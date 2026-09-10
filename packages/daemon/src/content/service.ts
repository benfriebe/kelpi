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
import { randomUUID } from 'node:crypto';

import { pluginJSON, type DocumentSnapshot } from '@kelpi/protocol';

import { createGitService } from '../git/index.js';
import type { BuiltinServiceHost } from '../plugins/builtin-services.js';
import type { DomainStore } from '../seams.js';
import { findPaneAnywhere } from '../store/derived.js';
import type { DaemonState, DomainAction, DomainEvent, Pane } from '../store/types.js';
import {
    DEFAULT_DIFF_FONT_SIZE,
    gitFailureText
} from './diff.js';
import { createEditorBuffers, type EditorBuffers, type EditorTarget } from './editor.js';
import {
    DEFAULT_CONTENT_BACKGROUND,
    isDarkBackground,
    type ContentAppearance
} from './html.js';
import {
    DEFAULT_MARKDOWN_FONT_SIZE,
    fileLoadErrorMarkdown
} from './markdown.js';
import { CONTENT_RENDER_SERVICE, CONTENT_RENDER_VERSION, contentRenderHTML, renderContentDocument, type ContentRenderArgs } from './render-service.js';
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
    /** Lazy because content is composed before the plugin supervisor. */
    readonly services?: (() => BuiltinServiceHost | undefined) | undefined;
}

export interface ContentService {
    document(paneID: string): Promise<DocumentSnapshot>;
    /** Save accepted edits before a pane/workspace closes; a failed save refuses the close. */
    prepareClose(paneIDs: readonly string[]): void;
    /** Load (if needed) and return the pane's content state. */
    state(paneID: string): Promise<ContentPaneState>;
    subscribe(paneID: string, listener: ContentListener): Promise<ContentSubscription>;
    /** Markdown only: view ⇄ edit (§4.1). Dispatches `set-markdown-editing`. */
    setMode(paneID: string, mode: ContentMode, guard?: DocumentGuard): Promise<ContentPaneState>;
    /** Client edit → the authoritative buffer (+ debounced save). */
    setText(paneID: string, text: string, guard?: DocumentGuard): Promise<ContentPaneState>;
    /** Explicit flush of the pending debounced save. */
    save(paneID: string, guard?: DocumentGuard): Promise<ContentPaneState>;
    /** Diff: re-run git. Markdown: re-read the file. Scratchpad: no-op. */
    refresh(paneID: string, guard?: DocumentGuard): Promise<ContentPaneState>;
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
    /** Provider selection, availability, or generation changed; source and dirty buffers stay. */
    invalidateRenderer(): void;
    /** Git provider changed; reload only existing diff entries, never open unobserved panes. */
    invalidateGit(): void;
    /** Shutdown: write every dirty buffer synchronously (§4.2 quit flush, incl. scratchpads). */
    flushSync(): void;
    dispose(): void;
}

export interface DocumentGuard {
    readonly revision: string;
    readonly signal?: AbortSignal | undefined;
}

interface Entry {
    readonly incarnation: string;
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
    /** Retires disk reads before newer source, edit intent, or entry ownership can change. */
    markdownGeneration: number;
    renderGeneration: number;
    renderRun: AbortController | null;
    rendering: Promise<boolean> | null;
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

    const documentRevision = (entry: Entry): string => `${entry.incarnation}:${entry.revision}`;
    /** Invalidate retained edits as soon as state changes, before a renderer can yield. */
    const advanceRevision = (entry: Entry): void => {
        entry.revision += 1;
        entry.updatedAt = now();
    };
    const setSource = (entry: Entry, content: string, loaded: boolean, error: string | null): void => {
        if (entry.content === content && entry.loaded === loaded && entry.error === error) return;
        entry.content = content;
        entry.loaded = loaded;
        entry.error = error;
        advanceRevision(entry);
    };
    const checkDocument = (entry: Entry, guard?: DocumentGuard): void => {
        assertLive(entry);
        if (!guard) return;
        if (guard.signal?.aborted) throw new Error('Document operation cancelled.');
        if (guard.revision !== documentRevision(entry)) throw new Error('DOCUMENT_CONFLICT: The document changed. Read the latest revision before applying edits.');
        if (findPaneAnywhere(store.getState(), entry.paneID)?.pane.externalEditorCommand != null) throw new Error('Document is owned by an external editor.');
    };

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
        advanceRevision(entry);
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

    const cancelRender = (entry: Entry): void => {
        entry.renderGeneration += 1;
        entry.renderRun?.abort();
        entry.renderRun = null;
    };

