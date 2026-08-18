/**
 * `layout-cycle` / `layout-select` (socket-handlers.md §8.3–§8.4). Both fire-and-forget.
 *
 * Focus-dependent by design: the target workspace is the one holding the CALLER's pane
 * (visible panes only), and the predefined rebuild puts that workspace's focused pane in the
 * "main" slot — which is why `layout select main-*` reads as "enlarge the focused pane" and
 * `pane resize` exists as the focus-independent alternative.
 */

import { isPredefinedLayoutKind } from '@nex/core/layout';

import { workspaceContainingVisiblePane } from '../../store/index.js';
import { forCommand } from './common.js';
import type { AppContext, AppDeps, AppHandler } from './context.js';

function workspaceForPane(ctx: AppContext, paneID: string): string | null {
    return workspaceContainingVisiblePane(ctx.store.getState(), paneID)?.id ?? null;
}

export function layoutHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('layout-cycle', (msg, ctx) => {
            const workspaceID = workspaceForPane(ctx, msg.pane_id);
            if (workspaceID === null) return;
            ctx.store.dispatch({ type: 'cycle-layout', workspaceID });
            deps.persist();
        }),
        forCommand('layout-select', (msg, ctx) => {
            const workspaceID = workspaceForPane(ctx, msg.pane_id);
            if (workspaceID === null) return;
            // An unknown layout name is silently dropped (never an error reply — F&F).
            if (!isPredefinedLayoutKind(msg.name)) return;
            ctx.store.dispatch({ type: 'select-layout', workspaceID, kind: msg.name });
            deps.persist();
        })
    ];
}
