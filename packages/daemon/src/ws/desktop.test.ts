import { describe, expect, it } from 'vitest';

import type { EditorResolver } from '../content/external-editor.js';
import { harness, seedWorkspace, testID, W1, type Harness } from '../handlers/pane/testing.js';
import { visiblePane, workspaceByID } from '../store/derived.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    CLIPBOARD_IMAGE_DIR,
    MAX_PASTE_IMAGE_BYTES,
    SHELL_ACTION_EVENT,
    clippedByBorder,
    createDesktopChannel,
    isDesktopCommand,
    looksLikeLink,
    resolveTerminalPath,
    shellEscapePath,
    tokenAt,
    urlFromToken
} from './desktop.js';

const P0 = testID('D', 100);
const NEW = testID('E', 900);

/**
 * `calls` records every ask, because WHICH verb asks is now load-bearing: the resolver is lazy
 * and the ask is what forks the user's login shell (CONT-087, #115).
 */
function editorResolver(editor: string | null, calls: string[] = []): EditorResolver {
    const resolution = editor === null ? null : { editor, path: '/usr/bin:/bin', source: 'shell' as const };
    return {
        current: () => {
            calls.push('current');
            return resolution;
        },
        resolve: async () => {
            calls.push('resolve');
            return resolution;
        },
        buildCommand: () => {
            calls.push('buildCommand');
            return null;
        }
    };
}

interface Fixture {
    readonly h: Harness;
    readonly channel: ReturnType<typeof createDesktopChannel>;
    readonly restarts: number[];
    /** Every call the channel made on the editor resolver, in order (#115). */
    readonly editorCalls: string[];
}

function fixture(
    options: {
        editor?: string | null;
        cell?: { text: string; offset: number } | null;
        /** The OSC 8 URI the clicked cell carries (#83); absent means the pane has none. */
        hyperlink?: string | null;
        exists?: boolean;
        restart?: boolean;
    } = {}
): Fixture {
    const h = harness({ minted: [NEW] });
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P0, path: '/tmp/work' });
    const restarts: number[] = [];
    // The channel reads the cell through an OPTIONAL widening on the terminal service, exactly
    // as the real `TerminalStateServiceImpl` provides it.
    const term = h.term as unknown as {
        cellTextAsync?: (id: string, r: number, c: number) => Promise<{ text: string; offset: number } | null>;
        hyperlinkAtAsync?: (id: string, r: number, c: number) => Promise<string | null>;
    };
    if (options.cell !== undefined) {
        term.cellTextAsync = async () => options.cell ?? null;
    }
    if (options.hyperlink !== undefined) {
        term.hyperlinkAtAsync = async () => options.hyperlink ?? null;
    }
    const editorCalls: string[] = [];
    const channel = createDesktopChannel({
        ctx: h.ctx,
        editor: editorResolver(options.editor === undefined ? 'nvim' : options.editor, editorCalls),
        fileExists: () => options.exists !== false,
        ...(options.restart === false
            ? {}
            : {
                  restartControl: async () => {
                      restarts.push(Date.now());
                      return { socketPath: '/tmp/sandbox/kelpid.sock', tcpPort: 19999 };
                  }
              })
    });
    return { h, channel, restarts, editorCalls };
}

describe('isDesktopCommand', () => {
    it('names exactly the six verbs', () => {
        expect(isDesktopCommand('shell-action')).toBe(true);
        expect(isDesktopCommand('restart-control-server')).toBe(true);
        expect(isDesktopCommand('open-terminal-target')).toBe(true);
        expect(isDesktopCommand('markdown-external-editor')).toBe(true);
        expect(isDesktopCommand('paste-image')).toBe(true);
        expect(isDesktopCommand('drop-text')).toBe(true);
        expect(isDesktopCommand('pane-close')).toBe(false);
        expect(isDesktopCommand('reveal-path')).toBe(false);
    });
});

