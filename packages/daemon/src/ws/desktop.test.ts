import { describe, expect, it } from 'vitest';

import type { EditorResolver } from '../content/external-editor.js';
import { harness, seedWorkspace, testID, W1, type Harness } from '../handlers/pane/testing.js';
import { visiblePane, workspaceByID } from '../store/derived.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    CLIPBOARD_IMAGE_DIR,
    MAX_SHELL_ANSWER_REQUEST_ID_LENGTH,
    MAX_PASTE_IMAGE_BYTES,
    SHELL_ACTION_EVENT,
    cellRuns,
    clippedByBorder,
    createDesktopChannel,
    isDesktopCommand,
    localFileURLPath,
    looksLikeLink,
    resolveTerminalPath,
    shellEscapePath,
    tokenAt,
    tokenRangeAt,
    urlFromToken,
    createProbeFileExists,
    historyPosition,
    MAX_ROW_TEXT,
    MAX_SCROLL_OFFSET,
    rowLooksLinked
} from './desktop.js';
import { createTerminalStateService, type TerminalCellSpan as TerminalCellRun } from '../term/service.js';

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
        cell?: {
            text: string;
            offset: number;
            cellsOf?: (start: number, end: number) => readonly TerminalCellRun[] | undefined;
        } | null;
        /** The OSC 8 URI the clicked cell carries (#83); absent means the pane has none. */
        hyperlink?: string | null;
        /** The same link with its cells (#303), which only a probe asks for. */
        hyperlinkRange?: { uri: string; segments: readonly TerminalCellRun[] } | null;
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
        hyperlinkRangeAtAsync?: (
            id: string,
            r: number,
            c: number
        ) => Promise<{ uri: string; segments: readonly TerminalCellRun[] } | null>;
    };
    if (options.cell !== undefined) {
        term.cellTextAsync = async () => options.cell ?? null;
    }
    if (options.hyperlink !== undefined) {
        term.hyperlinkAtAsync = async () => options.hyperlink ?? null;
    }
    if (options.hyperlinkRange !== undefined) {
        term.hyperlinkRangeAtAsync = async () => options.hyperlinkRange ?? null;
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
    it('names exactly the seven verbs', () => {
        expect(isDesktopCommand('shell-action')).toBe(true);
        expect(isDesktopCommand('restart-control-server')).toBe(true);
        expect(isDesktopCommand('open-terminal-target')).toBe(true);
        expect(isDesktopCommand('probe-terminal-target')).toBe(true);
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

    /**
     * Agents write `name (https://…): note` and `the PR (https://…).` all the time. The wrapper
     * pass ran before the punctuation trim, so the `:` or `.` hid the closing paren and the
     * token kept its `(`, which no scheme anchor matches.
     */
    it('unwraps brackets that prose punctuation follows', () => {
        expect(tokenAt('1. web#3133 (https://github.com/o/r/pull/3133): test fix', 14)).toBe('https://github.com/o/r/pull/3133');
        expect(tokenAt('the PR (https://github.com/o/r/pull/5249). It has', 10)).toBe('https://github.com/o/r/pull/5249');
        expect(tokenAt('see (notes.md), then', 7)).toBe('notes.md');
        expect(tokenAt('see [https://example.com/x];', 7)).toBe('https://example.com/x');
        expect(tokenAt('see ((notes.md)).', 7)).toBe('notes.md');
    });

    it('keeps parens inside a URL while unwrapping the ones around it', () => {
        expect(tokenAt('(https://en.wikipedia.org/wiki/A_(b)).', 5)).toBe('https://en.wikipedia.org/wiki/A_(b)');
        expect(tokenAt('https://en.wikipedia.org/wiki/A_(b)', 5)).toBe('https://en.wikipedia.org/wiki/A_(b)');
    });

    it('drops an opening bracket whose closer is outside the token', () => {
        expect(tokenAt('(https://example.com/x and more)', 5)).toBe('https://example.com/x');
        expect(tokenAt('[notes.md is here]', 3)).toBe('notes.md');
        expect(tokenAt('{https://example.com/x and more}', 5)).toBe('https://example.com/x');
        // A path opens as itself now, not as a missing `(draft.md`.
        expect(tokenAt('(draft.md is ready', 3)).toBe('draft.md');
    });

    it('counts brackets, so only the unmatched ones are trimmed', () => {
        expect(tokenAt('see https://en.wikipedia.org/wiki/A_(b)).', 8)).toBe('https://en.wikipedia.org/wiki/A_(b)');
        expect(tokenAt('(https://example.com/x?q=(1)', 5)).toBe('https://example.com/x?q=(1)');
        expect(tokenAt('see {https://example.com/x}.', 8)).toBe('https://example.com/x');
    });

    /**
     * A link stops at the first closer that has no opener inside it, whatever the counts over the
     * whole token say. Counting the token blocked the unwrap here and left the `(` on, so no link.
     */
    it('ends a link at its wrapper even when the token has a stray bracket', () => {
        expect(tokenAt('(https://x.com/a)b)', 5)).toBe('https://x.com/a');
        expect(tokenAt('[https://x.com/a]b]', 5)).toBe('https://x.com/a');
        expect(tokenAt('{https://x.com/a}b}', 5)).toBe('https://x.com/a');
        expect(tokenAt('[https://x.com/?a[b]=1]', 5)).toBe('https://x.com/?a[b]=1');
    });

    it('finds the link inside a markdown link or after a label', () => {
        expect(tokenAt('see [the docs](https://x.com/docs).', 18)).toBe('https://x.com/docs');
        expect(tokenAt('PR:https://github.com/o/r/pull/1', 8)).toBe('https://github.com/o/r/pull/1');
        // Two links in one token: the cell picks.
        const both = '[https://a.com/x](https://b.com/y)';
        expect(tokenAt(both, 3)).toBe('https://a.com/x');
        expect(tokenAt(both, both.indexOf('b.com'))).toBe('https://b.com/y');
        // A scheme inside a link's query is the link's own.
        expect(tokenAt('https://x.com/login?next=https://y.com/z', 30)).toBe('https://x.com/login?next=https://y.com/z');
    });

    it('trims a question or exclamation mark after a link only when it is not the link\'s', () => {
        expect(tokenAt('did you see the PR (https://x.com/a)?', 22)).toBe('https://x.com/a');
        expect(tokenAt('it landed (https://x.com/a)!', 13)).toBe('https://x.com/a');
        expect(tokenAt('see https://x.com/a)?', 6)).toBe('https://x.com/a');
        expect(tokenAt('https://x.com/a?q=1', 3)).toBe('https://x.com/a?q=1');
        // A `?` that would open an empty query is the sentence's.
        expect(tokenAt('did you see https://x.com/a?', 14)).toBe('https://x.com/a');
        expect(tokenAt('see https://x.com/a?.', 6)).toBe('https://x.com/a');
        // In a query or a fragment it is the link's, and so is a `!` (these are other pages).
        expect(tokenAt('https://x.com/s?q=why?', 3)).toBe('https://x.com/s?q=why?');
        expect(tokenAt('https://x.com/a#why?', 3)).toBe('https://x.com/a#why?');
        expect(tokenAt('https://en.wikipedia.org/wiki/Jeopardy!', 3)).toBe('https://en.wikipedia.org/wiki/Jeopardy!');
        expect(tokenAt('(https://en.wikipedia.org/wiki/Help!).', 3)).toBe('https://en.wikipedia.org/wiki/Help!');
        expect(tokenAt('https://x.com/#!', 3)).toBe('https://x.com/#!');
        // A path is not a URL: its `?` and `!` are prose.
        expect(tokenAt('did you read notes.md?', 15)).toBe('notes.md');
    });

    it('ends a link at curly quotes, an em dash, an ellipsis and full-width brackets', () => {
        expect(tokenAt('the PR (https://github.com/o/r/pull/1)\u2014it fixes', 10)).toBe('https://github.com/o/r/pull/1');
        expect(tokenAt('\u201chttps://x.com/a\u201d', 3)).toBe('https://x.com/a');
        expect(tokenAt('\u2018https://x.com/a\u2019', 3)).toBe('https://x.com/a');
        expect(tokenAt('https://x.com/a\u2026', 3)).toBe('https://x.com/a');
        expect(tokenAt('（https://x.com/a）', 3)).toBe('https://x.com/a');
        expect(tokenAt('詳細（https://x.com/a）を参照。', 5)).toBe('https://x.com/a');
        expect(tokenAt('【https://x.com/a】', 3)).toBe('https://x.com/a');
        expect(tokenAt('see https://x.com/a。', 6)).toBe('https://x.com/a');
        expect(tokenAt('\u201cnotes.md\u201d', 3)).toBe('notes.md');
        expect(tokenAt('（notes.md）', 3)).toBe('notes.md');
    });

    it('keeps a path\'s own brackets unless they wrap the whole token', () => {
        expect(tokenAt('(a)(b)', 1)).toBe('(a)(b)');
        expect(tokenAt('see (a)(b).md.', 5)).toBe('(a)(b).md');
        expect(tokenAt('[notes.md]', 3)).toBe('notes.md');
        expect(tokenAt('see (notes.md]', 6)).toBe('notes.md');
    });

    it('answers null for a token of brackets and punctuation only', () => {
        expect(tokenAt('see ((( now', 5)).toBeNull();
        expect(tokenAt('see (. now', 5)).toBeNull();
    });

    /**
     * A click reads the whole logical line, so a minified bundle can hand it a huge token. Each
     * line below leans on a different trim; one that rescans or re-slices the token per step takes
     * seconds at this length rather than a millisecond, so it fails here instead of in a pane.
     */
    it('trims a long token in time linear in its length', () => {
        const n = 30_000;
        const lines: Array<[string, number]> = [
            ['('.repeat(n), 0],
            ['x' + ')'.repeat(n), 0],
            ['x' + '.,?!'.repeat(n), 0],
            ['x' + '.)'.repeat(n), 0],
            ['('.repeat(n) + 'x' + ')'.repeat(n) + '.', n],
            ['https://x.com/' + '('.repeat(n), 0],
            ['https://x.com/a' + '.;:'.repeat(n), 0],
            ['(https://x.com/a)'.repeat(n / 10), 17 * (n / 10) - 1],
            // The scheme search: a long word with no `://`, one with a scheme at the far end, and a
            // `://` with no letter before it.
            ['a'.repeat(n), 0],
            ['a'.repeat(n) + '1://x', 0],
            ['1'.repeat(n) + '://x', 0]
        ];
        for (const [line, offset] of lines) {
            const started = performance.now();
            tokenAt(line, offset);
            expect(performance.now() - started, line.slice(0, 20)).toBeLessThan(250);
        }
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

describe('tokenRangeAt (#303)', () => {
    it('is exactly where tokenAt\'s token sits, after the same trimming', () => {
        const lines: Array<[string, number]> = [
            ['cat docs/notes.md', 6],
            ['see (notes.md), then', 7],
            ['open "a b.md" now', 7],
            ['  │https://example.com/x│', 8],
            ['see notes.md.,', 6],
            ['plain', 2]
        ];
        for (const [line, offset] of lines) {
            const range = tokenRangeAt(line, offset);
            expect(range === null ? null : line.slice(range.start, range.end)).toBe(tokenAt(line, offset));
        }
        expect(tokenRangeAt('cat (docs/a.md) now', 7)).toEqual({ start: 5, end: 14 });
        // The underline covers the URL only, not the paren or the full stop after it.
        const prose = 'the PR (https://e.com/a). It';
        expect(tokenRangeAt(prose, 10)).toEqual({ start: prose.indexOf('https'), end: prose.indexOf(')') });
        // On the unmatched `(` itself, the underline still starts at the URL.
        const open = '(https://e.com/a and more)';
        expect(tokenRangeAt(open, 0)).toEqual({ start: 1, end: open.indexOf(' ') });
        expect(tokenRangeAt('a  b', 1)).toBeNull();
    });
});

describe('cellRuns (#303)', () => {
    const cells = (row: number, from: number, count: number): TerminalCellRun[] =>
        Array.from({ length: count }, (_, index) => ({ row, col: from + index, width: 1 }));

    it('folds a token\'s cells into one run per row', () => {
        expect(cellRuns([...cells(0, 4, 6), ...cells(1, 0, 3)])).toEqual([
            { row: 0, col: 4, width: 6 },
            { row: 1, col: 0, width: 3 }
        ]);
    });

    it('covers both cells of a wide character, and drops rows above the screen', () => {
        const line: TerminalCellRun[] = [
            { row: -1, col: 8, width: 1 },
            { row: -1, col: 9, width: 1 },
            { row: 0, col: 0, width: 2 },
            { row: 0, col: 2, width: 1 }
        ];
        expect(cellRuns(line)).toEqual([{ row: 0, col: 0, width: 3 }]);
    });

    it('answers undefined without cells, rather than guessing', () => {
        expect(cellRuns(undefined)).toBeUndefined();
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

describe('localFileURLPath (content-panes.md §12)', () => {
    it('decodes a local file URL to its absolute path', () => {
        expect(localFileURLPath('file:///tmp/shot.png')).toBe('/tmp/shot.png');
        expect(localFileURLPath('file://localhost/tmp/My%20Shot.png')).toBe('/tmp/My Shot.png');
        expect(localFileURLPath('FILE:///tmp/a.png')).toBe('/tmp/a.png');
    });

    it('refuses another host, another scheme, and a NUL byte', () => {
        expect(localFileURLPath('file://otherhost/tmp/shot.png')).toBeNull();
        expect(localFileURLPath('https://example.com/shot.png')).toBeNull();
        expect(localFileURLPath('/tmp/shot.png')).toBeNull();
        expect(localFileURLPath('file:///tmp/a%00.png')).toBeNull();
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

    it('broadcasts a folder request with its id and window (#283)', async () => {
        const f = fixture();
        const reply = await f.channel.run('shell-action', {
            action: 'choose-folder-dialog',
            request_id: 'req-1',
            window_id: 'w-1'
        });
        expect(reply).toEqual({ ok: true, action: 'choose-folder-dialog', request_id: 'req-1' });
        expect(f.h.broadcasts).toEqual([
            { type: SHELL_ACTION_EVENT, action: 'choose-folder-dialog', windowID: 'w-1', requestID: 'req-1' }
        ]);
    });

    it('refuses a folder request with no id, an oversized id or no window, and broadcasts nothing', async () => {
        const f = fixture();
        for (const payload of [
            { action: 'choose-folder-dialog', window_id: 'w-1' },
            { action: 'choose-folder-dialog', request_id: '', window_id: 'w-1' },
            { action: 'choose-folder-dialog', request_id: 'x'.repeat(MAX_SHELL_ANSWER_REQUEST_ID_LENGTH + 1), window_id: 'w-1' },
            // Unaddressed, it would raise a panel in every attached shell window for one click.
            { action: 'choose-folder-dialog', request_id: 'req-1' }
        ]) {
            const reply = await f.channel.run('shell-action', payload);
            expect(reply, JSON.stringify(payload)).toMatchObject({ ok: false });
        }
        expect(f.h.broadcasts).toHaveLength(0);
    });

    it('says an oversized id is too long, rather than missing', async () => {
        const f = fixture();
        const reply = await f.channel.run('shell-action', {
            action: 'choose-folder-dialog',
            request_id: 'x'.repeat(MAX_SHELL_ANSWER_REQUEST_ID_LENGTH + 1),
            window_id: 'w-1'
        });
        expect(String(reply['error'])).toContain('too long');
    });

    it('broadcasts a dropped-files request with its id and window, and refuses one without (#288)', async () => {
        const f = fixture();
        const reply = await f.channel.run('shell-action', {
            action: 'resolve-dropped-files',
            request_id: 'drop-1',
            window_id: 'w-1'
        });
        expect(reply).toEqual({ ok: true, action: 'resolve-dropped-files', request_id: 'drop-1' });
        expect(f.h.broadcasts).toEqual([
            { type: SHELL_ACTION_EVENT, action: 'resolve-dropped-files', windowID: 'w-1', requestID: 'drop-1' }
        ]);
        for (const payload of [
            { action: 'resolve-dropped-files', window_id: 'w-1' },
            { action: 'resolve-dropped-files', request_id: 'x'.repeat(MAX_SHELL_ANSWER_REQUEST_ID_LENGTH + 1), window_id: 'w-1' },
            // Unaddressed, every attached window would go looking for a stash only one page holds.
            { action: 'resolve-dropped-files', request_id: 'drop-2' }
        ]) {
            const refused = await f.channel.run('shell-action', payload);
            expect(refused, JSON.stringify(payload)).toMatchObject({ ok: false });
            expect(String(refused['error'])).toContain('resolve-dropped-files');
        }
        expect(f.h.broadcasts).toHaveLength(1);
    });

    it('carries no request id on the one-way actions', async () => {
        const f = fixture();
        await f.channel.run('shell-action', { action: 'install-cli', request_id: 'req-1', window_id: 'w-1' });
        expect(f.h.broadcasts).toEqual([{ type: SHELL_ACTION_EVENT, action: 'install-cli', windowID: 'w-1' }]);
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

    it('answers a probe with what a ⌘-click would do, and changes nothing (#326)', async () => {
        const f = fixture({ cell: { text: 'cat docs/notes.md', offset: 8 } });
        const before = f.h.state();
        const reply = await f.channel.run('probe-terminal-target', { pane_id: P0, row: 3, col: 8 });
        expect(reply).toMatchObject({ ok: true, opened: 'markdown', probe: true, path: '/tmp/work/docs/notes.md' });
        expect(reply['pane_id']).toBeUndefined();
        // No pane was opened and focus did not move: the store is the one the probe found.
        expect(f.h.state()).toBe(before);
        expect(visiblePane(workspaceByID(f.h.state(), W1)!, NEW)).toBeNull();
    });

    it('answers a probe on a URL exactly as a ⌘-click (#326)', async () => {
        const f = fixture({ cell: { text: 'see https://example.com/x for more', offset: 6 } });
        const probed = await f.channel.run('probe-terminal-target', { pane_id: P0, row: 0, col: 6 });
        const clicked = await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6 });
        expect(probed).toMatchObject({ ok: true, opened: 'external', url: 'https://example.com/x' });
        expect(clicked).toEqual(probed);
    });

    it('opens a URL an agent wrapped in parens before a full stop or colon, on hover and click', async () => {
        for (const text of ['Here\'s the PR: manage#5249 (https://github.com/o/r/pull/5249). It has', '1. web#3133 (https://github.com/o/r/pull/3133): fix']) {
            const offset = text.indexOf('https') + 4;
            const f = fixture({ cell: { text, offset } });
            const probed = await f.channel.run('probe-terminal-target', { pane_id: P0, row: 0, col: offset });
            const clicked = await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: offset });
            expect(probed).toMatchObject({ ok: true, opened: 'external', url: text.slice(text.indexOf('https'), text.indexOf(')')) });
            expect(clicked).toEqual(probed);
        }
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

    // #324: csv/tsv files open as a csv pane; the reply says `opened: 'csv'`.
    it('opens a csv pane for an existing .csv path under the cell', async () => {
        const f = fixture({ cell: { text: 'wrote data/sales.csv', offset: 10 } });
        const reply = await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 10 });
        expect(reply).toMatchObject({
            ok: true,
            opened: 'csv',
            path: '/tmp/work/data/sales.csv',
            token: 'data/sales.csv',
            pane_id: NEW,
            workspace_id: W1
        });
        const pane = visiblePane(workspaceByID(f.h.state(), W1)!, NEW);
        expect(pane?.type).toBe('csv');
        expect(pane?.filePath).toBe('/tmp/work/data/sales.csv');
        expect(pane?.csvHeaderRow).toBe(true);
    });

    it('answers a probe on a .csv path as csv, and opens nothing (#324 + #326)', async () => {
        const f = fixture({ cell: { text: 'wrote data/sales.csv', offset: 10 } });
        const before = f.h.state();
        const reply = await f.channel.run('probe-terminal-target', { pane_id: P0, row: 0, col: 10 });
        expect(reply).toMatchObject({ ok: true, opened: 'csv', probe: true, path: '/tmp/work/data/sales.csv' });
        expect(f.h.state()).toBe(before);
    });

    it('opens .tsv and upper-case extensions as csv panes (the socket open rule)', async () => {
        const f = fixture({ cell: { text: 'see EXPORT.TSV.', offset: 6 } });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6 })).toMatchObject({
            opened: 'csv',
            path: '/tmp/work/EXPORT.TSV'
        });
        expect(visiblePane(workspaceByID(f.h.state(), W1)!, NEW)?.type).toBe('csv');
    });

    // content-panes.md §12: an image file opens an image pane; the reply says `opened: 'image'`.
    it('opens an image pane for an existing image path under the cell', async () => {
        const f = fixture({ cell: { text: 'saved shots/home.PNG.', offset: 8 } });
        const reply = await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 8 });
        expect(reply).toMatchObject({
            ok: true,
            opened: 'image',
            path: '/tmp/work/shots/home.PNG',
            token: 'shots/home.PNG',
            pane_id: NEW,
            workspace_id: W1
        });
        const pane = visiblePane(workspaceByID(f.h.state(), W1)!, NEW);
        expect(pane?.type).toBe('image');
        expect(pane?.filePath).toBe('/tmp/work/shots/home.PNG');
        expect(pane?.title).toBe('home.PNG');
    });

    it('answers a probe on an image path as image, with its cells, and opens nothing', async () => {
        const f = fixture({ cell: { text: 'saved shot.webp', offset: 8 } });
        const before = f.h.state();
        const reply = await f.channel.run('probe-terminal-target', { pane_id: P0, row: 0, col: 8 });
        expect(reply).toMatchObject({ ok: true, opened: 'image', probe: true, path: '/tmp/work/shot.webp' });
        expect(f.h.state()).toBe(before);
    });

    it('reports an image path that is not on disk instead of opening a broken pane', async () => {
        const f = fixture({ cell: { text: 'see shot.png', offset: 6 }, exists: false });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6 })).toMatchObject({
            ok: true,
            opened: 'missing',
            path: '/tmp/work/shot.png'
        });
        expect(visiblePane(workspaceByID(f.h.state(), W1)!, NEW)).toBeNull();
    });

    it('opens an image pane for a file: hyperlink to an image, and probes it with its cells', async () => {
        const segments = [{ row: 0, col: 4, width: 8 }];
        const f = fixture({ hyperlink: 'file:///pics/My%20Shot.png', cell: null });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 5 })).toMatchObject({
            ok: true,
            opened: 'image',
            path: '/pics/My Shot.png',
            link: 'file:///pics/My%20Shot.png',
            source: 'hyperlink',
            pane_id: NEW
        });
        expect(visiblePane(workspaceByID(f.h.state(), W1)!, NEW)?.type).toBe('image');

        const probe = await fixture({ hyperlinkRange: { uri: 'file:///pics/a.png', segments }, cell: null })
            .channel.run('probe-terminal-target', { pane_id: P0, row: 0, col: 5 });
        expect(probe).toMatchObject({ opened: 'image', probe: true, path: '/pics/a.png', span: segments });
    });

    it('still refuses a file: hyperlink that is not an image, and one on another host', async () => {
        for (const link of ['file:///pics/notes.md', 'file://otherhost/pics/a.png']) {
            const f = fixture({ hyperlink: link, cell: null });
            expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 2 })).toMatchObject({
                ok: true,
                opened: 'none',
                reason: 'link-not-http',
                link
            });
            expect(visiblePane(workspaceByID(f.h.state(), W1)!, NEW)).toBeNull();
        }
    });

    it('reports a .csv path that is not on disk instead of opening a broken pane', async () => {
        const f = fixture({ cell: { text: 'see sales.csv', offset: 6 }, exists: false });
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6 })).toMatchObject({
            ok: true,
            opened: 'missing',
            path: '/tmp/work/sales.csv'
        });
        expect(visiblePane(workspaceByID(f.h.state(), W1)!, NEW)).toBeNull();
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

