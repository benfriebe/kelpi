import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { harness, id, NOW, seededState, W1 } from '../store/testing.js';
import { visiblePane, workspaceByID } from '../store/derived.js';
import {
    PANE_ASSETS_PREFIX,
    createContentService,
    type ContentGit,
    type ContentPaneState,
    type ContentService
} from './service.js';

const MD = id('eeeeeeee', 1);
const DIFF = id('eeeeeeee', 2);
const SCRATCH = id('eeeeeeee', 3);
const SHELL = id('dddddddd', 100);

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Fixture {
    readonly store: ReturnType<typeof harness>;
    readonly service: ContentService;
    readonly dir: string;
    readonly file: string;
    readonly events: ContentPaneState[];
    readonly gitCalls: { repoPath: string; targetPath: string | null }[];
    diffText: string;
    diffError: Error | null;
    dispose(): void;
}

const dirs: string[] = [];

function fixture(options: { fileBody?: string; watch?: boolean } = {}): Fixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-content-'));
    dirs.push(dir);
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, options.fileBody ?? '# Title\n\nbody\n');

    const store = harness(seededState(W1, SHELL));
    const events: ContentPaneState[] = [];
    const gitCalls: { repoPath: string; targetPath: string | null }[] = [];
    const state = {
        diffText: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n',
        diffError: null as Error | null
    };
    const git: ContentGit = {
        getDiff: async (repoPath, targetPath) => {
            gitCalls.push({ repoPath, targetPath: targetPath ?? null });
            if (state.diffError !== null) throw state.diffError;
            return state.diffText;
        }
    };

    const service = createContentService({
        store: store.store,
        git,
        debounceMs: 20,
        reattachDelayMs: 20,
        appearance: { backgroundColor: '#101010' },
        ...(options.watch !== undefined ? { watch: options.watch } : {})
    });

    return {
        store,
        service,
        dir,
        file,
        events,
        gitCalls,
        get diffText() {
            return state.diffText;
        },
        set diffText(value: string) {
            state.diffText = value;
        },
        get diffError() {
            return state.diffError;
        },
        set diffError(value: Error | null) {
            state.diffError = value;
        },
        dispose() {
            service.dispose();
        }
    };
}

function openMarkdown(f: Fixture, filePath = f.file): void {
    f.store.dispatch({
        type: 'open-markdown-pane',
        workspaceID: W1,
        paneID: MD,
        filePath,
        now: NOW
    });
}

function openDiff(f: Fixture, targetPath?: string): void {
    f.store.dispatch({
        type: 'open-diff-pane',
        workspaceID: W1,
        paneID: DIFF,
        repoPath: f.dir,
        now: NOW,
        ...(targetPath !== undefined ? { targetPath } : {})
    });
}

