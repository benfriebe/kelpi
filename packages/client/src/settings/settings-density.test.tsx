/**
 * Settings' DENSITY pack — `docs/SPACING-REVIEW.md` S15, S24, S25, S26, S33, S57, S59, S60, S64.
 *
 * `docs/UI-FIDELITY.md` asks whether the window looks like the shipped one; the density register
 * asks whether it feels cramped, and these nine rows are where the two answers differed. Each
 * case names the Swift line (or, for the port-only rows, the port's own rhythm) and asserts the
 * number rather than "something changed" — and each number replaced one that was measured on a
 * live boot:
 *
 *   S15  the Add Repository sheet's Cancel/Add pair were bare words — Add 22.48 × 16.8,
 *        `padding: 0`, no border — 8 px apart in the corner of a sheet 20 px too narrow;
 *   S24  the 19 switches were a 26 × 15 track, the shortest hit target in Settings after the
 *        colour wells, under a comment naming a `.controlSize` the Swift never sets;
 *   S25  both colour wells were 20 × 14 (input 18 × 12) while the SAME control on Appearance is
 *        38 × 22;
 *   S26  `+ Add Profile` sat 2 px under the last rail row with no rule, so the two read as one
 *        continuous block of text;
 *   S33  the seven Appearance sliders were 435 × 16 — Chromium's default range box;
 *   S57  at a 760 × 700 window the preset name field measured 14 × 28.2 px while every fixed
 *        track held its width, and the dialog had no floor at all;
 *   S60  the text-colour cluster needed 187.5 px in a 124 px track, so it wrapped on every row
 *        at every width and the wrapped line drew over the row's usage caption;
 *   S64  the four `plain` tabs' rows were inset 8 px horizontally against `SETTINGS_ROW_PADDING`'s
 *        10, so the eye read a 2 px step moving from General to Keybindings.
 *
 * jsdom lays nothing out, so the assertions are on the class list and the inline style — where
 * the metric is *stated*. The pixel readings quoted per block come from the live sandbox boots.
 */

import { DEFAULT_WS_SETTINGS } from '@nex/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Inspector, clientKeyBindings, type ChromeLabelPreset } from '../chrome';
import type { InspectorAssociation, InspectorRepo } from '../chrome';
import type { ChromePane, ChromeWorkspace } from '../chrome/types';
import { AppearanceTab } from './AppearanceTab';
import { KeybindingsTab } from './KeybindingsTab';
import { LabelsTab } from './LabelsTab';
import { ProfilesTab } from './ProfilesTab';
import { RepositoriesTab } from './RepositoriesTab';
import { SettingsOverlay } from './SettingsOverlay';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';
import { SettingsToggle } from './ui';

afterEach(cleanup);

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

const PRESETS: readonly ChromeLabelPreset[] = [
    { name: 'ship', color: { kind: 'named', color: 'blue' }, textColor: null },
    // §N32 SWAP: the grid used to be measured against the composer, which every fixture had for
    // free. Row-against-row needs a SECOND row, so the fixture grew one.
    { name: 'wip', color: { kind: 'named', color: 'gray' }, textColor: null }
];

// ── S24 ─────────────────────────────────────────────────────────────────────────────

describe('S24 — the Settings switch is a REGULAR-size AppKit switch', () => {
    /**
     * `grep -rn controlSize SettingsView.swift` returns nothing, so `SettingsView.swift:141,
     * 151, 159, 189, 199, 226, 236, 435, 440-441` are all plain `Toggle`s inside
     * `.formStyle(.grouped)` — the regular 38 × 22 switch, not the 26 × 15 small one the
     * component's comment used to claim. In the same General card the placement `<select>` is
     * 123 × 25 and the base-path field 570.6 × 26.2, so the old track was 10 px shorter than the
     * controls stacked directly under it.
     */
    it('draws a 38 × 22 track with an 18 px thumb, and slides it to 18 px when on', () => {
        const { rerender } = render(
            <SettingsToggle checked={false} label="Focus follows mouse" testID="probe" onChange={vi.fn()} />
        );
        const track = screen.getByTestId('probe') as HTMLInputElement;
        const thumb = screen.getByTestId('probe-thumb');
        expect(track.style.width).toBe('38px');
        expect(track.style.height).toBe('22px');
        expect(thumb.style.width).toBe('18px');
        expect(thumb.style.height).toBe('18px');
        expect(thumb.style.left).toBe('2px');

        rerender(<SettingsToggle checked label="Focus follows mouse" testID="probe" onChange={vi.fn()} />);
        // 38 (track) − 18 (thumb) − 2 (inset) = 18.
        expect(screen.getByTestId('probe-thumb').style.left).toBe('18px');
    });
});

