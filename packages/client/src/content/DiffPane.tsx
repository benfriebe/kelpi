/**
 * A diff pane: `git diff` rendered by the daemon, shown read-only (content-panes.md §5).
 *
 * There is no watcher behind a diff — refresh is event-driven (§5.2), and of the doc's four
 * triggers three live here or above:
 *
 *   1. `repoPath` / `targetPath` change — the daemon re-runs git itself when the pane's fields
 *      move under the subscription, so the client sees it as a `content-updated`;
 *   2. the header refresh button — assembly wires it straight to `content.refresh(paneID)`;
 *   3. **unfocused → focused** — this component's job: come back to a diff pane and it is
 *      current. A re-render while already focused is not a transition and must not re-run git.
 *
 * (4, the webview's own ⌘R reload gesture, has no equivalent: the sandboxed frame has no
 * reload affordance to remap.)
 */

import { useEffect, useRef, type ReactElement } from 'react';

import type { ContentApi } from './client';
import { ContentFrame, ContentStatus } from './ContentFrame';
import type { ClipboardWriter, LinkOpener } from './bridge';
import type { ScrollStore } from './scroll';
import { useContent } from './useContent';

export interface DiffPaneProps {
    readonly paneID: string;
    readonly content: ContentApi;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
    readonly writeClipboard?: ClipboardWriter | undefined;
    readonly openLink?: LinkOpener | undefined;
}

export function DiffPane(props: DiffPaneProps): ReactElement {
    const { paneID, content } = props;
    const { state, error } = useContent(content, paneID);

    const focused = props.focused === true;
    // Seeded with the mount-time value: the subscribe reply is already a fresh git run, so a
    // pane that mounts focused must not immediately run a second one.
    const wasFocused = useRef(focused);
    useEffect(() => {
        if (focused && !wasFocused.current) void content.refresh(paneID);
        wasFocused.current = focused;
    }, [focused, content, paneID]);

    if (state === null) {
        return error === null ? (
            <ContentStatus paneID={paneID} text="Running git diff…" />
        ) : (
            <ContentStatus paneID={paneID} text={error} tone="error" />
        );
    }

    return (
        <ContentFrame
            paneID={paneID}
            title={`diff ${paneID}`}
            html={state.html ?? ''}
            visible={props.visible}
            onFocusRequest={props.onFocusRequest}
            scrollStore={props.scrollStore}
            writeClipboard={props.writeClipboard}
            openLink={props.openLink}
        />
    );
}
