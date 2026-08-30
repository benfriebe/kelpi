/**
 * The per-pane header bar (shell-ui.md §4.2).
 *
 * Left → right: type glyph / status dot, label chip, path or title, ZOOM badge, SYNC
 * badges, spacer, agent badge, git branch badge, per-type buttons, split buttons, close.
 * Focus is drawn by the pane's ring, never by the header itself.
 *
 * The component is `memo`ised and purely props-driven: agent activity mutates pane fields
 * every second (shell-ui.md §4.2 "Menu-stability requirement"), so nothing here may own
 * state that a tick would blow away — the only local state is the inline-rename draft, and
 * a tick cannot touch it because the header re-renders in place rather than remounting.
 */

import {
    memo,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent,
    type ReactElement,
    type RefObject
} from 'react';

import { ContextMenu, type MenuItemSpec } from '../chrome/ContextMenu';

import { chromeElapsedLabel, useSecondsTicker } from './elapsed';
import { Icon, type IconName, type IconWeight } from './icons';
import { pill, tokens } from './tokens';
import type { PaneActions, PaneModel } from './types';

/** Header content 20px + 2px vertical padding each side (shell-ui.md §4.2). */
export const PANE_HEADER_HEIGHT = 24;

/**
 * The path/title's flex-shrink weight (TERM-102/104).
 *
 * The Swift header was an `HStack` of fixed-size badges and buttons around one flexible
 * middle-truncating `Text`, so narrowing a pane ate the PATH and nothing else until there was
 * no path left. Flexbox has no notion of "shrink this one first", but it does share negative
 * space in proportion to `flex-shrink × flex-basis` — so a large weight here reproduces the
 * order: the title gives ground, then the user-data badges (label, agent, branch), and the
 * buttons never do.
 */
export const TITLE_SHRINK = 100;

/**
 * §S8 — the floor under a shrinkable badge's text, so a squeezed chip draws an ELLIPSIS and
 * never a colour stub.
 *
 * `2.5ch` is ~15 px at the badges' 10 px monospace: one glyph plus the ellipsis `truncate`
 * draws. Without it the inner `min-w-0 truncate` span is free to reach 0, and it does — at a
 * 130.75 px pane the label chip, the agent badge and the branch chip each measured **8.00 px
 * wide with 0.00 px of text**: three bare colour rectangles carrying no glyph and not even an
 * ellipsis, a state `PaneHeaderView.swift:80-92` cannot produce (SwiftUI overflows the header
 * and lets `PaneGridView.swift:354-355`'s `.clipped()` cut it, rather than compressing a chip).
 */
export const BADGE_TEXT_FLOOR = '2.5ch';

/** Which of the three user-data badges a header this wide can afford (`badgeFit`). */
export interface BadgeFit {
    readonly label: boolean;
    readonly agent: boolean;
    readonly branch: boolean;
}

/** What `badgeFit` needs: the width, what the pane WANTS to show, and the row's button count. */
export interface BadgeFitInput extends BadgeFit {
    readonly paneWidth: number | undefined;
    /** Trailing `HeaderButton`s this header renders — 4 shared, plus the per-type ones. */
    readonly buttons: number;
}

/**
 * §S8 — the header's fixed cost, in px, before a badge or a character of path is drawn.
 *
 * Measured on the running app and then written as its parts, so a change to any of them keeps
 * the ladder honest: `px-2`'s 16 px, the 10 px status dot / type glyph, one 20 px box per
 * trailing button, and a 4 px `gap-1` between every adjacent pair of the children that are
 * always there (dot, title, spacer, buttons). A shell pane's four buttons come out at **130**,
 * a markdown pane's six (copy + edit) at **178**.
 */
export function headerChrome(buttons: number): number {
    return 16 + 10 + buttons * 20 + (2 + buttons) * 4;
}

/**
 * §S8 — what a badge costs at its floor: its own box, plus the one extra `gap-1` it adds.
 *
 * 8 px of `px-1`, the glyph and its 2 px inner gap where there is one (8 for the tag, 9 for the
 * branch), and `BADGE_TEXT_FLOOR`'s ~15 px of text.
 */
export const BADGE_COST = { label: 37, agent: 27, branch: 38 } as const;

/**
 * §S8 — the badge fit ladder.
 *
 * The floor is only half the fix: flooring a badge that has no room pushes the trailing buttons
 * further past the pane edge (at 130.75 px the ✕ already overhung by 27.25 px), and a header
 * that drops its close button before a git branch is the wrong trade. So a badge that cannot be
 * seated at its floor is not drawn at all — hiding beats a stub, and it beats an ellipsis whose
 * chip costs more than the ✕ it displaces.
 *
 * It is arithmetic rather than a table of widths on purpose: the answer depends on how many
 * badges the pane actually wants and how many buttons its type draws, so a markdown pane whose
 * only badge is a branch keeps it far longer than a shell pane carrying all three. Measured
 * examples: a shell pane with label + agent + branch seats all three from 232 px, the label and
 * agent alone from 194, the label alone from 167; a markdown pane's lone branch chip survives
 * to 216 px, where a fixed ladder would have dropped it at 250 with 60 px of room to spare.
 *
 * The drop order is by what else carries the same fact. The branch goes first: the status
 * footer and the inspector both show it. The agent badge goes next: the 10 px status dot beside
 * the path is already painted from `pane.status`, so "an agent is running here" survives it.
 * The label chip goes last, because nothing else in a narrow header names the pane.
 */
export function badgeFit(input: BadgeFitInput): BadgeFit {
    const fit = { label: input.label, agent: input.agent, branch: input.branch };
    // No width to reason about (a standalone render, a test that does not care about the
    // ladder) draws everything the pane asked for, which is the pre-S8 behaviour.
    if (input.paneWidth === undefined || !Number.isFinite(input.paneWidth)) return fit;

    const budget = input.paneWidth - headerChrome(input.buttons);
    let cost =
        (fit.label ? BADGE_COST.label : 0) +
        (fit.agent ? BADGE_COST.agent : 0) +
        (fit.branch ? BADGE_COST.branch : 0);
    for (const key of ['branch', 'agent', 'label'] as const) {
        if (cost <= budget) break;
        if (!fit[key]) continue;
        fit[key] = false;
        cost -= BADGE_COST[key];
    }
    return fit;
}

