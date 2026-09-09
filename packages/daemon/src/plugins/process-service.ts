import { execFile } from 'node:child_process';
import { pluginRecord, type JsonValue } from '@kelpi/protocol';
import type { BuiltinPluginService } from './builtin-services.js';

export function createProcessService(options: {
    readonly homeDirectory: () => string;
    readonly cliEnvironment: () => Readonly<Record<string, string>>;
}): BuiltinPluginService {
    return {
        id: 'kelpi.process', title: 'Managed processes', version: 1,
        methods: {
            exec: {
                validateArgs(args) {
                    const file = args['file'];
                    if (typeof file !== 'string' || !file || file.length > 8192 || file.includes('\0')) throw new Error('missing or invalid file');
                    const argv = args['args'] ?? [];
                    if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('process args must be strings without null bytes');
                    const cwd = args['cwd'];
                    if (cwd !== undefined && (typeof cwd !== 'string' || !cwd || cwd.length > 8192 || cwd.includes('\0'))) throw new Error('invalid process cwd');
                },
                validateResult(result) {
                    if (!pluginRecord(result) || typeof result['stdout'] !== 'string' || typeof result['stderr'] !== 'string') throw new Error('expected process stdout and stderr');
                },
                run: (args, _context, signal) => new Promise<JsonValue>((resolve, reject) => {
                    execFile(args['file'] as string, (args['args'] ?? []) as string[], {
                        ...(signal ? { signal } : {}),
                        env: { ...process.env, ...options.cliEnvironment() },
                        cwd: (args['cwd'] as string | undefined) ?? options.homeDirectory(),
                        timeout: 25_000, maxBuffer: 256 * 1024
                    }, (error, stdout, stderr) => {
                        if (error) reject(new Error(`${error.message}\n${stderr}`)); else resolve({ stdout, stderr });
                    });
                })
            }
        }
    };
}
