/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
import colors from 'colors';
import path from 'path';
import { inspect } from 'util';

// inspired by: https://github.com/Kinjalrk2k/prisma-console

/**
 * CLI action for starting a REPL session
 */
export async function repl(
    projectPath: string,
    options: { loadPath?: string; prismaClient?: string; debug?: boolean; table?: boolean }
) {
    if (!process?.stdout?.isTTY && process?.versions?.bun) {
        console.error(
            'REPL on Bun is only available in a TTY terminal at this time. Please use npm/npx to run the command in this context instead of bun/bunx.'
        );
        return;
    }

    const prettyRepl = await import('pretty-repl');

    console.log('Welcome to ZenStack REPL. See help with the ".help" command.');
    console.log('Global variables:');
    console.log(`    ${colors.blue('db')} to access enhanced PrismaClient`);
    console.log(`    ${colors.blue('prisma')} to access raw PrismaClient`);
    console.log(`    ${colors.blue('user')} to inspect the current user`);
    console.log('Commands:');
    console.log(`    ${colors.magenta('.auth { id: ... }')} - set current user`);
    console.log(`    ${colors.magenta('.table')}            - toggle table output`);
    console.log(`    ${colors.magenta('.debug')}            - toggle debug output`);
    console.log();
    console.log(`Running as anonymous user. Use ".auth" to set current user.`);

    let PrismaClient: any;

    const prismaClientModule = options.prismaClient ?? '@prisma/client';

    try {
        // try direct require
        const module = require(prismaClientModule);
        PrismaClient = module.PrismaClient;
    } catch (err) {
        if (!path.isAbsolute(prismaClientModule)) {
            // try relative require
            const module = require(path.join(projectPath, prismaClientModule));
            PrismaClient = module.PrismaClient;
        } else {
            throw err;
        }
    }

    const { enhance } = options.loadPath
        ? require(path.join(path.resolve(options.loadPath), 'enhance'))
        : require('@zenstackhq/runtime');

    let debug = !!options.debug;
    let table = !!options.table;
    let prisma: any;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let db: any;
    let user: any;

    const replServer = prettyRepl.start({
        prompt: `[${colors.cyan('anonymous')}] > `,
        eval: async (cmd, _context, _filename, callback) => {
            try {
                let r: any = undefined;
                let isPrismaCall = false;

                if (/^\s*user\s*=[^=]/.test(cmd)) {
                    // assigning to user variable, reset auth
                    eval(cmd);
                    setAuth(user);
                } else if (/^\s*await\s+/.test(cmd)) {
                    // eval can't handle top-level await, so we wrap it in an async function
                    cmd = `(async () => (${cmd}))()`;
                    r = eval(cmd);
                    if (isPrismaPromise(r)) {
                        isPrismaCall = true;
                    }
                    r = await r;
                } else {
                    r = eval(cmd);
                    if (isPrismaPromise(r)) {
                        isPrismaCall = true;
                        // automatically await Prisma promises
                        r = await r;
                    }
                }

                if (isPrismaCall && table) {
                    console.table(r);
                    callback(null, undefined);
                } else {
                    callback(null, r);
                }
            } catch (err: any) {
                if (err.code) {
                    console.error(colors.red(err.message));
                    console.error('Code:', err.code);
                    if (err.meta) {
                        console.error('Meta:', err.meta);
                    }
                    callback(null, undefined);
                } else {
                    callback(err as Error, undefined);
                }
            }
        },
    });

    // .table command
    replServer.defineCommand('table', {
        help: 'Toggle table output',
        action(value: string) {
            if (value && value !== 'on' && value !== 'off' && value !== 'true' && value !== 'false') {
                console.error('Invalid argument. Usage: .table [on|off|true|false]');
                this.displayPrompt();
                return;
            }
            this.clearBufferedCommand();
            table = value ? value === 'on' || value === 'true' : !table;
            console.log('Table output:', table);
            this.displayPrompt();
        },
    });

    // .debug command
    replServer.defineCommand('debug', {
        help: 'Toggle debug output',
        async action(value: string) {
            if (value && value !== 'on' && value !== 'off' && value !== 'true' && value !== 'false') {
                console.error('Invalid argument. Usage: .debug [on|off|true|false]');
                this.displayPrompt();
                return;
            }
            this.clearBufferedCommand();
            debug = value ? value === 'on' || value === 'true' : !debug;
            console.log('Debug mode:', debug);
            await createClient();
            setPrompt();
            this.displayPrompt();
        },
    });

    // .auth command
    replServer.defineCommand('auth', {
        help: 'Set current user. Run without argument to switch to anonymous. Pass an user object to set current user. Run ".auth info" to show current user.',
        action(value: string) {
            this.clearBufferedCommand();
            try {
                if (!value?.trim()) {
                    // set anonymous
                    setAuth(undefined);
                    console.log(`Auth user: anonymous. Use ".auth { id: ... }" to change.`);
                } else if (value.trim() === 'info') {
                    // refresh auth user
                    setAuth(user);
                    console.log(`Current user: ${user ? inspect(user) : 'anonymous'}`);
                } else {
                    // set current user
                    const user = eval(`(${value})`);
                    if (!user || typeof user !== 'object') {
                        console.error(`Invalid argument. Pass a user object like { id: ... }`);
                        this.displayPrompt();
                        return;
                    }
                    setAuth(user);
                    console.log(`Auth user: ${inspect(user)}. Use ".auth" to switch to anonymous.`);
                }
            } catch (err: any) {
                console.error('Unable to set auth user:', err.message);
            }
            this.displayPrompt();
        },
    });

    replServer.setupHistory(path.join(projectPath, './.zenstack_repl_history'), (err) => {
        if (err) {
            console.error('unable to setup REPL history:', err);
        }
    });

    setPrompt();
    await createClient();

    async function createClient() {
        if (prisma) {
            prisma.$disconnect();
        }
        prisma = new PrismaClient(debug ? { log: ['info'] } : undefined);
        // https://github.com/prisma/prisma/issues/18292
        prisma[Symbol.for('nodejs.util.inspect.custom')] = 'PrismaClient';
        db = enhance(prisma, { user }, { logPrismaQuery: debug });

        replServer.context.prisma = prisma;
        replServer.context.db = db;
    }

    function setPrompt() {
        const userInfo = user ? (user.id ? `user#${user.id.toString().slice(-8)}` : inspect(user)) : 'anonymous';
        replServer.setPrompt(`[${debug ? colors.yellow('D ') : ''}${colors.cyan(userInfo)}] > `);
    }

    function setAuth(_user: unknown) {
        user = _user;
        // recreate enhanced PrismaClient
        db = replServer.context.db = enhance(prisma, { user }, { logPrismaQuery: debug });
        setPrompt();
    }
}

function isPrismaPromise(r: any) {
    return r?.[Symbol.toStringTag] === 'PrismaPromise' || r?.[Symbol.toStringTag] === 'ZenStackPromise';
}
