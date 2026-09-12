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
import { SETTINGS_PLACEMENT, createSettingsPresenterHost } from './presenter';
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
    // Appearance is the partly projected section: its plain rows are descriptors and the rest is
    // hand-built, so the walk has to type into it as well as route through it.
    created.setSection('appearance');
    created.setDraft('appearance.fontFamily', 'SF Mono');
    created.commitField('appearance.fontFamily');
    created.commitField('appearance.sparklineStyle', 'dots');
    frames.push(created.getSnapshot());
    return { frames, serialised: JSON.stringify(frames) };
}

/**
 * The copy fields, which the shipped tabs have always PRINTED.
 *
 * `general.tcpPort`'s caption names a port, the terminal padding rows name ghostty's own
 * `window-padding-x` / `-y` and the opacity row spells `rgba(background, opacity)` - the Swift
 * app's captions do the same, because a row that writes a named key in someone else's config file
 * is more useful when it says which one. Prose is therefore checked differently from structure: a
 * key may appear INSIDE a sentence, and may never BE one.
 */
const COPY_KEYS = ['label', 'detail', 'title', 'hint', 'valueLabel', 'testID', 'rowTestID'];

/**
 * The half of that copy a reader actually READS.
 *
 * The test ids are not in it: they are the tabs' own `data-testid`s, already on the elements of a
 * panel anything can read, and a few of them ARE key-shaped for that historical reason (`tcp-port`,
 * `clipboard-write-toggle`). They are exempt here exactly as they have always been - and the
 * presenter projection drops them outright, which the presenter case below asserts.
 */
const PROSE_KEYS = ['label', 'detail', 'title', 'hint', 'valueLabel'];

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
         * Structure first: with every human-readable string taken out, not one writable key may
         * appear anywhere in the frame - not as an id, not as a value, not as a property name.
         * That is the leak that would matter, because it is the one a caller could act on.
         *
         * The test ids come out with the copy: they are the tabs' own `data-testid`s, already on
         * the elements of a panel anything can read, and a few are key-shaped for that historical
         * reason (`tcp-port`, `clipboard-write-toggle`). The presenter projection drops them
         * outright, which the presenter test below asserts.
         */
        const structure: string[] = [];
        JSON.stringify(frames, (key, value) => {
            if (COPY_KEYS.includes(key)) return undefined;
            structure.push(key);
            if (typeof value === 'string') structure.push(value);
            return value as unknown;
        });
        // Whole tokens, not substrings: `background` is a writable ghostty key AND an English word
        // that half this tab's ids and captions are built from (`appearance.backgroundOpacity`).
        // What would matter is the key itself standing somewhere a caller could pick it up.
        for (const key of [...WS_WRITABLE_GENERAL_KEYS, ...WS_WRITABLE_GHOSTTY_KEYS])
            expect(structure).not.toContain(key);
        // …and no caption, label or card title may BE a key, which is the only way one could reach
        // a reader through the prose.
        const copy: string[] = [];
        JSON.stringify(frames, (key, value) => {
            if (PROSE_KEYS.includes(key) && typeof value === 'string') copy.push(value);
            return value as unknown;
        });
        expect(copy.length).toBeGreaterThan(0);
        for (const key of [...WS_WRITABLE_GENERAL_KEYS, ...WS_WRITABLE_GHOSTTY_KEYS])
            expect(copy).not.toContain(key);
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

    /**
     * The presenter projection, on the same walk.
     *
     * `settingsFieldDescriptor` is the panel's copy and `presenter.ts`'s is the frame's, and the
     * frame's is the narrower one: the two test ids and the three formatting fields the bundled
     * panel wants (`default`, `placeholder`, `valueLabel`) are dropped, so what crosses the window
     * boundary is an id, a kind, a label, a caption, a value and the constraints of the control.
     */
    it('hands a presenter less than the panel: no test ids, no defaults, no secrets', () => {
        const created = surface();
        const host = createSettingsPresenterHost({
            surface: created,
            placement: SETTINGS_PLACEMENT,
            formFactor: () => 'desktop',
            visible: () => true,
            close: vi.fn(),
            fail: vi.fn()
        });
        const frames: unknown[] = [];
        for (const sectionID of SETTINGS_SECTION_IDS) {
            created.setSection(sectionID);
            frames.push(host.getSettingsPresentation());
        }
        created.setSection('appearance');
        created.setDraft('appearance.fontFamily', SECRETS.env);
        frames.push(host.getSettingsPresentation());
        const serialised = JSON.stringify(frames);

        // A draft the USER typed is theirs and comes back to them; nothing else does.
        expect(serialised).toContain(SECRETS.env);
        expect(serialised).not.toContain(SECRETS.token);
        expect(serialised).not.toContain(SECRETS.device);
        expect(serialised).not.toContain('ts.net');

        const keys = new Set<string>();
        const walkKeys = (value: unknown): void => {
            if (Array.isArray(value)) {
                for (const item of value) walkKeys(item);
                return;
            }
            if (typeof value !== 'object' || value === null) return;
            for (const [key, child] of Object.entries(value)) {
                keys.add(key);
                walkKeys(child);
            }
        };
        walkKeys(frames);
        for (const withheld of ['testID', 'rowTestID', 'default', 'placeholder', 'valueLabel', 'order', 'target'])
            expect([...keys]).not.toContain(withheld);
        host.dispose();
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
