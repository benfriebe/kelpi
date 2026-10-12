/**
 * Markdown Scratchpad's shipped modules, loaded unchanged: the live-preview decorations and task
 * commands over a real CodeMirror state, and the document sync against a scripted documents API.
 * The live half (the sandboxed frame, a real daemon buffer) is checked by hand; see the plugin's
 * README.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples/plugins/markdown-scratchpad/ui');

interface Range { readonly from: number; readonly to: number; readonly value: { readonly spec: { readonly class?: string; readonly widget?: { readonly checked?: boolean; readonly glyph?: string } } } }
interface RangeSet { between(from: number, to: number, f: (from: number, to: number, value: Range['value']) => void): void }
interface State { readonly doc: { readonly length: number; toString(): string; line(n: number): { readonly from: number } }; update(spec: object): { readonly state: State } }
interface CodeMirror {
    EditorState: { create(config: object): State };
    EditorSelection: { single(anchor: number, head?: number): object; create(ranges: object[]): object; cursor(pos: number): object; range(anchor: number, head: number): object };
    EditorView: (new (config: object) => { readonly state: State; readonly dom: HTMLElement; destroy(): void }) & { inputHandler: object };
    history(): unknown;
    historyKeymap: ReadonlyArray<{ readonly key?: string; run?(view: unknown): boolean }>;
    ensureSyntaxTree(state: State, upto: number, timeout?: number): unknown;
}
interface Live {
    livePreview(): unknown;
    buildDecorations(state: State, from: number, to: number): { decorations: RangeSet; atomic: RangeSet };
    toggleTasks(state: State): object;
    toggleTaskAt(state: State, pos: number): object | null;
    typeTaskShorthand(view: unknown, from: number, to: number, text: string): boolean;
}
interface Sync {
    textChange(before: string, after: string): { from: number; to: number; insert: string } | null;
    createDocumentSync(api: unknown, hooks: unknown): { start(): Promise<{ text: string }>; edit(text: string): void; reload(): Promise<void>; readonly blocked: boolean; stop(): void };
}

const load = async <T>(file: string): Promise<T> => (await import(/* @vite-ignore */ path.join(ui, file))) as T;
const cm = await load<CodeMirror>('vendor/codemirror.js');
const live = await load<Live>('live.js');
const sync = await load<Sync>('sync.js');

function parsed(doc: string, selection?: object): State {
    const state = cm.EditorState.create({ doc, selection, extensions: live.livePreview() });
    cm.ensureSyntaxTree(state, state.doc.length, 5000);
    return state;
}
function ranges(set: RangeSet): Array<{ from: number; to: number; class?: string; checked?: boolean; glyph?: string }> {
    const out: Array<{ from: number; to: number; class?: string; checked?: boolean; glyph?: string }> = [];
    set.between(0, 1e9, (from, to, value) => {
        const { spec } = value;
        out.push({ from, to, ...(spec.class ? { class: spec.class } : {}), ...(spec.widget?.checked !== undefined ? { checked: spec.widget.checked } : {}), ...(spec.widget?.glyph ? { glyph: spec.widget.glyph } : {}) });
    });
    return out;
}
const apply = (state: State, spec: object): string => state.update(spec).state.doc.toString();

