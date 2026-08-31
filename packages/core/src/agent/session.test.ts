import { describe, expect, it } from 'vitest';
import {
    agentKindFromWire,
    captureResumeTuple,
    displayAgentKind,
    isActiveAgentStatus,
    isSafeSessionID,
    resetPaneAgentStateOnLoad,
    resumeCommand
} from './session.js';
import { initialPaneAgentState } from './types.js';

describe('agentKindFromWire', () => {
    it('defaults to claude for absent and unknown values', () => {
        expect(agentKindFromWire(undefined)).toBe('claude');
        expect(agentKindFromWire(null)).toBe('claude');
        expect(agentKindFromWire('')).toBe('claude');
        expect(agentKindFromWire('gemini')).toBe('claude');
    });

    it('matches codex case-insensitively', () => {
        expect(agentKindFromWire('codex')).toBe('codex');
        expect(agentKindFromWire('Codex')).toBe('codex');
        expect(agentKindFromWire('CODEX')).toBe('codex');
    });

    it('falls back to claude for display when no agent was ever seen', () => {
        expect(displayAgentKind(null)).toBe('claude');
        expect(displayAgentKind('codex')).toBe('codex');
    });
});

describe('isSafeSessionID - the pinned allowlist cases', () => {
    it('accepts alphanumerics plus . _ -', () => {
        expect(isSafeSessionID('abc-123_x.Y')).toBe(true);
        expect(isSafeSessionID('a'.repeat(128))).toBe(true);
    });

    it('rejects shell metacharacters, whitespace, empties and overlong ids', () => {
        for (const hostile of [
            'x; touch /tmp/pwned #',
            'a && curl evil',
            'a\nnewline',
            '$(id)',
            '',
            'a'.repeat(129)
        ]) {
            expect(isSafeSessionID(hostile)).toBe(false);
            expect(resumeCommand('claude', hostile)).toBeNull();
            expect(resumeCommand('codex', hostile)).toBeNull();
        }
    });
});

describe('resumeCommand', () => {
    it('builds the per-agent resume invocation', () => {
        expect(resumeCommand('claude', 'abc-123_x.Y')).toBe('claude --resume abc-123_x.Y');
        expect(resumeCommand('codex', 'abc-123_x.Y')).toBe('codex resume abc-123_x.Y');
    });
});

describe('state load sequence', () => {
    const persisted = {
        ...initialPaneAgentState,
        status: 'running' as const,
        agentSessionID: 'sess-1',
        agentKind: 'codex' as const,
        backgroundTaskCount: 3
    };

    it('captures resume tuples before clearing, defaulting the kind to claude', () => {
        expect(captureResumeTuple('pane-1', persisted)).toEqual({
            paneID: 'pane-1',
            sessionID: 'sess-1',
            kind: 'codex',
            profileName: null
        });
        expect(
            captureResumeTuple('pane-1', { ...persisted, agentKind: null })
        ).toEqual({ paneID: 'pane-1', sessionID: 'sess-1', kind: 'claude', profileName: null });
        expect(captureResumeTuple('pane-1', initialPaneAgentState)).toBeNull();
    });

    it('carries the recorded launch profile into the resume tuple', () => {
        expect(
            captureResumeTuple('pane-1', { ...persisted, agentProfileName: 'work' })
        ).toEqual({ paneID: 'pane-1', sessionID: 'sess-1', kind: 'codex', profileName: 'work' });
    });

    it('preserves the recorded launch profile across the load reset, like the kind', () => {
        expect(
            resetPaneAgentStateOnLoad({ ...persisted, agentProfileName: 'work' }).agentProfileName
        ).toBe('work');
    });

    it('clears the session id and status but never the agent kind', () => {
        expect(resetPaneAgentStateOnLoad(persisted)).toEqual({
            status: 'idle',
            agentSessionID: null,
            agentKind: 'codex',
            agentProfileName: null,
            agentStartedAt: null,
            backgroundTaskCount: 0
        });
    });

    it('treats any non-idle status as an active agent for the gates', () => {
        expect(isActiveAgentStatus('idle')).toBe(false);
        expect(isActiveAgentStatus('running')).toBe(true);
        expect(isActiveAgentStatus('waitingForInput')).toBe(true);
    });
});
