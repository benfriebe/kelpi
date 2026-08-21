/**
 * `ContentService` — the daemon's owner of markdown / diff / scratchpad pane content
 * (content-panes.md, port note 1: "the daemon owns the pane model, file reading, file watching,
 * git invocation, and the markdown/diff → HTML transformation").
 *
 * One `Entry` per *content* pane a client cares about:
 *
 *   - it holds the raw source (file text / diff text / scratchpad text) and the rendered HTML
 *     document, so every attached client renders byte-identical output;
 *   - it owns the pane's file watcher (§3.12), suspended while the pane is in edit mode so the
 *     editor's own autosave can never echo back as an external change (§4.2, port note 7);
 *   - it delegates the edit buffer to `./editor.ts`, whose saves come back through `onSaved` and
 *     fan out to subscribers.
 *
 * Entries are created lazily (first subscribe / first mutation) and released when the last
 * subscriber leaves, EXCEPT while an edit buffer is still dirty — that buffer is authoritative
 * and must outlive a client that navigated away, right up to the shutdown flush.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createGitService } from '../git/index.js';
import type { DomainStore } from '../seams.js';
import { findPaneAnywhere } from '../store/derived.js';
import type { DaemonState, DomainAction, DomainEvent, Pane } from '../store/types.js';
import {
    DEFAULT_DIFF_FONT_SIZE,
    gitFailureText,
    renderDiffDocument
} from './diff.js';
import { createEditorBuffers, type EditorBuffers, type EditorTarget } from './editor.js';
import {
    DEFAULT_CONTENT_BACKGROUND,
    isDarkBackground,
    type ContentAppearance
} from './html.js';
import {
    DEFAULT_MARKDOWN_FONT_SIZE,
    fileLoadErrorMarkdown,
    renderMarkdownDocument
} from './markdown.js';
import { watchFile, type FileWatcher } from './watcher.js';

export type ContentPaneType = 'markdown' | 'diff' | 'scratchpad';
export type ContentMode = 'view' | 'edit';

const CONTENT_PANE_TYPES = new Set<string>(['markdown', 'diff', 'scratchpad']);

/** URL prefix of the sibling-asset route (`./http.ts` serves it). */
export const PANE_ASSETS_PREFIX = '/pane-assets';

/** What a subscribed client mirrors. Sent as the subscribe reply and in `content-updated`. */
export interface ContentPaneState {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly type: ContentPaneType;
    /** Scratchpads are always `edit`; diffs always `view` (§1.1). */
    readonly mode: ContentMode;
    readonly filePath: string | null;
    /** The rendered HTML document (markdown + diff). null for scratchpads. */
    readonly html: string | null;
    /**
     * The raw source: the edit buffer in edit mode, and in view mode the markdown the preview
     * was rendered from (the client's "Copy as Markdown" needs it, §3.14). null for diffs.
     */
    readonly text: string | null;
    /** false when the last file read / git run failed — copy actions gate on it (§3.14). */
    readonly loaded: boolean;
    readonly error: string | null;
    /** True while the edit buffer has unsaved changes. */
    readonly dirty: boolean;
    readonly fontSize: number;
    readonly isDark: boolean;
    /** Monotonic per pane; a client can drop a state older than the one it has. */
    readonly revision: number;
    readonly updatedAt: number;
    /** `<base href>` for relative assets (markdown only), also embedded in `html`. */
    readonly assetBase: string | null;
}

export type ContentListener = (state: ContentPaneState) => void;

export interface ContentSubscription {
    readonly state: ContentPaneState;
    unsubscribe(): void;
}

/** The slice of `GitService` this module needs (kept narrow so tests can stub it). */
export interface ContentGit {
    getDiff(
        repoPath: string,
        targetPath?: string | null,
        options?: { readonly signal?: AbortSignal | undefined }
    ): Promise<string>;
}

export interface ContentServiceOptions {
    readonly store: DomainStore<DaemonState, DomainAction, DomainEvent>;
    /** Defaults to a real `createGitService()`. */
    readonly git?: ContentGit | undefined;
    /** Ghostty background/opacity; picks the light/dark theme (§3.1, §3.8). */
    readonly appearance?: ContentAppearance | undefined;
    readonly now?: (() => number) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Editor autosave debounce override (tests). */
    readonly debounceMs?: number | undefined;
    /** Rename re-attach delay override (tests). */
    readonly reattachDelayMs?: number | undefined;
    /** `false` disables file watching entirely (tests / headless batch use). */
    readonly watch?: boolean | undefined;
}

