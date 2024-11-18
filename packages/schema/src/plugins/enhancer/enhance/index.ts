import { DELEGATE_AUX_RELATION_PREFIX } from '@zenstackhq/runtime';
import {
    PluginError,
    getAttribute,
    getAttributeArg,
    getAuthDecl,
    getDataModelAndTypeDefs,
    getDataModels,
    getLiteral,
    getRelationField,
    isDelegateModel,
    isDiscriminatorField,
    normalizedRelative,
    saveSourceFile,
    type PluginOptions,
} from '@zenstackhq/sdk';
import {
    DataModel,
    DataModelField,
    ReferenceExpr,
    isArrayExpr,
    isDataModel,
    isGeneratorDecl,
    isReferenceExpr,
    isTypeDef,
    type Model,
} from '@zenstackhq/sdk/ast';
import { getDMMF, getPrismaClientImportSpec, getPrismaVersion, type DMMF } from '@zenstackhq/sdk/prisma';
import fs from 'fs';
import path from 'path';
import semver from 'semver';
import {
    FunctionDeclarationStructure,
    InterfaceDeclaration,
    ModuleDeclaration,
    Node,
    Project,
    SourceFile,
    SyntaxKind,
    TypeAliasDeclaration,
    VariableStatement,
} from 'ts-morph';
import { upperCaseFirst } from 'upper-case-first';
import { name } from '..';
import { execPackage } from '../../../utils/exec-utils';
import { CorePlugins, getPluginCustomOutputFolder } from '../../plugin-utils';
import { trackPrismaSchemaError } from '../../prisma';
import { PrismaSchemaGenerator } from '../../prisma/schema-generator';
import { isDefaultWithAuth } from '../enhancer-utils';
import { generateAuthType } from './auth-type-generator';
import { generateCheckerType } from './checker-type-generator';
import { generateTypeDefType } from './model-typedef-generator';

// information of delegate models and their sub models
type DelegateInfo = [DataModel, DataModel[]][];

const LOGICAL_CLIENT_GENERATION_PATH = './.logical-prisma-client';

export class EnhancerGenerator {
    // regex for matching "ModelCreateXXXInput" and "ModelUncheckedCreateXXXInput" type
    // names for models that use `auth()` in `@default` attribute
    private readonly modelsWithAuthInDefaultCreateInputPattern: RegExp;

    constructor(
        private readonly model: Model,
        private readonly options: PluginOptions,
        private readonly project: Project,
        private readonly outDir: string
    ) {
        const modelsWithAuthInDefault = this.model.declarations.filter(
            (d): d is DataModel => isDataModel(d) && d.fields.some((f) => f.attributes.some(isDefaultWithAuth))
        );
        this.modelsWithAuthInDefaultCreateInputPattern = new RegExp(
            `^(${modelsWithAuthInDefault.map((m) => m.name).join('|')})(Unchecked)?Create.*?Input$`
        );
    }

    async generate(): Promise<{ dmmf: DMMF.Document | undefined; newPrismaClientDtsPath: string | undefined }> {
        let dmmf: DMMF.Document | undefined;

        const prismaImport = getPrismaClientImportSpec(this.outDir, this.options);
        let prismaTypesFixed = false;
        let resultPrismaImport = prismaImport;

        if (this.needsLogicalClient) {
            prismaTypesFixed = true;
            resultPrismaImport = `${LOGICAL_CLIENT_GENERATION_PATH}/index-fixed`;
            const result = await this.generateLogicalPrisma();
            dmmf = result.dmmf;
        }

        // reexport PrismaClient types (original or fixed)
        const prismaDts = this.project.createSourceFile(
            path.join(this.outDir, 'models.d.ts'),
            `export type * from '${resultPrismaImport}';`,
            { overwrite: true }
        );
        await prismaDts.save();

        const authDecl = getAuthDecl(getDataModelAndTypeDefs(this.model));
        const authTypes = authDecl ? generateAuthType(this.model, authDecl) : '';
        const authTypeParam = authDecl ? `auth.${authDecl.name}` : 'AuthUser';

        const checkerTypes = this.generatePermissionChecker ? generateCheckerType(this.model) : '';

        for (const target of ['node', 'edge']) {
            // generate separate `enhance()` for node and edge runtime
            const outFile = target === 'node' ? 'enhance.ts' : 'enhance-edge.ts';
            const enhanceTs = this.project.createSourceFile(
                path.join(this.outDir, outFile),
                `/* eslint-disable */
import { type EnhancementContext, type EnhancementOptions, type ZodSchemas, type AuthUser } from '@zenstackhq/runtime';
import { createEnhancement } from '@zenstackhq/runtime/enhancements/${target}';
import modelMeta from './model-meta';
import policy from './policy';
${
    this.options.withZodSchemas
        ? `import * as zodSchemas from '${this.getZodImport()}';`
        : 'const zodSchemas = undefined;'
}

${
    prismaTypesFixed
        ? this.createLogicalPrismaImports(prismaImport, resultPrismaImport)
        : this.createSimplePrismaImports(prismaImport)
}

${authTypes}

${checkerTypes}

${
    prismaTypesFixed
        ? this.createLogicalPrismaEnhanceFunction(authTypeParam)
        : this.createSimplePrismaEnhanceFunction(authTypeParam)
}
    `,
                { overwrite: true }
            );

            this.saveSourceFile(enhanceTs);
        }

        return {
            dmmf,
            newPrismaClientDtsPath: prismaTypesFixed
                ? path.resolve(this.outDir, LOGICAL_CLIENT_GENERATION_PATH, 'index-fixed.d.ts')
                : undefined,
        };
    }

