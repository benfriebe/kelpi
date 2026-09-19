/**
 * Pane Lab, the SDK-only pane chrome presenter, driven exactly as the window drives it.
 *
 * The shipped view module is evaluated unchanged in jsdom against a fake `kelpi` whose `ui` methods
 * are the REAL presenter host (`pane-chrome/presenter.ts`) over the REAL projection
 * (`pane-chrome/projection.ts`) and the REAL per-pane surface (`pane-chrome/surface.ts`), exactly as
 * `features/settings-lab.test.ts` runs Settings Lab against the real settings model. So a pane the
 * frame does not carry, a ref from an older frame, a control that has gone disabled and a
 * declaration on a pane the host never published are refused HERE for the same reason they would be
 * refused in the window, and a split that reaches `PaneChromeActions` is the split the daemon would
 * have been sent.
 *
 * The subscription wrapper copies the SDK's delivery rule - one frame at a time, acknowledged only
 * once the listener settles - because that is what makes the example's `stall()` hook a real missed
 * acknowledgement rather than a flag.
 *
 * Two layers are asserted separately throughout, which is the contract's own shape: what the lab
 * draws from the frame it was given, and what the HOST refuses when a call arrives anyway - which
 * is the path the live scenario drives, because a ref the lab's own buttons cannot produce has to be
 * sent through the SDK directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonObject } from '@kelpi/protocol';

import { testPane } from '../grid/testing';
import type { PaneModel } from '../grid/types';
import { PANE_CHROME_LIMITS } from '../pane-chrome/contract';
import { paneChromeModel, type PaneChromeModel } from '../pane-chrome/model';
import {
    createPaneChromePresenterHost,
    resetPaneChromePresenterFailures,
    type PaneChromePresenterHost,
    type PaneChromePresenterSnapshot
} from '../pane-chrome/presenter';
import { paneChromeFrameRect } from '../pane-chrome/presenter-slot';
import { createPaneChromeRefs, projectPaneChrome, type PaneChromeFrameRect } from '../pane-chrome/projection';
import { createPaneChromeSurface, type PaneChromeSurface } from '../pane-chrome/surface';

const assets = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../examples/plugins/pane-lab/ui'
);
const view = fs.readFileSync(path.join(assets, 'pane-chrome.js'), 'utf8');
const shell = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');

const NOW = 1_800_000;
/** The lab's own threshold and the band it asks for; copied here so a change to either is caught. */
const WIDE_PANE = 420;
const TALL_BAND = 44;

/** What the view publishes for the scenario, and what this suite reads back. */
interface LabDiagnostics {
    readonly snapshot: PaneChromePresenterSnapshot | null;
    readonly ready: boolean;
    readonly frames: number;
    readonly lastError: string | null;
    crash(mode?: string): void;
    stall(): void;
    declare(paneID: string, pixels: number | null): void;
}

/** One action as the grid's own handlers received it. */
interface Action {
    readonly verb: string;
    readonly paneID: string;
    readonly detail?: string;
}

interface PaneSpec {
    readonly id: string;
    readonly width?: number;
    readonly overrides?: Parameters<typeof testPane>[1];
    readonly commands?: readonly { readonly id: string; readonly title: string; readonly enabled?: boolean }[];
    readonly items?: readonly {
        readonly id: string;
        readonly text: string;
        readonly enabled?: boolean;
    }[];
    /** The footer's own git stats for this pane, as `App` resolves them per working directory. */
    readonly changes?: { readonly changedFiles: number; readonly additions: number; readonly deletions: number };
}

