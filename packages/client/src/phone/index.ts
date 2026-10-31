/**
 * The phone shell (docs/MOBILE-PLAN.md lane B, plus the owner's multi-host and layout-toggle
 * requests of 2026-09-08). Everything here is gated on `chrome/form-factor.ts`; a desktop never
 * mounts any of it.
 *
 *   `view.ts`                  the screen (Home / one pane / full layout) and the remote selection
 *   `place.ts`                 where the phone was when it was last put down
 *   `hosts.ts`                 the phone's own host list, remembered on the phone
 *   `model.ts`                 one shape for every host the shell can show
 *   `PhoneShell.tsx`           the assembly's phone branch
 *   `fleet.ts`                 every host's connection and workspaces, read as one value
 *   `attention.ts`             what waits for the person, across every host
 *   `PhoneHome.tsx`            Home: Needs you, the host pager, the host's workspaces
 *   `PhoneLocationBar.tsx`     the breadcrumb bar at the bottom: host › workspace › pane
 *   `PhonePicker.tsx`          the card above the bar: hosts, workspaces, panes, New pane
 *   `PhonePaneChrome.tsx`      the pane's header and the strip under it (pager, attention pill)
 *   `PhoneNeedsYouSheet.tsx`   everything waiting, grouped by host
 *   `PhoneJumpSheet.tsx`       find a workspace or pane on any host by name
 *   `new-pane.ts`              the kinds of pane the picker can open, and how
 *   `keyboard.ts`              whether the software keyboard is up, for the bar to step aside
 *   `PhoneRemoteWorkspace.tsx` a remote host's workspace, one pane or the grid
 *   `PhoneWebCard.tsx`         a web pane on a phone (MOBILE-PLAN.md §9)
 *   `PhoneQrScanSheet.tsx`     Add host's camera, reading the pairing code the Mac draws
 *   `qr-camera.ts`             the camera and the QR reader behind it
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
    type PhoneScreen,
    type PhoneView,
    type PhoneViewMode,
    type PhoneVisibleInput,
    type UsePhoneViewOptions
} from './view';

export {
    PHONE_PLACE_KEY,
    isPhonePlace,
    readStoredPlace,
    writeStoredPlace,
    type PhonePlace
} from './place';

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

export { noteWaiting, phoneAttention, resetWaitingClock, waitedFor, type PhoneAttention, type PhoneAttentionItem } from './attention';
export { usePhoneFleet, type PhoneHostReading } from './fleet';
export { PHONE_NEW_PANE_OPTIONS, openPhonePane, type PhoneNewPaneKind } from './new-pane';
export { PhoneRemoteWorkspace, remoteShownPane, type PhoneRemoteWorkspaceProps } from './PhoneRemoteWorkspace';
export { PhoneWebCard, phoneWebCardTab, type PhoneWebCardProps, type PhoneWebCardTab } from './PhoneWebCard';
export { PhoneHostSheet, type PhoneHostSheetProps } from './PhoneHostSheet';
export { NOT_A_PAIRING_CODE, PhoneQrScanSheet, type PhoneQrScanSheetProps } from './PhoneQrScanSheet';
export {
    QR_CAMERA_MESSAGES,
    QrCameraError,
    defaultQrCamera,
    qrCameraError,
    type QrCamera,
    type QrCameraErrorKind
} from './qr-camera';
export { PhoneMenuSheet, type PhoneMenuItem, type PhoneMenuSheetProps } from './PhoneMenuSheet';
export { PhonePromptSheet, type PhonePromptSheetProps } from './PhonePromptSheet';
export { PHONE_ROW_MIN_PX, PHONE_SAFE_AREA, PhoneButton, PhoneRow, PhoneSheet, PhoneSheetHeader, statusDotColor } from './ui';

export { FAKE_PHONE_VIEWPORT, createFakePhoneWindow, type FakePhoneWindow, type FakePhoneWindowInit } from './testing';