export interface ContentService {
    /** Load (if needed) and return the pane's content state. */
    state(paneID: string): Promise<ContentPaneState>;
    subscribe(paneID: string, listener: ContentListener): Promise<ContentSubscription>;
    /** Markdown only: view ⇄ edit (§4.1). Dispatches `set-markdown-editing`. */
    setMode(paneID: string, mode: ContentMode): Promise<ContentPaneState>;
    /** Client edit → the authoritative buffer (+ debounced save). */
    setText(paneID: string, text: string): Promise<ContentPaneState>;
    /** Explicit flush of the pending debounced save. */
    save(paneID: string): Promise<ContentPaneState>;
    /** Diff: re-run git. Markdown: re-read the file. Scratchpad: no-op. */
    refresh(paneID: string): Promise<ContentPaneState>;
    /**
     * §3.16 preview font size. The clamp (8…32) and the markdown-and-not-editing guard live in
     * the reducer, so this only dispatches and re-reads: a rejected change comes back as the
     * unchanged snapshot rather than an error, exactly as the keybinding path behaves.
     */
    setFontSize(paneID: string, size: number): Promise<ContentPaneState>;
    /** Sibling-asset resolution for `/pane-assets/<paneID>/<relpath>`; null = 404. */
    assetPath(paneID: string, relativePath: string): string | null;
    /** Re-render every live entry against a new ghostty background (§3.8 theme change). */
    setAppearance(appearance: ContentAppearance): void;
    /** Shutdown: write every dirty buffer synchronously (§4.2 quit flush, incl. scratchpads). */
    flushSync(): void;
    dispose(): void;
}

interface Entry {
    readonly paneID: string;
    workspaceID: string;
    type: ContentPaneType;
    filePath: string | null;
    /** Diff panes: the repo (`pane.workingDirectory`). */
    repoPath: string;
    mode: ContentMode;
    /** Raw source: file text / diff text / scratchpad text. */
    content: string;
    html: string | null;
    loaded: boolean;
    error: string | null;
    fontSize: number;
    revision: number;
    updatedAt: number;
    watcher: FileWatcher | null;
    /** In-flight load; a second caller awaits it instead of seeing a half-built entry. */
    loading: Promise<void> | null;
    /**
     * §CONT-107: the in-flight `git diff`'s abort handle. A newer load aborts the older run —
     * which kills the child — and the older run then drops its own result, so what the pane
     * shows is the answer the LAST request asked for rather than whichever process happened to
     * finish last. Cleared when the run that owns it settles.
     */
    diffRun: AbortController | null;
    readonly listeners: Set<ContentListener>;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function messageOf(value: unknown): string {
    return toError(value).message;
}

export function createContentService(options: ContentServiceOptions): ContentService {
    const store = options.store;
    const git: ContentGit = options.git ?? createGitService();
    const now = options.now ?? ((): number => Date.now());
    const watchEnabled = options.watch !== false;
    const entries = new Map<string, Entry>();
    let appearance: ContentAppearance = options.appearance ?? {};
    let disposed = false;

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    const backgroundColor = (): string => appearance.backgroundColor ?? DEFAULT_CONTENT_BACKGROUND;

    // ── snapshots + fan-out ─────────────────────────────────────────────────

    const assetBaseFor = (entry: Entry): string | null =>
        entry.type === 'markdown' && entry.filePath !== null
            ? `${PANE_ASSETS_PREFIX}/${entry.paneID}/`
            : null;

    const snapshot = (entry: Entry): ContentPaneState => ({
        paneID: entry.paneID,
        workspaceID: entry.workspaceID,
        type: entry.type,
        mode: entry.mode,
        filePath: entry.filePath,
        html: entry.html,
        text: entry.type === 'diff' ? null : entry.content,
        loaded: entry.loaded,
        error: entry.error,
        dirty: editor.isDirty(entry.paneID),
        fontSize: entry.fontSize,
        isDark: isDarkBackground(backgroundColor()),
        revision: entry.revision,
        updatedAt: entry.updatedAt,
        assetBase: assetBaseFor(entry)
    });

    const emit = (entry: Entry): void => {
        entry.revision += 1;
        entry.updatedAt = now();
        if (entry.listeners.size === 0) return;
        const state = snapshot(entry);
        for (const listener of [...entry.listeners]) {
            try {
                listener(state);
            } catch (error) {
                report(error, `content listener ${entry.paneID}`);
            }
        }
    };

    // ── rendering ───────────────────────────────────────────────────────────

    const render = (entry: Entry): void => {
        if (entry.type === 'scratchpad') {
            entry.html = null;
            return;
        }
        const base = assetBaseFor(entry);
        entry.html =
            entry.type === 'markdown'
                ? renderMarkdownDocument(entry.content, {
                      backgroundColor: backgroundColor(),
                      baseFontSize: entry.fontSize,
                      ...(base !== null ? { baseHref: base } : {})
                  })
                : renderDiffDocument(entry.content, {
                      backgroundColor: backgroundColor(),
                      baseFontSize: entry.fontSize
                  });
    };

    // ── the edit buffer ─────────────────────────────────────────────────────

    const editor: EditorBuffers = createEditorBuffers({
        saveScratchpad: (paneID, text) => {
            const entry = entries.get(paneID);
            if (entry === undefined) return;
            store.dispatch({
                type: 'scratchpad-content-changed',
                workspaceID: entry.workspaceID,
                paneID,
                content: text
            });
        },
        onSaved: (paneID, text) => {
            const entry = entries.get(paneID);
            if (entry === undefined) return;
            entry.content = text;
            entry.loaded = true;
            entry.error = null;
            render(entry);
            emit(entry);
            releaseIfIdle(entry);
        },
        onError: (error, context) => report(error, context),
        ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {})
    });

