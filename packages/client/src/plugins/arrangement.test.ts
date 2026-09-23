import { describe, expect, it } from 'vitest';

import {
    DEFAULT_ARRANGEMENT,
    arrangementStorageKey,
    isArrangementSlotBand,
    readArrangement,
    sameArrangement,
    setBandVisible,
    toggleZenMode,
    zenModeActive
} from './arrangement';

describe('the root arrangement', () => {
    it('opens with every band showing except the Inspector, which is today’s launch state', () => {
        expect(DEFAULT_ARRANGEMENT).toEqual({
            visible: { topbar: true, statusbar: true, 'panel.bottom': true, sidebar: true, inspector: false },
            zenSnapshot: null
        });
        expect(zenModeActive(DEFAULT_ARRANGEMENT)).toBe(false);
    });

    it('lives beside the view selections, under the same identity suffix', () => {
        expect(arrangementStorageKey('daemon-1')).toBe('kelpi.workbench.layout.v1:daemon-1');
        // The v1 selections key is untouched, which is why there is no migration.
        expect(arrangementStorageKey('daemon-1').startsWith('kelpi.workbench.v1:')).toBe(false);
    });

    it('names exactly three slot bands; the sidebars are hosts, and the grid never hides', () => {
        expect(['topbar', 'statusbar', 'panel.bottom'].every(isArrangementSlotBand)).toBe(true);
        for (const other of ['workspace', 'sidebar', 'sidebar.primary', 'inspector', 'pane.chrome', 'settings.window']) expect(isArrangementSlotBand(other)).toBe(false);
    });

    it('shows and hides one band in React’s SetStateAction shape, and keeps identity on a no-op', () => {
        const hidden = setBandVisible(DEFAULT_ARRANGEMENT, 'topbar', false);
        expect(hidden.visible.topbar).toBe(false);
        expect(setBandVisible(hidden, 'topbar', (visible) => !visible).visible.topbar).toBe(true);
        expect(setBandVisible(DEFAULT_ARRANGEMENT, 'sidebar', true)).toBe(DEFAULT_ARRANGEMENT);
    });

    it('enters Zen Mode by recording the five and hiding them, and leaves by restoring exactly those', () => {
        const before = setBandVisible(setBandVisible(DEFAULT_ARRANGEMENT, 'inspector', true), 'statusbar', false);
        const zen = toggleZenMode(before);
        expect(zenModeActive(zen)).toBe(true);
        expect(Object.values(zen.visible)).toEqual([false, false, false, false, false]);
        expect(zen.zenSnapshot).toEqual(before.visible);
        // The individual toggles keep working inside Zen Mode…
        const peek = setBandVisible(zen, 'sidebar', true);
        expect(peek.visible.sidebar).toBe(true);
        expect(zenModeActive(peek)).toBe(true);
        // …and leaving restores what was recorded, whatever was toggled in between.
        expect(toggleZenMode(peek)).toEqual(before);
    });

    it('reads a saved value back, and anything unusable as the defaults', () => {
        const zen = toggleZenMode(DEFAULT_ARRANGEMENT);
        expect(readArrangement(JSON.parse(JSON.stringify(zen)))).toEqual(zen);
        for (const bad of [null, 'zen', [], {}, { visible: { topbar: 'yes' } }, { visible: { topbar: true } }]) {
            expect(readArrangement(bad)).toBe(DEFAULT_ARRANGEMENT);
        }
        // A corrupt snapshot drops Zen Mode but keeps the bands the user can see.
        const partial = readArrangement({ visible: zen.visible, zenSnapshot: { topbar: 1 } });
        expect(partial).toEqual({ visible: zen.visible, zenSnapshot: null });
        // Unknown extra keys are not carried.
        expect(readArrangement({ visible: { ...DEFAULT_ARRANGEMENT.visible, extra: true }, zenSnapshot: null })).toEqual(DEFAULT_ARRANGEMENT);
    });

    it('compares by value', () => {
        expect(sameArrangement(DEFAULT_ARRANGEMENT, readArrangement(JSON.parse(JSON.stringify(DEFAULT_ARRANGEMENT))))).toBe(true);
        expect(sameArrangement(DEFAULT_ARRANGEMENT, toggleZenMode(DEFAULT_ARRANGEMENT))).toBe(false);
        expect(sameArrangement(DEFAULT_ARRANGEMENT, setBandVisible(DEFAULT_ARRANGEMENT, 'inspector', true))).toBe(false);
    });
});