/**
 * §S40 — how many of the header's trailing buttons fold into the overflow `•••`
 * (OWNER-DIRECTED divergence from `PaneHeaderView.swift:222-272`, taken 2026-08-29).
 *
 * The Swift draws its whole button tail unconditionally and lets `PaneGridView.swift:354-355`'s
 * `.clipped()` cut whatever overruns; the port transcribed that exactly (`gap-1 px-2`, `h-5 w-5`,
 * the pane wrapper's `overflow-hidden`), so the row is parity rather than drift. It is also the
 * wrong trade in a multiplexer, because the control the clip reaches FIRST is the destructive
 * one: measured, a markdown pane's six-button tail had +8 px of clearance at a 199 px header,
 * **−1 at 169, −21 at 149 and −41 at 129** — the ✕ gone, then the globe with it. A real 4-pane
 * grid at 1280 reaches those widths (`run-AE` step 94 measured a **134 px** markdown pane), so
 * this is the ordinary case, not a pathological one.
 *
 * What folds, in order — `globe`, `split-down`, `split-right`, then the pane's own type buttons
 * from the right — is the row read from the ✕ inward, with the ✕ itself never foldable. That
 * ordering is a rule rather than a taste: the buttons that survive are always a PREFIX of the
 * Swift's own row, so nothing ever moves sideways as a pane narrows — a control either stays
 * where it is or leaves. And leaving is cheap here in a way §S8's dropped badges are not: every
 * folded button is in the `•••` menu one click away, with the label and the chord hint it had.
 *
 * **The first fold is two buttons deep, and has to be.** The `•••` is itself a 20 px box plus a
 * 4 px gap — exactly one button — so folding a single control costs precisely what it saves and
 * hides one for nothing. The register named two (`globe` and `split-down`) for that reason;
 * the arithmetic below re-derives it rather than hard-coding it.
 *
 * It engages strictly BELOW §S8: the badge cost passed in is what `badgeFit` has already seated,
 * and `badgeFit` only seats a badge when `headerChrome(allButtons) + cost <= paneWidth` — which
 * is the same inequality this returns 0 for. So at every width where a badge is drawn, this is
 * provably a no-op, and §S8's measured thresholds (all three from 232 px, the label alone from
 * 167, a markdown pane's lone branch to 216) are untouched.
 *
 * Owner-directed: do not re-report. The parity value is a tail that never folds, and a ✕ that
 * is the first control off the pane rather than the last.
 */
export interface OverflowFitInput {
    /** The pane's width; omitted (a standalone render) means "no fold", the pre-S40 behaviour. */
    readonly paneWidth: number | undefined;
    /** Every trailing button the header would draw, the close ✕ included. */
    readonly buttons: number;
    /** What `badgeFit` seated, in px — `BADGE_COST` summed over the badges still drawn. */
    readonly badgeCost: number;
}

export function headerOverflowCount(input: OverflowFitInput): number {
    const { paneWidth, buttons, badgeCost } = input;
    /*
     * A width of 0 is "not measured yet", not "fold everything". The grid computes pane frames
     * from a `ResizeObserver` on its container, so the first render — and every render under
     * jsdom, which has no layout at all — reports 0. Folding on that would flash the whole tail
     * into a `•••` for one frame on every mount, and it did exactly that in the two
     * `App.test.tsx` cases that click the markdown edit toggle and the diff refresh.
     */
    if (paneWidth === undefined || !Number.isFinite(paneWidth) || paneWidth <= 0) return 0;
    // The ✕ never folds, so it is never a candidate.
    const foldable = Math.max(buttons - 1, 0);
    const fits = (folded: number): boolean =>
        headerChrome(buttons - folded + (folded > 0 ? 1 : 0)) + badgeCost <= paneWidth;
    if (fits(0)) return 0;
    // 1 is skipped deliberately: one folded button plus the `•••` is the same box count as the
    // button it replaced, so it buys nothing and hides a control for nothing.
    for (let folded = 2; folded <= foldable; folded++) {
        if (fits(folded)) return folded;
    }
    return foldable;
}

// ── display strings ─────────────────────────────────────────────────────────────────

/** `/Users/x` → `~`, `/Users/x/a` → `~/a`; unrelated paths pass through (shell-ui.md §2). */
export function homeAbbreviated(path: string, home: string): string {
    if (home.length === 0) return path;
    const root = home.endsWith('/') ? home.slice(0, -1) : home;
    if (path === root) return '~';
    if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
    return path;
}

export function basename(path: string): string {
    const parts = path.split('/').filter((part) => part.length > 0);
    return parts.length === 0 ? path : (parts[parts.length - 1] as string);
}

/**
 * Split a header title so CSS can truncate it in the MIDDLE (§4.2 item 3).
 *
 * `text-overflow: ellipsis` only ever cuts the tail, which for a path throws away the only
 * informative part — the audit's `/var/folders/5x/k7q6qbys3p35wb8dcn0dl…` names a temp
 * directory and nothing else (run-B m9), while the status footer, describing the same pane,
 * middle-truncates. A character budget cannot be used here: the pane header's width is whatever
 * the split left it. So the string is split into a head that may ellipsize and a tail that
 * never does — the last path segment (with its separator), capped so a single monstrous segment
 * cannot eat the whole line. Titles with no separator, and short ones, keep the plain behaviour.
 *
 * M19 — the cap **clamps** the tail; it does not abandon it. The first version returned
 * `{ head: title, tail: '' }` for any segment longer than the budget, which handed the whole
 * string back to plain tail-ellipsis in exactly the case middle truncation exists for:
 * `~/code/some-really-long-directory-name` threw away the directory name and kept `~/code/some-r…`.
 * Over budget, the tail becomes the LAST `tailMax` characters of the title and the head is
 * everything before them — so the head still ellipsizes from its right and the informative end
 * survives, which is what `.truncationMode(.middle)` does. The two spans are adjacent, so when
 * the header is wide enough they still read as one unbroken string.
 */
