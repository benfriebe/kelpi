/**
 * A scratchpad pane: an editor with no file behind it (content-panes.md §7).
 *
 * Same body as markdown edit mode, three differences that come from having no file: it is
 * always editing (no preview, no ⌘E), the daemon's "save" writes the text onto the pane record
 * rather than to disk (so it rides the DB's own debounce and comes back after a restart), and
 * there is no watcher to suspend.
 *
 * The client debounce (`ContentClient`, 300 ms) matters more here than for markdown: §7 notes
 * the Swift app could lose up to a second of typing to the two stacked debounces on a hard
 * kill, so the buffer is also flushed on blur and on unmount.
 */

import { type ReactElement } from 'react';

import type { ContentApi } from './client';
import { ContentStatus } from './ContentFrame';
import { PlainTextEditor } from './PlainTextEditor';
import type { ScrollStore } from './scroll';
import { useContent } from './useContent';

export interface ScratchpadPaneProps {
    readonly paneID: string;
    readonly content: ContentApi;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
}

export function ScratchpadPane(props: ScratchpadPaneProps): ReactElement {
    const { paneID, content } = props;
    const { state, error } = useContent(content, paneID);

    if (state === null && error !== null) {
        return <ContentStatus paneID={paneID} text={error} tone="error" />;
    }

    return (
        <PlainTextEditor
            paneID={paneID}
            ariaLabel={`scratchpad ${paneID}`}
            value={state?.text ?? ''}
            isDark={state?.isDark ?? true}
            focused={props.focused}
            visible={props.visible}
            // Read-only until the first snapshot: a keystroke into the empty pre-load buffer
            // would go out as a `content-set-text` that wipes the restored scratchpad.
            readOnly={state === null}
            onChange={(text) => content.setText(paneID, text)}
            onFlush={() => void content.flush(paneID)}
            onFocusRequest={props.onFocusRequest}
            scrollStore={props.scrollStore}
        />
    );
}
