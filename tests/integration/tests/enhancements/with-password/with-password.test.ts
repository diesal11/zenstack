import { withPassword } from '@zenstackhq/runtime';
import { loadSchema } from '@zenstackhq/testtools';
import { compareSync } from 'bcryptjs';
import path from 'path';

describe('Password test', () => {
    let origDir: string;

    beforeAll(async () => {
        origDir = path.resolve('.');
    });

    afterEach(async () => {
        process.chdir(origDir);
    });

    const model = `
    model User {
        id String @id @default(cuid())
        password String @password(saltLength: 16)
    
        @@allow('all', true)
    }`;

    it('password tests', async () => {
        const { withPassword } = await loadSchema(model);

        const db = withPassword();
        const r = await db.user.create({
            data: {
                id: '1',
                password: 'abc123',
            },
        });
        expect(compareSync('abc123', r.password)).toBeTruthy();

        const r1 = await db.user.update({
            where: { id: '1' },
            data: {
                password: 'abc456',
            },
        });
        expect(compareSync('abc456', r1.password)).toBeTruthy();
    });

    it('customization', async () => {
        const { prisma } = await loadSchema(model, { getPrismaOnly: true, output: './zen' });

        const db = withPassword(prisma, { loadPath: './zen' });
        const r = await db.user.create({
            data: {
                id: '1',
                password: 'abc123',
            },
        });
        expect(compareSync('abc123', r.password)).toBeTruthy();

        const db1 = withPassword(prisma, { modelMeta: require(path.resolve('./zen/model-meta')).default });
        const r1 = await db1.user.create({
            data: {
                id: '2',
                password: 'abc123',
            },
        });
        expect(compareSync('abc123', r1.password)).toBeTruthy();
    });
});