    private getZodImport() {
        const zodCustomOutput = getPluginCustomOutputFolder(this.model, CorePlugins.Zod);

        if (!this.options.output && !zodCustomOutput) {
            // neither zod or me (enhancer) have custom output, use the default
            return './zod';
        }

        if (!zodCustomOutput) {
            // I have a custom output, but zod doesn't, import from runtime
            return '@zenstackhq/runtime/zod';
        }

        if (!this.options.output) {
            // I don't have a custom output, but zod has, CLI will still generate
            // a copy into the default output, so we can still import from there
            return './zod';
        }

        // both zod and me have custom output, resolve to relative path and import
        const schemaDir = path.dirname(this.options.schemaPath);
        const zodAbsPath = path.isAbsolute(zodCustomOutput)
            ? zodCustomOutput
            : path.resolve(schemaDir, zodCustomOutput);
        return normalizedRelative(this.outDir, zodAbsPath);
    }

    private createSimplePrismaImports(prismaImport: string) {
        return `import { Prisma, type PrismaClient } from '${prismaImport}';
import type * as _P from '${prismaImport}';
export type { PrismaClient };
        `;
    }

    private createSimplePrismaEnhanceFunction(authTypeParam: string) {
        const returnType = `DbClient${this.generatePermissionChecker ? ' & ModelCheckers' : ''}`;
        return `
export function enhance<DbClient extends object>(prisma: DbClient, context?: EnhancementContext<${authTypeParam}>, options?: EnhancementOptions): ${returnType} {
    return createEnhancement(prisma, {
        modelMeta,
        policy,
        zodSchemas: zodSchemas as unknown as (ZodSchemas | undefined),
        prismaModule: Prisma,
        ...options
    }, context) as ${returnType};
}         
            `;
    }

    private createLogicalPrismaImports(prismaImport: string, prismaClientImport: string) {
        return `import { Prisma as _Prisma, PrismaClient as _PrismaClient } from '${prismaImport}';
import type { InternalArgs, DynamicClientExtensionThis } from '${prismaImport}/runtime/library';
import type * as _P from '${prismaClientImport}';
import type { Prisma, PrismaClient } from '${prismaClientImport}';
export type { PrismaClient };
`;
    }

