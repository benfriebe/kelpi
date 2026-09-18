/**
 * One pane's chrome, as DATA: the strings, the badges, the ladders and the control row the native
 * header already draws, with the run targets kept privately beside it.
 *
 * Two things live here and nowhere else:
 *
 *   1. **The per-pane projection.** `paneChromeModel` folds a `PaneModel`, the workspace facts the
 *      grid holds (focus, zoom, sync, the home directory, the measured width) and the plugin
 *      contributions into one `PaneChromeDescriptor`. Everything the header paints comes out of
 *      that descriptor, so a presenter that is handed one can redraw the header it replaced.
 *   2. **The run targets, privately.** A plugin `pane.header` command arrives with a `run(paneID)`
 *      closure; the descriptor carries its display name and an opaque key, and the closure goes
 *      into `targets`, which `surface.ts` is the only reader of. A leaked closure would be the
 *      pane-header sibling of a leaked config key, so `model.test.ts` asserts a descriptor
 *      survives `JSON.parse(JSON.stringify(...))` unchanged.
 *
 * The display functions below moved here from `grid/PaneHeader.tsx` unchanged - same code, same
 * comments, same exported names, which `PaneHeader` re-exports so that every existing import and
 * every existing test keeps working. They belong to the model rather than to the painting: a
 * presenter needs the middle-truncation split and the badge ladder as much as the bundled header
 * does, and two copies of `badgeFit` would be two answers to which badges fit.
 */

import type { SplitDirection } from '@kelpi/core/layout';

import { chromeElapsedLabel } from '../grid/elapsed';
import type { IconName } from '../grid/icons';
import type { PaneModel } from '../grid/types';

import {
    PANE_CHROME_LIMITS,
    type PaneChromeAgent,
    type PaneChromeBadgeFit,
    type PaneChromeChanges,
    type PaneChromeControlDescriptor,
    type PaneChromeDescriptor,
    type PaneChromeItemDescriptor
} from './contract';

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
        case 'plugin':
            return pane.label ?? pane.title ?? 'Plugin view';
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

// ── the two width ladders ───────────────────────────────────────────────────────────

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

// ── the model ───────────────────────────────────────────────────────────────────────

/**
 * Another plugin's `pane.header` menu command, as the host holds it: a display name, an enabled
 * flag and the closure that runs it. The closure goes to `targets` and never into a descriptor.
 */
export interface PaneChromeCommandInput {
    readonly id: string;
    readonly title: string;
    readonly enabled?: boolean | undefined;
    run(paneID: string): void;
}

/** Everything the host knows about one pane, before any of it is a descriptor. */
export interface PaneChromeInput {
    readonly pane: PaneModel;
    readonly focused: boolean;
    readonly zoomed?: boolean | undefined;
    readonly zoomAvailable?: boolean | undefined;
    readonly syncActive?: boolean | undefined;
    readonly syncExcluded?: boolean | undefined;
    readonly homeDirectory?: string | undefined;
    /** Whole seconds, from the shared ticker, so every elapsed clock in the window agrees. */
    readonly nowSeconds: number;
    /** The band this pane is painting at (`height.ts` has already clamped it). */
    readonly height?: number | undefined;
    /** The pane's measured width, or undefined in a render with no layout (§S8, §S40). */
    readonly paneWidth?: number | undefined;
    readonly renaming?: boolean | undefined;
    readonly commands?: readonly PaneChromeCommandInput[] | undefined;
    readonly items?: readonly PaneChromeItemDescriptor[] | undefined;
    /**
     * Whether the host has a contributions box to draw for this pane.
     *
     * A boolean rather than `items.length > 0`, because the box's presence is what the width
     * ladder is charged four buttons for, and the host decides that from the node it is about to
     * render. Deriving it from the descriptor list instead would change the charge in every
     * render that has the items but not the node, which is every standalone header test.
     */
    readonly contributions?: boolean | undefined;
    readonly changes?: PaneChromeChanges | null | undefined;
    /** The markdown copy control exists only where the host bound a handler for it. */
    readonly canCopyDocument?: boolean | undefined;
}

/**
 * The run targets, which are the half of the model a descriptor must never carry.
 *
 * Keyed by the control's key, exactly as `settings/sections.ts` keys a write target by field id.
 * `surface.ts` re-resolves against a FRESH model on every call, so a command whose plugin was
 * disabled, whose enablement went false or which never existed refuses to run rather than running
 * a stale closure.
 */
export interface PaneChromeTargets {
    readonly commands: ReadonlyMap<string, (paneID: string) => void>;
}

export interface PaneChromeModel {
    readonly descriptor: PaneChromeDescriptor;
    readonly targets: PaneChromeTargets;
}

/** The glyph each non-shell pane kind wears instead of a status dot. */
const TYPE_GLYPHS: Record<Exclude<PaneModel['type'], 'shell'>, IconName> = {
    markdown: 'document',
    scratchpad: 'note',
    diff: 'plusminus',
    plugin: 'document',
    web: 'globe'
};

/** The glyph a pane of this kind wears, or null for a shell pane, which wears a status dot. */
export function paneChromeGlyph(kind: PaneModel['type']): IconName | null {
    return kind === 'shell' ? null : TYPE_GLYPHS[kind];
}

/** The split each of the two split controls performs. */
export const PANE_CHROME_SPLITS: Readonly<Record<'split-right' | 'split-down', SplitDirection>> = {
    'split-right': 'horizontal',
    'split-down': 'vertical'
};

function control(
    entry: Omit<PaneChromeControlDescriptor, 'enabled' | 'pinned'> &
        Partial<Pick<PaneChromeControlDescriptor, 'enabled' | 'pinned'>>
): PaneChromeControlDescriptor {
    return {
        key: entry.key,
        kind: entry.kind,
        label: entry.label,
        icon: entry.icon,
        testID: entry.testID,
        enabled: entry.enabled ?? true,
        pinned: entry.pinned ?? false
    };
}

