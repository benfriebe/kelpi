/**
 * Settings' DENSITY pack — `../kelpi-docs/SPACING-REVIEW.md` S15, S24, S25, S26, S33, S57, S59, S60, S64.
 *
 * `../kelpi-docs/UI-FIDELITY.md` asks whether the window looks like the shipped one; the density register
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

import { DEFAULT_WS_SETTINGS } from '@kelpi/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Inspector, clientKeyBindings, type ChromeLabelPreset } from '../chrome';
import type { InspectorAssociation, InspectorRepo } from '../chrome';
import type { ChromePane, ChromeWorkspace } from '../chrome/types';
import { AppearanceTab } from './AppearanceTab';
import { KeybindingsTab } from './KeybindingsTab';
import { LABEL_GRID_MIN_WIDTH, LabelsTab } from './LabelsTab';
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
     * target anywhere in Settings.
     *
     * §N38 SWAP (owner-directed) — **there are no wells left to measure.** Both native
     * `<input type="color">` controls are gone: the row carries one swatch TRIGGER, and both
     * custom colours are picked in the flyover's own hand-rolled HSV view. So the density claim
     * S25 was making — "the control you have to hit is not a sliver" — is re-read on the two
     * controls that replaced them, against §S50's floor rather than S25's 24 × 20 bezel:
     *
     *   · the row's trigger paints a 16 px disc and hit-tests as 20 px (the transparent inset
     *     overlay, exactly as the row's palette swatches did);
     *   · the flyover's `✎ Custom` rows — what a person now presses to reach a custom colour —
     *     are full-width 24 px rows, which is bigger than the well in both axes.
     */
    it('§N38/S25 — the colour controls are a 20 px trigger and 24 px flyover rows, no wells', () => {
        open();
        expect(screen.queryByTestId('label-color-ship-custom')).toBeNull();
        expect(screen.queryByTestId('label-text-ship-custom')).toBeNull();
        expect(document.querySelectorAll('input[type="color"]')).toHaveLength(0);

        const trigger = screen.getByTestId('label-color-ship-trigger');
        // 16 px of paint…
        expect(trigger.className).toContain('h-4');
        expect(trigger.className).toContain('w-4');
        // …in a 20 px target: `inset: -2px` on every side of a 16 px box (§S50).
        const bleed = trigger.querySelector('span[aria-hidden]') as HTMLElement;
        expect(bleed.style.inset).toBe('-2px');

        fireEvent.click(trigger);
        for (const testID of ['label-flyover-bg-custom', 'label-flyover-text-custom']) {
            expect(screen.getByTestId(testID).className).toContain('h-6');
            expect(screen.getByTestId(testID).className).toContain('w-full');
        }
    });

    /**
     * S60 — the Swift's 124 pt track (`LabelPresetsSettingsView.swift:9`) holds what the SWIFT
     * puts there: one compact `Menu` plus a well (`:224-233`, `:356-399`). This port drew the
     * mode as three explicit choices instead, so the cluster measured 179.5 px and S60 widened
     * the track to 184 so it would stop wrapping to a 44.4 px two-line box on every row.
     *
     * S57 — and the name track has a floor. As `minmax(0,1fr)` it was the only flexible track
     * among five hard px ones, so a 760 × 700 window took it to 14 × 28.2 px while every other
     * track held its width.
     *
     * §N36(3) collapsed the triple into a `<select>` and spent the 60 px it freed on that floor
     * (100 → 160), which returned the track to the Swift's 124.
     *
     * §N38 SWAP (owner-directed) — **both colour tracks are gone.** The row is
     * `[swatch 24 · name · chip 80 · reorder 44 · trash 40]`, and the 260 px the collapse frees
     * (126 from `bgColor`, 124 from `textColor`, 10 from the column gap six tracks needed and
     * five do not) all goes into S57's floor: **160 → 420**. `LABEL_GRID_MIN_WIDTH` is
     * unchanged at 648, which is the property S57 and S60 and §N36(3) each preserved in turn,
     * so nothing that fitted before stops fitting and a too-narrow panel scrolls by the same
     * amount it always did.
     *
     * §N40 SWAP (owner-directed) — the in-use count takes a track of its own, `usage`, so the row
     * is `[swatch 24 · name · usage 80 · chip 80 · reorder 44 · trash 40]`. 80 is MEASURED, not
     * picked: at the caption's own computed font on the live stack `12 workspaces` renders
     * **77.16 px**, and 80 also clears the widest two-digit count there is (`99 workspaces`,
     * 79.43). The 90 px it costs — the track plus the sixth column's gap — comes straight back
     * out of S57's floor, **420 → 330**, so `LABEL_GRID_MIN_WIDTH` is 648 for the fourth
     * redesign running and nothing else on the row moves.
     */
    it('§N40/§N38/S57/S60 — one grid template: a 24 px swatch, an 80 px usage track, a 330 px floored name', () => {
        open();
        for (const row of ['label-preset-ship', 'label-preset-wip']) {
            const node = screen.getByTestId(row);
            expect(node.style.gridTemplateColumns).toBe('24px minmax(330px,1fr) 80px 80px 44px 40px');
            expect(node.style.columnGap).toBe('10px');
        }
        expect(LABEL_GRID_MIN_WIDTH).toBe(648);
        // The two tracks the flyover replaced, and the controls that lived in them, are gone.
        expect(screen.queryByTestId('label-text-ship-mode')).toBeNull();
        expect(screen.queryByTestId('label-text-ship-sample')).toBeNull();
        expect(screen.queryByTestId('label-color-ship-purple')).toBeNull();
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
                configPath={DEFAULT_SETTINGS_PATHS.kelpiConfig}
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