    private createLogicalPrismaEnhanceFunction(authTypeParam: string) {
        const prismaVersion = getPrismaVersion();

        // Prisma 5.16.0 introduced a new generic parameter to `DynamicClientExtensionThis`
        const hasClientOptions = prismaVersion && semver.gte(prismaVersion, '5.16.0');

        return `
// overload for plain PrismaClient
export function enhance<ExtArgs extends Record<string, any> & InternalArgs>(
    prisma: _PrismaClient<any, any, ExtArgs>,
    context?: EnhancementContext<${authTypeParam}>, options?: EnhancementOptions): PrismaClient${
            this.generatePermissionChecker ? ' & ModelCheckers' : ''
        };
    
// overload for extended PrismaClient
export function enhance<ExtArgs extends Record<string, any> & InternalArgs${hasClientOptions ? ', ClientOptions' : ''}>(
    prisma: DynamicClientExtensionThis<_Prisma.TypeMap<ExtArgs>, _Prisma.TypeMapCb, ExtArgs${
        hasClientOptions ? ', ClientOptions' : ''
    }>,
    context?: EnhancementContext<${authTypeParam}>, options?: EnhancementOptions): DynamicClientExtensionThis<Prisma.TypeMap<ExtArgs>, Prisma.TypeMapCb, ExtArgs${
            hasClientOptions ? ', ClientOptions' : ''
        }>${this.generatePermissionChecker ? ' & ModelCheckers' : ''};

export function enhance(prisma: any, context?: EnhancementContext<${authTypeParam}>, options?: EnhancementOptions): any {
    return createEnhancement(prisma, {
        modelMeta,
        policy,
        zodSchemas: zodSchemas as unknown as (ZodSchemas | undefined),
        prismaModule: _Prisma,
        ...options
    }, context);
}
`;
    }

    private get needsLogicalClient() {
        return this.hasDelegateModel(this.model) || this.hasAuthInDefault(this.model) || this.hasTypeDef(this.model);
    }

    private hasDelegateModel(model: Model) {
        const dataModels = getDataModels(model);
        return dataModels.some(
            (dm) => isDelegateModel(dm) && dataModels.some((sub) => sub.superTypes.some((base) => base.ref === dm))
        );
    }

    private hasAuthInDefault(model: Model) {
        return getDataModels(model).some((dm) =>
            dm.fields.some((f) => f.attributes.some((attr) => isDefaultWithAuth(attr)))
        );
    }

    private hasTypeDef(model: Model) {
        return model.declarations.some(isTypeDef);
    }

    private async generateLogicalPrisma() {
        const prismaGenerator = new PrismaSchemaGenerator(this.model);

        // dir of the zmodel file
        const zmodelDir = path.dirname(this.options.schemaPath);

        // generate a temp logical prisma schema in zmodel's dir
        const logicalPrismaFile = path.join(zmodelDir, `logical-${Date.now()}.prisma`);

        // calculate a relative output path to output the logical prisma client into enhancer's output dir
        const prismaClientOutDir = path.join(path.relative(zmodelDir, this.outDir), LOGICAL_CLIENT_GENERATION_PATH);
        await prismaGenerator.generate({
            provider: '@internal', // doesn't matter
            schemaPath: this.options.schemaPath,
            output: logicalPrismaFile,
            overrideClientGenerationPath: prismaClientOutDir,
            mode: 'logical',
        });

        // generate the prisma client

        // only run prisma client generator for the logical schema
        const prismaClientGeneratorName = this.getPrismaClientGeneratorName(this.model);
        let generateCmd = `prisma generate --schema "${logicalPrismaFile}" --generator=${prismaClientGeneratorName}`;

        const prismaVersion = getPrismaVersion();
        if (!prismaVersion || semver.gte(prismaVersion, '5.2.0')) {
            // add --no-engine to reduce generation size if the prisma version supports
            generateCmd += ' --no-engine';
        }

        try {
            // run 'prisma generate'
            await execPackage(generateCmd, { stdio: 'ignore' });
        } catch {
            await trackPrismaSchemaError(logicalPrismaFile);
            try {
                // run 'prisma generate' again with output to the console
                await execPackage(generateCmd);
            } catch {
                // noop
            }
            throw new PluginError(name, `Failed to run "prisma generate" on logical schema: ${logicalPrismaFile}`);
        }

        // make a bunch of typing fixes to the generated prisma client
        await this.processClientTypes(path.join(this.outDir, LOGICAL_CLIENT_GENERATION_PATH));

        const dmmf = await getDMMF({ datamodel: fs.readFileSync(logicalPrismaFile, { encoding: 'utf-8' }) });

        try {
            // clean up temp schema
            if (fs.existsSync(logicalPrismaFile)) {
                fs.rmSync(logicalPrismaFile);
            }
        } catch {
            // ignore errors
        }

        return {
            prismaSchema: logicalPrismaFile,
            // load the dmmf of the logical prisma schema
            dmmf,
        };
    }

