import { FieldInfo } from '@zenstackhq/runtime';
import { loadSchema, loadModelWithError } from '@zenstackhq/testtools';
import path from 'path';

describe('Encrypted test', () => {
    let origDir: string;
    const encryptionKey = new Uint8Array(Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64'));

    beforeAll(async () => {
        origDir = path.resolve('.');
    });

    afterEach(async () => {
        process.chdir(origDir);
    });

    it('Simple encryption test', async () => {
        const { enhance, prisma } = await loadSchema(
            `
    model User {
        id String @id @default(cuid())
        encrypted_value String @encrypted()
    }`,
            {
                enhancements: ['encryption'],
                enhanceOptions: {
                    encryption: { encryptionKey },
                },
            }
        );

        const sudoDb = enhance(undefined, { kinds: [] });

        const db = enhance();

        const create = await db.user.create({
            data: {
                id: '1',
                encrypted_value: 'abc123',
            },
        });

        const read = await db.user.findUnique({
            where: {
                id: '1',
            },
        });

        const sudoRead = await sudoDb.user.findUnique({
            where: {
                id: '1',
            },
        });

        const rawRead = await prisma.user.findUnique({ where: { id: '1' } });

        expect(create.encrypted_value).toBe('abc123');
        expect(read.encrypted_value).toBe('abc123');
        expect(sudoRead.encrypted_value).not.toBe('abc123');
        expect(rawRead.encrypted_value).not.toBe('abc123');

        // update
        const updated = await db.user.update({
            where: { id: '1' },
            data: { encrypted_value: 'abc234' },
        });
        expect(updated.encrypted_value).toBe('abc234');
        await expect(db.user.findUnique({ where: { id: '1' } })).resolves.toMatchObject({
            encrypted_value: 'abc234',
        });
        await expect(prisma.user.findUnique({ where: { id: '1' } })).resolves.not.toMatchObject({
            encrypted_value: 'abc234',
        });

        // upsert with create
        const upsertCreate = await db.user.upsert({
            where: { id: '2' },
            create: {
                id: '2',
                encrypted_value: 'abc345',
            },
            update: {
                encrypted_value: 'abc456',
            },
        });
        expect(upsertCreate.encrypted_value).toBe('abc345');
        await expect(db.user.findUnique({ where: { id: '2' } })).resolves.toMatchObject({
            encrypted_value: 'abc345',
        });
        await expect(prisma.user.findUnique({ where: { id: '2' } })).resolves.not.toMatchObject({
            encrypted_value: 'abc345',
        });

        // upsert with update
        const upsertUpdate = await db.user.upsert({
            where: { id: '2' },
            create: {
                id: '2',
                encrypted_value: 'abc345',
            },
            update: {
                encrypted_value: 'abc456',
            },
        });
        expect(upsertUpdate.encrypted_value).toBe('abc456');
        await expect(db.user.findUnique({ where: { id: '2' } })).resolves.toMatchObject({
            encrypted_value: 'abc456',
        });
        await expect(prisma.user.findUnique({ where: { id: '2' } })).resolves.not.toMatchObject({
            encrypted_value: 'abc456',
        });

        // createMany
        await db.user.createMany({
            data: [
                { id: '3', encrypted_value: 'abc567' },
                { id: '4', encrypted_value: 'abc678' },
            ],
        });
        await expect(db.user.findUnique({ where: { id: '3' } })).resolves.toMatchObject({
            encrypted_value: 'abc567',
        });
        await expect(prisma.user.findUnique({ where: { id: '3' } })).resolves.not.toMatchObject({
            encrypted_value: 'abc567',
        });

        // createManyAndReturn
        await expect(
            db.user.createManyAndReturn({
                data: [
                    { id: '5', encrypted_value: 'abc789' },
                    { id: '6', encrypted_value: 'abc890' },
                ],
            })
        ).resolves.toEqual(
            expect.arrayContaining([
                { id: '5', encrypted_value: 'abc789' },
                { id: '6', encrypted_value: 'abc890' },
            ])
        );
        await expect(db.user.findUnique({ where: { id: '5' } })).resolves.toMatchObject({
            encrypted_value: 'abc789',
        });
        await expect(prisma.user.findUnique({ where: { id: '5' } })).resolves.not.toMatchObject({
            encrypted_value: 'abc789',
        });
    });

    it('Works with nullish values', async () => {
        const { enhance, prisma } = await loadSchema(
            `
    model User {
        id String @id @default(cuid())
        encrypted_value String? @encrypted()
    }`,
            {
                enhancements: ['encryption'],
                enhanceOptions: {
                    encryption: { encryptionKey },
                },
            }
        );

        const db = enhance();
        await expect(db.user.create({ data: { id: '1', encrypted_value: '' } })).resolves.toMatchObject({
            encrypted_value: '',
        });
        await expect(prisma.user.findUnique({ where: { id: '1' } })).resolves.toMatchObject({ encrypted_value: '' });

        await expect(db.user.create({ data: { id: '2' } })).resolves.toMatchObject({
            encrypted_value: null,
        });
        await expect(prisma.user.findUnique({ where: { id: '2' } })).resolves.toMatchObject({ encrypted_value: null });

        await expect(db.user.create({ data: { id: '3', encrypted_value: null } })).resolves.toMatchObject({
            encrypted_value: null,
        });
        await expect(prisma.user.findUnique({ where: { id: '3' } })).resolves.toMatchObject({ encrypted_value: null });
    });

    it('Decrypts nested fields', async () => {
        const { enhance, prisma } = await loadSchema(
            `
    model User {
        id String @id @default(cuid())
        posts Post[]
    }
    
    model Post {
        id String @id @default(cuid())
        title String @encrypted()
        author User @relation(fields: [authorId], references: [id])
        authorId String
    }
    `,
            {
                enhancements: ['encryption'],
                enhanceOptions: {
                    encryption: { encryptionKey },
                },
            }
        );

        const db = enhance();

        const create = await db.user.create({
            data: {
                id: '1',
                posts: { create: { title: 'Post1' } },
            },
            include: { posts: true },
        });
        expect(create.posts[0].title).toBe('Post1');

        const read = await db.user.findUnique({
            where: {
                id: '1',
            },
            include: { posts: true },
        });
        expect(read.posts[0].title).toBe('Post1');

        const rawRead = await prisma.user.findUnique({ where: { id: '1' }, include: { posts: true } });
        expect(rawRead.posts[0].title).not.toBe('Post1');
    });

    it('Multi-field encryption test', async () => {
        const { enhance } = await loadSchema(
            `
    model User {
        id String @id @default(cuid())
        x1 String @encrypted()
        x2 String @encrypted()
    }`,
            {
                enhancements: ['encryption'],
                enhanceOptions: {
                    encryption: { encryptionKey },
                },
            }
        );

        const db = enhance();

        const create = await db.user.create({
            data: {
                id: '1',
                x1: 'abc123',
                x2: '123abc',
            },
        });

        const read = await db.user.findUnique({
            where: {
                id: '1',
            },
        });

        expect(create).toMatchObject({ x1: 'abc123', x2: '123abc' });
        expect(read).toMatchObject({ x1: 'abc123', x2: '123abc' });
    });

    it('Custom encryption test', async () => {
        const { enhance, prisma } = await loadSchema(`
    model User {
        id String @id @default(cuid())
        encrypted_value String @encrypted()
    }`);

        const db = enhance(undefined, {
            kinds: ['encryption'],
            encryption: {
                encrypt: async (model: string, field: FieldInfo, data: string) => {
                    // Add _enc to the end of the input
                    return data + '_enc';
                },
                decrypt: async (model: string, field: FieldInfo, cipher: string) => {
                    // Remove _enc from the end of the input explicitly
                    if (cipher.endsWith('_enc')) {
                        return cipher.slice(0, -4); // Remove last 4 characters (_enc)
                    }

                    return cipher;
                },
            },
        });

        const create = await db.user.create({
            data: {
                id: '1',
                encrypted_value: 'abc123',
            },
        });

        const read = await db.user.findUnique({
            where: {
                id: '1',
            },
        });

        const rawRead = await prisma.user.findUnique({
            where: {
                id: '1',
            },
        });

        expect(create.encrypted_value).toBe('abc123');
        expect(read.encrypted_value).toBe('abc123');
        expect(rawRead.encrypted_value).toBe('abc123_enc');
    });

    it('Works with multiple decryption keys', async () => {
        const { enhanceRaw: enhance, prisma } = await loadSchema(
            `
    model User {
        id String @id @default(cuid())
        secret String @encrypted()
    }`
        );

        const key1 = crypto.getRandomValues(new Uint8Array(32));
        const key2 = crypto.getRandomValues(new Uint8Array(32));

        const db1 = enhance(prisma, undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey: key1 },
        });
        const user1 = await db1.user.create({ data: { secret: 'user1' } });

        const db2 = enhance(prisma, undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey: key2 },
        });
        const user2 = await db2.user.create({ data: { secret: 'user2' } });

        const dbAll = enhance(prisma, undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey: crypto.getRandomValues(new Uint8Array(32)), decryptionKeys: [key1, key2] },
        });
        const allUsers = await dbAll.user.findMany();
        expect(allUsers).toEqual(expect.arrayContaining([user1, user2]));

        const dbWithEncryptionKeyExplicitlyProvided = enhance(prisma, undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey: key1, decryptionKeys: [key1, key2] },
        });
        await expect(dbWithEncryptionKeyExplicitlyProvided.user.findMany()).resolves.toEqual(
            expect.arrayContaining([user1, user2])
        );

        const dbWithDuplicatedKeys = enhance(prisma, undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey: key1, decryptionKeys: [key1, key1, key2, key2] },
        });
        await expect(dbWithDuplicatedKeys.user.findMany()).resolves.toEqual(expect.arrayContaining([user1, user2]));

        const dbWithInvalidKeys = enhance(prisma, undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey: key1, decryptionKeys: [key2, crypto.getRandomValues(new Uint8Array(32))] },
        });
        await expect(dbWithInvalidKeys.user.findMany()).resolves.toEqual(expect.arrayContaining([user1, user2]));

        const dbWithMissingKeys = enhance(prisma, undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey: key2 },
        });
        const found = await dbWithMissingKeys.user.findMany();
        expect(found).not.toContainEqual(user1);
        expect(found).toContainEqual(user2);

        const dbWithAllWrongKeys = enhance(prisma, undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey: crypto.getRandomValues(new Uint8Array(32)) },
        });
        const found1 = await dbWithAllWrongKeys.user.findMany();
        expect(found1).not.toContainEqual(user1);
        expect(found1).not.toContainEqual(user2);
    });

    it('Only supports string fields', async () => {
        await expect(
            loadModelWithError(
                `
    model User {
        id String @id @default(cuid())
        encrypted_value Bytes @encrypted()
    }`
            )
        ).resolves.toContain(`attribute \"@encrypted\" cannot be used on this type of field`);
    });

    it('Returns cipher text when decryption fails', async () => {
        const { enhance, enhanceRaw, prisma } = await loadSchema(
            `
    model User {
        id String @id @default(cuid())
        encrypted_value String @encrypted()
    
        @@allow('all', true)
    }`,
            { enhancements: ['encryption'] }
        );

        const db = enhance(undefined, {
            kinds: ['encryption'],
            encryption: { encryptionKey },
        });

        const create = await db.user.create({
            data: {
                id: '1',
                encrypted_value: 'abc123',
            },
        });
        expect(create.encrypted_value).toBe('abc123');

        const db1 = enhanceRaw(prisma, undefined, {
            encryption: { encryptionKey: crypto.getRandomValues(new Uint8Array(32)) },
        });
        const read = await db1.user.findUnique({ where: { id: '1' } });
        expect(read.encrypted_value).toBeTruthy();
        expect(read.encrypted_value).not.toBe('abc123');
    });

    it('Works with length validation', async () => {
        const { enhance } = await loadSchema(
            `
    model User {
        id String @id @default(cuid())
        encrypted_value String @encrypted() @length(0, 6)
        @@allow('all', true)
    }`,
            {
                enhanceOptions: { encryption: { encryptionKey } },
            }
        );

        const db = enhance();

        const create = await db.user.create({
            data: {
                id: '1',
                encrypted_value: 'abc123',
            },
        });
        expect(create.encrypted_value).toBe('abc123');

        await expect(
            db.user.create({
                data: { id: '2', encrypted_value: 'abc1234' },
            })
        ).toBeRejectedByPolicy();
    });

    it('Complains when encrypted fields are used in model-level policy rules', async () => {
        await expect(
            loadModelWithError(`
    model User {
        id String @id @default(cuid())
        encrypted_value String @encrypted()
        @@allow('all', encrypted_value != 'abc123')
    }            
            `)
        ).resolves.toContain(`Encrypted fields cannot be used in policy rules`);
    });

    it('Complains when encrypted fields are used in field-level policy rules', async () => {
        await expect(
            loadModelWithError(`
    model User {
        id String @id @default(cuid())
        encrypted_value String @encrypted()
        value Int @allow('all', encrypted_value != 'abc123')
    }            
            `)
        ).resolves.toContain(`Encrypted fields cannot be used in policy rules`);
    });
});
