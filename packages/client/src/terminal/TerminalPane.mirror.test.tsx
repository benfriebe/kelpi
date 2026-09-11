/**
 * #166 — a pane that does not own PTY sizing MIRRORS the owner's grid.
 *
 * The defect. PTY geometry follows exactly ONE client (`sizeOwnerID`,
 * `daemon/src/ws/sync.ts:1320`; terminal-surface.md §5.1). Every other attached client is fed a
 * stream the daemon's emulator wrapped at the OWNER's column count, and re-seeded by a snapshot
 * serialised at that count — with no newline between a soft-wrapped row and its continuation,
 * because `@xterm/addon-serialize` leaves it out on the promise that the replaying terminal wraps
 * at the same column. An engine at any other width lays the two halves side by side on one row:
 * fixed-stride fragments at the owner's width, reproduced by every later replay, which is the
 * steady-state screenshot in #165. `kelpi pane capture` reads clean throughout, because the
 * daemon's own grid was never the problem.
 *
 * The fix, and what these pin. The replay now states the grid it was serialised at
 * (`replayGrid`, `protocol/src/ws/pty.ts`), and a non-owner pane resizes its engine to that grid
 * BEFORE applying the bytes. The engine sizes its own canvas from cols×rows
 * (`vendor/ghostty-web-patched`, no ResizeObserver), so the canvas letterboxes top-left inside a
 * bigger pane and is clipped by the pane's `overflow-hidden` in a smaller one — the owner's
 * screen, exactly, instead of a scramble of it. Three things must stay true while it does:
 * the pane keeps MEASURING and REPORTING its own box (the daemon caches it for an instant
 * takeover), it never reports the mirrored grid as if it were its own measurement, and the
 * moment this client takes size control the engine comes back to its own box.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_MIRROR_ATTRIBUTE, TerminalPane } from './TerminalPane';
import {
    createFakePtyApi,
    createFakeRendererFactory,
    installFakeResizeObserver,
    type FakePtyApi,
    type FakeRenderer,
    type FakeRendererFactory
} from './testing';

/** jsdom reports 0×0 for everything; the pane takes its box through this seam. */
const box = (width: number, height: number) => () => ({ width, height });

/** 10×20 cells, so a 1200×600 box is 120×30 and a 400×400 box is 40×20. */
const CELL = { width: 10, height: 20 };

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    observers = installFakeResizeObserver();
});

afterEach(() => {
    cleanup();
    observers.restore();
    vi.restoreAllMocks();
});

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

/**
 * Settle everything a MOUNT schedules, not just its microtasks.
 *
 * The pane re-measures at three honest moments after it comes up, and two of them are not
 * microtasks: `renderer.open().then(…)` calls `syncGeometry(true)` when the engine is live, and the
 * visibility effect calls it again from a `setTimeout(0)` "once layout settles". Both land on the
 * SAME grid the mount already measured, so they move nothing — but the fake records every `resize`
 * it is handed (the real renderer short-circuits an unchanged grid before it touches the engine),
 * and whether they are recorded before or after a test clears `screenLog` is load dependent. That
 * is a test race, not a product one, and this is where it is closed: every case below starts from a
 * pane that has finished measuring itself.
 */
