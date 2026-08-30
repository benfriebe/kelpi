/**
 * WEB-073: the out-of-process frame's console lines, proved against a scripted CDP session.
 *
 * The browser half of this cannot be unit-tested (it needs a real site-isolated iframe, which is
 * what the `web-console-frames` audit step is for), but everything the host *decides* can be:
 * which commands go to a child session and in what order, which events are forwarded and with
 * whose URL, what happens to the map across detach / destroy / navigation churn, and — the one
 * that turns a bug into a hung page — that a failing command still leaves the frame resumed.
 *
 * The fake below is deliberately a *script*, not a mock framework: a recorded command log and a
 * per-method failure table, so a test says "this command rejects" and then asserts what the rest
 * of the sequence did about it.
 */

import { describe, expect, it } from 'vitest';

import type { ConsoleLinePayload } from './console-format.js';
import { AUTO_ATTACH_PARAMS, createFrameSessions, SESSION_LIMIT } from './frames.js';

interface SentCommand {
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly sessionID: string | undefined;
}

function harness(options: { readonly fail?: Record<string, string>; readonly limit?: number } = {}) {
    const sent: SentCommand[] = [];
    const lines: ConsoleLinePayload[] = [];
    const errors: { message: string; context: string }[] = [];
    const logs: string[] = [];
    const fail = options.fail ?? {};

    const sessions = createFrameSessions({
        transport: {
            send(method, params, sessionID) {
                sent.push({ method, params, sessionID });
                const failure = fail[method];
                if (failure !== undefined) return Promise.reject(new Error(failure));
                return Promise.resolve({});
            }
        },
        console: (payload) => lines.push(payload),
        fallbackURL: () => 'http://tab.example/top',
        onError: (error, context) => errors.push({ message: error.message, context }),
        log: (message) => logs.push(message),
        ...(options.limit === undefined ? {} : { limit: options.limit })
    });

    /** The `Target.attachedToTarget` Chromium sends for an OOPIF. */
    const attachEvent = (
        sessionID: string,
        url: string,
        type = 'iframe',
        targetID = `target-${sessionID}`
    ): Record<string, unknown> => ({
        sessionId: sessionID,
        waitingForDebugger: true,
        targetInfo: { targetId: targetID, type, url, attached: true }
    });

    return { sessions, sent, lines, errors, logs, attachEvent };
}

const CONSOLE_CALL = (message: string): Record<string, unknown> => ({
    type: 'log',
    args: [{ type: 'string', value: message }]
});

