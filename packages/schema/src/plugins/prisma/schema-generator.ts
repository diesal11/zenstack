import {
    AttributeArg,
    BooleanLiteral,
    ConfigArrayExpr,
    ConfigExpr,
    ConfigInvocationArg,
    DataModel,
    DataModelAttribute,
    DataModelField,
    DataModelFieldAttribute,
    DataModelFieldType,
    DataSource,
    Enum,
    EnumField,
    Expression,
    GeneratorDecl,
    InvocationExpr,
    isArrayExpr,
    isDataModel,
    isDataSource,
    isInvocationExpr,
    isLiteralExpr,
    isNullExpr,
    isReferenceExpr,
    isStringLiteral,
    isTypeDef,
    LiteralExpr,
    Model,
    NumberLiteral,
    ReferenceExpr,
    StringLiteral,
} from '@zenstackhq/language/ast';
import { getPrismaVersion } from '@zenstackhq/sdk/prisma';
import { match, P } from 'ts-pattern';
import { getIdFields } from '../../utils/ast-utils';

import { DELEGATE_AUX_RELATION_PREFIX, PRISMA_MINIMUM_VERSION } from '@zenstackhq/runtime';
import {
    getAttribute,
    getAttributeArg,
    getAttributeArgLiteral,
    getInheritedFromDelegate,
    getLiteral,
    getRelationKeyPairs,
    isDelegateModel,
    isIdField,
    PluginError,
    PluginOptions,
    resolved,
    ZModelCodeGenerator,
} from '@zenstackhq/sdk';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import { lowerCaseFirst } from 'lower-case-first';
import path from 'path';
import semver from 'semver';
import { name } from '.';
import { getStringLiteral } from '../../language-server/validator/utils';
import { execPackage } from '../../utils/exec-utils';
import { isDefaultWithAuth } from '../enhancer/enhancer-utils';
import {
    AttributeArgValue,
    ModelField,
    ModelFieldType,
    AttributeArg as PrismaAttributeArg,
    AttributeArgValue as PrismaAttributeArgValue,
    ContainerDeclaration as PrismaContainerDeclaration,
    Model as PrismaDataModel,
    Enum as PrismaEnum,
    FieldAttribute as PrismaFieldAttribute,
    FieldReference as PrismaFieldReference,
    FieldReferenceArg as PrismaFieldReferenceArg,
    FunctionCall as PrismaFunctionCall,
    FunctionCallArg as PrismaFunctionCallArg,
    PrismaModel,
    ContainerAttribute as PrismaModelAttribute,
    PassThroughAttribute as PrismaPassThroughAttribute,
    SimpleField,
} from './prisma-builder';

const MODEL_PASSTHROUGH_ATTR = '@@prisma.passthrough';
const FIELD_PASSTHROUGH_ATTR = '@prisma.passthrough';
const PROVIDERS_SUPPORTING_NAMED_CONSTRAINTS = ['postgresql', 'mysql', 'cockroachdb'];

// Some database providers like postgres and mysql have default limit to the length of identifiers
// Here we use a conservative value that should work for most cases, and truncate names if needed
const IDENTIFIER_NAME_MAX_LENGTH = 50 - DELEGATE_AUX_RELATION_PREFIX.length;

/**
 * Generates Prisma schema file
 */
export class PrismaSchemaGenerator {
    private zModelGenerator: ZModelCodeGenerator = new ZModelCodeGenerator();

    private readonly PRELUDE = `//////////////////////////////////////////////////////////////////////////////////////////////
// DO NOT MODIFY THIS FILE                                                                  //
// This file is automatically generated by ZenStack CLI and should not be manually updated. //
//////////////////////////////////////////////////////////////////////////////////////////////

`;

    private mode: 'logical' | 'physical' = 'physical';
    private customAttributesAsComments = false;

    // a mapping from full names to shortened names
    private shortNameMap = new Map<string, string>();

    constructor(private readonly zmodel: Model) {}

