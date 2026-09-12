/**
 * The settings surface: routing, drafts, and the write queue.
 *
 * The claims worth stating out loud, because each one is a defect this module exists to prevent:
 *
 *   - a mutating call names an ID, and an id that is unknown, native, off screen or disabled
 *     REFUSES rather than writing something adjacent;
 *   - an invalid draft is kept and explained, and sends nothing;
 *   - a write is dispatched at most once, and a late acknowledgement cannot replace a newer value;
 *   - a daemon broadcast is authoritative for the value but never yanks a field the user is in;
 *   - `getSnapshot` is stable between changes, which is what `useSyncExternalStore` requires.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    SETTINGS_LIMITS,
    type SettingsSectionID,
    type SettingsTextFieldDescriptor,
    type SettingsTransportStatus
} from './contract';
import { createSettingsSurface, type SettingsSurface } from './surface';
import type { SettingsActions } from './types';

type General = Partial<WsSettingsSnapshot['general']>;

const snapshot = (general: General = {}): WsSettingsSnapshot => ({
    ...DEFAULT_WS_SETTINGS,
    general: { ...DEFAULT_WS_SETTINGS.general, ...general }
});

/** Every surface made by a test, disposed in `afterEach` so no 5 s settle timer outlives one. */
const surfaces: SettingsSurface[] = [];

