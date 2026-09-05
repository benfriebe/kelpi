/**
 * Settings ▸ the MEDIUM fidelity row, tab by tab (M40…M47, M51, M52).
 *
 * Every case below names the Swift line it is measuring against, because each one is a claim
 * about a metric, an order or a control KIND rather than about behaviour — the class of
 * divergence a capability test cannot see and the reason `../kelpi-docs/UI-FIDELITY.md` exists.
 *
 *   M40  the Labels preview chip is the chip it previews (a capsule, medium, 10 px);
 *   M41  zebra striping on the Keybindings table and the Labels preset list;
 *   M42  trigger chips are the rounded UI face at 13 px, not 11 px monospace;
 *   M43  the remove-trigger / clear-hotkey control is a FILLED-CIRCLE glyph;
 *   M44  the Keybindings footer strip is back, pinned, with Reset All at the END;
 *   M45  all four empty states carry their large glyph, centred with no card;
 *   M46  a row's detail copy is its own full-width row UNDER the control, and a section's
 *        caption comes LAST;
 *   M47  Profiles: rail glyphs, an "Environment Variables" heading, an aligned marker row;
 *   M51  the six system-stat rows carry the glyph the status bar draws for them;
 *   M52  the two General placement rows are pop-up menus, not segmented controls.
 *
 * M47's and M52's own cases live beside their tabs' existing suites (`ProfilesTab.test.tsx`,
 * `GeneralTab.test.tsx`) where the fixtures already are; what is here is everything else.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientKeyBindings, type ChromeLabelPreset } from '../chrome';
import { AppearanceTab } from './AppearanceTab';
import { KeybindingsTab } from './KeybindingsTab';
import { LabelsTab } from './LabelsTab';
import { RepositoriesTab } from './RepositoriesTab';
import { WebTab } from './WebTab';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';
import { SettingsRow, SettingsSection } from './ui';

function actions(): SettingsActions {
    return {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn(),
        moveLabelPreset: vi.fn()
    };
}

function snapshot(patch: Partial<WsSettingsSnapshot> = {}): WsSettingsSnapshot {
    return { ...DEFAULT_WS_SETTINGS, ...patch };
}

afterEach(cleanup);

// ── M46 ─────────────────────────────────────────────────────────────────────────────

describe('M46 — where the explanatory copy goes', () => {
    /**
     * `SettingsView.swift:141-148`: the caption is the KELPIT CHILD of the `Section`, after the
     * `Toggle` — a row of its own spanning the section's width, not a second line squeezed into
     * the label column.
     */
    it('puts a row’s detail on its own line under the control, not beside it', () => {
        render(
            <SettingsRow label="Auto-detect from pane directories" detail="Removed a few seconds after…" testID="probe-row">
                <button type="button" data-testid="probe-control">
                    on
                </button>
            </SettingsRow>
        );
        const row = screen.getByTestId('probe-row');
        const control = screen.getByTestId('probe-control');
        const detail = [...row.children].at(-1);
        expect(detail?.textContent).toBe('Removed a few seconds after…');
        // The detail is a SIBLING of the label+control line, so the control cannot be inside it.
        expect(detail?.contains(control)).toBe(false);
        expect(row.children).toHaveLength(2);
        expect(row.children[0]?.contains(control)).toBe(true);
    });

    it('renders a section caption LAST, after the children it describes', () => {
        render(
            <SettingsSection title="Worktrees" hint="Worktrees are created at <base path>/<name>." testID="probe-section">
                <div data-testid="probe-child">Base path</div>
            </SettingsSection>
        );
        const section = screen.getByTestId('probe-section');
        const order = [...section.children].map((node) => node.tagName.toLowerCase());
        expect(order[0]).toBe('h3');
        // L79 put the rows inside the section's CARD; the caption is still the last child of the
        // section, and still outside the card.
        const card = screen.getByTestId('probe-section-card');
        expect(section.children[1]).toBe(card);
        expect(card.contains(screen.getByTestId('probe-child'))).toBe(true);
        expect([...section.children].at(-1)?.textContent).toContain('Worktrees are created at');
        expect(card.contains([...section.children].at(-1) as Node)).toBe(false);
    });

    it('carries the same shape through the writing controls', () => {
        render(<AppearanceTab paths={DEFAULT_SETTINGS_PATHS} settings={snapshot()} actions={actions()} bucket="dark" />);
        // `SliderField` — the one whose label column is a fixed 140 px, so a detail folded into
        // it was the most cramped of the five. (Colour intensity's caption became its SECTION's
        // caption in L81, which is where the Swift has it; Background opacity is the slider that
        // still carries one of its own.)
        const row = screen.getByTestId('terminal-opacity');
        expect([...row.children].at(-1)?.textContent).toContain('Blended into every pane fill');
        expect([...row.children].at(-1)?.querySelector('input')).toBeNull();
    });
});