    async generate(options: PluginOptions) {
        if (!options.output) {
            throw new PluginError(name, 'Output file is not specified');
        }

        const outFile = options.output as string;
        const warnings: string[] = [];
        if (options.mode) {
            this.mode = options.mode as 'logical' | 'physical';
        }

        if (
            options.customAttributesAsComments !== undefined &&
            typeof options.customAttributesAsComments !== 'boolean'
        ) {
            throw new PluginError(name, 'option "customAttributesAsComments" must be a boolean');
        }
        this.customAttributesAsComments = options.customAttributesAsComments === true;

        const prismaVersion = getPrismaVersion();
        if (prismaVersion && semver.lt(prismaVersion, PRISMA_MINIMUM_VERSION)) {
            warnings.push(
                `ZenStack requires Prisma version "${PRISMA_MINIMUM_VERSION}" or higher. Detected version is "${prismaVersion}".`
            );
        }

        const prisma = new PrismaModel();

        for (const decl of this.zmodel.declarations) {
            switch (decl.$type) {
                case DataSource:
                    this.generateDataSource(prisma, decl as DataSource);
                    break;

                case Enum:
                    this.generateEnum(prisma, decl as Enum);
                    break;

                case DataModel:
                    this.generateModel(prisma, decl as DataModel);
                    break;

                case GeneratorDecl:
                    this.generateGenerator(prisma, decl as GeneratorDecl, options);
                    break;
            }
        }

        if (!fs.existsSync(path.dirname(outFile))) {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
        }
        await writeFile(outFile, this.PRELUDE + prisma.toString());

        if (options.format !== false) {
            try {
                // run 'prisma format'
                await execPackage(`prisma format --schema ${outFile}`, { stdio: 'ignore' });
            } catch {
                warnings.push(`Failed to format Prisma schema file`);
            }
        }

        return { warnings, shortNameMap: this.shortNameMap };
    }

    private generateDataSource(prisma: PrismaModel, dataSource: DataSource) {
        const fields: SimpleField[] = dataSource.fields.map((f) => ({
            name: f.name,
            text: this.configExprToText(f.value),
        }));
        prisma.addDataSource(dataSource.name, fields);
    }

    private configExprToText(expr: ConfigExpr) {
        if (isLiteralExpr(expr)) {
            return this.literalToText(expr);
        } else if (isInvocationExpr(expr)) {
            const fc = this.makeFunctionCall(expr);
            return fc.toString();
        } else {
            return this.configArrayToText(expr);
        }
    }

    private configArrayToText(expr: ConfigArrayExpr) {
        return (
            '[' +
            expr.items
                .map((item) => {
                    if (isLiteralExpr(item)) {
                        return this.literalToText(item);
                    } else {
                        return (
                            item.name +
                            (item.args.length > 0
                                ? '(' + item.args.map((arg) => this.configInvocationArgToText(arg)).join(', ') + ')'
                                : '')
                        );
                    }
                })
                .join(', ') +
            ']'
        );
    }

    private configInvocationArgToText(arg: ConfigInvocationArg) {
        return `${arg.name}: ${this.literalToText(arg.value)}`;
    }

    private literalToText(expr: LiteralExpr) {
        return JSON.stringify(expr.value);
    }

    private exprToText(expr: Expression) {
        return new ZModelCodeGenerator({ quote: 'double' }).generate(expr);
    }

    private generateGenerator(prisma: PrismaModel, decl: GeneratorDecl, options: PluginOptions) {
        const generator = prisma.addGenerator(
            decl.name,
            decl.fields.map((f) => ({ name: f.name, text: this.configExprToText(f.value) }))
        );

        // deal with configuring PrismaClient preview features
        const provider = generator.fields.find((f) => f.name === 'provider');
        if (provider?.text === JSON.stringify('prisma-client-js')) {
            const prismaVersion = getPrismaVersion();
            if (prismaVersion) {
                const previewFeatures = JSON.parse(
                    generator.fields.find((f) => f.name === 'previewFeatures')?.text ?? '[]'
                );

                if (!Array.isArray(previewFeatures)) {
                    throw new PluginError(name, 'option "previewFeatures" must be an array');
                }

                if (previewFeatures.length > 0) {
                    const curr = generator.fields.find((f) => f.name === 'previewFeatures');
                    if (!curr) {
                        generator.fields.push({ name: 'previewFeatures', text: JSON.stringify(previewFeatures) });
                    } else {
                        curr.text = JSON.stringify(previewFeatures);
                    }
                }
            }

            if (typeof options.overrideClientGenerationPath === 'string') {
                const output = generator.fields.find((f) => f.name === 'output');
                if (output) {
                    output.text = JSON.stringify(options.overrideClientGenerationPath);
                } else {
                    generator.fields.push({
                        name: 'output',
                        text: JSON.stringify(options.overrideClientGenerationPath),
                    });
                }
            }
        }
    }