async function settleMount(): Promise<void> {
    for (let turn = 0; turn < 3; turn += 1) {
        await act(async () => {
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

/**
 * Every grid the pane reported, with consecutive repeats collapsed.
 *
 * The fake stream handle records every `resize` call; the real `PtyClient` swallows one that
 * repeats the last grid it sent (`pty.ts` — `entry.geometryReported && entry.cols === …`), and the
 * pane calls `syncGeometry(true)` at a few honest moments (engine open, a late font, becoming
 * visible). Collapsing here keeps these tests about WHICH grids reached the daemon and in what
 * order, which is what #166 is about, rather than about that debounce.
 */
function reported(resizes: readonly { cols: number; rows: number; force?: boolean }[]): {
    cols: number;
    rows: number;
    force?: boolean;
}[] {
    const out: { cols: number; rows: number; force?: boolean }[] = [];
    for (const entry of resizes) {
        const last = out.at(-1);
        if (last !== undefined && last.cols === entry.cols && last.rows === entry.rows && last.force === entry.force) continue;
        out.push(entry);
    }
    return out;
}

/**
 * The engine's screen-moving calls with consecutive repeats collapsed.
 *
 * The fake records every `resize`, including one to the grid it already holds (the real renderer
 * short-circuits those before it touches the engine or opens a paint hold). The pane re-measures at
 * several honest moments whose timing is not fixed — the engine finishing `open()`, a late font,
 * becoming visible — so an exact log would be a record of how often it measured. Collapsing keeps
 * these tests about what the engine was MOVED to, and in what order, which is what #166 is about.
 */
function moves(renderer: FakeRenderer): string[] {
    return renderer.screenLog.filter((entry, index, all) => entry !== all[index - 1]);
}

/**
 * `moves`, minus every resize to the pane's OWN measured grid.
 *
 * Belt and braces with `settleMount`, for the cases whose claim is "the engine was not moved to
 * somebody else's grid": a re-measure of the pane's own box moves nothing, the real renderer
 * short-circuits it before it reaches the engine, and no case below is about how many times the
 * pane measured. A case that is about the own-box move — the takeover — reads `moves` instead.
 */
function movesOffOwnBox(renderer: FakeRenderer, own: string): string[] {
    return moves(renderer).filter((entry) => entry !== `resize ${own}`);
}

interface Mounted {
    readonly pty: FakePtyApi;
    readonly renderers: FakeRendererFactory;
    readonly root: HTMLElement;
    /** Re-render with different props (size control changing hands, a different box). */
    update(props: {
        ownsSize?: boolean;
        visible?: boolean;
        measure?: () => { width: number; height: number };
    }): Promise<void>;
}

async function mount(
    props: { ownsSize?: boolean; width?: number; height?: number; visible?: boolean } = {}
): Promise<Mounted> {
    const pty = createFakePtyApi();
    const renderers = createFakeRendererFactory({ cell: CELL });
    const base = {
        paneID: 'pane-1',
        ptyApi: pty,
        focused: false,
        visible: props.visible ?? true,
        createRenderer: renderers.factory,
        measure: box(props.width ?? 1200, props.height ?? 600),
        ...(props.ownsSize === undefined ? {} : { ownsSize: props.ownsSize })
    };
    const view = render(<TerminalPane {...base} />);
    await settleMount();
    return {
        pty,
        renderers,
        root: view.container.querySelector('[data-pane-id]') as HTMLElement,
        async update(next): Promise<void> {
            view.rerender(<TerminalPane {...base} {...next} />);
            await settle();
        }
    };
}

describe('a non-owner mirrors the owner grid the replay states (#166)', () => {
    it('resizes the engine to the replay grid BEFORE the snapshot is applied', async () => {
        const mounted = await mount({ ownsSize: false, width: 1200, height: 600 });
        const renderer = mounted.renderers.last();
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        renderer.screenLog.length = 0;

        // The owner's window is 73×19. The snapshot is only parseable at 73 columns.
        mounted.pty.last().replay('owner-width-screen', { cols: 73, rows: 19 });
        await settle();

        // Order, not just outcome: a resize AFTER the reset would re-wrap what it had painted.
        expect(movesOffOwnBox(renderer, '120x30')).toEqual(['resize 73x19', 'reset', 'write']);
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 73, rows: 19 });
        expect(renderer.writes.join('')).toBe('owner-width-screen');
    });

    it('publishes the mirrored grid so what is on the canvas is observable', async () => {
        const mounted = await mount({ ownsSize: false });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBeNull();

        mounted.pty.last().replay('screen', { cols: 73, rows: 19 });
        await settle();

        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('73x19');
    });

    it('never reports the mirrored grid back as its own measurement', async () => {
        // The daemon caches what a client reports so a takeover can apply the taker's real layout
        // in one step (`applyCachedSizes`). A pane that echoed the owner's grid back would have
        // told the daemon the owner's window was its own, and a takeover would then resize every
        // pane to the window the user just took control AWAY from.
        const mounted = await mount({ ownsSize: false, width: 1200, height: 600 });
        mounted.pty.last().replay('screen', { cols: 73, rows: 19 });
        await settle();

        expect(reported(mounted.pty.last().resizes)).toEqual([{ cols: 120, rows: 30 }]);
        expect(mounted.pty.last().resizes.some((entry) => entry.cols === 73)).toBe(false);
    });

    it('keeps measuring and reporting its own box, without moving the engine off the mirror', async () => {
        const mounted = await mount({ ownsSize: false, width: 1200, height: 600 });
        const renderer = mounted.renderers.last();
        mounted.pty.last().replay('screen', { cols: 73, rows: 19 });
        await settle();
        renderer.screenLog.length = 0;

        // The viewer's own window shrinks. The daemon hears about it (that report is the takeover
        // cache, and it is what asks for this viewer's own fresh snapshot — `requestReplay`), and
        // the engine does NOT follow it: the bytes on this stream are still the owner's.
        await mounted.update({ measure: box(400, 400) });
        await act(async () => {
            observers.trigger();
            await Promise.resolve();
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
        });

        expect(reported(mounted.pty.last().resizes)).toEqual([
            { cols: 120, rows: 30 },
            { cols: 40, rows: 20 }
        ]);
        expect(movesOffOwnBox(renderer, '120x30')).toEqual([]);
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 73, rows: 19 });
        // …and the attribute still says what is on the canvas, not what was measured.
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('73x19');
    });

    it('mirrors a grid WIDER than its own box too (the narrow viewer)', async () => {
        // The letterbox has two directions. A viewer narrower than the owner cannot show every
        // column, and the honest answer is the owner's screen clipped at this pane's edge (the
        // engine draws cols×rows and the pane root is `overflow-hidden`), because the alternative
        // is the one thing the issue forbids: re-wrapping the owner's rows. The escape hatch is
        // the `take-size-control` chip, which the next test is about.
        const mounted = await mount({ ownsSize: false, width: 400, height: 400 });
        const renderer = mounted.renderers.last();
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 40, rows: 20 });

        mounted.pty.last().replay('wide-owner-screen', { cols: 120, rows: 30 });
        await settle();

        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('120x30');
    });
});

