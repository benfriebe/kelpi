/**
 * `running-list` (wire-protocol.md §6.11, docs/running-services.md): the services running on
 * this host, scanned on demand. Request/response, never refused for a probe that could not run:
 * the reply's `warnings` say which. `running-stop` (§6.11.1, running-services.md §6) stops them.
 *
 * Without `workspace` or `scope: 'current'` it lists every service that belongs to a workspace
 * or to a worktree no workspace owns; `all` adds the ones started outside Kelpi and agents' own
 * local ports. A workspace filter lists only that workspace's services.
 */

import { resolveWorkspaceStrict } from '@kelpi/core/resolve';
import type { RunningServiceEntry, RunningServicePort, RunningStopMessage, RunningStopResult } from '@kelpi/protocol';

import type { ReplyHandle } from '../seams.js';
import { resolveStateOf, workspaceByID, type WorkspaceState } from '../store/index.js';
import { forCommand, uuidOut, wireTimestamp } from '../handlers/app/common.js';
import { fail, ok, type AppContext, type AppDeps, type AppHandler } from '../handlers/app/context.js';
import { unresolvedWorkspaceError } from '../handlers/app/workspaces.js';
import type { StopResult } from './stop.js';
import { stopCall } from './stop-call.js';
import type { RunningService, RunningServiceCategory, ServicePort } from './types.js';

/** What `kelpi ps` lists unless asked for all. */
const DEFAULT_CATEGORIES: ReadonlySet<RunningServiceCategory> = new Set(['workspace', 'unattached']);

function wirePort(port: ServicePort): RunningServicePort {
    return {
        port: port.port,
        address: port.address,
        exposed: port.exposed,
        pid: port.pid,
        container_port: port.containerPort
    };
}

function idOrNull(id: string | null): string | null {
    return id === null ? null : uuidOut(id);
}

/** CPU on the wire: tenths of a percent, so it reads as a figure rather than noise. */
export function wireCpu(percent: number | null): number | null {
    return percent === null ? null : Math.round(percent * 10) / 10;
}

export function toWireService(service: RunningService): RunningServiceEntry {
    return {
        id: service.id,
        kind: service.kind,
        name: service.name,
        command: service.command,
        category: service.category,
        workspace_id: idOrNull(service.workspaceID),
        workspace_name: service.workspaceName,
        pane_id: idOrNull(service.paneID),
        attribution: service.attribution,
        started_by: service.startedBy,
        agent: service.agent,
        foreground: service.foreground,
        directory: service.directory,
        directory_workspace_id: idOrNull(service.directoryWorkspaceID),
        directory_workspace_name: service.directoryWorkspaceName,
        directory_missing: service.directoryMissing,
        worktree: service.worktree,
        started_at: service.startedAt === null ? null : wireTimestamp(service.startedAt),
        pid: service.pid,
        process_count: service.processCount,
        rss_bytes: service.rssBytes,
        cpu_percent: wireCpu(service.cpuPercent),
        ports: service.ports.map(wirePort),
        members: service.members.map((member) => ({
            name: member.name,
            pid: member.pid,
            container_id: member.containerID,
            image: member.image,
            ports: member.ports.map(wirePort),
            rss_bytes: member.rssBytes
        }))
    };
}

/** Which workspace a request narrows to: `undefined` for none, or the refusal to send. */
function targetWorkspace(
    msg: { readonly pane_id?: string | undefined; readonly workspace?: string | undefined; readonly scope?: string | undefined },
    ctx: AppContext
): { readonly workspace: WorkspaceState | undefined } | { readonly error: string } {
    const state = ctx.store.getState();
    if (msg.scope !== undefined && msg.scope !== 'current') return { error: `unknown scope: ${msg.scope}` };
    if (msg.scope === 'current') {
        if (msg.workspace !== undefined) return { error: 'workspace and --current are mutually exclusive' };
        // Either lane: an agent in a parked pane still asks about its own workspace, and the
        // scanner attributes parked panes' processes too.
        const paneID = msg.pane_id;
        const workspace =
            paneID === undefined
                ? null
                : (state.workspaces.find(
                      (candidate) =>
                          candidate.panes.some((pane) => pane.id === paneID) ||
                          candidate.parkedPanes.some((pane) => pane.id === paneID)
                  ) ?? null);
        return workspace === null ? { error: 'no workspace contains the requesting pane' } : { workspace };
    }
    if (msg.workspace === undefined) return { workspace: undefined };
    const scope = resolveStateOf(state);
    const resolved = resolveWorkspaceStrict(scope, msg.workspace);
    const workspace = resolved === null ? null : workspaceByID(state, resolved.id);
    return workspace === null ? { error: unresolvedWorkspaceError(scope, msg.workspace) } : { workspace };
}

function handleRunningList(
    msg: { readonly pane_id?: string | undefined; readonly workspace?: string | undefined; readonly scope?: string | undefined; readonly all: boolean },
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const target = targetWorkspace(msg, ctx);
    if ('error' in target) {
        fail(reply, target.error);
        return;
    }
    void (async () => {
        try {
            const scan = await deps.running.scan();
            const workspaceID = target.workspace?.id;
            const services = scan.services.filter((service) =>
                workspaceID !== undefined
                    ? service.workspaceID === workspaceID
                    : msg.all || DEFAULT_CATEGORIES.has(service.category)
            );
            ok(reply, {
                services: services.map(toWireService),
                scanned_at: wireTimestamp(scan.scannedAt / 1000),
                warnings: scan.warnings
            });
        } catch (error) {
            fail(reply, `running-list failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    })();
}

export function wireStopResult(result: StopResult): RunningStopResult {
    return {
        id: result.id,
        name: result.name,
        ports: result.ports,
        action: result.action,
        signal: result.signal,
        signalled: result.signalled,
        skipped: result.skipped,
        failed: result.failed,
        remaining: result.remaining,
        stopped: result.stopped,
        restarted_by: result.restartedBy,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.code === undefined ? {} : { code: result.code })
    };
}

function handleRunningStop(msg: RunningStopMessage, ctx: AppContext, reply: ReplyHandle | null, deps: AppDeps): void {
    const call = stopCall(ctx, deps);
    void (async () => {
        try {
            const outcome = await deps.runningStop.stop(
                {
                    ids: msg.ids,
                    port: msg.port,
                    member: msg.member,
                    force: msg.force,
                    confirmed: msg.confirmed,
                    waitMs: msg.wait_ms,
                    paired: msg.paired === true
                },
                call
            );
            if (!outcome.ok) {
                fail(reply, outcome.error, { code: outcome.code, ...(outcome.candidates === undefined ? {} : { candidates: outcome.candidates }) });
                return;
            }
            ok(reply, { results: outcome.results.map(wireStopResult) });
        } catch (error) {
            fail(reply, `running-stop failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    })();
}

export function runningHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('running-list', (msg, ctx, reply) => {
            handleRunningList(msg, ctx, reply, deps);
        }),
        forCommand('running-stop', (msg, ctx, reply) => {
            handleRunningStop(msg, ctx, reply, deps);
        })
    ];
}
