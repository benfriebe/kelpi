/**
 * The authoritative edit buffer for markdown + scratchpad panes (content-panes.md §4.2, §7).
 *
 * One buffer per pane, 500 ms debounced save, with two save targets:
 *   - **markdown** → the file on disk, written atomically (temp file + rename), because the
 *     preview's own file watcher reads it back;
 *   - **scratchpad** → the domain store (`scratchpad-content-changed`), which the persistence
 *     layer then debounces into the DB. Nothing ever writes a scratchpad to disk (§7).
 *
 * Multi-client arbitration (port note 7): the *daemon* holds the buffer, not a client, so two
 * clients editing one pane converge on the same text and every viewer follows the autosaved
 * writes.
 *
 * Everything here is synchronous on purpose: the shutdown flush (§4.2 "Quit flush", issue #129)
 * has to complete inside a SIGTERM handler, and the spec calls the scratchpad's *missing* flush
 * a bug to fix — so `flushAll()` covers both kinds.
 */

import fs from 'node:fs';
import path from 'node:path';

/** §4.2: the editor's autosave debounce. */
export const EDITOR_AUTOSAVE_DEBOUNCE_MS = 500;

export type EditorTarget =
    | { readonly kind: 'file'; readonly path: string }
    | { readonly kind: 'scratchpad' };

let tempCounter = 0;

/** Temp file + rename, preserving the original mode when there is one. */
export function writeFileAtomic(filePath: string, text: string): void {
    const directory = path.dirname(filePath);
    tempCounter += 1;
    const temp = path.join(
        directory,
        `.${path.basename(filePath)}.nex-${String(process.pid)}-${String(tempCounter)}.tmp`
    );
    fs.writeFileSync(temp, text, 'utf8');
    try {
        const mode = fs.statSync(filePath).mode & 0o777;
        fs.chmodSync(temp, mode);
    } catch {
        // New file (or unreadable stat): the default mode is correct.
    }
    try {
        fs.renameSync(temp, filePath);
    } catch (error) {
        try {
            fs.rmSync(temp, { force: true });
        } catch {
            // Best effort; the rename error is the one that matters.
        }
        throw error;
    }
}

export interface EditorOptions {
    /** Scratchpad save target — the store dispatch. */
    readonly saveScratchpad: (paneID: string, text: string) => void;
    /** Defaults to `writeFileAtomic`. */
    readonly writeFile?: ((filePath: string, text: string) => void) | undefined;
    /** Called after a successful save (the service re-renders + notifies subscribers). */
    readonly onSaved?: ((paneID: string, text: string) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly debounceMs?: number | undefined;
}

export interface EditorBuffers {
    /** Record a client edit and (re)start the debounce. */
    set(paneID: string, target: EditorTarget, text: string): void;
    /** Load the buffer without marking it dirty (opening a file into edit mode). */
    seed(paneID: string, target: EditorTarget, text: string): void;
    text(paneID: string): string | undefined;
    isDirty(paneID: string): boolean;
    /** Save now if a save is pending. Returns true when something was written. */
    flush(paneID: string): boolean;
    /** Every dirty buffer, synchronously (shutdown). */
    flushAll(): void;
    /** Flush, then forget the pane entirely. */
    forget(paneID: string): void;
    /** Forget WITHOUT saving (the pane is gone / the file was reloaded from disk). */
    drop(paneID: string): void;
    readonly dirtyPaneIDs: readonly string[];
    dispose(): void;
}

interface Buffer {
    target: EditorTarget;
    text: string;
    dirty: boolean;
    timer: ReturnType<typeof setTimeout> | null;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function createEditorBuffers(options: EditorOptions): EditorBuffers {
    const debounceMs = options.debounceMs ?? EDITOR_AUTOSAVE_DEBOUNCE_MS;
    const writeFile = options.writeFile ?? writeFileAtomic;
    const buffers = new Map<string, Buffer>();
    let disposed = false;

    const cancel = (buffer: Buffer): void => {
        if (buffer.timer === null) return;
        clearTimeout(buffer.timer);
        buffer.timer = null;
    };

    const save = (paneID: string, buffer: Buffer): boolean => {
        cancel(buffer);
        if (!buffer.dirty) return false;
        try {
            if (buffer.target.kind === 'file') writeFile(buffer.target.path, buffer.text);
            else options.saveScratchpad(paneID, buffer.text);
            buffer.dirty = false;
            options.onSaved?.(paneID, buffer.text);
            return true;
        } catch (error) {
            // §4.2: "Write errors are logged, not surfaced." The buffer stays dirty so the next
            // keystroke (or the shutdown flush) retries.
            options.onError?.(toError(error), `editor save ${paneID}`);
            return false;
        }
    };

    return {
        set(paneID, target, text) {
            if (disposed) return;
            const existing = buffers.get(paneID);
            const buffer: Buffer = existing ?? { target, text, dirty: false, timer: null };
            buffer.target = target;
            buffer.text = text;
            buffer.dirty = true;
            buffers.set(paneID, buffer);
            cancel(buffer);
            buffer.timer = setTimeout(() => {
                buffer.timer = null;
                save(paneID, buffer);
            }, debounceMs);
            buffer.timer.unref?.();
        },
        seed(paneID, target, text) {
            if (disposed) return;
            const existing = buffers.get(paneID);
            if (existing !== undefined) cancel(existing);
            buffers.set(paneID, { target, text, dirty: false, timer: null });
        },
        text(paneID) {
            return buffers.get(paneID)?.text;
        },
        isDirty(paneID) {
            return buffers.get(paneID)?.dirty === true;
        },
        flush(paneID) {
            const buffer = buffers.get(paneID);
            if (buffer === undefined) return false;
            return save(paneID, buffer);
        },
        flushAll() {
            for (const [paneID, buffer] of buffers) save(paneID, buffer);
        },
        forget(paneID) {
            const buffer = buffers.get(paneID);
            if (buffer === undefined) return;
            save(paneID, buffer);
            cancel(buffer);
            buffers.delete(paneID);
        },
        drop(paneID) {
            const buffer = buffers.get(paneID);
            if (buffer === undefined) return;
            cancel(buffer);
            buffers.delete(paneID);
        },
        get dirtyPaneIDs() {
            return [...buffers].filter(([, buffer]) => buffer.dirty).map(([paneID]) => paneID);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const buffer of buffers.values()) cancel(buffer);
            buffers.clear();
        }
    };
}