    const render = (entry: Entry): boolean | Promise<boolean> => {
        cancelRender(entry);
        if (disposed || entries.get(entry.paneID) !== entry) return false;
        if (entry.type === 'scratchpad') {
            entry.html = null;
            return true;
        }
        const args: ContentRenderArgs = { kind: entry.type, source: entry.content, backgroundColor: backgroundColor(), fontSize: entry.fontSize, assetBase: assetBaseFor(entry) };
        const bundled = (): true => { entry.html = renderContentDocument(args); return true; };
        const host = options.services?.();
        if (!host?.hasSelectedProvider(CONTENT_RENDER_SERVICE, CONTENT_RENDER_VERSION)) return bundled();
        const input = { service: CONTENT_RENDER_SERVICE, version: CONTENT_RENDER_VERSION, method: 'render', args: { ...args } };
        const fallback = (error: unknown): true => {
            report(error, `content renderer ${entry.paneID}; using bundled renderer`);
            return bundled();
        };
        // Native documents are not truncated to the plugin transport limit. Rendering is pure,
        // so an oversized request or failed provider can safely use the complete native source.
        try { pluginJSON(input); } catch (error) { return fallback(error); }
        const run = new AbortController();
        const generation = entry.renderGeneration;
        const context = { daemonID: host.daemonID, workspaceID: entry.workspaceID, paneID: entry.paneID };
        entry.renderRun = run;
        const current = (): boolean => !disposed && entries.get(entry.paneID) === entry && entry.renderGeneration === generation && !run.signal.aborted;
        let onAbort: () => void;
        const cancelled = new Promise<false>(resolve => { onAbort = () => resolve(false); run.signal.addEventListener('abort', onAbort, { once: true }); });
        const work = Promise.resolve().then(async () => {
            if (!current()) return false;
            const result = await host.callService(input, context, run.signal);
            if (!current()) return false;
            entry.html = contentRenderHTML(pluginJSON(result));
            return true;
        }).catch((error: unknown) => current() ? fallback(error) : false);
        const rendering = Promise.race([work, cancelled]).finally(() => {
            run.signal.removeEventListener('abort', onAbort);
            if (entry.renderRun === run) entry.renderRun = null;
            if (entry.rendering === rendering) entry.rendering = null;
        });
        entry.rendering = rendering;
        return rendering;
    };

    /** Keep synchronous native updates synchronous; external output publishes only when current. */
    const renderAndEmit = (entry: Entry): void => {
        const result = render(entry);
        const generation = entry.renderGeneration;
        if (typeof result === 'boolean') { if (result) emit(entry); }
        else void result.then(applied => { if (applied && entry.renderGeneration === generation) emit(entry); });
    };

    const awaitRendering = async (entry: Entry): Promise<void> => {
        while (entry.rendering && !disposed && entries.get(entry.paneID) === entry) await entry.rendering;
    };

