import { DEFAULT_WS_SETTINGS, type WsIntegrationStatus } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChromeRepo } from '../chrome';
import { createFakePhoneWindow } from '../phone/testing';
import type { IntegrationsSlice } from '../state';
import { IntegrationsTab, formatCountdown, type IntegrationsTabActions, type IntegrationsTabProps } from './IntegrationsTab';
import { SettingsOverlay, type SettingsOverlayProps } from './SettingsOverlay';
import type { SettingsActions } from './types';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const DISCONNECTED: WsIntegrationStatus = { provider: 'github', available: true, connected: false };
const CONNECTED: WsIntegrationStatus = {
    provider: 'github',
    available: true,
    connected: true,
    login: 'octocat',
    how: 'oauth',
    scopes: ['repo']
};

function slice(status: WsIntegrationStatus | null, overrides: Partial<IntegrationsSlice> = {}): IntegrationsSlice {
    return { supported: true, manageable: true, providers: status === null ? [] : [status], ...overrides };
}

const START_REPLY = {
    ok: true,
    flow_id: 'flow-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5
};

function actions(overrides: Partial<IntegrationsTabActions> = {}): IntegrationsTabActions {
    return {
        linkStart: vi.fn(() => Promise.resolve<Record<string, unknown>>(START_REPLY)),
        linkCancel: vi.fn(() => Promise.resolve<Record<string, unknown>>({ ok: true, cancelled: true })),
        linkToken: vi.fn(() => Promise.resolve<Record<string, unknown>>({ ok: true, integrations: [CONNECTED] })),
        unlink: vi.fn(() => Promise.resolve<Record<string, unknown>>({ ok: true, integrations: [DISCONNECTED] })),
        ...overrides
    };
}

function props(overrides: Partial<IntegrationsTabProps> = {}): IntegrationsTabProps {
    return {
        integrations: slice(DISCONNECTED),
        actions: actions(),
        repos: [],
        sessionKey: 'client-1',
        onOpenURL: vi.fn(),
        ...overrides
    };
}

/** Let the reply promise settle inside React's act. */
async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function startFlow(view: ReturnType<typeof render>, base: IntegrationsTabProps): Promise<void> {
    fireEvent.click(screen.getByTestId('integrations-github-connect-button'));
    await flush();
    view.rerender(<IntegrationsTab {...base} />);
}

