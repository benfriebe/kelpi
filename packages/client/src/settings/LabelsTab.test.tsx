import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
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
            /*
             * bgColor 150 / name flexes / textColor / preview 80 / (port-only reorder) /
             * action 40 — `LabelPresetsSettingsView.swift:7-12`.
             *
             * Two of those numbers moved, and the old assertion pinned both of the defects:
             *
             *   · S60 — `textColor` is 184, not the Swift's 124. 124 pt holds what the SWIFT
             *     draws there (one compact `Menu` + a well); this port draws the mode as three
             *     explicit choices, which need 179.5 px, so the group wrapped to two lines on
             *     every row at every width and the wrapped line drew over the usage caption.
             *   · S57 — the name track has a floor. As `minmax(0,1fr)` it was the only flexible
             *     track among five hard px ones, so a 760 px window took it to 14 px.
             */
            expect(node.style.gridTemplateColumns).toBe('150px minmax(100px,1fr) 184px 80px 44px 40px');
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

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * N32 — the composer has ONE position, and it reads as a composer.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */
describe('the composer’s place and identity (N32)', () => {
    /** The section's rows, in document order, restricted to the ones with a stable id. */
    function sectionOrder(): string[] {
        return Array.from(
            screen.getByTestId('label-presets').querySelectorAll<HTMLElement>('[data-testid]')
        )
            .map((node) => node.dataset['testid'] ?? '')
            .filter(
                (id) =>
                    id === 'label-add-heading' ||
                    id === 'label-add-row' ||
                    id === 'label-add-divider' ||
                    id === 'labels-empty' ||
                    id.startsWith('label-preset-')
            );
    }

    /*
     * N32(a). `LabelPresetsSettingsView.swift:27-35` is
     * `VStack(spacing: 0) { addRow; Divider(); if isEmpty { emptyState } else { List } }` — the
     * add row's position does not depend on whether any preset exists. H25 had moved it above
     * the LIST and left it below the EMPTY state, so on a fresh install the one control that is
     * always there sat at the bottom of the tab and jumped to the top on the first Add.
     */
    it('puts the composer first in the EMPTY state too, with the art below the divider', () => {
        setup([], []);
        expect(sectionOrder()).toEqual([
            'label-add-heading',
            'label-add-row',
            'label-add-divider',
            'labels-empty'
        ]);
    });

    it('and in exactly the same place once presets exist', () => {
        setup();
        expect(sectionOrder()).toEqual([
            'label-add-heading',
            'label-add-row',
            'label-add-divider',
            'label-preset-ship',
            'label-preset-wip'
        ]);
    });

    /*
     * N32(b). The composer's two signals: a name, and a ground of its own. The Swift's own
     * separation is structural (the add row is outside the `List`, above a `Divider()`, on the
     * plain surface while every preset row is a band inside an `alternatesRowBackgrounds` list),
     * and H26 requires the same grid in both — so the port says it with a heading plus a tint
     * the eye resolves, rather than by moving a column.
     */
    it('names the composer and gives it a ground no preset row wears', () => {
        setup();
        const heading = screen.getByTestId('label-add-heading');
        expect(heading.textContent).toBe('New preset');
        const add = screen.getByTestId('label-add-row');
        // The heading introduces the row it names: nothing between them.
        expect(heading.nextElementSibling).toBe(add);
        const row = screen.getByTestId('label-preset-ship');
        expect(add.style.background).not.toBe('');
        expect(add.style.background).not.toBe(row.style.background);
    });

    /*
     * …and it does it WITHOUT touching the grid H26 exists to hold. This is the assertion that
     * rejects the two candidates a border or a leading rail would have shipped: both move the
     * add row's cells off the preset rows' columns, and `labels-design` measures exactly that.
     */
    it('leaves the shared column template and the row inset untouched', () => {
        setup();
        const add = screen.getByTestId('label-add-row');
        const row = screen.getByTestId('label-preset-ship');
        expect(add.style.gridTemplateColumns).toBe(row.style.gridTemplateColumns);
        expect(add.style.borderWidth).toBe('');
        expect(add.style.borderLeft).toBe('');
        // S64's 10 × 8 — the density row that measured these off the shipped dialog.
        expect(add.className).toContain('px-2.5');
        expect(add.className).toContain('py-2');
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
