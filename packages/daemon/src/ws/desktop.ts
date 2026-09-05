/**
 * Desktop gestures the CLI has no vocabulary for: the ⌘O picker, ⌘-clicking a path in a
 * terminal, hosting `$EDITOR` in a markdown pane, the ••• menu's shell items, and rebinding the
 * control socket.
 *
 * WS-only for the usual reason (`WS_ONLY_COMMANDS`): giving any of them a wire verb would be a
 * compatibility surface owed to the shipped Swift CLI forever. They live on their own channel
 * rather than inside `handleWsOnlyCommand` because each one needs something the store alone
 * cannot give — a PTY, the terminal buffer, the broadcast seam, or the control listeners.
 *
 * ## The two directions, and why both go through the daemon
 *
 * The Electron shell has **no preload script** (`shell/src/main.ts` explains why: the renderer
 * surface stays empty and there is no `contextBridge` API for a compromised page to reach), so
 * the page and the main process cannot talk directly. They already have a channel that works in
 * every state — the daemon — and `reveal-path` (client → daemon → shell) and `reveal-request`
 * (shell → daemon → client) are the two shapes it takes. Everything here reuses them:
 *
 *   client → daemon → shell   `shell-action` → a `shell-action` broadcast
 *                             (`open-file-dialog`, `install-cli`, `check-for-updates`)
 *   shell  → daemon → client  `menu-request` (`ws/sync.ts`) → a `menu-command` fan-out
 *                             (the Help menu item, ⌘O from the native File menu)
 *
 * The shell answers `open-file-dialog` with a **native** `dialog.showOpenDialog` and then sends
 * the chosen path back over its own control connection as the ordinary `open` verb — the same
 * path Finder's "Open With" already takes (`shell/src/main.ts` `forwardOpen`). Nothing about the
 * file open is special-cased: the daemon sees one `open` command, whoever raised it.
 *
 * ## `open-terminal-target` (CONT-122 / TERM-052)
 *
 * `GhosttyApp.swift:267-292` got a URL from libghostty's own link detection. Neither renderer
 * this port ships exposes one, so the split is the same one scrollback search already took: the
 * client computes the clicked **cell** from the pane's grid geometry, and the daemon — which
 * holds the authoritative `@xterm/headless` buffer — reads the token there, applies the Swift
 * trimming rules, resolves it against the pane's working directory and decides. Only a `.md`
 * file opens a markdown pane; everything else is reported back so the client can fall through
 * to the system opener, exactly as returning `false` did in Swift.
 *
 * ## `markdown-external-editor` (CONT-081…091)
 *
 * `open` resolves `$VISUAL`/`$EDITOR` (`content/external-editor.ts`), records the launch command
 * on the pane and gives the pane a PTY running it. The pane is a markdown pane throughout — it
 * is `externalEditorCommand` that makes the client draw a terminal instead of the preview, and
 * the same field is what `paneProcessTerminated` reads to flip the pane back to preview when the
 * editor exits on its own (CONT-091). Sync groups are unaffected by construction: `syncedPaneIDs`
 * admits shell panes only, so an editor pane can never join the broadcast group (CONT-089's
 * sibling rule), and `refreshSyncGroup` is called anyway so the group is recomputed from truth.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject } from '@kelpi/protocol';

import type { EditorResolver } from '../content/external-editor.js';
import { formatEditorCommand } from '../content/external-editor.js';
import {
    refreshSyncGroup,
    spawnEnvVars,
    type PaneHandlerContext
} from '../handlers/pane/index.js';
import { visiblePane, workspaceByID, workspaceContainingVisiblePane } from '../store/derived.js';
import { newUUID } from '@kelpi/core/codec';

export const DESKTOP_COMMANDS = [
    'shell-action',
    'restart-control-server',
    'open-terminal-target',
    'markdown-external-editor',
    'paste-image',
    'drop-text'
] as const;
export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export function isDesktopCommand(command: string): command is DesktopCommand {
    return (DESKTOP_COMMANDS as readonly string[]).includes(command);
}

/** What a client may ask the attached Electron shell to do. Anything else is refused. */
export const SHELL_ACTIONS = ['open-file-dialog', 'install-cli', 'check-for-updates'] as const;
export type ShellAction = (typeof SHELL_ACTIONS)[number];