describe('size control changing hands (#166)', () => {
    it('taking it returns the engine to its own box and claims the PTY', async () => {
        const mounted = await mount({ ownsSize: false, width: 1200, height: 600 });
        const renderer = mounted.renderers.last();
        mounted.pty.last().replay('owner-width-screen', { cols: 73, rows: 19 });
        await settle();
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 73, rows: 19 });
        renderer.screenLog.length = 0;

        // The chip: `take-size-control` goes to the daemon, the daemon broadcasts, the store
        // updates, and this prop turns true.
        await mounted.update({ ownsSize: true });

        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        expect(moves(renderer)).toEqual(['resize 120x30']);
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBeNull();
        // Re-sent even though the daemon has been told these numbers all along as a cached
        // non-owner: the claim has to reach the PTY, and without `force` the client's own
        // unchanged-geometry short circuit swallows it. (The report the re-measure behind it makes
        // is the one the real `PtyClient` swallows on exactly that rule; the fake has no short
        // circuit, which is why this asks whether the CLAIM was made rather than for a full list.)
        expect(
            mounted.pty.last().resizes.some((entry) => entry.force === true && entry.cols === 120 && entry.rows === 30)
        ).toBe(true);
        expect(mounted.pty.last().resizes.some((entry) => entry.cols === 73)).toBe(false);
    });

    it('losing it adopts the new owner grid on the next replay, not before', async () => {
        const mounted = await mount({ ownsSize: true, width: 1200, height: 600 });
        const renderer = mounted.renderers.last();
        renderer.screenLog.length = 0;

        // Another window took control. Nothing happens to this engine yet — the grid it would
        // adopt has not been sent, and resizing to a grid whose contents nobody has replayed is
        // the state §N24's paint hold exists to hide.
        await mounted.update({ ownsSize: false });
        // Still its own box, nothing mirrored. (Not "the log is empty": the pane re-measures at a
        // few honest moments of its own — the engine finishing `open()`, a late font — and any of
        // those may land here under load. What must NOT have happened is a resize to a grid the
        // daemon has not sent the contents of.)
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        expect(moves(renderer)).not.toContain('resize 73x19');
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBeNull();
        renderer.screenLog.length = 0;

        // The taker's grid reached the daemon's emulator, which is a grid CHANGE, which arms the
        // settled-resize resync for every attached client. This is that replay.
        mounted.pty.last().replay('the-new-owners-screen', { cols: 73, rows: 19 });
        await settle();

        expect(movesOffOwnBox(renderer, '120x30')).toEqual(['resize 73x19', 'reset', 'write']);
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('73x19');
    });
});

