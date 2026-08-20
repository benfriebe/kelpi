/**
 * A markdown pane: the daemon's rendered preview, or the built-in editor (content-panes.md §3–§4).
 *
 * The pane holds no document of its own. `useContent` mirrors the daemon's snapshot — the
 * rendered HTML, the source text, the light/dark decision, the mode — and the two bodies are
 * just two views of it:
 *
 *   view   the rendered document in a sandboxed frame (`ContentFrame`), which also gives the
 *          copy button and scroll preservation across the reloads the file watcher causes
 *   edit   a plain monospace textarea over the same text; keystrokes go back as
 *          `content-set-text`, and the daemon does the debounced atomic write (§4.2)
 *
 * The mode itself is daemon state (`markdown-set-mode` flips `pane.isEditing` too), so the
 * toggle is a command like any other: the header button, ⌘E in the app, and ⌘E from inside the
 * preview all raise `onToggleEdit`, and the new mode comes back as content state. The pane
 * therefore never guesses which body to show — before the first snapshot it shows neither.
 */

import { type ReactElement } from 'react';

import type { ContentApi } from './client';
import { ContentFrame, ContentStatus } from './ContentFrame';
import type { ClipboardWriter, LinkOpener } from './bridge';
import type { RichClipboardWriter } from './copy';
import { PlainTextEditor } from './PlainTextEditor';
import type { ScrollStore } from './scroll';
import { useContent } from './useContent';

export interface MarkdownPaneProps {
    readonly paneID: string;
    readonly content: ContentApi;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    /** The pane container's fill (may carry the ghostty opacity). */
    readonly background?: string | undefined;
    /** The opaque fill painted inside the sandboxed frame (`bridge.ts` → `frameBaseStyle`). */
    readonly documentBackground?: string | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly onToggleEdit?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
    readonly writeClipboard?: ClipboardWriter | undefined;
    readonly writeRichClipboard?: RichClipboardWriter | undefined;
    readonly openLink?: LinkOpener | undefined;
    /** Bump to open the preview's find bar (the app's `toggle_search` binding, §3.13). */
    readonly findToken?: number | undefined;
    /**
     * CONT-081 — "Open in $EDITOR". Present = the affordance is drawn over the preview.
     *
     * It is a separate gesture from ⌘E rather than a hijack of it: the Swift app preferred the
     * external editor whenever one resolved, but this port ships a real built-in editor the
     * whole audit exercises, and silently swapping it for `vim` on a machine where `$EDITOR`
     * happens to be set would be a worse surprise than an extra button. Both routes end in the
     * same pane state; only the entry points differ (noted in docs/PARITY.md).
     */
    readonly onOpenExternalEditor?: ((paneID: string) => void) | undefined;
}

export function MarkdownPane(props: MarkdownPaneProps): ReactElement {
    const { paneID, content } = props;
    const { state, error } = useContent(content, paneID);

    if (state === null) {
        return error === null ? (
            <ContentStatus paneID={paneID} text="Loading…" />
        ) : (
            <ContentStatus paneID={paneID} text={error} tone="error" />
        );
    }

    if (state.mode === 'edit') {
        return (
            <PlainTextEditor
                paneID={paneID}
                ariaLabel={`markdown editor ${paneID}`}
                value={state.text ?? ''}
                isDark={state.isDark}
                focused={props.focused}
                visible={props.visible}
                background={props.background}
                onChange={(text) => content.setText(paneID, text)}
                onFlush={() => void content.flush(paneID)}
                onToggleEdit={props.onToggleEdit}
                onFocusRequest={props.onFocusRequest}
                scrollStore={props.scrollStore}
                showGutter
            />
        );
    }

    const frame = (
        <ContentFrame
            paneID={paneID}
            title={`markdown preview ${paneID}`}
            html={state.html ?? ''}
            assetBase={state.assetBase}
            visible={props.visible}
            background={props.background}
            documentBackground={props.documentBackground}
            isDark={state.isDark}
            onFocusRequest={props.onFocusRequest}
            onToggleEdit={props.onToggleEdit}
            scrollStore={props.scrollStore}
            writeClipboard={props.writeClipboard}
            writeRichClipboard={props.writeRichClipboard}
            openLink={props.openLink}
            findToken={props.findToken}
            // §3.14: both copy commands bail on a failed load — you cannot copy the synthetic
            // "Failed to load file" blockquote, so the affordance is simply absent.
            copySource={state.loaded ? state.text : null}
        />
    );

    if (props.onOpenExternalEditor === undefined) return frame;
    return (
        <div className="relative h-full w-full">
            {frame}
            <button
                type="button"
                data-testid={`open-external-editor-${paneID}`}
                aria-label="Open in $EDITOR"
                title="Open this file in your $VISUAL / $EDITOR, hosted in this pane"
                className="absolute right-2 bottom-2 z-10 rounded text-[11px]"
                style={{
                    padding: '3px 8px',
                    // Inline, like the terminal retry chip: `styles.css` resets `button` outside
                    // any cascade layer, so an unlayered `padding: 0` would beat Tailwind's.
                    border: '1px solid var(--nex-border, #24242B)',
                    color: 'var(--nex-fg-secondary, #9A9AA0)',
                    backgroundColor: 'var(--nex-header-bg, #13131A)'
                }}
                onClick={() => props.onOpenExternalEditor?.(paneID)}
            >
                $EDITOR
            </button>
        </div>
    );
}