    private getPrismaClientGeneratorName(model: Model) {
        for (const generator of model.declarations.filter(isGeneratorDecl)) {
            if (
                generator.fields.some(
                    (f) => f.name === 'provider' && getLiteral<string>(f.value) === 'prisma-client-js'
                )
            ) {
                return generator.name;
            }
        }
        throw new PluginError(name, `Cannot find prisma-client-js generator in the schema`);
    }

    private async processClientTypes(prismaClientDir: string) {
        // make necessary updates to the generated `index.d.ts` file and save it as `index-fixed.d.ts`
        const project = new Project();
        const sf = project.addSourceFileAtPath(path.join(prismaClientDir, 'index.d.ts'));

        // build a map of delegate models and their sub models
        const delegateInfo: DelegateInfo = [];
        this.model.declarations
            .filter((d): d is DataModel => isDelegateModel(d))
            .forEach((dm) => {
                const concreteModels = this.model.declarations.filter(
                    (d): d is DataModel => isDataModel(d) && d.superTypes.some((s) => s.ref === dm)
                );
                if (concreteModels.length > 0) {
                    delegateInfo.push([dm, concreteModels]);
                }
            });

        // transform index.d.ts and save it into a new file (better perf than in-line editing)

        const sfNew = project.createSourceFile(path.join(prismaClientDir, 'index-fixed.d.ts'), undefined, {
            overwrite: true,
        });

        this.transformPrismaTypes(sf, sfNew, delegateInfo);

        this.generateExtraTypes(sfNew);

        sfNew.formatText();
        await sfNew.save();
    }

    private transformPrismaTypes(sf: SourceFile, sfNew: SourceFile, delegateInfo: DelegateInfo) {
        // copy toplevel imports
        sfNew.addImportDeclarations(sf.getImportDeclarations().map((n) => n.getStructure()));

        // copy toplevel import equals
        sfNew.addStatements(sf.getChildrenOfKind(SyntaxKind.ImportEqualsDeclaration).map((n) => n.getFullText()));

        // copy toplevel exports
        sfNew.addExportAssignments(sf.getExportAssignments().map((n) => n.getStructure()));

        // copy toplevel type aliases
        sfNew.addTypeAliases(sf.getTypeAliases().map((n) => n.getStructure()));

        // copy toplevel classes
        sfNew.addClasses(sf.getClasses().map((n) => n.getStructure()));

        // copy toplevel variables
        sfNew.addVariableStatements(sf.getVariableStatements().map((n) => n.getStructure()));

        // copy toplevel namespaces except for `Prisma`
        sfNew.addModules(
            sf
                .getModules()
                .filter((n) => n.getName() !== 'Prisma')
                .map((n) => n.getStructure())
        );

        // transform the `Prisma` namespace
        const prismaModule = sf.getModuleOrThrow('Prisma');
        const newPrismaModule = sfNew.addModule({ name: 'Prisma', isExported: true });
        this.transformPrismaModule(prismaModule, newPrismaModule, delegateInfo);
    }

    private transformPrismaModule(
        prismaModule: ModuleDeclaration,
        newPrismaModule: ModuleDeclaration,
        delegateInfo: DelegateInfo
    ) {
        // module block is the direct container of declarations inside a namespace
        const moduleBlock = prismaModule.getFirstChildByKindOrThrow(SyntaxKind.ModuleBlock);

        // most of the toplevel constructs should be copied over
        // here we use ts-morph batch operations for optimal performance

        // copy imports
        newPrismaModule.addStatements(
            moduleBlock.getChildrenOfKind(SyntaxKind.ImportEqualsDeclaration).map((n) => n.getFullText())
        );

        // copy classes
        newPrismaModule.addClasses(moduleBlock.getClasses().map((n) => n.getStructure()));

        // copy functions
        newPrismaModule.addFunctions(
            moduleBlock.getFunctions().map((n) => n.getStructure() as FunctionDeclarationStructure)
        );

        // copy nested namespaces
        newPrismaModule.addModules(moduleBlock.getModules().map((n) => n.getStructure()));

        // transform variables
        const newVariables = moduleBlock
            .getVariableStatements()
            .map((variable) => this.transformVariableStatement(variable));
        newPrismaModule.addVariableStatements(newVariables);

        // transform interfaces
        const newInterfaces = moduleBlock.getInterfaces().map((iface) => this.transformInterface(iface, delegateInfo));
        newPrismaModule.addInterfaces(newInterfaces);

        // transform type aliases
        const newTypeAliases = moduleBlock
            .getTypeAliases()
            .map((typeAlias) => this.transformTypeAlias(typeAlias, delegateInfo));
        newPrismaModule.addTypeAliases(newTypeAliases);
    }