describe('Settings ▸ Integrations: status', () => {
    it('says who the daemon is linked as, how, and with which scopes', () => {
        render(<IntegrationsTab {...props({ integrations: slice(CONNECTED) })} />);
        expect(screen.getByTestId('integrations-github-status-line').textContent).toBe('Connected as @octocat');
        const row = screen.getByTestId('integrations-github-status').textContent ?? '';
        expect(row).toContain('Signed in with GitHub.');
        expect(row).toContain('Scopes: repo.');
        // Linked: no Connect, but Disconnect.
        expect(screen.queryByTestId('integrations-github-connect')).toBeNull();
        expect(screen.getByTestId('integrations-github-disconnect')).toBeTruthy();
    });

    it('calls a token with no scopes header a fine-grained token', () => {
        render(
            <IntegrationsTab
                {...props({ integrations: slice({ provider: 'github', available: true, connected: true, login: 'o', how: 'token' }) })}
            />
        );
        expect(screen.getByTestId('integrations-github-status').textContent).toContain('A fine-grained token');
    });

    it('explains a revoked or unreadable credential and offers to connect again', () => {
        const view = render(
            <IntegrationsTab
                {...props({ integrations: slice({ provider: 'github', available: true, connected: false, login: 'o', how: 'oauth', problem: 'revoked' }) })}
            />
        );
        expect(screen.getByTestId('integrations-github-status-line').textContent).toContain('no longer accepts');
        expect(screen.getByTestId('integrations-github-status').textContent).toContain('Connect again');
        expect(screen.getByTestId('integrations-github-connect-button')).toBeTruthy();
        expect(screen.getByTestId('integrations-github-disconnect')).toBeTruthy();
        view.rerender(
            <IntegrationsTab {...props({ integrations: slice({ provider: 'github', available: true, connected: false, problem: 'unreadable' }) })} />
        );
        expect(screen.getByTestId('integrations-github-status').textContent).toContain('integrations.json');
        view.rerender(
            <IntegrationsTab
                {...props({ integrations: slice({ provider: 'github', available: true, connected: false, login: 'o', how: 'oauth', problem: 'endpoint-mismatch' }) })}
            />
        );
        expect(screen.getByTestId('integrations-github-status-line').textContent).toContain('another GitHub address');
        expect(screen.getByTestId('integrations-github-status').textContent).toContain('KELPI_GITHUB_API_URL');
        expect(screen.getByTestId('integrations-github-connect-button')).toBeTruthy();
    });

    it('tells everyone that paired devices search the owner’s private tickets', () => {
        render(<IntegrationsTab {...props()} />);
        expect(screen.getByTestId('integrations-github').textContent).toContain('anyone with a paired device can search and open your private issues');
    });

    it('says so, and nothing else, on a daemon that predates integrations', () => {
        render(<IntegrationsTab {...props({ integrations: { supported: false, manageable: false, providers: [] } })} />);
        expect(screen.getByTestId('integrations-unsupported').textContent).toContain('predates integrations');
        expect(screen.queryByTestId('integrations-github')).toBeNull();
        expect(screen.queryByTestId('integrations-repos')).toBeNull();
    });

    it('says GitHub is not available when the daemon reports no GitHub provider', () => {
        render(<IntegrationsTab {...props({ integrations: slice(null) })} />);
        expect(screen.getByTestId('integrations-github-unavailable')).toBeTruthy();
    });
});