function openScratchpad(f: Fixture): void {
    f.store.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: SCRATCH, now: NOW });
}

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe('markdown panes', () => {
    it('renders the file into a full HTML document with an asset base', async () => {
        const f = fixture();
        openMarkdown(f);
        const state = await f.service.state(MD);
        expect(state.type).toBe('markdown');
        expect(state.mode).toBe('view');
        expect(state.loaded).toBe(true);
        expect(state.filePath).toBe(f.file);
        expect(state.text).toBe('# Title\n\nbody\n');
        expect(state.html).toContain('<h1>Title</h1>');
        expect(state.html).toContain(`<base href="${PANE_ASSETS_PREFIX}/${MD}/">`);
        expect(state.assetBase).toBe(`${PANE_ASSETS_PREFIX}/${MD}/`);
        expect(state.isDark).toBe(true);
        f.dispose();
    });

    it('renders a read failure as a blockquote and marks the load failed', async () => {
        const f = fixture();
        openMarkdown(f, path.join(f.dir, 'missing.md'));
        const state = await f.service.state(MD);
        expect(state.loaded).toBe(false);
        expect(state.error).not.toBeNull();
        expect(state.html).toContain('<blockquote>');
        expect(state.html).toContain('Failed to load file:');
        f.dispose();
    });

    it('rejects a shell pane and an unknown pane', async () => {
        const f = fixture();
        await expect(f.service.state(SHELL)).rejects.toThrow('not a content pane');
        await expect(f.service.state(MD)).rejects.toThrow("no pane matches");
        f.dispose();
    });

    it('pushes a content-updated state to subscribers when the file changes on disk', async () => {
        const f = fixture();
        openMarkdown(f);
        const seen: ContentPaneState[] = [];
        const subscription = await f.service.subscribe(MD, (state) => seen.push(state));
        expect(subscription.state.html).toContain('<h1>Title</h1>');

        await tick(60);
        fs.writeFileSync(f.file, '# Changed\n');
        const deadline = Date.now() + 4000;
        while (seen.length === 0 && Date.now() < deadline) await tick(20);

        expect(seen.length).toBeGreaterThan(0);
        expect(seen.at(-1)?.html).toContain('<h1>Changed</h1>');
        expect(seen.at(-1)?.revision).toBeGreaterThan(subscription.state.revision);
        subscription.unsubscribe();
        f.dispose();
    });

    it('gives two concurrent subscribers the same fully loaded state', async () => {
        const f = fixture({ watch: false });
        openMarkdown(f);
        const [a, b] = await Promise.all([
            f.service.subscribe(MD, () => {}),
            f.service.subscribe(MD, () => {})
        ]);
        expect(a.state.html).toContain('<h1>Title</h1>');
        expect(b.state.html).toContain('<h1>Title</h1>');
        a.unsubscribe();
        b.unsubscribe();
        f.dispose();
    });

    it('keeps delivering to the remaining subscriber when one leaves', async () => {
        const f = fixture({ watch: false });
        openMarkdown(f);
        const seenA: ContentPaneState[] = [];
        const seenB: ContentPaneState[] = [];
        const a = await f.service.subscribe(MD, (state) => seenA.push(state));
        const b = await f.service.subscribe(MD, (state) => seenB.push(state));
        a.unsubscribe();

        fs.writeFileSync(f.file, '# Later\n');
        await f.service.refresh(MD);
        expect(seenA).toEqual([]);
        expect(seenB).toHaveLength(1);
        b.unsubscribe();
        f.dispose();
    });

    it('short-circuits a reload whose content is byte-identical', async () => {
        // Watching off: this is about the reload path itself, and a real OS event racing the
        // explicit refresh would make the event count non-deterministic.
        const f = fixture({ watch: false });
        openMarkdown(f);
        const seen: ContentPaneState[] = [];
        const subscription = await f.service.subscribe(MD, (state) => seen.push(state));
        // `refresh` runs the same load path the watcher does.
        await f.service.refresh(MD);
        expect(seen).toEqual([]);

        fs.writeFileSync(f.file, '# Other\n');
        await f.service.refresh(MD);
        expect(seen).toHaveLength(1);
        subscription.unsubscribe();
        f.dispose();
    });

    // §3.16 — the preview's font size is a re-render, never a disk read.
    it('re-renders at a new font size without re-reading the file', async () => {
        const f = fixture({ watch: false });
        openMarkdown(f);
        const seen: ContentPaneState[] = [];
        const subscription = await f.service.subscribe(MD, (state) => seen.push(state));

        const bigger = await f.service.setFontSize(MD, 18);
        expect(bigger.fontSize).toBe(18);
        expect(bigger.html).toContain('font-size: 18px');
        expect(seen.at(-1)?.fontSize).toBe(18);
        expect(visiblePane(workspaceByID(f.store.state(), W1) as never, MD)?.markdownFontSize).toBe(18);

        // The reducer owns the clamp (8…32), so an out-of-range request lands on the bound
        // rather than being rejected — which is what the ⌘=/⌘- handlers rely on.
        expect((await f.service.setFontSize(MD, 99)).fontSize).toBe(32);
        expect((await f.service.setFontSize(MD, 1)).fontSize).toBe(8);

        subscription.unsubscribe();
        f.dispose();
    });

    it('leaves the font size alone while the markdown pane is editing', async () => {
        const f = fixture({ watch: false });
        openMarkdown(f);
        await f.service.setMode(MD, 'edit');
        const state = await f.service.setFontSize(MD, 20);
        // The guard lives in the reducer; the service reports the (unchanged) truth.
        expect(state.fontSize).toBe(14);
        f.dispose();
    });
});

// ---------------------------------------------------------------------------
// Edit mode + buffers
// ---------------------------------------------------------------------------