describe('live preview decorations', () => {
    const doc = ['# Title', '- [ ] open', '- [x] done', '- plain', '  - nested', '1. [ ] numbered', '', '```', 'code', '```', '> quote', '', 'some `inline` text', '', '    not code'].join('\n');
    const state = parsed(doc);
    const at = (line: number, column = 0): number => state.doc.line(line).from + column;
    const { decorations, atomic } = live.buildDecorations(state, 0, state.doc.length);
    const all = ranges(decorations);

    it('styles a heading line and leaves its marker in the text', () => {
        expect(all).toContainEqual({ from: at(1), to: at(1), class: 'cm-md-heading cm-md-h1' });
    });

    it('draws a bullet task as one box over `- [ ]`, and strikes a ticked one through', () => {
        expect(all).toContainEqual({ from: at(2), to: at(2, 5), checked: false });
        expect(all).toContainEqual({ from: at(3), to: at(3, 5), checked: true });
        expect(all).toContainEqual({ from: at(3, 6), to: at(3, 10), class: 'cm-md-done' });
        expect(all.some(range => range.class === 'cm-md-done' && range.from === at(2, 5))).toBe(false);
    });

    it('keeps an ordered task its number and boxes only the marker', () => {
        expect(all).toContainEqual({ from: at(6, 3), to: at(6, 6), checked: false });
    });

    it('draws bullets by depth, one column each', () => {
        expect(all).toContainEqual({ from: at(4), to: at(4, 1), glyph: '•' });
        expect(all).toContainEqual({ from: at(5, 2), to: at(5, 3), glyph: '◦' });
    });

    it('reads indented text as a paragraph, not code', () => {
        type Node = { readonly name: string; readonly parent: Node | null };
        const tree = cm.ensureSyntaxTree(state, state.doc.length, 5000) as { resolveInner(pos: number, side: number): Node };
        const names: string[] = [];
        for (let node: Node | null = tree.resolveInner(at(15, 6), 1); node; node = node.parent) names.push(node.name);
        expect(names).toContain('Paragraph');
        expect(names).not.toContain('CodeBlock');
    });

    it('marks fenced code, quotes and inline code, but not indented text', () => {
        expect(all).toContainEqual({ from: at(8), to: at(8), class: 'cm-md-code cm-md-code-first' });
        expect(all).toContainEqual({ from: at(9), to: at(9), class: 'cm-md-code' });
        expect(all).toContainEqual({ from: at(10), to: at(10), class: 'cm-md-code cm-md-code-last' });
        expect(all).toContainEqual({ from: at(11), to: at(11), class: 'cm-md-quote' });
        expect(all).toContainEqual({ from: at(13, 5), to: at(13, 13), class: 'cm-md-inline-code' });
        expect(all.some(range => range.from === at(15) && range.class?.includes('code'))).toBe(false);
    });

    it('makes only the widgets atomic', () => {
        const widgets = ranges(atomic);
        expect(widgets.every(range => range.checked !== undefined || range.glyph !== undefined)).toBe(true);
        expect(widgets).toHaveLength(5);
    });

    it('limits line styling to the requested range', () => {
        const some = ranges(live.buildDecorations(state, at(8), at(9)).decorations).filter(range => range.class?.startsWith('cm-md-code'));
        expect(some.map(range => range.from)).toEqual([at(8), at(9)]);
    });
});

describe('task commands', () => {
    const toggle = (doc: string, anchor: number, head = anchor): string => apply(parsed(doc, cm.EditorSelection.single(anchor, head)), live.toggleTasks(parsed(doc, cm.EditorSelection.single(anchor, head))));

    it('turns a plain line into an open task after its indentation', () => {
        expect(toggle('  buy milk', 4)).toBe('  - [ ] buy milk');
        expect(toggle('', 0)).toBe('- [ ] ');
    });

    it('moves a caret on an empty line past the new marker', () => {
        const state = parsed('', cm.EditorSelection.single(0));
        const next = state.update(live.toggleTasks(state)).state as State & { selection: { main: { head: number } } };
        expect(next.selection.main.head).toBe(6);
    });

    it('gives a list item a box', () => {
        expect(toggle('- eggs', 2)).toBe('- [ ] eggs');
        expect(toggle('3) eggs', 2)).toBe('3) [ ] eggs');
    });

    it('ticks every selected task, or clears them when all were ticked', () => {
        expect(toggle('- [ ] a\n- [x] b', 0, 12)).toBe('- [x] a\n- [x] b');
        expect(toggle('- [x] a\n- [X] b', 0, 12)).toBe('- [ ] a\n- [ ] b');
    });

    it('gives a bare box the list marker it needs', () => {
        expect(toggle('[] a', 0)).toBe('- [ ] a');
        expect(toggle('  [x] a', 0)).toBe('  - [x] a');
        expect(toggle('- [] a', 0)).toBe('- [ ] a');
    });

    it('only converts the non-task lines of a mixed selection', () => {
        expect(toggle('- [x] a\nb', 0, 9)).toBe('- [x] a\n- [ ] b');
    });

    it('flips one box from a position on its line', () => {
        const state = parsed('x\n  - [ ] two');
        expect(apply(state, live.toggleTaskAt(state, 2)!)).toBe('x\n  - [x] two');
        expect(live.toggleTaskAt(state, 0)).toBeNull();
    });
});