    const targetOf = (entry: Entry): EditorTarget =>
        entry.type === 'scratchpad' || entry.filePath === null
            ? { kind: 'scratchpad' }
            : { kind: 'file', path: entry.filePath };

    // ── loading ─────────────────────────────────────────────────────────────

    const loadMarkdown = async (entry: Entry): Promise<void> => {
        const filePath = entry.filePath;
        if (filePath === null) {
            entry.content = '';
            entry.loaded = false;
            entry.error = 'markdown pane has no file path';
            return;
        }
        try {
            entry.content = await fs.promises.readFile(filePath, 'utf8');
            entry.loaded = true;
            entry.error = null;
        } catch (error) {
            // §3.11: the failure is rendered AS markdown (a blockquote), not as an error page.
            const message = messageOf(error);
            entry.content = fileLoadErrorMarkdown(filePath, message);
            entry.loaded = false;
            entry.error = message;
        }
        editor.seed(entry.paneID, targetOf(entry), entry.content);
    };

    /** §CONT-107: kill whatever `git diff` is still running for this pane. */
    const cancelDiff = (entry: Entry): void => {
        entry.diffRun?.abort();
        entry.diffRun = null;
    };

    /**
     * §CONT-107 (`DiffPaneView.swift:132-158,107-110`): one `git diff` at a time per pane.
     *
     * Two rules, and the second is the one that matters: the previous run is CANCELLED (the
     * child is killed, so a big tree's diff stops costing anything the moment it is stale), and
     * a cancelled run writes NOTHING — neither its text, nor its failure, nor an emission.
     * Without that second rule two rapid refreshes race and the later write wins by scheduling
     * accident, which is how a diff pane ends up showing the older of two answers.
     *
     * Returns whether THIS run's answer was applied; a superseded run says false so its caller
     * does not go on to render and notify on the winner's behalf.
     */
    const loadDiff = async (entry: Entry): Promise<boolean> => {
        cancelDiff(entry);
        const run = new AbortController();
        entry.diffRun = run;
        try {
            const text = await git.getDiff(entry.repoPath, entry.filePath, { signal: run.signal });
            if (run.signal.aborted) return false;
            entry.content = text;
            entry.loaded = true;
            entry.error = null;
            return true;
        } catch (error) {
            // An abort surfaces here as a rejection (killed child / `AbortError`); it is the
            // caller's own doing, never something to paint into the pane.
            if (run.signal.aborted) return false;
            const message = messageOf(error);
            entry.content = gitFailureText(entry.repoPath, message);
            entry.loaded = false;
            entry.error = message;
            return true;
        } finally {
            if (entry.diffRun === run) entry.diffRun = null;
        }
    };

    const loadScratchpad = (entry: Entry, pane: Pane): void => {
        const buffered = editor.text(entry.paneID);
        entry.content = buffered ?? pane.scratchpadContent ?? '';
        entry.loaded = true;
        entry.error = null;
        if (buffered === undefined) editor.seed(entry.paneID, targetOf(entry), entry.content);
    };