// ── S33 ─────────────────────────────────────────────────────────────────────────────

describe('S33 — the Appearance sliders are a 20 px drag target', () => {
    /**
     * `SettingsView.swift:506-515` is a macOS `Slider`, ~20 pt tall with a 20 pt knob. Chromium's
     * default range box is 16, and all seven measured 435 × 16 — the only control on the tab
     * under the 20 px pointer line. §L82's row metrics (columnGap 10, 140 px label track, 44 px
     * readout) are untouched: only the input's own box grows.
     */
    it('sets the range input’s own height rather than leaving Chromium’s 16', () => {
        render(
            <AppearanceTab
                settings={DEFAULT_WS_SETTINGS}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        const sliders = screen.getAllByRole('slider');
        expect(sliders.length).toBeGreaterThan(0);
        for (const slider of sliders) {
            expect((slider as HTMLInputElement).style.height).toBe('20px');
        }
    });
});

// ── S25 / S57 / S60 / S64 ───────────────────────────────────────────────────────────

describe('Labels tab density (S25, S57, S60, S64)', () => {
    function open(): void {
        render(<LabelsTab presets={PRESETS} workspaces={[]} actions={actions()} bucket="dark" />);
    }

    /**
     * S25 — `LabelPresetsSettingsView.swift:289` (background) and `:361` (text) are both
     * `ColorPicker`s: `NSColorWell`s with their own bezel, ~22-24 pt square minimum. The port
     * drew each as `h-3.5 w-5` — a 20 × 14 painted well over an 18 × 12 input, the smallest hit
     * target anywhere in Settings, while Appearance's `ColorField` draws the same control at
     * 38 × 22 one tab away.
     *
     * 24 × 20 rather than the register's `h-5 w-8` (20 × 32), which is a reading of the 20 px
     * pointer floor rather than of this column: at 32 px the `Custom…` chip needs 153.2 px
     * beside the last three swatches in a track the Swift fixes at 150 (`:8`), so the palette
     * wrapped to a third line and every row on the tab grew 18 px. Measured both ways.
     */
    // §N32 SWAP: the two wells were read off the COMPOSER, which no longer exists. They are the
    // same two controls in every preset row, so the measurement moves to a row and the claim is
    // unchanged.
    it('S25 — both colour wells are one 24 × 20 control, not two 20 × 14 slivers', () => {
        open();
        for (const testID of ['label-color-ship-custom', 'label-text-ship-custom']) {
            const well = screen.getByTestId(testID).parentElement as HTMLElement;
            expect(well.className).toContain('h-5');
            expect(well.className).toContain('w-6');
            expect(well.className).not.toContain('h-3.5');
        }
    });

    /**
     * S60 — the Swift's 124 pt track (`LabelPresetsSettingsView.swift:9`) holds what the SWIFT
     * puts there: one compact `Menu` plus a well (`:224-233`, `:356-399`). This port drew the
     * mode as three explicit choices instead, so the cluster measured 21.07 (Aa) + 36.27 + 40.23
     * + 41.89 + 24 (well) + 4 × 4 px of gaps = 179.5 px, and S60 widened the track to 184 so it
     * would stop wrapping to a 44.4 px two-line box on every row.
     *
     * S57 — and the name track has a floor. As `minmax(0,1fr)` it was the only flexible track
     * among five hard px ones, so a 760 × 700 window took it to 14 × 28.2 px while `bgColor`,
     * `textColor`, `preview`, `reorder` and `action` all held their width.
     *
     * §N36(3) SWAP — owner-directed, and it settles BOTH of those rows rather than restating
     * them. S60's own recorded remedy (collapse Auto/Black/White into one control, as `:365-394`
     * does) is now taken, so the cluster is 121.07 px and the track goes back to the Swift's
     * **124**; the 60 px it frees goes into S57's floor, **100 → 160**, which is what makes the
     * name field readable at a narrow window and not only at the default one. Measured live at
     * both widths in `docs/audit/n36-labels-design/`: the cluster does not wrap at either
     * (121.07 px of content in 124, one line), the row height is unchanged at 54 px, and
     * `LABEL_GRID_MIN_WIDTH` is unchanged at 648 px.
     */
    it('S57/S60/§N36 — one grid template: the Swift’s 124 px text-colour track, floored name', () => {
        open();
        for (const row of ['label-preset-ship', 'label-preset-wip']) {
            const node = screen.getByTestId(row);
            expect(node.style.gridTemplateColumns).toBe('150px minmax(160px,1fr) 124px 80px 44px 40px');
            expect(node.style.columnGap).toBe('10px');
        }
        // The cluster is sized off the same constant, so the track and its contents cannot drift.
        const group = screen.getByRole('group', { name: /ship text color/i });
        expect(group.style.width).toBe('124px');
        // …and what makes 124 possible is that the three buttons are ONE control now.
        expect(screen.getByTestId('label-text-ship-mode').tagName).toBe('SELECT');
        expect(screen.queryByTestId('label-text-ship-white')).toBeNull();
    });

    /**
     * S64 — one horizontal row inset for the whole window. `SETTINGS_ROW_PADDING` is `6px 10px`
     * on every carded tab; the four `plain` tabs' rows were `px-2` (8 px), so the same window
     * used two insets and the eye read a 2 px step moving between them. The 6/8 px VERTICAL
     * values are §L79's measurements off the shipped dialog and do not move.
     */
    /*
     * §N32 SWAP: the composer's own `px-2.5 py-2` went with it; the row inset it had to match is
     * still here.
     *
     * §N36(1) SWAP for the last line, owner-directed. It pinned the Add button to the same 10 px
     * gutter as a row, which was the right claim while the button stood in the list's own left
     * column. It stands in the SECTION HEADER now, on the trailing edge, so the gutter it has to
     * respect is the header's — and the header is `SettingsSection`'s, not this tab's. What the
     * row inset has to line up with there is the button's RIGHT edge against the row's right
     * edge, which is geometry and is measured live (`add.right 1063 === row.right 1063` at the
     * default window, 712.59 = 712.59 at 760 px: `docs/audit/n36-labels-design/after.json`).
     * Here, the DOM claim: the button is in the header, and the rows keep their 10 px.
     */
    it('S64 — the labels rows are inset 10 px horizontally, vertical untouched', () => {
        open();
        expect(screen.getByTestId('label-preset-ship').className).toContain('px-2.5');
        expect(screen.getByTestId('label-preset-ship').className).toContain('py-1.5');
        expect(screen.getByTestId('label-preset-wip').className).toContain('px-2.5');
        const heading = screen.getByTestId('label-presets').querySelector('h3');
        expect(heading?.parentElement?.contains(screen.getByTestId('label-add'))).toBe(true);
    });
});

describe('S64 — the other two plain tabs take the same 10 px inset', () => {
    it('repository rows and keybinding rows agree with SETTINGS_ROW_PADDING', () => {
        const repos = [{ id: 'r1', name: 'app', path: '/src/app', origin: 'manual' as const }];
        render(
            <RepositoriesTab
                repos={repos as never}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
                autoDetectRepos
            />
        );
        expect(screen.getByTestId('repo-row-r1').className).toContain('px-2.5');
        expect(screen.getByTestId('repo-row-r1').className).toContain('py-1.5');
        cleanup();

        render(
            <KeybindingsTab
                bindings={clientKeyBindings()}
                actions={actions()}
                configPath={DEFAULT_SETTINGS_PATHS.nexConfig}
            />
        );
        const row = screen.getAllByTestId(/^keybinding-row-/)[0] as HTMLElement;
        expect(row.className).toContain('px-2.5');
        expect(row.className).toContain('py-1.5');
    });
});

// ── S26 ─────────────────────────────────────────────────────────────────────────────

describe('S26 — the Profiles add affordance is a strip under a rule', () => {
    /**
     * `ProfilesSettingsView.swift:78-115` is `VStack(spacing: 0) { List; Divider();
     * addRemoveStrip }` — the standard macOS list-with-strip, whose `Divider()` is what says
     * "this is not another profile". The port rendered `+ Add Profile` as the immediate sibling
     * of the last rail row: measured a 2.00 px gap and no rule, so the last profile and the add
     * control were one continuous 38 px block of text.
     */
    it('separates the add control from the last rail row with a full-width rule', () => {
        render(
            <ProfilesTab
                profiles={[{ name: 'work', env: { NEX_PROFILE: 'work' } }]}
                actions={actions()}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        const strip = screen.getByTestId('profile-add-strip');
        expect(strip.style.borderTop).toContain('1px solid');
        // The button lives inside the strip, not beside the rows…
        expect(screen.getByTestId('profile-add').parentElement).toBe(strip);
        // …the strip clears the rows it follows…
        expect(strip.className).toContain('mt-1');
        expect(strip.className).toContain('pt-1');
        // …and the rule spans the rail, cancelling its `p-1` the way a `Divider()` spans a List.
        expect(strip.className).toContain('-mx-1');
        expect(strip.className).toContain('px-1');
    });
});

// ── S59 ─────────────────────────────────────────────────────────────────────────────

describe('S59 — the settings rail breathes between its tabs', () => {
    function open(): void {
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
     * The rows are the port's own intended 28.8 px now that S1 layered the reset, but `gap-0.5`
     * left a 2 px row gap — measured pitch 30.8 px, eight rows reading as a paragraph of lines.
     * `gap-1` puts the pitch at 32.8, still far denser than the Swift's icon-over-title
     * `.tabItem`s (`SettingsView.swift:18-60`, on the order of 50 × 40 pt).
     */
    it('S59 — the rail’s row gap is 4 px, and the tab rows keep their 6/8 padding', () => {
        open();
        const rail = screen.getByTestId('settings-tabs');
        expect(rail.className).toContain('gap-1');
        expect(rail.className).not.toContain('gap-0.5');
        const tab = screen.getByTestId('settings-tab-button-general');
        expect(tab.className).toContain('px-2');
        expect(tab.className).toContain('py-1.5');
    });

    /**
     * S57's other half: `SettingsView.swift:61-64` opens the preferences scene at `minWidth:
     * 500, idealWidth: 600`. `w-[min(880px,92%)]` had no floor, so a 760 px window drove the
     * dialog to 699 px and the Labels row's only flexible track collapsed.
     */
    it('S57 — the dialog width has a floor as well as a cap', () => {
        open();
        expect(screen.getByTestId('settings-window').className).toContain('w-[clamp(560px,92%,880px)]');
    });
});

// ── S15 ─────────────────────────────────────────────────────────────────────────────

describe('S15 — the repo picker’s action row is a pair of push buttons', () => {
    const REPOS: InspectorRepo[] = [
        { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/Users/t/nex/worktrees/app' }
    ];

    function pane(id: string): ChromePane {
        return {
            id,
            type: 'shell',
            label: null,
            title: 'zsh',
            workingDirectory: '/src/app',
            gitBranch: 'main',
            status: 'idle',
            agentSessionID: null,
            agentKind: null,
            agentStartedAt: null,
            backgroundTaskCount: 0
        };
    }

    function workspace(): ChromeWorkspace {
        return {
            id: 'aaaaaaaa-0000-4000-8000-000000000001',
            name: 'alpha',
            color: 'blue',
            icon: null,
            labels: [],
            panes: [pane('p1')]
        };
    }

    const ASSOCIATION: InspectorAssociation = {
        id: 'a-main',
        repoID: 'r1',
        repoName: 'app',
        repoPath: '/src/app',
        worktreePath: '/src/app',
        branch: 'main',
        isWorktree: false,
        status: { kind: 'clean', changedFiles: 0, additions: 0, deletions: 0 }
    };

    function openSheet(): void {
        render(
            <Inspector
                workspace={workspace()}
                focusedPaneID="p1"
                associations={[ASSOCIATION]}
                repos={REPOS}
            />
        );
        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('Add Repository…'));
    }

    /**
     * `RepoPickerView.swift:87-98` is `HStack { Button("Cancel").keyboardShortcut(.cancelAction);
     * Spacer(); Button(confirm).keyboardShortcut(.defaultAction) }`. Three things came out of
     * that line and none of them were in the port: both are real push buttons with a bezel, the
     * confirm is AppKit's DEFAULT button (filled accent, ~64 pt minimum width), and the
     * `Spacer()` puts Cancel at the LEADING edge. Measured: Cancel 38.82 × 16.8 and Add
     * 22.48 × 16.8, both `padding: 0px`, `border-width: 0px`, 8 px apart at the trailing corner.
     */
    it('gives both actions a 4/12 box and a ≥64 px width, Cancel leading', () => {
        openSheet();
        const cancel = screen.getByTestId('add-repo-cancel');
        const submit = screen.getByTestId('add-repo-submit');
        for (const button of [cancel, submit]) {
            expect(button.style.padding).toBe('4px 12px');
            expect(button.style.minWidth).toBe('64px');
            expect(button.style.border).toContain('1px solid');
        }
        // `Spacer()`: the default action is pushed to the trailing edge, Cancel holds the
        // leading one — where `justify-end` had put the pair together in the corner.
        expect(submit.className).toContain('ml-auto');
        expect(cancel.className).not.toContain('ml-auto');
        expect((cancel.parentElement as HTMLElement).className).not.toContain('justify-end');
    });

    /**
     * The two sub-findings the register filed under the same row: `RepoPickerView.swift:101` is
     * `.frame(width: 360, height: 340)` — the port's sheet was 340 px, that frame's HEIGHT read
     * as a width — and `:61` is `VStack(spacing: 12)` where the picker column had `gap-2`.
     */
    it('hosts the picker in a 360 px sheet, and spaces the picker’s column at 12', () => {
        openSheet();
        expect(screen.getByTestId('add-repo-sheet').style.width).toBe('360px');
        const picker = screen.queryByTestId('repo-picker');
        if (picker !== null) expect(picker.className).toContain('gap-3');
    });
});