    private generateModel(prisma: PrismaModel, decl: DataModel) {
        const model = decl.isView ? prisma.addView(decl.name) : prisma.addModel(decl.name);
        for (const field of decl.fields) {
            if (field.$inheritedFrom) {
                const inheritedFromDelegate = getInheritedFromDelegate(field);
                if (
                    // fields inherited from delegate are excluded from physical schema
                    !inheritedFromDelegate ||
                    // logical schema keeps all inherited fields
                    this.mode === 'logical' ||
                    // id fields are always kept
                    isIdField(field)
                ) {
                    this.generateModelField(model, field);
                }
            } else {
                this.generateModelField(model, field);
            }
        }

        for (const attr of decl.attributes.filter((attr) => this.isPrismaAttribute(attr))) {
            this.generateContainerAttribute(model, attr);
        }

        // user defined comments pass-through
        decl.comments.forEach((c) => model.addComment(c));
        this.getCustomAttributesAsComments(decl).forEach((c) => model.addComment(c));

        // physical: generate relation fields on base models linking to concrete models
        this.generateDelegateRelationForBase(model, decl);

        // physical: generate reverse relation fields on concrete models
        this.generateDelegateRelationForConcrete(model, decl);

        // logical: expand relations on other models that reference delegated models to concrete models
        this.expandPolymorphicRelations(model, decl);

        // logical: ensure relations inherited from delegate models
        this.ensureRelationsInheritedFromDelegate(model, decl);
    }

    private generateDelegateRelationForBase(model: PrismaDataModel, decl: DataModel) {
        if (this.mode !== 'physical') {
            return;
        }

        if (!isDelegateModel(decl)) {
            return;
        }

        // collect concrete models inheriting this model
        const concreteModels = decl.$container.declarations.filter(
            (d) => isDataModel(d) && d !== decl && d.superTypes.some((base) => base.ref === decl)
        );

        // generate an optional relation field in delegate base model to each concrete model
        concreteModels.forEach((concrete) => {
            const auxName = this.truncate(`${DELEGATE_AUX_RELATION_PREFIX}_${lowerCaseFirst(concrete.name)}`);
            model.addField(auxName, new ModelFieldType(concrete.name, false, true));
        });
    }

    private generateDelegateRelationForConcrete(model: PrismaDataModel, concreteDecl: DataModel) {
        if (this.mode !== 'physical') {
            return;
        }

        // generate a relation field for each delegated base model

        const baseModels = concreteDecl.superTypes
            .map((t) => t.ref)
            .filter((t): t is DataModel => !!t)
            .filter((t) => isDelegateModel(t));

        baseModels.forEach((base) => {
            const idFields = getIdFields(base);

            // add relation fields
            const relationField = this.truncate(`${DELEGATE_AUX_RELATION_PREFIX}_${lowerCaseFirst(base.name)}`);
            model.addField(relationField, base.name, [
                new PrismaFieldAttribute('@relation', [
                    new PrismaAttributeArg(
                        'fields',
                        new AttributeArgValue(
                            'Array',
                            idFields.map(
                                (idField) =>
                                    new AttributeArgValue('FieldReference', new PrismaFieldReference(idField.name))
                            )
                        )
                    ),
                    new PrismaAttributeArg(
                        'references',
                        new AttributeArgValue(
                            'Array',
                            idFields.map(
                                (idField) =>
                                    new AttributeArgValue('FieldReference', new PrismaFieldReference(idField.name))
                            )
                        )
                    ),
                    new PrismaAttributeArg(
                        'onDelete',
                        new AttributeArgValue('FieldReference', new PrismaFieldReference('Cascade'))
                    ),
                    new PrismaAttributeArg(
                        'onUpdate',
                        new AttributeArgValue('FieldReference', new PrismaFieldReference('Cascade'))
                    ),
                ]),
            ]);
        });
    }

