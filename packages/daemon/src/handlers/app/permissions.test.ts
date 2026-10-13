/**
 * `permission-request` (#388): the provider's decision comes back on the reply, bounded by the
 * handler's own 2 s deadline, and every failure answers `abstain`, never `allow`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, JsonValue } from '@kelpi/protocol';

import type { AgentHookEvent } from './agent-events.js';
import type { PermissionDecisionCall } from './context.js';
import { PERMISSION_DEADLINE_MS } from './permissions.js';
import { flush, harness, id, NOW, seeded } from './testing.js';

const W1 = id('aaaaaaaa', 1);
const P1 = id('dddddddd', 1);
const PM = id('eeeeeeee', 1);
const PROVIDER = 'sample.policy.provider';
const BUNDLED = 'kelpi.agent.permissions.bundled';

const REQUEST = {
    command: 'permission-request',
    pane_id: P1,
    tool_name: 'Bash',
    tool_input: { command: 'mv a b', description: 'Rename a' }
};

interface Recorded {
    readonly args: JsonObject;
    readonly signal: AbortSignal;
}

/** A `decidePermission` stub that records each call and answers with `answer`. */
function provider(answer: (args: JsonObject) => Promise<JsonValue>, id = PROVIDER) {
    const calls: Recorded[] = [];
    const decidePermission = (args: JsonObject, signal: AbortSignal): PermissionDecisionCall => {
        calls.push({ args, signal });
        return { provider: id, result: answer(args) };
    };
    return { calls, decidePermission };
}

