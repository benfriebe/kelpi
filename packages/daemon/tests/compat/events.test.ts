/**
 * `kelpi event *` — the Claude Code / Codex hook entrypoint.
 *
 * These are the only fire-and-forget commands that carry state: the CLI writes one line and
 * exits 0 without reading anything, so every assertion is made through a following
 * `pane list --json`. The hook payload is piped on stdin exactly as Claude Code pipes it,
 * which is what exercises the `session_id` dual-fire, the `background_tasks` counting and the
 * sub-agent filter (cli.md §8).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    startCompatDaemon,
    swiftCLIAvailable,
    type CompatDaemon,
    type PaneListEntryJSON
} from './harness.js';

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe.skipIf(!swiftCLIAvailable())('compat: kelpi event', () => {
    let kelpi: CompatDaemon;
    let paneID: string;

    beforeEach(async () => {
        kelpi = await startCompatDaemon();
        await kelpi.json(['workspace', 'create', '--name', 'agents', '--json']);
        const reply = await kelpi.json<{ pane_id: string }>([
            'pane', 'create', '--workspace', 'agents', '--name', 'worker', '--json'
        ]);
        paneID = reply.pane_id;
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    });

    async function pane(): Promise<PaneListEntryJSON> {
        const panes = await kelpi.json<PaneListEntryJSON[]>(['pane', 'list', '--workspace', 'agents', '--json']);
        const found = panes.find((entry) => entry.id === paneID);
        if (found === undefined) throw new Error(`pane ${paneID} vanished`);
        return found;
    }

    /** Fire a hook exactly as Claude Code does: flags + a JSON payload on stdin. */
    async function hook(args: readonly string[], payload?: Record<string, unknown>): Promise<void> {
        const result = await kelpi.run(['event', ...args], {
            paneID,
            ...(payload !== undefined ? { stdin: JSON.stringify(payload) } : {})
        });
        // Fire-and-forget: always exit 0, never a byte of output.
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
    }

    it('drives the pane status through start → stop', async () => {
        expect((await pane()).status).toBe('idle');

        await hook(['start']);
        expect((await pane()).status).toBe('running');
        // An untagged start still records the agent kind (absent on the wire = claude).
        expect((await pane()).agent).toBe('claude');

        await hook(['stop']);
        expect((await pane()).status).toBe('waitingForInput');
    }, 60_000);

    it('binds the session id from the hook payload (the stop dual-fire)', async () => {
        await hook(['start'], { session_id: SESSION });
        let current = await pane();
        expect(current.status).toBe('running');
        expect(current.agent_session_id).toBe(SESSION);

        // A stop carrying a session id does BOTH: the stop transition and a synthesized
        // session-start that (re)binds the id — dispatched after, never given a reply handle.
        await hook(['stop'], { session_id: SESSION });
        current = await pane();
        expect(current.status).toBe('waitingForInput');
        expect(current.agent_session_id).toBe(SESSION);
    }, 60_000);

    it('keeps the pane running while background tasks are in flight', async () => {
        await hook(['start']);
        // Two in-flight units (a running shell + a status-less subagent) and one finished.
        await hook(['stop'], {
            background_tasks: [
                { type: 'shell', status: 'running' },
                { type: 'subagent' },
                { type: 'shell', status: 'completed' }
            ]
        });

        const current = await pane();
        // NOT waitingForInput: the repeat Stops fired as each unit completes stay idempotent.
        expect(current.status).toBe('running');
        expect(current.background_tasks).toBe(2);

        // The next Stop with an empty snapshot ends the turn for real.
        await hook(['stop'], { background_tasks: [] });
        const settled = await pane();
        expect(settled.status).toBe('waitingForInput');
        expect('background_tasks' in settled).toBe(false); // omitted when zero
    }, 60_000);

    it('lets the session dual-fire clear the background count (Swift parity)', async () => {
        await hook(['start'], { session_id: SESSION });
        await hook(['stop'], {
            session_id: SESSION,
            background_tasks: [{ type: 'shell', status: 'running' }, { type: 'subagent' }]
        });

        const current = await pane();
        // The stop keeps the pane running (the suppression that matters)...
        expect(current.status).toBe('running');
        // ...but the synthesized session-start that follows it resets the count, so the
        // number never reaches `pane list`. The Swift app does exactly the same thing
        // (WorkspaceFeature.sessionStarted zeroes backgroundTaskCount), so this is bug-for-bug
        // compatible rather than a daemon defect. See ../kelpi-docs/compat-status.md.
        expect('background_tasks' in current).toBe(false);
    }, 60_000);

    it('clears the tracked session only when session-end matches', async () => {
        await hook(['start'], { session_id: SESSION });

        await hook(['session-end'], { session_id: 'some-other-session' });
        expect((await pane()).agent_session_id).toBe(SESSION);

        await hook(['session-end'], { session_id: SESSION });
        const cleared = await pane();
        expect('agent_session_id' in cleared).toBe(false);
        // The last-known agent kind deliberately survives (it is a display value).
        expect(cleared.agent).toBe('claude');
    }, 60_000);

    it('ignores sub-agent lifecycle hooks', async () => {
        await hook(['stop']);
        expect((await pane()).status).toBe('waitingForInput');

        // agent_id ⇒ a sub-agent fired this; start/stop must not touch the pane indicator.
        await hook(['start'], { session_id: SESSION, agent_id: 'sub-agent-1' });
        const current = await pane();
        expect(current.status).toBe('waitingForInput');
        // The filtered hook never reached the socket at all, so no session id was bound.
        expect('agent_session_id' in current).toBe(false);
    }, 60_000);

    it('routes notification and error through the agent-stopped transition', async () => {
        await hook(['start']);
        await hook(['notification', '--message', 'needs your input'], { session_id: SESSION });
        expect((await pane()).status).toBe('waitingForInput');

        await hook(['start']);
        await hook(['error', '--message', 'boom']);
        expect((await pane()).status).toBe('waitingForInput');
    }, 60_000);

    it('records the agent kind from --agent codex', async () => {
        await hook(['start', '--agent', 'codex'], { session_id: SESSION });
        const current = await pane();
        expect(current.agent).toBe('codex');
        expect(current.status).toBe('running');
        expect(current.agent_session_id).toBe(SESSION);
    }, 60_000);

    it('exits 0 and sends nothing without a pane id, and exits 1 on a bad --agent', async () => {
        // Outside a Kelpi pane: `requirePaneID()` exits 0 silently (hooks must never spam).
        const orphan = await kelpi.run(['event', 'start']);
        expect(orphan.code).toBe(0);
        expect(orphan.stdout).toBe('');
        expect((await pane()).status).toBe('idle');

        // A typo'd --agent is loud on purpose: it would otherwise degrade to claude.
        const bad = await kelpi.run(['event', 'start', '--agent', 'gpt'], { paneID });
        expect(bad.code).toBe(1);
        expect(bad.stderr).toContain('Unknown --agent value: gpt (valid: claude, codex)');
        expect((await pane()).status).toBe('idle');
    }, 60_000);
});