    private expandPolymorphicRelations(model: PrismaDataModel, dataModel: DataModel) {
        if (this.mode !== 'logical') {
            return;
        }

        // the logical schema needs to expand relations to the delegate models to concrete ones

        // for the given model, find relation fields of delegate model type, find all concrete models
        // of the delegate model and generate an auxiliary opposite relation field to each of them
        dataModel.fields.forEach((field) => {
            // don't process fields inherited from a delegate model
            if (field.$inheritedFrom && isDelegateModel(field.$inheritedFrom)) {
                return;
            }

            const fieldType = field.type.reference?.ref;
            if (!isDataModel(fieldType)) {
                return;
            }

            // find concrete models that inherit from this field's model type
            const concreteModels = dataModel.$container.declarations.filter(
                (d): d is DataModel => isDataModel(d) && isDescendantOf(d, fieldType)
            );

            concreteModels.forEach((concrete) => {
                // aux relation name format: delegate_aux_[model]_[relationField]_[concrete]
                // e.g., delegate_aux_User_myAsset_Video
                const auxRelationName = this.truncate(
                    `${DELEGATE_AUX_RELATION_PREFIX}_${dataModel.name}_${field.name}_${concrete.name}`
                );
                const auxRelationField = model.addField(
                    auxRelationName,
                    new ModelFieldType(concrete.name, field.type.array, field.type.optional)
                );

                const relAttr = getAttribute(field, '@relation');
                let relAttrAdded = false;
                if (relAttr) {
                    if (getAttributeArg(relAttr, 'fields')) {
                        // for reach foreign key field pointing to the delegate model, we need to create an aux foreign key
                        // to point to the concrete model
                        const relationFieldPairs = getRelationKeyPairs(field);
                        const addedFkFields: ModelField[] = [];
                        for (const { foreignKey } of relationFieldPairs) {
                            const addedFkField = this.replicateForeignKey(model, dataModel, concrete, foreignKey);
                            addedFkFields.push(addedFkField);
                        }

                        // the `@relation(..., fields: [...])` attribute argument
                        const fieldsArg = new AttributeArgValue(
                            'Array',
                            addedFkFields.map(
                                (addedFk) =>
                                    new AttributeArgValue('FieldReference', new PrismaFieldReference(addedFk.name))
                            )
                        );

                        // the `@relation(..., references: [...])` attribute argument
                        const referencesArg = new AttributeArgValue(
                            'Array',
                            relationFieldPairs.map(
                                ({ id }) => new AttributeArgValue('FieldReference', new PrismaFieldReference(id.name))
                            )
                        );

                        const addedRel = new PrismaFieldAttribute('@relation', [
                            // use field name as relation name for disambiguation
                            new PrismaAttributeArg(undefined, new AttributeArgValue('String', auxRelationField.name)),
                            new PrismaAttributeArg('fields', fieldsArg),
                            new PrismaAttributeArg('references', referencesArg),
                        ]);

                        if (this.supportNamedConstraints) {
                            addedRel.args.push(
                                // generate a `map` argument for foreign key constraint disambiguation
                                new PrismaAttributeArg(
                                    'map',
                                    new PrismaAttributeArgValue('String', `${auxRelationField.name}_fk`)
                                )
                            );
                        }
                        auxRelationField.attributes.push(addedRel);
                        relAttrAdded = true;
                    }
                }

                if (!relAttrAdded) {
                    auxRelationField.attributes.push(
                        new PrismaFieldAttribute('@relation', [
                            // use field name as relation name for disambiguation
                            new PrismaAttributeArg(undefined, new AttributeArgValue('String', auxRelationField.name)),
                        ])
                    );
                }
            });
        });
    }