describe('tokenAt (CONT-122 trimming)', () => {
    it('takes the whitespace-delimited token under the offset', () => {
        expect(tokenAt('cat docs/notes.md now', 8)).toBe('docs/notes.md');
    });

    it('trims the trailing whitespace-padding and dots ghostty’s regex leaves', () => {
        expect(tokenAt('see notes.md...', 6)).toBe('notes.md');
        expect(tokenAt('see notes.md,', 6)).toBe('notes.md');
        expect(tokenAt('see notes.md.,', 6)).toBe('notes.md');
    });

    it('unwraps quotes, angle brackets and balanced parens', () => {
        expect(tokenAt('cat "notes.md"', 7)).toBe('notes.md');
        expect(tokenAt('cat <notes.md>', 7)).toBe('notes.md');
        expect(tokenAt('(notes.md)', 3)).toBe('notes.md');
        expect(tokenAt('see notes.md)', 6)).toBe('notes.md');
    });

    it('keeps punctuation that is really part of a filename', () => {
        expect(tokenAt('open my-file_v2.md', 8)).toBe('my-file_v2.md');
        expect(tokenAt('open a(1).md', 8)).toBe('a(1).md');
    });

    it('answers null on whitespace and outside the line', () => {
        expect(tokenAt('a b', 1)).toBeNull();
        expect(tokenAt('abc', 9)).toBeNull();
        expect(tokenAt('', 0)).toBeNull();
    });

    /**
     * #83. A TUI draws its frames out of box-drawing characters and, when the content fills the
     * box, glues them straight onto it with no padding cell. With `│` absent from the break set
     * the token kept the border and `urlFromToken`'s scheme anchor failed, so a ⌘-click on a
     * perfectly ordinary URL inside a ratatui box did nothing at all.
     */
    it('breaks on box-drawing and block characters, not just the ASCII pipe', () => {
        expect(tokenAt('│https://example.com/x│', 5)).toBe('https://example.com/x');
        expect(tokenAt('│docs/notes.md│', 3)).toBe('docs/notes.md');
        // The heavy, double and rounded variants a TUI picks between, and the blocks it draws
        // gauges out of.
        expect(tokenAt('┃notes.md┃', 2)).toBe('notes.md');
        expect(tokenAt('║notes.md║', 2)).toBe('notes.md');
        expect(tokenAt('█notes.md░', 2)).toBe('notes.md');
        expect(tokenAt('─notes.md─', 2)).toBe('notes.md');
        // And the border cell itself is not a token.
        expect(tokenAt('│https://example.com/x│', 0)).toBeNull();
    });
});

describe('clippedByBorder (#83)', () => {
    it('is true only when the token runs FLUSH into a border, with no padding cell', () => {
        // The head row of a hard-wrapped URL: the box was filled, so the address continues.
        expect(clippedByBorder('│https://example.com/wrapped/pa│', 5)).toBe(true);
        // The same box with a URL that fitted: a TUI pads what fits.
        expect(clippedByBorder('│ https://example.com/x │', 5)).toBe(false);
        // Nothing to the right at all: an ordinary line of shell output.
        expect(clippedByBorder('open https://example.com/x', 8)).toBe(false);
        expect(clippedByBorder('open https://example.com/x and more', 8)).toBe(false);
        expect(clippedByBorder('', 0)).toBe(false);
        expect(clippedByBorder('abc', 9)).toBe(false);
    });
});

describe('looksLikeLink (#83)', () => {
    it('is the difference between a refused link and a click on prose', () => {
        expect(looksLikeLink('https://example.com/x')).toBe(true);
        expect(looksLikeLink('file:///etc/passwd')).toBe(true);
        expect(looksLikeLink('slack://channel?id=1')).toBe(true);
        expect(looksLikeLink('docs/notes.md')).toBe(false);
        expect(looksLikeLink('cargo')).toBe(false);
        expect(looksLikeLink('example.com/x')).toBe(false);
    });
});

describe('resolveTerminalPath', () => {
    it('expands ~, resolves relatives against the pane cwd, and normalises', () => {
        expect(resolveTerminalPath('~/docs/a.md', '/tmp/work', '/Users/test')).toBe('/Users/test/docs/a.md');
        expect(resolveTerminalPath('a.md', '/tmp/work', '/Users/test')).toBe('/tmp/work/a.md');
        expect(resolveTerminalPath('./sub/../a.md', '/tmp/work', '/Users/test')).toBe('/tmp/work/a.md');
        expect(resolveTerminalPath('/abs/a.md', '/tmp/work', '/Users/test')).toBe('/abs/a.md');
    });
});

describe('urlFromToken', () => {
    it('recognises http(s) only', () => {
        expect(urlFromToken('https://example.com/x')).toBe('https://example.com/x');
        expect(urlFromToken('file:///etc/passwd')).toBeNull();
        expect(urlFromToken('notes.md')).toBeNull();
    });
});

