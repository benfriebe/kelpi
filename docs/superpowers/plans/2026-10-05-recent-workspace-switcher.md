# Recent Workspace Switcher (⌃Tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold ⌃ and tap Tab to step back through workspaces in most-recently-used order in an on-screen switcher; release ⌃ to switch. A quick ⌃Tab toggles between the last two workspaces.

**Architecture:** Two new bindable actions route to a framework-free gesture state machine (`app/recent-switcher.ts`) that orders workspaces with a pure function (`app/recent-workspaces.ts`) over the `lastAccessedAt` the client mirror already carries. `App.tsx` feeds the machine keydowns (through the existing dispatcher), keyups and window blur, and renders a palette-styled overlay (`chrome/RecentWorkspaceSwitcher.tsx`) that registers modal presence so a live web page is parked and the window gets the keyboard back.

**Tech Stack:** TypeScript, React, vitest + @testing-library/react, the repo's CDP scenario runner (`scripts/scenario.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-05-recent-workspace-switcher-design.md`

## Global Constraints

- Action raw values: `next_recent_workspace`, `previous_recent_workspace`; labels "Next Recent Workspace", "Previous Recent Workspace"; category `Workspaces`.
- Defaults: `ctrl+tab=next_recent_workspace`, `ctrl+shift+tab=previous_recent_workspace`.
- Neither action is in `MENU_BAR_ACTIONS` or `WINDOW_ARRANGEMENT_ACTIONS`.
- Overlay show delay: `SWITCHER_SHOW_DELAY_MS = 150`.
- `lastAccessedAt` is epoch SECONDS; a missing or non-number value sorts as 0.
- Local workspaces only (`selectSidebarWorkspaceIDs`, collapsed groups included); remote-daemon workspaces are excluded.
- No wire-protocol change: the client mirror is a `DaemonState` and already holds `lastAccessedAt`.
- Run every command from the worktree root: `/Users/mrowe/src/kelpi-worktrees/recent-workspaces`. Tests: `corepack pnpm exec vitest run <path>`. The scenario runner needs `pnpm` on `PATH`; if it is missing, use a shim that execs `corepack pnpm "$@"`.
- Code style: match the surrounding files (4-space indent, single quotes, `readonly` interfaces, explanatory block comments only where the code is not self-evident).

## Review Focus