export interface TruncatedTitle {
    readonly head: string;
    readonly tail: string;
}

export const HEADER_TAIL_MAX = 24;

export function splitHeaderTitle(title: string, tailMax = HEADER_TAIL_MAX): TruncatedTitle {
    const cut = title.lastIndexOf('/');
    // Nothing to protect: no separator, or the separator is the very first/last character.
    if (cut <= 0 || cut === title.length - 1) return { head: title, tail: '' };
    const tail = title.slice(cut);
    // M19: over budget, keep the tail's END rather than dropping the tail entirely — a long last
    // segment is the case middle truncation is FOR. `title.length > tailMax` is guaranteed here
    // (`tail` is a suffix of `title` and is itself longer than the budget), so the split is safe.
    if (tail.length > tailMax) {
        return { head: title.slice(0, title.length - tailMax), tail: title.slice(title.length - tailMax) };
    }
    return { head: title.slice(0, cut), tail };
}

/** The header's path/title string, by pane type (shell-ui.md §4.2 item 3). */
export function paneDisplayTitle(pane: PaneModel, homeDirectory = ''): string {
    switch (pane.type) {
        case 'scratchpad':
            return 'Scratchpad';
        case 'markdown':
            return basename(pane.filePath ?? pane.workingDirectory);
        case 'diff': {
            // §L48: empty-as-unscoped, the Swift's own test (`PaneHeaderView.swift:496-502` reads
            // `target.isEmpty`, not `target == nil`). `??` alone keeps an empty STRING, and a diff
            // pane whose scope the daemon stored as `''` titled itself `diff: ` — the repo's
            // directory name is what the shipped app falls back to.
            const target = pane.filePath ?? '';
            return `diff: ${basename(target === '' ? pane.workingDirectory : target)}`;
        }
        case 'shell':
        case 'web':
            return homeAbbreviated(pane.title ?? pane.workingDirectory, homeDirectory);
    }
}

const TYPE_GLYPHS: Record<Exclude<PaneModel['type'], 'shell'>, IconName> = {
    markdown: 'document',
    scratchpad: 'note',
    diff: 'plusminus',
    web: 'globe'
};

// ── agent badge ─────────────────────────────────────────────────────────────────────

export type AgentBadgeTone = 'running' | 'waiting';

export interface AgentBadgeModel {
    readonly text: string;
    readonly tone: AgentBadgeTone;
}

/**
 * The right-aligned agent badge (agent-lifecycle.md §5.9 / §9.4). Shell panes with an
 * attached session only: running → `<kind>[ · <elapsed>][ · N running]` in amber,
 * waiting → `awaiting input` in blue, idle → nothing.
 *
 * `pane.agentStartedAt` is epoch **milliseconds** (the agent state machine stamps it with the
 * handler's `Date.now()`), while the shared ticker publishes whole **seconds** — the mismatch
 * is converted here, not in the formatter, which stays unit-agnostic.
 */
export function agentBadge(pane: PaneModel, nowSeconds: number): AgentBadgeModel | null {
    if (pane.type !== 'shell') return null;
    if (pane.agentSessionID === null) return null;
    if (pane.status === 'waitingForInput') return { text: 'awaiting input', tone: 'waiting' };
    if (pane.status !== 'running') return null;
    let text: string = pane.agentKind ?? 'claude';
    if (pane.agentStartedAt !== null) {
        text += ` · ${chromeElapsedLabel(pane.agentStartedAt / 1000, nowSeconds)}`;
    }
    if (pane.backgroundTaskCount > 0) text += ` · ${pane.backgroundTaskCount} running`;
    return { text, tone: 'running' };
}

function statusDotColor(status: PaneModel['status']): string {
    switch (status) {
        case 'running':
            return tokens.statusRunning;
        case 'waitingForInput':
            return tokens.statusWaiting;
        case 'idle':
            return tokens.textTertiary;
    }
}

// ── pieces ──────────────────────────────────────────────────────────────────────────

interface BadgeProps {
    readonly testID: string;
    readonly color: string;
    /**
     * M14 — the pill fill, in percent. `PaneHeaderView.swift` draws **three** tones, not one:
     * the label chip / ZOOM / SYNC at 12 (`:91`, `:112`, `:137`), SYNC OFF and the branch chip
     * at 10 (`:153`, `:174`), the agent badge at 14 (`:329`, `:336`). The port had flattened all
     * six to `pill()`'s single 14%, which read the branch and SYNC OFF ~40% stronger than the
     * shipped app draws them. Required rather than defaulted, so a new badge has to state its
     * tone instead of silently inheriting the loudest one.
     */
    readonly fill: number;
    /**
     * M15 — `.medium` weight. The Swift gives it to the **fixed-word** badges only (ZOOM `:106`,
     * SYNC `:131`, SYNC OFF `:147`); the label, branch and agent badges carry user data and stay
     * at the regular weight (`:85`, `:168`, `:325`).
     */
    readonly strong?: boolean | undefined;
    /**
     * M15 — SYNC OFF's deliberate 9 pt (`:147`), one point below every other badge's 10. It is
     * how the dimmed "sync is on but this pane opted out" state reads as secondary rather than
     * as another live badge.
     */
    readonly small?: boolean | undefined;
    readonly icon?: IconName | undefined;
    /**
     * L28 — the glyph's point size. `PaneHeaderView.swift` draws the label chip's `tag.fill`,
     * ZOOM's arrows and both SYNC glyphs at **8** (`:83`, `:104`, `:129`, `:145`) and only the
     * branch's `arrow.triangle.branch` at 9 (`:166`). The port had flattened all five to 9.
     */
    readonly iconSize?: number | undefined;
    readonly text: string;
    readonly title?: string | undefined;
    /**
     * TERM-102/104's truncation priority: a badge whose text is USER data (a pane label, a
     * branch name, an agent line) may give ground as the header narrows, after the path has;
     * a fixed-word badge (ZOOM, SYNC) may not, because there is nothing to truncate.
     *
     * The order is enforced with flex-shrink *weights* rather than by hiding anything: the
     * title carries a shrink factor two orders of magnitude larger (see `TITLE_SHRINK`), so it
     * absorbs essentially all of the first squeeze and these only start to give when it has
     * run out. The buttons never shrink at all — a header that drops its close ✕ before its
     * path is the wrong trade.
     */
    readonly shrinkable?: boolean | undefined;
    readonly onClick?: (() => void) | undefined;
}

