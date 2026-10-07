/**
 * The same `PtyManager`, telling one observer about every byte written INTO a pane.
 *
 * The agent launcher needs to know when somebody types into a pane it is about to type into
 * (docs/agent-lifecycle.md §6.5, `userInputSinceLaunch`): a paste that lands in the middle of
 * someone's typing interleaves with it, so the launcher gives up instead. Every input path in the
 * daemon (a client's keystrokes and mouse reports on the PTY stream, `pane send` / `send-key`,
 * a dropped file, a web-inspector paste, a plugin terminal) writes through the manager boot hands
 * out, so wrapping that one object observes all of them without any of them knowing.
 *
 * What it deliberately does NOT see, because boot keeps those writers on the inner manager:
 *
 *   - the terminal's own query replies (DA1 / DA2 / DSR, the kitty flags; `onQueryReply` in
 *     `boot/compose.ts`): the emulator answering a question is not a person typing;
 *   - the launcher's own launch line and paste.
 *
 * The observer is told the pane and the bytes, and is called BEFORE the write, so it has heard
 * about the input by the time the bytes can have any effect. A throwing observer is the
 * observer's problem: the write still happens. Sync-group mirroring happens inside the inner
 * manager, so a mirrored keystroke is reported once, for the pane it was typed into.
 *
 * Every other method is a plain delegation, written out (as in `withSpawnGate`) so a method added
 * to `KelpiPtyManager` later fails to compile here instead of quietly bypassing the wrapper.
 */

import type { KelpiPtyManager } from './manager.js';

export type PaneInputObserver = (paneID: string, data: Uint8Array | string) => void;

export function withInputObserver(pty: KelpiPtyManager, observe: PaneInputObserver): KelpiPtyManager {
    const notify = (paneID: string, data: Uint8Array | string): void => {
        try {
            observe(paneID, data);
        } catch {
            // Observation must never cost the user a keystroke.
        }
    };
    return {
        spawn(opts): void {
            pty.spawn(opts);
        },
        has(paneID: string): boolean {
            return pty.has(paneID);
        },
        write(paneID: string, data: Uint8Array | string): void {
            notify(paneID, data);
            pty.write(paneID, data);
        },
        writeDirect(paneID: string, data: Uint8Array | string): void {
            notify(paneID, data);
            pty.writeDirect(paneID, data);
        },
        resize(paneID: string, cols: number, rows: number): void {
            pty.resize(paneID, cols, rows);
        },
        pauseOutput(paneID: string): void {
            pty.pauseOutput(paneID);
        },
        resumeOutput(paneID: string): void {
            pty.resumeOutput(paneID);
        },
        kill(paneID: string): void {
            pty.kill(paneID);
        },
        killAll(): Promise<void> {
            return pty.killAll();
        },
        setSyncGroup(workspaceID: string, paneIDs: ReadonlySet<string>): void {
            pty.setSyncGroup(workspaceID, paneIDs);
        },
        onData(cb: (paneID: string, data: Uint8Array) => void): () => void {
            return pty.onData(cb);
        },
        onExit(cb: (paneID: string, exitCode: number) => void): () => void {
            return pty.onExit(cb);
        },
        pid(paneID: string): number | undefined {
            return pty.pid(paneID);
        },
        shell(paneID: string): string | undefined {
            return pty.shell(paneID);
        },
        count(): number {
            return pty.count();
        },
        paneIDs(): string[] {
            return pty.paneIDs();
        },
        isSyncing(paneID: string): boolean {
            return pty.isSyncing(paneID);
        },
        syncTargetIDs(sourcePaneID: string): Set<string> {
            return pty.syncTargetIDs(sourcePaneID);
        },
        processHandle(paneID: string) {
            return pty.processHandle(paneID);
        },
        // Output, not input: `pane-clear` drawing into the pane is nobody typing.
        injectOutput(paneID: string, data: Uint8Array | string): void {
            pty.injectOutput(paneID, data);
        },
        adopt(paneID, proc): void {
            pty.adopt(paneID, proc);
        },
        forget(paneID: string): void {
            pty.forget(paneID);
        }
    };
}