    private replicateForeignKey(
        model: PrismaDataModel,
        delegateModel: DataModel,
        concreteModel: DataModel,
        origForeignKey: DataModelField
    ) {
        // aux fk name format: delegate_aux_[model]_[fkField]_[concrete]
        // e.g., delegate_aux_User_myAssetId_Video

        // generate a fk field based on the original fk field
        const addedFkField = this.generateModelField(model, origForeignKey);

        // `@map` attribute should not be inherited
        addedFkField.attributes = addedFkField.attributes.filter((attr) => !('name' in attr && attr.name === '@map'));

        // `@unique` attribute should be recreated with disambiguated name
        addedFkField.attributes = addedFkField.attributes.filter(
            (attr) => !('name' in attr && attr.name === '@unique')
        );
        const uniqueAttr = addedFkField.addAttribute('@unique');
        const constraintName = this.truncate(`${delegateModel.name}_${addedFkField.name}_${concreteModel.name}_unique`);
        uniqueAttr.args.push(new PrismaAttributeArg('map', new AttributeArgValue('String', constraintName)));

        // fix its name
        const addedFkFieldName = `${delegateModel.name}_${origForeignKey.name}_${concreteModel.name}`;
        addedFkField.name = this.truncate(`${DELEGATE_AUX_RELATION_PREFIX}_${addedFkFieldName}`);

        // we also need to go through model-level `@@unique` and replicate those involving fk fields
        this.replicateForeignKeyModelLevelUnique(model, delegateModel, origForeignKey, addedFkField);

        return addedFkField;
    }

    private replicateForeignKeyModelLevelUnique(
        model: PrismaDataModel,
        dataModel: DataModel,
        origForeignKey: DataModelField,
        addedFkField: ModelField
    ) {
        for (const uniqueAttr of dataModel.attributes.filter((attr) => attr.decl.ref?.name === '@@unique')) {
            const fields = getAttributeArg(uniqueAttr, 'fields');
            if (fields && isArrayExpr(fields)) {
                const found = fields.items.find(
                    (fieldRef) => isReferenceExpr(fieldRef) && fieldRef.target.ref === origForeignKey
                );
                if (found) {
                    // replicate the attribute and replace the field reference with the new FK field
                    const args: PrismaAttributeArgValue[] = [];
                    for (const arg of fields.items) {
                        if (isReferenceExpr(arg) && arg.target.ref === origForeignKey) {
                            // replace
                            args.push(
                                new PrismaAttributeArgValue(
                                    'FieldReference',
                                    new PrismaFieldReference(addedFkField.name)
                                )
                            );
                        } else {
                            // copy
                            args.push(
                                new PrismaAttributeArgValue(
                                    'FieldReference',
                                    new PrismaFieldReference((arg as ReferenceExpr).target.$refText)
                                )
                            );
                        }
                    }

                    model.addAttribute('@@unique', [
                        new PrismaAttributeArg(undefined, new PrismaAttributeArgValue('Array', args)),
                    ]);
                }
            }
        }
    }

    private truncate(name: string) {
        if (name.length <= IDENTIFIER_NAME_MAX_LENGTH) {
            return name;
        }

        const existing = this.shortNameMap.get(name);
        if (existing) {
            return existing;
        }

        const baseName = name.slice(0, IDENTIFIER_NAME_MAX_LENGTH);
        let index = 0;
        let shortName = `${baseName}_${index}`;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const conflict = Array.from(this.shortNameMap.values()).find((v) => v === shortName);
            if (!conflict) {
                this.shortNameMap.set(name, shortName);
                break;
            }

            // try next index
            index++;
            shortName = `${baseName}_${index}`;
        }

