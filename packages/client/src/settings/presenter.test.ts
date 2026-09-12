/**
 * The Settings presenter model: what leaves the dialog, and what a presenter may send back.
 *
 * Driven through a REAL settings surface, because every rule worth pinning is a rule about the two
 * together: the projection is built from a live snapshot, the field checks only mean something
 * against the fields that snapshot actually published, and the budget has to be able to take the
 * dialog back from a presenter that is misusing it.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_LIMITS } from './contract';
import {
    SETTINGS_PLACEMENT,
    SETTINGS_UI_METHODS,
    clearSettingsPresenterFailure,
    createSettingsPresenterHost,
    noteSettingsPresenterFailure,
    resetSettingsPresenterFailures,
    settingsPresenterFailures,
    subscribeSettingsPresenters,
    type SettingsPresenterHost,
    type SettingsPresenterSnapshot
} from './presenter';
import { createSettingsSurface, type SettingsSurface } from './surface';
import type { SettingsActions } from './types';

const surfaces: SettingsSurface[] = [];
const hosts: SettingsPresenterHost[] = [];

function actions(): SettingsActions {
    return {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
}

function make(
    overrides: Partial<WsSettingsSnapshot['general']> = {},
    options: { disabled?: (fieldID: string) => boolean } = {}
) {
    const verbs = actions();
    const settings: WsSettingsSnapshot = {
        ...DEFAULT_WS_SETTINGS,
        general: { ...DEFAULT_WS_SETTINGS.general, ...overrides }
    };
    const surface = createSettingsSurface({
        settings: () => settings,
        actions: () => verbs,
        ...(options.disabled === undefined ? {} : { disabled: options.disabled })
    });
    surfaces.push(surface);
    return { surface, verbs, settings };
}

interface Harness {
    readonly host: SettingsPresenterHost;
    readonly frames: SettingsPresenterSnapshot[];
    readonly errors: Error[];
    readonly awaited: boolean[];
    readonly failures: string[];
    readonly closes: () => number;
    readonly ready: () => number;
    visible: boolean;
}

function mount(surface: SettingsSurface, options: { visible?: boolean; subscribe?: boolean } = {}): Harness {
    const frames: SettingsPresenterSnapshot[] = [];
    const errors: Error[] = [];
    const awaited: boolean[] = [];
    const failures: string[] = [];
    let closes = 0;
    let ready = 0;
    const state = { visible: options.visible ?? true };
    const host = createSettingsPresenterHost({
        surface,
        placement: SETTINGS_PLACEMENT,
        formFactor: () => 'desktop',
        visible: () => state.visible,
        close: () => {
            closes += 1;
        },
        fail: (detail) => failures.push(detail),
        onFrame: (awaits) => awaited.push(awaits),
        onReady: () => {
            ready += 1;
        }
    });
    hosts.push(host);
    if (options.subscribe !== false)
        host.subscribe(
            (value) => frames.push(value),
            (error) => errors.push(error)
        );
    return {
        host,
        frames,
        errors,
        awaited,
        failures,
        closes: () => closes,
        ready: () => ready,
        get visible() {
            return state.visible;
        },
        set visible(value: boolean) {
            state.visible = value;
        }
    };
}

/** The model coalesces on a microtask, exactly as the interaction one does. */
const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const surface of surfaces.splice(0)) surface.dispose();
    resetSettingsPresenterFailures();
    vi.useRealTimers();
});