const flush = async (): Promise<void> => {
    for (let index = 0; index < 12; index++) await Promise.resolve();
};
async function until(condition: () => boolean, label: string): Promise<void> {
    for (let index = 0; index < 240; index++) {
        try {
            if (condition()) return;
        } catch {
            /* a condition reading an element the view has not drawn yet is "not yet" */
        }
        await new Promise((resolve) => setTimeout(resolve, 4));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

const cleanups: Array<() => void> = [];

/**
 * A grid, as the presenter host reads one.
 *
 * The models are rebuilt on every projection so the height a pane is wearing, its focus and its
 * rename state are read afresh - which is what the window does, and what makes `declared` heights
 * observable in the frame that comes back.
 */
function make(specs: readonly PaneSpec[]) {
    // Mutable, because a plugin contributing a `pane.header` command mid-session is the case the
    // stale-ref replay test exists for.
    const live: PaneSpec[] = [...specs];
    /*
     * ONE token table for the whole session, which is what `PaneGrid` keeps per presenter
     * generation. A fresh table per projection is what `projectPaneChrome` defaults to, and it is
     * exactly the positional behaviour that made a one-commit-old click activate its neighbour.
     */
    const refs = createPaneChromeRefs();
    const actions: Action[] = [];
    const declared = new Map<string, number>();
    const state = {
        visible: true,
        focusedPaneID: specs[0]?.id ?? null,
        zoomedPaneID: null as string | null,
        hidden: new Set<string>(),
        renaming: new Set<string>(),
        workspaceID: 'ws-lab'
    };
    const widths = new Map(specs.map((spec) => [spec.id, spec.width ?? 600]));
    const paneHeight = 480;
    const panes = new Map<string, PaneModel>(
        specs.map((spec) => [spec.id, testPane(spec.id, spec.overrides)])
    );

    const verbs = {
        onFocusPane: (paneID: string) => actions.push({ verb: 'focus', paneID }),
        onClosePane: (paneID: string) => actions.push({ verb: 'close', paneID }),
        onRenamePane: (paneID: string, name: string) => actions.push({ verb: 'rename', paneID, detail: name }),
        onSplitPane: (paneID: string, direction: string) =>
            actions.push({ verb: 'split', paneID, detail: direction }),
        onToggleZoom: (paneID: string) => actions.push({ verb: 'zoom', paneID }),
        onNewWebPane: (paneID: string, direction: string) =>
            actions.push({ verb: 'new-web', paneID, detail: direction }),
        onRunHeaderItem: (paneID: string, itemID: string) =>
            actions.push({ verb: 'item', paneID, detail: itemID }),
        onPaneContextMenu: (paneID: string) => actions.push({ verb: 'menu', paneID })
    };

    const model = (spec: PaneSpec): PaneChromeModel =>
        paneChromeModel({
            pane: panes.get(spec.id)!,
            focused: state.focusedPaneID === spec.id,
            zoomed: state.zoomedPaneID === spec.id,
            zoomAvailable: specs.length > 1,
            homeDirectory: '/Users/ben',
            nowSeconds: NOW,
            // The band the host would be painting: the declaration, clamped against the pane.
            height: Math.min(declared.get(spec.id) ?? PANE_CHROME_LIMITS.nativeHeight, paneHeight / 4),
            paneWidth: widths.get(spec.id)!,
            renaming: state.renaming.has(spec.id),
            ...(spec.changes === undefined ? {} : { changes: spec.changes }),
            ...(spec.commands === undefined
                ? {}
                : {
                      commands: spec.commands.map((command) => ({
                          ...command,
                          run: (paneID: string) =>
                              actions.push({ verb: 'command', paneID, detail: command.id })
                      }))
                  }),
            ...(spec.items === undefined
                ? {}
                : {
                      items: spec.items.map((item) => ({
                          id: item.id,
                          text: item.text,
                          tooltip: null,
                          badge: null,
                          tone: 'default' as const,
                          enabled: item.enabled !== false
                      }))
                  })
        });

    /** Rebuilt on every read, which is what `surface.ts` re-resolving against a FRESH model means. */
    const models = (): Map<string, PaneChromeModel> =>
        new Map(live.filter((spec) => panes.has(spec.id)).map((spec) => [spec.id, model(spec)]));

    const surfaces = new Map<string, PaneChromeSurface>();
    const surface = (paneID: string): PaneChromeSurface | null => {
        if (!panes.has(paneID)) return null;
        let found = surfaces.get(paneID);
        if (found === undefined) {
            found = createPaneChromeSurface({
                actions: () => verbs,
                model: (id) => models().get(id) ?? null
            });
            surfaces.set(paneID, found);
        }
        return found;
    };

    const projection = () => {
        const shown = live.filter((spec) => panes.has(spec.id) && !state.hidden.has(spec.id));
        const rects: Record<string, PaneChromeFrameRect> = {};
        let y = 0;
        const descriptors = shown.map((spec) => {
            const width = widths.get(spec.id)!;
            const descriptor = model(spec).descriptor;
            rects[spec.id] = paneChromeFrameRect(
                { x: 0, y, width, height: paneHeight },
                descriptor.height
            );
            y += paneHeight;
            return descriptor;
        });
        return projectPaneChrome(
            {
                workspaceID: state.workspaceID,
                formFactor: 'desktop',
                focusedPaneID: state.focusedPaneID,
                zoomedPaneID: state.zoomedPaneID,
                panes: descriptors,
                rects
            },
            refs
        );
    };

    return {
        actions,
        declared,
        state,
        projection,
        surface,
        widths,
        panes,
        /** Another plugin's `pane.header` command arriving, at the HEAD of the control row. */
        addCommand(paneID: string, command: { readonly id: string; readonly title: string }) {
            const index = live.findIndex((spec) => spec.id === paneID);
            if (index < 0) return;
            live[index] = { ...live[index]!, commands: [command, ...(live[index]!.commands ?? [])] };
        },
        /** A pane closed under the presenter: its header unmounts, so it has no surface left. */
        remove(paneID: string) {
            panes.delete(paneID);
            surfaces.delete(paneID);
        },
        retitle(paneID: string, title: string) {
            const pane = panes.get(paneID);
            if (pane !== undefined) panes.set(paneID, { ...pane, title });
        }
    };
}
type Grid = ReturnType<typeof make>;

async function mount(grid: Grid) {
    document.documentElement.innerHTML = new DOMParser().parseFromString(shell, 'text/html').documentElement
        .innerHTML;
    const failures: string[] = [];
    const thrown: Error[] = [];
    const errors: Error[] = [];
    const calls: Array<{ method: string; args: JsonObject }> = [];
    const renames: string[] = [];
    const menus: string[] = [];
    let acknowledged = 0;
    let readied = 0;

    const host: PaneChromePresenterHost = createPaneChromePresenterHost({
        placement: 'pane.chrome',
        // A presenter is desktop-only in this release, so a frame it receives always says so.
        formFactor: () => 'desktop',
        visible: () => grid.state.visible,
        projection: grid.projection,
        surface: grid.surface,
        openRename: (paneID) => {
            renames.push(paneID);
            grid.state.renaming.add(paneID);
        },
        openMenu: (paneID) => {
            menus.push(paneID);
        },
        declareHeight: (paneID, pixels) => {
            if (pixels === null) grid.declared.delete(paneID);
            else grid.declared.set(paneID, Math.max(0, Math.round(pixels)));
        },
        fail: (detail) => {
            failures.push(detail);
        },
        onAcknowledged: () => {
            acknowledged += 1;
        },
        onReady: () => {
            readied += 1;
        }
    });
    const call = async (method: string, args: JsonObject): Promise<void> => {
        calls.push({ method, args });
        await host.call(method, args);
    };
    // The SDK's own rule: frames drain one at a time, and each is acknowledged only after the
    // author's listener settles. A listener that never settles never acknowledges.
    let draining: Promise<void> = Promise.resolve();
    const onPaneChrome = (
        listener: (value: PaneChromePresenterSnapshot) => void | Promise<void>,
        onError?: (error: Error) => void | Promise<void>
    ): (() => void) =>
        host.subscribe(
            (value) => {
                draining = draining.then(async () => {
                    try {
                        await listener(value);
                    } catch (error) {
                        thrown.push(error as Error);
                    }
                    host.noteAcknowledged();
                });
            },
            (error) => {
                errors.push(error);
                void onError?.(error);
            }
        );
    vi.stubGlobal('kelpi', {
        ready: Promise.resolve(),
        ui: {
            getPaneChrome: async () => host.getPaneChrome(),
            onPaneChrome,
            reportPresenterReady: () => call('ui.reportPresenterReady', {}),
            focusChromePane: (paneID: string) => call('ui.focusChromePane', { paneID }),
            splitPane: (paneID: string, direction: string) => call('ui.splitPane', { paneID, direction }),
            toggleZoom: (paneID: string) => call('ui.toggleZoom', { paneID }),
            renamePane: (paneID: string) => call('ui.renamePane', { paneID }),
            closePane: (paneID: string) => call('ui.closePane', { paneID }),
            activatePaneControl: (paneID: string, ref: string) =>
                call('ui.activatePaneControl', { paneID, ref }),
            runPaneHeaderItem: (paneID: string, ref: string) => call('ui.runPaneHeaderItem', { paneID, ref }),
            openPaneMenu: (paneID: string) => call('ui.openPaneMenu', { paneID }),
            setPaneChromeHeight: (paneID: string, pixels: number | null) =>
                call('ui.setPaneChromeHeight', { paneID, pixels })
        }
    });
    // Evaluate the shipped module unchanged, exactly as `features/settings-lab.test.ts` does.
    const events = vi.spyOn(globalThis, 'addEventListener');
    const registered: typeof events.mock.calls = [];
    try {
        await new Function(`return (async () => { ${view}\n})();`)();
    } finally {
        registered.push(...events.mock.calls);
        events.mockRestore();
    }
    cleanups.push(() => {
        window.dispatchEvent(new Event('pagehide'));
        host.dispose();
        for (const [name, listener, listenerOptions] of registered)
            globalThis.removeEventListener(name, listener, listenerOptions);
    });
    return {
        host,
        calls,
        errors,
        failures,
        thrown,
        renames,
        menus,
        acknowledged: () => acknowledged,
        readied: () => readied,
        lab: (): LabDiagnostics => (globalThis as unknown as { paneLab: LabDiagnostics }).paneLab,
        /** The grid moved: a new frame, exactly as `PaneGrid`'s render would produce one. */
        refresh: () => host.refresh(),
        /**
         * A call the lab's own buttons cannot produce, straight down the SDK's pipe - which is what
         * an `inFrame` evaluation in the live scenario is. The host answers it on its own.
         */
        // `async` on purpose: `host.call` throws SYNCHRONOUSLY, and the SDK's own wrapper is an
        // async function, so a refusal reaches a plugin as a rejected promise. This is that wrapper.
        send: async (method: string, args: JsonObject) => host.call(method, args),
        sent: (method: string) => calls.filter((entry) => entry.method === method).map((entry) => entry.args)
    };
}
type Harness = Awaited<ReturnType<typeof mount>>;

const found = (testid: string): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)
];
function band(paneID: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(
        `[data-testid="lab-pane-header"][data-pane-id="${paneID}"]`
    );
    expect(node, `Missing band for ${paneID}`).not.toBeNull();
    return node!;
}
const bandIDs = (): string[] => found('lab-pane-header').map((node) => node.dataset.paneId ?? '');
const controls = (paneID: string): HTMLButtonElement[] => [
    ...band(paneID).querySelectorAll<HTMLButtonElement>('[data-testid="lab-pane-control"]')
];
const items = (paneID: string): HTMLButtonElement[] => [
    ...band(paneID).querySelectorAll<HTMLButtonElement>('[data-testid="lab-pane-item"]')
];
const framePane = (h: Harness, paneID: string) =>
    h.lab().snapshot?.panes.find((pane) => pane.paneID === paneID);