describe('edit mode', () => {
    it('dispatches set-markdown-editing and suspends watching while editing', async () => {
        const f = fixture();
        openMarkdown(f);
        const subscription = await f.service.subscribe(MD, () => {});

        const edit = await f.service.setMode(MD, 'edit');
        expect(edit.mode).toBe('edit');
        expect(visiblePane(workspaceByID(f.store.state(), W1)!, MD)?.isEditing).toBe(true);

        const view = await f.service.setMode(MD, 'view');
        expect(view.mode).toBe('view');
        expect(visiblePane(workspaceByID(f.store.state(), W1)!, MD)?.isEditing).toBe(false);
        subscription.unsubscribe();
        f.dispose();
    });

    it('refuses edit mode on non-markdown panes', async () => {
        const f = fixture();
        openDiff(f);
        await expect(f.service.setMode(DIFF, 'edit')).rejects.toThrow('no edit mode');
        f.dispose();
    });

    it('saves the edit buffer to disk after the debounce and re-renders', async () => {
        const f = fixture();
        openMarkdown(f);
        const seen: ContentPaneState[] = [];
        const subscription = await f.service.subscribe(MD, (state) => seen.push(state));
        await f.service.setMode(MD, 'edit');
        seen.length = 0;

        const after = await f.service.setText(MD, '# Edited\n');
        expect(after.dirty).toBe(true);
        expect(seen).toEqual([]); // no per-keystroke fan-out

        await tick(60);
        expect(fs.readFileSync(f.file, 'utf8')).toBe('# Edited\n');
        expect(seen.at(-1)?.html).toContain('<h1>Edited</h1>');
        expect(seen.at(-1)?.dirty).toBe(false);
        subscription.unsubscribe();
        f.dispose();
    });

    it('markdown-save flushes the pending debounce immediately', async () => {
        const f = fixture();
        openMarkdown(f);
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, 'flushed');
        const state = await f.service.save(MD);
        expect(fs.readFileSync(f.file, 'utf8')).toBe('flushed');
        expect(state.dirty).toBe(false);
        f.dispose();
    });

    it('leaving edit mode writes the buffer before re-reading the file', async () => {
        const f = fixture();
        openMarkdown(f);
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, '# From editor\n');
        const view = await f.service.setMode(MD, 'view');
        expect(fs.readFileSync(f.file, 'utf8')).toBe('# From editor\n');
        expect(view.html).toContain('<h1>From editor</h1>');
        f.dispose();
    });

    it('refuses text on a markdown pane that is not in edit mode, and on diff panes', async () => {
        const f = fixture();
        openMarkdown(f);
        openDiff(f);
        await expect(f.service.setText(MD, 'x')).rejects.toThrow('not in edit mode');
        await expect(f.service.setText(DIFF, 'x')).rejects.toThrow('read-only');
        f.dispose();
    });

    it('flushSync writes dirty buffers at shutdown (markdown AND scratchpad)', async () => {
        const f = fixture();
        openMarkdown(f);
        openScratchpad(f);
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, 'unsaved markdown');
        await f.service.setText(SCRATCH, 'unsaved scratch');

        f.service.flushSync();

        expect(fs.readFileSync(f.file, 'utf8')).toBe('unsaved markdown');
        const workspace = workspaceByID(f.store.state(), W1)!;
        expect(visiblePane(workspace, SCRATCH)?.scratchpadContent).toBe('unsaved scratch');
        f.dispose();
    });

    it('keeps an unsaved buffer alive after the last subscriber leaves', async () => {
        const f = fixture();
        openMarkdown(f);
        const subscription = await f.service.subscribe(MD, () => {});
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, 'still unsaved');
        subscription.unsubscribe();

        f.service.flushSync();
        expect(fs.readFileSync(f.file, 'utf8')).toBe('still unsaved');
        f.dispose();
    });

    it('saves a pane that is closed while its buffer is dirty', async () => {
        const f = fixture();
        openMarkdown(f);
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, 'closing text');
        f.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: MD });
        expect(fs.readFileSync(f.file, 'utf8')).toBe('closing text');
        f.dispose();
    });
});

// ---------------------------------------------------------------------------
// Scratchpad
// ---------------------------------------------------------------------------

