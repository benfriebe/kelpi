/**
 * The files a `workspace-create` prompt is written to before anything is created.
 * Spec: docs/agent-lifecycle.md §6.5 ("Prompt files"), docs/wire-protocol.md §6.3 (step 4 of the
 * handler's checks, and the `prompt_file` echo).
 *
 * Why a file at all: send mode passes the prompt to the agent as ONE shell argument, read back
 * from disk at the moment the shell runs the line (`"$(command cat '<file>')"`, core's
 * `sendModeCommandLine`), so arbitrary text is never parsed by the shell and a 100 KB prompt never
 * crosses the terminal's input line. A prefill writes one too, so the text is at hand wherever the
 * prefill falls back (the CLI prints the path from the reply; the `agent-launch` frame carries it).
 *
 * The rules, each of which is a test in `launcher.test.ts`:
 *
 *   - one directory, `<database directory>/prompts`, created 0700 and FORCED back to 0700 (and
 *     checked to be a real directory owned by this user) on every write: `mkdirSync`'s `mode`
 *     only applies to a directory it creates, so an existing, looser one would otherwise stay
 *     readable by anyone;
 *   - an in-memory database has no directory of its own, so it gets a private `mkdtemp` one on
 *     the first write;
 *   - each file is `<uuid>.txt`, created 0600 with `wx` (exclusive: a pre-planted file or symlink
 *     at that name fails the write instead of being followed);
 *   - files are swept once they are `PROMPT_FILE_TTL_MS` (a day) old, at boot and on every write,
 *     so re-running a send-mode line from shell history still finds its prompt that day. The
 *     sweep reads entries with `lstat`, and deletes only regular files named like ours: it never
 *     follows a link and never touches anything else in the directory;
 *   - nothing here logs or returns prompt TEXT; the path is what callers log.
 */

import { randomUUID } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    unlinkSync,
    writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { PROMPT_FILE_TTL_MS } from '@kelpi/core/agent';

/** The directory beside the database that holds the prompt files. */
export const PROMPTS_DIRECTORY_NAME = 'prompts';

/** `<uuid>.txt`: the only names this module ever writes, and the only ones the sweep deletes. */
const PROMPT_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/i;

export interface PromptFileStore {
    /** Write `prompt` to a fresh file and return its absolute path. Throws when it cannot. */
    write(prompt: string): string;
    /** Remove a file `write` returned (the create it was for failed). Never throws. */
    discard(path: string): void;
    /** Delete every prompt file at least a TTL old; returns how many went. Never throws. */
    sweep(): number;
    /** Where the files go; null for an in-memory daemon that has not written one yet. */
    readonly directory: string | null;
}

export interface PromptFileStoreOptions {
    /** `<dirname(dbPath)>/prompts`; null = a private temporary directory, made on first write. */
    readonly directory: string | null;
    readonly ttlMs?: number | undefined;
    /** Epoch ms, compared with each file's mtime. */
    readonly now?: (() => number) | undefined;
    readonly uuid?: (() => string) | undefined;
    /** Where the temporary directory of an in-memory daemon is made (tests). */
    readonly temporaryRoot?: string | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function errorCode(error: unknown): string | undefined {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
}

/**
 * The directory is ours and private, or the write is refused: a real directory (`lstat`, so a
 * symlink planted at that name is refused rather than followed), owned by this user, mode 0700.
 */
function securePromptDirectory(directory: string): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory()) throw new Error(`${directory} is not a directory`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && info.uid !== uid) throw new Error(`${directory} is not owned by this user`);
    if ((info.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
}

export function createPromptFileStore(options: PromptFileStoreOptions): PromptFileStore {
    const ttlMs = options.ttlMs ?? PROMPT_FILE_TTL_MS;
    const now = options.now ?? (() => Date.now());
    const uuid = options.uuid ?? (() => randomUUID());
    let directory = options.directory;

    const report = (error: unknown, context: string): void => {
        try {
            options.onError?.(toError(error), context);
        } catch {
            // Reporting is best effort.
        }
    };

    const ensureDirectory = (): string => {
        if (directory === null) {
            // `mkdtemp` creates the directory 0700 under a name nobody else can predict.
            directory = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), 'kelpi-prompts-'));
        }
        securePromptDirectory(directory);
        return directory;
    };

    const sweep = (): number => {
        if (directory === null) return 0;
        let names: string[];
        try {
            names = readdirSync(directory);
        } catch (error) {
            if (errorCode(error) !== 'ENOENT') report(error, `prompt file sweep ${directory}`);
            return 0;
        }
        const oldest = now() - ttlMs;
        let removed = 0;
        for (const name of names) {
            if (!PROMPT_FILE_NAME.test(name)) continue;
            const file = join(directory, name);
            try {
                const info = lstatSync(file);
                // A link, a directory or a fifo wearing our name is left alone: deleting through
                // a link is exactly what the lstat is here to rule out.
                if (!info.isFile() || info.mtimeMs > oldest) continue;
                unlinkSync(file);
                removed += 1;
            } catch (error) {
                if (errorCode(error) !== 'ENOENT') report(error, `prompt file sweep ${file}`);
            }
        }
        return removed;
    };

    return {
        get directory() {
            return directory;
        },
        write(prompt) {
            const target = ensureDirectory();
            sweep();
            const file = join(target, `${uuid().toLowerCase()}.txt`);
            const fd = openSync(file, 'wx', 0o600);
            try {
                const bytes = Buffer.from(prompt, 'utf8');
                let offset = 0;
                while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
            } catch (error) {
                closeSync(fd);
                try {
                    unlinkSync(file);
                } catch {
                    // The write already failed; a half-written file is the sweep's.
                }
                throw error;
            }
            closeSync(fd);
            return file;
        },
        discard(path) {
            // Only a file this store could have written: never an arbitrary path a caller passed.
            if (directory === null || dirname(path) !== directory || !PROMPT_FILE_NAME.test(basename(path))) return;
            try {
                unlinkSync(path);
            } catch (error) {
                if (errorCode(error) !== 'ENOENT') report(error, `prompt file discard ${path}`);
            }
        },
        sweep
    };
}