describe('the projection', () => {
    it('carries the whole rail, the routed section and only its fields', () => {
        const { surface } = make({ tcpPort: 19400 });
        surface.setSection('general');
        const frame = mount(surface).host.getSettingsPresentation();
        expect(frame.placement).toBe(SETTINGS_PLACEMENT);
        expect(frame.formFactor).toBe('desktop');
        expect(frame.visible).toBe(true);
        // Every section, native ones included: the rail is the host's, and a presenter that could
        // not draw the entry for Plugins could hide the route to switching itself off.
        expect(frame.sections.map((section) => section.id)).toContain('plugins');
        expect(frame.sections.find((section) => section.id === 'plugins')).toMatchObject({
            title: 'Plugins',
            native: true
        });
        expect(frame.sectionID).toBe('general');
        /*
         * General is projected AND has a remainder: the failed-bind line, the CLI-compat note, the
         * pointer at Workspaces and the config-file footer are outcomes and prose, not values, so
         * the host keeps drawing them below the frame and the frame says so.
         */
        expect(frame.native).toBe(true);
        expect(frame.sections.find((section) => section.id === 'general')?.native).toBe(true);
        expect(frame.fields.map((field) => field.id)).toContain('general.tcpPort');
        for (const field of frame.fields) expect(field.sectionID).toBe('general');
        expect(frame.groups.map((group) => group.id)).toEqual([
            'general-worktrees',
            'general-repositories',
            'general-workspaces',
            'general-network'
        ]);
    });

    it('reports a permanently native section as native, with nothing in it', () => {
        const { surface } = make();
        const harness = mount(surface);
        for (const id of ['plugins', 'remote', 'profiles', 'keybindings', 'labels'] as const) {
            surface.setSection(id);
            const frame = harness.host.getSettingsPresentation();
            expect(frame).toMatchObject({ sectionID: id, native: true });
            expect(frame.fields).toEqual([]);
            expect(frame.groups).toEqual([]);
        }
    });

    /** Appearance: projected fields AND `native: true`, because the host draws the rest below. */
    it('reports a partly projected section as native beside its fields', () => {
        const { surface } = make();
        surface.setSection('appearance');
        const frame = mount(surface).host.getSettingsPresentation();
        expect(frame.native).toBe(true);
        expect(frame.fields.length).toBeGreaterThan(0);
        expect(frame.fields.map((field) => field.id)).toContain('appearance.fontSize');
        expect(frame.groups.map((group) => group.id)).toContain('appearance-terminal');
    });

    it('is frozen, plain JSON, and carries no test id or write target', () => {
        const { surface } = make({ tcpPort: 19400 });
        surface.setSection('general');
        const frame = mount(surface).host.getSettingsPresentation();
        expect(Object.isFrozen(frame)).toBe(true);
        expect(Object.isFrozen(frame.fields)).toBe(true);
        expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
        const port = frame.fields.find((field) => field.id === 'general.tcpPort');
        expect(port).toMatchObject({ kind: 'number', min: 1, max: 65535 });
        for (const key of ['testID', 'rowTestID', 'target', 'default', 'placeholder', 'valueLabel'])
            expect(Object.keys(port ?? {})).not.toContain(key);
    });

    it('publishes a draft, its error and the dirty count without writing anything', async () => {
        const { surface, verbs } = make({ tcpPort: 19400 });
        surface.setSection('general');
        const harness = mount(surface);
        await flush();
        harness.host.call('ui.setSettingsDraft', { fieldID: 'general.tcpPort', text: '99999' });
        await flush();
        const frame = harness.frames.at(-1);
        const port = frame?.fields.find((field) => field.id === 'general.tcpPort');
        expect(port?.draft).toBe('99999');
        expect(port?.error).toContain('between 1 and 65535');
        expect(frame?.dirty).toBe(1);
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
    });

    it('waits for an acknowledgement when the user is moved to another section', async () => {
        const { surface } = make();
        surface.setSection('general');
        const harness = mount(surface);
        await flush();
        // The first frame carries the section the dialog opened on.
        expect(harness.awaited[0]).toBe(true);
        harness.awaited.length = 0;
        surface.setDraft('general.worktreeBasePath', '~/x');
        await flush();
        // A value moving is not something the user is waiting to see repainted elsewhere.
        expect(harness.awaited).toEqual([false]);
        surface.setSection('workspaces');
        await flush();
        expect(harness.awaited.at(-1)).toBe(true);
    });
});

