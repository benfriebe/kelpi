import fs from 'node:fs';
import type { JsonObject } from '@kelpi/protocol';
import type { BuiltinPluginService } from './builtin-services.js';

function validatePath(args: JsonObject): void {
    if (typeof args['path'] !== 'string' || !args['path'] || args['path'].length > 8192 || args['path'].includes('\0')) throw new Error('missing or invalid path');
}

/** Plugin file access remains bounded; native editors retain their atomic save lifecycle. */
export function createFilesService(): BuiltinPluginService {
    return {
        id: 'kelpi.files', title: 'Files', version: 1,
        methods: {
            read: {
                validateArgs: validatePath,
                validateResult(result) { if (typeof result !== 'string') throw new Error('expected file text'); },
                async run(args, _context, signal) {
                    const handle = await fs.promises.open(args['path'] as string, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
                    try {
                        const stat = await handle.stat();
                        if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('file exceeds plugin read limit or is not a regular file');
                        const bytes = Buffer.alloc(256 * 1024 + 1);
                        let read = 0;
                        while (read < bytes.length) {
                            signal?.throwIfAborted();
                            const result = await handle.read(bytes, read, bytes.length - read, read);
                            if (result.bytesRead === 0) break;
                            read += result.bytesRead;
                        }
                        if (read > 256 * 1024) throw new Error('file exceeds plugin read limit');
                        return bytes.subarray(0, read).toString('utf8');
                    } finally { await handle.close(); }
                }
            },
            write: {
                validateArgs(args) { validatePath(args); if (typeof args['text'] !== 'string') throw new Error('expected text'); },
                validateResult(result) { if (result !== null) throw new Error('expected null write result'); },
                async run(args, _context, signal) {
                    await fs.promises.writeFile(args['path'] as string, args['text'] as string, { ...(signal ? { signal } : {}) });
                    return null;
                }
            }
        }
    };
}