function Badge({
    testID,
    color,
    fill,
    strong,
    small,
    icon,
    iconSize = 8,
    text,
    title,
    shrinkable,
    onClick
}: BadgeProps): ReactElement {
    const content = (
        <>
            {/* §S8: `shrink-0`. Under the squeeze the glyph went to 0 px too, so what was left
                of a "chip" was its 4 px of side padding and nothing else. */}
            {icon === undefined ? null : <Icon name={icon} size={iconSize} className="shrink-0" />}
            <span
                className={shrinkable === true ? 'min-w-0 truncate' : undefined}
                // §S8: the floor. A shrinkable badge stops at one glyph plus the ellipsis
                // instead of collapsing to a colour stub; `badgeFit` decides whether it is
                // drawn at all, so the floor never costs the header a button.
                {...(shrinkable === true ? { style: { minWidth: BADGE_TEXT_FLOOR } } : {})}
            >
                {text}
            </span>
        </>
    );
    const style = {
        color,
        background: pill(color, fill),
        // M14: every badge in `PaneHeaderView.swift` is `RoundedRectangle(cornerRadius: 3)`.
        borderRadius: 3,
        ...(shrinkable === true ? { minWidth: 0, maxWidth: '40%' } : {})
    };
    // Both size classes are spelled out as literals: Tailwind scans SOURCE TEXT, so a class name
    // assembled from an interpolated number would never be generated.
    const sizeClass = small === true ? 'text-[9px]' : 'text-[10px]';
    const weightClass = strong === true ? ' font-medium' : '';
    // L28: `HStack(spacing: 2)` inside every badge (`PaneHeaderView.swift:81`, `:102`, `:127`,
    // `:143`, `:164`) — `gap-1` was 4 px, double the gap, which pushed each glyph off its text
    // far enough that the pill read as two things rather than one chip.
    // §S20: `leading-[1.2]`, not `leading-none`.
    //
    // `PaneHeaderView.swift:89-91` puts its 1 pt of vertical padding around a `Text` whose line
    // box already carries the ascender AND the descender, so the padding sits OUTSIDE the glyph
    // box. `leading-none` collapsed the line box to exactly the font size, which put the 1 px
    // inside it: the pill measured **12.00 px**, and on a real branch string (`gypsy/pg`) the
    // inner `truncate` span clipped the last pixel of the descender (`scrollHeight` 11 in a
    // 10 px content box). The register asks for `leading-none` to simply go, on the reading
    // that `normal` is ~12 px at 10 px — measured on the running app it is **14 px** for this
    // face, which would make the pill 16. `1.2` is the smallest line box that clears the
    // measured ink (ascent 7.29 + descent 2.15 = 9.44 px at 10 px) and it lands the pill on the
    // 14 px the row asks for, with SYNC OFF's deliberate 9 pt still a point shorter (12.8).
    const className = `flex ${shrinkable === true ? 'shrink' : 'shrink-0'} items-center gap-[2px] px-1 py-px font-mono ${sizeClass}${weightClass} leading-[1.2]`;
    if (onClick === undefined) {
        return (
            <span data-testid={testID} className={className} style={style} {...(title === undefined ? {} : { title })}>
                {content}
            </span>
        );
    }
    return (
        <button
            type="button"
            data-testid={testID}
            className={className}
            style={style}
            {...(title === undefined ? {} : { title })}
            // L33: the ZOOM badge is a `Button` in the Swift too (`PaneHeaderView.swift:101`), so
            // it consumes its own press — clicking it neither moves focus nor starts a pane drag.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
            // A SwiftUI `Button` consumes the whole tap, double taps included, so the header's
            // `.onTapGesture(count: 2)` never sees one that landed on the ZOOM badge. `dblclick`
            // is a separate native event from `click`, so stopping `click` is not enough here.
            onDoubleClick={(event) => event.stopPropagation()}
        >
            {content}
        </button>
    );
}

interface HeaderButtonProps {
    readonly testID: string;
    readonly label: string;
    readonly icon: IconName;
    /**
     * L25 — the glyph's point size. Every button in `PaneHeaderView.swift:177-273` is
     * `.font(.system(size: 10))` **except** close, which is deliberately
     * `.font(.system(size: 9, weight: .semibold))` (`:265`): smaller and bolder than the split
     * icons it sits beside, which is how a row of five same-sized glyphs still ends in a ✕ that
     * reads as the one destructive control.
     */
    readonly iconSize?: number | undefined;
    readonly iconWeight?: IconWeight | undefined;
    /** Dimmed and inert, but still in the row: a control that vanishes reflows the header. */
    readonly disabled?: boolean | undefined;
    /** §S40 — the `•••` needs its own box to anchor its menu under. */
    readonly buttonRef?: RefObject<HTMLButtonElement | null> | undefined;
    readonly expanded?: boolean | undefined;
    readonly onClick?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
}

