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
import { contentPaneLabel } from './labels';
import { PlainTextEditor } from './PlainTextEditor';
import type { ScrollStore } from './scroll';
import { useContent } from './useContent';

export interface ScratchpadPaneProps {
    readonly paneID: string;
    readonly content: ContentApi;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    /** The pane container's fill (may carry the ghostty opacity). */
    readonly background?: string | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
}

export function ScratchpadPane(props: ScratchpadPaneProps): ReactElement {
    const { paneID, content } = props;
    const { state, error } = useContent(content, paneID);

    if (state === null) {
        /*
         * Issue #106 - no editor at all before the daemon's snapshot, which is what
         * `MarkdownPane` has always done (`MarkdownPane.tsx` ▸ `state === null`) and why the
         * markdown editor was never reachable by this bug.
         *
         * A workspace switch unmounts the pane and a return remounts it, so the text arrives one
         * round trip after the first render. While an empty textarea existed in that window it
         * could take the caret - from its own mount claim, and (the route `857f70f`'s
         * `focused={props.focused && state !== null}` did not close) from `focusPaneSurface`,
         * which queries the DOM for a textarea and knows nothing about this component's props.
         * `PlainTextEditor` then read the field as focused and refused the snapshot, leaving a
         * blank editable pane whose first keystroke overwrote the daemon's copy for every
         * client. `readOnly` guarded the keystrokes BEFORE the snapshot; it could not guard a
         * snapshot arriving into an already-focused field.
         *
         * With no textarea there is nothing to focus and nothing to type into: `useState(incoming)`
         * seeds from the real text on the first mount that has it, and the caret still lands
         * because `handCaretToPaneWhenReady` keeps asking for 1.5 s (`app/pane-focus.ts`).
         *
         * §L45's empty string rather than "Loading…", for the same reason the markdown pane
         * uses one: on a local pane this is a frame or two, and a centred placeholder reads as
         * a flash rather than as information.
         */
        return error === null ? (
            <ContentStatus paneID={paneID} text="" />
        ) : (
            <ContentStatus paneID={paneID} text={error} tone="error" />
        );
    }

    return (
        <PlainTextEditor
            paneID={paneID}
            // §L46: a scratchpad has no file behind it, so this is the kind plus a
            // four-character id — never the raw UUID a screen reader would spell out in full.
            ariaLabel={contentPaneLabel('scratchpad', paneID)}
            value={state.text ?? ''}
            isDark={state.isDark}
            focused={props.focused}
            visible={props.visible}
            background={props.background}
            onChange={(text) => content.setText(paneID, text)}
            onFlush={() => void content.flush(paneID)}
            onFocusRequest={props.onFocusRequest}
            scrollStore={props.scrollStore}
            showGutter
        />
    );
}
