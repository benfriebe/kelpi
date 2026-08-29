/**
 * Settings ▸ the LOW-POLISH fidelity row, tab by tab (L79…L93).
 *
 * The metric-only rows share this one file per the campaign's rule, and every case names the
 * Swift line it measures against — each is a claim about a metric, a tone, a glyph or a tooltip
 * rather than about behaviour, which is the class a capability test cannot see.
 *
 *   L79  one rounded card per SECTION with hairline row separators, and a sentence-case
 *        default-size header — not a 6 % card per ROW under an uppercase micro-label;
 *   L80  the six `.help()` tooltips that had become `aria-label`s only;
 *   L81  Appearance's sidebar knobs are TWO sections, each with its own caption;
 *   L82  `sliderRow`'s 140 / 44 frames, Graph width's 32, and a readout rather than a `KeyChip`;
 *   L83  the worktree Base path field is borderless and fills its row;
 *   L84  theme-preset cells: `.primary` name, `VStack(spacing: 5)`;
 *   L85  the favourites row's title field is bordered and medium; the URL is `.secondary`;
 *   L86  Repositories' toolbar buttons carry their SF Symbols; a repo row paints nothing at rest;
 *   L88  the tab rail carries the seven `.tabItem` glyphs (plus one for the port-only tab);
 *   L89  nothing in the window swaps the arrow cursor for a hand;
 *   L90  arming a Keybindings row does not change the trailing cluster's width;
 *   L91  the Labels delete control is a trash GLYPH in the 40 px action column (already true
 *        before this wave — H26's; locked here so it cannot drift back to a bordered "Delete");
 *   L92  the Profiles placeholder's title is a `.headline`;
 *   L93  the Labels colour groups announce the VALUE, not just the field name.
 *
 * L87 lives with the repo picker (`chrome/RepoPicker.test.tsx`), and L93's row-level wording is
 * asserted in `LabelsTab.test.tsx` too.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@nex/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientKeyBindings, type ChromeLabelPreset } from '../chrome';
import type { WebFavourite } from '../webpane';
import { AppearanceTab } from './AppearanceTab';
import { GeneralTab } from './GeneralTab';
import { KeybindingsTab } from './KeybindingsTab';
import { LabelsTab } from './LabelsTab';
import { ProfilesTab } from './ProfilesTab';
import { RepositoriesTab } from './RepositoriesTab';
import { SettingsOverlay } from './SettingsOverlay';
import { WebTab } from './WebTab';
import { WorkspacesTab } from './WorkspacesTab';
import { SETTINGS_TABS } from './catalog';
import { SLIDER_LABEL_WIDTH, SLIDER_READOUT_WIDTH } from './controls';
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

const FAVOURITE: WebFavourite = {
    id: 'f1',
    title: 'Docs',
    url: 'https://example.com/docs',
    created_at: '2026-08-21T00:00:00Z',
    label: 'Docs'
};

afterEach(cleanup);

// ── L79 ─────────────────────────────────────────────────────────────────────────────

describe('L79 — the grouped-form card is the SECTION’s, not the row’s', () => {
    /**
     * `SettingsView.swift:128` / `:278` — `Form { … }.formStyle(.grouped)`. macOS draws one
     * rounded card per `Section`, with its rows flush inside it and a hairline between each
     * pair. The port had the fill on every row.
     */
    it('paints one card per section and rules a hairline between its rows', () => {
        render(
            <SettingsSection title="Workspaces" testID="probe">
                <SettingsRow label="First" testID="probe-first">
                    <span />
                </SettingsRow>
                <SettingsRow label="Second" testID="probe-second">
                    <span />
                </SettingsRow>
                <SettingsRow label="Third" testID="probe-third">
                    <span />
                </SettingsRow>
            </SettingsSection>
        );
        const card = screen.getByTestId('probe-card');
        expect(card.style.background).toContain('128, 128, 128');
        expect(card.className).toContain('rounded-md');

        const bands = [...card.children] as HTMLElement[];
        expect(bands).toHaveLength(3);
        // Every band is padded the same, and every band after the first carries the hairline.
        expect(bands.map((band) => band.style.padding)).toEqual(['6px 10px', '6px 10px', '6px 10px']);
        expect(bands[0]?.style.borderTop).toBe('');
        expect(bands[1]?.style.borderTop).toContain('--nex-border');
        expect(bands[2]?.style.borderTop).toContain('--nex-border');
    });

    /** The inversion, stated as its own assertion: a ROW has neither fill nor radius. */
    it('leaves the rows themselves unfilled and unrounded', () => {
        render(
            <SettingsSection title="Workspaces" testID="probe">
                <SettingsRow label="First" testID="probe-first">
                    <span />
                </SettingsRow>
            </SettingsSection>
        );
        const row = screen.getByTestId('probe-first');
        expect(row.style.background).toBe('');
        expect(row.className).not.toContain('rounded');
        expect(row.className).not.toContain('px-2');
    });

    /**
     * The writing controls are rows too — the register named all five
     * (`controls.tsx:84,155,210,281,353`), and one of them keeping its pill would put a card
     * inside a card.
     */
    it('carries the same through every writing control', () => {
        render(<AppearanceTab paths={DEFAULT_SETTINGS_PATHS} settings={snapshot()} actions={actions()} bucket="dark" />);
        for (const id of ['chrome-color-accent', 'sidebar-intensity', 'terminal-theme', 'terminal-font-family']) {
            const row = screen.getByTestId(id);
            expect(row.style.background).toBe('');
            expect(row.className).not.toContain('rounded');
        }
    });

    /** The header: sentence case at the body size, not an 11 px uppercase tertiary label. */
    it('titles a section in sentence case at the body size', () => {
        render(
            <SettingsSection title="Preset themes" testID="probe">
                <div />
            </SettingsSection>
        );
        const heading = screen.getByRole('heading', { name: 'Preset themes' });
        expect(heading.className).toContain('text-[13px]');
        expect(heading.className).not.toContain('uppercase');
        expect(heading.className).not.toContain('tracking-wide');
        expect(heading.style.color).toContain('--nex-fg');
        expect(heading.style.color).not.toContain('tertiary');
    });

    /**
     * The four tabs whose Swift is a `VStack` + `List` rather than a `Form` draw NO card:
     * `RepoRegistryView.swift:12-55`, `LabelPresetsSettingsView.swift:27-45`,
     * `ProfilesSettingsView.swift`, `SettingsView.swift:707-741`. Their rows carry their own
     * chrome, so a grouped card would be a second grouping drawn over the first.
     */
    it('draws no card on the four list-shaped tabs — and still does on the form ones', () => {
        render(
            <RepositoriesTab
                repos={[]}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
                autoDetectRepos={false}
            />
        );
        expect(screen.queryByTestId('registry-section-card')).toBeNull();
        // …while Auto-detect, which IS General ▸ Repositories' grouped-form row, keeps it.
        expect(screen.getByTestId('auto-detect-section-card')).toBeDefined();
        cleanup();

        render(<LabelsTab presets={[]} workspaces={[]} actions={actions()} bucket="dark" />);
        expect(screen.queryByTestId('label-presets-card')).toBeNull();
        cleanup();

        render(<ProfilesTab profiles={[]} actions={actions()} paths={DEFAULT_SETTINGS_PATHS} />);
        expect(screen.queryByTestId('profiles-list-section-card')).toBeNull();
        cleanup();

        render(
            <WebTab
                favourites={[]}
                actions={{ renameFavourite: vi.fn(), removeFavourite: vi.fn(), moveFavourite: vi.fn() }}
            />
        );
        expect(screen.queryByTestId('settings-favourites-card')).toBeNull();
    });

    /** A conditional row that renders `null` leaves no empty band and no stray hairline. */
    it('does not band a row that is not there', () => {
        render(
            <SettingsSection title="Network" testID="probe">
                <SettingsRow label="TCP listener" testID="probe-first">
                    <span />
                </SettingsRow>
                {null}
            </SettingsSection>
        );
        expect(screen.getByTestId('probe-card').children).toHaveLength(1);
    });
});

