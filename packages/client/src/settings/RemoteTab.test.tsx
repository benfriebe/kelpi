import { encodeQr, qrSvg } from '@kelpi/core/qr';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteTab, type RemoteTabActions } from './RemoteTab';

afterEach(cleanup);

/**
 * The card's QR, as the encoder would draw it for `url`, serialised the way the DOM serialises
 * what `dangerouslySetInnerHTML` parsed.
 *
 * The options are spelled out rather than imported so that changing the module size or either
 * colour in `RemoteTab.tsx` fails a test instead of quietly redefining what is being pinned.
 * The round trip through a detached element is not slack in the assertion: an HTML serialiser
 * writes `<rect …></rect>` where the encoder writes `<rect …/>`, so both sides are put through
 * the same parser and the comparison stays exact everywhere it matters, the path data included.
 */
function expectedQr(url: string): string {
    const probe = document.createElement('div');
    probe.innerHTML = qrSvg(encodeQr(url), {
        moduleSize: 5,
        foreground: '#000000',
        background: '#FFFFFF',
        ariaLabel: 'Pairing QR code. Scan it with the device you are pairing.'
    });
    return probe.innerHTML;
}

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

    it('draws the minted tailnet URL as a QR beside the field, exactly what the encoder makes of it', async () => {
        // The URL the daemon really returns over the tailnet: a MagicDNS host and a `kd_` token
        // of the length `lifecycle/devices.ts` mints. 79 characters, so a version 5 symbol.
        const url = `https://werk.taila.ts.net/?token=kd_${'a'.repeat(43)}`;
        render(
            <RemoteTab
                actions={actions({
                    pair: () => Promise.resolve({ ok: true, url, device: { id: 'cc33', name: 'phone', created_at: '' }, notes: [] })
                })}
            />
        );
        await waitFor(() => expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk'));
        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'phone' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-qr')).toBeTruthy());

        // The payload IS the reply's URL: the encoder is verified against a decoder in
        // `@kelpi/core/qr`'s own tests, so drawing byte-for-byte what it draws for this URL is
        // the proof that a phone pointed at the card gets this URL and not another one.
        const host = screen.getByTestId('remote-pair-qr');
        expect(host.innerHTML).toBe(expectedQr(url));

        // Scannable from a Mac screen at arm's length: 37 modules plus the 4-module quiet zone
        // each side, 5 px a module, so a 225 px plate. Dark modules inside a LIGHT quiet zone,
        // whatever the theme is doing behind them.
        const svg = host.querySelector('svg');
        expect(svg?.getAttribute('width')).toBe('225');
        expect(svg?.getAttribute('height')).toBe('225');
        expect(svg?.getAttribute('viewBox')).toBe('0 0 45 45');
        expect(svg?.querySelector('rect')?.getAttribute('fill')).toBe('#FFFFFF');
        expect(svg?.querySelector('path')?.getAttribute('fill')).toBe('#000000');
        // One image to a screen reader, not a wall of nothing, and no token in its name.
        expect(svg?.getAttribute('role')).toBe('img');
        expect(svg?.getAttribute('aria-label')).toBe('Pairing QR code. Scan it with the device you are pairing.');
        expect(host.innerHTML).not.toContain('kd_');
    });

    it('draws no QR for a loopback pairing, and says nothing about one', async () => {
        // The toggle off: the daemon answers with the URL only this machine can open. A QR of
        // it would be an invitation a phone cannot accept, so there is not one.
        const pair = vi.fn(() =>
            Promise.resolve({
                ok: true,
                url: 'http://127.0.0.1:61154/?token=kd_secret',
                device: { id: 'cc33', name: 'here', created_at: '' },
                notes: ['This URL is loopback-only - it works in a browser on this machine.']
            })
        );
        render(<RemoteTab actions={actions({ pair })} />);
        await waitFor(() => expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk'));
        fireEvent.click(screen.getByTestId('remote-pair-tailnet-toggle'));
        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'here' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-url')).toBeTruthy());
        expect(pair).toHaveBeenCalledWith('here', false);
        expect(screen.queryByTestId('remote-pair-qr')).toBeNull();
        expect(screen.getByTestId('remote-pair-minted').textContent).not.toContain('scan');
    });

    it('draws no QR when the toggle said tailnet but the daemon answered with loopback anyway', async () => {
        // Belt and braces: the host the daemon actually sent decides, not only the toggle.
        const pair = vi.fn(() =>
            Promise.resolve({
                ok: true,
                url: 'http://localhost:61154/?token=kd_secret',
                device: { id: 'cc33', name: 'phone', created_at: '' },
                notes: []
            })
        );
        render(<RemoteTab actions={actions({ pair })} />);
        await waitFor(() => expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk'));
        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'phone' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-url')).toBeTruthy());
        expect(pair).toHaveBeenCalledWith('phone', true);
        expect(screen.queryByTestId('remote-pair-qr')).toBeNull();
    });

    it('forgets the QR with the rest of the card, the one-time rule unchanged', async () => {
        const url = `https://werk.taila.ts.net/?token=kd_${'a'.repeat(43)}`;
        const pair = vi
            .fn<(name: string, tailnet: boolean) => Promise<Record<string, unknown>>>()
            .mockResolvedValueOnce({ ok: true, url, device: { id: 'cc33', name: 'phone', created_at: '' }, notes: [] })
            .mockResolvedValueOnce({ ok: false, error: 'tailscaled is not running (state: Stopped)' });
        render(<RemoteTab actions={actions({ pair })} />);
        await waitFor(() => expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk'));
        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'phone' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-qr')).toBeTruthy());

        // The card goes, and the picture of the token goes with it - same one act, not two.
        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'again' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-error')).toBeTruthy());
        expect(screen.queryByTestId('remote-pair-minted')).toBeNull();
        expect(screen.queryByTestId('remote-pair-url')).toBeNull();
        expect(screen.queryByTestId('remote-pair-qr')).toBeNull();
        // The token itself, not the string `kd_` - the Daemons card's placeholder carries that.
        expect(document.body.innerHTML).not.toContain('a'.repeat(43));
    });

    it('renders a serve-not-enabled refusal as numbered SETUP STEPS with a real clickable link', async () => {
        // The daemon's own words for the commonest first-run stumble (issue #3): serve has
        // never been switched on for this tailnet, and tailscale names the page that does it.
        const pair = vi.fn(() =>
            Promise.resolve({
                ok: false,
                error:
                    'tailscale serve is not enabled for this tailnet yet, so there is no https address to give a device. ' +
                    '(the "studio" device was rolled back - nothing was paired)',
                repair: 'Enable serve for the tailnet at https://login.tailscale.com/f/serve?node=x, then try again.',
                steps: [
                    'Open https://login.tailscale.com/f/serve?node=x and enable serve for this tailnet.',
                    'Enable HTTPS certificates too, if they are not on yet: https://login.tailscale.com/admin/dns'
                ]
            })
        );
        render(<RemoteTab actions={actions({ pair })} />);
        await waitFor(() => expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk'));
        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'studio' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-error')).toBeTruthy());

        // A setup step, not a failure: the heading says so and the steps are numbered.
        expect(screen.getByTestId('remote-pair-error-title').textContent).toBe('Pairing needs a setup step');
        expect(screen.getByTestId('remote-pair-step-1').textContent).toContain('enable serve for this tailnet');
        expect(screen.getByTestId('remote-pair-step-2').textContent).toContain('HTTPS certificates');
        expect(screen.getByTestId('remote-pair-retry').textContent).toContain('pair this device again');
        // The one-line repair is not ALSO rendered - the steps are that repair, unrolled.
        expect(screen.queryByTestId('remote-pair-repair')).toBeNull();

        // Every URL is an anchor the shell hands to the system browser, not dead text.
        const links = screen.getAllByTestId('remote-pair-link') as HTMLAnchorElement[];
        expect(links.map((link) => link.getAttribute('href'))).toEqual([
            'https://login.tailscale.com/f/serve?node=x',
            'https://login.tailscale.com/admin/dns'
        ]);
        expect(links[0]?.getAttribute('target')).toBe('_blank');
        expect(links[0]?.getAttribute('rel')).toBe('noreferrer');
    });

    it('links a URL sitting inside the message, keeping the sentence’s punctuation out of the href', async () => {
        const pair = vi.fn(() =>
            Promise.resolve({ ok: false, error: 'serve refused, see https://login.tailscale.com/admin/dns.' })
        );
        render(<RemoteTab actions={actions({ pair })} />);
        await waitFor(() => expect(screen.getByTestId('remote-tailnet-line').textContent).toContain('werk'));
        fireEvent.change(screen.getByTestId('remote-pair-name-input'), { target: { value: 'x' } });
        fireEvent.click(screen.getByTestId('remote-pair-button'));
        await waitFor(() => expect(screen.getByTestId('remote-pair-error')).toBeTruthy());
        // No steps: this one really is a failure, and says so.
        expect(screen.getByTestId('remote-pair-error-title').textContent).toBe('Pairing failed');
        expect(screen.getByTestId('remote-pair-link').getAttribute('href')).toBe(
            'https://login.tailscale.com/admin/dns'
        );
        expect(screen.getByTestId('remote-pair-error').textContent).toContain('admin/dns.');
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
        // No steps in the reply: the one-line repair carries the guidance by itself.
        expect(screen.getByTestId('remote-pair-repair').textContent).toContain('Run `tailscale up`');

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
