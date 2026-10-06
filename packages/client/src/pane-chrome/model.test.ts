import { describe, expect, it, vi } from 'vitest';

import { testPane } from '../grid/testing';

import { paneChromeGlyph, paneChromeModel } from './model';
import { createPaneChromeSurface } from './surface';

const NOW = 1_000_000;

/** Every key anywhere in a descriptor, so a leaked field cannot hide inside a nested object. */
function keysOf(value: unknown, seen: string[] = []): readonly string[] {
    if (Array.isArray(value)) {
        for (const entry of value) keysOf(entry, seen);
        return seen;
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
            seen.push(key);
            keysOf(nested, seen);
        }
    }
    return seen;
}

describe('paneChromeModel', () => {
    it('draws every fact the native header paints, and no more', () => {
        const chrome = paneChromeModel({
            pane: testPane('p1', {
                label: 'api',
                type: 'shell',
                workingDirectory: '/Users/ben/code/kelpi',
                gitBranch: 'main',
                status: 'running',
                agentSessionID: 'session-1',
                agentKind: 'codex',
                agentStartedAt: (NOW - 90) * 1000,
                backgroundTaskCount: 2
            }),
            focused: true,
            zoomed: true,
            zoomAvailable: true,
            syncActive: true,
            syncExcluded: false,
            homeDirectory: '/Users/ben',
            nowSeconds: NOW,
            height: 24,
            paneWidth: 900
        }).descriptor;

        expect(chrome.paneID).toBe('p1');
        expect(chrome.kind).toBe('shell');
        expect(chrome.status).toBe('running');
        expect(chrome.focused).toBe(true);
        expect(chrome.title).toBe('~/code/kelpi');
        expect(chrome.titleParts).toEqual({ head: '~/code', tail: '/kelpi' });
        expect(chrome.directory).toBe('~/code/kelpi');
        expect(chrome.label).toBe('api');
        expect(chrome.branch).toBe('main');
        expect(chrome.agent).toEqual({
            kind: 'codex',
            elapsedSeconds: 90,
            backgroundTasks: 2,
            text: 'codex · 1m 30s · 2 running',
            tone: 'running'
        });
        expect(chrome.zoom).toEqual({ zoomed: true, available: true });
        expect(chrome.sync).toEqual({ active: true, excluded: false });
        expect(chrome.height).toBe(24);
        expect(chrome.size.badges).toEqual({ label: true, agent: true, branch: true });
        expect(chrome.renaming).toBe(false);
        // The three counts the header has no chip for: named, and null until a host fills them.
        expect(chrome.changes).toBeNull();
    });

    /**
     * The closure-free rule, proved rather than asserted.
     *
     * `settings/sections.ts` keeps a field's config key out of its descriptor for the same reason:
     * a projection that carried a verb would be a way past the host that owns it. Here the verb is
     * another plugin's `run(paneID)` closure, and a round trip through JSON is the only test that
     * cannot be satisfied by a descriptor that merely LOOKS free of one.
     */
    it('is plain JSON: no closure, no plugin identity, nothing that survives a round trip changed', () => {
        const run = vi.fn();
        const model = paneChromeModel({
            pane: testPane('p2', { type: 'markdown', filePath: '/repo/docs/NOTES.md' }),
            focused: false,
            nowSeconds: NOW,
            paneWidth: 900,
            commands: [{ id: 'sample.board.inspect', title: 'Inspect with Board', run }],
            items: [
                {
                    id: 'sample.board.status',
                    text: 'Ready',
                    tooltip: null,
                    badge: '3',
                    tone: 'success',
                    enabled: true
                }
            ],
            canCopyDocument: true
        });
        const encoded: unknown = JSON.parse(JSON.stringify(model.descriptor));
        // Deep equality after a round trip is the proof: a closure, an undefined or any other
        // value JSON cannot carry would come back missing or changed.
        expect(encoded).toEqual(model.descriptor);
        expect(keysOf(model.descriptor)).not.toContain('pluginID');
        expect(keysOf(model.descriptor)).not.toContain('command');
        expect(keysOf(model.descriptor)).not.toContain('run');
        // The opaque refs are the one thing that DOES cross: an id a presenter sends back.
        expect(model.descriptor.items[0]?.id).toBe('sample.board.status');
        expect(model.descriptor.controls[0]?.key).toBe('sample.board.inspect');
        // The closure went to the private table and nowhere else.
        expect(model.targets.commands.get('sample.board.inspect')).toBe(run);
        expect(run).not.toHaveBeenCalled();
    });

    it('rows the controls the way the header does, with the ids and test ids it already had', () => {
        const markdown = paneChromeModel({
            pane: testPane('m', { type: 'markdown', filePath: '/repo/NOTES.md' }),
            focused: false,
            nowSeconds: NOW,
            paneWidth: 900,
            canCopyDocument: true
        }).descriptor;
        expect(markdown.controls.map((control) => control.key)).toEqual([
            'copy',
            'edit',
            'split-right',
            'split-down',
            'new-web',
            'close'
        ]);
        expect(markdown.controls.map((control) => control.testID)).toEqual([
            'pane-copy-m',
            'pane-edit-toggle-m',
            'pane-split-right-m',
            'pane-split-down-m',
            'pane-new-web-m',
            'pane-close-m'
        ]);
        expect(markdown.controls.map((control) => control.label)).toEqual([
            'Copy whole file',
            'Edit (⌘E)',
            'Split right (⌘D)',
            'Split down (⌘⇧D)',
            'New web pane (⇧-click splits down)',
            'Close pane (⌘W)'
        ]);
        // Only the ✕ is pinned, and it is the last entry: §S40's fold can never reach it.
        expect(markdown.controls.filter((control) => control.pinned).map((c) => c.key)).toEqual(['close']);
    });

    it('drops the copy control in edit mode and where the host bound no handler', () => {
        const editing = paneChromeModel({
            pane: testPane('m', { type: 'markdown', filePath: '/repo/NOTES.md', isEditing: true }),
            focused: false,
            nowSeconds: NOW,
            canCopyDocument: true
        }).descriptor;
        expect(editing.controls.map((control) => control.key)).not.toContain('copy');
        expect(editing.controls.find((control) => control.key === 'edit')?.label).toBe('Preview (⌘E)');

        const unwired = paneChromeModel({
            pane: testPane('m', { type: 'markdown', filePath: '/repo/NOTES.md' }),
            focused: false,
            nowSeconds: NOW
        }).descriptor;
        expect(unwired.controls.map((control) => control.key)).not.toContain('copy');
    });

    it('gives a diff pane its refresh and a shell pane neither type control', () => {
        const diff = paneChromeModel({
            pane: testPane('d', { type: 'diff', filePath: '/repo/src/main.ts' }),
            focused: false,
            nowSeconds: NOW
        }).descriptor;
        expect(diff.title).toBe('diff: main.ts');
        expect(diff.controls.map((control) => control.key)).toEqual([
            'refresh',
            'split-right',
            'split-down',
            'new-web',
            'close'
        ]);
        const shell = paneChromeModel({ pane: testPane('s'), focused: false, nowSeconds: NOW }).descriptor;
        expect(shell.controls.map((control) => control.key)).toEqual([
            'split-right',
            'split-down',
            'new-web',
            'close'
        ]);
    });

    describe('a csv pane (#324)', () => {
        const csvPane = (overrides: Parameters<typeof testPane>[1] = {}) =>
            testPane('c', { type: 'csv', filePath: '/repo/data/sales.csv', workingDirectory: '/repo/data', ...overrides });

        it('titles by file name, wears the table glyph and draws raw text and header-row controls', () => {
            const model = paneChromeModel({ pane: csvPane(), focused: false, nowSeconds: NOW }).descriptor;
            expect(model.title).toBe('sales.csv');
            expect(paneChromeGlyph('csv')).toBe('table');
            expect(model.controls.map((control) => control.key)).toEqual(['edit', 'header-row', 'split-right', 'split-down', 'new-web', 'close']);
            expect(model.size.buttons).toBe(6);
            const edit = model.controls.find((control) => control.key === 'edit');
            expect(edit).toMatchObject({ label: 'Raw text (⌘E)', icon: 'pencil', enabled: true, testID: 'pane-edit-toggle-c' });
            const header = model.controls.find((control) => control.key === 'header-row');
            expect(header).toMatchObject({ label: 'Treat the first row as data', icon: 'table', enabled: true, testID: 'pane-header-row-c' });
        });

        it('relabels the toggle "Table" in raw mode, where the header row has nothing to toggle', () => {
            const model = paneChromeModel({ pane: csvPane({ isEditing: true }), focused: false, nowSeconds: NOW }).descriptor;
            expect(model.controls.find((control) => control.key === 'edit')).toMatchObject({ label: 'Table (⌘E)', icon: 'table', enabled: true });
            expect(model.controls.find((control) => control.key === 'header-row')?.enabled).toBe(false);
        });

        it('disables raw text, with the reason as its tooltip, when the body says it is unavailable', () => {
            const model = paneChromeModel({
                pane: csvPane(),
                focused: false,
                nowSeconds: NOW,
                csv: { rawEditable: false, rawUnavailableReason: 'Raw text (⌘E) is only available for files up to 2 MiB', headerRow: true }
            }).descriptor;
            expect(model.controls.find((control) => control.key === 'edit')).toMatchObject({
                enabled: false,
                label: 'Raw text (⌘E) is only available for files up to 2 MiB'
            });
        });

        it('swaps the header-row label and glyph from the document state, else the pane record', () => {
            const off = paneChromeModel({ pane: csvPane({ csvHeaderRow: false }), focused: false, nowSeconds: NOW }).descriptor;
            expect(off.controls.find((control) => control.key === 'header-row')).toMatchObject({ label: 'Use the first row as the header', icon: 'table-header' });
            // The document's own flag wins over the record when the body has published one.
            const on = paneChromeModel({
                pane: csvPane({ csvHeaderRow: false }),
                focused: false,
                nowSeconds: NOW,
                csv: { rawEditable: true, rawUnavailableReason: null, headerRow: true }
            }).descriptor;
            expect(on.controls.find((control) => control.key === 'header-row')?.label).toBe('Treat the first row as data');
        });

        it('runs the header-row control through the surface, and refuses a disabled raw-text toggle', () => {
            const onToggleCsvHeaderRow = vi.fn();
            const onToggleMarkdownEdit = vi.fn();
            const model = paneChromeModel({
                pane: csvPane(),
                focused: false,
                nowSeconds: NOW,
                csv: { rawEditable: false, rawUnavailableReason: 'too big', headerRow: true }
            });
            const surface = createPaneChromeSurface({ actions: () => ({ onToggleCsvHeaderRow, onToggleMarkdownEdit }), model: () => model });
            surface.runControl('c', 'header-row');
            surface.runControl('c', 'edit');
            expect(onToggleCsvHeaderRow).toHaveBeenCalledWith('c');
            expect(onToggleMarkdownEdit).not.toHaveBeenCalled();
        });
    });

    describe('a scratchpad pane', () => {
        const scratchpad = (overrides: Parameters<typeof testPane>[1] = {}) =>
            testPane('s', { type: 'scratchpad', isEditing: true, ...overrides });

        it('draws a wrap toggle that offers to wrap, from a record that does not', () => {
            const model = paneChromeModel({ pane: scratchpad(), focused: false, nowSeconds: NOW }).descriptor;
            expect(model.controls.map((control) => control.key)).toEqual(['wrap', 'split-right', 'split-down', 'new-web', 'close']);
            expect(model.size.buttons).toBe(5);
            expect(model.controls.find((control) => control.key === 'wrap')).toMatchObject({
                label: 'Wrap lines',
                icon: 'wrap',
                enabled: true,
                testID: 'pane-wrap-s'
            });
        });

        it('swaps the label and glyph once the scratchpad wraps', () => {
            const model = paneChromeModel({ pane: scratchpad({ scratchpadWrap: true }), focused: false, nowSeconds: NOW }).descriptor;
            expect(model.controls.find((control) => control.key === 'wrap')).toMatchObject({ label: 'Stop wrapping lines', icon: 'no-wrap' });
        });

        it('runs the wrap toggle through the surface', () => {
            const onToggleScratchpadWrap = vi.fn();
            const model = paneChromeModel({ pane: scratchpad(), focused: false, nowSeconds: NOW });
            const surface = createPaneChromeSurface({ actions: () => ({ onToggleScratchpadWrap }), model: () => model });
            surface.runControl('s', 'wrap');
            expect(onToggleScratchpadWrap).toHaveBeenCalledWith('s');
        });

        it('draws no wrap toggle on any other pane', () => {
            for (const type of ['shell', 'markdown', 'diff', 'csv', 'web'] as const) {
                const model = paneChromeModel({ pane: testPane('o', { type }), focused: false, nowSeconds: NOW }).descriptor;
                expect(model.controls.some((control) => control.key === 'wrap')).toBe(false);
            }
        });
    });

    /**
     * One source, so presence and count cannot disagree. They used to come from two: the box was
     * drawn when the host's rendered node was truthy and the count was `items.length`, which is a
     * charge for a box that may not be there and a count of zero for one that is.
     */
    it('charges the contributions box four button widths, from the items and nothing else', () => {
        const without = paneChromeModel({ pane: testPane('s'), focused: false, nowSeconds: NOW }).descriptor;
        const with_ = paneChromeModel({
            pane: testPane('s'),
            focused: false,
            nowSeconds: NOW,
            items: [
                { id: 'i', text: 'Ready', tooltip: null, badge: null, tone: 'default', enabled: true },
                { id: 'j', text: 'Busy', tooltip: null, badge: null, tone: 'warning', enabled: false }
            ]
        }).descriptor;
        expect(without.size.buttons).toBe(4);
        expect(with_.size.buttons).toBe(8);
        expect(without.contributions).toBeNull();
        expect(with_.contributions).toEqual({ testID: 'pane-contributions-s', count: 2 });
        // An empty list is no box and no charge, which is what the host's own renderer does with
        // one (`plugins/contributions-ui.tsx` returns null), so the two can never disagree.
        const empty = paneChromeModel({ pane: testPane('s'), focused: false, nowSeconds: NOW, items: [] }).descriptor;
        expect(empty.contributions).toBeNull();
        expect(empty.size.buttons).toBe(4);
        expect(with_.contributions?.count).toBe(with_.items.length);
    });

    it('carries the two width ladders as size-control state rather than re-deriving them', () => {
        const wide = paneChromeModel({
            pane: testPane('s', { label: 'api', gitBranch: 'main' }),
            focused: false,
            nowSeconds: NOW,
            paneWidth: 900
        }).descriptor;
        expect(wide.size.width).toBe(900);
        expect(wide.size.badges).toEqual({ label: true, agent: false, branch: true });
        expect(wide.size.folded).toBe(0);

        const narrow = paneChromeModel({
            pane: testPane('s', { label: 'api', gitBranch: 'main' }),
            focused: false,
            nowSeconds: NOW,
            paneWidth: 120
        }).descriptor;
        expect(narrow.size.badges).toEqual({ label: false, agent: false, branch: false });
        expect(narrow.size.folded).toBeGreaterThan(0);

        // An unmeasured render draws everything the pane asked for and folds nothing.
        const unmeasured = paneChromeModel({
            pane: testPane('s', { label: 'api', gitBranch: 'main' }),
            focused: false,
            nowSeconds: NOW
        }).descriptor;
        expect(unmeasured.size.width).toBeNull();
        expect(unmeasured.size.badges).toEqual({ label: true, agent: false, branch: true });
        expect(unmeasured.size.folded).toBe(0);
    });

    it('keeps a markdown pane out of the label chip, as the header does', () => {
        const chrome = paneChromeModel({
            pane: testPane('m', { type: 'markdown', label: 'notes', filePath: '/repo/NOTES.md' }),
            focused: false,
            nowSeconds: NOW,
            paneWidth: 900
        }).descriptor;
        // The label is still a FACT of the pane; it is simply not a badge this kind seats.
        expect(chrome.label).toBe('notes');
        expect(chrome.size.badges.label).toBe(false);
    });
});
