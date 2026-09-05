/**
 * M5 — content panes (markdown / diff / scratchpad), client half.
 *
 * Spec: docs/content-panes.md. The daemon owns the file, the watcher, git, the
 * markdown/diff → HTML transformation and the authoritative edit buffer (port note 1); this
 * package owns what only a client can: the sandboxed viewport, scroll position, the copy
 * button's clipboard hop, the caret, and the subscription lifecycle that keeps the daemon from
 * watching files nobody is looking at.
 *
 *   `client.ts`           — subscription multiplexer + typing debounce over the WS content verbs
 *   `useContent.ts`       — one pane's subscription as a hook
 *   `ContentFrame.tsx`    — the `allow-scripts`-only sandboxed iframe (+ its scroll restore)
 *   `PlainTextEditor.tsx` — the shared monospace editor (markdown edit mode, scratchpads)
 *   `MarkdownPane.tsx` / `DiffPane.tsx` / `ScratchpadPane.tsx` — the three pane bodies
 *   `bridge.ts`           — the script injected into the frame and the host side of its messages
 *   `scroll.ts`           — the per-pane-id scroll store shared by every view (§9)
 */

export {
    CONTENT_FONT_SIZE_DEFAULT,
    CONTENT_FONT_SIZE_MAX,
    CONTENT_FONT_SIZE_MIN,
    CONTENT_TEXT_DEBOUNCE_MS,
    createContentClient,
    nextFontSize,
    type ContentApi,
    type ContentClient,
    type ContentClientOptions,
    type ContentListener,
    type ContentSubscription,
    type FontSizeStep
} from './client';

export {
    stripFrontMatter,
    writeRichText,
    type RichClipboardWriter,
    type RichTextPayload
} from './copy';

export { useContent, type UseContentResult } from './useContent';

export {
    CONTENT_PANE_BACKGROUND,
    ContentFrame,
    ContentStatus,
    type ContentFrameProps,
    type ContentStatusProps
} from './ContentFrame';

export {
    EDITOR_FONT_SIZE,
    GUTTER_FONT_SIZE,
    GUTTER_MIN_WIDTH,
    GUTTER_PADDING,
    GUTTER_TEXT_PADDING,
    PlainTextEditor,
    gutterWidth,
    lineCount,
    type PlainTextEditorProps
} from './PlainTextEditor';

export { MarkdownPane, type MarkdownPaneProps } from './MarkdownPane';
export { DiffPane, type DiffPaneProps } from './DiffPane';
export { ScratchpadPane, type ScratchpadPaneProps } from './ScratchpadPane';

export {
    CONTENT_BRIDGE_SOURCE,
    CONTENT_HOST_SOURCE,
    COPY_FEEDBACK_MS,
    DEFAULT_FIND_PALETTE,
    FIND_CURRENT_COLOR,
    FIND_CURRENT_TEXT_COLOR,
    FIND_MATCH_COLOR,
    FIND_MATCH_TEXT_COLOR,
    chordKey,
    chordKeysForBindings,
    chordKeysForTrigger,
    contentBridgeScript,
    replayFrameChord,
    resolveFindPalette,
    openExternalLink,
    parseBridgeMessage,
    prepareContentDocument,
    writeClipboardText,
    type ClipboardWriter,
    type ContentBridgeMessage,
    type ContentChordEvent,
    type ContentHostMessage,
    type FindOp,
    type FindPalette,
    type FindResult,
    type LinkOpener,
    type PrepareDocumentOptions
} from './bridge';

export { contentScrollStore, createScrollStore, type ScrollPosition, type ScrollStore } from './scroll';

export {
    CONTENT_UPDATED_MESSAGE,
    editorTextColor,
    parseContentState,
    type ContentMode,
    type ContentPaneState,
    type ContentPaneType
} from './types';