describe('shell-action', () => {
    it('broadcasts the request so whichever shell is attached acts', async () => {
        const f = fixture();
        const reply = await f.channel.run('shell-action', {
            action: 'open-file-dialog',
            window_id: 'w-1',
            pane_id: P0
        });
        expect(reply).toMatchObject({ ok: true, action: 'open-file-dialog' });
        expect(f.h.broadcasts).toContainEqual({
            type: SHELL_ACTION_EVENT,
            action: 'open-file-dialog',
            windowID: 'w-1',
            paneID: P0
        });
    });

    it('refuses an action outside the allowlist', async () => {
        const f = fixture();
        const reply = await f.channel.run('shell-action', { action: 'rm-rf' });
        expect(reply).toMatchObject({ ok: false });
        expect(f.h.broadcasts).toHaveLength(0);
    });
});

describe('restart-control-server (APP-054 / AGNT-006)', () => {
    it('rebinds and reports where it is listening', async () => {
        const f = fixture();
        const reply = await f.channel.run('restart-control-server', {});
        expect(reply).toMatchObject({ ok: true, socket_path: '/tmp/sandbox/kelpid.sock', tcp_port: 19999 });
        expect(f.restarts).toHaveLength(1);
    });

    it('says so honestly when the daemon has no control server', async () => {
        const f = fixture({ restart: false });
        expect(await f.channel.run('restart-control-server', {})).toMatchObject({ ok: false });
    });

    it('turns a bind failure into an error reply rather than a throw', async () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P0 });
        const channel = createDesktopChannel({
            ctx: h.ctx,
            restartControl: async () => {
                throw new Error('EADDRINUSE');
            }
        });
        const reply = await channel.run('restart-control-server', {});
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('EADDRINUSE');
    });
});

