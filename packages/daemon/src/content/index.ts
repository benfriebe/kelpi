/**
 * M5 — content panes (markdown / diff / scratchpad), daemon half.
 *
 * Spec: docs/current/content-panes.md. The daemon owns file reading, file watching, git
 * invocation, the markdown/diff → HTML transformation (to the doc's exact HTML/CSS contract)
 * and the authoritative edit buffer; clients own scroll state, find-in-page, the copy-button JS
 * and the clipboard (port note 1).
 *
 * Wiring: `boot/compose.ts` creates the service, `ws/sync.ts` exposes the `content-*` verbs and
 * fans `content-updated` out to subscribed clients only, and `ws/http.ts` serves
 * `/pane-assets/<paneID>/<relpath>` so relative `<img src>` in a markdown file resolves.
 */

export {
    DEFAULT_CONTENT_BACKGROUND,
    DEFAULT_CONTENT_BACKGROUND_OPACITY,
    escapeHtml,
    htmlDocument,
    isDarkBackground,
    parseHexColor,
    perceivedLuminance,
    type ContentAppearance,
    type HtmlDocumentOptions,
    type Rgb
} from './html.js';

export {
    DEFAULT_MARKDOWN_FONT_SIZE,
    FRONT_MATTER_BYTE_LIMIT,
    autolinkText,
    extractFrontMatter,
    fileLoadErrorMarkdown,
    markdownStylesheet,
    renderFrontMatter,
    renderMarkdownBody,
    renderMarkdownDocument,
    type FrontMatterSplit,
    type MarkdownRenderOptions
} from './markdown.js';

export {
    DEFAULT_DIFF_FONT_SIZE,
    EMPTY_DIFF_HTML,
    chunkDiff,
    classifyDiffLine,
    describeChunk,
    diffStylesheet,
    displayPath,
    gitFailureText,
    renderDiffBody,
    renderDiffDocument,
    type DiffChunk,
    type DiffFileInfo,
    type DiffFileStatus,
    type DiffLineClass,
    type DiffRenderOptions
} from './diff.js';

export {
    RENAME_REATTACH_DELAY_MS,
    watchFile,
    type FileWatcher,
    type WatchFileOptions,
    type WatchFn,
    type WatchHandle
} from './watcher.js';

export {
    EDITOR_AUTOSAVE_DEBOUNCE_MS,
    createEditorBuffers,
    writeFileAtomic,
    type EditorBuffers,
    type EditorOptions,
    type EditorTarget
} from './editor.js';

export {
    PANE_ASSETS_PREFIX,
    createContentService,
    type ContentGit,
    type ContentListener,
    type ContentMode,
    type ContentPaneState,
    type ContentPaneType,
    type ContentService,
    type ContentServiceOptions,
    type ContentSubscription
} from './service.js';

export {
    EDITOR_BEGIN_MARKER,
    EDITOR_END_MARKER,
    FAILURE_RETRY_MS,
    SHELL_TIMEOUT_MS,
    chooseEditor,
    createEditorResolver,
    editorProbeScript,
    formatEditorCommand,
    parseShellOutput,
    probeLoginShell,
    resolveFromProcessEnv,
    resolveUserShell,
    singleQuoteEscape,
    type EditorResolution,
    type EditorResolver,
    type EditorResolverOptions
} from './external-editor.js';
