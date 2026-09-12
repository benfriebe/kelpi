/**
 * The catalog data, and the guard that keeps it honest.
 *
 * The load-bearing test is `writes only keys the daemon accepts`: it is the sibling of
 * `catalog.test.ts` asserting the action table covers `KELPI_ACTIONS` exactly once, and it is what
 * stops a field pointing at a config key `set-general-setting` would refuse - a row that looks
 * live, writes nothing, and reports no error. The others pin the catalog to the tabs it was lifted
 * out of: same sections, same cards, same order, same `data-testid`s, same numbers.
 */

import {
    DEFAULT_WS_SETTINGS,
    WS_WRITABLE_GENERAL_KEYS,
    WS_WRITABLE_GHOSTTY_KEYS,
    type WsSettingsSnapshot
} from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TCP_PORT } from './GeneralTab';
import { FOCUS_DELAY_MAX, FOCUS_DELAY_STEP } from './WorkspacesTab';
import { SETTINGS_TABS } from './catalog';
import { SETTINGS_LIMITS } from './contract';
import {
    SETTINGS_DEFAULT_TCP_PORT,
    SETTINGS_FIELD_DEFINITIONS,
    SETTINGS_FOCUS_DELAY_MAX,
    SETTINGS_FOCUS_DELAY_STEP,
    SETTINGS_GROUPS,
    SETTINGS_SECTIONS,
    describeSettingsField,
    encodeSettingsFieldValue,
    isNativeSettingsSection,
    settingsFieldDefinition,
    settingsFieldsInSection,
    settingsGroupsInSection,
    settingsTransportCaption
} from './sections';

function snapshot(general: Partial<WsSettingsSnapshot['general']> = {}): WsSettingsSnapshot {
    return { ...DEFAULT_WS_SETTINGS, general: { ...DEFAULT_WS_SETTINGS.general, ...general } };
}

const field = (id: string) => {
    const definition = settingsFieldDefinition(id);
    if (definition === undefined) throw new Error(`no such field: ${id}`);
    return definition;
};

describe('the section catalog', () => {
    it('is the rail, section for section, in order', () => {
        expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual(SETTINGS_TABS.map((tab) => tab.id));
        expect(SETTINGS_SECTIONS.map((section) => section.title)).toEqual(SETTINGS_TABS.map((tab) => tab.label));
        expect(SETTINGS_SECTIONS.map((section) => section.icon)).toEqual(SETTINGS_TABS.map((tab) => tab.icon));
        expect(SETTINGS_SECTIONS.map((section) => section.order)).toEqual(SETTINGS_TABS.map((_tab, index) => index));
        expect(SETTINGS_SECTIONS.length).toBeLessThanOrEqual(SETTINGS_LIMITS.sections);
    });

    // Phase 1's scope, stated as an assertion: the two value-and-verb tabs are projected and every
    // hand-built one stays native, including the three the plan calls permanently native.
    it('projects General and Workspaces, and draws every other section natively', () => {
        expect(SETTINGS_SECTIONS.filter((section) => section.kind === 'fields').map((section) => section.id)).toEqual([
            'general',
            'workspaces'
        ]);
        for (const id of ['appearance', 'plugins', 'remote', 'profiles', 'keybindings', 'labels', 'web'] as const)
            expect(isNativeSettingsSection(id)).toBe(true);
    });

    it('gives every card a section that exists and a test id that does not repeat', () => {
        const ids = SETTINGS_GROUPS.map((group) => group.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const group of SETTINGS_GROUPS) {
            expect(isNativeSettingsSection(group.sectionID)).toBe(false);
            expect(Object.isFrozen(group)).toBe(true);
        }
        expect(settingsGroupsInSection('general').map((group) => group.testID)).toEqual([
            'general-worktrees',
            'general-repositories',
            'general-workspaces',
            'general-network'
        ]);
        expect(settingsGroupsInSection('workspaces').map((group) => group.testID)).toEqual([
            'workspaces-section',
            'panes-section'
        ]);
        expect(settingsGroupsInSection('plugins')).toEqual([]);
    });
});