describe('createFrameSessions', () => {
    it('arms flattened auto-attach on the tab session, with waitForDebuggerOnStart', async () => {
        const { sessions, sent } = harness();
        await sessions.start();
        expect(sent).toEqual([
            { method: 'Target.setAutoAttach', params: { ...AUTO_ATTACH_PARAMS }, sessionID: undefined }
        ]);
        // The three flags are the whole mechanism, so assert them by name rather than by shape.
        expect(AUTO_ATTACH_PARAMS.autoAttach).toBe(true);
        expect(AUTO_ATTACH_PARAMS.flatten).toBe(true);
        expect(AUTO_ATTACH_PARAMS.waitForDebuggerOnStart).toBe(true);
    });

    it('enables Runtime and Log on an attached iframe session, then resumes it', async () => {
        const { sessions, sent, attachEvent } = harness();
        expect(sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'))).toBe(true);
        await sessions.settled();

        const forChild = sent.filter((entry) => entry.sessionID === 'S1').map((entry) => entry.method);
        expect(forChild).toEqual([
            'Runtime.enable',
            'Log.enable',
            // nested OOPIFs get the same treatment
            'Target.setAutoAttach',
            // …and the frame is let go LAST, after the subscriptions exist
            'Runtime.runIfWaitingForDebugger'
        ]);
        expect(sessions.size).toBe(1);
        expect(sessions.list()[0]).toMatchObject({ sessionID: 'S1', type: 'iframe', forwards: true });
    });

    it('forwards a child frame console line into the tab sink, attributed to the frame URL', async () => {
        const { sessions, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();

        sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('KELPI-OOPIF-MARKER'), 'S1');
        expect(lines).toEqual([
            { level: 'log', message: 'KELPI-OOPIF-MARKER', url: 'http://b.test/frame' }
        ]);
    });

    it('forwards a child frame exception as an error line', async () => {
        const { sessions, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();

        sessions.handle(
            'Runtime.exceptionThrown',
            {
                exceptionDetails: {
                    text: 'Uncaught',
                    url: 'http://b.test/frame',
                    lineNumber: 4,
                    columnNumber: 8,
                    exception: { description: 'Error: KELPI-OOPIF-BOOM' }
                }
            },
            'S1'
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]?.level).toBe('error');
        expect(lines[0]?.message).toContain('KELPI-OOPIF-BOOM');
        // CDP is 0-based; the wire mirrors window.onerror's 1-based numbers.
        expect(lines[0]?.line).toBe(5);
        expect(lines[0]?.column).toBe(9);
    });

    it('forwards Log.entryAdded from a child session', async () => {
        const { sessions, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();

        sessions.handle(
            'Log.entryAdded',
            { entry: { source: 'javascript', level: 'warning', text: 'frame deprecation', lineNumber: 2 } },
            'S1'
        );
        expect(lines).toEqual([
            { level: 'warn', message: 'frame deprecation', url: 'http://b.test/frame', line: 3 }
        ]);
    });

    it('falls back to the tab URL for a frame that has not committed a document', async () => {
        const { sessions, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', ''));
        await sessions.settled();
        sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('early'), 'S1');
        expect(lines[0]?.url).toBe('http://tab.example/top');
    });

    it('keeps a surviving frame\'s URL current through Target.targetInfoChanged', async () => {
        const { sessions, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();
        sessions.handle('Target.targetInfoChanged', {
            targetInfo: { targetId: 'target-S1', type: 'iframe', url: 'http://b.test/frame2' }
        });
        sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('after nav'), 'S1');
        expect(lines[0]?.url).toBe('http://b.test/frame2');
    });

    it('consumes root-session Target bookkeeping but passes ordinary root traffic through', () => {
        const { sessions, attachEvent } = harness();
        // Target.* is ours whichever session it rode in on.
        expect(sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'))).toBe(true);
        expect(sessions.handle('Target.detachedFromTarget', { sessionId: 'S1' })).toBe(true);
        // Root traffic (Electron reports the tab's own session as '') is the tab's business.
        expect(sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('top'), '')).toBe(false);
        expect(sessions.handle('Page.frameNavigated', { frame: { id: 'F1' } }, undefined)).toBe(false);
    });

    it('swallows a child session\'s traffic even before its attach is recorded', () => {
        const { sessions, lines } = harness();
        // A tab must never mistake a child frame's Page.frameNavigated for its own main frame.
        expect(sessions.handle('Page.frameNavigated', { frame: { id: 'F9' } }, 'UNKNOWN')).toBe(true);
        expect(sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('ghost'), 'UNKNOWN')).toBe(true);
        expect(lines).toEqual([]);
    });

    it('stops forwarding a detached session and forgets it', async () => {
        const { sessions, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();
        sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('before'), 'S1');
        sessions.handle('Target.detachedFromTarget', { sessionId: 'S1', targetId: 'target-S1' });
        sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('after'), 'S1');

        expect(lines.map((line) => line.message)).toEqual(['before']);
        expect(sessions.size).toBe(0);
    });

    it('forgets a session whose target is destroyed without a detach event', async () => {
        const { sessions, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();
        sessions.handle('Target.targetDestroyed', { targetId: 'target-S1' });
        expect(sessions.size).toBe(0);
    });

    it('does not leak sessions across navigation churn', async () => {
        const { sessions, attachEvent } = harness();
        for (let index = 0; index < 50; index += 1) {
            const id = `S${String(index)}`;
            sessions.handle('Target.attachedToTarget', attachEvent(id, `http://b.test/frame${String(index)}`));
            await sessions.settled();
            sessions.handle('Target.detachedFromTarget', { sessionId: id });
        }
        expect(sessions.size).toBe(0);
    });

    it('caps the session map when detaches never arrive', async () => {
        const { sessions, attachEvent } = harness({ limit: 4 });
        for (let index = 0; index < 12; index += 1) {
            sessions.handle('Target.attachedToTarget', attachEvent(`S${String(index)}`, 'http://b.test/f'));
        }
        await sessions.settled();
        expect(sessions.size).toBe(4);
        // The default is the shipping backstop, restated so a careless edit trips a test.
        expect(SESSION_LIMIT).toBe(128);
    });

    it('re-announcing the same session refreshes its URL without re-enabling', async () => {
        const { sessions, sent, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();
        const firstRound = sent.filter((entry) => entry.sessionID === 'S1').length;
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame-moved'));
        await sessions.settled();
        expect(sent.filter((entry) => entry.sessionID === 'S1')).toHaveLength(firstRound);
        expect(sessions.list()[0]?.url).toBe('http://b.test/frame-moved');
    });

    it('resumes a frame even when the enables fail, and reports instead of throwing', async () => {
        const { sessions, sent, errors, attachEvent } = harness({
            fail: { 'Runtime.enable': 'session closed', 'Log.enable': 'session closed' }
        });
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();

        // The one command a hung iframe is missing.
        expect(sent.some((entry) => entry.sessionID === 'S1' && entry.method === 'Runtime.runIfWaitingForDebugger')).toBe(true);
        expect(errors.map((entry) => entry.context)).toEqual([
            'child-session Runtime.enable',
            'child-session Log.enable'
        ]);
    });

    it('survives a child session that rejects every command', async () => {
        const { sessions, errors, attachEvent } = harness({
            fail: {
                'Runtime.enable': 'gone',
                'Log.enable': 'gone',
                'Target.setAutoAttach': 'gone',
                'Runtime.runIfWaitingForDebugger': 'gone'
            }
        });
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await expect(sessions.settled()).resolves.toBeUndefined();
        expect(errors).toHaveLength(4);
        // The tab's own pipeline is untouched: root traffic still falls through.
        expect(sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('top'), '')).toBe(false);
    });

    it('reports a failed auto-attach on the tab session without rejecting', async () => {
        const { sessions, errors } = harness({ fail: { 'Target.setAutoAttach': 'not supported' } });
        await expect(sessions.start()).resolves.toBeUndefined();
        expect(errors).toEqual([{ message: 'not supported', context: 'target-auto-attach' }]);
    });

    it('resumes a worker target but does not put its logs in the pane buffer', async () => {
        const { sessions, sent, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('W1', 'http://b.test/sw.js', 'service_worker'));
        await sessions.settled();

        const forWorker = sent.filter((entry) => entry.sessionID === 'W1').map((entry) => entry.method);
        expect(forWorker).toContain('Runtime.runIfWaitingForDebugger');
        expect(forWorker).not.toContain('Runtime.enable');
        sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('worker noise'), 'W1');
        expect(lines).toEqual([]);
    });

    it('attaches a frame nested inside a frame', async () => {
        const { sessions, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();
        // Chromium delivers the grandchild's attach ON the child's session.
        sessions.handle('Target.attachedToTarget', attachEvent('S2', 'http://c.test/deep'), 'S1');
        await sessions.settled();

        expect(sessions.size).toBe(2);
        sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('deep line'), 'S2');
        expect(lines).toEqual([{ level: 'log', message: 'deep line', url: 'http://c.test/deep' }]);
    });

    it('clear() drops every session (debugger detach / tab dispose)', async () => {
        const { sessions, lines, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();
        sessions.clear();
        sessions.handle('Runtime.consoleAPICalled', CONSOLE_CALL('after clear'), 'S1');
        expect(sessions.size).toBe(0);
        expect(lines).toEqual([]);
    });

    it('logs each attach so a live run can prove the frame was out-of-process', async () => {
        const { sessions, logs, attachEvent } = harness();
        sessions.handle('Target.attachedToTarget', attachEvent('S1', 'http://b.test/frame'));
        await sessions.settled();
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('attached child cdp session S1');
        expect(logs[0]).toContain('iframe');
        expect(logs[0]).toContain('http://b.test/frame');
    });
});