describe('probe-terminal-target (#303)', () => {
    const line = (text: string, offset: number) => ({
        text,
        offset,
        cellsOf: (start: number, end: number) =>
            Array.from({ length: end - start }, (_, index) => ({ row: 2, col: start + index, width: 1 }))
    });

    /**
     * The hover underline's promise: whatever a probe says, the click says too. Every fixture is
     * run twice, once as a click and once as a probe, each on a fresh channel.
     */
    it('answers what a click would, for every kind of cell', async () => {
        const cases: Array<Parameters<typeof fixture>[0]> = [
            { cell: line('cat docs/notes.md', 8) },
            { cell: line('see notes.md', 6), exists: false },
            { cell: line('wrote data/sales.csv', 10) },
            { cell: line('see sales.csv', 6), exists: false },
            { cell: line('open https://example.com/x', 8) },
            { cell: line('cargo build --release', 2) },
            { cell: null },
            { hyperlink: 'https://example.com/full', cell: line('see the docs now', 8) },
            { hyperlink: 'file:///etc/passwd', cell: null },
            { cell: line('see slack://channel now', 6) },
            { cell: line('  │https://example.com/wrapped/pa│', 8) }
        ];
        const fields = ['ok', 'opened', 'reason', 'url', 'path', 'token', 'link', 'source'];
        for (const options of cases) {
            const offset = options?.cell?.offset ?? 2;
            const click = await fixture(options).channel.run('open-terminal-target', { pane_id: P0, row: 2, col: offset });
            const probe = await fixture(options).channel.run('probe-terminal-target', { pane_id: P0, row: 2, col: offset });
            for (const field of fields) expect(probe[field], `${field} for ${JSON.stringify(options)}`).toEqual(click[field]);
        }
    });

    it('opens nothing and moves no focus, even on a markdown path', async () => {
        const f = fixture({ cell: line('cat docs/notes.md', 8) });
        const before = f.h.state();
        const reply = await f.channel.run('probe-terminal-target', { pane_id: P0, row: 2, col: 8 });
        expect(reply).toMatchObject({ ok: true, opened: 'markdown' });
        expect(reply['pane_id']).toBeUndefined();
        expect(visiblePane(workspaceByID(f.h.state(), W1)!, NEW)).toBeNull();
        expect(f.h.state()).toBe(before);
    });

    it('carries the cells of the token it would open', async () => {
        const url = await fixture({ cell: line('open https://example.com/x now', 8) }).channel.run('probe-terminal-target', { pane_id: P0, row: 2, col: 8 });
        expect(url).toMatchObject({ opened: 'external', span: [{ row: 2, col: 5, width: 21 }] });

        const markdown = await fixture({ cell: line('cat (docs/notes.md)', 8) }).channel.run('probe-terminal-target', { pane_id: P0, row: 2, col: 8 });
        expect(markdown).toMatchObject({ opened: 'markdown', span: [{ row: 2, col: 5, width: 13 }] });

        // #324: a csv path a ⌘-click opens as a table pane is underlined the same way.
        const csv = await fixture({ cell: line('wrote data/sales.csv', 10) }).channel.run('probe-terminal-target', {
            pane_id: P0,
            row: 2,
            col: 10
        });
        expect(csv).toMatchObject({ opened: 'csv', span: [{ row: 2, col: 6, width: 14 }] });
    });

    it('carries the cells of the hyperlink it would open', async () => {
        const segments = [
            { row: 1, col: 1, width: 16 },
            { row: 2, col: 1, width: 16 }
        ];
        const reply = await fixture({
            hyperlinkRange: { uri: 'https://example.com/wrapped', segments },
            cell: line('  │https://example.│', 8)
        }).channel.run('probe-terminal-target', { pane_id: P0, row: 2, col: 8 });
        expect(reply).toMatchObject({ opened: 'external', url: 'https://example.com/wrapped', source: 'hyperlink', span: segments });
    });

    it('carries no cells for anything a click would refuse or ignore', async () => {
        const quiet: Array<Parameters<typeof fixture>[0]> = [
            { cell: line('see notes.md', 6), exists: false },
            { cell: line('see sales.csv', 6), exists: false },
            { cell: line('see shot.png', 6), exists: false },
            { cell: line('cargo build --release', 2) },
            { cell: line('see slack://channel now', 6) },
            { cell: line('  │https://example.com/wrapped/pa│', 8) },
            { hyperlinkRange: { uri: 'file:///etc/passwd', segments: [{ row: 2, col: 0, width: 6 }] }, cell: null }
        ];
        for (const options of quiet) {
            const reply = await fixture(options).channel.run('probe-terminal-target', {
                pane_id: P0,
                row: 2,
                col: options?.cell?.offset ?? 2
            });
            expect(reply['span'], JSON.stringify(options)).toBeUndefined();
        }
    });

    it('carries no cells when the line came without them, and a click never carries any', async () => {
        const bare = await fixture({ cell: { text: 'open https://example.com/x', offset: 8 } }).channel.run('probe-terminal-target', { pane_id: P0, row: 2, col: 8 });
        expect(bare).toMatchObject({ opened: 'external' });
        expect(bare['span']).toBeUndefined();

        const click = await fixture({ cell: line('open https://example.com/x', 8) }).channel.run(
            'open-terminal-target',
            { pane_id: P0, row: 2, col: 8 }
        );
        expect(click['span']).toBeUndefined();
    });
});