// ── M40 / M41 / M45 (Labels) ────────────────────────────────────────────────────────

describe('Settings ▸ Labels', () => {
    const PRESETS: readonly ChromeLabelPreset[] = [
        { name: 'ship', color: { kind: 'named', color: 'gray' }, textColor: null },
        { name: 'wip', color: { kind: 'named', color: 'blue' }, textColor: null },
        { name: 'hold', color: { kind: 'named', color: 'red' }, textColor: null }
    ];

    function renderLabels(presets: readonly ChromeLabelPreset[] = PRESETS) {
        render(<LabelsTab presets={presets} workspaces={[]} actions={actions()} bucket="dark" />);
    }

    /**
     * M40. `WorkspaceLabelViews.swift:7-31`'s `LabelChip` — the view this column previews — is a
     * `Capsule` around `.font(.system(size: 10, weight: .medium))`. The port drew a 4 px-radius
     * rectangle at 11 px regular, a shape no label in the app has.
     */
    // §N32 SWAP: `label-new-preview` was the composer's draft chip. Every preset row still
    // carries the chip this rule is about, so the loop is over rows.
    it('M40 — previews the chip it previews: a capsule at 10 px medium', () => {
        renderLabels();
        for (const id of ['label-chip-ship', 'label-chip-wip']) {
            const chip = screen.getByTestId(id);
            expect(chip.className).toContain('rounded-full');
            expect(chip.className).toContain('text-[10px]');
            expect(chip.className).toContain('font-medium');
            expect(chip.className).not.toContain('text-[11px]');
        }
    });

    /** M41. `.listStyle(.inset(alternatesRowBackgrounds: true))` at `:74`. */
    it('M41 — stripes the preset list, even rows clear and odd rows washed', () => {
        renderLabels();
        const rows = ['ship', 'wip', 'hold'].map((name) => screen.getByTestId(`label-preset-${name}`));
        expect(rows.map((row) => row.dataset['stripe'])).toEqual(['base', 'alternate', 'base']);
        expect(rows[0]?.style.background).toBe('transparent');
        expect(rows[1]?.style.background).toContain('128, 128, 128');
        expect(rows[1]?.style.background).not.toBe(rows[0]?.style.background);
    });

    /** M45. `LabelPresetsSettingsView.swift:82-93` — `tag` at 28 pt over the two lines. */
    it('M45 — opens its empty state with the 28 pt tag glyph', () => {
        renderLabels([]);
        const glyph = screen.getByTestId('labels-empty-glyph').querySelector('svg');
        expect(glyph?.getAttribute('width')).toBe('28');
        // §N36(2) SWAP: the Swift headline is "No label presets yet" (`:88`). M45 is about the
        // SHAPE of the empty state — a 28 pt glyph over a headline and a caption, not an inline
        // emoji on one paragraph — and that is untouched; the owner directed the noun.
        expect(screen.getByTestId('labels-empty').textContent).toContain('No labels yet');
        expect(screen.getByTestId('labels-empty').textContent).toContain('Define reusable labels');
        // The `VStack` has no card behind it; the port's dashed box was its own invention.
        expect(screen.getByTestId('labels-empty').className).not.toContain('border');
    });

    /**
     * The placeholder centres in the tab's real height, not in a 180px band near the top:
     * the tab root claims the panel's full height and the empty list section fills it, so
     * the empty state's own flex centring works on the space the user actually sees. The
     * fill is conditional - a populated list must read top-down again.
     */
    it('centres the empty state in the tab, not a band', () => {
        renderLabels([]);
        expect(screen.getByTestId('settings-tab-labels').className).toContain('min-h-full');
        expect(screen.getByTestId('label-presets').className).toContain('flex-1');
        expect(screen.getByTestId('labels-empty').className).toContain('flex-1');
        expect(screen.getByTestId('labels-empty').className).toContain('justify-center');
        cleanup();
        renderLabels();
        expect(screen.getByTestId('label-presets').className).not.toContain('flex-1');
    });
});