    const assertLive = (entry: Entry): void => {
        if (disposed || entries.get(entry.paneID) !== entry) throw new Error('content pane was closed while loading');
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
            cancelMarkdown(entry);
            entry.content = text;
            entry.loaded = true;
            entry.error = null;
            // The editor already cleared dirty; expose that transition before rendering.
            advanceRevision(entry);
            renderAndEmit(entry);
            releaseIfIdle(entry);
        },
        onSaveFailed: (paneID, error) => {
            const entry = entries.get(paneID);
            if (entry === undefined) return;
            entry.error = error.message;
            emit(entry);
        },
        onError: (error, context) => report(error, context),
        ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {})
    });

    const targetOf = (entry: Entry): EditorTarget =>
        entry.type === 'scratchpad' || entry.filePath === null
            ? { kind: 'scratchpad' }
            : { kind: 'file', path: entry.filePath };

    // ── loading ─────────────────────────────────────────────────────────────

    const cancelMarkdown = (entry: Entry): void => {
        entry.markdownGeneration += 1;
    };

    /** A disk read can finish after an edit, rescope, or close; it may then write nothing. */
    const loadMarkdown = async (entry: Entry): Promise<boolean> => {
        cancelMarkdown(entry);
        const generation = entry.markdownGeneration;
        const filePath = entry.filePath;
        const mode = entry.mode;
        const editing = findPaneAnywhere(store.getState(), entry.paneID)?.pane.isEditing;
        const current = (): boolean => {
            if (disposed || entries.get(entry.paneID) !== entry ||
                entry.markdownGeneration !== generation || entry.filePath !== filePath ||
                entry.mode !== mode || editor.isDirty(entry.paneID)) return false;
            const found = findPaneAnywhere(store.getState(), entry.paneID);
            return found?.pane.type === 'markdown' && found.pane.filePath === filePath &&
                found.pane.isEditing === editing;
        };
        if (!current()) return false;
        let content = '';
        let loaded = false;
        let error: string | null = 'markdown pane has no file path';
        if (filePath !== null) {
            try {
                content = await fs.promises.readFile(filePath, 'utf8');
                loaded = true;
                error = null;
            } catch (cause) {
                // §3.11: the failure is rendered AS markdown, only if this read still owns it.
                error = messageOf(cause);
                content = fileLoadErrorMarkdown(filePath, error);
            }
        }
        if (!current()) return false;
        setSource(entry, content, loaded, error);
        editor.seed(entry.paneID, targetOf(entry), entry.content);
        return true;
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
            setSource(entry, text, true, null);
            return true;
        } catch (error) {
            // An abort surfaces here as a rejection (killed child / `AbortError`); it is the
            // caller's own doing, never something to paint into the pane.
            if (run.signal.aborted) return false;
            const message = messageOf(error);
            setSource(entry, gitFailureText(entry.repoPath, message), false, message);
            return true;
        } finally {
            if (entry.diffRun === run) entry.diffRun = null;
        }
    };

    const loadScratchpad = (entry: Entry, pane: Pane): void => {
        const buffered = editor.text(entry.paneID);
        setSource(entry, buffered ?? pane.scratchpadContent ?? '', true, null);
        if (buffered === undefined) editor.seed(entry.paneID, targetOf(entry), entry.content);
    };

    /** A superseded disk/Git load writes nothing and must not render or announce a result. */
    const load = async (entry: Entry, pane: Pane): Promise<boolean> => {
        if (entry.type === 'markdown') {
            if (!(await loadMarkdown(entry))) return false;
        } else if (entry.type === 'diff') {
            if (!(await loadDiff(entry))) return false;
        } else loadScratchpad(entry, pane);
        return await render(entry);
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
        if (disposed || entries.get(entry.paneID) !== entry || entry.mode === 'edit') return false;
        const before = entry.content;
        if (!(await loadMarkdown(entry))) return false;
        if (entry.content === before) return false;
        const applied = await render(entry);
        if (applied) emit(entry);
        return applied;
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
            cancelMarkdown(entry);
            entry.filePath = pane.filePath;
            changed = true;
        }
        if (entry.type === 'diff' && entry.repoPath !== pane.workingDirectory) {
            entry.repoPath = pane.workingDirectory;
            changed = true;
        }
        if (changed) advanceRevision(entry);
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
                if (entry.loading === loading) entry.loading = null;
            });
        entry.loading = loading;
        await loading;
        return applied;
    };

    const awaitLoading = async (entry: Entry): Promise<void> => {
        while (entry.loading && !disposed && entries.get(entry.paneID) === entry) await entry.loading;
    };

    const ensure = async (paneID: string): Promise<Entry> => {
        const existing = entries.get(paneID);
        if (existing !== undefined) {
            // A concurrent first-subscribe may still be reading the file; never hand back a
            // half-built entry.
            await awaitLoading(existing);
            assertLive(existing);
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
            incarnation: randomUUID(),
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
            markdownGeneration: 0,
            renderGeneration: 0,
            renderRun: null,
            rendering: null,
            listeners: new Set<ContentListener>()
        };
        entries.set(paneID, entry);
        await runLoad(entry, pane);
        await awaitLoading(entry);
        assertLive(entry);
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
        cancelMarkdown(entry);
        cancelRender(entry);
        // Disk reads cannot be interrupted here; their generation guard permits the new
        // scope to load immediately without waiting for the retired file read.
        if (entry.type !== 'markdown' && entry.loading !== null) await entry.loading;
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
        if (entries.get(entry.paneID) !== entry) return;
        if (entry.listeners.size > 0) return;
        stopWatch(entry);
        cancelMarkdown(entry);
        cancelRender(entry);
        if (editor.isDirty(entry.paneID)) return;
        cancelDiff(entry); // §CONT-107: nothing is watching, so nothing wants the answer.
        editor.drop(entry.paneID);
        entries.delete(entry.paneID);
    }

    const forget = (paneID: string): void => {
        const entry = entries.get(paneID);
        if (entry === undefined) return;
        cancelMarkdown(entry);
        // The pane is gone: save what the buffer still holds, then release everything.
        editor.forget(paneID);
        stopWatch(entry);
        // §CONT-107 (the Swift view's `deinit`): a pane that closed mid-`git diff` kills it.
        cancelDiff(entry);
        cancelRender(entry);
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
                    renderAndEmit(entry);
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
        prepareClose(paneIDs) {
            for (const paneID of paneIDs) {
                const entry = entries.get(paneID);
                if (!entry || !editor.isDirty(paneID)) continue;
                editor.flush(paneID);
                if (editor.isDirty(paneID)) throw new Error(entry.error ?? 'Could not save document before closing.');
            }
        },
        async document(paneID) {
            const entry = await ensure(paneID);
            assertLive(entry);
            return { paneID, workspaceID: entry.workspaceID, kind: entry.type, mode: entry.mode,
                path: entry.filePath, text: entry.content, loaded: entry.loaded, dirty: editor.isDirty(paneID),
                error: entry.error, revision: documentRevision(entry) };
        },
        async state(paneID) {
            const entry = await ensure(paneID);
            await awaitRendering(entry);
            assertLive(entry);
            return snapshot(entry);
        },

        async subscribe(paneID, listener) {
            const entry = await ensure(paneID);
            await awaitRendering(entry);
            assertLive(entry);
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

        async setMode(paneID, mode, guard) {
            const entry = await ensure(paneID);
            checkDocument(entry, guard);
            if (entry.type !== 'markdown') {
                throw new Error(`pane '${paneID}' is a ${entry.type} pane and has no edit mode`);
            }
            cancelMarkdown(entry);
            if (entry.mode === mode) return snapshot(entry);

            if (mode === 'view') {
                editor.flush(paneID);
                if (editor.isDirty(paneID)) throw new Error(entry.error ?? 'Could not save markdown');
            }
            entry.mode = mode;
            advanceRevision(entry);
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
                await reloadFromDisk(entry);
                startWatch(entry);
            }
            await awaitRendering(entry);
            emit(entry);
            return snapshot(entry);
        },

        async setText(paneID, text, guard) {
            const entry = await ensure(paneID);
            checkDocument(entry, guard);
            if (guard && !entry.loaded) throw new Error('Document has not loaded successfully.');
            if (entry.type === 'diff') throw new Error(`pane '${paneID}' is a read-only diff pane`);
            if (entry.type === 'markdown' && entry.mode !== 'edit') {
                throw new Error(`pane '${paneID}' is not in edit mode`);
            }
            cancelMarkdown(entry);
            entry.content = text;
            cancelRender(entry);
            // Subscribers are notified on SAVE, not per keystroke: the debounced write is what
            // other clients follow (port note 7), and the typist already has the text.
            editor.set(paneID, targetOf(entry), text);
            // A second editor must observe this write before autosave emits its notification.
            advanceRevision(entry);
            return snapshot(entry);
        },

        async save(paneID, guard) {
            const entry = await ensure(paneID);
            checkDocument(entry, guard);
            cancelMarkdown(entry);
            editor.flush(paneID);
            if (editor.isDirty(paneID)) throw new Error(entry.error ?? 'Could not save content');
            await awaitRendering(entry);
            return snapshot(entry);
        },

        async refresh(paneID, guard) {
            const entry = await ensure(paneID);
            checkDocument(entry, guard);
            if (guard && editor.isDirty(paneID)) throw new Error('Save pending document changes before refreshing.');
            if (entry.type === 'diff') {
                const before = entry.content;
                // §CONT-107: a run this refresh no longer owns must not render or notify — the
                // text it would be comparing against is the WINNER's, not its own.
                const applied = await loadDiff(entry);
                if (applied && entry.content !== before) {
                    const applied = await render(entry);
                    if (applied) emit(entry);
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
            // Native rendering is synchronous. A selected external renderer must finish the
            // new font-size generation before this command replies with its document.
            await awaitRendering(entry);
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
                renderAndEmit(entry);
            }
        },

        invalidateRenderer() {
            for (const entry of entries.values()) renderAndEmit(entry);
        },

        invalidateGit() {
            for (const entry of entries.values()) {
                if (entry.type !== 'diff') continue;
                const found = findPaneAnywhere(store.getState(), entry.paneID);
                if (!found || found.pane.type !== 'diff') continue;
                cancelDiff(entry);
                cancelRender(entry);
                sync(entry, found.pane, found.workspaceID);
                void runLoad(entry, found.pane).then(applied => {
                    if (applied && !disposed && entries.get(entry.paneID) === entry) emit(entry);
                }).catch((error: unknown) => report(error, `content Git provider refresh ${entry.paneID}`));
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
                cancelMarkdown(entry);
                cancelRender(entry);
                entry.listeners.clear();
            }
            entries.clear();
            editor.dispose();
        }
    };

    return service;
}