describe('open-terminal-target (CONT-122 / TERM-052)', () => {
    it('opens a markdown pane for an existing .md path under the cell', async () => {
        const f = fixture({ cell: { text: 'cat docs/notes.md', offset: 8 } });
        const reply = await f.channel.run('open-terminal-target', { pane_id: P0, row: 3, col: 8 });
        expect(reply).toMatchObject({
            ok: true,
            opened: 'markdown',
            path: '/tmp/work/docs/notes.md',
            pane_id: NEW,
            workspace_id: W1
        });
        const pane = visiblePane(workspaceByID(f.h.state(), W1)!, NEW);
        expect(pane?.type).toBe('markdown');
        expect(pane?.filePath).toBe('/tmp/work/docs/notes.md');
    });

    it('reports a .md path that is not on disk instead of opening a broken pane', async () => {
        const f = fixture({ cell: { text: 'see notes.md', offset: 6 }, exists: false });
        const reply = await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6 });
        expect(reply).toMatchObject({ ok: true, opened: 'missing', path: '/tmp/work/notes.md' });
        expect(visiblePane(workspaceByID(f.h.state(), W1)!, NEW)).toBeNull();
    });

    it('hands a URL back for the system opener (Swift returned false here)', async () => {
        const f = fixture({ cell: { text: 'open https://example.com/x', offset: 8 } });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 8 })).toMatchObject({
            ok: true,
            opened: 'external',
            url: 'https://example.com/x'
        });
    });

    it('falls through for a non-.md token, and for an empty cell', async () => {
        const f = fixture({ cell: { text: 'cargo build --release', offset: 2 } });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 2 })).toMatchObject({
            ok: true,
            opened: 'none'
        });
        const empty = fixture({ cell: null });
        expect(await empty.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 0 })).toMatchObject({
            ok: true,
            opened: 'none'
        });
    });

    it('is case-sensitive on the suffix, matching `path.hasSuffix(".md")`', async () => {
        const f = fixture({ cell: { text: 'open README.MD', offset: 6 } });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6 })).toMatchObject({
            opened: 'none'
        });
    });

    /**
     * #83. The whole reason ⌘-click did nothing in a Codex pane: the address is in an OSC 8
     * attribute and the visible text is a title, so the token scan reads prose. The attribute
     * is read FIRST, and it wins over whatever the scan would have said.
     */
    it('prefers the OSC 8 hyperlink at the cell over the token under it', async () => {
        const f = fixture({
            hyperlink: 'https://example.com/full/path',
            cell: { text: 'see the docs now', offset: 8 }
        });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 8 })).toMatchObject({
            ok: true,
            opened: 'external',
            url: 'https://example.com/full/path',
            source: 'hyperlink'
        });
    });

    it('falls back to the token scan when the cell carries no hyperlink', async () => {
        const f = fixture({ hyperlink: null, cell: { text: 'open https://example.com/x', offset: 8 } });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 8 })).toMatchObject({
            ok: true,
            opened: 'external',
            url: 'https://example.com/x',
            source: 'token'
        });
    });

    /**
     * The silent-failure half of #83. A ⌘-click AIMED at a link that we refuse to hand the OS
     * comes back with a reason so the client can say a word; a ⌘-click on prose or on empty
     * screen deliberately does not, because a toast on every stray ⌘-click is noise.
     */
    it('reports a refused link with a reason, and stays silent about prose', async () => {
        const refusedLink = fixture({ hyperlink: 'file:///etc/passwd', cell: null });
        expect(await refusedLink.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 2 })).toMatchObject({
            ok: true,
            opened: 'none',
            reason: 'link-not-http',
            link: 'file:///etc/passwd'
        });

        const refusedToken = fixture({ cell: { text: 'see slack://channel now', offset: 6 } });
        expect(await refusedToken.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6 })).toMatchObject({
            ok: true,
            opened: 'none',
            reason: 'link-not-http',
            token: 'slack://channel'
        });

        // The head row of a hard-wrapped URL inside a ratatui box: a valid URL, and the WRONG
        // one. Declined with a reason rather than opened truncated.
        const clipped = fixture({ cell: { text: '  │https://example.com/wrapped/pa│', offset: 8 } });
        expect(await clipped.channel.run('open-terminal-target', { pane_id: P0, row: 2, col: 8 })).toMatchObject({
            ok: true,
            opened: 'none',
            reason: 'link-clipped',
            token: 'https://example.com/wrapped/pa'
        });
        // The same box with a URL that FITTED opens, because a TUI pads what fits.
        const fitted = fixture({ cell: { text: '  │ https://example.com/x │', offset: 9 } });
        expect(await fitted.channel.run('open-terminal-target', { pane_id: P0, row: 2, col: 9 })).toMatchObject({
            ok: true,
            opened: 'external',
            url: 'https://example.com/x'
        });

        const prose = fixture({ cell: { text: 'cargo build --release', offset: 2 } });
        const quiet = await prose.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 2 });
        expect(quiet).toMatchObject({ ok: true, opened: 'none' });
        expect(quiet['reason']).toBeUndefined();
    });

    it('refuses an unknown pane, a non-terminal pane and a missing cell', async () => {
        const f = fixture({ cell: { text: 'a.md', offset: 0 } });
        expect(await f.channel.run('open-terminal-target', { row: 0, col: 0 })).toMatchObject({ ok: false });
        expect(
            await f.channel.run('open-terminal-target', { pane_id: 'nope', row: 0, col: 0 })
        ).toMatchObject({ ok: false });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0 })).toMatchObject({ ok: false });

        // A markdown pane is not a terminal, so it has no cell to click.
        f.h.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: NEW,
            filePath: '/tmp/work/a.md',
            now: 1
        });
        expect(
            await f.channel.run('open-terminal-target', { pane_id: NEW, row: 0, col: 0 })
        ).toMatchObject({ ok: false });
    });
});

