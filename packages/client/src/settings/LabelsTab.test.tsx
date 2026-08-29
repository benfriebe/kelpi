import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChromeLabelPreset } from '../chrome';
import { LABEL_GRID_MIN_WIDTH, LabelsTab } from './LabelsTab';
import type { LabelledWorkspace } from './model';
import type { SettingsActions } from './types';

interface Recorded {
    readonly added: { name: string; color: string; textColor?: string | null | undefined }[];
    readonly updated: {
        id: string;
        name?: string | undefined;
        color?: string | undefined;
        textColor?: string | null | undefined;
    }[];
    readonly removed: string[];
    readonly moved: { id: string; index: number }[];
}

function actions(): SettingsActions & { readonly log: Recorded } {
    const log: Recorded = { added: [], updated: [], removed: [], moved: [] };
    return {
        log,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: (input) => log.added.push(input),
        updateLabelPreset: (input) => log.updated.push(input),
        removeLabelPreset: (id) => log.removed.push(id),
        moveLabelPreset: (input) => log.moved.push(input)
    };
}

const PRESETS: readonly ChromeLabelPreset[] = [
    { name: 'ship', color: { kind: 'named', color: 'gray' }, textColor: null },
    { name: 'wip', color: { kind: 'named', color: 'blue' }, textColor: null }
];

function setup(workspaces: readonly LabelledWorkspace[] = [], presets = PRESETS) {
    const bound = actions();
    render(<LabelsTab presets={presets} workspaces={workspaces} actions={bound} bucket="dark" />);
    return bound;
}

afterEach(cleanup);