    private transformVariableStatement(variable: VariableStatement) {
        const structure = variable.getStructure();

        // remove `delegate_aux_*` fields from the variable's typing
        const auxFields = this.findAuxDecls(variable);
        if (auxFields.length > 0) {
            structure.declarations.forEach((variable) => {
                if (variable.type) {
                    let source = variable.type.toString();
                    auxFields.forEach((f) => {
                        source = this.removeFromSource(source, f.getText());
                    });
                    variable.type = source;
                }
            });
        }

        return structure;
    }

    private transformInterface(iface: InterfaceDeclaration, delegateInfo: DelegateInfo) {
        const structure = iface.getStructure();

        // filter out aux fields
        structure.properties = structure.properties?.filter((p) => !p.name.startsWith(DELEGATE_AUX_RELATION_PREFIX));

        // filter out aux methods
        structure.methods = structure.methods?.filter((m) => !m.name.startsWith(DELEGATE_AUX_RELATION_PREFIX));

        if (delegateInfo.some(([delegate]) => `${delegate.name}Delegate` === iface.getName())) {
            // delegate models cannot be created directly, remove create/createMany/upsert
            structure.methods = structure.methods?.filter(
                (m) => !['create', 'createMany', 'createManyAndReturn', 'upsert'].includes(m.name)
            );
        }

        return structure;
    }

    private transformTypeAlias(typeAlias: TypeAliasDeclaration, delegateInfo: DelegateInfo) {
        const structure = typeAlias.getStructure();
        let source = structure.type as string;

        // remove aux fields
        source = this.removeAuxFieldsFromTypeAlias(typeAlias, source);

        // remove discriminator field from concrete input types
        source = this.removeDiscriminatorFromConcreteInput(typeAlias, delegateInfo, source);

        // remove create/connectOrCreate/upsert fields from delegate's input types
        source = this.removeCreateFromDelegateInput(typeAlias, delegateInfo, source);

        // remove delegate fields from nested mutation input types
        source = this.removeDelegateFieldsFromNestedMutationInput(typeAlias, delegateInfo, source);

        // fix delegate payload union type
        source = this.fixDelegatePayloadType(typeAlias, delegateInfo, source);

        // fix fk and relation fields related to using `auth()` in `@default`
        source = this.fixDefaultAuthType(typeAlias, source);

        // fix json field type
        source = this.fixJsonFieldType(typeAlias, source);

        structure.type = source;
        return structure;
    }

    private fixDelegatePayloadType(typeAlias: TypeAliasDeclaration, delegateInfo: DelegateInfo, source: string) {
        // change the type of `$<DelegateModel>Payload` type of delegate model to a union of concrete types
        const typeName = typeAlias.getName();
        const payloadRecord = delegateInfo.find(([delegate]) => `$${delegate.name}Payload` === typeName);
        if (payloadRecord) {
            const discriminatorDecl = this.getDiscriminatorField(payloadRecord[0]);
            if (discriminatorDecl) {
                source = `${payloadRecord[1]
                    .map(
                        (concrete) =>
                            `($${concrete.name}Payload<ExtArgs> & { scalars: { ${discriminatorDecl.name}: '${concrete.name}' } })`
                    )
                    .join(' | ')}`;
            }
        }
        return source;
    }

    private removeCreateFromDelegateInput(typeAlias: TypeAliasDeclaration, delegateInfo: DelegateInfo, source: string) {
        // remove create/connectOrCreate/upsert fields from delegate's input types because
        // delegate models cannot be created directly
        const typeName = typeAlias.getName();
        const delegateModelNames = delegateInfo.map(([delegate]) => delegate.name);
        const delegateCreateUpdateInputRegex = new RegExp(
            `^(${delegateModelNames.join('|')})(Unchecked)?(Create|Update).*Input$`
        );
        if (delegateCreateUpdateInputRegex.test(typeName)) {
            const toRemove = typeAlias
                .getDescendantsOfKind(SyntaxKind.PropertySignature)
                .filter((p) => ['create', 'createMany', 'connectOrCreate', 'upsert'].includes(p.getName()));
            toRemove.forEach((r) => {
                this.removeFromSource(source, r.getText());
            });
        }
        return source;
    }