describe('Settings ▸ Integrations: connecting with the device flow', () => {
    it('shows the code, copies it, and opens only GitHub’s page from its own button', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
        const base = props();
        const view = render(<IntegrationsTab {...base} />);
        await startFlow(view, base);
        expect(base.actions.linkStart).toHaveBeenCalledWith('github');
        expect(screen.getByTestId('integrations-github-user-code').textContent).toBe('ABCD-1234');
        // Starting a flow opens nothing on its own: the page opens from a click on Open GitHub.
        expect(base.onOpenURL).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('integrations-github-copy'));
        await flush();
        expect(writeText).toHaveBeenCalledWith('ABCD-1234');
        expect(screen.getByTestId('integrations-github-copy').textContent).toBe('Copied');
        fireEvent.click(screen.getByTestId('integrations-github-open'));
        expect(base.onOpenURL).toHaveBeenCalledWith('https://github.com/login/device');
        // The Connect button cannot start a second flow while this one is up.
        expect((screen.getByTestId('integrations-github-connect-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('never opens a verification page that is not github.com, and abandons that flow', async () => {
        const linkCancel = vi.fn(() => Promise.resolve<Record<string, unknown>>({ ok: true, cancelled: true }));
        const base = props({
            actions: actions({
                linkStart: () => Promise.resolve({ ...START_REPLY, verification_uri: 'https://evil.example/login/device' }),
                linkCancel
            })
        });
        render(<IntegrationsTab {...base} />);
        fireEvent.click(screen.getByTestId('integrations-github-connect-button'));
        await flush();
        expect(screen.queryByTestId('integrations-github-code')).toBeNull();
        expect(screen.getByTestId('integrations-github-notice').textContent).toContain('not on github.com');
        expect(linkCancel).toHaveBeenCalledWith('github', 'flow-1');
        expect(base.onOpenURL).not.toHaveBeenCalled();
    });

    it('counts down by this machine’s clock and drops the code when it expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
        const base = props({ actions: actions({ linkStart: () => Promise.resolve({ ...START_REPLY, expires_in: 65 }) }) });
        const view = render(<IntegrationsTab {...base} />);
        await startFlow(view, base);
        expect(screen.getByTestId('integrations-github-countdown').textContent).toContain('1:05');
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });
        expect(screen.getByTestId('integrations-github-countdown').textContent).toContain('1:00');
        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.queryByTestId('integrations-github-code')).toBeNull();
        expect(screen.getByTestId('integrations-github-notice').textContent).toContain('The code expired');
    });

    it('cancels by its own flow id', async () => {
        const base = props();
        const view = render(<IntegrationsTab {...base} />);
        await startFlow(view, base);
        fireEvent.click(screen.getByTestId('integrations-github-cancel'));
        await flush();
        expect(base.actions.linkCancel).toHaveBeenCalledWith('github', 'flow-1');
        expect(screen.queryByTestId('integrations-github-code')).toBeNull();
        expect(screen.getByTestId('integrations-github-notice').textContent).toBe('Sign-in cancelled.');
    });

    it('keeps the code while its flow is pending, and drops it when another window replaces the flow', async () => {
        const base = props();
        const view = render(<IntegrationsTab {...base} />);
        await startFlow(view, base);
        const pending = (flowID: string): IntegrationsSlice =>
            slice({ ...DISCONNECTED, linking: { state: 'pending', flowID, expiresAt: Date.now() + 900_000 } });
        view.rerender(<IntegrationsTab {...base} integrations={pending('flow-1')} />);
        expect(screen.getByTestId('integrations-github-user-code')).toBeTruthy();
        view.rerender(<IntegrationsTab {...base} integrations={pending('flow-2')} />);
        expect(screen.queryByTestId('integrations-github-code')).toBeNull();
        expect(screen.getByTestId('integrations-github-notice').textContent).toContain('Another window started a new sign-in');
        // The other window's flow is described on the status row instead.
        expect(screen.getByTestId('integrations-github-status').textContent).toContain('started in another window');
    });

    it('shows why our flow failed', async () => {
        const base = props();
        const view = render(<IntegrationsTab {...base} />);
        await startFlow(view, base);
        view.rerender(
            <IntegrationsTab
                {...base}
                integrations={slice({ ...DISCONNECTED, linking: { state: 'failed', flowID: 'flow-1', reason: 'denied', message: 'You denied access at GitHub.' } })}
            />
        );
        expect(screen.queryByTestId('integrations-github-code')).toBeNull();
        expect(screen.getByTestId('integrations-github-notice').textContent).toBe('You denied access at GitHub.');
    });

    it('drops the code once the link lands', async () => {
        const base = props();
        const view = render(<IntegrationsTab {...base} />);
        await startFlow(view, base);
        view.rerender(<IntegrationsTab {...base} integrations={slice(CONNECTED)} />);
        expect(screen.queryByTestId('integrations-github-code')).toBeNull();
        expect(screen.getByTestId('integrations-github-notice').textContent).toBe('Connected as @octocat.');
        expect(screen.getByTestId('integrations-github-status-line').textContent).toBe('Connected as @octocat');
    });

    it('drops the code when the session changes (a reconnect or handoff ends every flow)', async () => {
        const base = props();
        const view = render(<IntegrationsTab {...base} />);
        await startFlow(view, base);
        expect(screen.getByTestId('integrations-github-user-code')).toBeTruthy();
        view.rerender(<IntegrationsTab {...base} sessionKey="client-2" />);
        expect(screen.queryByTestId('integrations-github-code')).toBeNull();
        expect(screen.getByTestId('integrations-github-notice').textContent).toContain('connection to the daemon was reset');
    });

    it('reports a refused start, and points at the token path when device flow is unavailable', async () => {
        const base = props({
            actions: actions({
                linkStart: () => Promise.resolve({ ok: false, error: 'GitHub device flow is disabled for this app.', code: 'unavailable' })
            })
        });
        render(<IntegrationsTab {...base} />);
        fireEvent.click(screen.getByTestId('integrations-github-connect-button'));
        await flush();
        expect(screen.getByTestId('integrations-github-notice').textContent).toContain('personal access token below');
    });
});