function setup(answer: (args: JsonObject) => Promise<JsonValue>, options: { muted?: boolean } = {}) {
    const stub = provider(answer);
    const logs: string[] = [];
    /** Each `agent.event`, with how many reply payloads had gone out when it was published. */
    const events: { event: AgentHookEvent; repliesSent: number }[] = [];
    const h = harness({
        initial: seeded(1),
        decidePermission: stub.decidePermission,
        log: (message) => {
            logs.push(message);
        },
        emitAgentEvent: (event) => {
            events.push({ event, repliesSent: h.replies.at(-1)?.payloads.length ?? 0 });
        },
        ...(options.muted === true ? { agentEventsMuted: (paneID: string) => paneID === P1 } : {})
    });
    /** Send one request and return its reply payloads, which fill in once the provider settles. */
    const ask = (object: Record<string, unknown> = REQUEST): Record<string, unknown>[] => {
        h.send(object);
        const capture = h.replies.at(-1);
        if (capture === undefined) throw new Error('no reply handle was allocated');
        return capture.payloads;
    };
    return { h, calls: stub.calls, logs, events, ask };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('permission-request', () => {
    it('replies allow with the provider id and logs the decision', async () => {
        const { h, calls, logs, ask } = setup(async () => ({ behavior: 'allow' }));
        const payloads = ask();
        await flush();
        expect(payloads).toEqual([{ ok: true, behavior: 'allow', provider: PROVIDER }]);
        expect(h.replies.at(-1)?.closed).toBe(true);
        expect(calls[0]?.args).toEqual({
            paneID: P1,
            workspaceID: W1,
            agent: 'claude',
            toolName: 'Bash',
            toolInput: { command: 'mv a b', description: 'Rename a' }
        });
        expect(calls[0]?.signal.aborted).toBe(false);
        expect(logs).toEqual([`permission-request: pane ${P1} tool Bash: allow (provider ${PROVIDER})`]);
    });

    it('passes the deny message through, and drops a message on any other behavior', async () => {
        const deny = setup(async () => ({ behavior: 'deny', message: 'rm -rf is never allowed' }));
        const denied = deny.ask();
        await flush();
        expect(denied).toEqual([{ ok: true, behavior: 'deny', message: 'rm -rf is never allowed', provider: PROVIDER }]);

        const allow = setup(async () => ({ behavior: 'allow', message: 'not shown' }));
        const allowed = allow.ask();
        await flush();
        expect(allowed).toEqual([{ ok: true, behavior: 'allow', provider: PROVIDER }]);
    });

    it('replies abstain when the provider abstains', async () => {
        const { logs, ask } = setup(async () => ({ behavior: 'abstain' }));
        const payloads = ask();
        await flush();
        expect(payloads).toEqual([{ ok: true, behavior: 'abstain', provider: PROVIDER }]);
        expect(logs.filter((line) => line.startsWith('WARNING'))).toEqual([]);
    });

    it('answers with the bundled abstain when boot composed no provider', async () => {
        const h = harness({ initial: seeded(1) });
        h.send(REQUEST);
        await flush();
        expect(h.replies.at(-1)?.payloads).toEqual([{ ok: true, behavior: 'abstain', provider: BUNDLED }]);
    });

    it('builds the args from the pane and the optional request fields', async () => {
        const { h, calls, ask } = setup(async () => ({ behavior: 'abstain' }));
        h.send({ command: 'session-start', pane_id: P1, session_id: 'sess-1', agent: 'codex' });
        ask({
            ...REQUEST,
            tool_name: 'mcp__github__create_issue',
            tool_input: {},
            mcp_server: 'github',
            cwd: '/work/app',
            permission_mode: 'acceptEdits'
        });
        await flush();
        expect(calls[0]?.args).toEqual({
            paneID: P1,
            workspaceID: W1,
            agent: 'codex',
            sessionID: 'sess-1',
            toolName: 'mcp__github__create_issue',
            toolInput: {},
            mcpServer: 'github',
            cwd: '/work/app',
            permissionMode: 'acceptEdits'
        });
    });

    it('replies abstain and logs a warning naming the provider when it throws', async () => {
        const { logs, ask } = setup(async () => {
            throw new Error('policy file missing');
        });
        const payloads = ask();
        await flush();
        expect(payloads).toEqual([{ ok: true, behavior: 'abstain', provider: PROVIDER }]);
        expect(logs).toEqual([
            `WARNING: permission-request: provider ${PROVIDER} failed (policy file missing); answering abstain`,
            `permission-request: pane ${P1} tool Bash: abstain (provider ${PROVIDER})`
        ]);
    });

    it('replies abstain when the provider cannot even be called', async () => {
        const logs: string[] = [];
        const h = harness({
            initial: seeded(1),
            decidePermission: () => {
                throw new Error('plugin service is stopped');
            },
            log: (message) => {
                logs.push(message);
            }
        });
        h.send(REQUEST);
        await flush();
        expect(h.replies.at(-1)?.payloads).toEqual([{ ok: true, behavior: 'abstain' }]);
        expect(logs[0]).toBe(
            'WARNING: permission-request: no provider could be asked (plugin service is stopped); answering abstain'
        );
    });

    it('replies abstain for a malformed result, never allow', async () => {
        for (const result of [{ behavior: 'Allow' }, { behavior: 'allow', message: 7 }, 'allow', null, [{ behavior: 'allow' }]]) {
            const { logs, ask } = setup(async () => result as JsonValue);
            const payloads = ask();
            await flush();
            expect(payloads).toEqual([{ ok: true, behavior: 'abstain', provider: PROVIDER }]);
            expect(logs[0]).toMatch(new RegExp(`^WARNING: permission-request: provider ${PROVIDER} returned a malformed result`));
        }
    });

    it('replies abstain at the 2 s deadline when the provider hangs, and aborts the pending call', async () => {
        vi.useFakeTimers();
        const { calls, logs, ask } = setup(() => new Promise<JsonValue>(() => {}));
        const started = Date.now();
        const payloads = ask();
        await vi.advanceTimersByTimeAsync(PERMISSION_DEADLINE_MS - 1);
        expect(payloads).toEqual([]);
        expect(calls[0]?.signal.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(payloads).toEqual([{ ok: true, behavior: 'abstain', provider: PROVIDER }]);
        expect(Date.now() - started).toBe(2000);
        expect(calls[0]?.signal.aborted).toBe(true);
        expect(logs).toEqual([
            `WARNING: permission-request: provider ${PROVIDER} did not answer within 2000 ms; answering abstain`,
            `permission-request: pane ${P1} tool Bash: abstain (provider ${PROVIDER})`
        ]);
    });

    it('ignores a provider allow that arrives after the deadline', async () => {
        vi.useFakeTimers();
        const { ask } = setup(
            () =>
                new Promise<JsonValue>((resolve) => {
                    setTimeout(() => {
                        resolve({ behavior: 'allow' });
                    }, 5000);
                })
        );
        const payloads = ask();
        await vi.advanceTimersByTimeAsync(5000);
        expect(payloads).toEqual([{ ok: true, behavior: 'abstain', provider: PROVIDER }]);
    });

    it('answers unknown pane for a pane no workspace owns, without asking', async () => {
        const { calls, ask } = setup(async () => ({ behavior: 'allow' }));
        const payloads = ask({ ...REQUEST, pane_id: id('9999aaaa', 1) });
        await flush();
        expect(payloads).toEqual([{ ok: false, error: 'unknown pane' }]);
        expect(calls).toEqual([]);
    });

    it('reaches a PARKED pane (its agent is still running)', async () => {
        const { h, calls, ask } = setup(async () => ({ behavior: 'allow' }));
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PM,
            filePath: '/docs/a.md',
            reusePaneID: P1,
            now: NOW
        });
        expect(h.state().workspaces[0]?.parkedPanes.map((pane) => pane.id)).toEqual([P1]);
        const payloads = ask();
        await flush();
        expect(payloads).toEqual([{ ok: true, behavior: 'allow', provider: PROVIDER }]);
        expect(calls).toHaveLength(1);
    });

    it('abstains without asking anyone for a pane whose agent events are muted (#372)', async () => {
        const { calls, logs, ask } = setup(async () => ({ behavior: 'allow' }), { muted: true });
        const payloads = ask();
        await flush();
        expect(payloads).toEqual([{ ok: true, behavior: 'abstain' }]);
        expect(calls).toEqual([]);
        expect(logs).toEqual([`permission-request: pane ${P1} tool Bash: abstain (agent events muted)`]);
    });
});