describe('taking size control when the pane cannot measure itself (#166)', () => {
    /*
     * The hole the first version of this fix left, and the reason the engine is moved by the
     * ownership effect itself rather than by `syncGeometry`.
     *
     * `syncGeometry` returns early for a pane that is not visible ("idle while hidden; the daemon
     * keeps draining the PTY") and for a box that measures zero. So a takeover in either state
     * cleared the mirror and left the engine on the EX-OWNER's grid, where nothing could move it:
     * `adoptReplayGrid` stops adopting the moment this client owns sizing, and the hand-off's own
     * resync replay - serialised at THIS client's grid - was then written into an engine still at
     * the old one. The #166 glue, on the owner's own pane, and steady: the next thing to touch the
     * engine was a reflow, and the report that would have asked for a fresh snapshot was swallowed
     * as "nothing moved".
     */
    it('moves the engine itself when the pane is HIDDEN', async () => {
        const mounted = await mount({ ownsSize: false, width: 1200, height: 600, visible: false });
        const renderer = mounted.renderers.last();
        // A hidden pane still measured its box at mount, which is what it owns a grid from.
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        mounted.pty.last().replay('owner-width-screen', { cols: 73, rows: 19 });
        await settle();
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 73, rows: 19 });

        await mounted.update({ ownsSize: true });

        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBeNull();
        expect(
            mounted.pty.last().resizes.some((entry) => entry.force === true && entry.cols === 120 && entry.rows === 30)
        ).toBe(true);
        // …and the next replay, taken at this client's grid now, is applied at this client's grid.
        mounted.pty.last().replay('my-own-width-screen', { cols: 120, rows: 30 });
        await settle();
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
    });

    it('keeps the mirror ARMED when there is no measurement to move to, and ends it on the first one', async () => {
        // The other half: a pane whose box has only ever measured zero has no grid of its own to go
        // back to. Clearing the mirror would be claiming the engine had moved when it had not - and
        // would let the next box change resize an engine whose replays are still the ex-owner's.
        const mounted = await mount({ ownsSize: false, width: 0, height: 0 });
        const renderer = mounted.renderers.last();
        mounted.pty.last().replay('owner-width-screen', { cols: 73, rows: 19 });
        await settle();
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 73, rows: 19 });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('73x19');

        await mounted.update({ ownsSize: true });
        // Still armed: the engine is where the bytes it is being sent were serialised.
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 73, rows: 19 });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('73x19');

        /*
         * And it keeps FOLLOWING the daemon while it is armed. The daemon does not stand still: the
         * takeover applied this client's cached geometry, which for a pane that never measured
         * anything is `attach-pane`'s 80x24 fallback, so the next snapshot is serialised at 80x24.
         * An engine left at the ex-owner's 73x19 would mis-parse it — the #166 glue, on this pane,
         * until some later measurement repaired it.
         */
        mounted.pty.last().replay('the-attach-fallback-screen', { cols: 80, rows: 24 });
        await settle();
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 80, rows: 24 });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('80x24');

        // The box finally measures. THAT is where the mirror ends and the engine comes back.
        await mounted.update({ ownsSize: true, measure: box(1200, 600) });
        await act(async () => {
            observers.trigger();
            await Promise.resolve();
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
        });

        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBeNull();
        expect(mounted.pty.last().resizes.some((entry) => entry.cols === 120 && entry.rows === 30)).toBe(true);
    });
});