describe('markdown-external-editor (CONT-081…090)', () => {
    const MD = testID('F', 7);

    function withMarkdownPane(options: Parameters<typeof fixture>[0] = {}): Fixture {
        const f = fixture(options);
        f.h.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: MD,
            filePath: '/tmp/work/notes.md',
            now: 1
        });
        return f;
    }

    it('records the launch command and gives the pane a PTY running it', async () => {
        const f = withMarkdownPane();
        const reply = await f.channel.run('markdown-external-editor', { pane_id: MD });
        expect(reply).toMatchObject({
            ok: true,
            pane_id: MD,
            editing: true,
            editor: 'nvim',
            command: "/usr/bin/env PATH='/usr/bin:/bin' nvim '/tmp/work/notes.md'"
        });

        const pane = visiblePane(workspaceByID(f.h.state(), W1)!, MD);
        expect(pane?.isEditing).toBe(true);
        expect(pane?.externalEditorCommand).toBe("/usr/bin/env PATH='/usr/bin:/bin' nvim '/tmp/work/notes.md'");
        expect(pane?.type).toBe('markdown');

        const spawn = f.h.pty.spawns.at(-1);
        expect(spawn?.paneID).toBe(MD);
        expect(spawn?.command).toBe("/usr/bin/env PATH='/usr/bin:/bin' nvim '/tmp/work/notes.md'");
        expect(spawn?.cwd).toBe('/tmp/work');
        // CONT-089: the same env every terminal pane gets, including the pane marker.
        expect(spawn?.env.some(([key, value]) => key === 'KELPI_PANE_ID' && value === MD)).toBe(true);
        expect(f.h.term.attached.some((entry) => entry.paneID === MD)).toBe(true);
    });

    it('never joins the sync broadcast group', async () => {
        const f = withMarkdownPane();
        f.h.store.dispatch({ type: 'set-sync-input-active', workspaceID: W1, active: true });
        await f.channel.run('markdown-external-editor', { pane_id: MD });
        const group = f.h.pty.syncGroups.get(W1) ?? [];
        expect(group).not.toContain(MD);
    });

    it('close kills the PTY, drops the terminal state and returns to preview (CONT-090)', async () => {
        const f = withMarkdownPane();
        await f.channel.run('markdown-external-editor', { pane_id: MD });
        const reply = await f.channel.run('markdown-external-editor', { pane_id: MD, action: 'close' });
        expect(reply).toMatchObject({ ok: true, editing: false });
        expect(f.h.pty.killed).toContain(MD);
        expect(f.h.term.disposed).toContain(MD);
        const pane = visiblePane(workspaceByID(f.h.state(), W1)!, MD);
        expect(pane?.isEditing).toBe(false);
        expect(pane?.externalEditorCommand).toBeNull();
    });

    it('a process exit AFTER the session was closed does not delete the pane', async () => {
        // The audit found this: `close` clears `externalEditorCommand` and only then does the
        // PTY die, so the exit arrives at a markdown pane with nothing marking it as an editor.
        // Before the guard, branch 3 closed it — ⌘E deleted the user's document pane.
        const f = withMarkdownPane();
        await f.channel.run('markdown-external-editor', { pane_id: MD });
        await f.channel.run('markdown-external-editor', { pane_id: MD, action: 'close' });
        f.h.store.dispatch({ type: 'pane-process-terminated', paneID: MD });
        const pane = visiblePane(workspaceByID(f.h.state(), W1)!, MD);
        expect(pane).not.toBeNull();
        expect(pane?.type).toBe('markdown');
    });

    it('an editor that exits by itself returns the pane to preview (CONT-091)', async () => {
        const f = withMarkdownPane();
        await f.channel.run('markdown-external-editor', { pane_id: MD });
        // What boot dispatches from `pty.onExit`.
        f.h.store.dispatch({ type: 'pane-process-terminated', paneID: MD });
        const pane = visiblePane(workspaceByID(f.h.state(), W1)!, MD);
        expect(pane).not.toBeNull();
        expect(pane?.isEditing).toBe(false);
        expect(pane?.externalEditorCommand).toBeNull();
    });

    it('falls back with an explanation when no $VISUAL / $EDITOR resolves (CONT-083)', async () => {
        const f = withMarkdownPane({ editor: null });
        const reply = await f.channel.run('markdown-external-editor', { pane_id: MD });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('$VISUAL or $EDITOR');
        expect(f.h.pty.spawns.some((spawn) => spawn.paneID === MD)).toBe(false);
    });

    it('refuses a non-markdown pane, an unknown pane and a bad action', async () => {
        const f = withMarkdownPane();
        expect(await f.channel.run('markdown-external-editor', { pane_id: P0 })).toMatchObject({ ok: false });
        expect(await f.channel.run('markdown-external-editor', { pane_id: 'nope' })).toMatchObject({ ok: false });
        expect(await f.channel.run('markdown-external-editor', {})).toMatchObject({ ok: false });
        expect(
            await f.channel.run('markdown-external-editor', { pane_id: MD, action: 'sideways' })
        ).toMatchObject({ ok: false });
    });

    /**
     * CONT-087 / #115: the resolver is lazy, so the ask IS the login-shell fork. `open` is the
     * one verb entitled to make it, and only after the pane and its file have checked out: a
     * refused open must not fork a shell to tell the user the pane was wrong.
     */
    it('asks the resolver on open, and on nothing else', async () => {
        const f = withMarkdownPane();
        expect(f.editorCalls).toEqual([]);

        await f.channel.run('markdown-external-editor', { pane_id: 'nope' });
        await f.channel.run('markdown-external-editor', { pane_id: P0 });
        await f.channel.run('markdown-external-editor', { pane_id: MD, action: 'sideways' });
        await f.channel.run('markdown-external-editor', { pane_id: MD, action: 'close' });
        expect(f.editorCalls).toEqual([]);

        await f.channel.run('markdown-external-editor', { pane_id: MD });
        expect(f.editorCalls).toEqual(['resolve']);
    });
});

