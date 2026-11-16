/**
 * The half of a stop only a handler's context knows (docs/running-services.md §6): the pane shells
 * and terminal hosts right now, which are never signalled, and Ctrl-C to a pane that is still
 * there. Its own module so `workspace-delete` and `running-stop` share it without an import cycle.
 */

import type { AppContext, AppDeps } from '../handlers/app/context.js';
import { paneShellPids } from './context.js';
import type { StopCall } from './stop.js';

export function stopCall(ctx: AppContext, deps: Pick<AppDeps, 'panePid'>): StopCall {
    const paneShells = new Map([...paneShellPids(ctx.store.getState(), deps.panePid)].map(([pid, ref]) => [pid, ref.paneID]));
    const hosts = ctx.terminalHosts?.();
    const kelpi = new Set<number>([...(hosts?.current === null || hosts?.current === undefined ? [] : [hosts.current.pid]), ...(hosts?.old ?? []).map((host) => host.pid)]);
    return {
        protection: { paneShells, kelpi },
        interrupt: (paneID) => {
            if (!ctx.pty.has(paneID)) return false;
            try {
                ctx.input.sendNamedKey(paneID, 'ctrl-c');
                return true;
            } catch {
                return false;
            }
        }
    };
}