    private removeDiscriminatorFromConcreteInput(
        typeAlias: TypeAliasDeclaration,
        delegateInfo: DelegateInfo,
        source: string
    ) {
        // remove discriminator field from the create/update input because discriminator cannot be set directly
        const typeName = typeAlias.getName();

        const delegateModelNames = delegateInfo.map(([delegate]) => delegate.name);
        const concreteModelNames = delegateInfo
            .map(([_, concretes]) => concretes.flatMap((c) => c.name))
            .flatMap((name) => name);
        const allModelNames = [...new Set([...delegateModelNames, ...concreteModelNames])];
        const concreteCreateUpdateInputRegex = new RegExp(
            `^(${allModelNames.join('|')})(Unchecked)?(Create|Update).*Input$`
        );

        const match = typeName.match(concreteCreateUpdateInputRegex);
        if (match) {
            const modelName = match[1];
            const dataModel = this.model.declarations.find(
                (d): d is DataModel => isDataModel(d) && d.name === modelName
            );

            if (!dataModel) {
                return source;
            }

            for (const field of dataModel.fields) {
                if (isDiscriminatorField(field)) {
                    const fieldDef = this.findNamedProperty(typeAlias, field.name);
                    if (fieldDef) {
                        source = this.removeFromSource(source, fieldDef.getText());
                    }
                }
            }
        }
        return source;
    }

    private removeAuxFieldsFromTypeAlias(typeAlias: TypeAliasDeclaration, source: string) {
        // remove `delegate_aux_*` fields from the type alias
        const auxDecls = this.findAuxDecls(typeAlias);
        if (auxDecls.length > 0) {
            auxDecls.forEach((d) => {
                source = this.removeFromSource(source, d.getText());
            });
        }
        return source;
    }

    private readonly CreateUpdateWithoutDelegateRelationRegex = new RegExp(
        `(.+)(Create|Update)Without${upperCaseFirst(DELEGATE_AUX_RELATION_PREFIX)}_(.+)Input`
    );

    private removeDelegateFieldsFromNestedMutationInput(
        typeAlias: TypeAliasDeclaration,
        _delegateInfo: DelegateInfo,
        source: string
    ) {
        const name = typeAlias.getName();

        // remove delegate model fields (and corresponding fk fields) from
        // create/update input types nested inside concrete models

        const match = name.match(this.CreateUpdateWithoutDelegateRelationRegex);
        if (!match) {
            return source;
        }

        const nameTuple = match[3]; // [modelName]_[relationFieldName]_[concreteModelName]
        const [modelName, relationFieldName, _] = nameTuple.split('_');

        const fieldDef = this.findNamedProperty(typeAlias, relationFieldName);
        if (fieldDef) {
            // remove relation field of delegate type, e.g., `asset`
            source = this.removeFromSource(source, fieldDef.getText());
        }

        // remove fk fields related to the delegate type relation, e.g., `assetId`

        const relationModel = this.model.declarations.find(
            (d): d is DataModel => isDataModel(d) && d.name === modelName
        );

        if (!relationModel) {
            return source;
        }

        const relationField = relationModel.fields.find((f) => f.name === relationFieldName);
        if (!relationField) {
            return source;
        }

        const relAttr = getAttribute(relationField, '@relation');
        if (!relAttr) {
            return source;
        }

        const fieldsArg = getAttributeArg(relAttr, 'fields');
        let fkFields: string[] = [];
        if (isArrayExpr(fieldsArg)) {
            fkFields = fieldsArg.items.map((e) => (e as ReferenceExpr).target.$refText);
        }

        fkFields.forEach((fkField) => {
            const fieldDef = this.findNamedProperty(typeAlias, fkField);
            if (fieldDef) {
                source = this.removeFromSource(source, fieldDef.getText());
            }
        });

        return source;
    }