describe('the field table', () => {
    /*
     * The parity guard. `WS_WRITABLE_GENERAL_KEYS` and `WS_WRITABLE_GHOSTTY_KEYS` are the daemon's
     * outer layer (`settings/service.ts` refuses anything else); a field aimed anywhere else is a
     * control that cannot work, and the type alone is not the proof because a cast would satisfy it.
     */
    it('writes only keys the daemon accepts', () => {
        for (const definition of SETTINGS_FIELD_DEFINITIONS) {
            const allowed: readonly string[] =
                definition.target.file === 'kelpi' ? WS_WRITABLE_GENERAL_KEYS : WS_WRITABLE_GHOSTTY_KEYS;
            expect(allowed).toContain(definition.target.key);
        }
    });

    it('lives entirely in fields sections, with unique ids that are not the config keys', () => {
        const ids = SETTINGS_FIELD_DEFINITIONS.map((definition) => definition.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const definition of SETTINGS_FIELD_DEFINITIONS) {
            expect(isNativeSettingsSection(definition.sectionID)).toBe(false);
            expect(SETTINGS_GROUPS).toContainEqual(
                expect.objectContaining({ id: definition.groupID, sectionID: definition.sectionID })
            );
            // The id must not BE the key: an id that spells the config key hands a presenter the
            // mapping the private table exists to keep.
            expect(definition.id).not.toBe(definition.target.key);
            expect(definition.label.length).toBeGreaterThan(0);
        }
    });

    it('stays inside the per-section budget', () => {
        for (const section of SETTINGS_SECTIONS)
            expect(settingsFieldsInSection(section.id, snapshot()).length).toBeLessThanOrEqual(
                SETTINGS_LIMITS.fieldsPerSection
            );
    });

    it('keeps each tab’s rows, in the tab’s order, with the tab’s test ids', () => {
        expect(
            settingsFieldsInSection('general', snapshot({ tcpPort: 19400 })).map((definition) => definition.testID)
        ).toEqual([
            'worktree-base-path',
            'auto-detect-repos-toggle',
            'inherit-group-toggle',
            'new-workspace-placement',
            'new-group-placement',
            'tcp-listener-toggle',
            'tcp-port'
        ]);
        expect(
            settingsFieldsInSection('workspaces', snapshot({ focusFollowsMouse: true })).map(
                (definition) => definition.testID
            )
        ).toEqual([
            'confirm-delete-toggle',
            'expand-group-on-drop-toggle',
            'confirm-quit-toggle',
            'focus-follows-mouse-toggle',
            'focus-delay-slider',
            'clipboard-write-toggle'
        ]);
        expect(settingsFieldsInSection('appearance', snapshot())).toEqual([]);
    });

    // The two conditional rows the tabs render with a ternary. A hidden row is not projected, and
    // `surface.ts` refuses to commit one - which is the whole reason visibility is data here.
    it('hides the port until the listener is on, and the delay until focus-follows-mouse is on', () => {
        const off = settingsFieldsInSection('general', snapshot({ tcpPort: 0 })).map((one) => one.id);
        expect(off).not.toContain('general.tcpPort');
        expect(off).toContain('general.tcpListener');
        const still = settingsFieldsInSection('workspaces', snapshot({ focusFollowsMouse: false })).map(
            (one) => one.id
        );
        expect(still).not.toContain('workspaces.focusDelay');
    });

    it('pins the two numbers the tabs already export', () => {
        expect(SETTINGS_DEFAULT_TCP_PORT).toBe(DEFAULT_TCP_PORT);
        expect(SETTINGS_FOCUS_DELAY_MAX).toBe(FOCUS_DELAY_MAX);
        expect(SETTINGS_FOCUS_DELAY_STEP).toBe(FOCUS_DELAY_STEP);
    });
});

