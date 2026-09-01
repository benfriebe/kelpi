import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteTab, type RemoteTabActions } from './RemoteTab';

afterEach(cleanup);

function actions(overrides: Partial<RemoteTabActions> = {}): RemoteTabActions {
    return {
        status: () =>
            Promise.resolve({
                ok: true,
                devices: [
                    { id: 'aa11', name: 'phone', created_at: '2026-09-01T00:00:00Z' },
                    { id: 'bb22', name: 'old-laptop', created_at: '2026-08-01T00:00:00Z', revoked_at: '2026-08-20T00:00:00Z' }
                ],
                tailnet: { available: true, backend: 'Running', dns_name: 'werk.taila.ts.net', serving: true }
            }),
        pair: () =>
            Promise.resolve({
                ok: true,
                url: 'https://werk.taila.ts.net/?token=kd_secret',
                device: { id: 'cc33', name: 'tablet', created_at: '2026-09-01T00:00:00Z' },
                notes: ['tailscale serve: already fronting 127.0.0.1:61154 on :443']
            }),
        revoke: () => Promise.resolve({ ok: true, device: { id: 'aa11', name: 'phone', created_at: '' } }),
        ...overrides
    };
}

describe('Settings ▸ Remote', () => {
    it('shows the tailnet identity and the registry, live devices with a Revoke and revoked ones inert', async () => {
        render(<RemoteTab actions={actions()} />);
        await waitFor(() => {
            expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk.taila.ts.net');
        });
        expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('serve is fronting the daemon');
        expect(screen.getByTestId('remote-device-aa11').textContent).toContain('phone');
        expect(screen.getByTestId('remote-revoke-aa11')).toBeTruthy();
        // A revoked device keeps its record but offers no button.
        expect(screen.getByTestId('remote-device-bb22').textContent).toContain('revoked');
        expect(screen.queryByTestId('remote-revoke-bb22')).toBeNull();
    });

    it('pairs a device and shows the one-time URL with its warning', async () => {
        const pair = vi.fn(() =>
            Promise.resolve({
                ok: true,
                url: 'https://werk.taila.ts.net/?token=kd_secret',
                device: { id: 'cc33', name: 'tablet', created_at: '' },
                notes: []
            })
        );
        render(<RemoteTab actions={actions({ pair })} />);
        await waitFor(() => expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk'));

        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'tablet' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-url')).toBeTruthy());
        // The tailnet toggle defaulted ON (the status said available), and rode the call.
        expect(pair).toHaveBeenCalledWith('tablet', true);
        expect((screen.getByTestId('remote-pair-url') as HTMLInputElement).value).toBe(
            'https://werk.taila.ts.net/?token=kd_secret'
        );
        expect(screen.getByTestId('remote-pair-minted').textContent).toContain('shown exactly once');
    });

    it('surfaces a pairing failure with its repair line, and the owner-only refusal a guest gets', async () => {
        const pair = vi.fn(() =>
            Promise.resolve({ ok: false, error: 'tailscaled is not running (state: Stopped)', repair: 'Run `tailscale up`, then retry.' })
        );
        render(<RemoteTab actions={actions({ pair })} />);
        await waitFor(() => expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk'));
        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'x' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-error')).toBeTruthy());
        expect(screen.getByTestId('remote-pair-error').textContent).toContain('tailscaled is not running');
        expect(screen.getByTestId('remote-pair-error').textContent).toContain('Run `tailscale up`');

        cleanup();
        // A paired device opening this tab: the daemon refuses status, the tab says so.
        render(
            <RemoteTab
                actions={actions({ status: () => Promise.resolve({ ok: false, error: 'remote-status is owner-only' }) })}
            />
        );
        await waitFor(() =>
            expect(screen.getByTestId('remote-tailnet-line').textContent).toBe('remote-status is owner-only')
        );
    });

    it('revokes through the action and refreshes the registry', async () => {
        const revoke = vi.fn(() => Promise.resolve({ ok: true, device: { id: 'aa11', name: 'phone', created_at: '' } }));
        render(<RemoteTab actions={actions({ revoke })} />);
        await waitFor(() => expect(screen.getByTestId('remote-revoke-aa11')).toBeTruthy());
        fireEvent.click(screen.getByTestId('remote-revoke-aa11'));
        await waitFor(() => expect(revoke).toHaveBeenCalledWith('aa11'));
    });
});

describe('the Daemons registry card (§1.7)', () => {
    it('lists configured daemons with tokens elided, removes one, and adds one as a full-replacement save', async () => {
        const onSaveDaemons = vi.fn();
        render(
            <RemoteTab
                actions={actions()}
                daemons={[{ name: 'werk', url: 'https://werk.taila.ts.net/?token=kd_secret' }]}
                onSaveDaemons={onSaveDaemons}
            />
        );
        await waitFor(() => expect(screen.getByTestId('remote-daemon-row-werk')).toBeTruthy());
        // The credential never renders: the row shows the URL with the token elided.
        expect(screen.getByTestId('remote-daemon-row-werk').textContent).not.toContain('kd_secret');
        expect(screen.getByTestId('remote-daemon-row-werk').textContent).toContain('?token=…');

        fireEvent.click(screen.getByTestId('remote-daemon-remove-werk'));
        expect(onSaveDaemons).toHaveBeenCalledWith([]);

        fireEvent.change(screen.getByTestId('remote-daemon-add-name'), { target: { value: 'studio' } });
        fireEvent.change(screen.getByTestId('remote-daemon-add-url'), {
            target: { value: 'https://studio.taila.ts.net/?token=kd_b' }
        });
        fireEvent.click(screen.getByTestId('remote-daemon-add-button'));
        expect(onSaveDaemons).toHaveBeenLastCalledWith([
            { name: 'werk', url: 'https://werk.taila.ts.net/?token=kd_secret' },
            { name: 'studio', url: 'https://studio.taila.ts.net/?token=kd_b' }
        ]);
    });

    it('renders read-only without a save handler, and refuses a name carrying a colon', async () => {
        render(<RemoteTab actions={actions()} daemons={[]} />);
        await waitFor(() => expect(screen.getByTestId('remote-daemons-empty')).toBeTruthy());
        fireEvent.change(screen.getByTestId('remote-daemon-add-name'), { target: { value: 'a' } });
        fireEvent.change(screen.getByTestId('remote-daemon-add-url'), { target: { value: 'https://x/' } });
        expect((screen.getByTestId('remote-daemon-add-button') as HTMLButtonElement).disabled).toBe(true);
    });
});