const control = (h: Harness, paneID: string, label: string) =>
    framePane(h, paneID)?.controls.find((entry) => entry.label.startsWith(label));

const ready = (h: Harness): Promise<void> =>
    until(() => document.body.dataset.ready === 'true', 'the presenter to report readiness').then(() => {
        expect(h.lab().ready).toBe(true);
    });

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await flush();
    vi.unstubAllGlobals();
    resetPaneChromePresenterFailures();
    delete (globalThis as unknown as { paneLab?: LabDiagnostics }).paneLab;
    document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('Pane Lab draws every carried pane and reports readiness', () => {
    it('draws one band per pane at the rectangle the frame gave it, then reports it has painted', async () => {
        const grid = make([{ id: 'p1', width: 600 }, { id: 'p2', width: 300 }]);
        const h = await mount(grid);
        await ready(h);
        expect(bandIDs()).toEqual(['p1', 'p2']);
        expect(h.readied()).toBe(1);
        const first = framePane(h, 'p1')!;
        expect(first.rect).not.toBeNull();
        expect(band('p1').style.left).toBe(`${String(first.rect!.x)}px`);
        expect(band('p1').style.top).toBe(`${String(first.rect!.y)}px`);
        expect(band('p1').style.width).toBe(`${String(first.rect!.width)}px`);
        expect(document.body.dataset.panes).toBe('2');
        expect(document.body.dataset.withheld).toBe('0');
    });

    it('draws the title with the host\'s own middle-truncation split', async () => {
        const grid = make([
            {
                id: 'p1',
                overrides: {
                    title: '/Users/ben/code/kelpi/packages/client/src/grid',
                    workingDirectory: '/Users/ben/code/kelpi'
                }
            }
        ]);
        const h = await mount(grid);
        await ready(h);
        const parts = framePane(h, 'p1')!.titleParts;
        const title = band('p1').querySelector<HTMLElement>('[data-testid="lab-pane-title"]')!;
        expect(title.textContent).toBe(`${parts.head}${parts.tail}`);
        // The directory never leaves the host as an absolute path: the frame is already `~/…`.
        expect(framePane(h, 'p1')!.directory.startsWith('~')).toBe(true);
    });

    it('draws the branch and the change counts the frame carries', async () => {
        const grid = make([
            {
                id: 'p1',
                overrides: { gitBranch: 'feature/pane-chrome' },
                // §APP-071's numbers, which `App` resolves with the status footer's own
                // `footerGitStats` and hands the grid per pane. The bundled header draws a branch
                // chip and no counts; the frame carries both.
                changes: { changedFiles: 4, additions: 120, deletions: 8 }
            }
        ]);
        const h = await mount(grid);
        await ready(h);
        expect(
            band('p1').querySelector<HTMLElement>('[data-testid="lab-pane-branch"]')?.textContent
        ).toBe('feature/pane-chrome');
        expect(framePane(h, 'p1')?.changes).toEqual({ changedFiles: 4, additions: 120, deletions: 8 });
        expect(band('p1').textContent).toContain('doc 4 +120 -8');
    });

    it('renders nothing while the grid is not presenting, and comes back when it is', async () => {
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        grid.state.visible = false;
        h.refresh();
        await until(() => document.body.dataset.visible === 'false', 'the blank frame');
        expect(found('lab-pane-header')).toEqual([]);
        grid.state.visible = true;
        h.refresh();
        await until(() => bandIDs().length === 1, 'the bands to come back');
    });

    it('renders nothing for a pane the budget withheld, and says how many there were', async () => {
        // One pane far past the whole budget on its own: the frame stops at it and counts the rest.
        const huge = 'x'.repeat(PANE_CHROME_LIMITS.payloadBytes);
        const grid = make([{ id: 'p1' }, { id: 'p2', overrides: { title: huge } }, { id: 'p3' }]);
        const h = await mount(grid);
        await ready(h);
        expect(bandIDs()).toEqual(['p1']);
        expect(document.body.dataset.withheld).toBe('2');
        expect(found('lab-pane-withheld')[0]?.dataset.count).toBe('2');
    });
});