    /** False only when a diff load was superseded (§CONT-107): nothing was written. */
    const load = async (entry: Entry, pane: Pane): Promise<boolean> => {
        if (entry.type === 'markdown') await loadMarkdown(entry);
        else if (entry.type === 'diff') {
            if (!(await loadDiff(entry))) return false;
        } else loadScratchpad(entry, pane);
        render(entry);
        return true;
    };

    // ── watching ────────────────────────────────────────────────────────────

    const stopWatch = (entry: Entry): void => {
        entry.watcher?.close();
        entry.watcher = null;
    };

    const startWatch = (entry: Entry): void => {
        if (!watchEnabled || disposed) return;
        if (entry.type !== 'markdown' || entry.filePath === null) return;
        if (entry.mode === 'edit') return; // §4.2: no watching while editing
        if (entry.watcher !== null) {
            entry.watcher.resume();
            return;
        }
        entry.watcher = watchFile({
            path: entry.filePath,
            onChange: () => {
                void reloadFromDisk(entry).catch((error: unknown) =>
                    report(error, `content reload ${entry.paneID}`)
                );
            },
            ...(options.reattachDelayMs !== undefined
                ? { reattachDelayMs: options.reattachDelayMs }
                : {}),
            onError: (error, context) => report(error, context)
        });
    };

    /** §3.11: byte-identical content is a no-op (no re-render, no scroll flicker on `touch`). */
    const reloadFromDisk = async (entry: Entry): Promise<boolean> => {
        if (disposed || !entries.has(entry.paneID)) return false;
        const before = entry.content;
        await loadMarkdown(entry);
        if (entry.content === before) return false;
        render(entry);
        emit(entry);
        return true;
    };

    // ── entry lifecycle ─────────────────────────────────────────────────────

    const locate = (paneID: string): { pane: Pane; workspaceID: string } => {
        const found = findPaneAnywhere(store.getState(), paneID);
        if (found === null) throw new Error(`no pane matches '${paneID}'`);
        if (!CONTENT_PANE_TYPES.has(found.pane.type)) {
            throw new Error(`pane '${paneID}' is a ${found.pane.type} pane, not a content pane`);
        }
        return { pane: found.pane, workspaceID: found.workspaceID };
    };

    /** Pane metadata can move under a live entry (file path change, pane moved workspace). */
    const sync = (entry: Entry, pane: Pane, workspaceID: string): boolean => {
        let changed = false;
        if (entry.workspaceID !== workspaceID) {
            entry.workspaceID = workspaceID;
            changed = true;
        }
        if (entry.filePath !== pane.filePath) {
            entry.filePath = pane.filePath;
            changed = true;
        }
        if (entry.type === 'diff' && entry.repoPath !== pane.workingDirectory) {
            entry.repoPath = pane.workingDirectory;
            changed = true;
        }
        return changed;
    };

    /**
     * Run a load exactly once per entry, with concurrent callers sharing the same promise.
     * Answers `load`'s "did this run write anything" (§CONT-107).
     */
    const runLoad = async (entry: Entry, pane: Pane): Promise<boolean> => {
        let applied = true;
        const loading = load(entry, pane)
            .then((result) => {
                applied = result;
            })
            .finally(() => {
                entry.loading = null;
            });
        entry.loading = loading;
        await loading;
        return applied;
    };

    const ensure = async (paneID: string): Promise<Entry> => {
        const existing = entries.get(paneID);
        if (existing !== undefined) {
            // A concurrent first-subscribe may still be reading the file; never hand back a
            // half-built entry.
            if (existing.loading !== null) await existing.loading;
            const { pane, workspaceID } = locate(paneID);
            if (sync(existing, pane, workspaceID)) {
                stopWatch(existing);
                const applied = await runLoad(existing, pane);
                startWatch(existing);
                // A superseded diff wrote nothing, so there is nothing to announce (§CONT-107).
                if (applied) emit(existing);
            }
            return existing;
        }

        const { pane, workspaceID } = locate(paneID);
        const type = pane.type as ContentPaneType;
        const entry: Entry = {
            paneID,
            workspaceID,
            type,
            filePath: pane.filePath,
            repoPath: pane.workingDirectory,
            // §1.2: markdown restores in view mode, scratchpads are always editing.
            mode: type === 'scratchpad' || pane.isEditing ? 'edit' : 'view',
            content: '',
            html: null,
            loaded: false,
            error: null,
            fontSize:
                type === 'diff'
                    ? (pane.markdownFontSize || DEFAULT_DIFF_FONT_SIZE)
                    : (pane.markdownFontSize || DEFAULT_MARKDOWN_FONT_SIZE),
            revision: 0,
            updatedAt: now(),
            watcher: null,
            loading: null,
            diffRun: null,
            listeners: new Set<ContentListener>()
        };
        entries.set(paneID, entry);
        await runLoad(entry, pane);
        return entry;
    };