describe('createProbeFileExists (#303)', () => {
    const file = { isFile: () => true };

    it('answers from stat, off the event loop, and remembers the answer for a while', async () => {
        let calls = 0;
        let clock = 0;
        const exists = createProbeFileExists({
            stat: async () => {
                calls += 1;
                return file;
            },
            ttlMs: 1_000,
            now: () => clock
        });
        expect(await exists('/a.md')).toBe(true);
        expect(await exists('/a.md')).toBe(true);
        expect(calls).toBe(1);
        clock = 1_500;
        expect(await exists('/a.md')).toBe(true);
        expect(calls).toBe(2);
    });

    it('answers no for a path stat refuses, or one that is not a file', async () => {
        const missing = createProbeFileExists({ stat: () => Promise.reject(new Error('ENOENT')) });
        expect(await missing('/gone.md')).toBe(false);
        const directory = createProbeFileExists({ stat: async () => ({ isFile: () => false }) });
        expect(await directory('/dir.md')).toBe(false);
    });

    /**
     * The case it exists for: a path on a hung network mount, whose `stat` does not come back.
     * The hover gets "no" in bounded time, and hovering it again shares the one stuck call
     * rather than tying up another thread.
     */
    it('answers no when stat hangs, and asks a hung path only once', async () => {
        let calls = 0;
        const exists = createProbeFileExists({
            stat: () => {
                calls += 1;
                return new Promise(() => undefined);
            },
            timeoutMs: 10
        });
        expect(await exists('/Volumes/share/plan.md')).toBe(false);
        expect(await exists('/Volumes/share/plan.md')).toBe(false);
        expect(calls).toBe(1);
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

/**
 * #327: a ⌘-click (or a probe) from a client scrolled into history.
 *
 * These run the handler against a REAL emulator: the stub terminal service is given the real
 * service's reads, so the location (`locateRow`) and the reads at its offset are the shipped ones.
 */
describe('a click in history (#327)', () => {
    const URL = 'https://example.com/old';

    /** Bind a real emulator, fed `text`, onto a fixture's stub terminal service. */
    async function historyFixture(text: string, cols = 40, rows = 4): Promise<Fixture & { real: ReturnType<typeof createTerminalStateService> }> {
        const f = fixture();
        const real = createTerminalStateService({ defaultCols: cols, defaultRows: rows });
        real.attach(P0, cols, rows);
        real.feed(P0, text);
        await real.flush(P0);
        Object.assign(f.h.term, {
            flush: (id: string) => real.flush(id),
            locateRow: real.locateRow.bind(real),
            cellText: real.cellText.bind(real),
            cellTextAsync: real.cellTextAsync.bind(real),
            hyperlinkAt: real.hyperlinkAt.bind(real),
            hyperlinkAtAsync: real.hyperlinkAtAsync.bind(real),
            hyperlinkRange: undefined,
            hyperlinkRangeAt: real.hyperlinkRangeAt.bind(real),
            hyperlinkRangeAtAsync: real.hyperlinkRangeAtAsync.bind(real)
        });
        return { ...f, real };
    }

    const lines = (...rows: string[]): string => rows.map((row) => `${row}\r\n`).join('');
    const fillers = (count: number, tag = 'filler'): string[] => Array.from({ length: count }, (_, index) => `${tag} ${String(index)}`);

    /*
     * The screen below, 4 rows: two lines, the link, ten more, and the cursor's empty line, so 14
     * lines and `baseY` 10. Scrolled 9 lines up, the client's viewport starts at line 1 and shows
     * the link on its row 1, between "early 1" and "filler 0".
     */
    const SCREEN = lines('early 0', 'early 1', `see ${URL} now`, ...fillers(10));
    const AROUND = ['early 1', `see ${URL} now`, 'filler 0'];

    it('opens the link on the row the client shows, not the live screen\'s', async () => {
        const f = await historyFixture(SCREEN);
        const reply = await f.channel.run('open-terminal-target', { pane_id: P0, row: 1, col: 6, scroll_offset: 9, row_text: AROUND });
        // The offset is echoed: how a client tells this answer from an older daemon's (#328).
        expect(reply).toMatchObject({ ok: true, opened: 'external', url: URL, scroll_offset: 9 });
        // The live screen's row 1 is filler: the old behaviour, and still the answer at offset 0,
        // which echoes nothing.
        const live = await f.channel.run('open-terminal-target', { pane_id: P0, row: 1, col: 6 });
        expect(live).toMatchObject({ ok: true, opened: 'none' });
        expect(live).not.toHaveProperty('scroll_offset');
    });

    /**
     * The client keeps less history than the daemon (it caps by bytes, the daemon at 10 000
     * lines), so at its top row the row above is one it does not have: sent as `null`, it is left
     * out of the match rather than compared as a blank row.
     */
    it('finds the client\'s top row when the daemon holds more history above it', async () => {
        const f = await historyFixture(SCREEN);
        // The client's history starts at the link: scrolled to its top, the link is row 0.
        const reply = await f.channel.run('probe-terminal-target', {
            pane_id: P0,
            row: 0,
            col: 6,
            scroll_offset: 8,
            row_text: [null, AROUND[1], AROUND[2]]
        });
        expect(reply).toMatchObject({ opened: 'external', url: URL, span: [{ row: 0, col: 4, width: URL.length }], scroll_offset: 8 });
        // And off by a few, found nearby the same way.
        expect(
            await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6, scroll_offset: 5, row_text: [null, AROUND[1], AROUND[2]] })
        ).toMatchObject({ opened: 'external', url: URL });
    });

    it('answers a probe with the span in the client\'s viewport rows', async () => {
        const f = await historyFixture(SCREEN);
        const reply = await f.channel.run('probe-terminal-target', { pane_id: P0, row: 1, col: 6, scroll_offset: 9, row_text: AROUND });
        expect(reply).toMatchObject({ ok: true, opened: 'external', url: URL, span: [{ row: 1, col: 4, width: URL.length }] });
    });

    it('trusts an offset sent with no row text (an engine that cannot read its rows)', async () => {
        const f = await historyFixture(SCREEN);
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 1, col: 6, scroll_offset: 9 })).toMatchObject({
            opened: 'external',
            url: URL
        });
    });

    /**
     * The client's history does not line up with the daemon's (output reached one end first, or it
     * keeps more lines): the offset names the wrong line, the rows around the click are found
     * nearby, once, and the span still comes back in the client's rows.
     */
    it('finds the row nearby when the offset is off, and answers in the client\'s rows', async () => {
        const f = await historyFixture(SCREEN);
        for (const offset of [6, 12, 400]) {
            const reply = await f.channel.run('probe-terminal-target', { pane_id: P0, row: 1, col: 6, scroll_offset: offset, row_text: AROUND });
            expect(reply).toMatchObject({ opened: 'external', url: URL, span: [{ row: 1, col: 4, width: URL.length }] });
        }
    });

    it('refuses, saying why, when the rows are nowhere, or in two places', async () => {
        const missing = await historyFixture(SCREEN);
        expect(
            await missing.channel.run('open-terminal-target', {
                pane_id: P0,
                row: 1,
                col: 6,
                scroll_offset: 9,
                row_text: ['early 1', 'see https://example.com/elsewhere now', 'filler 0']
            })
        ).toEqual({ ok: true, opened: 'none', reason: 'history-moved', scroll_offset: 9 });

        const twice = await historyFixture(lines(...AROUND, 'between', ...AROUND, ...fillers(6)));
        expect(
            await twice.channel.run('open-terminal-target', { pane_id: P0, row: 1, col: 6, scroll_offset: 2, row_text: AROUND })
        ).toEqual({ ok: true, opened: 'none', reason: 'history-moved', scroll_offset: 2 });
    });

    it('stays quiet when the row it could not find was prose', async () => {
        const f = await historyFixture(SCREEN);
        expect(
            await f.channel.run('open-terminal-target', { pane_id: P0, row: 1, col: 6, scroll_offset: 9, row_text: ['a', 'just some prose', 'b'] })
        ).toEqual({ ok: true, opened: 'none', scroll_offset: 9 });
    });

    /**
     * Two rows that read the same are not the same row: a URL soft-wraps into a different tail on
     * each. The row below the click is part of the match, so the resync takes the right one.
     */
    it('tells two identical rows apart by the rows around them', async () => {
        const head = 'https://example.com/' + 'a'.repeat(20); // exactly the 40-column row
        const f = await historyFixture(lines(`${head}one`, 'gap', `${head}two`, ...fillers(8)));
        // Off by three, the client's click on the second head row.
        const reply = await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 5, scroll_offset: 3, row_text: ['gap', head, 'two'] });
        expect(reply).toMatchObject({ opened: 'external', url: `${head}two` });
    });

    it('refuses an offset on the alternate screen, which has no history', async () => {
        const f = await historyFixture(`${SCREEN}\x1b[?1049h\x1b[Hsee ${URL} now\r\n`);
        expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 0, col: 6, scroll_offset: 3, row_text: ['', `see ${URL} now`, ''] })).toEqual({
            ok: true,
            opened: 'none',
            reason: 'history-moved',
            scroll_offset: 3
        });
    });

    it('ignores malformed or out-of-range fields and reads the live row, as an older daemon does', async () => {
        const f = await historyFixture(lines(...fillers(12), `see ${URL} now`));
        // The link is on the live screen's row 2.
        for (const extra of [
            { scroll_offset: 'nine' },
            { scroll_offset: -4 },
            { scroll_offset: MAX_SCROLL_OFFSET + 1 },
            { scroll_offset: 0, row_text: ['x', 'y', 'z'] }
        ]) {
            expect(await f.channel.run('open-terminal-target', { pane_id: P0, row: 2, col: 6, ...extra })).toMatchObject({ opened: 'external', url: URL });
        }
    });
});