1. **Modifier released before the 150 ms timer fires** — must commit the second row and never paint the overlay. Pinned in Task 3 ("quick tap").
2. **Holding ⌃Tab so Tab auto-repeats** — each repeat is another step and must keep wrapping, not commit. Pinned in Task 3 ("repeat steps wrap").
3. **Escape while held** — must cancel with no switch AND hand the caret back to the focused pane. Pinned in Task 3 (cancel) and Task 5 (scenario Escape check).
4. **A workspace deleted mid-gesture** — committing a vanished ID must not throw; `activateWorkspace` on an unknown ID is a no-op in the daemon reducer (`set-active-workspace` returns state unchanged). Pinned in Task 2 (order built from live state only) and Task 3 (commit passes the ID through untouched).
5. **Only one local workspace** — ⌃Tab must fall through unconsumed so a terminal app still receives it. Pinned in Task 3 ("fewer than two") and Task 5 (handler returns the machine's boolean).

---

### Task 1: The two actions, their defaults and Settings labels

**Files:**
- Modify: `packages/core/src/config/actions.ts` (Workspaces block of `KELPI_ACTIONS`; header comment count)
- Modify: `packages/core/src/config/bindings.ts` (default lines, after `alt+super+up=previous_workspace`)
- Modify: `packages/core/src/config/bindings.test.ts:25-39`
- Modify: `packages/client/src/settings/catalog.ts` (Workspaces rows)
- Modify: `packages/client/src/settings/catalog.test.ts:23-24,74`

**Interfaces:**
- Produces: `KelpiAction` gains `'next_recent_workspace' | 'previous_recent_workspace'`; `DEFAULT_KEYBINDINGS` gains `ctrl+tab` and `ctrl+shift+tab`.

- [ ] **Step 0: Install dependencies in the worktree**

Run: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install`
Expected: `Done in …`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/config/bindings.test.ts`, change the two counts and add a defaults test inside the same `describe`:

```ts
    it('has the 65 bindable actions and the 20 menu-bar ones', () => {
        expect(KELPI_ACTIONS).toHaveLength(65);
        expect(new Set(KELPI_ACTIONS).size).toBe(65);
```

```ts
    it('ships 49 triggers', () => {
        expect(DEFAULT_KEYBINDINGS.size).toBe(49);
```

```ts
    it('binds ⌃Tab and ⌃⇧Tab to the recent-workspace switcher', () => {
        expect(DEFAULT_KEYBINDINGS.get('ctrl+tab')).toBe('next_recent_workspace');
        expect(DEFAULT_KEYBINDINGS.get('ctrl+shift+tab')).toBe('previous_recent_workspace');
    });
```

(Keep whatever else those two `it` blocks assert; only the numbers change. If `DEFAULT_KEYBINDINGS` is keyed by something other than the config string, read the existing `ships 47 triggers` neighbours and use the same lookup they use.)

In `packages/client/src/settings/catalog.test.ts`:

```ts
    it('is the 65 actions the spec counts', () => {
        expect(ACTION_CATALOG).toHaveLength(65);
    });
```

and at line 74 `expect(visible).toHaveLength(65 - 11);`. Add:

```ts
    it('lists the recent-workspace switcher under Workspaces', () => {
        expect(actionsInCategory('Workspaces')).toContain('next_recent_workspace');
        expect(actionsInCategory('Workspaces')).toContain('previous_recent_workspace');
        expect(actionLabel('next_recent_workspace')).toBe('Next Recent Workspace');
        expect(actionLabel('previous_recent_workspace')).toBe('Previous Recent Workspace');
    });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `corepack pnpm exec vitest run packages/core/src/config/bindings.test.ts packages/client/src/settings/catalog.test.ts`
Expected: FAIL on the counts (63/47) and the new expectations.

- [ ] **Step 3: Implement**

`packages/core/src/config/actions.ts` — header comment `(63 actions …)` → `(65 actions …)`, and in the Workspaces block after `'previous_workspace',`:

```ts
    // ⌃Tab: hold to step back through workspaces in most-recently-used order, release to switch
    // (docs/config-keybindings.md §7.8). Monitor-only: a menu accelerator cannot see the release.
    'next_recent_workspace',
    'previous_recent_workspace',
```

`packages/core/src/config/bindings.ts` — after `'alt+super+up=previous_workspace',`:

```ts
    'ctrl+tab=next_recent_workspace',
    'ctrl+shift+tab=previous_recent_workspace',
```

`packages/client/src/settings/catalog.ts` — after the `previous_workspace` row:

```ts
    { action: 'next_recent_workspace', category: 'Workspaces', label: 'Next Recent Workspace' },
    { action: 'previous_recent_workspace', category: 'Workspaces', label: 'Previous Recent Workspace' },
```

- [ ] **Step 4: Run the tests, then the two packages' suites**

Run: `corepack pnpm exec vitest run packages/core/src/config/bindings.test.ts packages/client/src/settings/catalog.test.ts`
Expected: PASS.

Run: `corepack pnpm exec vitest run packages/core packages/client/src/settings packages/client/src/chrome`
Expected: PASS. If a snapshot (e.g. `chrome/__snapshots__`) fails, inspect the diff: if it is exactly the two new Workspaces rows, update with `-u`; anything else is a real failure.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config packages/client/src/settings packages/client/src/chrome/__snapshots__
git commit -m "Add next/previous recent workspace actions, bound to ⌃Tab and ⌃⇧Tab"
```

---

### Task 2: Recent order

**Files:**
- Create: `packages/client/src/app/recent-workspaces.ts`
- Test: `packages/client/src/app/recent-workspaces.test.ts`

**Interfaces:**
- Produces:
  - `interface RecentCandidate { readonly id: string; readonly lastAccessedAt: unknown }`
  - `recentWorkspaceOrder(candidates: readonly RecentCandidate[], activeID: string | null, localSeq: ReadonlyMap<string, number>): string[]` — `candidates` in sidebar order.
  - `createActivationSequence(): ActivationSequence` where `interface ActivationSequence { note(id: string | null): void; readonly seq: ReadonlyMap<string, number> }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { createActivationSequence, recentWorkspaceOrder } from './recent-workspaces';

const none = new Map<string, number>();

describe('recentWorkspaceOrder', () => {
    it('puts the active workspace first, then newest-first', () => {
        const order = recentWorkspaceOrder(
            [
                { id: 'a', lastAccessedAt: 100 },
                { id: 'b', lastAccessedAt: 300 },
                { id: 'c', lastAccessedAt: 200 }
            ],
            'a',
            none
        );
        expect(order).toEqual(['a', 'b', 'c']);
    });

    it('breaks a same-second tie by this window’s activation sequence', () => {
        const seq = new Map([['b', 1], ['c', 2]]);
        expect(
            recentWorkspaceOrder(
                [
                    { id: 'a', lastAccessedAt: 500 },
                    { id: 'b', lastAccessedAt: 400 },
                    { id: 'c', lastAccessedAt: 400 }
                ],
                'a',
                seq
            )
        ).toEqual(['a', 'c', 'b']);
    });

    it('falls back to sidebar order on a full tie', () => {
        expect(
            recentWorkspaceOrder(
                [
                    { id: 'x', lastAccessedAt: 1 },
                    { id: 'y', lastAccessedAt: 1 },
                    { id: 'z', lastAccessedAt: 1 }
                ],
                null,
                none
            )
        ).toEqual(['x', 'y', 'z']);
    });

    it('sorts a missing or non-number timestamp as oldest', () => {
        expect(
            recentWorkspaceOrder(
                [
                    { id: 'old', lastAccessedAt: undefined },
                    { id: 'nan', lastAccessedAt: Number.NaN },
                    { id: 'new', lastAccessedAt: 10 }
                ],
                null,
                none
            )
        ).toEqual(['new', 'old', 'nan']);
    });

    it('omits an active ID that is not a candidate (a remote workspace, or one just deleted)', () => {
        expect(recentWorkspaceOrder([{ id: 'a', lastAccessedAt: 1 }], 'gone', none)).toEqual(['a']);
    });
});

describe('createActivationSequence', () => {
    it('numbers each change of active workspace, ignoring repeats and null', () => {
        const sequence = createActivationSequence();
        sequence.note('a');
        sequence.note('a');
        sequence.note(null);
        sequence.note('b');
        sequence.note('a');
        expect(sequence.seq.get('b')).toBe(2);
        expect(sequence.seq.get('a')).toBe(3);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `corepack pnpm exec vitest run packages/client/src/app/recent-workspaces.test.ts`
Expected: FAIL — cannot resolve `./recent-workspaces`.

- [ ] **Step 3: Implement**

```ts
/**
 * The order ⌃Tab walks: the active workspace, then every other local workspace by the daemon's
 * `lastAccessedAt`, newest first (docs/superpowers/specs/2026-10-05-recent-workspace-switcher-design.md).
 */

export interface RecentCandidate {
    readonly id: string;
    /** Epoch SECONDS, as the daemon stores it. Anything that is not a finite number sorts as 0. */
    readonly lastAccessedAt: unknown;
}

export interface ActivationSequence {
    note(id: string | null): void;
    readonly seq: ReadonlyMap<string, number>;
}

function stamp(candidate: RecentCandidate): number {
    const value = candidate.lastAccessedAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `candidates` in sidebar order, which is the last tie-break. */
export function recentWorkspaceOrder(
    candidates: readonly RecentCandidate[],
    activeID: string | null,
    localSeq: ReadonlyMap<string, number>
): string[] {
    const rest = candidates
        .map((candidate, sidebarIndex) => ({ candidate, sidebarIndex }))
        .filter(({ candidate }) => candidate.id !== activeID)
        .sort(
            (a, b) =>
                stamp(b.candidate) - stamp(a.candidate) ||
                (localSeq.get(b.candidate.id) ?? 0) - (localSeq.get(a.candidate.id) ?? 0) ||
                a.sidebarIndex - b.sidebarIndex
        )
        .map(({ candidate }) => candidate.id);
    const activeIsLocal = activeID !== null && candidates.some((candidate) => candidate.id === activeID);
    return activeIsLocal ? [activeID, ...rest] : rest;
}

/**
 * This window's own activation order. `lastAccessedAt` is whole seconds, so two switches inside
 * one second tie; the later one this window saw wins.
 */
export function createActivationSequence(): ActivationSequence {
    const seq = new Map<string, number>();
    let last: string | null = null;
    let counter = 0;
    return {
        note(id) {
            if (id === null || id === last) return;
            last = id;
            counter += 1;
            seq.set(id, counter);
        },
        seq
    };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `corepack pnpm exec vitest run packages/client/src/app/recent-workspaces.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/app/recent-workspaces.ts packages/client/src/app/recent-workspaces.test.ts
git commit -m "Order workspaces for the recent switcher: active first, then by last access"
```

---

### Task 3: The gesture state machine

**Files:**
- Create: `packages/client/src/app/recent-switcher.ts`
- Test: `packages/client/src/app/recent-switcher.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 directly (the order arrives through `deps.order`).
- Produces:
  - `type HeldModifier = 'ctrl' | 'alt' | 'meta'`
  - `interface ModifierSnapshot { readonly ctrlKey: boolean; readonly altKey: boolean; readonly metaKey: boolean }`
  - `interface SwitcherState { readonly order: readonly string[]; readonly index: number; readonly shown: boolean }`
  - `const SWITCHER_SHOW_DELAY_MS = 150`
  - `heldModifiersFromEvent(event: ModifierSnapshot): HeldModifier[]`
  - `createRecentSwitcher(deps: RecentSwitcherDeps): RecentSwitcher` with
    `RecentSwitcherDeps { order(): readonly string[]; commit(id: string): void; onChange(state: SwitcherState | null): void; setTimer?(fn: () => void, ms: number): unknown; clearTimer?(handle: unknown): void }` and
    `RecentSwitcher { step(direction: 1 | -1, held: readonly HeldModifier[], options?: { readonly showNow?: boolean }): boolean; keyUp(modifiers: ModifierSnapshot): void; cancel(): boolean; blur(): void; pick(id: string): void; state(): SwitcherState | null }`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    SWITCHER_SHOW_DELAY_MS,
    createRecentSwitcher,
    heldModifiersFromEvent,
    type SwitcherState
} from './recent-switcher';

const up = { ctrlKey: false, altKey: false, metaKey: false };
const ctrlDown = { ctrlKey: true, altKey: false, metaKey: false };

function harness(order: readonly string[] = ['a', 'b', 'c', 'd']) {
    const commits: string[] = [];
    const states: (SwitcherState | null)[] = [];
    const switcher = createRecentSwitcher({
        order: () => order,
        commit: (id) => commits.push(id),
        onChange: (state) => states.push(state)
    });
    return { switcher, commits, states, last: () => states.at(-1) ?? null };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('recent switcher', () => {
    it('quick tap: commits the previous workspace and never shows', () => {
        const h = harness();
        expect(h.switcher.step(1, ['ctrl'])).toBe(true);
        h.switcher.keyUp(up);
        vi.advanceTimersByTime(SWITCHER_SHOW_DELAY_MS * 2);
        expect(h.commits).toEqual(['b']);
        expect(h.states.some((state) => state?.shown === true)).toBe(false);
        expect(h.switcher.state()).toBeNull();
    });

    it('hold: shows after the delay, steps, and commits on release', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        vi.advanceTimersByTime(SWITCHER_SHOW_DELAY_MS);
        expect(h.last()).toEqual({ order: ['a', 'b', 'c', 'd'], index: 1, shown: true });
        h.switcher.step(1, ['ctrl']);
        h.switcher.keyUp(ctrlDown); // the Tab keyup: ⌃ still down
        expect(h.commits).toEqual([]);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual(['c']);
        expect(h.last()).toBeNull();
    });

    it('repeat steps wrap in both directions', () => {
        const h = harness(['a', 'b', 'c']);
        h.switcher.step(1, ['ctrl']); // b
        h.switcher.step(1, ['ctrl']); // c
        h.switcher.step(1, ['ctrl']); // a (wrapped)
        expect(h.switcher.state()?.index).toBe(0);
        h.switcher.step(-1, ['ctrl']); // c (wrapped back)
        expect(h.switcher.state()?.index).toBe(2);
    });

    it('starting with ⌃⇧Tab starts on the least recent', () => {
        const h = harness();
        h.switcher.step(-1, ['ctrl']);
        expect(h.switcher.state()?.index).toBe(3);
    });

    it('Escape cancels without switching', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        expect(h.switcher.cancel()).toBe(true);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual([]);
        expect(h.switcher.cancel()).toBe(false);
    });

    it('window blur commits the highlighted row', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        h.switcher.step(1, ['ctrl']);
        h.switcher.blur();
        expect(h.commits).toEqual(['c']);
    });

    it('a picked row commits that row', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl']);
        h.switcher.pick('d');
        expect(h.commits).toEqual(['d']);
    });

    it('showNow paints at once (a gesture started from a web page)', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl'], { showNow: true });
        expect(h.last()?.shown).toBe(true);
    });

    it('fewer than two workspaces: not consumed, nothing happens', () => {
        const h = harness(['only']);
        expect(h.switcher.step(1, ['ctrl'])).toBe(false);
        expect(h.commits).toEqual([]);
        expect(h.switcher.state()).toBeNull();
    });

    it('a bare-key trigger has nothing to hold, so it commits at once', () => {
        const h = harness();
        h.switcher.step(1, []);
        expect(h.commits).toEqual(['b']);
        expect(h.switcher.state()).toBeNull();
    });

    it('rebound to ⌥Tab, releasing ⌃ does nothing and releasing ⌥ commits', () => {
        const h = harness();
        h.switcher.step(1, ['alt']);
        h.switcher.keyUp({ ctrlKey: false, altKey: true, metaKey: false });
        expect(h.commits).toEqual([]);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual(['b']);
    });

    it('a commit passes a vanished workspace ID through for the reducer to ignore', () => {
        const h = harness(['a', 'gone']);
        h.switcher.step(1, ['ctrl']);
        h.switcher.keyUp(up);
        expect(h.commits).toEqual(['gone']);
    });
});

describe('heldModifiersFromEvent', () => {
    it('reads ⌃ ⌥ ⌘ and ignores Shift', () => {
        expect(heldModifiersFromEvent({ ctrlKey: true, altKey: false, metaKey: true })).toEqual(['ctrl', 'meta']);
        expect(heldModifiersFromEvent(up)).toEqual([]);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `corepack pnpm exec vitest run packages/client/src/app/recent-switcher.test.ts`
Expected: FAIL — cannot resolve `./recent-switcher`.

- [ ] **Step 3: Implement**

```ts
/**
 * The ⌃Tab gesture (docs/superpowers/specs/2026-10-05-recent-workspace-switcher-design.md):
 * the first press snapshots the recent order and highlights the previous workspace, each further
 * press moves the highlight, and releasing the held modifiers commits. Framework-free so the
 * timing rules are unit-tested; `App.tsx` feeds it keydowns, keyups and window blur.
 */

export type HeldModifier = 'ctrl' | 'alt' | 'meta';

export interface ModifierSnapshot {
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
}

export interface SwitcherState {
    readonly order: readonly string[];
    readonly index: number;
    readonly shown: boolean;
}

/** A press released inside this window commits without the overlay ever painting. */
export const SWITCHER_SHOW_DELAY_MS = 150;

export interface RecentSwitcherDeps {
    order(): readonly string[];
    commit(workspaceID: string): void;
    onChange(state: SwitcherState | null): void;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(handle: unknown): void;
}

export interface RecentSwitcher {
    /** False when there is nothing to switch to, so the chord falls through to the pane. */
    step(direction: 1 | -1, held: readonly HeldModifier[], options?: { readonly showNow?: boolean }): boolean;
    keyUp(modifiers: ModifierSnapshot): void;
    /** True when a gesture was open (Escape belonged to it). */
    cancel(): boolean;
    blur(): void;
    pick(workspaceID: string): void;
    state(): SwitcherState | null;
}

/** The modifiers the gesture waits on: the trigger's own, minus Shift (which only picks direction). */
export function heldModifiersFromEvent(event: ModifierSnapshot): HeldModifier[] {
    const held: HeldModifier[] = [];
    if (event.ctrlKey) held.push('ctrl');
    if (event.altKey) held.push('alt');
    if (event.metaKey) held.push('meta');
    return held;
}

function isDown(modifier: HeldModifier, snapshot: ModifierSnapshot): boolean {
    if (modifier === 'ctrl') return snapshot.ctrlKey;
    if (modifier === 'alt') return snapshot.altKey;
    return snapshot.metaKey;
}

interface Gesture extends SwitcherState {
    readonly held: readonly HeldModifier[];
}

export function createRecentSwitcher(deps: RecentSwitcherDeps): RecentSwitcher {
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let gesture: Gesture | null = null;
    let timer: unknown = null;

    const snapshot = (): SwitcherState | null =>
        gesture === null ? null : { order: gesture.order, index: gesture.index, shown: gesture.shown };
    const publish = (): void => deps.onChange(snapshot());
    const end = (): void => {
        if (timer !== null) clearTimer(timer);
        timer = null;
        gesture = null;
        publish();
    };
    const commit = (workspaceID: string | undefined): void => {
        end();
        if (workspaceID !== undefined) deps.commit(workspaceID);
    };

    return {
        step(direction, held, options) {
            const showNow = options?.showNow === true;
            if (gesture === null) {
                const order = deps.order();
                if (order.length < 2) return false;
                const index = direction === 1 ? 1 : order.length - 1;
                if (held.length === 0) {
                    commit(order[index]);
                    return true;
                }
                gesture = { order, index, shown: showNow, held };
                if (!showNow) {
                    timer = setTimer(() => {
                        timer = null;
                        if (gesture === null) return;
                        gesture = { ...gesture, shown: true };
                        publish();
                    }, SWITCHER_SHOW_DELAY_MS);
                }
                publish();
                return true;
            }
            const count = gesture.order.length;
            gesture = { ...gesture, index: (gesture.index + direction + count) % count, shown: gesture.shown || showNow };
            publish();
            return true;
        },
        keyUp(modifiers) {
            if (gesture === null) return;
            if (gesture.held.some((modifier) => isDown(modifier, modifiers))) return;
            commit(gesture.order[gesture.index]);
        },
        cancel() {
            if (gesture === null) return false;
            end();
            return true;
        },
        blur() {
            if (gesture !== null) commit(gesture.order[gesture.index]);
        },
        pick(workspaceID) {
            if (gesture !== null) commit(workspaceID);
        },
        state: snapshot
    };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `corepack pnpm exec vitest run packages/client/src/app/recent-switcher.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/app/recent-switcher.ts packages/client/src/app/recent-switcher.test.ts
git commit -m "Add the ⌃Tab gesture state machine: step, show after 150 ms, commit on release"
```

---

### Task 4: The switcher overlay

**Files:**
- Create: `packages/client/src/chrome/RecentWorkspaceSwitcher.tsx`
- Test: `packages/client/src/chrome/RecentWorkspaceSwitcher.test.tsx`

**Interfaces:**
- Consumes: `useModalPresence` (`./modal-presence`), `workspaceColorHex`, `withAlpha`, `ChromeBucket` (`./theme`), `tokens` (`./tokens`), `WorkspaceColor` (`@kelpi/daemon/store`).
- Produces: `RecentWorkspaceSwitcher(props: { rows: readonly RecentSwitcherRow[]; index: number; bucket?: ChromeBucket; onPick(id: string): void })`, `interface RecentSwitcherRow { readonly id: string; readonly name: string; readonly color: WorkspaceColor | null }`. DOM contract for the scenario: `[data-testid="recent-switcher"]`, rows `[data-testid="recent-switcher-row"][data-workspace-id][data-selected]`.

- [ ] **Step 1: Write the failing test**

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { modalPresenceCount } from './modal-presence';
import { RecentWorkspaceSwitcher } from './RecentWorkspaceSwitcher';

afterEach(cleanup);

const rows = [
    { id: 'a', name: 'kelpi', color: null },
    { id: 'b', name: 'OrderingPlatform', color: 'blue' as const },
    { id: 'c', name: 'scratch', color: null }
];

describe('RecentWorkspaceSwitcher', () => {
    it('lists every row in order and marks the highlighted one', () => {
        render(<RecentWorkspaceSwitcher rows={rows} index={1} onPick={() => {}} />);
        const rendered = screen.getAllByTestId('recent-switcher-row');
        expect(rendered.map((row) => row.textContent)).toEqual(['kelpi', 'OrderingPlatform', 'scratch']);
        expect(rendered.map((row) => row.getAttribute('data-selected'))).toEqual(['false', 'true', 'false']);
    });

    it('picks a clicked row', () => {
        const onPick = vi.fn();
        render(<RecentWorkspaceSwitcher rows={rows} index={1} onPick={onPick} />);
        fireEvent.click(screen.getAllByTestId('recent-switcher-row')[2]!);
        expect(onPick).toHaveBeenCalledWith('c');
    });

    it('counts as a modal while mounted, so a live web page is parked', () => {
        const before = modalPresenceCount();
        const { unmount } = render(<RecentWorkspaceSwitcher rows={rows} index={1} onPick={() => {}} />);
        expect(modalPresenceCount()).toBe(before + 1);
        unmount();
        expect(modalPresenceCount()).toBe(before);
    });

    it('takes keyboard focus so the release reaches the window', () => {
        render(<RecentWorkspaceSwitcher rows={rows} index={1} onPick={() => {}} />);
        expect(document.activeElement).toBe(screen.getByTestId('recent-switcher'));
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `corepack pnpm exec vitest run packages/client/src/chrome/RecentWorkspaceSwitcher.test.tsx`
Expected: FAIL — cannot resolve `./RecentWorkspaceSwitcher`.

- [ ] **Step 3: Implement**

```tsx
/**
 * The ⌃Tab switcher: recent workspaces, the highlighted one in the palette's selection band.
 * Keys are not handled here — the gesture lives in `app/recent-switcher.ts` and reaches this
 * through props — but it takes focus and registers modal presence: a live web page is parked
 * while it is up, which hands the keyboard (and so the ⌃ release) back to the window.
 */

import type { WorkspaceColor } from '@kelpi/daemon/store';
import { useLayoutEffect, useRef, type ReactElement } from 'react';

import { useModalPresence } from './modal-presence';
import { withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

export interface RecentSwitcherRow {
    readonly id: string;
    readonly name: string;
    readonly color: WorkspaceColor | null;
}

export interface RecentWorkspaceSwitcherProps {
    readonly rows: readonly RecentSwitcherRow[];
    readonly index: number;
    readonly bucket?: ChromeBucket | undefined;
    onPick(workspaceID: string): void;
}

export function RecentWorkspaceSwitcher(props: RecentWorkspaceSwitcherProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const panelRef = useRef<HTMLDivElement>(null);
    useModalPresence(true);
    useLayoutEffect(() => {
        panelRef.current?.focus();
    }, []);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'transparent' }}>
            <div
                ref={panelRef}
                tabIndex={-1}
                data-testid="recent-switcher"
                role="listbox"
                aria-label="Recent workspaces"
                className="w-[320px] overflow-hidden rounded-[10px] py-1 outline-none"
                style={{ background: tokens.surfaceBackground, boxShadow: '0 4px 12px rgba(0,0,0,0.25)', color: tokens.textPrimary }}
            >
                {props.rows.map((row, rowIndex) => {
                    const selected = rowIndex === props.index;
                    return (
                        <button
                            key={row.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-testid="recent-switcher-row"
                            data-workspace-id={row.id}
                            data-selected={selected ? 'true' : 'false'}
                            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
                            style={{ background: selected ? withAlpha(tokens.accent, 0.2) : 'transparent' }}
                            onClick={() => props.onPick(row.id)}
                        >
                            <span
                                aria-hidden
                                className="h-[8px] w-[8px] shrink-0 rounded-full"
                                style={{ background: workspaceColorHex(row.color, bucket) }}
                            />
                            <span className="truncate text-[13px]">{row.name}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
```

The colour dot has `aria-hidden` and no text, so `textContent` is just the name, which is what the test asserts.

- [ ] **Step 4: Run it to verify it passes**

Run: `corepack pnpm exec vitest run packages/client/src/chrome/RecentWorkspaceSwitcher.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/chrome/RecentWorkspaceSwitcher.tsx packages/client/src/chrome/RecentWorkspaceSwitcher.test.tsx
git commit -m "Add the recent workspace switcher overlay"
```

---

### Task 5: Wire it into the app, and prove it in a real window

**Files:**
- Modify: `packages/client/src/App.tsx` (imports; state and machine after `act` at ~line 1577; `keyActions` at ~line 3151; an Escape/keyup/blur effect beside the dispatcher effect at ~line 3275; render beside `HelpOverlay` at ~line 5065)
- Create: `scripts/scenarios/recent-workspace-switcher.mjs`

**Interfaces:**
- Consumes: Task 2 `recentWorkspaceOrder`, `createActivationSequence`; Task 3 `createRecentSwitcher`, `heldModifiersFromEvent`, `SwitcherState`; Task 4 `RecentWorkspaceSwitcher`; existing `act.activateWorkspace(id)`, `selectSidebarWorkspaceIDs`, `selectWorkspace`, `selectActiveWorkspaceID`, `selectActiveWorkspace`, `selectFocusedPaneID`, `handBackPaneCaret`, `bucket`.
- Produces: end-to-end behaviour; the DOM contract from Task 4.

- [ ] **Step 1: Write the failing scenario**

`scripts/scenarios/recent-workspace-switcher.mjs`:

```js
/**
 * ⌃Tab switches workspaces in most-recently-used order: a quick tap toggles between the last two,
 * holding ⌃ shows the switcher and each Tab steps further back, Escape cancels.
 * docs/superpowers/specs/2026-10-05-recent-workspace-switcher-design.md
 */
import { MOD } from '../ui-audit/lib/cdp.mjs';

export const covers = [
    'packages/client/src/app/recent-switcher.ts',
    'packages/client/src/app/recent-workspaces.ts',
    'packages/client/src/chrome/RecentWorkspaceSwitcher.tsx',
    'packages/client/src/App.tsx'
];

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    const created = [];
    const active = async () => JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((w) => w.is_active === true)?.id ?? null;
    const control = (type) =>
        page.send('Input.dispatchKeyEvent', {
            type,
            code: 'ControlLeft',
            key: 'Control',
            windowsVirtualKeyCode: 17,
            nativeVirtualKeyCode: 17,
            modifiers: type === 'keyUp' ? 0 : MOD.ctrl
        });
    const tab = (shift = false) => page.key('Tab', { modifiers: MOD.ctrl | (shift ? MOD.shift : 0) });
    const switcherShown = () => page.eval(`document.querySelector('[data-testid="recent-switcher"]') !== null`);
    const visit = async (id) => {
        await page.eval(`document.querySelector('[data-workspace-id="${id}"]')?.click()`);
        await d.settle(async () => (await active()) === id);
    };
    try {
        for (const name of ['MRU A', 'MRU B', 'MRU C']) {
            created.push(JSON.parse(await cli.ok(['workspace', 'create', '--name', name, '--path', sandbox.root, '--json'])).workspace_id);
        }
        const [a, b, c] = created;
        for (const id of [a, b, c]) await visit(id);

        // Quick tap: C -> B, no overlay.
        await control('rawKeyDown');
        await tab();
        await control('keyUp');
        rec.check('a quick ⌃Tab goes to the previous workspace', await d.settle(async () => (await active()) === b));
        rec.check('a quick ⌃Tab never shows the switcher', (await switcherShown()) === false);

        // Tap again: B -> C (toggle).
        await control('rawKeyDown');
        await tab();
        await control('keyUp');
        rec.check('a second quick ⌃Tab toggles back', await d.settle(async () => (await active()) === c));

        // Hold: C, [B, A] -> two steps lands on A.
        await control('rawKeyDown');
        await tab();
        await sleep(300);
        rec.check('holding ⌃ shows the switcher', await switcherShown());
        await rec.shot(page, 'switcher-held');
        await tab();
        await control('keyUp');
        rec.check('two Tabs while held land two workspaces back', await d.settle(async () => (await active()) === a));
        rec.check('the switcher closes on release', await d.settle(async () => (await switcherShown()) === false));

        // Escape mid-hold: nothing switches.
        await control('rawKeyDown');
        await tab();
        await sleep(300);
        await page.key('Escape', { modifiers: MOD.ctrl });
        await control('keyUp');
        await sleep(300);
        rec.check('Escape cancels the gesture', (await active()) === a && (await switcherShown()) === false);
    } finally {
        for (const id of created) await cli.ok(['workspace', 'delete', id, '--force']).catch(() => {});
    }
}
```

Before running: confirm the session object returned by `scripts/ui-audit/lib/cdp.mjs` exposes `send` (it is listed in the returned object near line 171) and that sidebar rows carry `data-workspace-id` (`grep -rn "data-workspace-id" packages/client/src/chrome`); if the attribute differs, use the one the sidebar renders.

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/scenario.mjs --window offscreen recent-workspace-switcher`
Expected: FAIL on "a quick ⌃Tab goes to the previous workspace" (⌃Tab is bound but has no handler, so it falls through).

- [ ] **Step 3: Implement the wiring in `App.tsx`**

Imports (with the other `./app/*` and `./chrome/*` imports):

```ts
import { createRecentSwitcher, heldModifiersFromEvent, type SwitcherState } from './app/recent-switcher';
import { createActivationSequence, recentWorkspaceOrder } from './app/recent-workspaces';
import { RecentWorkspaceSwitcher } from './chrome/RecentWorkspaceSwitcher';
```

(`selectSidebarWorkspaceIDs`, `selectWorkspace`, `selectActiveWorkspaceID` come from `./state/selectors`; add any that the file does not already import.)

After the `act` `useMemo` (~line 1577):

```ts
    // ⌃Tab (docs/superpowers/specs/2026-10-05-recent-workspace-switcher-design.md). The activation
    // sequence breaks same-second ties in the daemon's `lastAccessedAt`.
    const activationSequenceRef = useRef(createActivationSequence());
    useEffect(() => {
        const note = (): void => activationSequenceRef.current.note(selectActiveWorkspaceID(store.getState()));
        note();
        return store.subscribe(note);
    }, [store]);
    const [recentSwitcher, setRecentSwitcher] = useState<SwitcherState | null>(null);
    const switcher = useMemo(
        () =>
            createRecentSwitcher({
                order: () => {
                    const state = store.getState();
                    const candidates = selectSidebarWorkspaceIDs(state).flatMap((id) => {
                        const workspace = selectWorkspace(state, id);
                        return workspace === null ? [] : [{ id, lastAccessedAt: workspace.lastAccessedAt }];
                    });
                    return recentWorkspaceOrder(candidates, selectActiveWorkspaceID(state), activationSequenceRef.current.seq);
                },
                commit: (id) => {
                    act.activateWorkspace(id);
                },
                onChange: setRecentSwitcher
            }),
        [store, act]
    );
    /** A gesture started from a web page paints at once: the page holds the keyboard until it is parked. */
    const focusedPaneIsWeb = (): boolean => {
        const state = store.getState();
        const paneID = selectFocusedPaneID(state);
        return selectActiveWorkspace(state)?.panes.some((pane) => pane.id === paneID && pane.type === 'web') ?? false;
    };
```

In `keyActions`, after `previous_workspace`:

```ts
            next_recent_workspace: ({ event }) => switcher.step(1, heldModifiersFromEvent(event), { showNow: focusedPaneIsWeb() }),
            previous_recent_workspace: ({ event }) =>
                switcher.step(-1, heldModifiersFromEvent(event), { showNow: focusedPaneIsWeb() }),
```

A new effect beside the dispatcher's. Escape is handled HERE, not through the dispatcher's
`onEscape`: that hook only runs for an Escape with no modifiers (`keys.ts` step 2), and during the
gesture ⌃ is still down, so the press is ⌃Escape.

```ts
    // The gesture ends on the RELEASE of its modifiers, on Escape (with ⌃ still held), or on the
    // window losing focus (a keyup that happens while another app is frontmost is never delivered).
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.code !== 'Escape' || !switcher.cancel()) return;
            event.preventDefault();
            event.stopPropagation();
            handBackPaneCaret(selectFocusedPaneID(store.getState()));
        };
        const onKeyUp = (event: KeyboardEvent): void => switcher.keyUp(event);
        const onBlur = (): void => switcher.blur();
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', onBlur);
        };
    }, [switcher, store, handBackPaneCaret]);
```

Render, immediately before `{helpOpen ? (`:

```tsx
            {recentSwitcher?.shown === true ? (
                <RecentWorkspaceSwitcher
                    rows={recentSwitcher.order.flatMap((id) => {
                        const workspace = selectWorkspace(store.getState(), id);
                        return workspace === null ? [] : [{ id, name: workspace.name, color: workspace.color }];
                    })}
                    index={recentSwitcher.index}
                    bucket={bucket}
                    onPick={(id) => switcher.pick(id)}
                />
            ) : null}
```

- [ ] **Step 4: Typecheck, unit suites, and the scenario**

Run: `corepack pnpm typecheck`
Expected: exit 0.

Run: `corepack pnpm exec vitest run packages/client`
Expected: PASS.

Run: `corepack pnpm --filter @kelpi/client build && node scripts/scenario.mjs --no-build --window offscreen recent-workspace-switcher`
Expected: every check `ok`. Open the `switcher-held` screenshot and confirm the overlay lists MRU C / MRU B / MRU A / Default with MRU A highlighted after the second Tab (the shot is taken after one Tab, so MRU B is highlighted there).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/App.tsx scripts/scenarios/recent-workspace-switcher.mjs
git commit -m "Switch workspaces in recent order on ⌃Tab, with a switcher while ⌃ is held"
```

---

### Task 6: Starting the gesture from a web pane

**Files:**
- Modify: `scripts/scenarios/recent-workspace-switcher.mjs` (append a web-pane block)
- Possibly modify: `packages/client/src/app/recent-switcher.ts`, its test, and `App.tsx` (Step 4, only if Step 2 fails)

**Interfaces:**
- Consumes: Task 5's wiring; `waitForPageTarget`, `connect`, `MOD` from `scripts/ui-audit/lib/cdp.mjs`.

- [ ] **Step 1: Add the web-pane checks to the scenario**

Append inside the `try`, after the Escape block (with `waitForPageTarget, connect` added to the import from `../ui-audit/lib/cdp.mjs`):

```js
        // From a focused web page: the chord reaches the window through the shell's relay, and
        // the switcher must take the keyboard so the ⌃ release is seen.
        await cli.ok(['web', 'open', '--focus', 'data:text/html,<title>mru-web</title><input autofocus>']);
        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.title === 'mru-web', timeoutMs: 15_000 });
        const web = await connect(target.webSocketDebuggerUrl);
        try {
            const webControl = (type) =>
                web.send('Input.dispatchKeyEvent', {
                    type,
                    code: 'ControlLeft',
                    key: 'Control',
                    windowsVirtualKeyCode: 17,
                    nativeVirtualKeyCode: 17,
                    modifiers: type === 'keyUp' ? 0 : MOD.ctrl
                });
            await webControl('rawKeyDown');
            await web.key('Tab', { modifiers: MOD.ctrl });
            rec.check('⌃Tab from a web page opens the switcher at once', await d.settle(switcherShown, { ceilingMs: 2000 }));
            // The page is parked now, so the rest of the gesture is the window's.
            await control('keyUp');
            rec.check('releasing ⌃ after starting in a web page switches', await d.settle(async () => (await active()) === c));
        } finally {
            await web.close?.();
        }
```

Rationale for the expected destination: before this block the active workspace is A (Escape left it there); `web open` adds the page to A, so the order is A, C, B, …, and one step lands on C.

- [ ] **Step 2: Run it**

Run: `node scripts/scenario.mjs --no-build --window offscreen recent-workspace-switcher`
Expected: all checks `ok`. If both web checks pass, skip to Step 5.

- [ ] **Step 3: If "opens the switcher at once" fails** — the relay did not deliver ⌃Tab. Check `packages/shell/src/webhost/keys.ts` `forwardedChord`/`claimedChords` with a log line; a `ctrl+tab` chord should be claimed because it carries ⌃ and is in the binding map. Fix there, add a unit test beside `keys.ts`'s existing tests asserting `ctrl+tab` is claimed, rebuild the shell (`corepack pnpm --filter @kelpi/shell build`), rerun.

- [ ] **Step 4: If "releasing ⌃ … switches" fails** (the overlay opened but the window never saw the release), add the spec's fallback: commit after 400 ms with no further step, only for gestures started with `showNow`.

Test, added to `recent-switcher.test.ts`:

```ts
    it('a gesture started from a web page commits after 400 ms with no further step', () => {
        const h = harness();
        h.switcher.step(1, ['ctrl'], { showNow: true });
        vi.advanceTimersByTime(399);
        expect(h.commits).toEqual([]);
        h.switcher.step(1, ['ctrl'], { showNow: true });
        vi.advanceTimersByTime(399);
        expect(h.commits).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(h.commits).toEqual(['c']);
    });
```

Implementation in `recent-switcher.ts`: export `const WEB_IDLE_COMMIT_MS = 400;`, and in `step`, when `showNow` is true, (re)arm the timer to commit instead of to show:

```ts
const armIdleCommit = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
        timer = null;
        if (gesture !== null) commit(gesture.order[gesture.index]);
    }, WEB_IDLE_COMMIT_MS);
};
```

called at the end of both branches of `step` when `showNow` is true (and the show timer is not armed in that case). Rerun Task 3's tests and the scenario; then change the scenario's second web check to `await sleep(500)` before asserting instead of sending the release.

- [ ] **Step 5: Commit**

```bash
git add scripts/scenarios/recent-workspace-switcher.mjs packages/client/src/app packages/shell/src/webhost
git commit -m "Cover ⌃Tab started from a web page"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/config-keybindings.md` (§4 intro count, §4 Workspaces table, §5.2 heading and block, new §7.8)

- [ ] **Step 1: Edit**

§4 intro: `63 bindable actions` → `65 bindable actions`.

§4 "Workspaces" table, after the `previous_workspace` row:

```markdown
| `next_recent_workspace` | Next Recent Workspace | ⌃Tab | monitor (hold-and-release gesture, §7.8) |
| `previous_recent_workspace` | Previous Recent Workspace | ⌃⇧Tab | monitor (hold-and-release gesture, §7.8) |
```

§5.2: heading `(47 triggers)` → `(49 triggers)`; add to the block:

```
ctrl+tab=next_recent_workspace       ctrl+shift+tab=previous_recent_workspace
```

New section after the last §7 subsection (number it after the last existing one; `§7.8` if §7.7 is the last):

```markdown
### 7.8 The recent-workspace gesture (⌃Tab)

`next_recent_workspace` / `previous_recent_workspace` are the one place a binding acts on a key
RELEASE (`app/recent-switcher.ts`). The first press snapshots the local workspaces — active first,
then by the daemon's `lastAccessedAt` (seconds; same-second ties by this window's own activation
order, then sidebar order) — and highlights the previous one (`previous_…` starts on the least
recent). Further presses move the highlight, wrapping. Releasing every non-Shift modifier of the
trigger commits; Escape cancels and hands the caret back; window blur commits; clicking a row
commits it. The switcher paints only after 150 ms, so a quick ⌃Tab toggles the last two
workspaces with no flash. With fewer than two local workspaces the chord is not consumed.

From a focused web page the chord arrives through the shell's relay (`webhost/keys.ts`) and the
switcher paints at once; it registers modal presence, which parks the page and gives the window
the keyboard, so the release is seen.

⌃Tab is no longer delivered to terminal programs (kitty keyboard protocol apps read it).
`keybind = ctrl+tab=unbind` and `keybind = ctrl+shift+tab=unbind` give it back.
```

If Task 6 Step 4 was needed, replace the second paragraph's last clause with: "…but a page keeps the keyboard, so a gesture started there commits 400 ms after its last step."

- [ ] **Step 2: Commit**

```bash
git add docs/config-keybindings.md
git commit -m "Document the ⌃Tab recent-workspace gesture"
```

---

### Task 8: Verify the branch

- [ ] **Step 1: Run the impact-mapped battery**

Run: `node scripts/verify.mjs --since origin/main`
Expected: green. A failure in a component this branch did not touch must be checked against `origin/main` before it is called pre-existing.

- [ ] **Step 2: Note the result** for the PR description (components run, counts, any retries).