describe('Pane Lab routes every gesture through the host', () => {
    it('focuses a pane from a press anywhere in its band', async () => {
        const grid = make([{ id: 'p1' }, { id: 'p2' }]);
        const h = await mount(grid);
        await ready(h);
        band('p2').dispatchEvent(new Event('pointerdown', { bubbles: true }));
        await until(() => grid.actions.some((entry) => entry.verb === 'focus'), 'the focus call');
        expect(grid.actions.at(-1)).toEqual({ verb: 'focus', paneID: 'p2' });
    });

    it('toggles zoom from a double click and opens the host menu from a right click', async () => {
        const grid = make([{ id: 'p1' }, { id: 'p2' }]);
        const h = await mount(grid);
        await ready(h);
        band('p1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        await until(() => grid.actions.some((entry) => entry.verb === 'zoom'), 'the zoom call');
        band('p1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        await until(() => h.menus.length === 1, 'the host menu');
        // The MENU is the host's: nothing about it reaches the presenter.
        expect(h.menus).toEqual(['p1']);
    });

    it('splits and closes through the row, by ref', async () => {
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        const split = control(h, 'p1', 'Split right')!;
        controls('p1').find((node) => node.dataset.ref === split.ref)!.click();
        await until(() => grid.actions.some((entry) => entry.verb === 'split'), 'the split call');
        expect(grid.actions.at(-1)).toEqual({ verb: 'split', paneID: 'p1', detail: 'horizontal' });
        const close = control(h, 'p1', 'Close pane')!;
        expect(close.pinned).toBe(true);
        controls('p1').find((node) => node.dataset.ref === close.ref)!.click();
        await until(() => grid.actions.some((entry) => entry.verb === 'close'), 'the close call');
    });

    it('runs another plugin\'s header item by ref, and its command button by ref', async () => {
        const grid = make([
            {
                id: 'p1',
                commands: [{ id: 'example.board.inspect', title: 'Inspect board' }],
                items: [{ id: 'example.board.status', text: 'Ready' }]
            }
        ]);
        const h = await mount(grid);
        await ready(h);
        items('p1')[0]!.click();
        await until(() => grid.actions.some((entry) => entry.verb === 'item'), 'the item call');
        expect(grid.actions.at(-1)).toEqual({
            verb: 'item',
            paneID: 'p1',
            detail: 'example.board.status'
        });
        const command = control(h, 'p1', 'Inspect board')!;
        expect(command.kind).toBe('item');
        // The ref is all the view has: no plugin id and no command name anywhere in the frame.
        expect(JSON.stringify(h.lab().snapshot)).not.toContain('example.board');
        controls('p1').find((node) => node.dataset.ref === command.ref)!.click();
        await until(() => grid.actions.some((entry) => entry.verb === 'command'), 'the command call');
    });


    it('starts no text selection from a press on a band, and asks for no drag call', async () => {
        /*
         * What the user actually hit: a press dragged across the band highlighted its title instead
         * of moving the pane. The band holds nothing selectable (`user-select: none`) and the press
         * itself is defaulted away, so a drag across a header is never a selection - and the pane
         * MOVE is the host's own grip, outside this frame, because a press that lands in here can
         * never reach the window's gesture.
         */
        const grid = make([{ id: 'p1' }, { id: 'p2' }]);
        const h = await mount(grid);
        await ready(h);
        const press = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
        band('p2').querySelector<HTMLElement>('[data-testid="lab-pane-title"]')!.dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true);
        // There is no call for it to have made: the contract carries none.
        expect(h.sent('ui.beginPaneDrag')).toEqual([]);
        await expect(h.send('ui.beginPaneDrag', { paneID: 'p2' })).rejects.toThrow(/Unknown pane chrome method/);
    });

    it('prints the withheld count inside the first carried band, never over it', async () => {
        const huge = 'x'.repeat(PANE_CHROME_LIMITS.payloadBytes);
        const grid = make([{ id: 'p1' }, { id: 'p2', overrides: { title: huge } }]);
        const h = await mount(grid);
        await ready(h);
        const notice = document.querySelector<HTMLElement>('[data-testid="lab-pane-withheld"]');
        expect(notice?.dataset.count).toBe('1');
        // Inside the first band's own row, so the layout gives it a box rather than the host's clip
        // deciding whether it lands on somebody's title.
        expect(band('p1').contains(notice)).toBe(true);
    });

    it('opens the host\'s rename field and never sends a name', async () => {
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        await h.send('ui.renamePane', { paneID: 'p1' });
        expect(h.renames).toEqual(['p1']);
        expect(grid.actions.filter((entry) => entry.verb === 'rename')).toEqual([]);
        // The field is up, so the frame says so and the title stops being the presenter's.
        h.refresh();
        await until(() => framePane(h, 'p1')?.renaming === true, 'the renaming flag');
    });
});

describe('Pane Lab declares a band and the host clamps it', () => {
    it('asks for a two-line band on a wide pane and hands it back when the pane narrows', async () => {
        const grid = make([{ id: 'wide', width: WIDE_PANE + 40 }, { id: 'narrow', width: 240 }]);
        const h = await mount(grid);
        await ready(h);
        await until(() => grid.declared.get('wide') === TALL_BAND, 'the declared band');
        expect(grid.declared.has('narrow')).toBe(false);
        // The frame reports what the pane is actually PAINTING, which is the clamped value.
        h.refresh();
        await until(() => (framePane(h, 'wide')?.height ?? 0) > PANE_CHROME_LIMITS.nativeHeight, 'the clamp');
        grid.widths.set('wide', 240);
        h.refresh();
        await until(() => !grid.declared.has('wide'), 'the band handed back');
    });

    it('does not re-send a declaration that has not changed', async () => {
        const grid = make([{ id: 'wide', width: WIDE_PANE + 40 }]);
        const h = await mount(grid);
        await ready(h);
        await until(() => grid.declared.get('wide') === TALL_BAND, 'the declared band');
        const before = h.sent('ui.setPaneChromeHeight').length;
        for (let index = 0; index < 5; index++) {
            grid.retitle('wide', `title ${String(index)}`);
            h.refresh();
            await flush();
        }
        await until(() => (h.lab().frames ?? 0) >= 5, 'five more frames');
        expect(h.sent('ui.setPaneChromeHeight').length).toBe(before);
    });

    it('lets a band be handed back for a pane that has LEFT the frame', async () => {
        const grid = make([{ id: 'wide', width: WIDE_PANE + 40 }, { id: 'other' }]);
        const h = await mount(grid);
        await ready(h);
        await until(() => grid.declared.get('wide') === TALL_BAND, 'the declared band');
        // The pane is hidden, so the frame stops carrying it and every WRITE for it is refused.
        grid.state.hidden.add('wide');
        h.refresh();
        await until(() => framePane(h, 'wide') === undefined, 'the pane to leave the frame');
        await expect(h.send('ui.setPaneChromeHeight', { paneID: 'wide', pixels: 64 })).rejects.toThrow(
            /not in the current pane chrome frame/
        );
        // A hand-back is not a write. Refusing it too left the presenter holding a band it could
        // never undo, with the bundled header floating inside it.
        await h.send('ui.setPaneChromeHeight', { paneID: 'wide', pixels: null });
        expect(grid.declared.has('wide')).toBe(false);
    });

    it('refuses a hand-back for a pane with no header left at all', async () => {
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        await expect(h.send('ui.setPaneChromeHeight', { paneID: 'ghost', pixels: null })).rejects.toThrow(
            /not in the current pane chrome frame/
        );
    });

    it('refuses a declaration for a pane the frame does not carry', async () => {
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        await expect(h.send('ui.setPaneChromeHeight', { paneID: 'ghost', pixels: 64 })).rejects.toThrow(
            /not in the current pane chrome frame/
        );
        expect(grid.declared.has('ghost')).toBe(false);
    });

    it('refuses a band that is not a number, and keeps the one that is there', async () => {
        const grid = make([{ id: 'wide', width: WIDE_PANE + 40 }]);
        const h = await mount(grid);
        await ready(h);
        await until(() => grid.declared.get('wide') === TALL_BAND, 'the declared band');
        await expect(
            h.send('ui.setPaneChromeHeight', { paneID: 'wide', pixels: Number.NaN })
        ).rejects.toThrow(/finite number of pixels/);
        expect(grid.declared.get('wide')).toBe(TALL_BAND);
    });
});

describe('Pane Lab is refused what the frame withheld', () => {
    it('refuses a forged ref, a ref from another pane, and an item ref used as a control', async () => {
        const grid = make([
            { id: 'p1', items: [{ id: 'example.board.status', text: 'Ready' }] },
            { id: 'p2' }
        ]);
        const h = await mount(grid);
        await ready(h);
        const itemRef = framePane(h, 'p1')!.items[0]!.ref;
        const controlRef = framePane(h, 'p1')!.controls[0]!.ref;
        await expect(h.send('ui.activatePaneControl', { paneID: 'p1', ref: 'nonsense' })).rejects.toThrow(
            /not in the current pane chrome frame/
        );
        // p1's control ref, used on p2: refs are pane-scoped and mean nothing anywhere else.
        await expect(
            h.send('ui.activatePaneControl', { paneID: 'p2', ref: `${controlRef}#` })
        ).rejects.toThrow(/not in the current pane chrome frame/);
        // The two lists are not the same kind of thing; neither reaches into the other.
        await expect(h.send('ui.activatePaneControl', { paneID: 'p1', ref: itemRef })).rejects.toThrow(
            /not in the current pane chrome frame/
        );
        await expect(h.send('ui.runPaneHeaderItem', { paneID: 'p1', ref: controlRef })).rejects.toThrow(
            /not in the current pane chrome frame/
        );
        expect(grid.actions).toEqual([]);
    });

    it('replays a stale ref onto the control it was minted for, never onto its neighbour', async () => {
        /*
         * The defect this is here for: refs used to be ROW POSITIONS, so `c0` meant "whatever is
         * first in this row". A plugin command appearing at the head of the row moved every
         * control along, and a click painted from the frame before it - which is every click, the
         * frame is always at least one commit old - activated the control one place over. Split
         * right ran Close.
         */
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        const splitRef = control(h, 'p1', 'Split right')!.ref;
        const closeRef = control(h, 'p1', 'Close pane')!.ref;
        expect(splitRef).not.toBe(closeRef);
        // A plugin command arrives at the HEAD of the row, moving every host control along.
        grid.addCommand('p1', { id: 'example.board.inspect', title: 'Inspect board' });
        h.refresh();
        const before = framePane(h, 'p1')!.controls.length;
        await until(() => (framePane(h, 'p1')?.controls.length ?? 0) > before, 'the new row');
        // The ref the user's click was painted with still names Split right, and nothing else.
        await h.send('ui.activatePaneControl', { paneID: 'p1', ref: splitRef });
        expect(grid.actions.map((entry) => entry.verb)).toEqual(['split']);
        expect(grid.actions.some((entry) => entry.verb === 'close')).toBe(false);
        // And the newcomer got a token of its own rather than inheriting one.
        const command = control(h, 'p1', 'Inspect board')!;
        expect([splitRef, closeRef]).not.toContain(command.ref);
    });

    it('refuses every call for a pane whose header has gone', async () => {
        const grid = make([{ id: 'p1' }, { id: 'p2' }]);
        const h = await mount(grid);
        await ready(h);
        const ref = framePane(h, 'p2')!.controls[0]!.ref;
        // The pane closed after the frame went out: the ref still resolves, and the surface it
        // resolves against is gone, so nothing runs.
        grid.remove('p2');
        await expect(h.send('ui.activatePaneControl', { paneID: 'p2', ref })).rejects.toThrow(
            /not in the current pane chrome frame/
        );
        expect(grid.actions).toEqual([]);
    });

    it('refuses every mutating call while the grid is presenting nothing', async () => {
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        grid.state.visible = false;
        h.refresh();
        await until(() => document.body.dataset.visible === 'false', 'the blank frame');
        await expect(h.send('ui.focusChromePane', { paneID: 'p1' })).rejects.toThrow(
            /not presented right now/
        );
        expect(grid.actions).toEqual([]);
    });

    it('carries no absolute path, pid, session id or test id in any frame', async () => {
        const grid = make([
            {
                id: 'p1',
                overrides: {
                    workingDirectory: '/Users/ben/code/kelpi',
                    agentSessionID: 'session-secret-42',
                    status: 'running',
                    agentKind: 'claude',
                    agentStartedAt: (NOW - 90) * 1000
                }
            }
        ]);
        const h = await mount(grid);
        await ready(h);
        const text = JSON.stringify(h.lab().snapshot);
        expect(text).not.toContain('/Users/ben');
        expect(text).not.toContain('session-secret-42');
        expect(text).not.toContain('pane-close-');
        expect(text).not.toContain('testID');
        // The agent is a kind and a clock, and the badge line the host composed.
        expect(framePane(h, 'p1')!.agent?.kind).toBe('claude');
    });
});

describe('Pane Lab fails the way the fallback needs it to', () => {
    it('fails the placement on an uncaught error inside the view', async () => {
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        h.lab().crash('listener');
        grid.retitle('p1', 'after the crash');
        h.refresh();
        await until(() => h.thrown.length > 0, 'the crash to reach the SDK');
        expect(h.lab().lastError).toContain('crashed on purpose');
    });

    it('stops acknowledging once stalled, which is what the watchdog fires on', async () => {
        const grid = make([{ id: 'p1' }, { id: 'p2' }]);
        const h = await mount(grid);
        await ready(h);
        const before = h.acknowledged();
        h.lab().stall();
        // A frame whose SHAPE moved: a pane closed. The listener never settles, so it is never
        // acknowledged, and the slot's 5 s timer is what turns that into a failure in the window.
        grid.remove('p2');
        h.refresh();
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(h.acknowledged()).toBe(before);
    });

    it('charges every call against the presenter budget, and a breach fails the placement', async () => {
        const grid = make([{ id: 'p1' }]);
        const h = await mount(grid);
        await ready(h);
        let failed: unknown = null;
        for (let index = 0; index < PANE_CHROME_LIMITS.presenterCalls + 8; index++) {
            try {
                await h.send('ui.focusChromePane', { paneID: 'p1' });
            } catch (error) {
                failed = error;
                break;
            }
        }
        expect(String(failed)).toContain('call budget');
        expect(h.failures.some((detail) => detail.includes('call budget'))).toBe(true);
    });
});