// ── M41 / M42 / M43 / M44 (Keybindings) ─────────────────────────────────────────────

describe('Settings ▸ Keybindings', () => {
    function renderKeybindings(globalHotkey: string | null = 'super+shift+space') {
        render(
            <KeybindingsTab
                bindings={clientKeyBindings([])}
                actions={actions()}
                configPath="~/.config/kelpi/config"
                globalHotkey={globalHotkey}
            />
        );
    }

    it('M41 — stripes the table rows rather than painting every one transparent', () => {
        renderKeybindings();
        const rows = [...screen.getByRole('table', { name: 'Pane Management keybindings' }).children];
        expect(rows.length).toBeGreaterThan(3);
        expect(rows.map((row) => (row as HTMLElement).dataset['stripe']).slice(0, 4)).toEqual([
            'base',
            'alternate',
            'base',
            'alternate'
        ]);
        expect((rows[0] as HTMLElement).style.background).toBe('transparent');
        expect((rows[1] as HTMLElement).style.background).toContain('128, 128, 128');
    });

    /**
     * M42. `KeybindingsSettingsView.swift:112-120` / `:161-169` —
     * `.font(.system(.body, design: .rounded))`, i.e. the rounded UI face at body size, on a
     * radius-4 quaternary fill. The port had 11 px monospace: a different family two points down.
     */
    it('M42 — draws trigger chips in the rounded UI face at 13 px', () => {
        renderKeybindings();
        const row = screen.getByTestId('keybinding-row-focus_next_pane');
        const chips = [...row.querySelectorAll('[data-chip="trigger"]')] as HTMLElement[];
        expect(chips.map((node) => node.textContent)).toContain('⌘]');
        for (const chip of chips) {
            expect(chip.style.fontSize).toBe('13px');
            expect(chip.style.fontFamily).toContain('ui-rounded');
            expect(chip.className).not.toContain('font-mono');
            // The fill, radius and padding were already the Swift's and must not have moved.
            expect(chip.className).toContain('rounded');
            expect(chip.className).toContain('px-1.5');
            expect(chip.style.background).toContain('128, 128, 128');
        }
        // The global hotkey's chip is the same object, not a second recipe.
        const hotkey = screen.getByTestId('global-hotkey-chip').parentElement;
        expect(hotkey?.dataset['chip']).toBe('trigger');
        expect(hotkey?.style.fontSize).toBe('13px');
        expect(hotkey?.style.fontFamily).toContain('ui-rounded');
    });

    /**
     * M43. `Image(systemName: "xmark.circle.fill")` — a filled disc, not a `×` character.
     *
     * The target was `h-4 w-4` until SPACING-REVIEW S50 (owner-directed) took it to a 20 px box
     * with a `-m-0.5` bleed, so it still OCCUPIES the 16 px M43 settled on. Both halves are
     * asserted, because either one alone is the wrong control: `h-5 w-5` without the bleed moves
     * the column, and the bleed without `h-5 w-5` is a 12 px target.
     */
    it('M43 — removes a trigger with a filled-circle glyph at a 20 px target that occupies 16 (S50)', () => {
        renderKeybindings();
        const remove = screen.getByTestId('keybinding-remove-focus_next_pane-super+]');
        expect(remove.className).toContain('h-5');
        expect(remove.className).toContain('w-5');
        expect(remove.className).toContain('-m-0.5');
        expect(remove.textContent).toBe('');
        const svg = remove.querySelector('svg');
        expect(svg?.querySelector('circle')?.getAttribute('fill')).toBe('currentColor');
        const clear = screen.getByTestId('global-hotkey-clear');
        expect(clear.querySelector('svg circle')?.getAttribute('fill')).toBe('currentColor');
        expect(clear.textContent).toBe('');
    });

    /**
     * M44. `KeybindingsSettingsView.swift:61-72` — `Divider()` then an `HStack` of the config
     * path, a `Spacer()` and "Reset All to Defaults", padded 12 and OUTSIDE the scrolling list.
     * The port had hoisted Reset to a header row, which made the destructive control the first
     * thing on a 40-row tab.
     */
    it('M44 — ends on a pinned footer carrying the path and Reset All', () => {
        renderKeybindings();
        const tab = screen.getByTestId('settings-tab-keybindings');
        const footer = screen.getByTestId('keybindings-footer');
        const scroller = screen.getByTestId('keybindings-scroll');
        // The bar is a SIBLING of the scrolling region, so no row can pass under it — the shape
        // `VStack(spacing: 0) { List; Divider(); bar }` has.
        expect([...tab.children]).toEqual([scroller, footer]);
        expect(scroller.className).toContain('overflow-y-auto');
        expect(scroller.contains(footer)).toBe(false);
        expect(footer.className).toContain('shrink-0');
        expect(footer.style.borderTop).toContain('--kelpi-border');
        expect(screen.getByTestId('settings-footer-note').textContent).toContain('~/.config/kelpi/config');
        // Reset is INSIDE the footer, and it is the footer's trailing control.
        const reset = screen.getByTestId('reset-all-keybindings');
        expect(footer.contains(reset)).toBe(true);
        expect([...footer.children].at(-1)).toBe(reset);
        // …and nothing above the first section is a button any more.
        expect(scroller.children[0]?.tagName.toLowerCase()).toBe('p');
    });
});