describe('the editor', () => {
    let view: InstanceType<CodeMirror['EditorView']> | null = null;
    afterEach(() => { view?.destroy(); view = null; });

    it('ticks a box on a press and leaves the caret alone', () => {
        view = new cm.EditorView({ parent: document.body, state: cm.EditorState.create({ doc: 'top\n- [ ] milk', selection: cm.EditorSelection.single(1), extensions: live.livePreview() }) });
        const box = view.dom.querySelector('.cm-md-checkbox')!;
        box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        expect(view.state.doc.toString()).toBe('top\n- [x] milk');
        expect((view.state as State & { selection: { main: { head: number } } }).selection.main.head).toBe(1);
        expect(view.dom.querySelector('.cm-md-checkbox')?.getAttribute('aria-checked')).toBe('true');
    });

    const editor = (doc: string, at: number) => new cm.EditorView({ parent: document.body, state: cm.EditorState.create({ doc, selection: cm.EditorSelection.single(at), extensions: [cm.history(), live.livePreview()] }) });
    const head = (state: State): number => (state as State & { selection: { main: { head: number } } }).selection.main.head;

    it('makes `[]` and a space a task, and ⌘Z gives the brackets back', () => {
        view = editor('top\n  []', 8);
        expect((view.state as State & { facet(facet: object): unknown[] }).facet(cm.EditorView.inputHandler)).toContain(live.typeTaskShorthand);
        expect(live.typeTaskShorthand(view, 8, 8, ' ')).toBe(true);
        expect(view.state.doc.toString()).toBe('top\n  - [ ] ');
        expect(head(view.state)).toBe(12);
        expect(view.dom.querySelector('.cm-md-checkbox')).not.toBeNull();
        cm.historyKeymap.find(binding => binding.key === 'Mod-z')!.run!(view);
        expect(view.state.doc.toString()).toBe('top\n  [] ');
    });

    it('keeps the tick of `[x]` and the marker of a list item', () => {
        view = editor('[x]', 3);
        live.typeTaskShorthand(view, 3, 3, ' ');
        expect(view.state.doc.toString()).toBe('- [x] ');
        view.destroy();
        view = editor('1. []', 5);
        live.typeTaskShorthand(view, 5, 5, ' ');
        expect(view.state.doc.toString()).toBe('1. [ ] ');
    });

    it('leaves any other space alone', () => {
        for (const [doc, at] of [['- [ ]', 5], ['a []', 4], ['[] b', 4], ['[a]', 3], ['  - [x]', 7]] as const) {
            view = editor(doc, at);
            expect(live.typeTaskShorthand(view, at, at, ' ')).toBe(false);
            expect(view.state.doc.toString()).toBe(doc);
            view.destroy();
        }
        view = null;
    });
});

describe('textChange', () => {
    it('finds the one replacement between two texts', () => {
        expect(sync.textChange('abc', 'abc')).toBeNull();
        expect(sync.textChange('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' });
        expect(sync.textChange('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' });
        expect(sync.textChange('', 'x')).toEqual({ from: 0, to: 0, insert: 'x' });
        expect(sync.textChange('- [ ] a', '- [x] a')).toEqual({ from: 3, to: 4, insert: 'x' });
    });
});

