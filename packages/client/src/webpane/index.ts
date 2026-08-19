/**
 * Web panes, client half.
 *
 * A web pane is the one pane type whose content this client cannot draw: the page lives in a
 * native browser view the Electron shell owns. What lives here is everything around it —
 *
 *   `WebPane.tsx`     the chrome (URL bar, tab strip, nav buttons) + the page-area hole
 *   `geometry.ts`     the throttled "here is where the hole is" reporter
 *   `commands.ts`     the chrome's verbs (`web-navigate`, `web-tab-*`, `web-devtools`)
 *   `shell-window.ts` am-I-inside-a-shell-window, which decides pixels vs placeholder
 *   `reveal.ts`       the client end of a clicked desktop notification (§8.5)
 *
 * Assembly (`App.tsx`) wires them: one reporter for the whole client, one command set, and a
 * `WebPane` per web pane in the grid.
 */

export {
    createWebPaneCommands,
    type WebCommandSender,
    type WebPaneCommands
} from './commands';

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

export { SHELL_WINDOW_PARAM, readShellWindowID } from './shell-window';

export { WebPane, resolveActiveTab, tabLabel, type WebPaneProps, type WebPaneTab } from './WebPane';
