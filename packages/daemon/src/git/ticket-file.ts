/**
 * Writing the ticket file into a new workspace's checkout (graft-git.md §8.5.4; the content is
 * `@kelpi/core/tickets`' `renderTicketFile`, docs/integrations.md §7).
 *
 * `<dir>/.kelpi/ticket-<number>.md`, where `<dir>` is the first pane's working directory (so the
 * prompt's `@.kelpi/ticket-418.md` names it as the agent sees it), beside a `.kelpi/.gitignore` of
 * `*` that keeps the folder out of `git status` wherever it is, a monorepo subfolder included.
 *
 * Kelpi never writes where a checkout's own content could redirect it, and never points an agent
 * at a file it did not write. So the file is SKIPPED, with the reason as the reply's
 * `ticket_file_error`, when:
 *
 *   - the checkout tracks anything under `.kelpi` in ANY letter case (`git ls-files --
 *     ':(icase).kelpi'`), or, for a pull request, its head commit's tree has an entry whose name is
 *     `.kelpi` in any case (`git ls-tree --name-only <head>`, compared lowercased): whatever is
 *     there came from the pull request's author. Any case, because on a case-insensitive file
 *     system (macOS's default APFS) `.Kelpi/` IS `.kelpi/`: a fork tracking `.Kelpi/` would
 *     otherwise pass a case-sensitive check, Kelpi would write into its tracked folder, and a
 *     `git commit -a` would push the ticket text to the fork;
 *   - `.kelpi` is a symbolic link or not a folder, or resolves outside the checkout, or is spelled
 *     on disk in another case (`fs.realpathSync.native`, which, unlike `fs.realpathSync`, returns
 *     the case the file system stores, so an untracked `.Kelpi/` is not taken for Kelpi's own);
 *   - any read or write fails.
 *
 * Both files are written to a temporary name (`wx`, so nothing existing is followed) and renamed
 * into place, which replaces a symbolic link at the target rather than writing through it. The
 * create succeeds either way; the caller then renders the prompt without the file
 * (`withoutTicketFileReference`).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { TICKET_FILE_DIRECTORY, TICKET_FILE_DIRECTORY_GITIGNORE, ticketFilePath } from '@kelpi/core/tickets';

import { isGitCommandError } from './exec.js';
import { worktreeErrorMessage } from './names.js';
import type { WorktreeGitOps } from './worktree-add.js';

export interface TicketFileWrite {
    /** The directory the file goes under: the first pane's working directory, inside a checkout. */
    readonly directory: string;
    /** The ticket's number: the file is `.kelpi/ticket-<number>.md`. */
    readonly number: number;
    /** `renderTicketFile`'s text. */
    readonly content: string;
    /** A pull request's head commit, checked for a `.kelpi` of its own; null for an issue. */
    readonly headSha?: string | null | undefined;
}

export type TicketFileOutcome = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };

/** One temporary-then-rename write; never follows an existing file or link. */
function writeAtomically(target: string, content: string, mode: number): void {
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let fd: number | null = null;
    try {
        fd = fs.openSync(temp, 'wx', mode);
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(temp, target);
    } catch (error) {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {
                // already closed
            }
        }
        try {
            fs.unlinkSync(temp);
        } catch {
            // never made, or already renamed
        }
        throw error;
    }
}

function reason(error: unknown): string {
    if (isGitCommandError(error)) return worktreeErrorMessage(error);
    if (error instanceof Error) return (error as NodeJS.ErrnoException).code ?? error.message;
    return String(error);
}

/** The first path component of a path git listed: the folder's name as the checkout spells it. */
function topComponent(listed: string): string {
    return listed.split('/')[0] ?? listed;
}

/** Why git says the checkout (or the pull request) owns `.kelpi` in any case, or null when it does not. */
async function trackedKelpi(ops: WorktreeGitOps, directory: string, headSha: string | null): Promise<string | null> {
    const tracked = (await ops.read(['ls-files', '-z', '--', `:(icase)${TICKET_FILE_DIRECTORY}`], directory)).split('\0').filter((entry) => entry !== '');
    const first = tracked[0];
    if (first !== undefined) return `the checkout tracks ${topComponent(first)}, so Kelpi did not write a ticket file there`;
    if (headSha === null) return null;
    try {
        await ops.read(['cat-file', '-e', `${headSha}^{commit}`], directory);
    } catch (error) {
        if (isGitCommandError(error)) return `could not read the pull request's head commit to check its ${TICKET_FILE_DIRECTORY}`;
        throw error;
    }
    // Run in `directory`, `ls-tree` lists the head's entries at that folder (a monorepo subfolder
    // included). A failure here is not "absent": it propagates, and nothing is written.
    const entries = (await ops.read(['ls-tree', '--name-only', '-z', headSha], directory)).split('\0');
    const owned = entries.find((name) => name.toLowerCase() === TICKET_FILE_DIRECTORY);
    return owned === undefined ? null : `the pull request tracks ${owned}, so Kelpi did not write a ticket file there`;
}

/** Write the ticket file (module note). Never throws. */
export async function writeTicketFile(ops: WorktreeGitOps, input: TicketFileWrite): Promise<TicketFileOutcome> {
    const relative = ticketFilePath(input.number);
    try {
        const owned = await trackedKelpi(ops, input.directory, input.headSha ?? null);
        if (owned !== null) return { ok: false, error: owned };

        // `.native`: the path as the file system stores it, case included (module note).
        const root = fs.realpathSync.native(input.directory);
        const folder = path.join(input.directory, TICKET_FILE_DIRECTORY);
        let stat: fs.Stats | null = null;
        try {
            stat = fs.lstatSync(folder);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (stat === null) {
            fs.mkdirSync(folder, { mode: 0o755 });
            stat = fs.lstatSync(folder);
        }
        if (stat.isSymbolicLink()) return { ok: false, error: `${TICKET_FILE_DIRECTORY} in the checkout is a symbolic link, so Kelpi did not write a ticket file there` };
        if (!stat.isDirectory()) return { ok: false, error: `${TICKET_FILE_DIRECTORY} in the checkout is not a folder, so Kelpi did not write a ticket file there` };
        const real = fs.realpathSync.native(folder);
        if (real !== path.join(root, TICKET_FILE_DIRECTORY)) {
            if (path.dirname(real) === root && path.basename(real).toLowerCase() === TICKET_FILE_DIRECTORY) {
                return {
                    ok: false,
                    error: `the checkout has ${path.basename(real)}, which this file system takes for ${TICKET_FILE_DIRECTORY}, so Kelpi did not write a ticket file there`
                };
            }
            return { ok: false, error: `${TICKET_FILE_DIRECTORY} resolves outside the checkout, so Kelpi did not write a ticket file there` };
        }

        // The ignore first, so the ticket file is never visible to `git status`, even for a moment.
        const ignore = path.join(folder, '.gitignore');
        let current: string | null = null;
        try {
            if (fs.lstatSync(ignore).isFile()) current = fs.readFileSync(ignore, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (current !== TICKET_FILE_DIRECTORY_GITIGNORE) writeAtomically(ignore, TICKET_FILE_DIRECTORY_GITIGNORE, 0o644);

        const target = path.join(input.directory, relative);
        writeAtomically(target, input.content, 0o600);
        return { ok: true, path: target };
    } catch (error) {
        return { ok: false, error: `could not write ${relative}: ${reason(error)}` };
    }
}