describe('losing size control when the replay got there first (#166)', () => {
    it('asks for a fresh replay when the last one was applied at the wrong grid', async () => {
        /*
         * The race: the `size-control` broadcast updates the store immediately but reaches these
         * props one render later, and a big snapshot is applied in chunks across several tasks, so
         * the new owner's screen can be painted at THIS engine's grid before `ownsSize` turns
         * false. Nothing else would then repair it - the box has not moved, the daemon replays a
         * non-owner only on a changed grid, and a replay provokes no replay - so the pane asks,
         * once, with the one request the protocol has.
         */
        const mounted = await mount({ ownsSize: true, width: 1200, height: 600 });
        const renderer = mounted.renderers.last();

        // The taker's snapshot arrives while this client still believes it owns sizing.
        mounted.pty.last().replay('the-new-owners-screen', { cols: 73, rows: 19 });
        await settle();
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        const before = mounted.pty.last().resizes.length;

        // …and the broadcast lands a render later.
        await mounted.update({ ownsSize: false });

        const asked = mounted.pty.last().resizes.slice(before);
        expect(asked.some((entry) => entry.force === true && entry.cols === 120 && entry.rows === 30)).toBe(true);
        // Exactly one request, and never a poll: the effect runs on the transition only.
        expect(asked.filter((entry) => entry.force === true)).toHaveLength(1);

        // The replay that answers it carries the owner's grid, and the mirror is established.
        mounted.pty.last().replay('the-new-owners-screen', { cols: 73, rows: 19 });
        await settle();
        expect(moves(renderer)).toContain('resize 73x19');
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('73x19');
    });

    it('asks for nothing when the last replay and the engine already agree', async () => {
        // The ordinary hand-off: this client owned sizing, so the last snapshot was taken at its
        // own grid and the engine is at it. The daemon's settled resync is already on its way with
        // the new owner's grid, and asking would be a second snapshot for nothing.
        const mounted = await mount({ ownsSize: true, width: 1200, height: 600 });
        mounted.pty.last().replay('my-own-screen', { cols: 120, rows: 30 });
        await settle();
        const before = mounted.pty.last().resizes.length;

        await mounted.update({ ownsSize: false });

        expect(mounted.pty.last().resizes.slice(before).filter((entry) => entry.force === true)).toEqual([]);
    });
});