    /**
     * §CONT-106 — re-run the pane's load because its SCOPE moved (a diff pane's repo or target
     * path, a markdown pane's file). The same sequence `ensure()` runs when it notices a moved
     * path, hoisted out so the store subscription can run it the moment the change lands
     * instead of waiting for the next command.
     */
    const reloadForMovedPane = async (paneID: string): Promise<void> => {
        const entry = entries.get(paneID);
        if (entry === undefined) return;
        // Kill the read for the OLD scope BEFORE awaiting it: its answer is already wrong, and
        // waiting for a big `git diff` would hold the rescope open for no reason.
        cancelDiff(entry);
        if (entry.loading !== null) await entry.loading;
        if (disposed || entries.get(paneID) !== entry) return;
        const found = findPaneAnywhere(store.getState(), paneID);
        if (found === null || !CONTENT_PANE_TYPES.has(found.pane.type)) return;
        if (!sync(entry, found.pane, found.workspaceID)) return;
        stopWatch(entry);
        const applied = await runLoad(entry, found.pane);
        if (disposed || entries.get(paneID) !== entry) return;
        startWatch(entry);
        if (applied) emit(entry);
    };

    /** Drop an entry once nothing watches it AND its buffer holds nothing unsaved. */
    function releaseIfIdle(entry: Entry): void {
        if (entry.listeners.size > 0) return;
        stopWatch(entry);
        if (editor.isDirty(entry.paneID)) return;
        cancelDiff(entry); // §CONT-107: nothing is watching, so nothing wants the answer.
        editor.drop(entry.paneID);
        entries.delete(entry.paneID);
    }

    const forget = (paneID: string): void => {
        const entry = entries.get(paneID);
        if (entry === undefined) return;
        // The pane is gone: save what the buffer still holds, then release everything.
        editor.forget(paneID);
        stopWatch(entry);
        // §CONT-107 (the Swift view's `deinit`): a pane that closed mid-`git diff` kills it.
        cancelDiff(entry);
        entry.listeners.clear();
        entries.delete(paneID);
    };

    // A closed pane must not keep a watcher (or an unsaved buffer) alive.
    const unsubscribeStore = store.subscribe((events) => {
        if (disposed) return;
        for (const event of events) {
            if (event.kind === 'pane-removed') {
                forget(event.paneID);
                continue;
            }
            if (event.kind === 'workspace-removed') {
                for (const entry of [...entries.values()]) {
                    if (entry.workspaceID === event.id) forget(entry.paneID);
                }
                continue;
            }
            if (event.kind === 'pane-upserted') {
                const entry = entries.get(event.paneID);
                if (entry === undefined) continue;
                // Font size is transient pane state a client can change (⌘= / ⌘-); re-render
                // without re-reading the file (§3.16).
                const size = event.pane.markdownFontSize;
                if (size > 0 && size !== entry.fontSize) {
                    entry.fontSize = size;
                    render(entry);
                    emit(entry);
                }
                /*
                 * §CONT-106 — the pane's SCOPE moved under a live subscription.
                 *
                 * Swift re-runs `git diff` whenever the view's repo path or target path
                 * changes, not just when the pane is refreshed or refocused. The port used to
                 * pick a moved path up only on the next command that happened to call
                 * `ensure()`, so a subscriber watched a diff of somewhere else until it did
                 * something. `reloadForMovedPane` is the same reload `ensure()` runs, and it
                 * cancels the in-flight read first (§CONT-107) because that read is now for
                 * the wrong scope.
                 */
                const moved =
                    entry.filePath !== event.pane.filePath ||
                    (entry.type === 'diff' && entry.repoPath !== event.pane.workingDirectory);
                if (!moved) continue;
                void reloadForMovedPane(event.paneID).catch((error: unknown) =>
                    report(error, `content rescope ${event.paneID}`)
                );
            }
        }
    });

    // ── public API ──────────────────────────────────────────────────────────