describe('scratchpad panes', () => {
    it('starts in edit mode seeded from the pane record and never renders HTML', async () => {
        const f = fixture();
        openScratchpad(f);
        f.store.dispatch({
            type: 'scratchpad-content-changed',
            workspaceID: W1,
            paneID: SCRATCH,
            content: 'persisted'
        });
        const state = await f.service.state(SCRATCH);
        expect(state.mode).toBe('edit');
        expect(state.text).toBe('persisted');
        expect(state.html).toBeNull();
        f.dispose();
    });

    it('routes saves to the store, never to disk', async () => {
        const f = fixture();
        openScratchpad(f);
        await f.service.setText(SCRATCH, 'typed');
        await tick(60);
        const workspace = workspaceByID(f.store.state(), W1)!;
        expect(visiblePane(workspace, SCRATCH)?.scratchpadContent).toBe('typed');
        expect(fs.readdirSync(f.dir)).toEqual(['note.md']);
        f.dispose();
    });
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

describe('diff panes', () => {
    it('runs git diff scoped to the pane and renders the document', async () => {
        const f = fixture();
        openDiff(f, path.join(f.dir, 'sub'));
        const state = await f.service.state(DIFF);
        expect(f.gitCalls).toEqual([{ repoPath: f.dir, targetPath: path.join(f.dir, 'sub') }]);
        expect(state.html).toContain('<details class="file" open>');
        expect(state.text).toBeNull();
        expect(state.loaded).toBe(true);
        f.dispose();
    });

    it('renders a git failure through the normal renderer', async () => {
        const f = fixture();
        f.diffError = new Error('fatal: not a git repository');
        openDiff(f);
        const state = await f.service.state(DIFF);
        expect(state.loaded).toBe(false);
        expect(state.html).toContain('Failed to run git diff in');
        expect(state.html).toContain('fatal: not a git repository');
        f.dispose();
    });

    it('re-runs git on refresh and only notifies when the diff changed', async () => {
        const f = fixture();
        openDiff(f);
        const seen: ContentPaneState[] = [];
        const subscription = await f.service.subscribe(DIFF, (state) => seen.push(state));
        expect(f.gitCalls).toHaveLength(1);

        await f.service.refresh(DIFF);
        expect(f.gitCalls).toHaveLength(2);
        expect(seen).toEqual([]);

        f.diffText = 'diff --git a/y b/y\n@@ -1 +1 @@\n-c\n+d\n';
        const refreshed = await f.service.refresh(DIFF);
        expect(f.gitCalls).toHaveLength(3);
        expect(seen).toHaveLength(1);
        expect(refreshed.html).toContain('y</span>');
        subscription.unsubscribe();
        f.dispose();
    });

    it('renders "No changes" for an empty diff', async () => {
        const f = fixture();
        f.diffText = '';
        openDiff(f);
        expect((await f.service.state(DIFF)).html).toContain('No changes');
        f.dispose();
    });
});

/**
 * §CONT-107 (cancellation) and §CONT-106 (reacting to a moved scope).
 *
 * Both need a `git diff` that does NOT resolve on its own, so this block runs its own service
 * against a scriptable git: every call parks, hands back its abort signal, and is resolved (or
 * left hanging) by the test. The fixture above deliberately answers instantly, which is the
 * wrong instrument for "what happens while git is still running".
 */
describe('diff panes: cancellation and rescoping', () => {
    interface PendingDiff {
        readonly repoPath: string;
        readonly targetPath: string | null;
        readonly signal: AbortSignal | undefined;
        resolve(text: string): void;
        reject(error: Error): void;
    }

    interface SlowFixture {
        readonly store: ReturnType<typeof harness>;
        readonly service: ContentService;
        readonly dir: string;
        readonly calls: PendingDiff[];
        readonly seen: ContentPaneState[];
        dispose(): void;
    }

    function slowFixture(): SlowFixture {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-content-slow-'));
        dirs.push(dir);
        const store = harness(seededState(W1, SHELL));
        const calls: PendingDiff[] = [];
        const git: ContentGit = {
            getDiff: (repoPath, targetPath, options) =>
                new Promise<string>((resolve, reject) => {
                    calls.push({
                        repoPath,
                        targetPath: targetPath ?? null,
                        signal: options?.signal,
                        resolve,
                        reject
                    });
                })
        };
        const service = createContentService({
            store: store.store,
            git,
            watch: false,
            appearance: { backgroundColor: '#101010' }
        });
        return { store, service, dir, calls, seen: [], dispose: () => service.dispose() };
    }

    function openDiffAt(f: SlowFixture, repoPath: string): void {
        f.store.dispatch({ type: 'open-diff-pane', workspaceID: W1, paneID: DIFF, repoPath, now: NOW });
    }

    it('CONT-107: a newer load aborts the running git diff, and the stale answer is dropped', async () => {
        const f = slowFixture();
        openDiffAt(f, f.dir);
        const first = f.service.state(DIFF);
        expect(f.calls).toHaveLength(1);
        f.calls[0]?.resolve('diff --git a/one b/one\n@@ -1 +1 @@\n-a\n+b\n');
        await first;

        const subscription = await f.service.subscribe(DIFF, (state) => f.seen.push(state));
        // Two refreshes in a row — the second supersedes the first while it is still running.
        const slow = f.service.refresh(DIFF);
        await tick(0);
        expect(f.calls).toHaveLength(2);
        expect(f.calls[1]?.signal?.aborted).toBe(false);
        const fresh = f.service.refresh(DIFF);
        await tick(0);
        expect(f.calls).toHaveLength(3);
        // The superseded run is cancelled: the signal is what kills the real child process.
        expect(f.calls[1]?.signal?.aborted).toBe(true);
        expect(f.calls[2]?.signal?.aborted).toBe(false);

        // The newer run answers first, then the stale one finally comes back with older text.
        f.calls[2]?.resolve('diff --git a/new b/new\n@@ -1 +1 @@\n-c\n+d\n');
        await fresh;
        f.calls[1]?.resolve('diff --git a/stale b/stale\n@@ -1 +1 @@\n-e\n+f\n');
        await slow;
        await tick(0);

        const state = await f.service.state(DIFF);
        expect(state.html).toContain('new</span>');
        expect(state.html).not.toContain('stale</span>');
        // …and the pane was told about the new diff exactly once, not once per run.
        expect(f.seen.filter((entry) => entry.html?.includes('new</span>') === true)).toHaveLength(1);
        expect(f.seen.some((entry) => entry.html?.includes('stale</span>') === true)).toBe(false);
        subscription.unsubscribe();
        f.dispose();
    });

    it('CONT-107: a cancelled run cannot paint its failure either', async () => {
        const f = slowFixture();
        openDiffAt(f, f.dir);
        const first = f.service.state(DIFF);
        f.calls[0]?.resolve('diff --git a/one b/one\n@@ -1 +1 @@\n-a\n+b\n');
        await first;

        const slow = f.service.refresh(DIFF);
        await tick(0);
        const fresh = f.service.refresh(DIFF);
        await tick(0);
        f.calls[2]?.resolve('diff --git a/new b/new\n@@ -1 +1 @@\n-c\n+d\n');
        await fresh;
        // A killed child rejects; that rejection is the caller's own doing, so it is not the
        // "Failed to run git diff" page.
        f.calls[1]?.reject(new Error('The operation was aborted'));
        await slow;
        await tick(0);

        const state = await f.service.state(DIFF);
        expect(state.loaded).toBe(true);
        expect(state.error).toBeNull();
        expect(state.html).not.toContain('Failed to run git diff');
        f.dispose();
    });

    it('CONT-107: closing the pane kills the git diff still running for it', async () => {
        const f = slowFixture();
        openDiffAt(f, f.dir);
        const first = f.service.state(DIFF);
        f.calls[0]?.resolve('');
        await first;
        const subscription = await f.service.subscribe(DIFF, (state) => f.seen.push(state));

        const pending = f.service.refresh(DIFF);
        await tick(0);
        expect(f.calls[1]?.signal?.aborted).toBe(false);
        f.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: DIFF });
        expect(f.calls[1]?.signal?.aborted).toBe(true);

        f.calls[1]?.reject(new Error('The operation was aborted'));
        await pending;
        expect(f.seen).toEqual([]);
        subscription.unsubscribe();
        f.dispose();
    });

    it('CONT-106: a repo path that moves under a live subscription re-runs git at once', async () => {
        const f = slowFixture();
        openDiffAt(f, f.dir);
        const first = f.service.state(DIFF);
        f.calls[0]?.resolve('diff --git a/old b/old\n@@ -1 +1 @@\n-a\n+b\n');
        await first;
        const subscription = await f.service.subscribe(DIFF, (state) => f.seen.push(state));

        const moved = path.join(f.dir, 'other-repo');
        fs.mkdirSync(moved);
        // Nothing calls `ensure()` here: the scope change alone has to trigger the re-read.
        f.store.dispatch({
            type: 'pane-directory-changed',
            paneID: DIFF,
            directory: moved,
            now: NOW
        });
        await tick(0);
        expect(f.calls).toHaveLength(2);
        expect(f.calls[1]?.repoPath).toBe(moved);

        f.calls[1]?.resolve('diff --git a/moved b/moved\n@@ -1 +1 @@\n-c\n+d\n');
        await tick(0);
        expect(f.seen.at(-1)?.html).toContain('moved</span>');
        expect((await f.service.state(DIFF)).html).toContain('moved</span>');
        subscription.unsubscribe();
        f.dispose();
    });

    it('CONT-106: a pane change that is NOT a move leaves git alone', async () => {
        const f = slowFixture();
        openDiffAt(f, f.dir);
        const first = f.service.state(DIFF);
        f.calls[0]?.resolve('diff --git a/one b/one\n@@ -1 +1 @@\n-a\n+b\n');
        await first;
        const subscription = await f.service.subscribe(DIFF, (state) => f.seen.push(state));

        // A branch update rides the same `pane-upserted` event as a moved path; only the
        // SCOPE fields may re-run git, or every pane heartbeat would spawn a process.
        f.store.dispatch({
            type: 'pane-branch-changed',
            paneID: DIFF,
            branch: 'feature/x'
        });
        await tick(0);
        expect(f.calls).toHaveLength(1);
        expect(f.seen).toEqual([]);
        subscription.unsubscribe();
        f.dispose();
    });
});

