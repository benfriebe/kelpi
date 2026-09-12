/**
 * The secret walk.
 *
 * `WsSettingsSnapshot` is not an innocent object: `remoteDaemons[].url` is documented on the wire
 * as "the pairing URL the other daemon's Settings ▸ Remote hands out (origin + `?token=`)", and
 * `WsProfile.env` is arbitrary environment, which in practice means API keys. The native precedent
 * for withholding them is `features/workspaces.tsx`, which projects `remoteNames` only.
 *
 * Withholding here is by CONSTRUCTION, not by filtering: `settingsFieldDescriptor` copies named
 * fields and the sections carrying secrets are `kind: 'native'`, so there is no code path that
 * reads them. This test is the proof, and it is written to fail loudly if anyone ever reaches for a
 * spread: it stuffs a snapshot with three secrets, walks EVERY section, types and commits, and
 * greps the serialised projection.
 *
 * The write targets are on the same footing as the secrets: a config key in a frame is a bypass of
 * `WS_WRITABLE_GENERAL_KEYS` waiting to happen, so none of them may appear either.
 */

import {
    DEFAULT_WS_SETTINGS,
    WS_WRITABLE_GENERAL_KEYS,
    WS_WRITABLE_GHOSTTY_KEYS,
    type WsSettingsSnapshot
} from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_SECTION_IDS, type SettingsTransportStatus } from './contract';
import { createSettingsSurface, type SettingsSurface, type SettingsSurfaceSnapshot } from './surface';
import type { SettingsActions } from './types';

/** The three things that must never come back out, each distinctive enough to grep for. */
const SECRETS = {
    token: 'REMOTE-PAIRING-TOKEN-7f3a91',
    env: 'sk-live-PROFILE-ENV-SECRET-24b8',
    device: 'DEVICE-ID-0c4d-5e6f-7a8b'
};

const SETTINGS: WsSettingsSnapshot = {
    ...DEFAULT_WS_SETTINGS,
    general: { ...DEFAULT_WS_SETTINGS.general, tcpPort: 19400, focusFollowsMouse: true },
    remoteDaemons: [
        { name: 'studio', url: `https://studio.example.ts.net/?token=${SECRETS.token}` },
        { name: `laptop (${SECRETS.device})`, url: `https://laptop.example.ts.net/?token=${SECRETS.token}` }
    ],
    profiles: [
        {
            name: 'work',
            env: { ANTHROPIC_API_KEY: SECRETS.env, KELPI_DEVICE_ID: SECRETS.device }
        }
    ]
};

/** Disposed after every test, so no 5 s settle timer outlives one. */
const surfaces: SettingsSurface[] = [];

afterEach(() => {
    for (const created of surfaces.splice(0)) created.dispose();
});

function surface(transport?: () => SettingsTransportStatus | null) {
    const actions: SettingsActions = {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
    const created = createSettingsSurface({
        settings: () => SETTINGS,
        actions: () => actions,
        ...(transport === undefined ? {} : { transport })
    });
    surfaces.push(created);
    return created;
}

/** Every section's projection, after some typing, as one serialised blob. */
function walk(): { readonly frames: readonly SettingsSurfaceSnapshot[]; readonly serialised: string } {
    const created = surface();
    const frames: SettingsSurfaceSnapshot[] = [];
    for (const sectionID of SETTINGS_SECTION_IDS) {
        created.setSection(sectionID);
        frames.push(created.getSnapshot());
    }
    created.setSection('general');
    created.setDraft('general.tcpPort', '19500');
    created.commitField('general.tcpPort');
    frames.push(created.getSnapshot());
    created.setSection('workspaces');
    created.commitField('workspaces.clipboardWrite', true);
    frames.push(created.getSnapshot());
    return { frames, serialised: JSON.stringify(frames) };
}

describe('what a settings projection may carry', () => {
    it('never carries a pairing token, a profile environment value or a device id', () => {
        const { serialised } = walk();
        expect(serialised).not.toContain(SECRETS.token);
        expect(serialised).not.toContain(SECRETS.env);
        expect(serialised).not.toContain(SECRETS.device);
        // Not even the things they hang off: no daemon URL, no profile name, no env key.
        expect(serialised).not.toContain('ts.net');
        expect(serialised).not.toContain('ANTHROPIC_API_KEY');
        expect(serialised).not.toContain('token=');
    });

    it('never carries a config key or a verb name', () => {
        const { frames, serialised } = walk();
        /*
         * The test ids are exempt, and only they: they are the tabs' own `data-testid`s, already
         * on the elements of a panel anything can read, and they are how a rewired tab keeps the
         * audit selectors it has always had. A few of them are key-shaped for that historical
         * reason (`tcp-port`, `clipboard-write-toggle`). Everything else in the frame is checked.
         */
        const projected = JSON.stringify(frames, (key, value) =>
            key === 'testID' || key === 'rowTestID' ? undefined : (value as unknown)
        );
        for (const key of [...WS_WRITABLE_GENERAL_KEYS, ...WS_WRITABLE_GHOSTTY_KEYS])
            expect(projected).not.toContain(key);
        for (const verb of ['set-general-setting', 'set-ghostty-setting', 'set-profiles', 'set-remote-daemons'])
            expect(serialised).not.toContain(verb);
    });

    it('is plain JSON all the way down: no closure survives the copy', () => {
        const { frames, serialised } = walk();
        expect(JSON.parse(serialised)).toEqual(frames);
        const seen = new Set<unknown>();
        const inspect = (value: unknown): void => {
            expect(typeof value).not.toBe('function');
            if (typeof value !== 'object' || value === null || seen.has(value)) return;
            seen.add(value);
            for (const [key, child] of Object.entries(value)) {
                // The private half of the catalog, named so a future spread trips here first.
                expect(['target', 'read', 'encode', 'visible', 'format', 'run', 'actions']).not.toContain(key);
                inspect(child);
            }
        };
        inspect(frames);
    });

    it('cannot carry a raw OS bind error, because there is no arm to pass one through', () => {
        /*
         * `WsTcpTransportStatus.error` is the OS text a failed bind threw - `listen EADDRINUSE:
         * address already in use 127.0.0.1:19400`. The host keeps printing it in its own
         * `tcp-bind-error` row, which is native; what it hands the surface is three flags with
         * nowhere to put it, and the surface writes the row's sentence itself.
         */
        const status: SettingsTransportStatus = { state: 'failed', host: '127.0.0.1', port: 19400 };
        expect(Object.keys(status).sort()).toEqual(['host', 'port', 'state']);
        const created = surface(() => status);
        const frame = created.getSnapshot();
        expect(frame.fields.find((one) => one.id === 'general.tcpListener')?.detail).toBe(
            'Port 19400 is unavailable. Unix-socket clients are unaffected.'
        );
        const serialised = JSON.stringify(frame);
        expect(serialised).not.toContain('EADDRINUSE');
        expect(serialised).not.toContain('listen ');
        expect(serialised).not.toContain('address already in use');
    });

    it('reports the secret-bearing sections as native, with nothing in them', () => {
        const created = surface();
        for (const sectionID of ['remote', 'profiles', 'plugins', 'labels', 'keybindings'] as const) {
            created.setSection(sectionID);
            const frame = created.getSnapshot();
            expect(frame).toMatchObject({ sectionID, native: true });
            expect(frame.fields).toEqual([]);
            expect(frame.groups).toEqual([]);
        }
    });
});
