/**
 * Web panes, client half.
 *
 * A web pane is the one pane type whose content this client cannot draw: the page lives in a
 * native browser view the Electron shell owns. What lives here is everything around it —
 *
 *   `WebPane.tsx`       the chrome (URL bar, tab strip, nav buttons) + the page-area hole
 *   `WebFindBar.tsx`    ⌘F over a page the host owns (§10)
 *   `BatchPanel.tsx`    the batch "element pickup" session's panel (§12)
 *   `StoragePanel.tsx`  cookies, local storage and the private-session toggle (§13)
 *   `FavouritesMenu.tsx` the URL-bar star and the bookmarks menu (§14)
 *   `priority.ts`       the ⌘L/⌘R/⌘←/⌘→/⌘T/⌘W/⌘⇧[]/⌘=-0 layer that runs before the keymap
 *   `state.ts`          read models for favourites + batch sessions, and their matching rules
 *   `hooks.ts`          the two broadcast subscriptions those read models need
 *   `geometry.ts`       the throttled "here is where the hole is" reporter
 *   `commands.ts`       the chrome's verbs (`web-navigate`, `web-tab-*`, `web-devtools`, …)
 *   `shell-window.ts`   am-I-inside-a-shell-window, which decides pixels vs placeholder
 *   `reveal.ts`         the client end of a clicked desktop notification (§8.5)
 *
 * Assembly (`App.tsx`) wires them: one reporter for the whole client, one command set, and a
 * `WebPane` per web pane in the grid.
 */

export {
    createWebPaneCommands,
    type WebCookieWrite,
    type WebCommandSender,
    type WebFindOp,
    type WebPaneCommands,
    type WebZoomDirection
} from './commands';

export { BatchPanel, BATCH_EMPTY_HINT, type BatchPanelProps } from './BatchPanel';

export { FavouritesMenu, type FavouritesMenuProps } from './FavouritesMenu';

export {
    StoragePanel,
    canonicalDomain,
    defaultExpiryInput,
    groupCookies,
    privateModeWarning,
    type CookieGroup,
    type StoragePanelProps,
    type WebCookie
} from './StoragePanel';

export { WebFindBar, findCountLabel, type WebFindBarProps } from './WebFindBar';

export {
    WEB_CHORD_COMMAND_PREFIX,
    WEB_CHROME_TEXT_ATTRIBUTE,
    chromeTextIsFocused,
    createWebPanePriority,
    parseChordCommand,
    replayChordCommand,
    type FocusedWebPane,
    type WebPanePriority,
    type WebPanePriorityDeps
} from './priority';

export {
    batchDestinations,
    favouriteMatching,
    normalizeFavouriteURL,
    parseBatchMessage,
    parseBatchSession,
    parseFavourites,
    parseFavouritesMessage,
    parseNavStateMessage,
    seededDestination,
    truncateMiddle,
    type BatchDestination,
    type DestinationCandidate,
    type WebBatchItem,
    type WebBatchSession,
    type WebFavourite,
    type WebNavState
} from './state';

export {
    navStateKey,
    replyBatch,
    useBlankWebPaneURLFocus,
    useWebPaneUI,
    type BlankURLTarget,
    type WebPaneUIState,
    type WebUIConnection
} from './hooks';

export {
    DEFAULT_PROGRESS_TIMINGS,
    useLoadProgress,
    type LoadProgressPhase,
    type LoadProgressTimings,
    type LoadProgressView
} from './progress';

export { orderChanged, reorderedTabs, tabUnderPointer, type PillBox } from './reorder';

export {
    DEFAULT_GEOMETRY_THROTTLE_MS,
    createGeometryReporter,
    type GeometryRect,
    type GeometryReport,
    type GeometryReporter,
    type GeometryReporterOptions
} from './geometry';

export {
    REVEAL_PANE_MESSAGE,
    parseRevealMessage,
    revealAppliesHere,
    type RevealTarget
} from './reveal';

export {
    SHELL_WINDOW_PARAM,
    TRAFFIC_LIGHT_INSET_PARAM,
    WINDOW_TRANSPARENT_PARAM,
    readShellWindowID,
    readTrafficLightInset,
    readWindowTransparent
} from './shell-window';

export { WebPane, resolveActiveTab, tabLabel, type WebPaneProps, type WebPaneTab } from './WebPane';