    const service: ContentService = {
        async state(paneID) {
            const entry = await ensure(paneID);
            return snapshot(entry);
        },

        async subscribe(paneID, listener) {
            const entry = await ensure(paneID);
            entry.listeners.add(listener);
            startWatch(entry);
            let released = false;
            return {
                state: snapshot(entry),
                unsubscribe: () => {
                    if (released) return;
                    released = true;
                    entry.listeners.delete(listener);
                    releaseIfIdle(entry);
                }
            };
        },

        async setMode(paneID, mode) {
            const entry = await ensure(paneID);
            if (entry.type !== 'markdown') {
                throw new Error(`pane '${paneID}' is a ${entry.type} pane and has no edit mode`);
            }
            if (entry.mode === mode) return snapshot(entry);

            entry.mode = mode;
            store.dispatch({
                type: 'set-markdown-editing',
                workspaceID: entry.workspaceID,
                paneID,
                editing: mode === 'edit'
            });

            if (mode === 'edit') {
                // The buffer starts from what the preview last read; the watcher stands down so
                // autosave can never come back as an "external" change.
                entry.watcher?.suspend();
                if (!editor.isDirty(paneID)) editor.seed(paneID, targetOf(entry), entry.content);
            } else {
                editor.flush(paneID);
                await reloadFromDisk(entry);
                startWatch(entry);
            }
            emit(entry);
            return snapshot(entry);
        },

        async setText(paneID, text) {
            const entry = await ensure(paneID);
            if (entry.type === 'diff') throw new Error(`pane '${paneID}' is a read-only diff pane`);
            if (entry.type === 'markdown' && entry.mode !== 'edit') {
                throw new Error(`pane '${paneID}' is not in edit mode`);
            }
            entry.content = text;
            // Subscribers are notified on SAVE, not per keystroke: the debounced write is what
            // other clients follow (port note 7), and the typist already has the text.
            editor.set(paneID, targetOf(entry), text);
            return snapshot(entry);
        },

        async save(paneID) {
            const entry = await ensure(paneID);
            editor.flush(paneID);
            return snapshot(entry);
        },

        async refresh(paneID) {
            const entry = await ensure(paneID);
            if (entry.type === 'diff') {
                const before = entry.content;
                // §CONT-107: a run this refresh no longer owns must not render or notify — the
                // text it would be comparing against is the WINNER's, not its own.
                const applied = await loadDiff(entry);
                if (applied && entry.content !== before) {
                    render(entry);
                    emit(entry);
                }
                return snapshot(entry);
            }
            if (entry.type === 'markdown') {
                await reloadFromDisk(entry);
                return snapshot(entry);
            }
            return snapshot(entry);
        },

        async setFontSize(paneID, size) {
            const entry = await ensure(paneID);
            if (!Number.isFinite(size)) throw new Error('font size must be a number');
            store.dispatch({
                type: 'set-markdown-font-size',
                workspaceID: entry.workspaceID,
                paneID,
                size
            });
            // `dispatch` is synchronous and this service subscribes to the store, so by the time
            // it returns the `pane-upserted` handler above has already re-rendered and emitted;
            // the snapshot below is therefore the post-change one, not a stale read.
            return snapshot(entry);
        },

        assetPath(paneID, relativePath) {
            let pane: Pane;
            try {
                pane = locate(paneID).pane;
            } catch {
                return null;
            }
            if (pane.type !== 'markdown' || pane.filePath === null) return null;
            if (relativePath.includes('\0') || relativePath === '') return null;
            if (path.isAbsolute(relativePath)) return null;

            const directory = path.resolve(path.dirname(pane.filePath));
            const resolved = path.resolve(directory, relativePath);
            if (resolved === directory || !resolved.startsWith(directory + path.sep)) return null;

            try {
                // Symlinks are resolved before the containment re-check so a link inside the
                // directory cannot smuggle a file from outside it.
                const realDirectory = fs.realpathSync(directory);
                const real = fs.realpathSync(resolved);
                if (real !== realDirectory && !real.startsWith(realDirectory + path.sep)) {
                    return null;
                }
                return fs.statSync(real).isFile() ? real : null;
            } catch {
                return null;
            }
        },

        setAppearance(next) {
            appearance = next;
            for (const entry of entries.values()) {
                render(entry);
                emit(entry);
            }
        },

        flushSync() {
            editor.flushAll();
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribeStore();
            for (const entry of entries.values()) {
                stopWatch(entry);
                // §CONT-107: shutdown is a teardown too — no child outlives the service.
                cancelDiff(entry);
                entry.listeners.clear();
            }
            entries.clear();
            editor.dispose();
        }
    };

    return service;
}
