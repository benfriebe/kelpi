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
import { PlainTextEditor } from './PlainTextEditor';
import type { ScrollStore } from './scroll';
import { useContent } from './useContent';

export interface MarkdownPaneProps {
    readonly paneID: string;
    readonly content: ContentApi;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly onToggleEdit?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
    readonly writeClipboard?: ClipboardWriter | undefined;
    readonly openLink?: LinkOpener | undefined;
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
                onChange={(text) => content.setText(paneID, text)}
                onFlush={() => void content.flush(paneID)}
                onToggleEdit={props.onToggleEdit}
                onFocusRequest={props.onFocusRequest}
                scrollStore={props.scrollStore}
            />
        );
    }

    return (
        <ContentFrame
            paneID={paneID}
            title={`markdown preview ${paneID}`}
            html={state.html ?? ''}
            assetBase={state.assetBase}
            visible={props.visible}
            onFocusRequest={props.onFocusRequest}
            onToggleEdit={props.onToggleEdit}
            scrollStore={props.scrollStore}
            writeClipboard={props.writeClipboard}
            openLink={props.openLink}
        />
    );
}