describe('the label preset list', () => {
    it('lists presets with their color and how many workspaces wear them', () => {
        setup([{ labels: ['ship'] }, { labels: ['ship'] }]);
        expect(screen.getByTestId('label-chip-ship').dataset['color']).toBe('gray');
        expect(screen.getByTestId('label-preset-ship').textContent).toContain('2 workspaces');
        expect(screen.getByTestId('label-preset-wip').textContent).toContain('unused');
    });

    it('shows an empty state rather than a bare list', () => {
        setup([], []);
        expect(screen.getByTestId('labels-empty')).toBeDefined();
    });

    /*
     * §N38 SWAP — the palette lives in the flyover, so the gesture opens it first. The claim is
     * unchanged: a swatch writes §6.2's one-string token through `update-label-preset`, and the
     * swatch that is ALREADY set writes nothing (`aria-pressed` is not a toggle).
     */
    it('recolors through the flyover’s palette, and no-ops on the current color', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-color-ship-trigger'));
        fireEvent.click(screen.getByTestId('label-flyover-bg-purple'));
        expect(bound.log.updated).toEqual([{ id: 'ship', color: 'purple' }]);
        fireEvent.click(screen.getByTestId('label-flyover-close'));

        fireEvent.click(screen.getByTestId('label-color-wip-trigger'));
        fireEvent.click(screen.getByTestId('label-flyover-bg-blue'));
        expect(bound.log.updated).toHaveLength(1);
    });

    /*
     * §N32 SWAP — this was "type a name into the composer, press Add". The composer is gone, so
     * the claim it carried (a new preset is created GRAY, the one default every route into this
     * list shares) is now made about the mint, and about the mint's payload being the CLI
     * back-fill's payload rather than merely resembling it.
     */
    it('mints a preset in gray, with the same payload the CLI back-fill writes', () => {
        const bound = setup([{ labels: ['adopt-me'] }]);
        fireEvent.click(screen.getByTestId('label-add'));
        expect(bound.log.added).toEqual([{ name: 'New label', color: 'gray' }]);
        // The orphan adoption below IS the `workspace label` back-fill's write (§6.5/§6.6): the
        // GUI mint has to be indistinguishable from it, or a GUI preset and a CLI preset would
        // round-trip differently.
        fireEvent.click(screen.getByTestId('label-adopt-adopt-me'));
        const [minted, backFilled] = bound.log.added;
        expect(Object.keys(minted ?? {})).toEqual(Object.keys(backFilled ?? {}));
        expect(minted?.color).toBe(backFilled?.color);
    });

    it('renames on Enter, and ignores an unchanged or empty name', () => {
        const bound = setup();
        const field = screen.getByTestId('label-rename-field-ship') as HTMLInputElement;
        fireEvent.change(field, { target: { value: 'shipped' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(bound.log.updated).toEqual([{ id: 'ship', name: 'shipped' }]);

        // Unchanged: Enter on the stored name writes nothing (`commitRename`'s first guard).
        fireEvent.change(field, { target: { value: 'ship' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(bound.log.updated).toHaveLength(1);

        // Empty: the field snaps back to the stored name and still writes nothing.
        fireEvent.change(field, { target: { value: '   ' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(bound.log.updated).toHaveLength(1);
        expect(field.value).toBe('ship');
    });
});

/*
 * H25 / H26 / H27 — the tab's SHAPE, which `LabelPresetsSettingsView.swift:4-12` says out loud
 * is the point: fixed columns so the wells, the "Aa" sample, the chip and the trash line up
 * down the tab and with the add row.
 */
describe('the tab’s shape (H25/H26/H27)', () => {
    /** Every direct child of a row, in DOM order — the row's grid cells. */
    function cells(testID: string): HTMLElement[] {
        return Array.from(screen.getByTestId(testID).children) as HTMLElement[];
    }

    /*
     * H25: `VStack(spacing: 0) { addRow; Divider(); List }` — the add affordance is the FIRST
     * thing on the tab, not the last control under a list that can be longer than the window.
     *
     * §N32 SWAP: the thing in that first position is now one button rather than a composer row.
     * The POSITION is the assertion, and it is unchanged.
     */
    it('puts the Add button above the preset list, with a divider between them', () => {
        setup();
        const section = screen.getByTestId('label-presets');
        const order = Array.from(section.querySelectorAll<HTMLElement>('[data-testid]'))
            .map((node) => node.dataset['testid'] ?? '')
            .filter(
                (id) => id === 'label-add' || id === 'label-add-divider' || id.startsWith('label-preset-')
            );
        expect(order).toEqual([
            'label-add',
            'label-add-divider',
            'label-preset-ship',
            'label-preset-wip'
        ]);
    });

    /*
     * H26: one grid line per row, on LabelCol's widths — not a two-line stacked card.
     *
     * §N32 SWAP: the loop no longer includes the composer, because there is no composer.
     *
     * §N38 SWAP (owner-directed): one template pinned in place of another, and both numbers that
     * moved are accounted for in `LabelsTab.tsx`'s `LABEL_NAME_MIN`. The pinned string was
     * `150px minmax(160px,1fr) 124px 80px 44px 40px` — the Swift's two colour tracks plus §N36(3)'s
     * floor. The flyover takes BOTH colour controls out of the row, so:
     *
     *   · `bgColor` 150 + `textColor` 124 → **one 24 px swatch-trigger track**;
     *   · six tracks become five, so one 10 px column gap goes with them;
     *   · 126 + 124 + 10 = **260 px**, all of it into §S57's name floor: 160 → **420**.
     */
    it('lays every row out on LabelCol’s fixed columns', () => {
        setup();
        for (const row of ['label-preset-ship', 'label-preset-wip']) {
            const node = screen.getByTestId(row);
            expect(node.style.display).toBe('grid');
            expect(node.style.gridTemplateColumns).toBe('24px minmax(420px,1fr) 80px 44px 40px');
            expect(node.style.columnGap).toBe('10px');
        }
    });

    /*
     * …and the rebalance is free at the narrow end, which is the half a template alone does not
     * say. §S57's floor is what stops a narrowing window emptying the name field, and the width
     * below which the list scrolls sideways instead is the sum of the tracks and the gaps. That
     * sum is 648 through §S57, §S60, §N36(3) and now §N38 — 150 + 100 + 184 = 150 + 160 + 124 =
     * 24 + 420 — so a panel that fitted the row before still fits it, and one that scrolled
     * scrolls by the same amount.
     */
    it('leaves the width at which the list starts scrolling unchanged (§S57 / §N36 / §N38)', () => {
        expect(LABEL_GRID_MIN_WIDTH).toBe(648);
    });

    /*
     * …and every row orders its cells the same way, which is what makes them line up.
     *
     * §N32 SWAP: this compared the composer against a preset row. With the composer gone the
     * alignment that remains — and the only one the Swift's widths were ever about for the list
     * — is row against row.
     *
     * §N38 SWAP: the order was `colour · name · text colour · preview`; it is
     * `swatch trigger · name · preview` now, with the trigger carrying BOTH colours. L93's rule
     * (announce the field AND the value in it) applies to the one control that replaced the two
     * groups, so it names both values.
     */
    it('orders every preset row’s cells the same way', () => {
        setup();
        const first = cells('label-preset-ship');
        const second = cells('label-preset-wip');
        expect(first[0]?.querySelector('[data-testid="label-color-ship-trigger"]')).not.toBeNull();
        expect(second[0]?.querySelector('[data-testid="label-color-wip-trigger"]')).not.toBeNull();
        expect(
            first[0]?.querySelector('button')?.getAttribute('aria-label')
        ).toBe('ship colours: Gray background, Auto text');
        expect(
            second[0]?.querySelector('button')?.getAttribute('aria-label')
        ).toBe('wip colours: Blue background, Auto text');
        expect(first[1]?.querySelector('input')?.getAttribute('data-testid')).toBe('label-rename-field-ship');
        expect(second[1]?.querySelector('input')?.getAttribute('data-testid')).toBe('label-rename-field-wip');
        expect(first[2]?.querySelector('[data-testid="label-chip-ship"]')).not.toBeNull();
        expect(second[2]?.querySelector('[data-testid="label-chip-wip"]')).not.toBeNull();
        // …and the two cells the flyover replaced are gone from the row entirely.
        expect(screen.queryByTestId('label-text-ship-mode')).toBeNull();
        expect(screen.queryByTestId('label-color-ship-purple')).toBeNull();
    });

    // H27: no Rename button anywhere — the name is a live field in every row.
    it('has no Rename button; the name field is live in every row', () => {
        setup();
        expect(screen.queryByTestId('label-rename-ship')).toBeNull();
        expect(screen.queryByTestId('label-rename-wip')).toBeNull();
        expect(screen.queryAllByText('Rename')).toHaveLength(0);
        for (const preset of ['ship', 'wip']) {
            const field = screen.getByTestId(`label-rename-field-${preset}`) as HTMLInputElement;
            expect(field.value).toBe(preset);
        }
    });

    // …and typing into it previews live, exactly as the Swift row's `previewText` does.
    it('follows the typed name in the row’s chip while it is being edited', () => {
        setup();
        fireEvent.change(screen.getByTestId('label-rename-field-ship'), { target: { value: 'shipped' } });
        expect(screen.getByTestId('label-chip-ship').textContent).toBe('shipped');
    });

    // H11: the same hover recipe as the rail and the buttons, on the row and on a swatch.
    // §N38 SWAP: the swatch that is read is the ROW's trigger, and the ten palette swatches keep
    // the identical recipe inside the flyover — one hover rule, two places it is now applied.
    it('lights a preset row, its swatch trigger and a flyover swatch under the pointer', () => {
        setup();
        const row = screen.getByTestId('label-preset-ship');
        expect(row.dataset['hovered']).toBe('false');
        fireEvent.mouseEnter(row);
        expect(row.dataset['hovered']).toBe('true');
        expect(row.style.background).toContain('--nex-selection-fill');

        const trigger = screen.getByTestId('label-color-ship-trigger');
        expect(trigger.style.outline).toBe('none');
        fireEvent.mouseEnter(trigger);
        expect(trigger.style.outline).toContain('--nex-selection-stroke');

        fireEvent.click(trigger);
        const swatch = screen.getByTestId('label-flyover-bg-purple');
        expect(swatch.style.outline).toBe('none');
        fireEvent.mouseEnter(swatch);
        expect(swatch.style.outline).toContain('--nex-selection-stroke');
    });
});

/*
 * §N36 — the owner's three directives, in the two halves jsdom can answer.
 *
 * The GEOMETRY half of (3) and the whole of (4) are not here and cannot be: jsdom has no layout,
 * so "the name track is 162 px" and "the minted name is not clipped" are measured on the live
 * stack instead (`docs/audit/n36-labels-design/probe.mjs`, and the `labels-design` audit step).
 * What is here is what a DOM can be asked: WHERE the button is in the tree, and WHAT the tab
 * says. The template the geometry follows from is pinned in "the tab's shape" above.
 */
describe('§N36 — the header action and the tab’s words', () => {
    /** The section's heading row: the `<h3>`'s own parent, which is where the action lives. */
    function headerRow(): HTMLElement {
        const heading = screen.getByTestId('label-presets').querySelector('h3');
        expect(heading).not.toBeNull();
        return heading?.parentElement as HTMLElement;
    }

    /*
     * (1) The New Label button is IN the header row, level with the title — not the first item of
     * the list it heads, which is where the owner's frame found it.
     *
     * Asserted as containment plus source order rather than as a class list: `justify-between`
     * is one way to put a control on the trailing edge and there is no reason for a test to
     * insist on it, but "the heading and the button are children of one row, title first" is the
     * claim, and the live probe reads the resulting x's (`add.right === row.right`, 1063 = 1063
     * at the default window).
     */
    it('puts the New Label button in the section header, after the title', () => {
        setup();
        const header = headerRow();
        const add = screen.getByTestId('label-add');
        expect(header.contains(add)).toBe(true);
        const order = Array.from(header.children);
        expect(order[0]?.tagName).toBe('H3');
        expect(order[order.length - 1]?.contains(add)).toBe(true);
        // …and it is still ABOVE the divider, which is the position §N32(a) fixed and §N36 must
        // not undo: header, rule, then the list.
        const section = screen.getByTestId('label-presets');
        const ids = Array.from(section.querySelectorAll<HTMLElement>('[data-testid]'))
            .map((node) => node.dataset['testid'] ?? '')
            .filter((id) => id === 'label-add' || id === 'label-add-divider');
        expect(ids).toEqual(['label-add', 'label-add-divider']);
    });

    it('keeps the header action out of every OTHER section, which renders a bare heading', () => {
        // The orphan section takes no action, so `SettingsSection` must not have grown a row
        // wrapper for everyone: a section with no action renders the `<h3>` it always did.
        setup([{ labels: ['adopt-me'] }], []);
        const orphans = screen.getByTestId('label-orphans');
        const heading = orphans.querySelector('h3');
        expect(heading?.parentElement).toBe(orphans);
        expect(orphans.querySelector('[data-settings-section-action]')).toBeNull();
    });

    /*
     * (2) The tab's user-facing vocabulary is LABELS. The daemon's object stays a "preset" in
     * every identifier — `label-presets`, `label-preset-ship`, `add-label-preset` — which is the
     * boundary this asserts from both sides: no rendered text and no announced string says
     * "preset", while the test ids this very file addresses rows by still do.
     */
    it('says "label" everywhere a person can read, and "preset" only in identifiers', () => {
        setup();
        const tab = screen.getByTestId('settings-tab-labels');
        expect(screen.getByTestId('label-presets').querySelector('h3')?.textContent).toBe('Labels');
        expect(tab.textContent ?? '').not.toMatch(/preset/i);
        const announced = Array.from(tab.querySelectorAll('[aria-label], [title]')).flatMap((node) =>
            [node.getAttribute('aria-label'), node.getAttribute('title')].filter(
                (value): value is string => value !== null
            )
        );
        expect(announced.filter((value) => /preset/i.test(value))).toEqual([]);
        // The identifiers are untouched — this is the half that says the rename was COPY only.
        expect(screen.getByTestId('label-preset-ship')).toBeDefined();
        expect(screen.getByTestId('label-presets')).toBeDefined();
    });

    it('says it in the empty state', () => {
        setup([], []);
        expect(screen.getByTestId('labels-empty').textContent).toContain('No labels yet');
        expect(screen.getByTestId('settings-tab-labels').textContent ?? '').not.toMatch(/preset/i);
    });

    it('says it in the orphan section too', () => {
        setup([{ labels: ['adopt-me'] }], []);
        expect(screen.getByTestId('settings-tab-labels').textContent ?? '').not.toMatch(/preset/i);
        expect(screen.getByTestId('label-orphans').textContent).toContain('Labels not defined here');
    });

    it('says it in the delete confirmation, which is the one place the two nouns met', () => {
        setup([{ labels: ['ship'] }]);
        fireEvent.click(screen.getByTestId('label-delete-ship'));
        const confirm = screen.getByTestId('label-delete-confirm-ship');
        expect(confirm.textContent).toContain('Delete this label?');
        // …and it still says exactly what survives the delete (§6.4): the NAME stays applied.
        expect(confirm.textContent).toContain('The name stays on 1 workspace');
        expect(confirm.textContent).toContain('render neutral');
        expect(confirm.textContent ?? '').not.toMatch(/preset/i);
    });
});

describe('designing a preset (SET-058, SET-061, SET-062)', () => {
    /*
     * §N32 SWAP — two tests died here and their coverage moved one row down.
     *
     *   · "previews the draft chip live, placeholder first, then the typed name" was about the
     *     composer's chip. The live preview is now the ROW's chip, which is covered by "follows
     *     the typed name in the row's chip while it is being edited" above and, for a freshly
     *     minted preset, by the mint suite below.
     *   · "carries the chosen background AND text colour into the add" was about designing a
     *     preset BEFORE it existed. A preset is now designed after it exists, through the row's
     *     own controls — the same two writes, in the other order, asserted here end to end so
     *     the capability is not merely assumed to have survived.
     */
    /*
     * §N38 SWAP — every control these tests drove has moved into the flyover, and the gestures
     * move with it. What is asserted does not change at all: the same writes, in the same order,
     * with the same values, through the same `updateLabelPreset` verb.
     *
     *   · the ten background swatches → `label-flyover-bg-<color>` (was `label-color-<name>-<color>`);
     *   · the Auto/Black/White `<select>` → three `aria-pressed` buttons, `label-flyover-text-*`
     *     (§N36(3) had collapsed them into one control ONLY because 179.5 px would not fit a
     *     124 px Swift track, and that track no longer exists — the owner's mockup draws three);
     *   · the two `<input type="color">` wells → the popover's own HSV view, reached from either
     *     `Custom` row, with a hex field that is the byte-exact way in and out;
     *   · the "Aa" sample → the flyover's Text ▸ Custom row, which shows the resolved swatch and
     *     hex, and the row's chip, which was always the other place the resolution showed.
     */
    function openFlyover(preset: string): void {
        fireEvent.click(screen.getByTestId(`label-color-${preset}-trigger`));
    }
    function setTextMode(preset: string, mode: 'auto' | 'black' | 'white'): void {
        if (screen.queryByTestId('label-flyover-text-auto') === null) openFlyover(preset);
        fireEvent.click(screen.getByTestId(`label-flyover-text-${mode}`));
    }

    it('designs a minted preset through its own row: background, then text colour', () => {
        const bound = setup();
        openFlyover('ship');
        fireEvent.click(screen.getByTestId('label-flyover-bg-purple'));
        setTextMode('ship', 'white');
        expect(bound.log.updated).toEqual([
            { id: 'ship', color: 'purple' },
            { id: 'ship', textColor: '#ffffff' }
        ]);
    });

    /*
     * …and the control SHOWS which mode is set, which is the whole reason this port draws the
     * mode rather than hiding it behind a menu (§L93). §N38 SWAP: the read is `aria-pressed` on
     * three buttons again, where §N36(3)'s `<select>` had a `value` and a `data-mode`. `Custom`
     * is not a fourth button — it is the row beneath, which is `aria-pressed` when the stored
     * colour is neither black, white nor auto, and which is also the way IN to a custom colour.
     */
    it('shows the current mode on the three buttons, Custom on its own row (§N38)', () => {
        setup([], [
            { name: 'auto', color: { kind: 'named', color: 'gray' }, textColor: null },
            { name: 'white', color: { kind: 'named', color: 'gray' }, textColor: { kind: 'custom', hex: '#ffffff' } },
            { name: 'odd', color: { kind: 'named', color: 'gray' }, textColor: { kind: 'custom', hex: '#3366cc' } }
        ]);
        const pressed = (): string[] =>
            ['auto', 'black', 'white', 'custom']
                .filter(
                    (mode) =>
                        screen.getByTestId(`label-flyover-text-${mode}`).getAttribute('aria-pressed') === 'true'
                );

        openFlyover('auto');
        expect(pressed()).toEqual(['auto']);
        fireEvent.click(screen.getByTestId('label-flyover-close'));

        openFlyover('white');
        expect(pressed()).toEqual(['white']);
        fireEvent.click(screen.getByTestId('label-flyover-close'));

        openFlyover('odd');
        expect(pressed()).toEqual(['custom']);
        // …and the Custom row shows the colour it is pressed FOR, which the `<select>` could not.
        expect(screen.getByTestId('label-flyover-text-custom-hex').textContent).toBe('#3366cc');
    });

    /*
     * §N38 SWAP for "takes a custom hex from the colour well". The OS well is gone; the way to a
     * custom colour is the popover's own picker, and the hex field is the byte-exact door.
     */
    it('takes a custom hex from the flyover’s picker, for both colours', () => {
        const bound = setup();
        openFlyover('ship');
        fireEvent.click(screen.getByTestId('label-flyover-bg-custom'));
        fireEvent.change(screen.getByTestId('label-flyover-hex'), { target: { value: '#ff8800' } });
        expect(bound.log.updated).toEqual([{ id: 'ship', color: '#ff8800' }]);

        // …and the SAME view, entered from the Text section, writes the other value.
        fireEvent.click(screen.getByTestId('label-flyover-back'));
        fireEvent.click(screen.getByTestId('label-flyover-text-custom'));
        fireEvent.change(screen.getByTestId('label-flyover-hex'), { target: { value: '#123456' } });
        expect(bound.log.updated).toEqual([
            { id: 'ship', color: '#ff8800' },
            { id: 'ship', textColor: '#123456' }
        ]);
    });

    it('sends null for Auto, so the daemon re-derives black/white by luminance', () => {
        const bound = setup();
        setTextMode('ship', 'black');
        setTextMode('ship', 'auto');
        expect(bound.log.updated).toEqual([
            { id: 'ship', textColor: '#000000' },
            { id: 'ship', textColor: null }
        ]);
    });

    /*
     * §N38 SWAP for the "Aa" sample: white on a dark chip, black on a light one. The sample went
     * with `LabelTextColorField`; the two surfaces that still SHOW the luminance rule's answer
     * are the row's chip and the flyover's Text ▸ Custom row, and both are read here so the rule
     * cannot quietly stop being displayed anywhere.
     */
    it('shows the resolved text colour: white on a dark chip, black on a light one', () => {
        setup([], [
            { name: 'dark', color: { kind: 'custom', hex: '#101014' }, textColor: null },
            { name: 'light', color: { kind: 'custom', hex: '#f4e7a1' }, textColor: null }
        ]);
        openFlyover('dark');
        expect(screen.getByTestId('label-flyover-text-custom-hex').textContent).toBe('#ffffff');
        expect(screen.getByTestId('label-flyover-chip').dataset['text']).toBe('#ffffff');
        fireEvent.click(screen.getByTestId('label-flyover-close'));

        openFlyover('light');
        expect(screen.getByTestId('label-flyover-text-custom-hex').textContent).toBe('#000000');
        expect(screen.getByTestId('label-flyover-chip').dataset['text']).toBe('#000000');
    });

    it('reorders with the ↑/↓ buttons, disabled at the ends (SET-065)', () => {
        const bound = setup();
        expect((screen.getByTestId('label-move-up-ship') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('label-move-down-wip') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByTestId('label-move-down-ship'));
        expect(bound.log.moved).toEqual([{ id: 'ship', index: 1 }]);
    });
});

describe('renaming a preset (SET-063)', () => {
    it('commits on focus loss, not only on Return', () => {
        const bound = setup();
        const field = screen.getByTestId('label-rename-field-ship');
        fireEvent.change(field, { target: { value: 'shipped' } });
        fireEvent.blur(field);
        expect(bound.log.updated).toEqual([{ id: 'ship', name: 'shipped' }]);
    });

    it('snaps back and says why when the name collides with another preset', () => {
        const bound = setup();
        const field = screen.getByTestId('label-rename-field-ship') as HTMLInputElement;
        fireEvent.change(field, { target: { value: 'wip' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(bound.log.updated).toEqual([]);
        // §N36(2): the refusal says "label", not "preset" — the sweep's most load-bearing string.
        expect(screen.getByTestId('label-rename-error-ship').textContent).toContain('already a label');
        // The row still shows the STORED name — nothing was left half-renamed on screen.
        expect(field.value).toBe('ship');
        expect(screen.getByTestId('label-chip-ship').textContent).toBe('ship');
    });

    it('cancels on Escape without writing', () => {
        const bound = setup();
        const field = screen.getByTestId('label-rename-field-ship') as HTMLInputElement;
        fireEvent.change(field, { target: { value: 'shipped' } });
        fireEvent.keyDown(field, { key: 'Escape' });
        expect(field.value).toBe('ship');
        fireEvent.blur(field);
        expect(bound.log.updated).toEqual([]);
    });

    /*
     * The live field's other half (H27): it has to survive the deltas the row's OWN controls
     * produce. Recolouring through the swatch round-trips `label-presets-changed` back into
     * this list, and a half-typed name must still be there when it lands — the failure mode a
     * "Rename" button never had, because the field only existed for the duration of the rename.
     */
    it('keeps a half-typed name across a store rewrite of the same preset', () => {
        const bound = actions();
        const view = render(
            <LabelsTab presets={PRESETS} workspaces={[]} actions={bound} bucket="dark" />
        );
        const field = screen.getByTestId('label-rename-field-ship') as HTMLInputElement;
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: 'half-typed' } });

        view.rerender(
            <LabelsTab
                presets={[
                    { name: 'ship', color: { kind: 'named', color: 'purple' }, textColor: null },
                    ...PRESETS.slice(1)
                ]}
                workspaces={[]}
                actions={bound}
                bucket="dark"
            />
        );
        expect((screen.getByTestId('label-rename-field-ship') as HTMLInputElement).value).toBe('half-typed');
        // …and the daemon's colour did land: the draft did not freeze the whole row.
        expect(screen.getByTestId('label-chip-ship').dataset['color']).toBe('purple');
    });
});

describe('deleting a preset (§6.4)', () => {
    it('deletes an unused preset outright', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-delete-ship'));
        expect(bound.log.removed).toEqual(['ship']);
    });

    // The spec is explicit that removal never touches a workspace's `labels`, so an in-use
    // preset is deletable — it just says what will happen first.
    it('confirms an in-use delete, saying the label survives', () => {
        const bound = setup([{ labels: ['ship'] }]);
        fireEvent.click(screen.getByTestId('label-delete-ship'));
        expect(bound.log.removed).toEqual([]);
        // §N36(2): "…renders neutral" → "…those chips render neutral" — the sentence had to name
        // what survives without the preset/label pair to lean on. The claim is untouched.
        expect(screen.getByTestId('label-delete-confirm-ship').textContent).toContain('render neutral');
        fireEvent.click(screen.getByTestId('label-delete-confirm-yes-ship'));
        expect(bound.log.removed).toEqual(['ship']);
    });

    it('lets the confirmation be cancelled', () => {
        const bound = setup([{ labels: ['ship'] }]);
        fireEvent.click(screen.getByTestId('label-delete-ship'));
        fireEvent.click(screen.getByTestId('label-delete-cancel-ship'));
        expect(screen.queryByTestId('label-delete-confirm-ship')).toBeNull();
        expect(bound.log.removed).toEqual([]);
    });
});

describe('labels with no preset (§6.5/§6.6)', () => {
    it('offers a one-click gray back-fill, and hides the section when there are none', () => {
        const bound = setup([{ labels: ['ship', 'orphan'] }]);
        fireEvent.click(screen.getByTestId('label-adopt-orphan'));
        expect(bound.log.added).toEqual([{ name: 'orphan', color: 'gray' }]);
        cleanup();

        setup([{ labels: ['ship'] }]);
        expect(screen.queryByTestId('label-orphans')).toBeNull();
    });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * N32 (owner-directed) — the composer is gone; a preset is MINTED and renamed in place.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The three tests this replaces were about the composer having ONE position and reading as a
 * composer rather than as a fourth preset with an empty name. Neither claim can be made about a
 * thing that does not exist, so each is SWAPPED for the claim that now carries its weight:
 *
 *   · "puts the composer first in the EMPTY state too, with the art below the divider" and "and
 *     in exactly the same place once presets exist" → the ADD BUTTON leads the tab in both
 *     states, with the art still below the divider. The defect they were written for (an add
 *     affordance with two positions) is still possible, so the assertion survives with a new
 *     subject.
 *   · "names the composer and gives it a ground no preset row wears" → there is nothing left to
 *     tell apart from a row: the tab carries exactly one add affordance and no draft controls at
 *     all. That is the stronger form of the same guarantee, and it is what makes the heading and
 *     the accent ground unnecessary rather than merely absent.
 *   · "leaves the shared column template and the row inset untouched" → the same grid assertion,
 *     now row-against-row (§S60's 184 px track was sized for the cluster in every PRESET row, so
 *     removing the composer must not move it).
 */
describe('minting a preset (N32)', () => {
    /** The section's rows, in document order, restricted to the ones with a stable id. */
    function sectionOrder(): string[] {
        return Array.from(
            screen.getByTestId('label-presets').querySelectorAll<HTMLElement>('[data-testid]')
        )
            .map((node) => node.dataset['testid'] ?? '')
            .filter(
                (id) =>
                    id === 'label-add' ||
                    id === 'label-add-divider' ||
                    id === 'labels-empty' ||
                    id.startsWith('label-preset-')
            );
    }

    /**
     * The tab wired to a list the daemon actually appends to — because the mint's whole shape is
     * "write, wait for the echo, then take the field". A `LabelsTab` handed a frozen array can
     * only prove the write.
     */
    function MintHarness(props: {
        readonly initial?: readonly ChromeLabelPreset[];
        readonly bound: SettingsActions & { readonly log: Recorded };
    }): ReactElement {
        const [presets, setPresets] = useState<readonly ChromeLabelPreset[]>(props.initial ?? []);
        const bound = props.bound;
        const wired: SettingsActions = {
            ...bound,
            addLabelPreset: (input) => {
                bound.addLabelPreset(input);
                // §6.4's own rule, and the reason the mint must uniquify: a duplicate name is
                // refused outright, so a list that accepted one would be a lie.
                setPresets((current) =>
                    current.some((preset) => preset.name === input.name)
                        ? current
                        : [
                              ...current,
                              {
                                  name: input.name,
                                  color: { kind: 'named', color: 'gray' },
                                  textColor: null
                              } satisfies ChromeLabelPreset
                          ]
                );
            },
            removeLabelPreset: (id) => {
                bound.removeLabelPreset(id);
                setPresets((current) => current.filter((preset) => preset.name !== id));
            },
            moveLabelPreset: ({ id, index }) => {
                bound.moveLabelPreset?.({ id, index });
                setPresets((current) => {
                    const from = current.findIndex((preset) => preset.name === id);
                    if (from < 0) return current;
                    const next = current.slice();
                    const [moved] = next.splice(from, 1);
                    if (moved === undefined) return current;
                    next.splice(Math.max(0, Math.min(next.length, index)), 0, moved);
                    return next;
                });
            }
        };
        return (
            <>
                {/* Another client reordering the same list, with nothing in this window focused
                    by the gesture (`fireEvent.click` does not focus in jsdom). */}
                <button
                    type="button"
                    data-testid="third-party"
                    onClick={() => {
                        setPresets((current) =>
                            current.length < 2 ? current : [...current.slice(1), ...current.slice(0, 1)]
                        );
                    }}
                >
                    third party
                </button>
                <LabelsTab presets={presets} workspaces={[]} actions={wired} bucket="dark" />
            </>
        );
    }

    const names = (): string[] =>
        Array.from(document.querySelectorAll('[data-testid^="label-preset-"]')).map((node) =>
            (node.getAttribute('data-testid') ?? '').replace('label-preset-', '')
        );

    it('leads the tab with the Add button in the EMPTY state, with the art below the divider', () => {
        setup([], []);
        expect(sectionOrder()).toEqual(['label-add', 'label-add-divider', 'labels-empty']);
    });

    it('and in exactly the same place once presets exist', () => {
        setup();
        expect(sectionOrder()).toEqual([
            'label-add',
            'label-add-divider',
            'label-preset-ship',
            'label-preset-wip'
        ]);
    });

    it('carries no draft controls at all — there is nothing that can read as a row', () => {
        setup();
        // Every control that used to make the composer a lookalike, gone: no draft name field,
        // no draft palette, no draft text-colour cluster, no draft chip, no heading over it.
        expect(screen.queryByTestId('label-new-name')).toBeNull();
        expect(screen.queryByTestId('label-new-preview')).toBeNull();
        expect(screen.queryByTestId('label-add-heading')).toBeNull();
        expect(screen.queryByTestId('label-add-row')).toBeNull();
        expect(document.querySelectorAll('[data-testid^="label-new-"]')).toHaveLength(0);
        // …and exactly one add affordance, which is a button.
        const add = screen.getByTestId('label-add');
        expect(add.tagName).toBe('BUTTON');
        expect(add.textContent).toBe('New Label');
        expect(screen.getAllByTestId('label-add')).toHaveLength(1);
    });

    it('leaves every preset row on one shared column template and inset', () => {
        setup();
        const first = screen.getByTestId('label-preset-ship');
        const second = screen.getByTestId('label-preset-wip');
        expect(first.style.gridTemplateColumns).toBe(second.style.gridTemplateColumns);
        // §N36(3) / §N38 SWAP: the same one-template-for-every-row claim, on the template the
        // owner's rebalance produced. Reasoned about where it is defined, above.
        expect(first.style.gridTemplateColumns).toBe('24px minmax(420px,1fr) 80px 44px 40px');
        // S64's 10 px horizontal inset, measured off the shipped dialog.
        expect(first.className).toContain('px-2.5');
        expect(second.className).toContain('px-2.5');
    });

    it('mints a uniquely named preset every time it is pressed', () => {
        const bound = actions();
        render(<MintHarness bound={bound} />);
        fireEvent.click(screen.getByTestId('label-add'));
        expect(names()).toEqual(['New label']);
        fireEvent.click(screen.getByTestId('label-add'));
        fireEvent.click(screen.getByTestId('label-add'));
        expect(names()).toEqual(['New label', 'New label 2', 'New label 3']);
        expect(bound.log.added.map((entry) => entry.name)).toEqual([
            'New label',
            'New label 2',
            'New label 3'
        ]);
        // …and it skips a name a preset already holds, wherever that preset came from.
        cleanup();
        render(
            <MintHarness
                bound={actions()}
                initial={[
                    { name: 'New label', color: { kind: 'named', color: 'blue' }, textColor: null },
                    { name: 'New label 2', color: { kind: 'named', color: 'blue' }, textColor: null }
                ]}
            />
        );
        fireEvent.click(screen.getByTestId('label-add'));
        expect(names()).toEqual(['New label', 'New label 2', 'New label 3']);
    });

    it('appends the new preset at the end, the CLI back-fill’s own position', () => {
        render(
            <MintHarness
                bound={actions()}
                initial={[{ name: 'ship', color: { kind: 'named', color: 'gray' }, textColor: null }]}
            />
        );
        fireEvent.click(screen.getByTestId('label-add'));
        expect(names()).toEqual(['ship', 'New label']);
    });

    it('hands the new row’s name field the focus, with the default name SELECTED', () => {
        render(<MintHarness bound={actions()} />);
        fireEvent.click(screen.getByTestId('label-add'));
        const field = screen.getByTestId('label-rename-field-New label') as HTMLInputElement;
        expect(document.activeElement).toBe(field);
        // Selected, not merely focused: the default name is a placeholder to type OVER.
        expect(field.value).toBe('New label');
        expect(field.selectionStart).toBe(0);
        expect(field.selectionEnd).toBe('New label'.length);
    });

    it('leaves a VALID preset behind when the rename is abandoned immediately', () => {
        const bound = actions();
        render(<MintHarness bound={bound} />);
        fireEvent.click(screen.getByTestId('label-add'));
        const field = screen.getByTestId('label-rename-field-New label') as HTMLInputElement;
        // Escape, then blur — the two ways out of a rename nobody wanted. Neither may write, and
        // neither may leave a half-made preset: the row was created by the daemon the moment the
        // button was pressed, so the only question is whether it survives untouched.
        fireEvent.keyDown(field, { key: 'Escape' });
        fireEvent.blur(field);
        expect(names()).toEqual(['New label']);
        expect(bound.log.updated).toEqual([]);
        expect(bound.log.removed).toEqual([]);
        expect((screen.getByTestId('label-rename-field-New label') as HTMLInputElement).value).toBe(
            'New label'
        );
    });

    it('renames the minted preset in place, exactly like any other row', () => {
        const bound = actions();
        render(<MintHarness bound={bound} />);
        fireEvent.click(screen.getByTestId('label-add'));
        const field = screen.getByTestId('label-rename-field-New label') as HTMLInputElement;
        fireEvent.change(field, { target: { value: 'release' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(bound.log.updated).toEqual([{ id: 'New label', name: 'release' }]);
    });

    /*
     * A mint SUPERSEDES the last reorder's focus intent (§N33 keeps that intent armed on purpose,
     * so that a second commit can finish the move). Without this, the next commit to change the
     * order — another client's reorder, arriving while the user is still typing the new name —
     * would take the caret out of the field the mint just handed it to.
     */
    it('supersedes a pending reorder intent, so a later commit cannot steal the new field', () => {
        render(
            <MintHarness
                bound={actions()}
                initial={[
                    { name: 'a', color: { kind: 'named', color: 'gray' }, textColor: null },
                    { name: 'b', color: { kind: 'named', color: 'gray' }, textColor: null },
                    { name: 'c', color: { kind: 'named', color: 'gray' }, textColor: null }
                ]}
            />
        );
        // Mid-list, so the pressed arrow is still enabled afterwards and the intent is plainly
        // the one this test is about.
        fireEvent.click(screen.getByTestId('label-move-down-a'), { detail: 1, clientX: 10, clientY: 10 });
        expect(document.activeElement).toBe(screen.getByTestId('label-move-down-a'));
        fireEvent.click(screen.getByTestId('label-add'));
        const field = screen.getByTestId('label-rename-field-New label');
        expect(document.activeElement).toBe(field);
        fireEvent.click(screen.getByTestId('third-party'));
        expect(document.activeElement).toBe(screen.getByTestId('label-rename-field-New label'));
    });

    it('deletes a minted preset from its own row, with no confirmation while it is unused', () => {
        const bound = actions();
        render(<MintHarness bound={bound} />);
        fireEvent.click(screen.getByTestId('label-add'));
        fireEvent.click(screen.getByTestId('label-delete-New label'));
        expect(bound.log.removed).toEqual(['New label']);
        expect(names()).toEqual([]);
        // Back to the empty state, with the button still leading the tab.
        expect(sectionOrder()).toEqual(['label-add', 'label-add-divider', 'labels-empty']);
    });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * N33 — where focus goes when a row is reordered.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * **What jsdom cannot see, and how this suite covers it anyway.** The defect lives in two
 * browser behaviours jsdom does not implement: Chromium blurs a focused element when its node is
 * MOVED in the tree (React's keyed reconciliation moves the pressed row's node on ↓ and the
 * other row's on ↑ — the asymmetry in the report), and it blurs a focused element that becomes
 * `disabled` (which is what an arrow does when its row reaches an end). Measured on the real
 * stack over CDP: mid-list ↓ fired `focusout`+`focusin` on the pressed arrow, mid-list ↑ fired
 * neither, and BOTH ends dropped `document.activeElement` to `<body>`.
 *
 * So `blurLikeChromium` models the one thing jsdom omits — the blur — at exactly the moment the
 * browser does it, and the assertions below are then about the port's own behaviour: does focus
 * come back, and does it come back to the right control. The mid-list cases fail without the fix
 * (activeElement is `<body>`); the end cases fail without it even with the model off, because
 * jsdom happily leaves focus on a disabled button. The same assertions run for real, against a
 * real Chromium, in the `labels-design` audit step.
 */
describe('reorder focus (N33)', () => {
    const FOUR: readonly ChromeLabelPreset[] = [
        { name: 'a', color: { kind: 'named', color: 'gray' }, textColor: null },
        { name: 'b', color: { kind: 'named', color: 'blue' }, textColor: null },
        { name: 'c', color: { kind: 'named', color: 'red' }, textColor: null },
        { name: 'd', color: { kind: 'named', color: 'green' }, textColor: null }
    ];

    interface HarnessProps {
        readonly initial: readonly ChromeLabelPreset[];
        /** Model Chromium's blur-on-move / blur-on-disable, which jsdom does not implement. */
        readonly blurLikeChromium?: boolean;
    }

    /** A LabelsTab wired to a real, mutable list, so a reorder actually reorders. */
    function Harness(props: HarnessProps): ReactElement {
        const [presets, setPresets] = useState<readonly ChromeLabelPreset[]>(props.initial);
        const bound: SettingsActions = {
            ...actions(),
            moveLabelPreset: ({ id, index }) => {
                if (props.blurLikeChromium === true) {
                    (document.activeElement as HTMLElement | null)?.blur();
                }
                setPresets((current) => {
                    const from = current.findIndex((preset) => preset.name === id);
                    if (from < 0) return current;
                    const next = current.slice();
                    const [moved] = next.splice(from, 1);
                    if (moved === undefined) return current;
                    next.splice(Math.max(0, Math.min(next.length, index)), 0, moved);
                    return next;
                });
            }
        };
        return <LabelsTab presets={presets} workspaces={[]} actions={bound} bucket="dark" />;
    }

    /** The names in render order — "did the reorder actually happen". */
    function order(): string[] {
        return Array.from(document.querySelectorAll('[data-testid^="label-preset-"]')).map((node) =>
            (node.getAttribute('data-testid') ?? '').replace('label-preset-', '')
        );
    }

    const activeID = (): string =>
        document.activeElement === document.body
            ? 'BODY'
            : (document.activeElement?.getAttribute('data-testid') ?? 'unknown');

    /**
     * What pressing Enter (or Space) on a focused button does: fire its click. `fireEvent.keyDown`
     * synthesises no click of its own, so a keyboard walk is a click on whatever holds focus —
     * which is precisely the property under test (if focus were lost, there would be nothing to
     * press).
     */
    function pressFocused(): void {
        const active = document.activeElement;
        expect(active).not.toBe(document.body);
        fireEvent.click(active as HTMLElement);
    }

    it('follows the moved row DOWN, onto the same arrow', () => {
        render(<Harness initial={FOUR} blurLikeChromium />);
        const down = screen.getByTestId('label-move-down-b');
        down.focus();
        fireEvent.click(down);
        expect(order()).toEqual(['a', 'c', 'b', 'd']);
        expect(activeID()).toBe('label-move-down-b');
    });

    it('follows the moved row UP, onto the same arrow', () => {
        render(<Harness initial={FOUR} blurLikeChromium />);
        const up = screen.getByTestId('label-move-up-c');
        up.focus();
        fireEvent.click(up);
        expect(order()).toEqual(['a', 'c', 'b', 'd']);
        expect(activeID()).toBe('label-move-up-c');
    });

    /*
     * The end of the list, which is where the shipped tab dropped focus to `<body>`: the pressed
     * arrow disables itself in the same commit. A row can only be at ONE end, so its other arrow
     * is necessarily enabled — and landing there means the next press walks the row back, which
     * is what makes a keyboard-only reorder a loop rather than a dead end.
     */
    it('lands on the row’s other arrow when ↓ reaches the bottom and disables', () => {
        render(<Harness initial={FOUR} blurLikeChromium />);
        // `c` is second-to-last: one ↓ puts it in the last slot and disables the arrow pressed.
        const down = screen.getByTestId('label-move-down-c');
        down.focus();
        fireEvent.click(down);
        expect(order()).toEqual(['a', 'b', 'd', 'c']);
        expect((screen.getByTestId('label-move-down-c') as HTMLButtonElement).disabled).toBe(true);
        expect(activeID()).toBe('label-move-up-c');
    });

    it('lands on the row’s other arrow when ↑ reaches the top and disables', () => {
        render(<Harness initial={FOUR} blurLikeChromium />);
        const up = screen.getByTestId('label-move-up-b');
        up.focus();
        fireEvent.click(up);
        expect(order()).toEqual(['b', 'a', 'c', 'd']);
        expect((screen.getByTestId('label-move-up-b') as HTMLButtonElement).disabled).toBe(true);
        expect(activeID()).toBe('label-move-down-b');
    });

    /*
     * The acceptance criterion in the report's own words: "keyboard-only reordering must be
     * possible end to end". One row walked from the top of the list to the bottom and back,
     * pressing only whatever holds focus — no re-aiming, no mouse, and `document.activeElement`
     * asserted at every step.
     */
    it('walks a row top-to-bottom and back on the keyboard alone', () => {
        render(<Harness initial={FOUR} blurLikeChromium />);
        screen.getByTestId('label-move-down-a').focus();
        const seen: string[] = [];
        for (let step = 0; step < FOUR.length - 1; step++) {
            pressFocused();
            seen.push(`${order().join('')}:${activeID()}`);
        }
        expect(seen).toEqual([
            'bacd:label-move-down-a',
            'bcad:label-move-down-a',
            // Last slot: ↓ disabled, so focus moves to the row's ↑ — still on `a`, still armed.
            'bcda:label-move-up-a'
        ]);
        for (let step = 0; step < FOUR.length - 1; step++) {
            pressFocused();
            seen.push(`${order().join('')}:${activeID()}`);
        }
        expect(seen.slice(3)).toEqual([
            'bcad:label-move-up-a',
            'bacd:label-move-up-a',
            // First slot: ↑ disabled, focus hands back to ↓, ready to walk down again.
            'abcd:label-move-down-a'
        ]);
    });

    /*
     * The intent is consumed by a REORDER and by nothing else: a preset list that changes for
     * another reason (here a rename arriving from the daemon) must not move the user's focus.
     */
    it('does not steal focus when the list changes for a reason other than a reorder', () => {
        function RenameHarness(): ReactElement {
            const [presets, setPresets] = useState<readonly ChromeLabelPreset[]>(FOUR);
            return (
                <>
                    <button
                        type="button"
                        data-testid="elsewhere"
                        onClick={() => {
                            setPresets((current) =>
                                current.map((preset) =>
                                    preset.name === 'c' ? { ...preset, name: 'renamed' } : preset
                                )
                            );
                        }}
                    >
                        rename
                    </button>
                    <LabelsTab presets={presets} workspaces={[]} actions={actions()} bucket="dark" />
                </>
            );
        }
        render(<RenameHarness />);
        const elsewhere = screen.getByTestId('elsewhere');
        elsewhere.focus();
        fireEvent.click(elsewhere);
        expect(order()).toEqual(['a', 'b', 'renamed', 'd']);
        expect(activeID()).toBe('elsewhere');
    });
});


/*
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * N33 (reopened) — the highlight the user can SEE, and a focus intent that survives the echo.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The first N33 fix was verified against `document.activeElement` alone, and the owner still saw
 * the defect. The live probe (`docs/audit/n33-reorder-focus/echo-probe.mjs`, real daemon, real
 * Chromium, one transition entry per animation frame) says why: a mouse click on a `<button>`
 * never matches `:focus-visible` in Chromium — `ring=no` on EVERY frame of every case — so a
 * mouse-driven reorder paints no focus ring at all. What the eye follows is the hover wash, and
 * Chromium re-evaluates `:hover` when the DOM moves, with the pointer perfectly still: the wash
 * jumps off the row that moved and onto the row that slid into the pressed slot.
 *
 * jsdom implements none of that either — it has no pointer, so `:hover` never matches and no
 * mouse events are synthesised by a DOM change. What it CAN check is the port's own answer to
 * it: the paint is taken from the reorder while the list is parked, the park is released by a
 * real pointer move and not by jitter, and a stale hover cannot outlive the row it was on.
 * Those are asserted here; that they are the right answer is settled on the live stack.
 */
describe('reorder highlight and intent (N33 reopened)', () => {
    const FOUR: readonly ChromeLabelPreset[] = [
        { name: 'a', color: { kind: 'named', color: 'gray' }, textColor: null },
        { name: 'b', color: { kind: 'named', color: 'blue' }, textColor: null },
        { name: 'c', color: { kind: 'named', color: 'red' }, textColor: null },
        { name: 'd', color: { kind: 'named', color: 'green' }, textColor: null }
    ];

    /**
     * A list a test can reorder from the outside as well as from a row — which is how a SECOND
     * CLIENT reorders it. `blur` models Chromium blurring an element that has just become
     * `disabled`; jsdom leaves focus sitting on a disabled button.
     */
    function Harness(props: { readonly external?: (list: ChromeLabelPreset[]) => ChromeLabelPreset[] }): ReactElement {
        const [presets, setPresets] = useState<readonly ChromeLabelPreset[]>(FOUR);
        const blurArrowLikeChromium = (): void => {
            const active = document.activeElement as HTMLElement | null;
            if ((active?.getAttribute('data-testid') ?? '').startsWith('label-move-')) active?.blur();
        };
        const move = (id: string, index: number): void => {
            blurArrowLikeChromium();
            setPresets((current) => {
                const from = current.findIndex((preset) => preset.name === id);
                if (from < 0) return current;
                const next = current.slice();
                const [moved] = next.splice(from, 1);
                if (moved === undefined) return current;
                next.splice(Math.max(0, Math.min(next.length, index)), 0, moved);
                return next;
            });
        };
        return (
            <>
                <button type="button" data-testid="outside" onClick={() => undefined}>
                    outside
                </button>
                <button
                    type="button"
                    data-testid="third-party"
                    onClick={() => {
                        // A delta from another client: the rows re-order under a focused control
                        // that nobody in this window touched. `fireEvent.click` does not focus in
                        // jsdom, so focus is exactly where the previous gesture left it — and only
                        // an ARROW is blurred, because that is all Chromium would move or disable.
                        blurArrowLikeChromium();
                        setPresets((current) => (props.external ?? ((list) => list))(current.slice()));
                    }}
                >
                    third party
                </button>
                <LabelsTab
                    presets={presets}
                    workspaces={[]}
                    actions={{ ...actions(), moveLabelPreset: ({ id, index }) => move(id, index) }}
                    bucket="dark"
                />
            </>
        );
    }

    const activeID = (): string =>
        document.activeElement === document.body
            ? 'BODY'
            : (document.activeElement?.getAttribute('data-testid') ?? 'unknown');

    /** What is PAINTED as highlighted — the rows and arrows a person sees lit. */
    function painted(): string[] {
        return Array.from(
            document.querySelectorAll(
                '[data-testid^="label-preset-"][data-hovered="true"], [data-testid^="label-move-"][data-hovered="true"]'
            )
        ).map((node) => node.getAttribute('data-testid') ?? '');
    }

    /** A MOUSE click: `detail > 0` and a real position, which is what a keyboard press lacks. */
    function mouseClick(testID: string, at = { x: 400, y: 300 }): void {
        fireEvent.click(screen.getByTestId(testID), { detail: 1, clientX: at.x, clientY: at.y });
    }

    /**
     * The pointer moving, as the window sees it. Built by hand rather than through
     * `fireEvent.pointerMove` because jsdom has no `PointerEvent` constructor, and the two
     * coordinates are the whole point of the event.
     */
    function movePointer(x: number, y: number): void {
        const event = new Event('pointermove', { bubbles: true });
        Object.assign(event, { clientX: x, clientY: y });
        // `act` because this listener is the tab's own, not a React handler `fireEvent` wraps:
        // without it the release lands after the assertion rather than before it.
        act(() => {
            window.dispatchEvent(event);
        });
    }

    /**
     * What Chromium does to hover at a reorder commit, and jsdom does not: the pointer has not
     * moved, but the element under it has changed, so the browser fires `mouseout` on the row
     * that left and `mouseover` on the one that took its place.
     */
    function hoverJumpsTo(row: string, arrow: string, from: { row: string; arrow: string }): void {
        fireEvent.mouseLeave(screen.getByTestId(`label-move-${from.arrow}-${from.row}`));
        fireEvent.mouseLeave(screen.getByTestId(`label-preset-${from.row}`));
        fireEvent.mouseEnter(screen.getByTestId(`label-preset-${row}`));
        fireEvent.mouseEnter(screen.getByTestId(`label-move-${arrow}-${row}`));
    }

    it('keeps the highlight on the moved row when the pointer has not moved', () => {
        render(<Harness />);
        fireEvent.mouseEnter(screen.getByTestId('label-preset-c'));
        fireEvent.mouseEnter(screen.getByTestId('label-move-up-c'));
        expect(painted()).toEqual(['label-preset-c', 'label-move-up-c']);

        mouseClick('label-move-up-c');
        // The row moved up; Chromium now says the pointer is over `b`, which slid into the slot.
        hoverJumpsTo('b', 'up', { row: 'c', arrow: 'up' });

        // …and the tab does not believe it: the wash and the arrow fill stay with the row that
        // moved, which is the bounce the owner reported, refused.
        expect(painted()).toEqual(['label-preset-c', 'label-move-up-c']);
        expect(activeID()).toBe('label-move-up-c');
    });

    it('paints the row’s OTHER arrow when the press drove it into an end', () => {
        render(<Harness />);
        fireEvent.mouseEnter(screen.getByTestId('label-move-up-b'));
        mouseClick('label-move-up-b');
        expect((screen.getByTestId('label-move-up-b') as HTMLButtonElement).disabled).toBe(true);
        // The pressed arrow disabled itself, so both the ring and the paint move to the arrow
        // that is still armed — the one that walks the row back.
        expect(activeID()).toBe('label-move-down-b');
        expect(painted()).toEqual(['label-preset-b', 'label-move-down-b']);
    });

    /**
     * Whether the park is still on, asked the way it MATTERS: park is "the list will not
     * re-decide what is hovered", so the question is whether a fresh hover can light a row.
     *
     * Read this way rather than off the moved row's own paint on purpose. jsdom has no pointer,
     * and `matches(':hover')` there is not a pointer state at all — it answers about the ACTIVE
     * element — so any assertion whose value comes from jsdom's `:hover` is asserting a quirk.
     * This one is pure port logic, and reads identically in a browser.
     */
    function anotherRowCanLight(row: string): boolean {
        fireEvent.mouseEnter(screen.getByTestId(`label-preset-${row}`));
        const lit = painted().includes(`label-preset-${row}`);
        fireEvent.mouseLeave(screen.getByTestId(`label-preset-${row}`));
        return lit;
    }

    it('releases the park when the pointer really moves', () => {
        render(<Harness />);
        fireEvent.mouseEnter(screen.getByTestId('label-move-up-c'));
        mouseClick('label-move-up-c', { x: 400, y: 300 });
        expect(anotherRowCanLight('d')).toBe(false);
        movePointer(460, 300);
        // Released: hover is the pointer's business again, and the paint is no longer pinned.
        expect(anotherRowCanLight('d')).toBe(true);
    });

    it('ignores pointer jitter smaller than the slop', () => {
        render(<Harness />);
        fireEvent.mouseEnter(screen.getByTestId('label-move-up-c'));
        mouseClick('label-move-up-c', { x: 400, y: 300 });
        // A hand resting on a mouse. This is the movement that would make the fix look right in
        // the lab and fail on the owner's desk, so it is asserted rather than assumed.
        movePointer(402, 301);
        movePointer(399, 302);
        expect(painted()).toEqual(['label-preset-c', 'label-move-up-c']);
        expect(anotherRowCanLight('d')).toBe(false);
        movePointer(410, 300);
        expect(anotherRowCanLight('d')).toBe(true);
    });

    it('parks a KEYBOARD reorder too, and lets any pointer movement release it', () => {
        render(<Harness />);
        const up = screen.getByTestId('label-move-up-c');
        up.focus();
        // `fireEvent.click` with no `detail` is an Enter/Space activation: no pointer, no origin,
        // so there is no anchor to measure jitter against and the first movement releases.
        fireEvent.click(up);
        expect(painted()).toEqual(['label-preset-c', 'label-move-up-c']);
        expect(anotherRowCanLight('d')).toBe(false);
        movePointer(1, 1);
        expect(anotherRowCanLight('d')).toBe(true);
    });

    it('re-reads a moved control’s hover from the DOM instead of waiting for a mouseleave', () => {
        // The ghost: `c` is hovered, the list moves it, and Chromium sends the `mouseleave` to a
        // node it has already detached — so nothing clears it and the tab paints TWO hovered
        // rows at once (measured live on the pre-fix bundle, CASE 5: `alpha,charlie`).
        //
        // The fix is to ASK the DOM again on the commit that moved the row. jsdom's `:hover`
        // cannot answer that question, so the DOM's answer is stubbed and what is asserted is
        // that the tab asks at all, and believes the answer over the event it never got.
        const matches = vi.spyOn(HTMLElement.prototype, 'matches');
        matches.mockImplementation(function (this: HTMLElement, selector: string): boolean {
            return selector === ':hover' ? false : Object.getPrototypeOf(HTMLElement.prototype).matches !== undefined;
        });
        try {
            render(<Harness />);
            fireEvent.mouseEnter(screen.getByTestId('label-preset-c'));
            expect(painted()).toContain('label-preset-c');
            mouseClick('label-move-up-c');
            movePointer(600, 600);
            expect(painted()).toEqual([]);
        } finally {
            matches.mockRestore();
        }
    });

    /*
     * The idempotent half. One gesture is not always one commit: the daemon may answer with more
     * than one, and another client can reorder the same list at any time. The intent is keyed to
     * the PRESET ID, so any later commit that changes row identity re-asserts it — measured live
     * as CASE 7, where the pre-fix bundle drops `document.activeElement` to `<body>`.
     */
    it('re-asserts the ring on a LATER commit, on the same preset’s arrow', () => {
        render(
            <Harness
                external={(list) => {
                    // Another client sends `a` to the end: `c` lands in the first slot, so the ↑
                    // holding focus disables under it.
                    const next = list.filter((preset) => preset.name !== 'a');
                    const moved = list.find((preset) => preset.name === 'a');
                    return moved === undefined ? list : [...next, moved];
                }}
            />
        );
        mouseClick('label-move-up-c');
        expect(activeID()).toBe('label-move-up-c');
        fireEvent.click(screen.getByTestId('third-party'));
        expect(
            Array.from(document.querySelectorAll('[data-testid^="label-preset-"]')).map((node) =>
                (node.getAttribute('data-testid') ?? '').replace('label-preset-', '')
            )
        ).toEqual(['c', 'b', 'd', 'a']);
        expect((screen.getByTestId('label-move-up-c') as HTMLButtonElement).disabled).toBe(true);
        expect(activeID()).toBe('label-move-down-c');
    });

    it('never steals the ring back once focus has left the tab', () => {
        render(
            <Harness
                external={(list) => {
                    const next = list.filter((preset) => preset.name !== 'a');
                    const moved = list.find((preset) => preset.name === 'a');
                    return moved === undefined ? list : [...next, moved];
                }}
            />
        );
        mouseClick('label-move-up-c');
        expect(activeID()).toBe('label-move-up-c');
        // The user moves on — a control outside the tab entirely (the terminal taking the caret
        // when the window activates is the real case). A later reorder must not yank it back.
        screen.getByTestId('outside').focus();
        fireEvent.click(screen.getByTestId('third-party'));
        expect(activeID()).toBe('outside');
    });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * N33 (run-AH) — a FINISHED reorder must not replay into whatever the user does next.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The re-assert that makes a burst and a second client's move land correctly was armed for ever:
 * the intent was re-asserted by every later commit that changed the ORDER and never cleared. A
 * preset's identity IS its name (SET-066), so the order key is the names joined — and a RENAME
 * changes it. Any rename after any reorder therefore replayed a gesture the user had finished,
 * measured on the live stack (`docs/audit/n32-33-verify-ah/`):
 *
 *   (F) a rename echo landing inside the 110 ms a human holds the mouse button down on ANOTHER
 *       row put the ring and the wash on a row nobody was touching, mid-gesture;
 *   (G) renaming any preset after having used an arrow jumped focus to that arrow;
 *   (H) the ordinary two-field edit — type in one name, click into another — took the caret out
 *       of the field just clicked, so the next keystrokes were lost AND the SPACE in them pressed
 *       the focused arrow and silently reordered the list.
 *
 * The two guards written for the wave could see none of it: one never performed a reorder first
 * (so nothing was ever armed), and the other moved focus OUTSIDE the tab (so the `foreign` guard
 * answered instead). Both of these cases put focus on another control INSIDE the tab after a real
 * reorder, which is where the defect lives. Each fails on the pre-fix shape — an intent that is
 * re-armed rather than judged — and passes once a re-assert is allowed only while focus is still
 * on the moved row's own arrows.
 */
describe('a finished reorder does not replay (N33, run-AH)', () => {
    const FIVE: readonly ChromeLabelPreset[] = [
        { name: 'a', color: { kind: 'named', color: 'gray' }, textColor: null },
        { name: 'b', color: { kind: 'named', color: 'blue' }, textColor: null },
        { name: 'c', color: { kind: 'named', color: 'red' }, textColor: null },
        { name: 'd', color: { kind: 'named', color: 'green' }, textColor: null },
        { name: 'e', color: { kind: 'named', color: 'purple' }, textColor: null }
    ];

    /**
     * A list that both REORDERS and RENAMES, which is what these cases need and the older
     * harnesses do not have: a rename is the order change that replays the stale gesture.
     *
     * `echo` is a rename arriving from the daemon with nobody touching the tab — the button is
     * outside the tab and `fireEvent.click` does not focus in jsdom, so pressing it changes the
     * list while leaving `document.activeElement` exactly where the test put it. That is the only
     * way to model an echo landing MID-GESTURE (F).
     */
    function LiveHarness(props: { readonly echo?: { readonly id: string; readonly name: string } }): ReactElement {
        const [presets, setPresets] = useState<readonly ChromeLabelPreset[]>(FIVE);
        // Chromium blurs an element it moves in the tree or disables under the finger; jsdom does
        // neither, and the transient `<body>` it leaves is exactly what the fix must still honour.
        const blurArrowLikeChromium = (): void => {
            const active = document.activeElement as HTMLElement | null;
            if ((active?.getAttribute('data-testid') ?? '').startsWith('label-move-')) active?.blur();
        };
        const rename = (id: string, name: string): void => {
            setPresets((current) =>
                current.map((preset) => (preset.name === id ? { ...preset, name } : preset))
            );
        };
        return (
            <>
                <button
                    type="button"
                    data-testid="echo"
                    onClick={() => {
                        if (props.echo !== undefined) rename(props.echo.id, props.echo.name);
                    }}
                >
                    echo
                </button>
                <LabelsTab
                    presets={presets}
                    workspaces={[]}
                    actions={{
                        ...actions(),
                        moveLabelPreset: ({ id, index }) => {
                            blurArrowLikeChromium();
                            setPresets((current) => {
                                const from = current.findIndex((preset) => preset.name === id);
                                if (from < 0) return current;
                                const next = current.slice();
                                const [moved] = next.splice(from, 1);
                                if (moved === undefined) return current;
                                next.splice(Math.max(0, Math.min(next.length, index)), 0, moved);
                                return next;
                            });
                        },
                        updateLabelPreset: (input) => {
                            if (typeof input.name === 'string') rename(input.id, input.name);
                        }
                    }}
                    bucket="dark"
                />
            </>
        );
    }

    const activeID = (): string =>
        document.activeElement === document.body
            ? 'BODY'
            : (document.activeElement?.getAttribute('data-testid') ?? 'unknown');

    function order(): string[] {
        return Array.from(document.querySelectorAll('[data-testid^="label-preset-"]')).map((node) =>
            (node.getAttribute('data-testid') ?? '').replace('label-preset-', '')
        );
    }

    /** A MOUSE click: `detail > 0` and a real position, which is what a keyboard press lacks. */
    function mouseClick(testID: string, at = { x: 400, y: 300 }): void {
        fireEvent.click(screen.getByTestId(testID), { detail: 1, clientX: at.x, clientY: at.y });
    }

    /** Chromium focuses a `<button>` on MOUSEDOWN — a whole hold before its click fires. */
    function pressAndHold(testID: string): void {
        const button = screen.getByTestId(testID);
        act(() => {
            fireEvent.mouseDown(button, { detail: 1, clientX: 400, clientY: 300 });
            button.focus();
        });
    }

    /** Click into a field the way a person does: the caret goes there, the old field commits. */
    function clickInto(testID: string): HTMLInputElement {
        const field = screen.getByTestId(testID) as HTMLInputElement;
        act(() => {
            field.focus();
        });
        return field;
    }

    /**
     * SPACE, delivered where focus actually IS — which is the whole point of (H). In a text field
     * it is a character; on a focused `<button>` the browser makes it an ACTIVATION, so it presses
     * the arrow and reorders the list. jsdom synthesises neither, so both are modelled here.
     */
    function pressSpace(): void {
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement) {
            fireEvent.click(active);
            return;
        }
        if (active instanceof HTMLInputElement) {
            fireEvent.change(active, { target: { value: `${active.value} ` } });
        }
    }

    /*
     * (F) — the echo lands INSIDE the hold, on a row the gesture is not about.
     *
     * The live frame log: `+82..182ms focus=label-move-down-bravo` while the button on `charlie`
     * was still held down, 99 ms of ring and wash on a row the user had not touched in this
     * gesture. Here: a reorder of `c` settles, the user presses and holds `b`'s ↑, and a rename
     * of an unrelated preset arrives before the click fires.
     */
    it('does not replay a settled reorder when a rename echo lands during a mouse hold on another row', () => {
        render(<LiveHarness echo={{ id: 'e', name: 'renamed-by-the-daemon' }} />);
        mouseClick('label-move-up-c');
        expect(order()).toEqual(['a', 'c', 'b', 'd', 'e']);
        expect(activeID()).toBe('label-move-up-c');

        // The pointer moves to another row and the button goes down: Chromium focuses it here,
        // a whole hold before the click that will actually dispatch the move.
        pressAndHold('label-move-up-b');
        expect(activeID()).toBe('label-move-up-b');

        // …and the echo of a rename nobody in this gesture asked for arrives mid-hold.
        fireEvent.click(screen.getByTestId('echo'));
        expect(order()).toEqual(['a', 'c', 'b', 'd', 'renamed-by-the-daemon']);
        expect(activeID()).toBe('label-move-up-b');
        // Nor may the WASH be dragged back onto the settled row: what is painted is read by row
        // identity, which is the channel the reopening was actually about.
        expect(
            Array.from(document.querySelectorAll('[data-hovered="true"]')).map((node) =>
                node.getAttribute('data-testid')
            )
        ).not.toContain('label-preset-c');

        // The gesture the user is actually making then completes normally.
        mouseClick('label-move-up-b');
        expect(order()).toEqual(['a', 'b', 'c', 'd', 'renamed-by-the-daemon']);
        expect(activeID()).toBe('label-move-up-b');
    });

    /*
     * (G) — the plain one: reorder, walk away, rename something else.
     */
    it('does not yank focus to the old arrow when a LATER rename changes the order', () => {
        render(<LiveHarness />);
        mouseClick('label-move-up-c');
        expect(activeID()).toBe('label-move-up-c');

        // The user moves on to a control INSIDE the tab — which is the half the shipped guards
        // missed, because `foreign` only ever answered for controls outside it.
        const field = clickInto('label-rename-field-e');
        fireEvent.change(field, { target: { value: 'typed-later' } });
        fireEvent.keyDown(field, { key: 'Enter' });

        expect(order()).toEqual(['a', 'c', 'b', 'd', 'typed-later']);
        // The rename replaced the row (SET-066), so focus lands wherever the removed field left
        // it — `<body>`, which is where a pristine HEAD bundle leaves it too. What may NOT happen
        // is the ring appearing on an arrow the user last touched a gesture ago.
        expect(activeID()).not.toMatch(/^label-move-/);
    });

    /*
     * (H) — the severe form, and the one that loses keystrokes: two name fields in a row.
     */
    it('keeps the caret in the second name field when the first commits, and SPACE stays a space', () => {
        render(<LiveHarness />);
        mouseClick('label-move-up-c');
        expect(activeID()).toBe('label-move-up-c');

        // Edit one name…
        const first = clickInto('label-rename-field-a');
        fireEvent.change(first, { target: { value: 'edited-one' } });
        // …then click straight into another row's field, which is how anyone edits two labels.
        // The blur commits the first rename, the order changes, and the stale gesture used to be
        // replayed onto an arrow right here.
        clickInto('label-rename-field-e');
        expect(order()).toEqual(['edited-one', 'c', 'b', 'd', 'e']);
        expect(activeID()).toBe('label-rename-field-e');

        // …so what is typed next lands in the field, and the SPACE in it is a character rather
        // than a press of a focused arrow. Measured live on the pre-fix bundle, the space
        // reordered the list: `alpha echo charlie bravo edited-one` → `alpha echo bravo charlie
        // edited-one`, while the field never took a character.
        const before = order();
        fireEvent.change(screen.getByTestId('label-rename-field-e'), { target: { value: 'two' } });
        pressSpace();
        pressSpace();
        expect(activeID()).toBe('label-rename-field-e');
        expect((screen.getByTestId('label-rename-field-e') as HTMLInputElement).value).toBe('two  ');
        expect(order()).toEqual(before);
    });
});

/*
 * (J) — the residual `run-AH2` bounded, closed. PROMOTED from
 * `docs/audit/n32-33-verify-ah2/probe-J.test.tsx`, where it was kept FAILING on purpose as the
 * record of a hole: the first honour was unconditional, so an intent armed by a press whose
 * order-changing commit had not come back yet was still owed one, and it was paid into whatever
 * the user was doing when a commit finally arrived. The verifier measured the live window at
 * 14-15 ms on all four corners (a local daemon's echo) — narrower than the second press of a
 * double-click, so unreachable by hand — but a daemon across a real network, or a
 * `move-label-preset` refused or dropped across a reconnect, widens it without limit.
 *
 * The closure is an EVENT, not a timer and not a second reading of `activeElement` at commit
 * time: a non-arrow `focusin` after the press means the user moved on, so the intent is dead.
 * Both halves are asserted here — the intent that must die, and the one that must still be
 * honoured through the transient `<body>` a moved or disabled arrow leaves behind.
 */
describe('an un-honoured intent dies when the user moves on (N33, run-AH2)', () => {
    const FIVE: readonly ChromeLabelPreset[] = [
        { name: 'a', color: { kind: 'named', color: 'gray' }, textColor: null },
        { name: 'b', color: { kind: 'named', color: 'blue' }, textColor: null },
        { name: 'c', color: { kind: 'named', color: 'red' }, textColor: null },
        { name: 'd', color: { kind: 'named', color: 'green' }, textColor: null },
        { name: 'e', color: { kind: 'named', color: 'purple' }, textColor: null }
    ];

    /**
     * The daemon has NOT answered the move (or answered with no order change at all — a move to
     * the index the row already holds, which is what a second client's earlier move leaves), so
     * the intent sits armed and un-honoured. The `echo` button then delivers the first
     * order-changing commit: a plain RENAME of another row, from outside the tab, with focus left
     * exactly where the test put it.
     */
    function SlowHarness(): ReactElement {
        const [presets, setPresets] = useState<readonly ChromeLabelPreset[]>(FIVE);
        return (
            <>
                <button
                    type="button"
                    data-testid="echo"
                    onClick={() => {
                        setPresets((current) =>
                            current.map((preset) =>
                                preset.name === 'd' ? { ...preset, name: 'd-renamed' } : preset
                            )
                        );
                    }}
                >
                    echo
                </button>
                <LabelsTab
                    presets={presets}
                    workspaces={[]}
                    actions={{
                        ...actions(),
                        // The move goes out and nothing comes back. Chromium blurs a button it
                        // moves or disables under the finger; jsdom does neither, so the blur is
                        // modelled here — and the `<body>` it leaves must NOT read as moving on.
                        moveLabelPreset: () => {
                            const active = document.activeElement as HTMLElement | null;
                            if ((active?.getAttribute('data-testid') ?? '').startsWith('label-move-')) {
                                active?.blur();
                            }
                        }
                    }}
                    bucket="dark"
                />
            </>
        );
    }

    const activeID = (): string =>
        document.activeElement === document.body
            ? 'BODY'
            : (document.activeElement?.getAttribute('data-testid') ?? 'unknown');

    const order = (): string[] =>
        Array.from(document.querySelectorAll('[data-testid^="label-preset-"]')).map((node) =>
            (node.getAttribute('data-testid') ?? '').replace('label-preset-', '')
        );

    /** A mouse press on an arrow: Chromium focuses the `<button>` on mousedown, then clicks. */
    function pressArrow(testID: string): void {
        const arrow = screen.getByTestId(testID);
        act(() => {
            fireEvent.mouseDown(arrow, { detail: 1, clientX: 400, clientY: 300 });
            arrow.focus();
        });
        fireEvent.click(arrow, { detail: 1, clientX: 400, clientY: 300 });
    }

    it('does not pay a pending arrow press into a name field the user has moved to', () => {
        render(<SlowHarness />);
        pressArrow('label-move-up-c');
        // Nothing came back: the order is untouched and the intent is armed, un-honoured.
        expect(order()).toEqual(['a', 'b', 'c', 'd', 'e']);

        // The user moves on — into another row's name field.
        const field = screen.getByTestId('label-rename-field-e') as HTMLInputElement;
        act(() => {
            field.focus();
        });
        expect(activeID()).toBe('label-rename-field-e');

        // …and NOW the first order-changing commit arrives: a rename of an unrelated row.
        act(() => {
            fireEvent.click(screen.getByTestId('echo'));
        });
        expect(order()).toEqual(['a', 'b', 'c', 'd-renamed', 'e']);
        expect(activeID()).toBe('label-rename-field-e');
    });

    /*
     * The other half, and the reason this is not simply "disarm on every commit": the first
     * honour still fires for a gesture the user has NOT left. Focus here is `<body>` at the
     * commit — the blur a moved or disabled arrow leaves — which the layout effect must keep
     * treating as "still mine", because that is the common case the intent exists for at all.
     */
    it('still honours a pending press when the user has not moved on, through a transient BODY', () => {
        render(<SlowHarness />);
        pressArrow('label-move-up-c');
        expect(activeID()).toBe('BODY');

        act(() => {
            fireEvent.click(screen.getByTestId('echo'));
        });
        expect(order()).toEqual(['a', 'b', 'c', 'd-renamed', 'e']);
        expect(activeID()).toBe('label-move-up-c');
    });

    /*
     * A burst keeps focus on ARROWS, which is why the rule is "a non-arrow took focus" and not
     * "focus moved": three presses inside one echo re-arm on every press and must still land on
     * the row, including when they cross rows.
     */
    it('survives a burst of presses, including one that crosses rows', () => {
        render(<SlowHarness />);
        pressArrow('label-move-up-c');
        pressArrow('label-move-up-c');
        pressArrow('label-move-down-b');
        expect(activeID()).toBe('BODY');

        act(() => {
            fireEvent.click(screen.getByTestId('echo'));
        });
        // The LAST press owns the gesture, and it is honoured onto its own row's arrow.
        expect(activeID()).toBe('label-move-down-b');
    });
});
