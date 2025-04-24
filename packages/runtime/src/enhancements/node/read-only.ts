/* eslint-disable @typescript-eslint/no-explicit-any */

import { ACTIONS_WITH_WRITE_PAYLOAD } from '../../constants';
import { NestedWriteVisitor, PrismaWriteActionType } from '../../cross';
import { DbClientContract } from '../../types';
import { InternalEnhancementOptions } from './create-enhancement';
import { DefaultPrismaProxyHandler, makeProxy, PrismaProxyActions } from './proxy';

/**
 * Gets an enhanced Prisma client that supports `@readOnly` attribute.
 *
 * @private
 */
export function withReadOnly<DbClient extends object>(prisma: DbClient, options: InternalEnhancementOptions): DbClient {
    return makeProxy(
        prisma,
        options.modelMeta,
        (_prisma, model) => new ReadOnlyHandler(_prisma as DbClientContract, model, options),
        'readOnly'
    );
}

class ReadOnlyHandler extends DefaultPrismaProxyHandler {
    protected async preprocessArgs(action: PrismaProxyActions, args: any) {
        if (args && ACTIONS_WITH_WRITE_PAYLOAD.includes(action)) {
            await this.preprocessWritePayload(this.model, action as PrismaWriteActionType, args);
        }
        return args;
    }

    private async preprocessWritePayload(model: string, action: PrismaWriteActionType, args: any) {
        const visitor = new NestedWriteVisitor(this.options.modelMeta, {
            field: async (field, _action) => {
                const readOnlyAttr = field.attributes?.find((attr) => attr.name === '@readOnly');
                if (readOnlyAttr) {
                    throw new Error(`Field \`${field.name}\` is ReadOnly and cannot be modified`);
                }
            },
        });

        await visitor.visit(model, action, args);
    }
}