describe('the mirrored canvas is the mouse surface (#166)', () => {
    /** The engine's own node, where both engines put their canvas: an event here is one it would act on. */
    function engineOf(root: HTMLElement): HTMLElement {
        const host = root.querySelector('[data-terminal-host]') as HTMLElement;
        const engine = document.createElement('div');
        host.appendChild(engine);
        return engine;
    }

    const SGR_PRESS_INSIDE = '\u001b[<0;5;4M';

    it('drops a press in the letterbox background instead of clamping it to the last column', async () => {
        /*
         * The dead zone that types. `positionOutOfViewport` is "the pointer has LEFT the terminal"
         * and it reads `width`/`height`, which used to be the PANE BOX whatever the engine was at.
         * Under a mirror the canvas is 400px of an 800px box, so a click in the 400px of pane
         * background beside it was INSIDE the box, so it was not out of viewport, so it was clamped
         * to the last column and sent to the application as a click on a cell the user never
         * pointed at.
         */
        const mounted = await mount({ ownsSize: false, width: 800, height: 480 });
        const engine = engineOf(mounted.root);
        act(() => {
            mounted.pty.last().modes({ mouseTracking: 'vt200', mouseFormat: 'sgr' });
        });
        mounted.pty.last().replay('owner-width-screen', { cols: 40, rows: 12 });
        await settle();
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBe('40x12');

        // Inside the 40x12 canvas (400x240 px at a 10x20 cell): reported, as it always was.
        fireEvent.mouseDown(engine, { clientX: 45, clientY: 61, button: 0 });
        expect(mounted.pty.last().directInput).toEqual([SGR_PRESS_INSIDE]);

        // Beyond the canvas but inside the pane: not the terminal, so not a report. (1000/`vt200`
        // is the mode that shows it: outside the surface, only a motion-tracking mode with a
        // button held keeps reporting, which is what lets a drag continue off the pane.)
        fireEvent.mouseDown(engine, { clientX: 600, clientY: 61, button: 0 });
        fireEvent.mouseDown(engine, { clientX: 45, clientY: 400, button: 0 });
        expect(mounted.pty.last().directInput).toEqual([SGR_PRESS_INSIDE]);
    });

    it('leaves an un-mirrored pane measuring its own box, sub-cell remainder and all', async () => {
        /*
         * The guard on the other side, and the box is 805px wide for a reason: 80 columns of a 10px
         * cell is 800, so the last 5px are the sub-cell remainder every terminal pane has. A press
         * there is inside the pane's box and outside the grid, and it has always been reported
         * (clamped to the last column) — the extent is passed ONLY while mirroring precisely so that
         * stays true. At 800x480 the extent and the box are the same number and this case could not
         * fail; at 805 it reds the moment the extent is passed unconditionally.
         */
        const mounted = await mount({ ownsSize: true, width: 805, height: 480 });
        const engine = engineOf(mounted.root);
        act(() => {
            mounted.pty.last().modes({ mouseTracking: 'vt200', mouseFormat: 'sgr' });
        });

        fireEvent.mouseDown(engine, { clientX: 802, clientY: 61, button: 0 });
        expect(mounted.pty.last().directInput).toEqual(['\u001b[<0;80;4M']);
    });
});

describe('the pane that owns sizing, and the daemon that cannot say (#166)', () => {
    it('ignores the grid when this client sizes the PTY', async () => {
        // An owner's engine is at the grid the daemon just serialised at BECAUSE the owner put it
        // there. A transient disagreement (the box moved while the snapshot was in flight) is
        // repaired by that gesture's own settled resync; adopting the stale grid here would
        // letterbox the owner's own window mid-drag.
        const mounted = await mount({ ownsSize: true, width: 1200, height: 600 });
        const renderer = mounted.renderers.last();
        renderer.screenLog.length = 0;

        mounted.pty.last().replay('screen', { cols: 73, rows: 19 });
        await settle();

        expect(moves(renderer)).toContain('reset');
        expect(moves(renderer)).not.toContain('resize 73x19');
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBeNull();
    });

    it('keeps its own box against a daemon that sends no grid at all', async () => {
        // The backward-compatibility half: a new client on a daemon that predates #166 gets no
        // `replayGrid` frame, so `grid` is undefined and nothing is mirrored. That is the
        // behaviour that shipped — #166 is reachable again, but nothing else changes.
        const mounted = await mount({ ownsSize: false, width: 1200, height: 600 });
        const renderer = mounted.renderers.last();
        renderer.screenLog.length = 0;

        mounted.pty.last().replay('owner-width-screen');
        await settle();

        expect(movesOffOwnBox(renderer, '120x30')).toEqual(['reset', 'write']);
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
        expect(mounted.root.getAttribute(TERMINAL_MIRROR_ATTRIBUTE)).toBeNull();
    });

    it('refuses a zero grid rather than resizing an engine to nothing', async () => {
        const mounted = await mount({ ownsSize: false, width: 1200, height: 600 });
        const renderer = mounted.renderers.last();
        renderer.screenLog.length = 0;

        mounted.pty.last().replay('screen', { cols: 0, rows: 0 });
        await settle();

        expect(moves(renderer)).toContain('reset');
        expect(moves(renderer)).not.toContain('resize 0x0');
        expect({ cols: renderer.cols, rows: renderer.rows }).toEqual({ cols: 120, rows: 30 });
    });
});