describe('document sync', () => {
    type Snapshot = { paneID: string; workspaceID: string; kind: string; mode: string; path: null; text: string; loaded: boolean; dirty: boolean; error: null; revision: string };
    const settle = async (): Promise<void> => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
    const snapshot = (text: string, revision: string): Snapshot => ({ paneID: 'p', workspaceID: 'w', kind: 'scratchpad', mode: 'edit', path: null, text, loaded: true, dirty: false, error: null, revision });
    const conflict = (): Error => Object.assign(new Error('DOCUMENT_CONFLICT: stale'), { code: 'DOCUMENT_CONFLICT' });

    function harness(initial: Snapshot) {
        let daemon = initial, drafts = 0;
        const listeners = new Map<string, (event: { data: { subscription: string } }) => void>();
        const staged = new Map<string, string>();
        const api = {
            events: { on: (name: string, listener: (event: { data: { subscription: string } }) => void) => { listeners.set(name, listener); return () => listeners.delete(name); } },
            documents: {
                watch: vi.fn(async () => ({ subscription: 's', state: daemon })),
                unwatch: vi.fn(async () => {}),
                get: vi.fn(async () => daemon),
                stage: vi.fn(async (text: string) => { const id = `d${String(++drafts)}`; staged.set(id, text); return { id }; }),
                applyDraft: vi.fn(async (id: string, revision: string) => {
                    if (revision !== daemon.revision) throw conflict();
                    daemon = snapshot(staged.get(id)!, `${daemon.revision}+`);
                    return daemon;
                })
            }
        };
        const hooks = { onText: vi.fn(), onProblem: vi.fn(), onClosed: vi.fn() };
        return {
            api, hooks,
            /** Another writer (or autosave) changing the daemon's buffer. */
            set(next: Snapshot) { daemon = next; },
            changed() { listeners.get('documents.changed')?.({ data: { subscription: 's' } }); },
            get daemon() { return daemon; }
        };
    }

    it('stages each input and writes the newest against the last acknowledged revision', async () => {
        const h = harness(snapshot('a', 'r1'));
        const doc = sync.createDocumentSync(h.api, h.hooks);
        expect((await doc.start()).text).toBe('a');
        doc.edit('ab');
        await settle();
        expect(h.api.documents.applyDraft).toHaveBeenLastCalledWith('d1', 'r1');
        doc.edit('abc');
        await settle();
        expect(h.api.documents.applyDraft).toHaveBeenLastCalledWith('d2', 'r1+');
        expect(h.daemon.text).toBe('abc');
        expect(h.hooks.onProblem).not.toHaveBeenCalled();
    });

    it('retries once when only autosave moved the revision', async () => {
        const h = harness(snapshot('a', 'r1'));
        const doc = sync.createDocumentSync(h.api, h.hooks);
        await doc.start();
        h.set({ ...snapshot('a', 'r2'), dirty: false });
        doc.edit('ab');
        await settle();
        expect(h.daemon.text).toBe('ab');
        expect(h.api.documents.applyDraft).toHaveBeenCalledTimes(2);
        expect(h.hooks.onProblem).not.toHaveBeenCalled();
    });

    it('stops editing when another writer changed the text, and reloads on request', async () => {
        const h = harness(snapshot('a', 'r1'));
        const doc = sync.createDocumentSync(h.api, h.hooks);
        await doc.start();
        h.set(snapshot('from the phone', 'r2'));
        doc.edit('ab');
        await settle();
        expect(h.daemon.text).toBe('from the phone');
        expect(doc.blocked).toBe(true);
        expect(h.hooks.onProblem).toHaveBeenLastCalledWith(expect.stringContaining('changed somewhere else'), { conflict: true });
        doc.edit('abc');
        await settle();
        expect(h.api.documents.stage).toHaveBeenCalledTimes(1);
        await doc.reload();
        expect(doc.blocked).toBe(false);
        expect(h.hooks.onText).toHaveBeenLastCalledWith('from the phone');
    });

    it('adopts another writer\'s text while idle, never over unsaved input', async () => {
        const h = harness(snapshot('a', 'r1'));
        const doc = sync.createDocumentSync(h.api, h.hooks);
        await doc.start();
        h.set(snapshot('remote', 'r2'));
        h.changed();
        await settle();
        expect(h.hooks.onText).toHaveBeenLastCalledWith('remote');
        h.hooks.onText.mockClear();
        // Input staged but not yet written: a snapshot arriving now must not replace it.
        h.api.documents.stage.mockImplementationOnce(() => new Promise(() => {}));
        doc.edit('mine');
        h.set(snapshot('other', 'r3'));
        h.changed();
        await settle();
        expect(h.hooks.onText).not.toHaveBeenCalled();
    });
});
