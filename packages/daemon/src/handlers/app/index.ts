/**
 * WP2.5b — the app-level command handler family.
 *
 * Covers everything in socket-handlers.md that is not a `pane-*` command: workspace + group
 * lifecycle, layout selection, file/diff opening, the agent lifecycle events, `ping`, and
 * honest stubs for the graft / web-pane verbs.
 *
 * Boot composes the table:
 *
 * ```ts
 * const app = createAppHandlers({ persist, spawnPane, isAppActive });
 * const dispatcher: ControlDispatcher = (msg, reply) => {
 *   (app.get(msg.command) ?? paneHandlers.get(msg.command))?.(msg, ctx, reply);
 * };
 * ```
 */

import { eventHandlerEntries } from './events.js';
import { fileHandlerEntries } from './files.js';
import { groupHandlerEntries } from './groups.js';
import { layoutHandlerEntries } from './layout.js';
import { pingHandlerEntries } from './ping.js';
import { stubHandlerEntries } from './stubs.js';
import { workspaceHandlerEntries } from './workspaces.js';
import {
    handlerTable,
    resolveAppDeps,
    type AppHandlerOptions,
    type AppHandlerTable
} from './context.js';

export function createAppHandlers(options: AppHandlerOptions = {}): AppHandlerTable {
    const deps = resolveAppDeps(options);
    return handlerTable([
        ...workspaceHandlerEntries(deps),
        ...groupHandlerEntries(deps),
        ...layoutHandlerEntries(deps),
        ...fileHandlerEntries(deps),
        ...eventHandlerEntries(deps),
        ...pingHandlerEntries(),
        ...stubHandlerEntries()
    ]);
}

export { fail, handlerTable, ok, resolveAppDeps } from './context.js';
export type {
    AppContext,
    AppDeps,
    AppHandler,
    AppHandlerOptions,
    AppHandlerTable,
    SpawnPaneRequest
} from './context.js';
export { forCommand, listedGroupIDs, listedWorkspaceIDs, uuidOut, wireTimestamp } from './common.js';
export { applyAgentEvent, ATTENTION_EVENT, notificationDedupeKey } from './events.js';
export { NOT_SUPPORTED_ERROR, STUBBED_COMMANDS } from './stubs.js';
export { eventHandlerEntries } from './events.js';
export { fileHandlerEntries } from './files.js';
export { groupHandlerEntries } from './groups.js';
export { layoutHandlerEntries } from './layout.js';
export { pingHandlerEntries } from './ping.js';
export { stubHandlerEntries } from './stubs.js';
export { workspaceHandlerEntries } from './workspaces.js';
