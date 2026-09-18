import type {
    PaneChromeControl,
    PaneChromeItem,
    PaneChromePane,
    PaneChromePlacement,
    PaneChromeSnapshot,
    WindowPaneChromeAPI
} from './pane-chrome.js';

declare const ui: WindowPaneChromeAPI;
declare const snapshot: PaneChromeSnapshot;

const placement: PaneChromePlacement = snapshot.placement;
const control: PaneChromeControl = {
    key: 'split-right',
    kind: 'action',
    label: 'Split right (⌘D)',
    icon: 'split-right',
    enabled: true,
    pinned: false
};
const item: PaneChromeItem = {
    id: 'example.board.status',
    text: 'Ready',
    tooltip: null,
    badge: '3',
    tone: 'success',
    enabled: true
};
void [placement, control, item];

async function present(): Promise<void> {
    const current: PaneChromeSnapshot = await ui.getPaneChrome();
    const stop = ui.onPaneChrome(
        value => {
            void value.withheld;
        },
        error => {
            void error.message;
        }
    );
    await ui.reportPresenterReady();
    // One band for every pane this presenter draws; the host clamps each against its own pane.
    for (const pane of current.panes) await ui.setPaneChromeHeight(pane.paneID, 48);
    const pane: PaneChromePane | undefined = current.panes[0];
    if (pane !== undefined) {
        await ui.focusPane(pane.paneID);
        await ui.splitPane(pane.paneID, 'vertical');
        if (pane.zoom.available) await ui.toggleZoom(pane.paneID);
        // The host draws the field and the confirmation; the presenter only asks.
        if (!pane.renaming) await ui.renamePane(pane.paneID);
        for (const entry of pane.controls) if (entry.enabled && !entry.pinned) void entry.key;
        for (const other of pane.items) if (other.enabled) await ui.runPaneHeaderItem(pane.paneID, other.id);
        await ui.openPaneMenu(pane.paneID);
        await ui.closePane(pane.paneID);
    }
    stop();
}
void present;

// @ts-expect-error A control carries no write target: the presenter sends a key, the host owns the verb.
void snapshot.panes[0]?.controls[0]?.command;
// @ts-expect-error Audit selectors stay host-side; a projection carries no testID.
void snapshot.panes[0]?.controls[0]?.testID;
// @ts-expect-error An item is a display name and an opaque ref, never a plugin identity.
void snapshot.panes[0]?.items[0]?.pluginID;
// @ts-expect-error A pane's absolute path never leaves the host; `directory` is home-abbreviated.
void snapshot.panes[0]?.workingDirectory;
// @ts-expect-error An agent is a kind and a clock, never a session handle.
void snapshot.panes[0]?.agent?.agentSessionID;
// @ts-expect-error A web pane's page URL is not pane chrome.
void snapshot.panes[0]?.url;
// @ts-expect-error The rename field is the host's: a presenter asks for it, it does not send a name.
void ui.renamePane('pane-1', 'api');
