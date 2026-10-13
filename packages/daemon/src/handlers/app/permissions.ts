/**
 * `permission-request` (#388; socket-handlers.md §3.7, wire-protocol.md §6.1.1).
 *
 * The one agent hook verb with a reply. Claude's PermissionRequest hook asks, the selected
 * `kelpi.agent.permissions` provider decides, and the CLI prints Claude's decision JSON from
 * the reply. Routing uses the same parked-INCLUSIVE pane lookup as the lifecycle events.
 *
 * This handler owns the deadline. A provider that is late, throws or answers malformed is
 * replied to as `abstain`, which leaves Claude's own prompt in place: failing open means
 * abstaining, never allowing. Every decision is one info line in the daemon log.
 *
 * The deadline bounds the provider only: a plugin `before` operation hook on
 * `permission-request` or `*` runs in the dispatcher first (up to 5 s), and the CLI's 3.5 s
 * guard and Claude's 5 s hook timeout bound the whole run, both failing open to the prompt.
 *
 * Every decision, fallbacks included, is also one `agent.event` of type `permission-request`
 * (#388 §4, agent-lifecycle.md §7.7), published after the reply. An unknown or unowned pane
 * (`ok:false`) and a pane whose agent events are muted (#372) publish none, as for every
 * other hook; the muted pane's abstain reply still goes out.
 *
 * The event's `behavior` is the daemon's answer as Claude got it: a decision that arrives after
 * the CLI left (its guard fired, so Claude kept its prompt) publishes `abstain`. An internal
 * fault caught by the last-resort `.catch` answers abstain and publishes no event.
 */

import { pluginRecord, type JsonObject, type JsonValue } from '@kelpi/protocol';

import { findPaneAnywhere, workspaceByID } from '../../store/index.js';
import { permissionRequestEvent } from './agent-events.js';
import { forCommand } from './common.js';
import { fail, ok, type AppDeps, type AppHandler } from './context.js';

/** How long the selected provider gets before the daemon answers `abstain` for it. */
export const PERMISSION_DEADLINE_MS = 2000;

export const UNKNOWN_PANE_ERROR = 'unknown pane';

export type PermissionBehavior = 'allow' | 'deny' | 'abstain';

export interface PermissionDecision {
    readonly behavior: PermissionBehavior;
    /** Only ever present on `deny`. */
    readonly message?: string;
}

interface PermissionOutcome {
    /** Absent only when no provider could be asked at all. */
    readonly provider?: string;
    readonly decision: PermissionDecision;
}

const ABSTAIN: PermissionDecision = { behavior: 'abstain' };
const TIMED_OUT = Symbol('timed out');

/** The provider's result as a decision, or the reason it is not one. */
function parseDecision(result: JsonValue): PermissionDecision | string {
    if (!pluginRecord(result)) return 'the result is not an object';
    const behavior = result['behavior'];
    if (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'abstain') {
        return `unknown behavior ${JSON.stringify(behavior) ?? 'undefined'}`;
    }
    const message = result['message'];
    if (message !== undefined && typeof message !== 'string') return 'the message is not a string';
    return behavior === 'deny' && message !== undefined ? { behavior, message } : { behavior };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Ask the provider, bounded by `PERMISSION_DEADLINE_MS`. Never rejects. */
async function askProvider(args: JsonObject, deps: AppDeps): Promise<PermissionOutcome> {
    const controller = new AbortController();
    let call;
    try {
        call = deps.decidePermission(args, controller.signal);
    } catch (error) {
        deps.log(`WARNING: permission-request: no provider could be asked (${describeError(error)}); answering abstain`);
        return { decision: ABSTAIN };
    }
    const { provider } = call;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => {
            resolve(TIMED_OUT);
        }, PERMISSION_DEADLINE_MS);
    });
    let reason: string;
    try {
        const result = await Promise.race([call.result, deadline]);
        if (result === TIMED_OUT) {
            controller.abort();
            reason = `did not answer within ${String(PERMISSION_DEADLINE_MS)} ms`;
        } else {
            const decision = parseDecision(result);
            if (typeof decision !== 'string') return { provider, decision };
            reason = `returned a malformed result (${decision})`;
        }
    } catch (error) {
        reason = `failed (${describeError(error)})`;
    } finally {
        clearTimeout(timer);
    }
    deps.log(`WARNING: permission-request: provider ${provider} ${reason}; answering abstain`);
    return { provider, decision: ABSTAIN };
}

export function permissionHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('permission-request', (msg, ctx, reply) => {
            // #372: the pane's agent is being restarted on a new terminal host; nobody is asked.
            if (deps.agentEventsMuted(msg.pane_id)) {
                deps.log(`permission-request: pane ${msg.pane_id} tool ${msg.tool_name}: abstain (agent events muted)`);
                ok(reply, { behavior: 'abstain' });
                return;
            }
            const state = ctx.store.getState();
            const location = findPaneAnywhere(state, msg.pane_id);
            const workspace = location === null ? null : workspaceByID(state, location.workspaceID);
            if (location === null || workspace === null) {
                fail(reply, UNKNOWN_PANE_ERROR);
                return;
            }
            const { pane } = location;
            // The line's own session id first: its dual-fire binds the pane only after this handler
            // ran, and a provider that remembers grants per session must not be told the previous one.
            const sessionID = msg.session_id ?? pane.agentSessionID ?? undefined;
            const args: JsonObject = {
                paneID: msg.pane_id,
                workspaceID: workspace.id,
                agent: pane.agentKind ?? 'claude',
                ...(sessionID !== undefined ? { sessionID } : {}),
                toolName: msg.tool_name,
                toolInput: msg.tool_input,
                ...(msg.mcp_server !== undefined ? { mcpServer: msg.mcp_server } : {}),
                ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
                ...(msg.permission_mode !== undefined ? { permissionMode: msg.permission_mode } : {})
            };
            void askProvider(args, deps)
                .then(({ provider, decision }) => {
                    // Read before `ok()` closes it: a closed handle means the CLI already left.
                    const delivered = reply !== null && !reply.closed;
                    ok(reply, { ...decision, ...(provider !== undefined ? { provider } : {}) });
                    if (delivered) {
                        deps.log(
                            `permission-request: pane ${msg.pane_id} tool ${msg.tool_name}: ${decision.behavior} (provider ${provider ?? 'none'})`
                        );
                    } else {
                        deps.log(
                            `WARNING: permission-request: pane ${msg.pane_id} tool ${msg.tool_name}: provider ${provider ?? 'none'} answered ${decision.behavior} after the CLI left; Claude kept its prompt`
                        );
                    }
                    // Read the pane again: the provider may have taken up to the deadline.
                    if (deps.agentEventsMuted(msg.pane_id)) return;
                    const event = permissionRequestEvent(msg.pane_id, ctx.store.getState(), {
                        toolName: msg.tool_name,
                        behavior: delivered ? decision.behavior : 'abstain',
                        ...(provider !== undefined ? { provider } : {}),
                        ...(delivered && decision.message !== undefined ? { message: decision.message } : {})
                    });
                    if (event !== null) deps.emitAgentEvent(event);
                })
                .catch((error: unknown) => {
                    if (reply !== null && !reply.closed) ok(reply, { behavior: 'abstain' });
                    try {
                        deps.log(`WARNING: permission-request: ${describeError(error)}`);
                    } catch {
                        // The log itself is what failed; the abstain reply already went out.
                    }
                });
        })
    ];
}