function HeaderButton({
    testID,
    label,
    icon,
    iconSize = 10,
    iconWeight = 'regular',
    disabled,
    buttonRef,
    expanded,
    onClick
}: HeaderButtonProps): ReactElement {
    const off = disabled === true;
    return (
        <button
            type="button"
            {...(buttonRef === undefined ? {} : { ref: buttonRef })}
            data-testid={testID}
            aria-label={label}
            title={label}
            disabled={off}
            {...(expanded === undefined ? {} : { 'aria-haspopup': 'menu' as const, 'aria-expanded': expanded })}
            // L24: `.opacity(0.6)` and nothing else (`PaneHeaderView.swift:192`, `:205`, `:218`,
            // `:230`, `:241`, `:259`, `:271`) — the shipped header buttons carry no `.onHover`,
            // so they never brighten under the cursor. The port's `hover:opacity-100` was
            // invented chrome, and it is gone.
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
                off ? 'opacity-25' : 'opacity-60'
            }`}
            style={{ color: tokens.textSecondary, cursor: off ? 'default' : 'pointer' }}
            onPointerDown={(event) => {
                // Never let a button press start a pane-move drag.
                event.stopPropagation();
            }}
            onClick={(event) => {
                event.stopPropagation();
                onClick?.(event);
            }}
            // The Swift header hangs `.onTapGesture(count: 2) { onToggleZoom }` off the HStack,
            // and every control inside it is a SwiftUI `Button`, which swallows its own taps —
            // so a double-click on Split Right there is two splits and NOTHING else. In the DOM
            // `dblclick` is a separate native event from `click`: stopping `click` leaves it
            // bubbling to the header's `onDoubleClick`, which is two splits *and* a zoom toggle.
            onDoubleClick={(event) => event.stopPropagation()}
        >
            <Icon name={icon} size={iconSize} weight={iconWeight} />
        </button>
    );
}

// ── the header ──────────────────────────────────────────────────────────────────────

export interface PaneHeaderProps extends PaneActions {
    readonly pane: PaneModel;
    readonly focused: boolean;
    /** This pane is the workspace's zoomed pane. */
    readonly zoomed?: boolean | undefined;
    /** The workspace has more than one pane, so the ZOOM badge is meaningful. */
    readonly zoomAvailable?: boolean | undefined;
    readonly syncActive?: boolean | undefined;
    readonly syncExcluded?: boolean | undefined;
    readonly homeDirectory?: string | undefined;
    /** Pins the elapsed clock (tests); omit to subscribe to the shared 1 s ticker. */
    readonly nowSeconds?: number | undefined;
    readonly height?: number | undefined;
    /**
     * §S8 — the pane's own width, which is the header's width (`w-full`). The grid already has
     * it as the pane's frame, so the header reads it rather than measuring itself: it is what
     * `badgeFit` uses to decide whether a user-data badge has room to be drawn at all. Omitted
     * (a standalone render) means "no ladder".
     */
    readonly paneWidth?: number | undefined;
    /**
     * Bumped to open the inline rename field from OUTSIDE the header — the context menu's
     * "Rename…" (TERM-106), which in the Swift app raised a sheet and here reuses the field
     * that is already the port's rename affordance (TERM-112's accepted divergence).
     *
     * A counter rather than a boolean, so asking twice in a row re-opens the field after the
     * first edit was committed.
     */
    readonly renameToken?: number | undefined;
    /** The grid's pane-move drag hook (shell-ui.md §4.3). */
    readonly onHeaderPointerDown?: ((paneID: string, event: PointerEvent<HTMLElement>) => void) | undefined;
}

function PaneHeaderImpl(props: PaneHeaderProps): ReactElement {
    const {
        pane,
        focused,
        zoomed = false,
        zoomAvailable = false,
        syncActive = false,
        syncExcluded = false,
        homeDirectory = '',
        nowSeconds,
        height = PANE_HEADER_HEIGHT,
        paneWidth,
        renameToken = 0,
        onHeaderPointerDown,
        onFocusPane,
        onClosePane,
        onRenamePane,
        onSplitPane,
        onToggleZoom,
        onToggleMarkdownEdit,
        onRefreshDiff,
        onCopyDocument,
        onNewWebPane,
        onPaneContextMenu
    } = props;

    const running = pane.type === 'shell' && pane.agentSessionID !== null && pane.status === 'running';
    // Only a running agent with a known start time needs the clock; everything else is static.
    const wantsTick = running && pane.agentStartedAt !== null && nowSeconds === undefined;
    const ticked = useSecondsTicker(wantsTick);
    const now = nowSeconds ?? ticked;

    // `null` = not renaming; a string is the live draft. Commit is idempotent, so the
    // blur that follows an Enter (or an unmount) can never fire the callback twice.
    const [renameDraft, setRenameDraft] = useState<string | null>(null);
    const renaming = renameDraft !== null;

    /*
     * §S40 — where the `•••` menu is open, if it is.
     *
     * State in this component is exactly what the file's own menu-stability rule allows: the
     * header re-renders IN PLACE on the per-second agent tick rather than remounting, so an
     * open menu survives it — and the menu itself is a `ContextMenu` portal, whose whole
     * reason for existing is that lifetime (shell-ui.md §15, macOS #124/#227).
     */
    const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null);
    const overflowRef = useRef<HTMLButtonElement | null>(null);

    // The context menu's "Rename…" is now the ONLY way in (M30 dropped the header's own pencil,
    // which the Swift never had): it reaches the field through a bumped token, and the effect
    // runs only on a CHANGE, so a re-render caused by an agent tick can never re-open it.
    const lastRenameToken = useRef(renameToken);
    useEffect(() => {
        if (renameToken === lastRenameToken.current) return;
        lastRenameToken.current = renameToken;
        if (renameToken > 0) setRenameDraft(pane.label ?? '');
    }, [renameToken, pane.label]);

    const commitRename = (): void => {
        if (renameDraft === null) return;
        setRenameDraft(null);
        onRenamePane?.(pane.id, renameDraft.trim());
    };

    const cancelRename = (): void => setRenameDraft(null);

    const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter') {
            event.preventDefault();
            commitRename();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelRename();
        }
    };

    const badge = agentBadge(pane, now);
    const title = paneDisplayTitle(pane, homeDirectory);
    const titleParts = splitHeaderTitle(title);

    /*
     * §S8 — what this header wants, and what its width can seat.
     *
     * `showCopyButton` is read twice on purpose: once here, once by the JSX below, so the
     * button count the ladder reserves for can never drift from the row it is reserving for.
     * The other five trailing buttons are the two type ones and the four shared ones.
     */
    const showCopyButton = pane.type === 'markdown' && pane.isEditing !== true && onCopyDocument !== undefined;
    const buttonCount =
        4 + (showCopyButton ? 1 : 0) + (pane.type === 'markdown' ? 1 : 0) + (pane.type === 'diff' ? 1 : 0);
    const fit = badgeFit({
        paneWidth,
        label: pane.label !== null && pane.label.length > 0 && pane.type !== 'markdown',
        agent: badge !== null,
        branch: pane.gitBranch !== null && pane.gitBranch.length > 0,
        buttons: buttonCount
    });

    /*
     * §S40 — the trailing button row, as data, so the fold has one list to read.
     *
     * Row order is `PaneHeaderView.swift:177-272`'s: the per-type buttons, then split-right,
     * split-down, the globe, and the ✕ (which is not in this list — it never folds). Every entry
     * carries both an `onClick` for the button and an `onSelect` for the `•••` menu row it
     * becomes when it folds, because the two are not always the same gesture: the globe's button
     * reads `event.shiftKey` to choose the split direction, and a menu row has no modifier.
     */
    const tail: readonly {
        readonly key: string;
        readonly testID: string;
        readonly label: string;
        readonly icon: IconName;
        readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
        readonly onSelect: () => void;
    }[] = [
        ...(showCopyButton
            ? [
                  {
                      key: 'copy',
                      testID: `pane-copy-${pane.id}`,
                      // L26: `.help("Copy whole file")` (`PaneHeaderView.swift:193`), verbatim. It
                      // was the one header tooltip the port had reworded — every other string in
                      // this row is already the Swift's — and the rewrite also became the button's
                      // accessible name, so a screen reader read a label the shipped app does not
                      // have. Which two formats the menu then offers is the MENU's business.
                      label: 'Copy whole file',
                      icon: 'copy' as const,
                      onClick: () => onCopyDocument(pane.id),
                      onSelect: () => onCopyDocument(pane.id)
                  }
              ]
            : []),
        ...(pane.type === 'markdown'
            ? [
                  {
                      key: 'edit',
                      testID: `pane-edit-toggle-${pane.id}`,
                      label: pane.isEditing === true ? 'Preview (⌘E)' : 'Edit (⌘E)',
                      icon: (pane.isEditing === true ? 'eye' : 'pencil') as IconName,
                      onClick: () => onToggleMarkdownEdit?.(pane.id),
                      onSelect: () => onToggleMarkdownEdit?.(pane.id)
                  }
              ]
            : []),
        ...(pane.type === 'diff'
            ? [
                  {
                      key: 'refresh',
                      testID: `pane-refresh-${pane.id}`,
                      label: 'Refresh diff',
                      icon: 'refresh' as const,
                      onClick: () => onRefreshDiff?.(pane.id),
                      onSelect: () => onRefreshDiff?.(pane.id)
                  }
              ]
            : []),
        {
            key: 'split-right',
            testID: `pane-split-right-${pane.id}`,
            label: 'Split right (⌘D)',
            icon: 'split-right',
            onClick: () => onSplitPane?.(pane.id, 'horizontal'),
            onSelect: () => onSplitPane?.(pane.id, 'horizontal')
        },
        {
            key: 'split-down',
            testID: `pane-split-down-${pane.id}`,
            label: 'Split down (⌘⇧D)',
            icon: 'split-down',
            onClick: () => onSplitPane?.(pane.id, 'vertical'),
            onSelect: () => onSplitPane?.(pane.id, 'vertical')
        },
        {
            key: 'new-web',
            testID: `pane-new-web-${pane.id}`,
            label: 'New web pane (⇧-click splits down)',
            icon: 'globe',
            onClick: (event) => onNewWebPane?.(pane.id, event.shiftKey ? 'vertical' : 'horizontal'),
            onSelect: () => onNewWebPane?.(pane.id, 'horizontal')
        }
    ];

    // §S40: fold from the ✕ inward. `tail` is in row order, so the survivors are its prefix.
    const folded = headerOverflowCount({
        paneWidth,
        buttons: buttonCount,
        badgeCost:
            (fit.label ? BADGE_COST.label : 0) +
            (fit.agent ? BADGE_COST.agent : 0) +
            (fit.branch ? BADGE_COST.branch : 0)
    });
    const inlineTail = folded === 0 ? tail : tail.slice(0, Math.max(tail.length - folded, 0));
    const overflowTail = folded === 0 ? [] : tail.slice(Math.max(tail.length - folded, 0));
    const overflowItems: readonly MenuItemSpec[] = overflowTail.map((entry) => ({
        id: entry.key,
        label: entry.label,
        onSelect: entry.onSelect
    }));
    // §S40: widening the pane un-folds the row, and a menu anchored to a `•••` that is no longer
    // drawn would be a menu floating under nothing. `useDismissable` cannot see this — it
    // watches for clicks and Escape, not for the button disappearing out from under it.
    const overflowOpen = overflowAt !== null;
    useEffect(() => {
        if (overflowOpen && overflowItems.length === 0) setOverflowAt(null);
    }, [overflowOpen, overflowItems.length]);

    return (
        <div
            data-testid={`pane-header-${pane.id}`}
            data-focused={focused ? 'true' : 'false'}
            // M17: `HStack(spacing: 4)` + `.padding(.horizontal, 8)` (`PaneHeaderView.swift:52,274`).
            // The port's `gap-1.5` was 6 px — 50% wider, across a button tail plus three or four
            // badges, which is why this header ran out of room sooner than the shipped one.
            className="flex w-full shrink-0 select-none items-center gap-1 px-2"
            style={{
                height,
                background: tokens.headerBackground,
                /*
                 * §S30 — the hairline is PAINTED, not laid out.
                 *
                 * `PaneHeaderView.swift:274-275` is `.padding(.vertical, 2)` → a 24 pt box, and
                 * `:297-299` draws the rule as an `.overlay(alignment: .bottom)`, which consumes
                 * no layout height. A `borderBottom` on a `border-box` element of `height: 24`
                 * does: the content band measured **23 px**, so the 20 px buttons sat 1.5 px
                 * above centre and 2.5 px below where the Swift's sit on 2 pt either side. An
                 * inset shadow paints the same 1 px on the same edge and costs the band nothing
                 * — measured 24.00 / 24.00 after, with the buttons at 2.0 / 2.0.
                 */
                boxShadow: `inset 0 -1px 0 ${tokens.divider}`,
                cursor: renaming ? 'text' : 'default'
            }}
            onPointerDown={(event) => {
                // shell-ui.md §4.1: clicking anywhere in a pane focuses it.
                onFocusPane?.(pane.id);
                if (renaming) return;
                onHeaderPointerDown?.(pane.id, event);
            }}
            onDoubleClick={(event) => {
                if (renaming) return;
                event.preventDefault();
                onToggleZoom?.(pane.id);
            }}
            onContextMenu={(event) => {
                if (onPaneContextMenu === undefined) return;
                event.preventDefault();
                onPaneContextMenu(pane.id, event);
            }}
        >
            {/* 1 — type glyph / status dot */}
            {pane.type === 'shell' ? (
                <span
                    data-testid={`pane-status-dot-${pane.id}`}
                    data-status={pane.status}
                    className="h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-300"
                    style={{
                        background: statusDotColor(pane.status),
                        opacity: pane.status === 'idle' && !focused ? 0.5 : 1
                    }}
                />
            ) : (
                <span className="shrink-0" style={{ color: tokens.textSecondary }}>
                    <Icon name={TYPE_GLYPHS[pane.type]} size={10} />
                </span>
            )}

            {/* 2 — label chip (§S8: last of the three to go) */}
            {fit.label && pane.label !== null ? (
                <Badge
                    testID={`pane-label-${pane.id}`}
                    // M13: `PaneHeaderView.swift:88,91` is `Color.accentColor` — the macOS system
                    // accent, not the chrome theme's `accent`. See `tokens.ts` for the seam and
                    // the standing divergence.
                    color={tokens.systemAccent}
                    fill={12}
                    icon="tag"
                    text={pane.label}
                    shrinkable
                />
            ) : null}

            {/* 3 — path / title, or the inline rename field */}
            {renaming ? (
                <input
                    data-testid={`pane-rename-input-${pane.id}`}
                    aria-label="Pane name"
                    autoFocus
                    value={renameDraft}
                    className="min-w-0 flex-1 rounded px-1 font-mono text-[11px] leading-none outline-none"
                    style={{ background: tokens.surfaceBackground, color: tokens.textPrimary }}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={onRenameKeyDown}
                    onBlur={commitRename}
                    onPointerDown={(event) => event.stopPropagation()}
                />
            ) : (
                <span
                    data-testid={`pane-title-${pane.id}`}
                    // M11 — no `flex-1`. The Swift's `Text(displayPath)` sizes to its content and
                    // the free space belongs to the `Spacer()` at `PaneHeaderView.swift:157`,
                    // AFTER the ZOOM and SYNC badges; a `flex-1` title absorbed every pixel of
                    // slack instead, which pushed ZOOM and SYNC out of the left cluster (where
                    // they hug the path) and over to the right one. Grow 0, shrink `TITLE_SHRINK`.
                    className="flex min-w-0 font-mono text-[11px] leading-none"
                    // TERM-102/104's truncation priority, expressed the only way flexbox can:
                    // negative space is shared out in proportion to (shrink factor × base size),
                    // so a title weighted `TITLE_SHRINK` against the badges' 1 takes effectively
                    // the whole squeeze first, and the badges only give when it has nothing left.
                    // The spacer below carries `flex-basis: 0`, so it contributes nothing to that
                    // share-out and cannot steal the squeeze from the title.
                    // L32: no `title=`. `PaneHeaderView.swift:94-98` is a bare `Text(displayPath)`
                    // with `.truncationMode(.middle)` and no `.help()`, so hovering a truncated
                    // path in the shipped app shows nothing at all. The native tooltip was a port
                    // invention — and a misleading one, since it was the ONLY header element that
                    // answered a hover, which implied the truncation was recoverable here and
                    // nowhere else. The full path is still in the status footer and the
                    // inspector, which is where the shipped app puts it.
                    style={{ color: focused ? tokens.textPrimary : tokens.textSecondary, flexShrink: TITLE_SHRINK }}
                >
                    <span className="min-w-0 truncate">{titleParts.head}</span>
                    {titleParts.tail === '' ? null : <span className="shrink-0">{titleParts.tail}</span>}
                </span>
            )}

            {/* 4 — ZOOM badge */}
            {zoomed && zoomAvailable ? (
                <Badge
                    testID={`pane-zoom-badge-${pane.id}`}
                    // L27: `.orange` (`PaneHeaderView.swift:109,112`), as a token — the hex that
                    // was here was the only colour in the grid outside `--kelpi-*`, so it ignored
                    // the light/dark swap.
                    color={tokens.orange}
                    fill={12}
                    strong
                    icon="zoom"
                    text="ZOOM"
                    title="Toggle zoom"
                    onClick={() => onToggleZoom?.(pane.id)}
                />
            ) : null}

            {/* 5 — SYNC badges */}
            {syncActive && !syncExcluded ? (
                <Badge
                    testID={`pane-sync-badge-${pane.id}`}
                    // L27: `.orange` too (`PaneHeaderView.swift:134,137`) — the SAME orange as
                    // ZOOM. Painted with `--kelpi-agent` it was the agent amber, so a synced pane
                    // read as a pane with an agent running in it.
                    color={tokens.orange}
                    fill={12}
                    strong
                    icon="broadcast"
                    text="SYNC"
                    title="Synchronise input is on — keystrokes mirror to peer panes"
                />
            ) : null}
            {syncActive && syncExcluded ? (
                <Badge
                    testID={`pane-sync-off-badge-${pane.id}`}
                    color={tokens.textTertiary}
                    fill={10}
                    strong
                    small
                    icon="broadcast-off"
                    text="SYNC OFF"
                    title="Excluded from the workspace sync group"
                />
            ) : null}

            {/* 6 — spacer.
                M11: `Spacer()` at `PaneHeaderView.swift:157`, and it is the reason ZOOM and SYNC
                belong to the LEFT cluster. `flex-1` here (basis 0) takes the slack the title no
                longer does, and contributes nothing to the negative-space share-out that decides
                the truncation order. It is skipped while the inline rename field is up: that
                field is `flex-1` too, and Swift has no counterpart to split the slack with, so
                the field keeps the whole run of the header exactly as it did before.

                The test id is deliberately NOT `pane-header-spacer-…`: the audit harness counts
                panes and extracts pane ids with `[data-testid^="pane-header-"]` in eleven places
                (`scripts/ui-audit/audit.mjs:530,533`), so a second element under that prefix would
                read as a second pane in every one of them. */}
            {renaming ? null : <div data-testid={`pane-spacer-${pane.id}`} aria-hidden="true" className="flex-1" />}

            {/* 7 — agent badge (§S8: dropped before the label; the status dot keeps the state) */}
            {badge === null || !fit.agent ? null : (
                <Badge
                    testID={`pane-agent-badge-${pane.id}`}
                    color={badge.tone === 'running' ? tokens.activeAgent : tokens.statusWaiting}
                    fill={14}
                    text={badge.text}
                    shrinkable
                />
            )}

            {/* 8 — git branch (§S8: first to go; the footer and the inspector both show it) */}
            {!fit.branch || pane.gitBranch === null ? null : (
                <Badge
                    testID={`pane-branch-${pane.id}`}
                    color={tokens.textSecondary}
                    fill={10}
                    icon="branch"
                    // L28: the one badge glyph the Swift draws at 9 (`PaneHeaderView.swift:166`);
                    // the other four are 8.
                    iconSize={9}
                    text={pane.gitBranch}
                    shrinkable
                />
            )}

            {/* 9–13 — the trailing button row.
                The buttons themselves are declared as `tail` above (§S40 needs them as data so
                the fold has one list to read); what follows is the record of what is NOT in it
                and why, kept here where the row is drawn.

                M30: no `A−` / `A+` pair. `PaneHeaderView.swift:177-273` is the complete per-type
                block — markdown-copy, markdown-edit, diff-refresh — and the shipped app exposes
                preview font size ONLY through ⌘= / ⌘- / ⌘0. The pair existed here partly because
                a focused preview could not receive those chords (§H9); that reason expired when
                H9's chord relay landed — `content/bridge.ts` now posts a `focus` on any press
                inside the frame and replays every chord the binding map claims, and
                `increase/decrease/reset_markdown_font_size` are bound by default
                (`core/config/bindings.ts:68-70` → `App.tsx:2565-2567`). The capability itself is
                untouched: `PaneActions.onSetFontSize` and the `set-font-size` path stay, exactly
                as `onRestartAgent` does below. */}
            {/* §TERM-103: the Swift's header copy menu — markdown, preview mode only (there is
                no rendered document to copy while the editor is up). The menu is drawn by the
                content frame; this asks it to open. */}
            {/* No `.shell` branch, deliberately. `PaneHeaderView.swift:177-272`'s per-type block
                is markdown-copy / markdown-edit / diff-refresh and then the shared tail; the
                shipped app has no restart control anywhere (`grep -rn restartAgent Kelpi/` is
                empty), and a one-click restart of a live agent sitting between Split Down and
                Close is a mis-click nobody asked for. The capability itself stays: the
                `restart-pane-agent` verb, its daemon channel and `PaneActions.onRestartAgent`
                are untouched, so any client — or a later context-menu item — can still reach it. */}

            {/* M30: no rename button. `PaneHeaderView.swift:222-272` is split-right, split-down,
                globe, close and nothing else; the shipped app's rename lives in the header's
                CONTEXT menu (`:354-356`, "Rename…"), which the port already offers and drives
                through `renameToken`. The pencil also sat immediately beside the markdown
                edit-toggle's near-identical pencil, so the two glyphs read as one control
                repeated. The inline field itself is unchanged — it is still the port's rename
                affordance (TERM-112), just reached the way the Swift reaches it.

                §S40 (owner-directed): the row above the ✕ is `tail`, drawn from its prefix. At
                every width where the whole row fits this is the same JSX it always was, in the
                same order; below it the trailing entries become the `•••` menu instead, so the
                ✕ is the last control the pane loses rather than the first. */}
            {inlineTail.map((entry) => (
                <HeaderButton
                    key={entry.key}
                    testID={entry.testID}
                    label={entry.label}
                    icon={entry.icon}
                    onClick={entry.onClick}
                />
            ))}
            {overflowItems.length === 0 ? null : (
                <HeaderButton
                    buttonRef={overflowRef}
                    testID={`pane-overflow-${pane.id}`}
                    label="More pane actions"
                    icon="ellipsis"
                    expanded={overflowAt !== null}
                    onClick={() => {
                        if (overflowAt !== null) {
                            setOverflowAt(null);
                            return;
                        }
                        // Anchored under the button the way a native menu drops. `ContextMenu`
                        // is a portal, so it needs viewport coordinates rather than a position
                        // inside this header — the same anchoring `chrome/TopBar.tsx`'s own
                        // ••• uses, and the same `ContextMenu` recipe, which means §N26's
                        // overlay registration (a web pane's native page parks while the menu
                        // is up) comes with it rather than being re-invented here.
                        const box = overflowRef.current?.getBoundingClientRect();
                        setOverflowAt(
                            box === undefined
                                ? { x: 8, y: 32 }
                                : { x: Math.round(box.left), y: Math.round(box.bottom + 4) }
                        );
                    }}
                />
            )}
            {/* L25: the one button in the row that is not 10 pt regular — 9 pt semibold. */}
            <HeaderButton
                testID={`pane-close-${pane.id}`}
                label="Close pane (⌘W)"
                icon="close"
                iconSize={9}
                iconWeight="semibold"
                onClick={() => onClosePane?.(pane.id)}
            />
            {overflowAt === null || overflowItems.length === 0 ? null : (
                <ContextMenu
                    x={overflowAt.x}
                    y={overflowAt.y}
                    items={overflowItems}
                    label="More pane actions"
                    onClose={() => setOverflowAt(null)}
                />
            )}
        </div>
    );
}

export const PaneHeader = memo(PaneHeaderImpl);
PaneHeader.displayName = 'PaneHeader';