describe('Settings ▸ Integrations: other paths', () => {
    it('offers only the token path, and says why, when the build has no OAuth client ID', () => {
        render(<IntegrationsTab {...props({ integrations: slice({ provider: 'github', available: false, connected: false }) })} />);
        expect(screen.queryByTestId('integrations-github-connect')).toBeNull();
        expect(screen.getByTestId('integrations-github-no-oauth').textContent).toContain('no GitHub OAuth app');
        expect(screen.getByTestId('integrations-github-token-input')).toBeTruthy();
    });

    it('sends a pasted token from a masked field, clears it, and shows the daemon’s warnings', async () => {
        const linkToken = vi.fn(() =>
            Promise.resolve<Record<string, unknown>>({
                ok: true,
                integrations: [CONNECTED],
                warnings: ['A fine-grained token: GitHub does not say which repositories it can see.']
            })
        );
        render(<IntegrationsTab {...props({ actions: actions({ linkToken }) })} />);
        const input = screen.getByTestId('integrations-github-token-input') as HTMLInputElement;
        expect(input.type).toBe('password');
        expect(input.getAttribute('autocomplete')).toBe('off');
        fireEvent.change(input, { target: { value: '  github_pat_secret \n' } });
        fireEvent.click(screen.getByTestId('integrations-github-token-button'));
        await flush();
        expect(linkToken).toHaveBeenCalledWith('github', 'github_pat_secret');
        expect(input.value).toBe('');
        expect(screen.getByTestId('integrations-github-token-warning-0').textContent).toContain('fine-grained');
    });

    it('shows why a token was refused and keeps it for a correction', async () => {
        const linkToken = vi.fn(() =>
            Promise.resolve<Record<string, unknown>>({ ok: false, error: 'This token lacks the repo scope.', code: 'missing-scope' })
        );
        render(<IntegrationsTab {...props({ actions: actions({ linkToken }) })} />);
        const input = screen.getByTestId('integrations-github-token-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'ghp_x' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await flush();
        expect(screen.getByTestId('integrations-github-token-error').textContent).toBe('This token lacks the repo scope.');
        expect(input.value).toBe('ghp_x');
    });

    it('disconnects, and links to GitHub’s own page for revoking the grant', async () => {
        const base = props({ integrations: slice(CONNECTED) });
        render(<IntegrationsTab {...base} />);
        expect(screen.getByTestId('integrations-github-disconnect').textContent).toContain('cannot revoke the authorization on GitHub');
        fireEvent.click(screen.getByTestId('integrations-github-grants'));
        expect(base.onOpenURL).toHaveBeenCalledWith('https://github.com/settings/applications');
        fireEvent.click(screen.getByTestId('integrations-github-disconnect-button'));
        await flush();
        expect(base.actions.unlink).toHaveBeenCalledWith('github');
    });

    it('is read-only for a paired device', () => {
        render(<IntegrationsTab {...props({ integrations: slice(CONNECTED, { manageable: false }) })} />);
        expect(screen.getByTestId('integrations-github-status-line').textContent).toBe('Connected as @octocat');
        expect(screen.getByTestId('integrations-github-readonly').textContent).toContain('Only the owner');
        expect(screen.queryByTestId('integrations-github-connect')).toBeNull();
        expect(screen.queryByTestId('integrations-github-disconnect')).toBeNull();
        expect(screen.queryByTestId('integrations-github-token')).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();
    });
});

describe('Settings ▸ Integrations: searchable repositories', () => {
    const repo = (id: string, name: string, remoteURL: string | null): ChromeRepo => ({
        id,
        name,
        path: `/code/${name}`,
        worktreeBase: '/wt',
        remoteURL
    });

    it('lists each GitHub repository once, with the registry rows that point at it', () => {
        render(
            <IntegrationsTab
                {...props({
                    repos: [
                        repo('r1', 'api', 'git@github.com:acme/api.git'),
                        repo('r2', 'api-docs', 'https://github.com/acme/api'),
                        repo('r3', 'web', 'https://github.com/acme/web.git'),
                        repo('r4', 'scratch', null),
                        repo('r5', 'gitlab-thing', 'git@gitlab.com:acme/thing.git')
                    ]
                })}
            />
        );
        expect(screen.getByTestId('integrations-repo-acme/api').textContent).toContain('api, api-docs');
        expect(screen.getByTestId('integrations-repo-acme/web')).toBeTruthy();
        expect(screen.getByTestId('integrations-repos-other').textContent).toContain('scratch, gitlab-thing');
        expect(screen.queryByTestId('integrations-repos-empty')).toBeNull();
    });

    it('says when no registered repository has a GitHub remote', () => {
        render(<IntegrationsTab {...props({ repos: [repo('r1', 'notes', null)] })} />);
        expect(screen.getByTestId('integrations-repos-empty')).toBeTruthy();
    });
});

describe('formatCountdown', () => {
    it('reads minutes and seconds, rounding up and never below zero', () => {
        expect(formatCountdown(900_000)).toBe('15:00');
        expect(formatCountdown(65_000)).toBe('1:05');
        expect(formatCountdown(400)).toBe('0:01');
        expect(formatCountdown(-5)).toBe('0:00');
    });
});

describe('Settings ▸ Integrations in the Settings window', () => {
    const NOOP_ACTIONS: SettingsActions = {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };

    function overlay(overrides: Partial<SettingsOverlayProps> = {}): void {
        render(
            <SettingsOverlay
                open
                settings={DEFAULT_WS_SETTINGS}
                domain={{ labelPresets: [], workspaces: [] }}
                actions={NOOP_ACTIONS}
                onClose={vi.fn()}
                {...overrides}
            />
        );
    }

    it('is a rail tab with its own glyph that draws the tab from the prop', () => {
        overlay({ initialTab: 'integrations', integrations: props({ integrations: slice(CONNECTED) }) });
        const button = screen.getByTestId('settings-tab-button-integrations');
        expect(button.getAttribute('aria-selected')).toBe('true');
        expect(button.dataset['icon']).toBe('link');
        expect(screen.getByTestId('settings-panel').contains(screen.getByTestId('integrations-github-status'))).toBe(true);
    });

    it('says integrations are unavailable when the host passes nothing', () => {
        overlay({ initialTab: 'integrations' });
        expect(screen.getByTestId('settings-tab-integrations').textContent).toContain('unavailable');
    });

    it('is pushed on a phone like every other tab', () => {
        overlay({ formFactorWindow: createFakePhoneWindow(), integrations: props() });
        fireEvent.click(screen.getByTestId('settings-tab-button-integrations'));
        expect(screen.getByTestId('integrations-github-connect-button')).toBeTruthy();
        expect(screen.getByTestId('settings-phone-back')).toBeTruthy();
    });

    it('searches to the Connect row for the owner, and to the status with a reason for a paired device', () => {
        overlay({ integrations: props() });
        fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'Sign in with GitHub' } });
        fireEvent.click(screen.getAllByTestId('settings-search-result-integrations-github-connect')[0]!);
        expect(screen.getByTestId('integrations-github-connect').dataset['settingsSearchHit']).toBe('true');
        cleanup();

        overlay({ integrations: props({ integrations: slice(CONNECTED, { manageable: false }) }) });
        fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'Sign in with GitHub' } });
        expect(screen.getByTestId('settings-search-results').textContent).toContain('Only the owner of this daemon can connect GitHub.');
        fireEvent.click(screen.getAllByTestId('settings-search-result-integrations-github-connect')[0]!);
        expect(screen.getByTestId('integrations-github-status').dataset['settingsSearchHit']).toBe('true');
    });
});