    private fixDefaultAuthType(typeAlias: TypeAliasDeclaration, source: string) {
        const match = typeAlias.getName().match(this.modelsWithAuthInDefaultCreateInputPattern);
        if (!match) {
            return source;
        }

        const modelName = match[1];
        const dataModel = this.model.declarations.find((d): d is DataModel => isDataModel(d) && d.name === modelName);
        if (dataModel) {
            for (const fkField of dataModel.fields.filter((f) => f.attributes.some(isDefaultWithAuth))) {
                // change fk field to optional since it has a default
                source = source.replace(new RegExp(`^(\\s*${fkField.name}\\s*):`, 'm'), `$1?:`);

                const relationField = getRelationField(fkField);
                if (relationField) {
                    // change relation field to optional since its fk has a default
                    source = source.replace(new RegExp(`^(\\s*${relationField.name}\\s*):`, 'm'), `$1?:`);
                }
            }
        }
        return source;
    }

    private fixJsonFieldType(typeAlias: TypeAliasDeclaration, source: string) {
        const modelsWithTypeField = this.model.declarations.filter(
            (d): d is DataModel => isDataModel(d) && d.fields.some((f) => isTypeDef(f.type.reference?.ref))
        );
        const typeName = typeAlias.getName();

        const getTypedJsonFields = (model: DataModel) => {
            return model.fields.filter((f) => isTypeDef(f.type.reference?.ref));
        };

        const replacePrismaJson = (source: string, field: DataModelField) => {
            return source.replace(
                new RegExp(`(${field.name}\\??\\s*):[^\\n]+`),
                `$1: ${field.type.reference!.$refText}${field.type.array ? '[]' : ''}${
                    field.type.optional ? ' | null' : ''
                }`
            );
        };

        // fix "$[Model]Payload" type
        const payloadModelMatch = modelsWithTypeField.find((m) => `$${m.name}Payload` === typeName);
        if (payloadModelMatch) {
            const scalars = typeAlias
                .getDescendantsOfKind(SyntaxKind.PropertySignature)
                .find((p) => p.getName() === 'scalars');
            if (!scalars) {
                return source;
            }

            const fieldsToFix = getTypedJsonFields(payloadModelMatch);
            for (const field of fieldsToFix) {
                source = replacePrismaJson(source, field);
            }
        }

        // fix input/output types, "[Model]CreateInput", etc.
        const inputOutputModelMatch = modelsWithTypeField.find((m) => typeName.startsWith(m.name));
        if (inputOutputModelMatch) {
            const relevantTypePatterns = [
                'GroupByOutputType',
                '(Unchecked)?Create(\\S+?)?Input',
                '(Unchecked)?Update(\\S+?)?Input',
                'CreateManyInput',
                '(Unchecked)?UpdateMany(Mutation)?Input',
            ];
            const typeRegex = modelsWithTypeField.map(
                (m) => new RegExp(`^(${m.name})(${relevantTypePatterns.join('|')})$`)
            );
            if (typeRegex.some((r) => r.test(typeName))) {
                const fieldsToFix = getTypedJsonFields(inputOutputModelMatch);
                for (const field of fieldsToFix) {
                    source = replacePrismaJson(source, field);
                }
            }
        }

        return source;
    }

    private async generateExtraTypes(sf: SourceFile) {
        for (const decl of this.model.declarations) {
            if (isTypeDef(decl)) {
                generateTypeDefType(sf, decl);
            }
        }
    }

    private findNamedProperty(typeAlias: TypeAliasDeclaration, name: string) {
        return typeAlias.getFirstDescendant((d) => d.isKind(SyntaxKind.PropertySignature) && d.getName() === name);
    }

    private findAuxDecls(node: Node) {
        return node
            .getDescendantsOfKind(SyntaxKind.PropertySignature)
            .filter((n) => n.getName().startsWith(DELEGATE_AUX_RELATION_PREFIX));
    }

    private getDiscriminatorField(delegate: DataModel) {
        const delegateAttr = getAttribute(delegate, '@@delegate');
        if (!delegateAttr) {
            return undefined;
        }
        const arg = delegateAttr.args[0]?.value;
        return isReferenceExpr(arg) ? (arg.target.ref as DataModelField) : undefined;
    }

    private saveSourceFile(sf: SourceFile) {
        if (this.options.preserveTsFiles) {
            saveSourceFile(sf);
        }
    }

    private get generatePermissionChecker() {
        return this.options.generatePermissionChecker === true;
    }

    private removeFromSource(source: string, text: string) {
        source = source.replace(text, '');
        return this.trimEmptyLines(source);
    }

    private trimEmptyLines(source: string): string {
        return source.replace(/^\s*[\r\n]/gm, '');
    }
}
