/**
 * The phone shell (docs/MOBILE-PLAN.md lane B, plus the owner's multi-host and layout-toggle
 * requests of 2026-09-08). Everything here is gated on `chrome/form-factor.ts`; a desktop never
 * mounts any of it.
 *
 *   `view.ts`                  the view mode (one pane / full layout) and the remote selection
 *   `hosts.ts`                 the phone's own host list, remembered on the phone
 *   `model.ts`                 one shape for every host the shell can show
 *   `PhoneShell.tsx`           the assembly's phone branch
 *   `PhoneWorkspaceDrawer.tsx` hosts and their workspaces
 *   `PhonePaneSheet.tsx`       the current workspace's panes
 *   `PhoneRemoteWorkspace.tsx` a remote host's workspace, one pane or the grid
 *   `ui.tsx`                   the sheet, the thumb button, the safe-area insets
 *   `testing.ts`               a fake phone window for jsdom
 */

export {
    DEFAULT_PHONE_VIEW_MODE,
    PHONE_VIEW_MODE_KEY,
    isPhoneViewMode,
    phoneVisiblePaneIDs,
    readStoredViewMode,
    resolveShownPane,
    usePhoneView,
    writeStoredViewMode,
    type PhoneRemoteSelection,
    type PhoneView,
    type PhoneViewMode,
    type PhoneVisibleInput,
    type UsePhoneViewOptions
} from './view';

export {
    PHONE_HOSTS_KEY,
    originHostName,
    parsePairingURL,
    readStoredHosts,
    suggestedHostName,
    usePhoneHosts,
    writeStoredHosts,
    type PairingURLParse,
    type PhoneHostEntry,
    type PhoneHosts
} from './hosts';

export { ORIGIN_HOST_KEY, type PhoneHostKind, type PhoneHostModel, type PhoneWorkspaceSelection } from './model';

export {
    PhoneShell,
    type PhoneGridProps,
    type PhoneShellActions,
    type PhoneShellProps
} from './PhoneShell';

export {
    PHONE_SHEET_HISTORY_STATE,
    defaultSheetHistory,
    isSheetHistoryState,
    useSheetHistory,
    type SheetHistory,
    type SheetHistoryLike
} from './sheet-history';

export { PhoneRemoteWorkspace, remoteShownPane, type PhoneRemoteWorkspaceProps } from './PhoneRemoteWorkspace';
export { PhoneWorkspaceDrawer, connectionDotColor, type PhoneWorkspaceDrawerProps } from './PhoneWorkspaceDrawer';
export { PhonePaneSheet, paneGlyph, type PhonePaneSheetProps } from './PhonePaneSheet';
export { PhoneHostSheet, type PhoneHostSheetProps } from './PhoneHostSheet';
export { PhoneMenuSheet, type PhoneMenuItem, type PhoneMenuSheetProps } from './PhoneMenuSheet';
export { PhonePromptSheet, type PhonePromptSheetProps } from './PhonePromptSheet';
export { PHONE_ROW_MIN_PX, PHONE_SAFE_AREA, PhoneButton, PhoneRow, PhoneSheet, PhoneSheetHeader, statusDotColor } from './ui';

export { FAKE_PHONE_VIEWPORT, createFakePhoneWindow, type FakePhoneWindow, type FakePhoneWindowInit } from './testing';