        return shortName;
    }

    private ensureRelationsInheritedFromDelegate(model: PrismaDataModel, decl: DataModel) {
        if (this.mode !== 'logical') {
            return;
        }

        decl.fields.forEach((f) => {
            if (!isDataModel(f.type.reference?.ref)) {
                // only process relation fields
                return;
            }

            if (!f.$inheritedFrom) {
                // only process inherited fields
                return;
            }

            // Walk up the inheritance chain to find a field with matching name
            // which is where this field is inherited from.
            //
            // Note that we can't walk all the way up to the $inheritedFrom model
            // because it may have been eliminated because of being abstract.

            const baseField = this.findUpMatchingFieldFromDelegate(decl, f);
            if (!baseField) {
                // only process fields inherited from delegate models
                return;
            }

            const prismaField = model.fields.find((field) => field.name === f.name);
            if (!prismaField) {
                return;
            }

            // find the opposite side of the relation
            const oppositeRelationField = this.getOppositeRelationField(f.type.reference.ref, baseField);
            if (!oppositeRelationField) {
                return;
            }
            const oppositeRelationAttr = getAttribute(oppositeRelationField, '@relation');

            const fieldType = f.type.reference.ref;

            // relation name format: delegate_aux_[relationType]_[oppositeRelationField]_[concrete]
            const relName = this.truncate(
                `${DELEGATE_AUX_RELATION_PREFIX}_${fieldType.name}_${oppositeRelationField.name}_${decl.name}`
            );

            // recreate `@relation` attribute
            prismaField.attributes = prismaField.attributes.filter(
                (attr) => (attr as PrismaFieldAttribute).name !== '@relation'
            );

            if (
                // array relation doesn't need FK
                f.type.array ||
                // opposite relation already has FK, we don't need to generate on this side
                (oppositeRelationAttr && getAttributeArg(oppositeRelationAttr, 'fields'))
            ) {
                prismaField.attributes.push(
                    new PrismaFieldAttribute('@relation', [
                        new PrismaAttributeArg(undefined, new AttributeArgValue('String', relName)),
                    ])
                );
            } else {
                // generate FK field
                const oppositeModelIds = getIdFields(oppositeRelationField.$container as DataModel);
                const fkFieldNames: string[] = [];

                oppositeModelIds.forEach((idField) => {
                    const fkFieldName = this.truncate(`${DELEGATE_AUX_RELATION_PREFIX}_${f.name}_${idField.name}`);
                    model.addField(fkFieldName, new ModelFieldType(idField.type.type!, false, f.type.optional), [
                        // one-to-one relation requires FK field to be unique, we're just including it
                        // in all cases since it doesn't hurt
                        new PrismaFieldAttribute('@unique'),
                    ]);
                    fkFieldNames.push(fkFieldName);
                });

                prismaField.attributes.push(
                    new PrismaFieldAttribute('@relation', [
                        new PrismaAttributeArg(undefined, new AttributeArgValue('String', relName)),
                        new PrismaAttributeArg(
                            'fields',
                            new AttributeArgValue(
                                'Array',
                                fkFieldNames.map(
                                    (fk) => new AttributeArgValue('FieldReference', new PrismaFieldReference(fk))
                                )
                            )
                        ),
                        new PrismaAttributeArg(
                            'references',
                            new AttributeArgValue(
                                'Array',
                                oppositeModelIds.map(
                                    (idField) =>
                                        new AttributeArgValue('FieldReference', new PrismaFieldReference(idField.name))
                                )
                            )
                        ),
                    ])
                );
            }
        });
    }

    private findUpMatchingFieldFromDelegate(start: DataModel, target: DataModelField): DataModelField | undefined {
        for (const base of start.superTypes) {
            if (isDataModel(base.ref)) {
                if (isDelegateModel(base.ref)) {
                    const field = base.ref.fields.find((f) => f.name === target.name);
                    if (field) {
                        if (!field.$inheritedFrom || !isDelegateModel(field.$inheritedFrom)) {
                            // if this field is not inherited from an upper delegate, we're done
                            return field;
                        }
                    }
                }

                const upper = this.findUpMatchingFieldFromDelegate(base.ref, target);
                if (upper) {
                    return upper;
                }
            }
        }
        return undefined;
    }

    private getOppositeRelationField(oppositeModel: DataModel, relationField: DataModelField) {
        const relName = this.getRelationName(relationField);
        const matches = oppositeModel.fields.filter(
            (f) => f.type.reference?.ref === relationField.$container && this.getRelationName(f) === relName
        );

        if (matches.length === 0) {
            return undefined;
        } else if (matches.length === 1) {
            return matches[0];
        } else {
            // if there are multiple matches, prefer to use the one with the same field name,
            // this can happen with self-relations
            const withNameMatch = matches.find((f) => f.name === relationField.name);
            if (withNameMatch) {
                return withNameMatch;
            } else {
                return matches[0];
            }
        }
    }

    private getRelationName(field: DataModelField) {
        const relAttr = getAttribute(field, '@relation');
        if (!relAttr) {
            return undefined;
        }
        return getAttributeArgLiteral<string>(relAttr, 'name');
    }

    private get supportNamedConstraints() {
        const ds = this.zmodel.declarations.find(isDataSource);
        if (!ds) {
            return false;
        }

        const provider = ds.fields.find((f) => f.name === 'provider');
        if (!provider) {
            return false;
        }

        const value = getStringLiteral(provider.value);
        return value && PROVIDERS_SUPPORTING_NAMED_CONSTRAINTS.includes(value);
    }

    private isPrismaAttribute(attr: DataModelAttribute | DataModelFieldAttribute) {
        if (!attr.decl.ref) {
            return false;
        }
        const attrDecl = resolved(attr.decl);
        return (
            !!attrDecl.attributes.find((a) => a.decl.ref?.name === '@@@prisma') ||
            // the special pass-through attribute
            attrDecl.name === MODEL_PASSTHROUGH_ATTR ||
            attrDecl.name === FIELD_PASSTHROUGH_ATTR
        );
    }

    private getUnsupportedFieldType(fieldType: DataModelFieldType) {
        if (fieldType.unsupported) {
            const value = getStringLiteral(fieldType.unsupported.value);
            if (value) {
                return `Unsupported("${value}")`;
            } else {
                return undefined;
            }
        } else {
            return undefined;
        }
    }

    private generateModelField(model: PrismaDataModel, field: DataModelField, addToFront = false) {
        let fieldType: string | undefined;

        if (field.type.type) {
            // intrinsic type
            fieldType = field.type.type;
        } else if (field.type.reference?.ref) {
            // model, enum, or type-def
            if (isTypeDef(field.type.reference.ref)) {
                fieldType = 'Json';
            } else {
                fieldType = field.type.reference.ref.name;
            }
        } else {
            // Unsupported type
            const unsupported = this.getUnsupportedFieldType(field.type);
            if (unsupported) {
                fieldType = unsupported;
            }
        }

        if (!fieldType) {
            throw new PluginError(name, `Field type is not resolved: ${field.$container.name}.${field.name}`);
        }

        const isArray =
            // typed-JSON fields should be translated to scalar Json type
            isTypeDef(field.type.reference?.ref) ? false : field.type.array;
        const type = new ModelFieldType(fieldType, isArray, field.type.optional);

        const attributes = field.attributes
            .filter((attr) => this.isPrismaAttribute(attr))
            // `@default` with `auth()` is handled outside Prisma
            .filter((attr) => !isDefaultWithAuth(attr))
            .filter(
                (attr) =>
                    // when building physical schema, exclude `@default` for id fields inherited from delegate base
                    !(
                        this.mode === 'physical' &&
                        isIdField(field) &&
                        this.isInheritedFromDelegate(field) &&
                        attr.decl.$refText === '@default'
                    )
            )
            .map((attr) => this.makeFieldAttribute(attr));

        // user defined comments pass-through
        const docs = [...field.comments, ...this.getCustomAttributesAsComments(field)];
        const result = model.addField(field.name, type, attributes, docs, addToFront);

        if (this.mode === 'logical') {
            if (field.attributes.some((attr) => isDefaultWithAuth(attr))) {
                // field has `@default` with `auth()`, turn it into a dummy default value, and the
                // real default value setting is handled outside Prisma
                this.setDummyDefault(result, field);
            }
        }

        return result;
    }

    private setDummyDefault(result: ModelField, field: DataModelField) {
        const dummyDefaultValue = match(field.type.type)
            .with('String', () => new AttributeArgValue('String', ''))
            .with(P.union('Int', 'BigInt', 'Float', 'Decimal'), () => new AttributeArgValue('Number', '0'))
            .with('Boolean', () => new AttributeArgValue('Boolean', 'false'))
            .with('DateTime', () => new AttributeArgValue('FunctionCall', new PrismaFunctionCall('now')))
            .with('Json', () => new AttributeArgValue('String', '{}'))
            .with('Bytes', () => new AttributeArgValue('String', ''))
            .otherwise(() => {
                throw new PluginError(name, `Unsupported field type with default value: ${field.type.type}`);
            });

        result.attributes.push(
            new PrismaFieldAttribute('@default', [new PrismaAttributeArg(undefined, dummyDefaultValue)])
        );
    }

    private isInheritedFromDelegate(field: DataModelField) {
        return field.$inheritedFrom && isDelegateModel(field.$inheritedFrom);
    }

    private makeFieldAttribute(attr: DataModelFieldAttribute) {
        const attrName = resolved(attr.decl).name;
        if (attrName === FIELD_PASSTHROUGH_ATTR) {
            const text = getLiteral<string>(attr.args[0].value);
            if (text) {
                return new PrismaPassThroughAttribute(text);
            } else {
                throw new PluginError(name, `Invalid arguments for ${FIELD_PASSTHROUGH_ATTR} attribute`);
            }
        } else {
            return new PrismaFieldAttribute(
                attrName,
                attr.args.map((arg) => this.makeAttributeArg(arg))
            );
        }
    }

    private makeAttributeArg(arg: AttributeArg): PrismaAttributeArg {
        return new PrismaAttributeArg(arg.name, this.makeAttributeArgValue(arg.value));
    }

    private makeAttributeArgValue(node: Expression): PrismaAttributeArgValue {
        if (isLiteralExpr(node)) {
            const argType = match(node.$type)
                .with(StringLiteral, () => 'String' as const)
                .with(NumberLiteral, () => 'Number' as const)
                .with(BooleanLiteral, () => 'Boolean' as const)
                .exhaustive();
            return new PrismaAttributeArgValue(argType, node.value);
        } else if (isArrayExpr(node)) {
            return new PrismaAttributeArgValue(
                'Array',
                new Array(...node.items.map((item) => this.makeAttributeArgValue(item)))
            );
        } else if (isReferenceExpr(node)) {
            return new PrismaAttributeArgValue(
                'FieldReference',
                new PrismaFieldReference(
                    resolved(node.target).name,
                    node.args.map((arg) => new PrismaFieldReferenceArg(arg.name, this.exprToText(arg.value)))
                )
            );
        } else if (isInvocationExpr(node)) {
            // invocation
            return new PrismaAttributeArgValue('FunctionCall', this.makeFunctionCall(node));
        } else {
            throw new PluginError(name, `Unsupported attribute argument expression type: ${node.$type}`);
        }
    }

    makeFunctionCall(node: InvocationExpr): PrismaFunctionCall {
        return new PrismaFunctionCall(
            resolved(node.function).name,
            node.args.map((arg) => {
                const val = match(arg.value)
                    .when(isStringLiteral, (v) => `"${v.value}"`)
                    .when(isLiteralExpr, (v) => v.value.toString())
                    .when(isNullExpr, () => 'null')
                    .otherwise(() => {
                        throw new PluginError(name, 'Function call argument must be literal or null');
                    });

                return new PrismaFunctionCallArg(val);
            })
        );
    }

    private generateContainerAttribute(container: PrismaContainerDeclaration, attr: DataModelAttribute) {
        const attrName = resolved(attr.decl).name;
        if (attrName === MODEL_PASSTHROUGH_ATTR) {
            const text = getLiteral<string>(attr.args[0].value);
            if (text) {
                container.attributes.push(new PrismaPassThroughAttribute(text));
            }
        } else {
            container.attributes.push(
                new PrismaModelAttribute(
                    attrName,
                    attr.args.map((arg) => this.makeAttributeArg(arg))
                )
            );
        }
    }

    private generateEnum(prisma: PrismaModel, decl: Enum) {
        const _enum = prisma.addEnum(decl.name);

        for (const field of decl.fields) {
            this.generateEnumField(_enum, field);
        }

        for (const attr of decl.attributes.filter((attr) => this.isPrismaAttribute(attr))) {
            this.generateContainerAttribute(_enum, attr);
        }

        // user defined comments pass-through
        decl.comments.forEach((c) => _enum.addComment(c));
        this.getCustomAttributesAsComments(decl).forEach((c) => _enum.addComment(c));
    }

    private generateEnumField(_enum: PrismaEnum, field: EnumField) {
        const attributes = field.attributes
            .filter((attr) => this.isPrismaAttribute(attr))
            .map((attr) => this.makeFieldAttribute(attr));

        const docs = [...field.comments, ...this.getCustomAttributesAsComments(field)];
        _enum.addField(field.name, attributes, docs);
    }

    private getCustomAttributesAsComments(decl: DataModel | DataModelField | Enum | EnumField) {
        if (!this.customAttributesAsComments) {
            return [];
        } else {
            return decl.attributes
                .filter((attr) => attr.decl.ref && !this.isPrismaAttribute(attr))
                .map((attr) => `/// ${this.zModelGenerator.generate(attr)}`);
        }
    }
}

function isDescendantOf(model: DataModel, superModel: DataModel): boolean {
    return model.superTypes.some((s) => s.ref === superModel || isDescendantOf(s.ref!, superModel));
}