// ── L80 ─────────────────────────────────────────────────────────────────────────────

describe('L80 — the six missing `.help()` tooltips', () => {
    const PRESETS: readonly ChromeLabelPreset[] = [
        { name: 'ship', color: { kind: 'named', color: 'gray' }, textColor: null }
    ];

    /** `LabelPresetsSettingsView.swift:290, 362, 244`. */
    it('Labels: the two colour wells and the trash say what they do', () => {
        render(<LabelsTab presets={PRESETS} workspaces={[]} actions={actions()} bucket="dark" />);
        expect(screen.getByTestId('label-color-ship-custom').getAttribute('title')).toBe(
            'Pick a custom colour'
        );
        expect(screen.getByTestId('label-text-ship-custom').getAttribute('title')).toBe(
            'Pick a text colour'
        );
        // §N36(2) SWAP: the Swift's own help text is "Remove preset" (`:244`); the owner directed
        // the tab's user-facing vocabulary to LABELS, so the tooltip exists — which is what L80
        // is about — and says "Remove label". The divergence is recorded, not silent.
        expect(screen.getByTestId('label-delete-ship').getAttribute('title')).toBe('Remove label');
    });

    /** `SettingsView.swift:792`. */
    it('Web: the favourite’s Remove says "Remove favourite"', () => {
        render(
            <WebTab
                favourites={[FAVOURITE]}
                actions={{ renameFavourite: vi.fn(), removeFavourite: vi.fn(), moveFavourite: vi.fn() }}
            />
        );
        expect(screen.getByTestId('settings-favourite-remove-f1').getAttribute('title')).toBe(
            'Remove favourite'
        );
    });

    /** `ProfilesSettingsView.swift:101, 262`. */
    it('Profiles: Add Profile and a variable’s Remove carry theirs', () => {
        render(
            <ProfilesTab
                profiles={[
                    { name: 'work', env: { NEX_PROFILE: 'work', CLAUDE_CONFIG_DIR: '~/.claude-accounts/work' } }
                ]}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        expect(screen.getByTestId('profile-add').getAttribute('title')).toBe('Add profile');
        // `default` is pinned first, so the profile with a variable on it is the second row.
        fireEvent.click(screen.getByTestId('profile-row-work'));
        expect(screen.getByTestId('profile-var-remove-0').getAttribute('title')).toBe('Remove variable');
    });
});

// ── L81 / L82 / L84 (Appearance) ────────────────────────────────────────────────────

describe('Settings ▸ Appearance', () => {
    function renderAppearance(patch: Partial<WsSettingsSnapshot> = {}) {
        render(
            <AppearanceTab
                paths={DEFAULT_SETTINGS_PATHS}
                settings={snapshot(patch)}
                actions={actions()}
                bucket="dark"
            />
        );
    }

    /**
     * L81. `SettingsView.swift:384-409` — `Section("Sidebar")` over the intensity slider with its
     * own caption, then `Section("Sidebar fill & stroke")` over the four opacity rows with its
     * own. The port had merged them, so five sliders ran together with nothing marking the change
     * of subject.
     */
    it('L81 — splits the sidebar knobs into two captioned sections', () => {
        renderAppearance();
        const intensity = screen.getByTestId('appearance-sidebar');
        const style = screen.getByTestId('appearance-sidebar-style');
        expect(intensity).not.toBe(style);
        expect(screen.getByRole('heading', { name: 'Sidebar' })).toBeDefined();
        expect(screen.getByRole('heading', { name: 'Sidebar fill & stroke' })).toBeDefined();

        // The intensity section holds exactly its one slider…
        expect(screen.getByTestId('appearance-sidebar-card').children).toHaveLength(1);
        expect(intensity.contains(screen.getByTestId('sidebar-intensity'))).toBe(true);
        // …and the four opacities are the other section's.
        for (const id of ['sidebar-avatar-fill', 'sidebar-avatar-stroke', 'sidebar-group-fill', 'sidebar-group-stroke']) {
            expect(style.contains(screen.getByTestId(id))).toBe(true);
        }
        // Each keeps the caption the Swift section closes with.
        expect(intensity.textContent).toContain('Scales how vivid the group bands');
        expect(style.textContent).toContain('The intensity above multiplies these');
    });

    /** L82. `sliderRow` is 140 / 44 (`SettingsView.swift:506-515`); the port had 150 / 52. */
    it('L82 — sizes every slider row’s label and readout the Swift’s way', () => {
        renderAppearance();
        expect(SLIDER_LABEL_WIDTH).toBe(140);
        expect(SLIDER_READOUT_WIDTH).toBe(44);
        for (const id of ['sidebar-intensity', 'sidebar-avatar-fill', 'terminal-opacity']) {
            const row = screen.getByTestId(id);
            const label = [...row.querySelectorAll<HTMLElement>('div')].find(
                (node) => node.style.width !== ''
            );
            expect(label?.style.width).toBe('140px');
            expect(screen.getByTestId(`${id}-value`).style.width).toBe('44px');
        }
    });

    /**
     * L82's third clause. Graph width is not a `sliderRow` in the Swift: it writes its own
     * `HStack` and gives the readout `.frame(width: 32)` (`SettingsView.swift:472-474`).
     */
    it('L82 — narrows the Graph width readout to 32', () => {
        renderAppearance({
            chrome: { ...DEFAULT_WS_SETTINGS.chrome, showSystemStats: true, showSystemStatGraphs: true }
        });
        expect(screen.getByTestId('sparkline-width-value').style.width).toBe('32px');
    });

    /**
     * L84. `SettingsView.swift:559-566` — `VStack(spacing: 5)` and the name
     * `.foregroundStyle(.primary)`. The port had 4 px and `textSecondary`, which read as a
     * caption under a picture rather than as a button's label.
     */
    it('L84 — names a theme preset in the primary tone, 5 px under its swatch', () => {
        renderAppearance();
        const cell = screen.getByTestId('theme-preset-nord');
        expect(cell.className).toContain('gap-[5px]');
        expect(cell.className).not.toContain('gap-1 ');
        // The name is the cell's LAST child — the swatch mock above it has spans of its own.
        const name = [...cell.children].at(-1) as HTMLElement;
        expect(name.textContent).toBe('Nord');
        expect(name.style.color).toContain('--nex-fg');
        expect(name.style.color).not.toContain('secondary');
    });
});

// ── L82 (Workspaces) / L83 (General) ────────────────────────────────────────────────

describe('L82 / L83 — the two rows outside the Appearance tab', () => {
    /**
     * L82. `SettingsView.swift:218-220` — `Text("\(delay) ms").monospacedDigit().frame(width: 55,
     * alignment: .trailing)`. `KeyChip` is the KEY face, a grey monospace capsule, and wearing it
     * here said "chord" about a number of milliseconds.
     */
    it('L82 — reads the focus delay out as a plain tabular figure, not a key chip', () => {
        render(
            <WorkspacesTab
                settings={snapshot({
                    general: { ...DEFAULT_WS_SETTINGS.general, focusFollowsMouse: true, focusFollowsMouseDelay: 125 }
                })}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        const readout = screen.getByTestId('focus-delay-value');
        expect(readout.textContent).toBe('125 ms');
        expect(readout.className).toContain('tabular-nums');
        expect(readout.className).toContain('text-right');
        expect(readout.className).toContain('w-[55px]');
        // The chip's two tells: a monospace family and a filled capsule.
        expect(readout.className).not.toContain('font-mono');
        expect(readout.style.background).toBe('');
    });

    /**
     * L83. `SettingsView.swift:130-134` — `TextField(…).textFieldStyle(.plain)` in a bare
     * `HStack`, so the field has no border and simply takes the rest of the row. The port's
     * bordered `w-[180px]` clipped a long `<repo>`-substituted path.
     */
    it('L83 — lets the worktree base path fill its row, borderless', () => {
        render(
            <GeneralTab
                settings={snapshot()}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
                transport={null}
            />
        );
        const field = screen.getByTestId('worktree-base-path-input');
        expect(field.className).toContain('flex-1');
        expect(field.className).toContain('border-0');
        expect(field.className).not.toContain('w-[180px]');
        expect(field.style.borderColor).toBe('');
    });
});

// ── L85 / L86 ───────────────────────────────────────────────────────────────────────

describe('L85 — the web favourites row', () => {
    /** `SettingsView.swift:772-783` — `.roundedBorder` at 12 pt medium; the URL `.secondary`. */
    it('draws the title as an editable bordered field and the URL one tone up', () => {
        render(
            <WebTab
                favourites={[FAVOURITE]}
                actions={{ renameFavourite: vi.fn(), removeFavourite: vi.fn(), moveFavourite: vi.fn() }}
            />
        );
        const title = screen.getByTestId('settings-favourite-title-f1');
        expect(title.style.border).toContain('--nex-border');
        expect(title.style.border).not.toContain('transparent');
        expect(title.className).toContain('font-medium');
        const url = screen.getByTestId('settings-favourite-url-f1');
        expect(url.style.color).toContain('--nex-fg-secondary');
    });
});

describe('L86 — the Repositories tab', () => {
    function renderRepos() {
        render(
            <RepositoriesTab
                repos={[{ id: 'r1', name: 'nex', path: '/code/nex' }]}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
                autoDetectRepos={false}
            />
        );
    }

    /** `RepoRegistryView.swift:18-24` — `Label(_, systemImage: "folder.badge.gearshape" / "plus")`. */
    it('gives both toolbar buttons their SF Symbol back', () => {
        renderRepos();
        expect(screen.getByTestId('repo-scan').querySelector('svg')).not.toBeNull();
        expect(screen.getByTestId('repo-add').querySelector('svg')).not.toBeNull();
        // The words are still the words — the glyph joins the label, it does not replace it.
        expect(screen.getByTestId('repo-scan').textContent).toContain('Scan Directory');
        expect(screen.getByTestId('repo-add').textContent).toContain('Add Repo');
    });

    /** `.listStyle(.inset)` (`:48-54`) paints no per-row fill; hover is the only response. */
    it('paints a repo row nothing at rest and the selection fill under the pointer', () => {
        renderRepos();
        const row = screen.getByTestId('repo-row-r1');
        expect(row.style.background).toBe('transparent');
        fireEvent.mouseEnter(row);
        expect(row.style.background).toContain('--nex-selection-fill');
    });
});

// ── L88 / L89 ───────────────────────────────────────────────────────────────────────

describe('the Settings window itself', () => {
    function open() {
        render(
            <SettingsOverlay
                open
                settings={DEFAULT_WS_SETTINGS}
                domain={{ labelPresets: [], workspaces: [] }}
                actions={actions()}
                onClose={vi.fn()}
            />
        );
    }

    /**
     * L88. Every `.tabItem` in `SettingsView.swift:20-59` is a `Label(name, systemImage:)`, and
     * the rail had the names alone. The eighth entry is the port-only Workspaces tab, whose glyph
     * is chosen rather than ported — it still has to have one, or the rail reads as broken.
     */
    it('L88 — every rail entry carries its glyph, and the label still reads as the label', () => {
        open();
        for (const entry of SETTINGS_TABS) {
            const tab = screen.getByTestId(`settings-tab-button-${entry.id}`);
            expect(tab.dataset['icon']).toBe(entry.icon);
            expect(tab.querySelector('svg')).not.toBeNull();
            // An `aria-hidden` glyph adds no text, so the rail still reads as seven names.
            expect((tab.textContent ?? '').trim()).toBe(entry.label);
        }
        // The seven Swift symbols, verbatim and in order.
        expect(SETTINGS_TABS.slice(0, 7).map((entry) => entry.icon)).toEqual([
            'gear',
            'paintbrush',
            'externaldrive',
            'tag',
            'person.badge.key',
            'command',
            'globe'
        ]);
    });

    /**
     * L89. macOS never swaps the arrow for a hand over a control, and the port's own
     * `styles.css` `button { cursor: default }` says so for the whole app — an inline
     * `cursor: pointer` beat that rule. Asserted over the WHOLE dialog rather than per control,
     * because "one cursor in one window" is the claim.
     */
    it('L89 — nothing in the dialog asks for the hand cursor', () => {
        open();
        const dialog = screen.getByTestId('settings-window');
        const handed = [...dialog.querySelectorAll<HTMLElement>('*')].filter(
            (node) =>
                node.style.cursor === 'pointer' ||
                (node.getAttribute('class') ?? '').split(/\s+/).includes('cursor-pointer')
        );
        expect(handed.map((node) => node.getAttribute('data-testid') ?? node.tagName)).toEqual([]);
    });
});

// ── L90 ─────────────────────────────────────────────────────────────────────────────

describe('L90 — arming a keybinding row does not move the row', () => {
    /**
     * `KeybindingsSettingsView.swift:184-197` is always `[Record] [Reset]` — arming opens a SHEET,
     * so the row cannot move. This port inlines the recorder, so both changes it causes (Record's
     * label growing, SET-094's Cancel appearing) are RESERVED instead.
     */
    it('reserves the Cancel slot and floors the Record button', () => {
        render(
            <KeybindingsTab
                bindings={clientKeyBindings([])}
                actions={actions()}
                configPath="~/.config/nex/config"
            />
        );
        const slot = screen.getByTestId('keybinding-cancel-slot-split_right');
        const record = screen.getByTestId('keybinding-record-split_right');
        const idleSlotWidth = slot.style.width;
        expect(idleSlotWidth).toBe('56px');
        expect(slot.children).toHaveLength(0);
        expect(record.style.minWidth).toBe('92px');

        fireEvent.click(record);
        // Armed: the slot is the same width and now holds Cancel; Record is the same box.
        expect(screen.getByTestId('keybinding-cancel-split_right')).toBeDefined();
        expect(slot.style.width).toBe(idleSlotWidth);
        expect(slot.children).toHaveLength(1);
        expect(record.style.minWidth).toBe('92px');
        expect(record.textContent).toBe('Press a key…');
        // …and the order is unchanged: Record, the slot, then Reset.
        const cluster = record.parentElement;
        expect([...(cluster?.children ?? [])]).toEqual([
            record,
            slot,
            screen.getByTestId('keybinding-reset-split_right')
        ]);
    });
});

// ── L92 / L93 ───────────────────────────────────────────────────────────────────────

describe('L92 — the Profiles detail placeholder', () => {
    /**
     * `ProfilesSettingsView.swift:126-133` — `.font(.headline)` on the title (body size, semibold,
     * primary) and `.frame(maxWidth: 360)` on the explanation. It is the one of the four empty
     * states whose title is a heading rather than a `.secondary` line.
     */
    it('titles itself as a headline, over a 360 px explanation', () => {
        render(<ProfilesTab profiles={[]} actions={actions()} paths={DEFAULT_SETTINGS_PATHS} />);
        // Deselect: the placeholder is the no-selection state (§SET-080).
        fireEvent.click(screen.getByTestId('profiles-list'));
        const title = screen.getByTestId('profile-detail-placeholder-title');
        expect(title.textContent).toBe('No profile selected');
        expect(title.className).toContain('font-semibold');
        expect(title.className).toContain('text-[13px]');
        expect(title.style.color).toContain('--nex-fg');
        expect(title.style.color).not.toContain('secondary');
        const detail = screen.getByTestId('profile-detail-placeholder').querySelector('.max-w-\\[360px\\]');
        expect(detail).not.toBeNull();
    });

    /** The other three keep the `.secondary` line they have in the Swift. */
    it('leaves the other empty states as `.secondary` lines', () => {
        render(
            <WebTab
                favourites={[]}
                actions={{ renameFavourite: vi.fn(), removeFavourite: vi.fn(), moveFavourite: vi.fn() }}
            />
        );
        const title = screen.getByTestId('settings-favourites-empty-title');
        expect(title.className).not.toContain('font-semibold');
        expect(title.style.color).toContain('--nex-fg-secondary');
    });
});

describe('L91 — the Labels delete control (already a glyph before this wave)', () => {
    /**
     * `LabelPresetsSettingsView.swift:238-244` — `Button { Image(systemName: "trash") }
     * .buttonStyle(.plain).frame(width: LabelCol.action)`. The register recorded a bordered
     * "Delete" TEXT button in the danger tone, which had widened the 40 pt action column; H26's
     * wave had already put the glyph back. Locked here so it cannot drift out again.
     */
    it('is a quiet trash GLYPH in the 40 px action column, not a bordered Delete', () => {
        render(
            <LabelsTab
                presets={[{ name: 'ship', color: { kind: 'named', color: 'gray' }, textColor: null }]}
                workspaces={[]}
                actions={actions()}
                bucket="dark"
            />
        );
        const remove = screen.getByTestId('label-delete-ship');
        expect(remove.querySelector('svg')).not.toBeNull();
        expect((remove.textContent ?? '').trim()).toBe('');
        expect(remove.className).not.toContain('border');
        // The 16 px square target `SettingsIconButton` gives every plain glyph button.
        expect(remove.className).toContain('h-4');
        expect(remove.className).toContain('w-4');
        // …and it is the quiet `.secondary` tone, not the destructive red.
        expect(remove.style.color).not.toContain('#E0');
    });
});

describe('L93 — the Labels colour groups announce their value', () => {
    /**
     * `LabelPresetsSettingsView.swift:330, 395` — `"Colour: \(name)"` / `"Text colour:
     * \(currentLabel)"`. The port's groups named the field and left the ten swatch buttons as the
     * only way to learn which one is pressed.
     */
    it('names the field AND the colour set in it', () => {
        render(
            <LabelsTab
                presets={[
                    { name: 'wip', color: { kind: 'named', color: 'blue' }, textColor: null },
                    { name: 'hold', color: { kind: 'custom', hex: '#123456' }, textColor: { kind: 'custom', hex: '#ffffff' } }
                ]}
                workspaces={[]}
                actions={actions()}
                bucket="dark"
            />
        );
        expect(screen.getByRole('group', { name: 'wip color: Blue' })).toBeDefined();
        expect(screen.getByRole('group', { name: 'wip text color: Auto' })).toBeDefined();
        expect(screen.getByRole('group', { name: 'hold color: Custom' })).toBeDefined();
        expect(screen.getByRole('group', { name: 'hold text color: White' })).toBeDefined();
    });
});