/** The broadcast the shell listens for (`shell/src/status.ts`). */
export const SHELL_ACTION_EVENT = 'shell-action';

/** Extensions the ⌘-click route opens as a markdown pane. Swift: `path.hasSuffix(".md")`. */
export const TERMINAL_MARKDOWN_SUFFIX = '.md';

/** Where a pasted image lands, exactly as `ClipboardImageHelper.swift:10-42` chose. */
export const CLIPBOARD_IMAGE_DIR = 'kelpi-clipboard-images';
/** A pasted image bigger than this is refused rather than buffered (a 32 MB base64 line). */
export const MAX_PASTE_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * The shell-escape set `SurfaceView.swift:29-33` applies before typing a path — the same one the
 * client uses for a dropped path, restated here because this side types the path too.
 */
const SHELL_ESCAPE_CHARACTERS = new Set([...' \t\\()[]{}<>"\'`!#$&;|*?']);

export function shellEscapePath(target: string): string {
    let out = '';
    for (const character of target) {
        if (SHELL_ESCAPE_CHARACTERS.has(character)) out += '\\';
        out += character;
    }
    return out;
}

export interface DesktopChannel {
    run(command: DesktopCommand, payload: Record<string, unknown>): Promise<JsonObject>;
}

export interface DesktopChannelOptions {
    readonly ctx: PaneHandlerContext;
    /** `$VISUAL`/`$EDITOR` resolution + launch-command formatting (CONT-082…088). */
    readonly editor?: EditorResolver | undefined;
    /**
     * Close and re-bind the control listeners (APP-054 / AGNT-006). Absent = the verb answers
     * "not available", which is what a daemon composed without a control server should say.
     */
    readonly restartControl?: (() => Promise<{ socketPath: string; tcpPort?: number | undefined }>) | undefined;
    /** Existence probe; injected by tests so no real file is needed. */
    readonly fileExists?: ((target: string) => boolean) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

function failure(error: string): JsonObject {
    return { ok: false, error };
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// Terminal token extraction (pure — the interesting half of `open-terminal-target`)
// ---------------------------------------------------------------------------

/**
 * Characters that can never be *inside* a clicked path token.
 *
 * Whitespace ends a token; the quote/bracket/pipe set is the shell-and-prose punctuation that
 * wraps paths in real terminal output (`cat "notes.md"`, `<docs/a.md>`, `foo | bar`). Everything
 * else — including `(`, `)`, `[`, `]`, `-`, `_`, `.` — stays, because those appear in real file
 * names; the trailing-punctuation trim below is what handles them at the edges.
 */
const TOKEN_BREAK = new Set([' ', '\t', '\n', '\r', '"', "'", '`', '<', '>', '|']);
/** Wrappers stripped from both ends when they are balanced around the token. */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
];

/**
 * The token under `offset` in `line`, with the Swift trimming rules applied.
 *
 * `GhosttyApp.swift:267-292` trimmed trailing whitespace (ghostty's URL regex pads a match to
 * end-of-line) and then trailing dots. We do both, and additionally drop trailing prose
 * punctuation (`,;:`) and a balanced wrapper pair, because a token here comes from a plain-text
 * scan rather than a URL regex and therefore keeps punctuation the regex would have excluded.
 */
export function tokenAt(line: string, offset: number): string | null {
    if (offset < 0 || offset >= line.length) return null;
    if (TOKEN_BREAK.has(line[offset] as string)) return null;
    let start = offset;
    while (start > 0 && !TOKEN_BREAK.has(line[start - 1] as string)) start -= 1;
    let end = offset;
    while (end + 1 < line.length && !TOKEN_BREAK.has(line[end + 1] as string)) end += 1;
    let token = line.slice(start, end + 1);

    for (const [open, close] of WRAPPERS) {
        while (token.startsWith(open) && token.endsWith(close) && token.length > 1) {
            token = token.slice(1, -1);
        }
    }
    // Trailing dots first (the Swift rule), then prose punctuation, then dots again so
    // `see notes.md.,` lands on `notes.md`.
    for (let pass = 0; pass < 2; pass++) {
        while (token.endsWith('.')) token = token.slice(0, -1);
        while (token.endsWith(',') || token.endsWith(';') || token.endsWith(':')) {
            token = token.slice(0, -1);
        }
    }
    while (token.endsWith(')') && !token.includes('(')) token = token.slice(0, -1);
    while (token.endsWith(']') && !token.includes('[')) token = token.slice(0, -1);
    return token === '' ? null : token;
}

/** `~` expansion + resolution against the pane's cwd + `standardizingPath`'s normalisation. */
export function resolveTerminalPath(token: string, cwd: string, home: string): string {
    if (token === '~') return home;
    if (token.startsWith('~/')) return path.normalize(path.join(home, token.slice(2)));
    if (path.isAbsolute(token)) return path.normalize(token);
    return path.normalize(path.resolve(cwd, token));
}

/** A token that is a real URL rather than a path — the client hands these to the OS opener. */
export function urlFromToken(token: string): string | null {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) return null;
    try {
        const parsed = new URL(token);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

export function createDesktopChannel(options: DesktopChannelOptions): DesktopChannel {
    const { ctx } = options;
    const now = (): number => (ctx.clock ?? Date.now)();
    const mint = (): string => (ctx.mintPaneID ?? newUUID)();
    const exists =
        options.fileExists ??
        ((target: string): boolean => {
            try {
                return fs.statSync(target).isFile();
            } catch {
                return false;
            }
        });

    /** client → shell. The daemon has no window, so it fans out and whichever shell acts. */
    const shellAction = (payload: Record<string, unknown>): JsonObject => {
        const action = text(payload['action']);
        if (action === undefined || !(SHELL_ACTIONS as readonly string[]).includes(action)) {
            return failure(`shell-action requires action ${SHELL_ACTIONS.join(' | ')}`);
        }
        const windowID = text(payload['window_id']);
        const paneID = text(payload['pane_id']);
        ctx.broadcast({
            type: SHELL_ACTION_EVENT,
            action,
            ...(windowID === undefined ? {} : { windowID }),
            ...(paneID === undefined ? {} : { paneID })
        });
        return { ok: true, action };
    };

    /**
     * APP-054 / AGNT-006. `AppReducer.swift:2454-2464` stops and starts the socket server and
     * re-adds TCP when configured; the dispatcher is a singleton there and the seam here, so a
     * command that arrives a millisecond after the rebind is handled by the same handlers.
     */
    const restartControlServer = async (): Promise<JsonObject> => {
        const restart = options.restartControl;
        if (restart === undefined) return failure('this daemon has no control server to restart');
        try {
            const result = await restart();
            return {
                ok: true,
                socket_path: result.socketPath,
                ...(result.tcpPort === undefined ? {} : { tcp_port: result.tcpPort })
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.onError?.(error instanceof Error ? error : new Error(message), 'restart-control-server');
            return failure(`control server could not be rebound: ${message}`);
        }
    };

    /** CONT-122 / TERM-052: what a ⌘-click on a terminal cell resolves to. */
    const openTerminalTarget = async (payload: Record<string, unknown>): Promise<JsonObject> => {
        const paneID = text(payload['pane_id']);
        if (paneID === undefined) return failure('open-terminal-target requires pane_id');
        const row = integer(payload['row']);
        const col = integer(payload['col']);
        if (row === undefined || col === undefined) {
            return failure('open-terminal-target requires numeric row and col');
        }
        const state = ctx.store.getState();
        const workspace = workspaceContainingVisiblePane(state, paneID);
        if (workspace === null) return failure(`pane not found: ${paneID}`);
        const pane = visiblePane(workspace, paneID);
        if (pane === null || pane.type !== 'shell') {
            return failure(`pane '${paneID}' is not a terminal pane`);
        }

        const reads = ctx.term as Partial<{
            cellTextAsync(id: string, r: number, c: number): Promise<{ text: string; offset: number } | null>;
            cellText(id: string, r: number, c: number): { text: string; offset: number } | null;
        }>;
        const cell =
            reads.cellTextAsync !== undefined
                ? await reads.cellTextAsync(paneID, row, col)
                : (reads.cellText?.(paneID, row, col) ?? null);
        if (cell === null) return { ok: true, opened: 'none' };

        const token = tokenAt(cell.text, cell.offset);
        if (token === null) return { ok: true, opened: 'none' };

        // A real URL is ghostty's default-opener case: report it and let the client hand it to
        // the OS, which is what returning `false` from the Swift action callback did.
        const url = urlFromToken(token);
        if (url !== null) return { ok: true, opened: 'external', url, token };

        const resolved = resolveTerminalPath(token, pane.workingDirectory, state.homeDirectory);
        // Case-sensitive, matching `path.hasSuffix(".md")` in `GhosttyApp.swift:280`.
        if (!resolved.endsWith(TERMINAL_MARKDOWN_SUFFIX)) {
            return { ok: true, opened: 'none', token, path: resolved };
        }
        // Deliberate improvement over the Swift path, which opened a pane for any `.md`-suffixed
        // word: a ⌘-click on prose must not leave a broken preview behind. The client says so.
        if (!exists(resolved)) return { ok: true, opened: 'missing', token, path: resolved };

        const newPaneID = mint();
        ctx.store.dispatch({ type: 'focus-pane', workspaceID: workspace.id, paneID });
        ctx.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: workspace.id,
            paneID: newPaneID,
            filePath: resolved,
            now: now()
        });
        refreshSyncGroup(ctx, workspace.id);
        return {
            ok: true,
            opened: 'markdown',
            path: resolved,
            token,
            pane_id: newPaneID,
            workspace_id: workspace.id
        };
    };

    /** CONT-081…091. `open` hosts the editor; `close` ends the session and returns to preview. */
    const markdownExternalEditor = async (payload: Record<string, unknown>): Promise<JsonObject> => {
        const paneID = text(payload['pane_id']);
        if (paneID === undefined) return failure('markdown-external-editor requires pane_id');
        const action = text(payload['action']) ?? 'open';
        if (action !== 'open' && action !== 'close') {
            return failure("markdown-external-editor requires action 'open' or 'close'");
        }
        const state = ctx.store.getState();
        const workspace = workspaceContainingVisiblePane(state, paneID);
        if (workspace === null) return failure(`pane not found: ${paneID}`);
        const pane = visiblePane(workspace, paneID);
        if (pane === null || pane.type !== 'markdown') {
            return failure(`pane '${paneID}' is not a markdown pane`);
        }

        if (action === 'close') {
            // CONT-090: the surface dies with the mode, or the editor process and its PTY leak.
            ctx.pty.kill(paneID);
            ctx.term.dispose(paneID);
            ctx.store.dispatch({
                type: 'set-markdown-editing',
                workspaceID: workspace.id,
                paneID,
                editing: false
            });
            refreshSyncGroup(ctx, workspace.id);
            return { ok: true, pane_id: paneID, workspace_id: workspace.id, editing: false };
        }

        const filePath = pane.filePath;
        if (filePath === null || filePath === '') {
            return failure(`pane '${paneID}' has no file to edit`);
        }
        const resolver = options.editor;
        if (resolver === undefined) return failure('external editor support is not available');
        // A user-initiated open may wait for the probe; the cached answer makes this instant
        // after boot's warm-up (CONT-086/087).
        const resolution = await resolver.resolve();
        if (resolution === null) {
            return failure('no $VISUAL or $EDITOR is set - set one in your shell profile');
        }
        const command = formatEditorCommand(resolution.editor, filePath, resolution.path);

        // A clean VT per session: re-entering the editor on the same pane must not replay the
        // last one's screen (and `attach` on a live pane would be a no-op otherwise).
        ctx.pty.kill(paneID);
        ctx.term.dispose(paneID);

        ctx.store.dispatch({
            type: 'set-markdown-editing',
            workspaceID: workspace.id,
            paneID,
            editing: true,
            externalEditorCommand: command
        });

        const after = workspaceByID(ctx.store.getState(), workspace.id);
        /**
         * `$EDITOR` is as unreflowable as a shell prompt — vim paints for the grid it was
         * born into — and a markdown pane has never had a terminal, so the geometry cache has
         * nothing for this pane and `sizeFor` answers with the last size some OTHER pane was
         * rendered at. The gate holds the spawn for the client's own measurement of THIS pane,
         * which arrives as soon as the renderer mounts a surface for the editing pane
         * (`pty/spawn-gate.ts`). It declines when nobody is attached, and this is then the
         * immediate spawn it always was.
         */
        const spawnEditor = (size: { cols: number; rows: number } | null): string | null => {
            const cols = size?.cols ?? ctx.spawn?.sizeFor?.(paneID)?.cols ?? ctx.spawn?.cols ?? 80;
            const rows = size?.rows ?? ctx.spawn?.sizeFor?.(paneID)?.rows ?? ctx.spawn?.rows ?? 24;
            try {
                ctx.pty.spawn({
                    paneID,
                    cwd: pane.workingDirectory,
                    // CONT-089: the editor's PTY gets the workspace profile env every terminal
                    // pane gets — same `mergedEnvVars` call, same `NEX_PANE_ID`, same overlay.
                    env: (after === null ? [] : spawnEnvVars(ctx, paneID, after)).map(
                        (entry) => [entry.key, entry.value] as const
                    ),
                    cols,
                    rows,
                    command,
                    ...(ctx.spawn?.shell === undefined ? {} : { shell: ctx.spawn.shell })
                });
                ctx.term.attach(paneID, cols, rows);
                return null;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                options.onError?.(error instanceof Error ? error : new Error(message), 'external-editor spawn');
                ctx.store.dispatch({
                    type: 'set-markdown-editing',
                    workspaceID: workspace.id,
                    paneID,
                    editing: false
                });
                return message;
            }
        };
        if (ctx.spawn?.deferSpawn?.(paneID, (size) => void spawnEditor(size)) !== true) {
            const message = spawnEditor(null);
            if (message !== null) return failure(`could not launch ${resolution.editor}: ${message}`);
        }
        refreshSyncGroup(ctx, workspace.id);
        return {
            ok: true,
            pane_id: paneID,
            workspace_id: workspace.id,
            editing: true,
            editor: resolution.editor,
            command
        };
    };

    /**
     * TERM-043 — a pasted image becomes a temp file, and its path is typed.
     *
     * `ClipboardImageHelper.swift:10-42` wrote `NSTemporaryDirectory()/kelpi-clipboard-images/
     * clipboard-<uuid>.png` and pasted the shell-escaped path; the same choice is made here, for
     * the same reason: the agent reading the file runs on the DAEMON's machine, so the bytes have
     * to land on the daemon's filesystem, not the browser's. That is also why the image travels
     * as base64 over the WS command channel rather than being written client-side.
     *
     * PNG only. The Swift helper accepted TIFF and re-encoded it through `NSBitmapImageRep`; a
     * browser clipboard hands over PNG already (`image/png` is the only type Chromium exposes for
     * a copied screenshot), so there is nothing to re-encode and an unknown type is refused
     * rather than written with a lying extension.
     */
    const pasteImage = async (payload: Record<string, unknown>): Promise<JsonObject> => {
        const paneID = text(payload['pane_id']);
        if (paneID === undefined) return failure('paste-image requires pane_id');
        const mime = text(payload['mime']) ?? 'image/png';
        if (mime !== 'image/png') return failure(`paste-image supports image/png, not '${mime}'`);
        const encoded = text(payload['data']);
        if (encoded === undefined) return failure('paste-image requires base64 data');

        const state = ctx.store.getState();
        const workspace = workspaceContainingVisiblePane(state, paneID);
        const pane = workspace === null ? null : visiblePane(workspace, paneID);
        if (pane === null) return failure(`pane not found: ${paneID}`);
        if (pane.type !== 'shell') return failure(`pane '${paneID}' is not a terminal pane`);

        let bytes: Buffer;
        try {
            bytes = Buffer.from(encoded, 'base64');
        } catch {
            return failure('paste-image data is not valid base64');
        }
        if (bytes.byteLength === 0) return failure('paste-image data is empty');
        if (bytes.byteLength > MAX_PASTE_IMAGE_BYTES) {
            return failure(
                `pasted image is ${String(bytes.byteLength)} bytes, over the ${String(MAX_PASTE_IMAGE_BYTES)} byte limit`
            );
        }

        const directory = path.join(os.tmpdir(), CLIPBOARD_IMAGE_DIR);
        const target = path.join(directory, `clipboard-${mint().toLowerCase()}.png`);
        try {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(target, bytes);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.onError?.(error instanceof Error ? error : new Error(message), 'paste-image');
            return failure(`could not write the pasted image: ${message}`);
        }

        // Bare: the path is typed, not submitted — the user is composing a prompt around it.
        ctx.input.sendText(paneID, shellEscapePath(target), { bare: true });
        return { ok: true, pane_id: paneID, path: target, bytes: bytes.byteLength };
    };

    /**
     * TERM-040 (issue #51): paths dropped onto a terminal pane, already shell-escaped and
     * space-joined by the client (`app/open-file.ts` `terminalDropText`).
     *
     * Not `pane-send --bare`, which is what the client used to call: terminal-surface.md §12.4
     * says a drop takes the outside-keystroke text path, and §8.2 item 2 says that path is
     * paste-piped AND mirrored to sync siblings, like a Cmd+V paste (the engine's paste rides
     * the mirrored PTY stream). `pane send` is a programmatic send and is exempt from
     * mirroring by §8.2 / §9, so a drop needs its own verb to reach `sendText` with
     * `mirror: true`. Bare, because the user is composing a command around the path, exactly
     * as the Swift drop did (`SurfaceView.swift:660-701`).
     */
    const dropText = async (payload: Record<string, unknown>): Promise<JsonObject> => {
        const paneID = text(payload['pane_id']);
        if (paneID === undefined) return failure('drop-text requires pane_id');
        const dropped = text(payload['text']);
        if (dropped === undefined || dropped === '') return failure('drop-text requires non-empty text');

        const state = ctx.store.getState();
        const workspace = workspaceContainingVisiblePane(state, paneID);
        const pane = workspace === null ? null : visiblePane(workspace, paneID);
        if (pane === null) return failure(`pane not found: ${paneID}`);
        if (pane.type !== 'shell') return failure(`pane '${paneID}' is not a terminal pane`);

        ctx.input.sendText(paneID, dropped, { bare: true, mirror: true });
        return { ok: true, pane_id: paneID };
    };

    return {
        async run(command, payload) {
            if (command === 'shell-action') return shellAction(payload);
            if (command === 'restart-control-server') return restartControlServer();
            if (command === 'open-terminal-target') return openTerminalTarget(payload);
            if (command === 'paste-image') return pasteImage(payload);
            if (command === 'drop-text') return dropText(payload);
            return markdownExternalEditor(payload);
        }
    };
}
