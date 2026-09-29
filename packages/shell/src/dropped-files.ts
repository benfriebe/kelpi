/**
 * #288: the shell's half of a file dropped from Finder onto a terminal pane.
 *
 * ## Why the main process has to do this
 *
 * A drop onto a terminal types the dropped paths (TERM-040), and a page cannot read them:
 *
 *  - Chromium keeps file paths out of a drag's `text/uri-list` and `text/plain`
 *    (`content/browser/web_contents/web_drag_dest_mac.mm`, `PopulateDropDataFromPasteboard`: "To
 *    avoid exposing file system paths to web content, filenames in the drag are not converted to
 *    file URLs"). The page gets `types: ["Files"]` and `File` objects with a name and bytes.
 *  - Electron ≥ 32 removed `File.path`; its replacement, `webUtils.getPathForFile`, is reachable
 *    only from a preload, and this shell deliberately has none (`main.ts`).
 *
 * The `File` objects ARE backed by the real paths inside the renderer ("real files already on
 * disk ... backed by actual file paths", the same Chromium function), and the DevTools protocol
 * will say what they are: `DOM.getFileInfo` takes a `File`'s remote object and answers its path.
 * The main process can speak that protocol to its own window through `webContents.debugger`
 * without giving the page anything to call, which is the whole point of having no preload.
 *
 * ## The exchange
 *
 * The page parks the dropped `File`s on `globalThis[DROPPED_FILES_STASH]`, a `Map`, under the
 * request id, and asks through the daemon (`daemon/src/ws/desktop.ts`). Here: attach, read and
 * DELETE that one entry in a single evaluation, resolve each element, release the remote objects,
 * detach. Measured in a standalone Electron 43 probe before this was written: it works with the
 * page sandboxed and context-isolated, with a remote-debugging client (the harness) attached to
 * the same page, and with DevTools open on it.
 *
 * ## What the page can and cannot learn through it
 *
 * Nothing new. The evaluation runs in the page's own world, so a hostile page could put anything
 * in the stash, but `DOM.getFileInfo` answers only for a genuine `File` backed by a file on disk
 * (Blink checks the wrapper type natively, whatever the object calls itself), and a page holds such
 * a `File` only when the user handed it one: a drop or an `<input type=file>`. So the most a page
 * can learn is the path of a file the user chose to give it, which is what a terminal drop types
 * anyway. The page cannot name an object, a method or an expression here: the request id is the
 * only thing interpolated, and it goes in as a JSON string literal.
 *
 * Pure apart from the debugger it is handed, so the rules are testable without Electron.
 */

import { DROPPED_FILES_STASH, MAX_DROPPED_FILES } from '@kelpi/protocol';

/** The slice of Electron's `Debugger` this module drives; a test hands it a fake. */
export interface DebuggerLike {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

export interface DroppedFilesResult {
    /** Absolute paths, in drop order. */
    readonly paths: string[];
    /** Items that were not a file on disk (a `File` built from bytes, or not a `File` at all). */
    readonly unresolved: number;
    /** Why nothing could be read, when that is the case. */
    readonly error?: string;
}

/** Released as one group, so a failure halfway through leaks nothing into the page. */
export const DROPPED_FILES_OBJECT_GROUP = 'kelpi-dropped-files';

/**
 * The one evaluation: take the entry out of the stash and hand back the array it held.
 *
 * Read-and-delete together, so an entry is resolvable exactly once and the page's `File`s do not
 * outlive the request (the page also deletes it when it stops waiting, whichever comes first).
 * `undefined` for anything but an array under that id: a missing stash, a missing entry, a page
 * that reloaded between the drop and here.
 */
export function stashTakeExpression(requestID: string): string {
    const stash = JSON.stringify(DROPPED_FILES_STASH);
    const id = JSON.stringify(requestID);
    return `(() => {
        const stash = globalThis[${stash}];
        if (!(stash instanceof Map)) return undefined;
        const files = stash.get(${id});
        stash.delete(${id});
        return Array.isArray(files) ? files : undefined;
    })()`;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Resolve the `File`s the page stashed under `requestID` to their paths.
 *
 * Never throws: every failure is an answer (an `error`, or a count of unresolved items), because
 * the page is waiting on one and silence would cost it a timeout. A debugger somebody else
 * attached through this same API is borrowed and left attached; one attached here is detached
 * again, whatever happened in between.
 */
export async function resolveDroppedFiles(target: DebuggerLike, requestID: string): Promise<DroppedFilesResult> {
    const borrowed = target.isAttached();
    if (!borrowed) {
        try {
            target.attach('1.3');
        } catch (error) {
            return { paths: [], unresolved: 0, error: `could not attach to the window: ${message(error)}` };
        }
    }
    try {
        const evaluated = record(
            await target.sendCommand('Runtime.evaluate', {
                expression: stashTakeExpression(requestID),
                objectGroup: DROPPED_FILES_OBJECT_GROUP,
                returnByValue: false,
                silent: true
            })
        );
        const array = record(evaluated?.['result']);
        const arrayID = array?.['objectId'];
        if (typeof arrayID !== 'string') {
            return { paths: [], unresolved: 0, error: 'the dropped files were no longer waiting on the page' };
        }
        const properties = record(
            await target.sendCommand('Runtime.getProperties', { objectId: arrayID, ownProperties: true })
        );
        const list = Array.isArray(properties?.['result']) ? (properties['result'] as unknown[]) : [];
        // Array indices only, in order: `length` and anything a page hung on the array are not
        // dropped items.
        const items = list
            .map(record)
            .filter((entry): entry is Record<string, unknown> => entry !== null && /^\d+$/.test(String(entry['name'])))
            .sort((a, b) => Number(a['name']) - Number(b['name']));
        const paths: string[] = [];
        let unresolved = 0;
        for (const item of items) {
            if (paths.length >= MAX_DROPPED_FILES) break;
            const objectID = record(item['value'])?.['objectId'];
            if (typeof objectID !== 'string') {
                unresolved += 1;
                continue;
            }
            try {
                const info = record(await target.sendCommand('DOM.getFileInfo', { objectId: objectID }));
                const found = info?.['path'];
                // An empty path is a `File` made from bytes (an image dragged out of a web page, a
                // screenshot thumbnail's promise): it exists, but nowhere on disk.
                if (typeof found === 'string' && found.startsWith('/')) paths.push(found);
                else unresolved += 1;
            } catch {
                // Not a File at all, whatever it called itself.
                unresolved += 1;
            }
        }
        return { paths, unresolved };
    } catch (error) {
        return { paths: [], unresolved: 0, error: `could not read the dropped files: ${message(error)}` };
    } finally {
        try {
            await target.sendCommand('Runtime.releaseObjectGroup', { objectGroup: DROPPED_FILES_OBJECT_GROUP });
        } catch {
            // The page went away, and the group with it.
        }
        if (!borrowed) {
            try {
                target.detach();
            } catch {
                // Already detached (the window closed under us).
            }
        }
    }
}

/**
 * One lookup at a time per window. Two quick drops would otherwise overlap: the second would see
 * the first's attachment, borrow it, and have it detached from under it halfway through its own
 * reads. Each call waits for the one before it, success or failure.
 */
export function serialized<A extends unknown[], R>(run: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    let tail: Promise<unknown> = Promise.resolve();
    return (...args: A): Promise<R> => {
        const next = tail.then(
            () => run(...args),
            () => run(...args)
        );
        tail = next.catch(() => undefined);
        return next;
    };
}