describe('what a presenter may send', () => {
    it('names exactly seven methods, and refuses anything else', () => {
        expect([...SETTINGS_UI_METHODS]).toEqual([
            'ui.getSettingsPresentation',
            'ui.reportPresenterReady',
            'ui.setSettingsSection',
            'ui.setSettingsDraft',
            'ui.commitSettingsField',
            'ui.resetSettingsField',
            'ui.closeSettings'
        ]);
        const harness = mount(make().surface);
        expect(() => harness.host.call('ui.openSettings', {})).toThrow('Unknown window settings method');
        expect(() => harness.host.call('ui.selectView', { slot: 'settings.window' })).toThrow(
            'Unknown window settings method'
        );
    });

    it('refuses an argument object that is not exactly the declared keys', () => {
        const harness = mount(make().surface);
        expect(() => harness.host.call('ui.setSettingsSection', {})).toThrow('Invalid settings arguments');
        expect(() => harness.host.call('ui.setSettingsSection', { id: 'general', extra: 1 })).toThrow(
            'Invalid settings arguments'
        );
        expect(() => harness.host.call('ui.commitSettingsField', { field: 'general.tcpPort' })).toThrow(
            'Invalid settings arguments'
        );
    });

    it('routes to any section the rail lists, native ones included', () => {
        const { surface } = make();
        const harness = mount(surface);
        harness.host.call('ui.setSettingsSection', { id: 'plugins' });
        expect(surface.getSection()).toBe('plugins');
        // The route BACK matters more than the route away: Plugins is where a presenter is
        // switched off, and it is drawn by the bundled panel once the host is routed there.
        expect(harness.host.getSettingsPresentation().native).toBe(true);
        harness.host.call('ui.setSettingsSection', { id: 'general' });
        expect(surface.getSection()).toBe('general');
        expect(() => harness.host.call('ui.setSettingsSection', { id: 'nonesuch' })).toThrow(
            'That settings section does not exist'
        );
    });

    it('refuses a field the current frame did not publish', () => {
        const { surface, verbs } = make({ tcpPort: 0 });
        surface.setSection('general');
        const harness = mount(surface);
        for (const fieldID of [
            // Another section's.
            'workspaces.clipboardWrite',
            // Off screen: the port row is absent while the listener is off.
            'general.tcpPort',
            // Never existed.
            'general.nonesuch'
        ]) {
            expect(() => harness.host.call('ui.commitSettingsField', { fieldID })).toThrow(
                'not in the current section'
            );
            expect(() => harness.host.call('ui.setSettingsDraft', { fieldID, text: '1' })).toThrow(
                'not in the current section'
            );
        }
        surface.setSection('plugins');
        // A native section publishes nothing, so nothing in it can be committed either.
        expect(() => harness.host.call('ui.commitSettingsField', { fieldID: 'general.autoDetectRepos' })).toThrow(
            'not in the current section'
        );
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
    });

    it('refuses a draft longer than the limit, and writes nothing for it', () => {
        const { surface, verbs } = make();
        surface.setSection('general');
        const harness = mount(surface);
        expect(() =>
            harness.host.call('ui.setSettingsDraft', {
                fieldID: 'general.worktreeBasePath',
                text: 'x'.repeat(SETTINGS_LIMITS.valueChars + 1)
            })
        ).toThrow('at most 4096 characters');
        expect(harness.host.getSettingsPresentation().dirty).toBe(0);
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
    });

    it('commits through the surface, which re-resolves the id and dispatches once', () => {
        const { surface, verbs } = make();
        surface.setSection('workspaces');
        const harness = mount(surface);
        harness.host.call('ui.setSettingsDraft', { fieldID: 'workspaces.clipboardWrite', text: 'true' });
        harness.host.call('ui.commitSettingsField', { fieldID: 'workspaces.clipboardWrite' });
        expect(verbs.setGeneralSetting).toHaveBeenCalledTimes(1);
        expect(verbs.setGeneralSetting).toHaveBeenCalledWith('clipboard-write', 'true');
        // Asking again for the value already out is the same ask, not a second config-file write.
        harness.host.call('ui.commitSettingsField', { fieldID: 'workspaces.clipboardWrite' });
        expect(verbs.setGeneralSetting).toHaveBeenCalledTimes(1);
    });

    it('drops a draft on reset without writing the shipped default', () => {
        const { surface, verbs } = make();
        surface.setSection('general');
        const harness = mount(surface);
        harness.host.call('ui.setSettingsDraft', { fieldID: 'general.worktreeBasePath', text: '~/elsewhere' });
        expect(harness.host.getSettingsPresentation().dirty).toBe(1);
        harness.host.call('ui.resetSettingsField', { fieldID: 'general.worktreeBasePath' });
        expect(harness.host.getSettingsPresentation().dirty).toBe(0);
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
    });

    it('closes the dialog, and has no way to open one', () => {
        const harness = mount(make().surface);
        harness.host.call('ui.closeSettings', {});
        expect(harness.closes()).toBe(1);
        expect(() => harness.host.call('ui.openSettings', {})).toThrow('Unknown window settings method');
    });

    it('reports readiness, whoever is painted', () => {
        const harness = mount(make().surface, { visible: false });
        harness.host.call('ui.reportPresenterReady', {});
        expect(harness.ready()).toBe(1);
    });

    it('refuses every mutating call while the dialog is not presented', () => {
        const { surface, verbs } = make();
        surface.setSection('general');
        const harness = mount(surface, { visible: false });
        for (const [method, args] of [
            ['ui.setSettingsSection', { id: 'workspaces' }],
            ['ui.setSettingsDraft', { fieldID: 'general.worktreeBasePath', text: '~/x' }],
            ['ui.commitSettingsField', { fieldID: 'general.worktreeBasePath' }],
            ['ui.resetSettingsField', { fieldID: 'general.worktreeBasePath' }],
            ['ui.closeSettings', {}]
        ] as const)
            expect(() => harness.host.call(method, args)).toThrow('not presented right now');
        expect(surface.getSection()).toBe('general');
        expect(harness.closes()).toBe(0);
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
    });

    /**
     * The line-break refusal, which is a SECURITY boundary rather than a nicety.
     *
     * Both config files are line-oriented and their writers join lines with a newline, so a text
     * value carrying one does not write a setting - it writes the setting, then whatever the rest of
     * the string parses as. `command`, `remote-daemon`, `profile` and `keybind` are all one `\n`
     * away from a font stack, and none of them is in `WS_WRITABLE_GENERAL_KEYS`. The draft is held
     * with the reason under it; nothing leaves.
     */
    it('refuses a line break or a control character in a text field, and writes nothing', () => {
        const { surface, verbs } = make();
        const harness = mount(surface);
        for (const [sectionID, fieldID, text] of [
            ['general', 'general.worktreeBasePath', '~/work\ncommand = rm -rf ~'],
            ['appearance', 'appearance.fontFamily', 'Mono\nkeybind = super+q=quit'],
            ['appearance', 'appearance.fontFamily', 'Mono\r\nremote-daemon = evil'],
            ['general', 'general.worktreeBasePath', '~/work\u0000command = x']
        ] as const) {
            surface.setSection(sectionID);
            harness.host.call('ui.setSettingsDraft', { fieldID, text });
            const held = harness.host
                .getSettingsPresentation()
                .fields.find((field) => field.id === fieldID);
            // The draft is KEPT - it is what the user has in front of them - with the reason.
            expect(held?.draft).toBe(text);
            expect(held?.error).toContain('cannot contain line breaks or control characters');
            harness.host.call('ui.commitSettingsField', { fieldID });
            expect(
                harness.host.getSettingsPresentation().fields.find((field) => field.id === fieldID)?.error
            ).toContain('cannot contain line breaks or control characters');
            harness.host.call('ui.resetSettingsField', { fieldID });
        }
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
        expect(verbs.setGhosttySetting).not.toHaveBeenCalled();
    });

    /** The step grid is published as a constraint, so it is enforced as one. */
    it('refuses a number off the published step grid', () => {
        const { surface, verbs } = make();
        surface.setSection('appearance');
        const harness = mount(surface);
        const width = harness.host
            .getSettingsPresentation()
            .fields.find((field) => field.id === 'appearance.sparklineWidth');
        expect(width).toMatchObject({ min: 16, max: 80, step: 2 });
        harness.host.call('ui.setSettingsDraft', { fieldID: 'appearance.sparklineWidth', text: '19' });
        harness.host.call('ui.commitSettingsField', { fieldID: 'appearance.sparklineWidth' });
        expect(
            harness.host
                .getSettingsPresentation()
                .fields.find((field) => field.id === 'appearance.sparklineWidth')?.error
        ).toContain('must be in steps of 2');
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
        // …and a value ON the grid goes out, floating-point arithmetic notwithstanding.
        harness.host.call('ui.setSettingsDraft', { fieldID: 'appearance.backgroundOpacity', text: '0.85' });
        harness.host.call('ui.commitSettingsField', { fieldID: 'appearance.backgroundOpacity' });
        expect(verbs.setGhosttySetting).toHaveBeenCalledWith('background-opacity', '0.85');
    });

    it('refuses every mutating call for a field the host has disabled', () => {
        const { surface, verbs } = make({}, { disabled: (fieldID) => fieldID === 'general.autoDetectRepos' });
        surface.setSection('general');
        const harness = mount(surface);
        expect(
            harness.host
                .getSettingsPresentation()
                .fields.find((field) => field.id === 'general.autoDetectRepos')?.disabled
        ).toBe(true);
        for (const [method, args] of [
            ['ui.setSettingsDraft', { fieldID: 'general.autoDetectRepos', text: 'false' }],
            ['ui.commitSettingsField', { fieldID: 'general.autoDetectRepos' }],
            ['ui.resetSettingsField', { fieldID: 'general.autoDetectRepos' }]
        ] as const)
            expect(() => harness.host.call(method, args)).toThrow('cannot be changed right now');
        // The rest of the section is unaffected: disabling is per field, not per section.
        harness.host.call('ui.setSettingsDraft', { fieldID: 'general.worktreeBasePath', text: '~/x' });
        expect(harness.host.getSettingsPresentation().dirty).toBe(1);
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
    });

    /**
     * The budget FAILS the placement as well as rejecting the call: a call loop is not a
     * recoverable error, and the bundled panel has to be able to take the dialog back from it.
     */
    it('fails the presenter when it runs past its call budget', () => {
        const harness = mount(make().surface);
        expect(() => {
            for (let index = 0; index <= SETTINGS_LIMITS.presenterCalls; index += 1)
                harness.host.call('ui.reportPresenterReady', {});
        }).toThrow('call budget');
        expect(harness.failures).toEqual(['This presenter exceeded its window settings call budget.']);
    });

    /**
     * An undeliverable frame is not something a watchdog can save.
     *
     * The SDK acknowledges an error exactly as it acknowledges a frame, so arming the ack timer for
     * one would be cleared by the presenter's own ack while the dialog sat empty. So the placement
     * fails NOW, which is what hands it back to the bundled panel with every draft still in the
     * surface.
     */
    it('fails the placement outright when a frame cannot be delivered', async () => {
        const { surface } = make();
        // A section title the size of the whole budget: `pluginJSON` refuses anything over 256 KiB,
        // and there is no smaller frame to fall back to.
        const huge = 'x'.repeat(SETTINGS_LIMITS.payloadBytes + 1);
        const oversized = {
            ...surface,
            getSnapshot: () => ({
                ...surface.getSnapshot(),
                groups: [{ id: 'general-worktrees', sectionID: 'general', title: huge, hint: null, testID: 'x' }]
            })
        } as SettingsSurface;
        const harness = mount(oversized);
        await flush();
        expect(harness.errors.map((error) => error.message)).toEqual([
            'Window settings snapshot is invalid or exceeds 256 KiB.'
        ]);
        expect(harness.failures).toEqual(['Window settings snapshot is invalid or exceeds 256 KiB.']);
        expect(harness.frames).toEqual([]);
        expect(() => harness.host.getSettingsPresentation()).toThrow('exceeds 256 KiB');
    });

    it('answers nothing at all after disposal', () => {
        const harness = mount(make().surface);
        harness.host.dispose();
        expect(() => harness.host.getSettingsPresentation()).toThrow('unavailable after disposal');
        expect(() => harness.host.call('ui.closeSettings', {})).toThrow('unavailable after disposal');
    });
});