function harness(initial: General = {}, options: { readonly hostRouting?: boolean } = {}) {
    let settings = snapshot(initial);
    let section: SettingsSectionID | null = 'general';
    let transport: SettingsTransportStatus | null = null;
    const disabled = new Set<string>();
    const writes: { key: string; value: string | null }[] = [];
    const actions: SettingsActions = {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => writes.push({ key, value }),
        setGhosttySetting: (key, value) => writes.push({ key, value }),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
    const surface = createSettingsSurface({
        settings: () => settings,
        actions: () => actions,
        ...(options.hostRouting === false
            ? {}
            : {
                  section: {
                      get: () => section,
                      set: (id) => {
                          section = id;
                      }
                  }
              }),
        transport: () => transport,
        disabled: (fieldID) => disabled.has(fieldID)
    });
    surfaces.push(surface);
    return {
        surface,
        writes,
        disabled,
        /** The daemon broadcast: a new snapshot, then the reconciliation hook. */
        broadcast(general: General): void {
            settings = snapshot(general);
            surface.settingsChanged();
        },
        /** A new snapshot with NO hook call - a render that beat the broadcast to the surface. */
        swap(general: General): void {
            settings = snapshot(general);
        },
        /** What the daemon's listener did - flags, never prose (`SettingsTransportStatus`). */
        setTransport(next: SettingsTransportStatus | null): void {
            transport = next;
        },
        routedSection: (): SettingsSectionID | null => section,
        field(id: string) {
            const found = surface.getSnapshot().fields.find((one) => one.id === id);
            if (found === undefined) throw new Error(`no projected field: ${id}`);
            return found;
        }
    };
}

afterEach(() => {
    for (const created of surfaces.splice(0)) created.dispose();
    vi.useRealTimers();
});

describe('routing', () => {
    it('describes every section, including the ones it never projects', () => {
        const { surface } = harness();
        const snapshotted = surface.getSnapshot();
        expect(snapshotted.sections.map((section) => section.id)).toContain('plugins');
        expect(snapshotted.sectionID).toBe('general');
        expect(snapshotted.native).toBe(false);
        expect(snapshotted.fields.length).toBeGreaterThan(0);
    });

    it('projects nothing for a native section, and still names it', () => {
        const { surface } = harness();
        surface.setSection('plugins');
        const snapshotted = surface.getSnapshot();
        expect(snapshotted.sectionID).toBe('plugins');
        expect(snapshotted.native).toBe(true);
        expect(snapshotted.fields).toEqual([]);
        expect(snapshotted.groups).toEqual([]);
        expect(snapshotted.sections.find((section) => section.id === 'plugins')?.kind).toBe('native');
    });

    it('refuses an id the catalog does not have, and routes nowhere', () => {
        const { surface, routedSection } = harness();
        expect(() => {
            surface.setSection('nonesuch');
        }).toThrow('Unknown settings section');
        expect(routedSection()).toBe('general');
    });

    it('writes through the host’s own routing state when one is supplied', () => {
        const { surface, routedSection } = harness();
        surface.setSection('workspaces');
        expect(routedSection()).toBe('workspaces');
        expect(surface.getSection()).toBe('workspaces');
    });

    it('holds the section itself when the host does not', () => {
        const { surface } = harness({}, { hostRouting: false });
        expect(surface.getSection()).toBe('general');
        surface.setSection('workspaces');
        expect(surface.getSection()).toBe('workspaces');
    });
});

describe('drafts', () => {
    it('keeps an invalid draft, explains it, and sends nothing', () => {
        const { surface, writes, field } = harness({ tcpPort: 19400 });
        surface.setDraft('general.tcpPort', 'seventy');
        expect(field('general.tcpPort')).toMatchObject({ draft: 'seventy', error: 'Enter a valid number.' });
        // The authoritative value is untouched: the control still knows what the file says.
        expect(field('general.tcpPort')).toMatchObject({ value: 19400 });
        expect(writes).toEqual([]);
        expect(surface.getSnapshot().dirty).toBe(1);
    });

    it('clears the error as soon as the draft parses again', () => {
        const { surface, field } = harness({ tcpPort: 19400 });
        surface.setDraft('general.tcpPort', 'seventy');
        surface.setDraft('general.tcpPort', '19500');
        expect(field('general.tcpPort').error).toBeUndefined();
    });

    it('discards a draft and its error on reset, without writing a default', () => {
        const { surface, writes, field } = harness({ tcpPort: 19400 });
        surface.setDraft('general.tcpPort', 'seventy');
        surface.resetField('general.tcpPort');
        expect(field('general.tcpPort').draft).toBeUndefined();
        expect(field('general.tcpPort').error).toBeUndefined();
        expect(writes).toEqual([]);
        expect(surface.getSnapshot().dirty).toBe(0);
    });

    it('refuses a draft for a field that is not there to type into', () => {
        const { surface } = harness({ tcpPort: 0 });
        expect(() => {
            surface.setDraft('general.tcpPort', '19500');
        }).toThrow('not on screen');
        expect(() => {
            surface.setDraft('profiles.env', 'anything');
        }).toThrow('Unknown settings field');
    });
});

describe('commits', () => {
    it('writes the catalog’s key and the encoded value, once', () => {
        const { surface, writes } = harness({ tcpPort: 19400 });
        surface.setDraft('general.tcpPort', '19500');
        surface.commitField('general.tcpPort');
        expect(writes).toEqual([{ key: 'tcp-port', value: '19500' }]);
        // The same ask again is the same ask: a presenter repeating itself is not two writes.
        surface.commitField('general.tcpPort');
        expect(writes).toHaveLength(1);
    });

    it('takes a value directly for the controls that have no draft phase', () => {
        const { surface, writes } = harness();
        surface.commitField('workspaces.clipboardWrite', true);
        expect(writes).toEqual([{ key: 'clipboard-write', value: 'true' }]);
    });

    it.each([
        ['unknown', 'profiles.env'],
        ['off screen', 'general.tcpPort']
    ])('throws for a field that is %s, and writes nothing', (_why, fieldID) => {
        const { surface, writes } = harness({ tcpPort: 0 });
        expect(() => {
            surface.commitField(fieldID, '1');
        }).toThrow();
        expect(writes).toEqual([]);
    });

    it('throws for a disabled field, and writes nothing', () => {
        const { surface, writes, disabled } = harness();
        disabled.add('workspaces.clipboardWrite');
        expect(() => {
            surface.commitField('workspaces.clipboardWrite', true);
        }).toThrow('cannot be changed');
        expect(writes).toEqual([]);
    });

    // The whole-set writers (profiles, remote daemons, label presets) are not fields: they have no
    // per-key target, so there is nothing for a field id to name and the call is refused.
    it('has no field for the whole-set writers', () => {
        const { surface, writes } = harness();
        for (const id of ['profiles', 'remoteDaemons', 'labelPresets', 'keybindings.split_right'])
            expect(() => {
                surface.commitField(id, 'x');
            }).toThrow('Unknown settings field');
        expect(writes).toEqual([]);
    });

    it('keeps the draft and sends nothing when the value is out of bounds', () => {
        const { surface, writes, field } = harness({ focusFollowsMouse: true });
        surface.setSection('workspaces');
        surface.setDraft('workspaces.focusDelay', '900');
        surface.commitField('workspaces.focusDelay');
        expect(writes).toEqual([]);
        expect(field('workspaces.focusDelay')).toMatchObject({ draft: '900' });
        expect(field('workspaces.focusDelay').error).toContain('between 0 and 500');
    });

    // SET-020, as per-field data rather than a coercion inside the control: junk commits the
    // shipped default, and the port row writes whether or not the value moved. Both were rules the
    // old `GeneralTab` control enforced on its own; there is one write path now, so they live here.
    it.each([
        ['junk', 'seventy', '19400'],
        ['a radix the parser does not take', '0x1F90', '19400'],
        ['a leading integer with trailing junk', '8080abc', '8080'],
        ['an empty field', '', '19400'],
        ['a port past the ceiling', '70000', '19400']
    ])('commits the shipped default for %s', (_why, typed, written) => {
        const { surface, writes } = harness({ tcpPort: 20500 });
        surface.setDraft('general.tcpPort', typed);
        surface.commitField('general.tcpPort');
        expect(writes).toEqual([{ key: 'tcp-port', value: written }]);
    });

    it('writes the port row even when the value has not moved', () => {
        const { surface, writes, field } = harness({ tcpPort: 19400 });
        surface.setDraft('general.tcpPort', 'seventy');
        surface.commitField('general.tcpPort');
        // The default IS the live value here, and the write still goes out: a control whose Apply
        // does nothing visible is worse than one redundant line in the config file.
        expect(writes).toEqual([{ key: 'tcp-port', value: '19400' }]);
        expect(field('general.tcpPort').error).toBeUndefined();
    });

    it('does not write a value the file already holds', () => {
        const { surface, writes, field } = harness();
        surface.setDraft('general.worktreeBasePath', '~/kelpi/worktrees/<repo>');
        surface.commitField('general.worktreeBasePath');
        expect(writes).toEqual([]);
        expect(field('general.worktreeBasePath').draft).toBeUndefined();
    });

    it('marks the field busy until the broadcast arrives', () => {
        const { surface, field, broadcast } = harness({ tcpPort: 19400 });
        surface.commitField('general.tcpPort', '19500');
        expect(field('general.tcpPort').busy).toBe(true);
        broadcast({ tcpPort: 19500 });
        expect(field('general.tcpPort').busy).toBeUndefined();
        expect(field('general.tcpPort')).toMatchObject({ value: 19500 });
        expect(field('general.tcpPort').draft).toBeUndefined();
    });
});

describe('the write queue', () => {
    it('holds the newer value behind the one in flight, and a late acknowledgement cannot win', () => {
        const { surface, writes, field, broadcast } = harness({ tcpPort: 19400 });
        surface.commitField('general.tcpPort', '19500');
        surface.commitField('general.tcpPort', '19600');
        // One write out: the second is desired, not dispatched.
        expect(writes).toEqual([{ key: 'tcp-port', value: '19500' }]);
        expect(field('general.tcpPort').draft).toBe('19600');

        // The first write lands. The acknowledgement is for an OLDER edit, so it moves the value
        // and releases the queue but must not replace the newer draft.
        broadcast({ tcpPort: 19500 });
        expect(writes).toEqual([
            { key: 'tcp-port', value: '19500' },
            { key: 'tcp-port', value: '19600' }
        ]);
        expect(field('general.tcpPort')).toMatchObject({ value: 19500, draft: '19600', busy: true });

        broadcast({ tcpPort: 19600 });
        expect(writes).toHaveLength(2);
        expect(field('general.tcpPort')).toMatchObject({ value: 19600 });
        expect(field('general.tcpPort').draft).toBeUndefined();
        expect(surface.getSnapshot().dirty).toBe(0);
    });

    it('coalesces a repeated ask rather than queueing it twice', () => {
        const { surface, writes, broadcast } = harness({ tcpPort: 19400 });
        surface.commitField('general.tcpPort', '19500');
        surface.commitField('general.tcpPort', '19600');
        surface.commitField('general.tcpPort', '19600');
        broadcast({ tcpPort: 19500 });
        expect(writes.map((write) => write.value)).toEqual(['19500', '19600']);
    });

    it('never sends a verb from a read: a release during getSnapshot drains on a microtask', async () => {
        const { surface, writes, swap, field } = harness({ tcpPort: 19400 });
        surface.commitField('general.tcpPort', '19500');
        surface.commitField('general.tcpPort', '19600');
        swap({ tcpPort: 19500 });
        // `getSnapshot` runs inside a React render. It reconciles and releases the queue - and
        // sends nothing, because a socket verb dispatched mid-render is a side effect in a read.
        expect(field('general.tcpPort')).toMatchObject({ value: 19500, draft: '19600' });
        expect(writes).toHaveLength(1);
        await Promise.resolve();
        expect(writes.map((write) => write.value)).toEqual(['19500', '19600']);
    });

    it('stops waiting for an acknowledgement that never comes', () => {
        vi.useFakeTimers();
        const { surface, field } = harness({ tcpPort: 19400 });
        surface.commitField('general.tcpPort', '19500');
        expect(field('general.tcpPort').busy).toBe(true);
        vi.advanceTimersByTime(SETTINGS_LIMITS.writeSettleMs + 1);
        // The queue is released and the control goes back to what the file actually says, rather
        // than showing a value the daemon never took.
        expect(field('general.tcpPort').busy).toBeUndefined();
        expect(field('general.tcpPort').draft).toBeUndefined();
        expect(field('general.tcpPort')).toMatchObject({ value: 19400 });
    });
});

describe('reconciliation', () => {
    it('adopts a value changed elsewhere and drops the stale draft', () => {
        const { surface, field, broadcast } = harness({ tcpPort: 19400 });
        surface.setDraft('general.tcpPort', '19500');
        broadcast({ tcpPort: 19800 });
        expect(field('general.tcpPort')).toMatchObject({ value: 19800 });
        expect(field('general.tcpPort').draft).toBeUndefined();
    });

    it('does not yank a field the user is still in', () => {
        const { surface, field, broadcast } = harness({ tcpPort: 19400 });
        surface.setEditing('general.tcpPort', true);
        surface.setDraft('general.tcpPort', '19500');
        broadcast({ tcpPort: 19800 });
        expect(field('general.tcpPort')).toMatchObject({ value: 19800, draft: '19500' });
        surface.setEditing('general.tcpPort', false);
    });

    it('keeps a draft that is carrying an error worth reading', () => {
        const { surface, field, broadcast } = harness({ tcpPort: 19400 });
        surface.setDraft('general.tcpPort', 'seventy');
        broadcast({ tcpPort: 19800 });
        expect(field('general.tcpPort')).toMatchObject({ draft: 'seventy', error: 'Enter a valid number.' });
    });

    it('follows a snapshot the host swapped in without announcing it', () => {
        // `settingsChanged` is the hook, but a surface that only ever believed the hook would show
        // a stale window whenever a render beat the broadcast. A fresh snapshot IDENTITY is enough:
        // `getSnapshot` reconciles before it builds, so the projection cannot lag the props.
        const { surface, field, swap } = harness({ tcpPort: 19400 });
        surface.setDraft('general.tcpPort', '19500');
        swap({ tcpPort: 19900 });
        expect(field('general.tcpPort')).toMatchObject({ value: 19900 });
        expect(field('general.tcpPort').draft).toBeUndefined();
    });

    it('tracks a row while it is off screen, so it comes back correct', () => {
        const { surface, field, broadcast } = harness({ tcpPort: 19400 });
        broadcast({ tcpPort: 0 });
        expect(surface.getSnapshot().fields.some((one) => one.id === 'general.tcpPort')).toBe(false);
        broadcast({ tcpPort: 22000 });
        expect(field('general.tcpPort')).toMatchObject({ value: 22000 });
        expect(field('general.tcpPort').draft).toBeUndefined();
    });
});

describe('the snapshot', () => {
    it('is stable between changes and new after each one', () => {
        const { surface, broadcast } = harness({ tcpPort: 19400 });
        const first = surface.getSnapshot();
        expect(surface.getSnapshot()).toBe(first);
        surface.setDraft('general.tcpPort', '195');
        const second = surface.getSnapshot();
        expect(second).not.toBe(first);
        expect(surface.getSnapshot()).toBe(second);
        broadcast({ tcpPort: 19500 });
        expect(surface.getSnapshot()).not.toBe(second);
    });

    it('re-renders a caption the settings snapshot cannot supply', () => {
        const { surface, setTransport, field } = harness({ tcpPort: 19400 });
        expect(field('general.tcpListener').detail).toBe('Listening on 127.0.0.1:19400 (as of daemon start).');
        const before = surface.getSnapshot();
        setTransport({ state: 'failed', host: '127.0.0.1', port: 19400 });
        expect(surface.getSnapshot()).not.toBe(before);
        // The surface writes the sentence: the host had no way to pass one, and no way to pass
        // the OS error behind it either.
        expect(field('general.tcpListener').detail).toBe(
            'Port 19400 is unavailable. Unix-socket clients are unaffected.'
        );
    });

    it('re-renders when the host disables a field without touching a value', () => {
        const { surface, disabled, field } = harness({ tcpPort: 19400 });
        const before = surface.getSnapshot();
        expect(field('general.tcpPort').disabled).toBeUndefined();
        disabled.add('general.tcpPort');
        expect(surface.getSnapshot()).not.toBe(before);
        expect(field('general.tcpPort').disabled).toBe(true);
    });

    it('tells subscribers, and stops when they leave', () => {
        const { surface } = harness();
        let seen = 0;
        const off = surface.subscribe(() => {
            seen += 1;
        });
        surface.setSection('workspaces');
        expect(seen).toBe(1);
        off();
        surface.setSection('general');
        expect(seen).toBe(1);
    });

    it('carries the group each field belongs to, so a renderer can rebuild the cards', () => {
        const { surface } = harness();
        const { groups, fields } = surface.getSnapshot();
        expect(groups.map((group) => group.id)).toEqual([
            'general-worktrees',
            'general-repositories',
            'general-workspaces',
            'general-network'
        ]);
        for (const field of fields) expect(groups.some((group) => group.id === field.groupID)).toBe(true);
        const basePath = fields.find((one) => one.id === 'general.worktreeBasePath') as SettingsTextFieldDescriptor;
        expect(basePath.testID).toBe('worktree-base-path');
        expect(basePath.placeholder).toBe('~/kelpi/worktrees/<repo>');
    });
});

describe('disposal', () => {
    it('cancels the queue’s timers and goes quiet', () => {
        vi.useFakeTimers();
        const { surface, writes } = harness({ tcpPort: 19400 });
        surface.commitField('general.tcpPort', '19500');
        surface.dispose();
        vi.advanceTimersByTime(SETTINGS_LIMITS.writeSettleMs * 2);
        surface.commitField('general.tcpPort', '19600');
        expect(writes).toEqual([{ key: 'tcp-port', value: '19500' }]);
    });
});
