import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChromeLabelPreset } from '../chrome';
import { LabelsTab } from './LabelsTab';
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

    it('recolors through the palette, and no-ops on the current color', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-color-ship-purple'));
        expect(bound.log.updated).toEqual([{ id: 'ship', color: 'purple' }]);
        fireEvent.click(screen.getByTestId('label-color-wip-blue'));
        expect(bound.log.updated).toHaveLength(1);
    });

    it('creates a preset in gray, the same default the CLI back-fill uses', () => {
        const bound = setup();
        fireEvent.change(screen.getByTestId('label-new-name'), { target: { value: '  release  ' } });
        fireEvent.click(screen.getByTestId('label-add'));
        expect(bound.log.added).toEqual([{ name: 'release', color: 'gray' }]);
        expect((screen.getByTestId('label-new-name') as HTMLInputElement).value).toBe('');
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

    // H25: `VStack(spacing: 0) { addRow; Divider(); List }` — the add row is the FIRST thing on
    // the tab, not the last row under a list that can be longer than the window.
    it('puts the add row above the preset list, with a divider between them', () => {
        setup();
        const section = screen.getByTestId('label-presets');
        const order = Array.from(section.querySelectorAll<HTMLElement>('[data-testid]'))
            .map((node) => node.dataset['testid'] ?? '')
            .filter(
                (id) =>
                    id === 'label-add-row' || id === 'label-add-divider' || id.startsWith('label-preset-')
            );
        expect(order).toEqual([
            'label-add-row',
            'label-add-divider',
            'label-preset-ship',
            'label-preset-wip'
        ]);
    });

    // H26: one grid line per row, on LabelCol's widths — not a two-line stacked card.
    it('lays every row out on LabelCol’s fixed columns', () => {
        setup();
        for (const row of ['label-add-row', 'label-preset-ship', 'label-preset-wip']) {
            const node = screen.getByTestId(row);
            expect(node.style.display).toBe('grid');
            // bgColor 150 / name flexes / textColor 124 / preview 80 / (port-only reorder) /
            // action 40 — `LabelPresetsSettingsView.swift:7-12`.
            expect(node.style.gridTemplateColumns).toBe('150px minmax(0,1fr) 124px 80px 44px 40px');
            expect(node.style.columnGap).toBe('10px');
        }
    });

    // …and the columns are in the SAME ORDER in the add row as in a preset row, which is what
    // makes them line up: colour, name, text colour, preview, then the trailing controls.
    it('orders the add row’s cells the same way a preset row orders its own', () => {
        setup();
        const add = cells('label-add-row');
        const row = cells('label-preset-ship');
        // L93: the group announces the field AND the value in it, so the name is a prefix.
        expect(add[0]?.getAttribute('aria-label')).toBe('new preset color: Gray');
        expect(row[0]?.getAttribute('aria-label')).toBe('ship color: Gray');
        expect(add[1]?.getAttribute('data-testid')).toBe('label-new-name');
        expect(row[1]?.querySelector('input')?.getAttribute('data-testid')).toBe('label-rename-field-ship');
        expect(add[2]?.getAttribute('aria-label')).toBe('new preset text color: Auto');
        expect(row[2]?.getAttribute('aria-label')).toBe('ship text color: Auto');
        expect(add[3]?.querySelector('[data-testid="label-new-preview"]')).not.toBeNull();
        expect(row[3]?.querySelector('[data-testid="label-chip-ship"]')).not.toBeNull();
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
    it('lights a preset row and a colour swatch under the pointer', () => {
        setup();
        const row = screen.getByTestId('label-preset-ship');
        expect(row.dataset['hovered']).toBe('false');
        fireEvent.mouseEnter(row);
        expect(row.dataset['hovered']).toBe('true');
        expect(row.style.background).toContain('--nex-selection-fill');

        const swatch = screen.getByTestId('label-color-ship-purple');
        expect(swatch.style.outline).toBe('none');
        fireEvent.mouseEnter(swatch);
        expect(swatch.style.outline).toContain('--nex-selection-stroke');
    });
});

describe('designing a preset (SET-058, SET-061, SET-062)', () => {
    it('previews the draft chip live, placeholder first, then the typed name', () => {
        setup();
        const preview = screen.getByTestId('label-new-preview');
        expect(preview.textContent).toBe('label');
        expect(preview.dataset['placeholder']).toBe('true');
        fireEvent.change(screen.getByTestId('label-new-name'), { target: { value: 'release' } });
        expect(screen.getByTestId('label-new-preview').textContent).toBe('release');
        expect(screen.getByTestId('label-new-preview').dataset['placeholder']).toBe('false');
    });

    it('carries the chosen background AND text colour into the add', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-new-color-purple'));
        fireEvent.click(screen.getByTestId('label-new-text-white'));
        fireEvent.change(screen.getByTestId('label-new-name'), { target: { value: 'release' } });
        // The preview is painted with exactly what will be written.
        const preview = screen.getByTestId('label-new-preview');
        expect(preview.style.color).toBe('rgb(255, 255, 255)');
        fireEvent.click(screen.getByTestId('label-add'));
        expect(bound.log.added).toEqual([{ name: 'release', color: 'purple', textColor: '#ffffff' }]);
    });

    it('takes a custom hex from the colour well', () => {
        const bound = setup();
        fireEvent.change(screen.getByTestId('label-color-ship-custom'), { target: { value: '#ff8800' } });
        expect(bound.log.updated).toEqual([{ id: 'ship', color: '#ff8800' }]);
    });

    it('sends null for Auto, so the daemon re-derives black/white by luminance', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-text-ship-black'));
        fireEvent.click(screen.getByTestId('label-text-ship-auto'));
        expect(bound.log.updated).toEqual([
            { id: 'ship', textColor: '#000000' },
            { id: 'ship', textColor: null }
        ]);
    });

    it('shows the resolved text colour on the Aa sample: white on a dark chip, black on a light one', () => {
        setup([], [
            { name: 'dark', color: { kind: 'custom', hex: '#101014' }, textColor: null },
            { name: 'light', color: { kind: 'custom', hex: '#f4e7a1' }, textColor: null }
        ]);
        expect(screen.getByTestId('label-text-dark-sample').dataset['color']?.toLowerCase()).toBe('#ffffff');
        expect(screen.getByTestId('label-text-light-sample').dataset['color']?.toLowerCase()).toBe('#000000');
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
        expect(screen.getByTestId('label-rename-error-ship').textContent).toContain('already a preset');
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
        expect(screen.getByTestId('label-delete-confirm-ship').textContent).toContain('renders neutral');
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