/**
 * Fold a pane into its chrome.
 *
 * The order below is `PaneHeaderView.swift:177-273`'s row order, which is also the order §S40
 * folds from the ✕ inward: the plugin commands, the per-type controls, split-right, split-down,
 * the globe, and then the ✕, which carries `pinned` so it is never a fold candidate.
 */
export function paneChromeModel(input: PaneChromeInput): PaneChromeModel {
    const { pane } = input;
    const homeDirectory = input.homeDirectory ?? '';
    const title = paneDisplayTitle(pane, homeDirectory);
    const badge = agentBadge(pane, input.nowSeconds);
    const commandInputs = input.commands ?? [];
    const items = input.items ?? [];
    const contributions = input.contributions === true;

    // Read once and used twice, exactly as the header reads it: the count the ladder reserves for
    // can never drift from the row it is reserving for.
    const showCopy =
        pane.type === 'markdown' && pane.isEditing !== true && input.canCopyDocument === true;
    const buttons =
        4 +
        (showCopy ? 1 : 0) +
        (pane.type === 'markdown' ? 1 : 0) +
        (pane.type === 'diff' ? 1 : 0) +
        commandInputs.length +
        (contributions ? 4 : 0);

    const badges: PaneChromeBadgeFit = badgeFit({
        paneWidth: input.paneWidth,
        label: pane.label !== null && pane.label.length > 0 && pane.type !== 'markdown',
        agent: badge !== null,
        branch: pane.gitBranch !== null && pane.gitBranch.length > 0,
        buttons
    });

    const controls: PaneChromeControlDescriptor[] = [
        ...commandInputs.map((command) =>
            control({
                key: command.id,
                kind: 'item',
                label: command.title,
                icon: 'plugin',
                testID: `pane-command-${command.id}-${pane.id}`,
                enabled: command.enabled !== false
            })
        ),
        ...(showCopy
            ? [
                  control({
                      key: 'copy',
                      kind: 'action',
                      // L26: `.help("Copy whole file")` (`PaneHeaderView.swift:193`), verbatim.
                      label: 'Copy whole file',
                      icon: 'copy',
                      testID: `pane-copy-${pane.id}`
                  })
              ]
            : []),
        ...(pane.type === 'markdown'
            ? [
                  control({
                      key: 'edit',
                      kind: 'action',
                      label: pane.isEditing === true ? 'Preview (⌘E)' : 'Edit (⌘E)',
                      icon: pane.isEditing === true ? 'eye' : 'pencil',
                      testID: `pane-edit-toggle-${pane.id}`
                  })
              ]
            : []),
        ...(pane.type === 'diff'
            ? [
                  control({
                      key: 'refresh',
                      kind: 'action',
                      label: 'Refresh diff',
                      icon: 'refresh',
                      testID: `pane-refresh-${pane.id}`
                  })
              ]
            : []),
        control({
            key: 'split-right',
            kind: 'action',
            label: 'Split right (⌘D)',
            icon: 'split-right',
            testID: `pane-split-right-${pane.id}`
        }),
        control({
            key: 'split-down',
            kind: 'action',
            label: 'Split down (⌘⇧D)',
            icon: 'split-down',
            testID: `pane-split-down-${pane.id}`
        }),
        control({
            key: 'new-web',
            kind: 'action',
            label: 'New web pane (⇧-click splits down)',
            icon: 'globe',
            testID: `pane-new-web-${pane.id}`
        }),
        control({
            key: 'close',
            kind: 'action',
            label: 'Close pane (⌘W)',
            icon: 'close',
            testID: `pane-close-${pane.id}`,
            // The one control the fold may never reach: it is the last thing a narrowing pane
            // loses rather than the first (§S40).
            pinned: true
        })
    ];

    const folded = headerOverflowCount({
        paneWidth: input.paneWidth,
        buttons,
        badgeCost:
            (badges.label ? BADGE_COST.label : 0) +
            (badges.agent ? BADGE_COST.agent : 0) +
            (badges.branch ? BADGE_COST.branch : 0)
    });

    const agent: PaneChromeAgent | null =
        badge === null
            ? null
            : {
                  kind: pane.agentKind,
                  elapsedSeconds:
                      pane.agentStartedAt === null
                          ? null
                          : Math.max(0, Math.round(input.nowSeconds - pane.agentStartedAt / 1000)),
                  backgroundTasks: pane.backgroundTaskCount,
                  text: badge.text,
                  tone: badge.tone
              };

    const descriptor: PaneChromeDescriptor = {
        paneID: pane.id,
        kind: pane.type,
        status: pane.status,
        focused: input.focused,
        title,
        titleParts: splitHeaderTitle(title),
        directory: homeAbbreviated(pane.workingDirectory, homeDirectory),
        label: pane.label,
        branch: pane.gitBranch,
        changes: input.changes ?? null,
        agent,
        zoom: { zoomed: input.zoomed === true, available: input.zoomAvailable === true },
        sync: { active: input.syncActive === true, excluded: input.syncExcluded === true },
        height: input.height ?? PANE_CHROME_LIMITS.nativeHeight,
        size: {
            width:
                input.paneWidth === undefined || !Number.isFinite(input.paneWidth)
                    ? null
                    : input.paneWidth,
            badges,
            buttons,
            folded
        },
        controls,
        items,
        contributions: contributions
            ? { testID: `pane-contributions-${pane.id}`, count: items.length }
            : null,
        renaming: input.renaming === true
    };

    return {
        descriptor,
        targets: {
            commands: new Map(commandInputs.map((command) => [command.id, command.run]))
        }
    };
}