describe('paste-image (TERM-043)', () => {
    // A 1×1 transparent PNG.
    const PNG =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    it('writes the bytes next to the other clipboard images and types the escaped path', async () => {
        const f = fixture();
        const reply = await f.channel.run('paste-image', { pane_id: P0, data: PNG });
        expect(reply['ok']).toBe(true);
        const written = String(reply['path']);
        expect(path.dirname(written)).toBe(path.join(os.tmpdir(), CLIPBOARD_IMAGE_DIR));
        expect(path.basename(written)).toMatch(/^clipboard-[0-9a-f-]+\.png$/);
        expect(fs.existsSync(written)).toBe(true);
        expect(fs.readFileSync(written).byteLength).toBe(Buffer.from(PNG, 'base64').byteLength);

        // Typed, not submitted: the user is composing a prompt around the path.
        expect(f.h.input.texts.at(-1)).toEqual({
            paneID: P0,
            text: shellEscapePath(written),
            bare: true,
            mirror: false
        });
        fs.rmSync(written, { force: true });
    });

    it('refuses a non-PNG type rather than writing one with a lying extension', async () => {
        const f = fixture();
        const reply = await f.channel.run('paste-image', { pane_id: P0, data: PNG, mime: 'image/tiff' });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('image/png');
    });

    it('refuses an empty payload, a missing pane and a non-terminal pane', async () => {
        const f = fixture();
        expect(await f.channel.run('paste-image', { data: PNG })).toMatchObject({ ok: false });
        expect(await f.channel.run('paste-image', { pane_id: P0 })).toMatchObject({ ok: false });
        expect(await f.channel.run('paste-image', { pane_id: P0, data: '' })).toMatchObject({ ok: false });
        expect(await f.channel.run('paste-image', { pane_id: 'nope', data: PNG })).toMatchObject({ ok: false });

        f.h.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: NEW,
            filePath: '/tmp/work/a.md',
            now: 1
        });
        expect(await f.channel.run('paste-image', { pane_id: NEW, data: PNG })).toMatchObject({ ok: false });
    });

    it('refuses an image over the size cap instead of buffering it', async () => {
        const f = fixture();
        const huge = Buffer.alloc(MAX_PASTE_IMAGE_BYTES + 1024).toString('base64');
        const reply = await f.channel.run('paste-image', { pane_id: P0, data: huge });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('limit');
    });
});

describe('drop-text (TERM-040, #51)', () => {
    it('types the dropped paths bare AND mirrored, the outside-keystroke text path of §8.2 / §12.4', async () => {
        const f = fixture();
        const reply = await f.channel.run('drop-text', { pane_id: P0, text: '/tmp/a\\ b.txt /tmp/c.txt' });
        expect(reply).toEqual({ ok: true, pane_id: P0 });
        // Bare (the user is composing a command around the path) and mirror: true, which is
        // the whole reason this is not `pane-send --bare` (programmatic sends never mirror).
        expect(f.h.input.texts).toEqual([{ paneID: P0, text: '/tmp/a\\ b.txt /tmp/c.txt', bare: true, mirror: true }]);
    });

    it('refuses empty text, a missing pane and a non-terminal pane without typing anything', async () => {
        const f = fixture();
        expect(await f.channel.run('drop-text', { text: '/tmp/a' })).toMatchObject({ ok: false });
        expect(await f.channel.run('drop-text', { pane_id: P0 })).toMatchObject({ ok: false });
        expect(await f.channel.run('drop-text', { pane_id: P0, text: '' })).toMatchObject({ ok: false });
        expect(await f.channel.run('drop-text', { pane_id: 'nope', text: '/tmp/a' })).toMatchObject({ ok: false });

        f.h.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: NEW,
            filePath: '/tmp/work/a.md',
            now: 1
        });
        expect(await f.channel.run('drop-text', { pane_id: NEW, text: '/tmp/a' })).toMatchObject({ ok: false });
        expect(f.h.input.texts).toEqual([]);
    });
});

describe('shellEscapePath', () => {
    it('is the Swift escape set, so a path types identically in either app', () => {
        expect(shellEscapePath('/a/My Notes (v2).png')).toBe('/a/My\\ Notes\\ \\(v2\\).png');
        expect(shellEscapePath('/plain/a.png')).toBe('/plain/a.png');
    });
});