// ── M45 (Repositories, Web) ─────────────────────────────────────────────────────────

describe('M45 — the empty states carry their glyph', () => {
    /** `RepoRegistryView.swift:33-35` — `externaldrive` at 36 pt in `.quaternary`. */
    it('Repositories: a 36 px drive glyph, dimmed a step below tertiary', () => {
        render(
            <RepositoriesTab
                repos={[]}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
                autoDetectRepos={false}
            />
        );
        const empty = screen.getByTestId('repo-empty');
        const glyph = screen.getByTestId('repo-empty-glyph');
        expect(glyph.querySelector('svg')?.getAttribute('width')).toBe('36');
        expect(glyph.style.opacity).toBe('0.6');
        expect(empty.textContent).toContain('No repositories registered');
        expect(empty.className).not.toContain('border');
    });

    /** `SettingsView.swift:710-712` — `star` at 28 pt in `.tertiary`, not an 18 px yellow ☆. */
    it('Web: a 28 px star glyph in the label tone, not favourite yellow', () => {
        render(
            <WebTab
                favourites={[]}
                actions={{ renameFavourite: vi.fn(), removeFavourite: vi.fn(), moveFavourite: vi.fn() }}
            />
        );
        const glyph = screen.getByTestId('settings-favourites-empty-glyph');
        expect(glyph.querySelector('svg')?.getAttribute('width')).toBe('28');
        expect(glyph.style.color).toContain('--kelpi-fg-tertiary');
        expect(screen.getByTestId('settings-favourites-empty').textContent).toContain('No favourites yet');
    });
});

// ── M51 ─────────────────────────────────────────────────────────────────────────────

describe('M51 — the system-stat rows', () => {
    /**
     * `SettingsView.swift:444-447` labels each row `Label(displayName, systemImage:
     * kind.systemImage)` — the SAME glyph the status bar draws for that metric, which the port
     * already carried on `SYSTEM_STAT_META[kind].icon` and simply never rendered.
     */
    it('draws each metric’s own glyph, the one the footer uses', () => {
        render(
            <AppearanceTab
                paths={DEFAULT_SETTINGS_PATHS}
                settings={snapshot({
                    chrome: { ...DEFAULT_WS_SETTINGS.chrome, showSystemStats: true }
                })}
                actions={actions()}
                bucket="dark"
            />
        );
        const expected: Readonly<Record<string, string>> = {
            cpu: 'cpu',
            memory: 'memory',
            load: 'gauge',
            network: 'network',
            diskIO: 'diskio',
            diskSpace: 'drive'
        };
        for (const [kind, icon] of Object.entries(expected)) {
            const row = screen.getByTestId(`stats-kind-${kind}`);
            expect(row.querySelector('svg')?.dataset['icon']).toBe(icon);
        }
    });
});