describe('the TCP listener caption', () => {
    /*
     * `GeneralTab.tsx`'s `tcpListenerDetail`, branch for branch, with one deliberate difference:
     * the failed-bind sentence drops the OS text. `tcp.error` still prints in full in the host's
     * own `tcp-bind-error` row, which is drawn natively and never projected.
     */
    it('reports what the listener DID, not what the file asked for', () => {
        expect(
            settingsTransportCaption(snapshot({ tcpPort: 19400 }), {
                state: 'listening',
                host: '127.0.0.1',
                port: 19400
            })
        ).toBe('Listening on 127.0.0.1:19400.');
        // A daemon started with an explicit port is genuinely listening even though the file is
        // silent, and the row says where the port came from.
        expect(
            settingsTransportCaption(snapshot({ tcpPort: 0 }), {
                state: 'listening',
                host: '127.0.0.1',
                port: 52114
            })
        ).toBe(
            'Listening on 127.0.0.1:52114 - this daemon was started with an explicit port, not from this config file.'
        );
    });

    it('names the unavailable port without the daemon’s error text', () => {
        const caption = settingsTransportCaption(snapshot({ tcpPort: 19400 }), {
            state: 'failed',
            host: '127.0.0.1',
            port: 19400
        });
        expect(caption).toBe('Port 19400 is unavailable. Unix-socket clients are unaffected.');
        expect(caption).not.toContain('EADDRINUSE');
    });

    it('separates “no listener at all” from “the daemon has not said”', () => {
        expect(settingsTransportCaption(snapshot({ tcpPort: 19400 }), { state: 'none' })).toBe(
            'Port 19400 takes effect on the next daemon start - this daemon started with no TCP listener.'
        );
        expect(settingsTransportCaption(snapshot({ tcpPort: 19400 }), null)).toBe(
            'Listening on 127.0.0.1:19400 (as of daemon start).'
        );
    });

    it('says disabled when the file asks for nothing and no listener is up', () => {
        for (const status of [null, { state: 'none' } as const])
            expect(settingsTransportCaption(snapshot({ tcpPort: 0 }), status)).toBe(
                'Disabled - the Unix control socket is the only transport.'
            );
    });
});

describe('the two SET-020 rules, as data', () => {
    it('marks the port row as the one that writes unchanged and falls back to its default', () => {
        expect(field('general.tcpPort')).toMatchObject({ commitsUnchanged: true, fallbackToDefault: true });
        // And only that row: every other field keeps the draft and reports why.
        for (const definition of SETTINGS_FIELD_DEFINITIONS.filter((one) => one.id !== 'general.tcpPort')) {
            expect(definition.commitsUnchanged).toBeUndefined();
            expect(definition.fallbackToDefault).toBeUndefined();
        }
    });

    it('is the listener row, and only it, that takes its caption from the host’s transport status', () => {
        expect(
            SETTINGS_FIELD_DEFINITIONS.filter((one) => one.captionFrom !== undefined).map((one) => one.id)
        ).toEqual(['general.tcpListener']);
    });
});

describe('reading and encoding', () => {
    it('reads each value straight off the daemon snapshot', () => {
        const settings = snapshot({ tcpPort: 19400, focusFollowsMouse: true, focusFollowsMouseDelay: 250 });
        expect(describeSettingsField(field('general.tcpListener'), settings)).toMatchObject({ value: true });
        expect(describeSettingsField(field('general.tcpPort'), settings)).toMatchObject({ value: 19400 });
        expect(describeSettingsField(field('workspaces.focusDelay'), settings)).toMatchObject({
            value: 250,
            valueLabel: '250 ms'
        });
        expect(describeSettingsField(field('general.worktreeBasePath'), settings)).toMatchObject({
            value: '~/kelpi/worktrees/<repo>'
        });
    });

    it('encodes the way the tabs encoded', () => {
        expect(encodeSettingsFieldValue(field('general.autoDetectRepos'), false)).toBe('false');
        expect(encodeSettingsFieldValue(field('general.autoDetectRepos'), true)).toBe('true');
        // SET-019: the switch seeds the default port, and 0 is how "off" is spelled in the file.
        expect(encodeSettingsFieldValue(field('general.tcpListener'), true)).toBe(String(DEFAULT_TCP_PORT));
        expect(encodeSettingsFieldValue(field('general.tcpListener'), false)).toBe('0');
        expect(encodeSettingsFieldValue(field('general.worktreeBasePath'), '  ~/code  ')).toBe('~/code');
        expect(encodeSettingsFieldValue(field('workspaces.focusDelay'), 250)).toBe('250');
        expect(() => encodeSettingsFieldValue(field('general.autoDetectRepos'), 'true')).toThrow('switch');
    });

    it('overlays the surface’s edit state without touching the catalog data', () => {
        const described = describeSettingsField(field('general.tcpPort'), snapshot({ tcpPort: 19400 }), {
            detail: 'Listening on 127.0.0.1:19400.',
            busy: true,
            error: 'Enter a valid number.',
            draft: '194'
        });
        expect(described).toMatchObject({
            detail: 'Listening on 127.0.0.1:19400.',
            busy: true,
            error: 'Enter a valid number.',
            draft: '194'
        });
        expect(Object.isFrozen(described)).toBe(true);
        expect((described as unknown as Record<string, unknown>)['target']).toBeUndefined();
    });
});
