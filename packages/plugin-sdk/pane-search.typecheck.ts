import type {
    PaneSearchKind,
    PaneSearchMatch,
    PaneSearchPlacement,
    PaneSearchRect,
    PaneSearchSnapshot,
    WindowPaneSearchAPI
} from './pane-search.js';

declare const ui: WindowPaneSearchAPI;
declare const snapshot: PaneSearchSnapshot;

const placement: PaneSearchPlacement = snapshot.placement;
const kind: PaneSearchKind = 'shell';
const box: PaneSearchRect = { x: 12, y: 8, width: 266, height: 35 };
const where: PaneSearchMatch = { line: null, col: 3, length: 9, linesFromBottom: 12 };
void [placement, kind, box, where];

async function present(): Promise<void> {
    const current: PaneSearchSnapshot = await ui.getPaneSearch();
    const stop = ui.onPaneSearch(
        value => {
            // `visible: false` is "present nothing"; a box is where the bar actually goes.
            if (!value.visible || value.box === null) return;
            void value.box.width;
            void value.needleTruncated;
            // The counter the native bar draws: `selected+1/total`, `-/total`, or nothing.
            void (value.total === null ? '' : value.selected === null ? `-/${value.total}` : `${value.selected + 1}/${value.total}`);
        },
        error => {
            void error.message;
        }
    );
    await ui.reportPresenterReady();
    const paneID = current.paneID;
    if (paneID !== null) {
        await ui.setSearchNeedle(paneID, 'anchor');
        await ui.setSearchCaseSensitive(paneID, true);
        await ui.searchNext(paneID);
        await ui.searchPrevious(paneID);
        // Measure what was drawn and declare it; the host clamps against the pane.
        await ui.setSearchBoxSize(paneID, { width: 320, height: 56 });
        await ui.setSearchBoxSize(paneID, null);
        await ui.closeSearch(paneID);
    }
    stop();
}
void present;

// @ts-expect-error A find bar never receives the buffer it is searching; read it with `capture`.
void snapshot.scrollback;
// @ts-expect-error One search is open at a time; a frame is about that one pane, not a list.
void snapshot.panes;
// @ts-expect-error A pane's path is not part of a find bar.
void snapshot.workingDirectory;
// @ts-expect-error The workspace id stays with the host: the calls take a pane the host re-checks.
void snapshot.workspaceID;
// @ts-expect-error Audit selectors stay host-side; a projection carries no testID.
void snapshot.testID;
// @ts-expect-error Opening a search is a host gesture; there is no presenter call for it.
void ui.openSearch('pane-1');
// @ts-expect-error The reveal belongs to the terminal renderer, not to the bar over it.
void ui.revealMatch('pane-1', 0);
// @ts-expect-error A box is two numbers, not a rectangle: the host decides where it goes.
void ui.setSearchBoxSize('pane-1', { x: 0, y: 0, width: 10, height: 10 });
// @ts-expect-error Case sensitivity is a boolean, not a mode string.
void ui.setSearchCaseSensitive('pane-1', 'sensitive');