describe('permission-request agent.event (#388 §4)', () => {
    it('publishes one allow event naming the provider, after the reply, without the tool input', async () => {
        const { events, ask } = setup(async () => ({ behavior: 'allow' }));
        ask();
        await flush();
        expect(events).toEqual([
            {
                event: {
                    type: 'permission-request',
                    paneID: P1,
                    workspaceID: W1,
                    agent: 'claude',
                    status: 'idle',
                    toolName: 'Bash',
                    behavior: 'allow',
                    provider: PROVIDER
                },
                repliesSent: 1
            }
        ]);
    });

    it('carries a deny message, the bound session and the workspace mute', async () => {
        const { h, events, ask } = setup(async () => ({ behavior: 'deny', message: 'rm -rf is never allowed' }));
        h.send({ command: 'session-start', pane_id: P1, session_id: 'sess-1' });
        h.dispatch({ type: 'set-workspace-muted', id: W1, muted: true });
        ask();
        await flush();
        // The session-start publishes its own event first.
        expect(events.map(({ event }) => event).filter((event) => event.type === 'permission-request')).toEqual([
            expect.objectContaining({
                type: 'permission-request',
                sessionID: 'sess-1',
                behavior: 'deny',
                message: 'rm -rf is never allowed',
                provider: PROVIDER,
                muted: true
            })
        ]);
    });

    it('publishes the abstain fallback once, naming the provider that timed out', async () => {
        vi.useFakeTimers();
        const { events, ask } = setup(() => new Promise<JsonValue>(() => {}));
        ask();
        await vi.advanceTimersByTimeAsync(PERMISSION_DEADLINE_MS);
        expect(events).toEqual([
            {
                event: expect.objectContaining({ type: 'permission-request', behavior: 'abstain', provider: PROVIDER }),
                repliesSent: 1
            }
        ]);
        expect(events[0]?.event).not.toHaveProperty('message');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(events).toHaveLength(1);
    });

    it('leaves out the provider when none could be asked', async () => {
        const events: AgentHookEvent[] = [];
        const h = harness({
            initial: seeded(1),
            decidePermission: () => {
                throw new Error('plugin service is stopped');
            },
            emitAgentEvent: (event) => {
                events.push(event);
            }
        });
        h.send(REQUEST);
        await flush();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'permission-request', behavior: 'abstain' });
        expect(events[0]).not.toHaveProperty('provider');
    });

    it('publishes nothing for an unknown pane or a pane whose agent events are muted', async () => {
        const unknown = setup(async () => ({ behavior: 'allow' }));
        unknown.ask({ ...REQUEST, pane_id: id('9999aaaa', 1) });
        await flush();
        expect(unknown.events).toEqual([]);

        const muted = setup(async () => ({ behavior: 'allow' }), { muted: true });
        expect(muted.ask()).toEqual([{ ok: true, behavior: 'abstain' }]);
        await flush();
        expect(muted.events).toEqual([]);
    });
});
