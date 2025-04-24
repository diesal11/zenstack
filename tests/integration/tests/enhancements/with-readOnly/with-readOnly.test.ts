import { loadSchema } from '@zenstackhq/testtools';
import path from 'path';

describe('readonly test', () => {
    let origDir: string;

    beforeAll(async () => {
        origDir = path.resolve('.');
    });

    afterEach(async () => {
        process.chdir(origDir);
    });

    const model = `
        model User {
            id String @id @default(cuid()) @readOnly
            name String
            profile Profile?
            @@allow('all', true)
        }

        model Profile {
            id String @id @default(cuid()) @readOnly
            user User @relation(fields: [userId], references: [id])
            userId String @unique
            image String

            @@allow('all', true)
        }
    `;

    it('Works with @readOnly field', async () => {
        const { enhance } = await loadSchema(model);

        const db = enhance();
        const user = await db.user.create({
            include: { profile: true },
            data: {
                name: 'abc123',
                profile: {
                    create: {
                        image: 'test.png',
                    },
                },
            },
        });

        expect(user).toEqual({
            id: expect.any(String),
            name: 'abc123',
            profile: {
                id: expect.any(String),
                userId: user.id,
                image: 'test.png',
            },
        });

        const updatedUser = await db.user.update({
            where: { id: user.id },
            include: { profile: true },
            data: {
                name: 'xyz456',
            },
        });

        expect(updatedUser).toEqual({
            id: user.id,
            name: 'xyz456',
            profile: {
                id: expect.any(String),
                userId: user.id,
                image: 'test.png',
            },
        });
    });

    it('Throws an error if @readOnly field is provided in create', async () => {
        const { enhance } = await loadSchema(model);

        const db = enhance();
        let req = db.user.create({
            include: { profile: true },
            data: {
                id: '28',
                name: 'abc123',
            },
        });

        await expect(req).rejects.toThrow('Field `id` is ReadOnly and cannot be modified');

        req = db.user.create({
            data: {
                name: 'abc123',
                profile: {
                    create: {
                        id: '29',
                        image: 'test.png',
                    },
                },
            },
        });

        await expect(req).rejects.toThrow('Field `id` is ReadOnly and cannot be modified');
    });

    it('Throws an error if @readOnly field is provided in update', async () => {
        const { enhance } = await loadSchema(model);
        const db = enhance();

        const user = await db.user.create({
            data: {
                name: 'abc123',
                profile: {
                    create: {
                        image: 'test.png',
                    },
                },
            },
        });

        let req = db.user.update({
            where: { id: '1' },
            data: {
                id: '2',
            },
        });

        await expect(req).rejects.toThrow('Field `id` is ReadOnly and cannot be modified');

        req = db.user.update({
            where: { id: '1' },
            data: {
                profile: {
                    update: {
                        id: '2',
                    },
                },
            },
        });

        await expect(req).rejects.toThrow('Field `id` is ReadOnly and cannot be modified');
    });
});