describe('historyPosition (#327)', () => {
    it('reads a positive offset and three row texts, a missing neighbour as null', () => {
        expect(historyPosition({ scroll_offset: 4, row_text: ['a', 'b', 'c'] })).toEqual({ scrollOffset: 4, rowText: ['a', 'b', 'c'] });
        expect(historyPosition({ scroll_offset: 4, row_text: [null, 'b', null] })).toEqual({ scrollOffset: 4, rowText: [null, 'b', null] });
    });

    it('drops the offset at 0, negative, past the cap or not a number', () => {
        for (const scroll_offset of [0, -1, MAX_SCROLL_OFFSET + 1, '4', null, Number.NaN]) {
            expect(historyPosition({ scroll_offset, row_text: ['a', 'b', 'c'] })).toBeUndefined();
        }
    });

    it('keeps the offset but drops row text that is not three strings within the cap', () => {
        for (const row_text of [['a', 'b'], ['a', 'b', 'c', 'd'], ['a', 2, 'c'], 'abc', ['a', 'x'.repeat(MAX_ROW_TEXT + 1), 'c']]) {
            expect(historyPosition({ scroll_offset: 4, row_text })).toEqual({ scrollOffset: 4 });
        }
    });
});

describe('rowLooksLinked (#327)', () => {
    it('is true for a row holding a URL, a link, or a path Kelpi opens', () => {
        expect(rowLooksLinked('see https://example.com now')).toBe(true);
        expect(rowLooksLinked('clone ssh://host/repo')).toBe(true);
        expect(rowLooksLinked('wrote docs/notes.md')).toBe(true);
        expect(rowLooksLinked('wrote out/sales.csv')).toBe(true);
        expect(rowLooksLinked('saved shot.png')).toBe(true);
    });

    it('is false for prose', () => {
        expect(rowLooksLinked('just some prose, nothing more')).toBe(false);
        expect(rowLooksLinked('')).toBe(false);
    });
});