describe('the failure latch', () => {
    it('is per generation, and an explicit clear is what lifts it', () => {
        const seen: number[] = [];
        const stop = subscribeSettingsPresenters(() => seen.push(1));
        expect(settingsPresenterFailures()[SETTINGS_PLACEMENT]).toBeUndefined();
        noteSettingsPresenterFailure(SETTINGS_PLACEMENT, 'view:r1:i1', 'crashed');
        expect(settingsPresenterFailures()[SETTINGS_PLACEMENT]).toEqual({
            generation: 'view:r1:i1',
            detail: 'crashed'
        });
        // The same generation failing twice is one failure, so a second watchdog cannot restate it.
        const held = settingsPresenterFailures();
        noteSettingsPresenterFailure(SETTINGS_PLACEMENT, 'view:r1:i1', 'crashed again');
        expect(settingsPresenterFailures()).toBe(held);
        // A reload moves the generation, which is a different failure.
        noteSettingsPresenterFailure(SETTINGS_PLACEMENT, 'view:r2:i2', 'crashed later');
        expect(settingsPresenterFailures()[SETTINGS_PLACEMENT]?.generation).toBe('view:r2:i2');
        clearSettingsPresenterFailure(SETTINGS_PLACEMENT);
        expect(settingsPresenterFailures()[SETTINGS_PLACEMENT]).toBeUndefined();
        expect(seen.length).toBeGreaterThan(0);
        stop();
    });
});