// ---------------------------------------------------------------------------
// Assets + appearance
// ---------------------------------------------------------------------------

describe('assetPath', () => {
    it('resolves a sibling file of the open markdown file', async () => {
        const f = fixture();
        const image = path.join(f.dir, 'diagram.png');
        fs.writeFileSync(image, 'png');
        openMarkdown(f);
        await f.service.state(MD);
        expect(f.service.assetPath(MD, 'diagram.png')).toBe(fs.realpathSync(image));
        f.dispose();
    });

    it('resolves a file in a subdirectory of the file directory', async () => {
        const f = fixture();
        fs.mkdirSync(path.join(f.dir, 'img'));
        fs.writeFileSync(path.join(f.dir, 'img', 'a.png'), 'png');
        openMarkdown(f);
        expect(f.service.assetPath(MD, 'img/a.png')).toContain(path.join('img', 'a.png'));
        f.dispose();
    });

    it('rejects traversal, absolute paths, NUL bytes and directories', async () => {
        const f = fixture();
        const outside = path.join(f.dir, '..', 'kelpi-content-outside.txt');
        fs.writeFileSync(outside, 'secret');
        try {
            openMarkdown(f);
            expect(f.service.assetPath(MD, '../kelpi-content-outside.txt')).toBeNull();
            expect(f.service.assetPath(MD, 'img/../../kelpi-content-outside.txt')).toBeNull();
            expect(f.service.assetPath(MD, '/etc/passwd')).toBeNull();
            expect(f.service.assetPath(MD, 'a\0b')).toBeNull();
            expect(f.service.assetPath(MD, '')).toBeNull();
            expect(f.service.assetPath(MD, '.')).toBeNull();
        } finally {
            fs.rmSync(outside, { force: true });
            f.dispose();
        }
    });

    it('rejects a symlink that escapes the file directory', async () => {
        const f = fixture();
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-outside-'));
        dirs.push(outsideDir);
        const secret = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(secret, 'secret');
        fs.symlinkSync(secret, path.join(f.dir, 'link.txt'));
        openMarkdown(f);
        expect(f.service.assetPath(MD, 'link.txt')).toBeNull();
        f.dispose();
    });

    it('serves nothing for non-markdown panes or unknown panes', async () => {
        const f = fixture();
        openDiff(f);
        openScratchpad(f);
        expect(f.service.assetPath(DIFF, 'x')).toBeNull();
        expect(f.service.assetPath(SCRATCH, 'x')).toBeNull();
        expect(f.service.assetPath('nope', 'x')).toBeNull();
        f.dispose();
    });
});

describe('appearance', () => {
    it('re-renders every entry when the ghostty background changes', async () => {
        const f = fixture();
        openMarkdown(f);
        const seen: ContentPaneState[] = [];
        const subscription = await f.service.subscribe(MD, (state) => seen.push(state));
        expect(subscription.state.html).toContain('<html class="dark">');

        f.service.setAppearance({ backgroundColor: '#FFFFFF' });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.html).toContain('<html class="light">');
        expect(seen[0]?.isDark).toBe(false);
        subscription.unsubscribe();
        f.dispose();
    });

    it('re-renders on a pane font-size change without re-reading the file', async () => {
        const f = fixture();
        openMarkdown(f);
        const seen: ContentPaneState[] = [];
        const subscription = await f.service.subscribe(MD, (state) => seen.push(state));
        f.store.dispatch({
            type: 'set-markdown-font-size',
            workspaceID: W1,
            paneID: MD,
            size: 20
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.fontSize).toBe(20);
        expect(seen[0]?.html).toContain('font-size: 20px;');
        subscription.unsubscribe();
        f.dispose();
    });
});
