import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PushDeviceState } from '../pwa/push';
import type { KelpiRuntime } from '../state';
import type { PhoneHostModel } from './model';
import { PhoneNotificationsSheet } from './PhoneNotificationsSheet';
import type { PushHostStatus } from './push-hosts';

afterEach(cleanup);

const OFF: PushDeviceState = { availability: 'available', permission: 'default', wanted: false, registration: null, busy: false, error: null };
const ON: PushDeviceState = {
    ...OFF,
    permission: 'granted',
    wanted: true,
    registration: { endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a', vapidPublicKey: 'v', vapidPrivateKey: 'd' }
};

const host = (key: string, name: string): PhoneHostModel => ({ key, name, kind: key === 'origin' ? 'origin' : 'phone', runtime: {} as KelpiRuntime, removable: false });
const HOSTS = [host('origin', 'werk'), host('phone:2', 'mini')];

function sheet(state: PushDeviceState, statuses: ReadonlyMap<string, PushHostStatus> = new Map(), overrides: Partial<Parameters<typeof PhoneNotificationsSheet>[0]> = {}) {
    const props = {
        open: true,
        state,
        hosts: HOSTS,
        statuses,
        onEnable: vi.fn(),
        onDisable: vi.fn(),
        onTest: vi.fn(() => Promise.resolve([])),
        onClose: vi.fn(),
        ...overrides
    };
    render(<PhoneNotificationsSheet {...props} />);
    return props;
}

describe('PhoneNotificationsSheet', () => {
    it('offers to turn on, straight from the tap', () => {
        const props = sheet(OFF);
        fireEvent.click(screen.getByTestId('phone-notifications-enable'));
        expect(props.onEnable).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('phone-notifications-host')).toBeNull();
    });

    it('tells an iPhone in Safari to add Kelpi to the Home Screen, with no button to press', () => {
        sheet({ ...OFF, availability: 'install-first' });
        expect(screen.getByTestId('phone-notifications-unavailable').textContent).toMatch(/Add to Home Screen/);
        expect(screen.queryByTestId('phone-notifications-enable')).toBeNull();
    });

    it('shows the error it was given', () => {
        sheet({ ...OFF, permission: 'denied', error: 'Notifications are blocked for Kelpi.' });
        expect(screen.getByTestId('phone-notifications-error').textContent).toBe('Notifications are blocked for Kelpi.');
    });

    it('lists each host with its state, and sends a test from the ones that are on', async () => {
        const onTest = vi.fn(() => Promise.resolve([{ hostKey: 'origin', ok: true, message: 'Sent' }]));
        const props = sheet(
            ON,
            new Map<string, PushHostStatus>([
                ['origin', { state: 'on' }],
                ['phone:2', { state: 'error', message: "This host's Kelpi is too old for phone notifications." }]
            ]),
            { onTest }
        );
        const rows = screen.getAllByTestId('phone-notifications-host');
        expect(rows.map((row) => row.getAttribute('data-push-state'))).toEqual(['on', 'error']);
        expect(rows[1]?.textContent).toContain('too old');

        await act(async () => {
            fireEvent.click(screen.getByTestId('phone-notifications-test'));
        });
        expect(onTest).toHaveBeenCalledTimes(1);
        expect(screen.getAllByTestId('phone-notifications-host')[0]?.textContent).toContain('Test sent');

        fireEvent.click(screen.getByTestId('phone-notifications-disable'));
        expect(props.onDisable).toHaveBeenCalledTimes(1);
    });

    it('cannot test before any host is on', () => {
        sheet(ON, new Map<string, PushHostStatus>([['origin', { state: 'waiting' }]]));
        expect((screen.getByTestId('phone-notifications-test') as HTMLButtonElement).disabled).toBe(true);
    });
});
