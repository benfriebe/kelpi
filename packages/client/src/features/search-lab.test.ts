/**
 * Search Lab, the SDK-only pane search presenter, driven exactly as the window drives it.
 *
 * The shipped view module is evaluated unchanged in jsdom against a fake `kelpi` whose `ui` methods
 * are the REAL presenter host (`pane-search/presenter.ts`) over the REAL projection
 * (`pane-search/projection.ts`) and the REAL box clamp (`pane-search/contract.ts`), exactly as
 * `features/pane-lab.test.ts` runs Pane Lab against the real pane chrome model. So a pane the frame
 * does not name, a call while no search is open and a needle past the cap are refused HERE for the
 * same reason they would be refused in the window, and a needle that reaches `PaneSearchActions` is
 * the needle the daemon would have been sent.
 *
 * The subscription wrapper copies the SDK's delivery rule - one frame at a time, acknowledged only
 * once the listener settles - because that is what makes the example's `stall()` hook a real missed
 * acknowledgement rather than a flag.
 *
 * Two layers are asserted separately throughout, which is the contract's own shape: what the lab
 * draws from the frame it was given, and what the HOST refuses when a call arrives anyway - which is
 * the path the live scenario drives, because a call the lab's own buttons cannot produce has to be
 * sent through the SDK directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonObject } from '@kelpi/protocol';

import { PANE_SEARCH_LIMITS, paneSearchBox, paneSearchRect } from '../pane-search/contract';
import { projectPaneSearch, type PaneSearchSession } from '../pane-search/projection';
import {
    createPaneSearchPresenterHost,
    resetPaneSearchPresenterFailures,
    type PaneSearchPresenterHost,
    type PaneSearchPresenterSnapshot
} from '../pane-search/presenter';

const assets = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../examples/plugins/search-lab/ui'
);
const view = fs.readFileSync(path.join(assets, 'pane-search.js'), 'utf8');
const shell = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');

/** The pane the window is searching, and the box the grid would have measured for it. */
const PANE = { x: 0, y: 0, width: 800, height: 600 };

interface LabDiagnostics {
    readonly snapshot: PaneSearchPresenterSnapshot | null;
    readonly ready: boolean;
    readonly frames: number;
    readonly lastError: string | null;
    readonly held: boolean;
    readonly paintedAt: number | null;
    readonly readyAt: number | null;
    readonly readyNeedle: string | null;
    readonly readyFrameNeedle: string | null;
    readonly readyTyped: boolean | null;
    crash(mode?: string): void;
    stall(): void;
    declare(size: { width: number; height: number } | null): void;
    holdNextBoot(): Promise<void>;
    releaseReady(): void;
}

interface Action {
    readonly verb: string;
    readonly paneID: string;
    readonly detail?: string;
}

const cleanups: Array<() => void> = [];

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

const flush = async (): Promise<void> => {
    for (let index = 0; index < 12; index++) await Promise.resolve();
};

/**
 * The window, as the presenter host reads it.
 *
 * The session is mutable so a needle typed into the lab can be echoed back the way the daemon's
 * delta stream echoes it, and the declared box is stored raw and clamped at read - which is what
 * makes a clamp observable in the frame that comes back.
 */
function make(initial: PaneSearchSession | null = null) {
    const actions: Action[] = [];
    const state = {
        visible: true,
        session: initial,
        declared: null as { width: number; height: number } | null,
        pane: PANE
    };
    const known = new Set(['pane-1', 'pane-2']);
    const projection = () => {
        const session = state.session;
        const box = session === null ? null : paneSearchBox(state.declared, state.pane);
        return projectPaneSearch({
            formFactor: 'desktop',
            visible: state.visible && session !== null,
            session,
            rect: box === null ? null : paneSearchRect(state.pane, box)
        });
    };
    return {
        actions,
        state,
        projection,
        known,
        /** The daemon answering: the needle it stored, the total it counted, the match it found. */
        publish(next: Partial<PaneSearchSession>) {
            if (state.session === null) return;
            state.session = { ...state.session, ...next };
        },
        open(session: PaneSearchSession) {
            state.session = session;
        },
        close() {
            state.session = null;
        }
    };
}
type Window = ReturnType<typeof make>;

const SESSION: PaneSearchSession = {
    paneID: 'pane-1',
    kind: 'shell',
    needle: '',
    caseSensitive: false,
    total: null,
    selected: null,
    match: null
};

/**
 * A layout, because jsdom has none.
 *
 * The lab MEASURES the bar it drew and declares that, so a document where every box is 0x0 declares
 * nothing at all and the whole box-authority path goes untested. The width grows with the counter,
 * which is exactly the reflow the declaration exists for, and shrinks with the tier the lab fits
 * itself to: 80 px of padding and controls, the 160 px field, 7 px a counter character, less the two
 * 26 px step buttons in `compact` and the counter as well in `tight`.
 */
const STEPS_WIDTH = 52;
function stubLayout(): () => void {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function boxed(this: Element): DOMRect {
        if (this.classList.contains('root')) {
            const text = this.querySelector('[data-testid="lab-search-count"]')?.textContent ?? '';
            const fit = (this as HTMLElement).dataset['fit'] ?? 'full';
            const counter = fit === 'tight' ? 0 : text.length * 7;
            const width = 240 + counter - (fit === 'full' ? 0 : STEPS_WIDTH);
            // A pixel `max-height` caps the bar the way the browser would.
            const ceiling = Number.parseFloat((this as HTMLElement).style.maxHeight);
            const height = Number.isFinite(ceiling) ? Math.min(34, ceiling) : 34;
            return {
                x: 0, y: 0, left: 0, top: 0, width, height,
                right: width, bottom: height, toJSON: () => ({})
            } as DOMRect;
        }
        return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
    };
    return () => {
        Element.prototype.getBoundingClientRect = real;
    };
}

async function mount(window: Window, options: { readonly storage?: Map<string, unknown> } = {}) {
    const storage = options.storage ?? new Map<string, unknown>();
    document.documentElement.innerHTML = new DOMParser().parseFromString(shell, 'text/html').documentElement
        .innerHTML;
    cleanups.push(stubLayout());
    const failures: string[] = [];
    const thrown: Error[] = [];
    const errors: Error[] = [];
    const calls: Array<{ method: string; args: JsonObject }> = [];
    let acknowledged = 0;
    let readied = 0;
    let awaitedFrames = 0;

    const host: PaneSearchPresenterHost = createPaneSearchPresenterHost({
        placement: 'pane.search',
        // A presenter is desktop-only in this release, so a frame it receives always says so.
        formFactor: () => 'desktop',
        visible: () => window.state.visible,
        projection: window.projection,
        actions: {
            setNeedle: (paneID, needle) => {
                window.actions.push({ verb: 'needle', paneID, detail: needle });
                // The daemon echoes it back on the delta stream, which is what a real window sees.
                window.publish({ needle, selected: null });
            },
            setCaseSensitive: (paneID, on) => {
                window.actions.push({ verb: 'case', paneID, detail: String(on) });
                window.publish({ caseSensitive: on, selected: null });
            },
            step: (paneID, direction) => {
                window.actions.push({ verb: 'step', paneID, detail: direction });
            },
            close: (paneID) => {
                window.actions.push({ verb: 'close', paneID });
                window.close();
            },
            declareBox: (paneID, size) => {
                window.actions.push({
                    verb: 'box',
                    paneID,
                    detail: size === null ? 'null' : `${String(size.width)}x${String(size.height)}`
                });
                window.state.declared = size;
            },
            knows: (paneID) => window.known.has(paneID)
        },
        fail: (detail) => {
            failures.push(detail);
        },
        onFrame: (awaits) => {
            if (awaits) awaitedFrames += 1;
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
    const onPaneSearch = (
        listener: (value: PaneSearchPresenterSnapshot) => void | Promise<void>,
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
        storage: {
            get: async (key: string) => storage.get(key) ?? null,
            set: async (key: string, value: unknown) => {
                storage.set(key, value);
            }
        },
        ui: {
            getPaneSearch: async () => host.getPaneSearch(),
            onPaneSearch,
            reportPresenterReady: () => call('ui.reportPresenterReady', {}),
            setSearchNeedle: (paneID: string, text: string) => call('ui.setSearchNeedle', { paneID, text }),
            setSearchCaseSensitive: (paneID: string, on: boolean) =>
                call('ui.setSearchCaseSensitive', { paneID, on }),
            searchNext: (paneID: string) => call('ui.searchNext', { paneID }),
            searchPrevious: (paneID: string) => call('ui.searchPrevious', { paneID }),
            closeSearch: (paneID: string) => call('ui.closeSearch', { paneID }),
            setSearchBoxSize: (paneID: string, size: unknown) =>
                call('ui.setSearchBoxSize', { paneID, size: size as JsonObject['size'] })
        }
    });
    // Evaluate the shipped module unchanged, exactly as `features/pane-lab.test.ts` does.
    const events = vi.spyOn(globalThis, 'addEventListener');
    const registered: typeof events.mock.calls = [];
    try {
        await new Function(`return (async () => { ${view}\n})();`)();
    } finally {
        registered.push(...events.mock.calls);
        events.mockRestore();
    }
    cleanups.push(() => {
        globalThis.dispatchEvent(new Event('pagehide'));
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
        acknowledged: () => acknowledged,
        readied: () => readied,
        awaitedFrames: () => awaitedFrames,
        lab: (): LabDiagnostics => (globalThis as unknown as { searchLab: LabDiagnostics }).searchLab,
        /** The window moved: a new frame, exactly as `PaneGrid`'s render would produce one. */
        refresh: () => host.refresh(),
        /**
         * A call the lab's own controls cannot produce, straight down the SDK's pipe - which is what
         * an `inFrame` evaluation in the live scenario is. The host answers it on its own.
         */
        // `async` on purpose: `host.call` throws SYNCHRONOUSLY, and the SDK's own wrapper is an
        // async function, so a refusal reaches a plugin as a rejected promise. This is that wrapper.
        send: async (method: string, args: JsonObject) => host.call(method, args),
        sent: (method: string) => calls.filter((entry) => entry.method === method).map((entry) => entry.args)
    };
}
type Harness = Awaited<ReturnType<typeof mount>>;

const node = (testid: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
const bar = (): HTMLElement => {
    const found = node('lab-search');
    expect(found, 'Missing lab-search').not.toBeNull();
    return found!;
};
const input = (): HTMLInputElement => node('lab-search-input') as unknown as HTMLInputElement;
const countText = (): string => node('lab-search-count')?.textContent ?? '';
const press = (testid: string): void => {
    const button = node(testid);
    expect(button, `Missing ${testid}`).not.toBeNull();
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

/** Type into the field the way a user does: set the value, fire `input`. */
const type = async (h: Harness, text: string): Promise<void> => {
    const field = input();
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    h.refresh();
    await flush();
};

const ready = async (h: Harness): Promise<void> => {
    await until(() => h.lab()?.ready === true, 'Search Lab to report it had painted');
};

afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.unstubAllGlobals();
    resetPaneSearchPresenterFailures();
    document.documentElement.innerHTML = '';
});

describe('Search Lab over the real presenter host', () => {
    it('reports it has painted even when the first frame carries no open search', async () => {
        const window = make(null);
        const h = await mount(window);
        await ready(h);
        expect(h.readied()).toBe(1);
        // Nothing to draw and nothing drawn: `visible: false` is "present nothing".
        expect(document.body.dataset['visible']).toBe('false');
        expect(bar().hidden).toBe(true);
        expect(h.failures).toEqual([]);
    });

    it('draws the bar at the box the frame carries once a search opens', async () => {
        const window = make(null);
        const h = await mount(window);
        await ready(h);
        // The box BEFORE the lab has measured anything is the native bar's own, at the pane's
        // top-trailing corner. Read first, because the lab declares its own the moment it paints.
        window.open(SESSION);
        const first = window.projection().frame.box!;
        expect(first.width).toBe(PANE_SEARCH_LIMITS.nativeWidth);
        expect(first.x).toBe(PANE.width - PANE_SEARCH_LIMITS.margin - PANE_SEARCH_LIMITS.nativeWidth);
        expect(first.y).toBe(PANE_SEARCH_LIMITS.margin);
        h.refresh();
        await until(() => document.body.dataset['visible'] === 'true', 'the bar to appear');
        expect(bar().dataset['paneId']).toBe('pane-1');
        // And the bar is positioned at whatever box the frame it is HOLDING carries, which is the
        // clamped one the host handed back after its own declaration.
        await until(() => {
            const box = h.lab().snapshot?.box ?? null;
            return box !== null && bar().style.left === `${String(box.x)}px` && bar().style.top === `${String(box.y)}px`;
        }, 'the bar to sit at the box it was given');
    });

    it('seeds the field from the daemon\'s needle with the caret at the end, and selects nothing', async () => {
        const window = make({ ...SESSION, needle: 'anchor' });
        const h = await mount(window);
        await ready(h);
        await until(() => input()?.value === 'anchor', 'the field to be seeded');
        // The bundled bar's own rule: a re-opened bar is something you keep typing into, not
        // something whose first keystroke silently replaces the needle you came back to.
        expect(input().selectionStart).toBe('anchor'.length);
        expect(input().selectionEnd).toBe('anchor'.length);
    });

    it('sends what is typed to the daemon\'s needle', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await type(h, 'marker');
        expect(window.actions).toContainEqual({ verb: 'needle', paneID: 'pane-1', detail: 'marker' });
        expect(h.sent('ui.setSearchNeedle').at(-1)).toEqual({ paneID: 'pane-1', text: 'marker' });
    });

    it('does not fight the caret when the daemon echoes the needle back', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await type(h, 'anchor');
        const field = input();
        field.setSelectionRange(2, 4);
        // The same session, the same needle, a new frame: the field is left exactly as it is.
        h.refresh();
        await flush();
        expect(field.selectionStart).toBe(2);
        expect(field.selectionEnd).toBe(4);
    });

    it('follows a needle somebody else set while the field is not being typed into', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        input().blur();
        // Another window, or another plugin through `terminal.search`.
        window.publish({ needle: 'elsewhere' });
        h.refresh();
        await until(() => input().value === 'elsewhere', 'the field to follow the daemon');
    });

    it('reads the counter out of the daemon\'s numbers, in every state it can publish', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        // Nothing at all while the field is empty, which is the bundled bar's own rule.
        expect(countText()).toBe('');
        await type(h, 'anchor');
        window.publish({ total: null });
        h.refresh();
        await until(() => countText() === 'counting', 'the counting state');
        window.publish({ total: 0, selected: null });
        h.refresh();
        await until(() => countText() === 'no matches', 'the empty state');
        window.publish({ total: 17, selected: null });
        h.refresh();
        await until(() => countText() === '17 matches', 'the unselected state');
        window.publish({ total: 17, selected: 2 });
        h.refresh();
        await until(() => countText() === '3 of 17', 'the selected state');
    });

    it('steps with its buttons and with Return and Shift Return', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await type(h, 'anchor');
        window.publish({ total: 9, selected: 0 });
        h.refresh();
        await flush();
        press('lab-search-next');
        press('lab-search-previous');
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        input().dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
        );
        await flush();
        expect(window.actions.filter((action) => action.verb === 'step').map((action) => action.detail)).toEqual([
            'next',
            'prev',
            'next',
            'prev'
        ]);
    });

    it('disables both steps while there is nothing to step through', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        const next = node('lab-search-next') as HTMLButtonElement;
        const previous = node('lab-search-previous') as HTMLButtonElement;
        await until(() => next.disabled, 'the steps to be inert on an empty needle');
        await type(h, 'anchor');
        window.publish({ total: 0 });
        h.refresh();
        await until(() => next.disabled && previous.disabled, 'the steps to be inert with no matches');
        window.publish({ total: 4 });
        h.refresh();
        await until(() => !next.disabled && !previous.disabled, 'the steps to come back');
    });

    it('toggles case sensitivity and shows the state it is in', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        const toggle = node('lab-search-case')!;
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        press('lab-search-case');
        await flush();
        h.refresh();
        await until(() => toggle.getAttribute('aria-pressed') === 'true', 'the toggle to light up');
        expect(window.actions).toContainEqual({ verb: 'case', paneID: 'pane-1', detail: 'true' });
    });

    it('closes the search and blanks itself, because a closed search is present nothing', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        press('lab-search-close');
        await flush();
        h.refresh();
        await until(() => document.body.dataset['visible'] === 'false', 'the bar to go');
        expect(window.actions).toContainEqual({ verb: 'close', paneID: 'pane-1' });
        expect(bar().hidden).toBe(true);
        expect(bar().dataset['paneId']).toBeUndefined();
    });

    it('declares the box it drew, and re-declares when its own layout moves', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await until(() => window.state.declared !== null, 'the first declaration');
        const first = window.state.declared!;
        expect(first.height).toBe(34);
        await type(h, 'anchor');
        // A wider counter is a wider bar, which is the one thing the host cannot see for itself.
        window.publish({ total: 4096, selected: 311 });
        h.refresh();
        await until(
            () => (window.state.declared?.width ?? 0) > first.width,
            'the declaration to follow the counter'
        );
    });

    /**
     * The onscreen screenshots caught this one, which is what onscreen runs are for.
     *
     * A bar wider than its box is drawn in full and then CUT by the host's clip, and what a flex row
     * loses to a cut on its trailing edge is the trailing end: the counter and every button. On a
     * 131 px pane the shipped example showed the needle and nothing else - no next, no previous, no
     * case toggle, no close. It now lays out inside the granted box and lets the FIELD yield, which
     * is the native bar's own answer, and still declares the width it WANTS so a pane that widens
     * gets the whole bar back.
     */
    it('lays its bar out inside the box it was granted, and still declares the one it wants', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await until(() => window.state.declared !== null, 'the first declaration');
        const wanted = window.state.declared!.width;
        // A pane too narrow to seat the bar: the clamp gives it the pane's inner width and no more.
        window.state.pane = { x: 0, y: 0, width: 160, height: 600 };
        h.refresh();
        await until(() => (window.projection().frame.box?.width ?? 0) === 160 - PANE_SEARCH_LIMITS.margin * 2, 'the narrow box');
        await until(() => bar().style.maxWidth === `${String(window.projection().frame.box!.width)}px`, 'the bar to take the box as its ceiling');
        // And what it asks for has not shrunk with it, or it could never ask for more again.
        expect(window.state.declared!.width).toBe(wanted);
    });

    /**
     * The two defects the 2026-09-20 onscreen shots showed: a counter cut to "1 of" on a 246 px
     * pane, and on a 112 px pane a field collapsed to an empty square with the × cut off. The needle
     * yields first and alone; then whole controls go, the steps before the counter; the case toggle
     * and the close button never do.
     */
    it('gives up the needle first, then the step buttons, then the counter, and never the × or Aa', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await type(h, 'anchor');
        window.publish({ total: 12, selected: 0 });
        h.refresh();
        await until(() => countText() === '1 of 12', 'the counter');
        const fitAt = async (paneWidth: number): Promise<string | undefined> => {
            window.state.pane = { x: 0, y: 0, width: paneWidth, height: 600 };
            h.refresh();
            await until(() => {
                const granted = window.projection().frame.box?.width ?? -1;
                return granted <= paneWidth - PANE_SEARCH_LIMITS.margin * 2 && bar().style.maxWidth === `${String(granted)}px`;
            }, `the box for a ${String(paneWidth)} px pane`);
            return bar().dataset['fit'];
        };
        // Wide: every control. The bar wants 80 + 160 + 7 x 7 = 289 px and is granted all of it.
        expect(await fitAt(800)).toBe('full');
        // A 246 px box: the needle alone yields (to 117 px), and the counter is whole.
        expect(await fitAt(262)).toBe('full');
        // 184 px is too narrow for the needle's floor with the steps: they go first.
        expect(await fitAt(200)).toBe('compact');
        // 112 px: the counter goes WHOLE, never in part, and its text moves to the field.
        expect(await fitAt(128)).toBe('tight');
        expect(input().title).toBe('1 of 12');
        // The case toggle and the close button are never among what gives way.
        const css = fs.readFileSync(path.join(assets, 'style.css'), 'utf8');
        expect(node('lab-search-case')?.classList.contains('step')).toBe(false);
        expect(node('lab-search-close')?.classList.contains('step')).toBe(false);
        expect(css).toMatch(/\.root\[data-fit='tight'\] \.count \{ display: none; \}/);
        expect(css).toMatch(/\.count \{[^}]*flex: none;/);
        // And a pane that widens again gets the whole bar back, because the declaration never shrank.
        expect(await fitAt(800)).toBe('full');
        expect(input().title).toBe('');
    });

    /**
     * The hand-over the review found stranding a half-typed needle: ⌘F before this view painted opens
     * the NATIVE bar, the user types there, and the host feeds this view the needle as it goes. Until
     * the user types into THIS field it follows, so when the native bar stands down mid-word the
     * field already holds the needle and the caret is after it.
     */
    it('follows the needle it is handed until the user types into its own field', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        // Kelpi shows the bar and focuses the frame, which puts the caret in the field.
        globalThis.dispatchEvent(new FocusEvent('focus'));
        await until(() => document.activeElement === input(), 'the field to take the caret when shown');
        // Typed into the native bar, and handed over while the field here has the caret.
        window.publish({ needle: 'ne' });
        h.refresh();
        await until(() => input().value === 'ne', 'the field to follow the handed needle');
        expect(input().selectionStart).toBe(2);
        window.publish({ needle: 'needle' });
        h.refresh();
        await until(() => input().value === 'needle', 'the field to keep following');
        // Once the user types here, the field is theirs: a stale echo does not overwrite it.
        await type(h, 'needles');
        window.publish({ needle: 'needle' });
        h.refresh();
        await flush();
        expect(input().value).toBe('needles');
    });

    /**
     * A session's first frame arrives while Kelpi's own bar is still drawing, and a field that
     * focused itself then would pull the caret out of the bar the user is typing into. So seeding
     * places the caret and takes focus only when this document already has it.
     */
    it('does not take the caret on its first frame unless its own document has focus', async () => {
        const unfocused = make({ ...SESSION, needle: 'anchor' });
        const h = await mount(unfocused);
        await ready(h);
        await until(() => input().value === 'anchor', 'the field to be seeded');
        expect(document.hasFocus()).toBe(false);
        expect(document.activeElement).not.toBe(input());
        expect(input().selectionStart).toBe('anchor'.length);
        while (cleanups.length > 0) cleanups.pop()?.();
        vi.unstubAllGlobals();

        const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        try {
            const h2 = await mount(make({ ...SESSION, needle: 'anchor' }));
            await ready(h2);
            await until(() => document.activeElement === input(), 'the field to take the caret');
        } finally {
            focused.mockRestore();
        }
    });

    /**
     * The focus hop: the host focuses the FRAME, and waiting for the next delivered frame to focus
     * the field left a window in which a fast keystroke landed on the body and was lost.
     */
    it('puts the caret in the field the moment its frame gains focus', async () => {
        const window = make({ ...SESSION, needle: 'anchor' });
        const h = await mount(window);
        await ready(h);
        await until(() => input().value === 'anchor', 'the field to be seeded');
        input().blur();
        expect(document.activeElement).not.toBe(input());
        globalThis.dispatchEvent(new FocusEvent('focus'));
        expect(document.activeElement).toBe(input());
        expect(input().selectionStart).toBe('anchor'.length);
    });

    /**
     * A short pane grants a short box, and a bar measured under that height would declare it and
     * never ask for more again. The measurement lifts the height ceiling as well as the width one.
     */
    it('declares the height it wants on a short pane, so a pane that grows gets it back', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await until(() => window.state.declared !== null, 'the first declaration');
        expect(window.state.declared!.height).toBe(34);
        // A quarter of a 100 px pane is 25: the box is clamped, the declaration must not follow it.
        window.state.pane = { x: 0, y: 0, width: 800, height: 100 };
        h.refresh();
        await until(() => bar().style.maxHeight === '25px', 'the short box');
        for (let index = 0; index < 3; index += 1) {
            h.refresh();
            await flush();
        }
        expect(window.state.declared!.height).toBe(34);
        window.state.pane = PANE;
        h.refresh();
        await until(() => window.projection().frame.box?.height === 34, 'the full height back');
    });

    /**
     * The hand-over hook. A boot asked to hold keeps painting and acknowledging frames behind
     * Kelpi's own bar, and reports readiness only when released - recording what it held at that
     * moment, which is what the live scenario reads back.
     */
    it('holds its readiness report on a boot asked to, while frames keep arriving', async () => {
        const storage = new Map<string, unknown>([['holdReadyOnNextBoot', true]]);
        const window = make(SESSION);
        const h = await mount(window, { storage });
        await until(() => h.lab()?.held === true && h.lab()?.paintedAt !== null, 'the boot to paint and hold');
        // The request is consumed: the boot after this one does not hold.
        expect(storage.get('holdReadyOnNextBoot')).toBe(false);
        expect(h.readied()).toBe(0);
        // The native bar hands over a needle while this one is held, and the frame still arrives.
        window.publish({ needle: 'NE' });
        h.refresh();
        await until(() => input().value === 'NE', 'the handed needle to arrive while held');
        expect(h.readied()).toBe(0);
        h.lab().releaseReady();
        await ready(h);
        expect(h.readied()).toBe(1);
        expect(h.lab().held).toBe(false);
        expect(h.lab().readyNeedle).toBe('NE');
        expect(h.lab().readyFrameNeedle).toBe('NE');
        // Handed in by the host, not typed here.
        expect(h.lab().readyTyped).toBe(false);
        expect(typeof h.lab().readyAt).toBe('number');
    });

    it('asks the next boot to hold through plugin storage', async () => {
        const storage = new Map<string, unknown>();
        const h = await mount(make(null), { storage });
        await ready(h);
        await h.lab().holdNextBoot();
        expect(storage.get('holdReadyOnNextBoot')).toBe(true);
    });

    it('never re-sends a declaration that has not changed', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await until(() => h.sent('ui.setSearchBoxSize').length > 0, 'the first declaration');
        const before = h.sent('ui.setSearchBoxSize').length;
        for (let index = 0; index < 5; index += 1) {
            h.refresh();
            await flush();
        }
        expect(h.sent('ui.setSearchBoxSize')).toHaveLength(before);
    });

    it('has its declaration clamped by the host rather than honoured as asked', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        h.lab().declare({ width: 9_999, height: 9_999 });
        await flush();
        h.refresh();
        await until(() => (window.projection().frame.box?.width ?? 0) === PANE_SEARCH_LIMITS.maxWidth, 'the clamp');
        const box = window.projection().frame.box!;
        expect(box.width).toBe(PANE_SEARCH_LIMITS.maxWidth);
        // A quarter of a 600 px pane is 150, so 96 is the smaller ceiling and the one that applies.
        expect(box.height).toBe(PANE_SEARCH_LIMITS.maxHeight);
        // And it still sits at the pane's trailing edge, not off it.
        expect(box.x + box.width).toBe(PANE.width - PANE_SEARCH_LIMITS.margin);
    });

    it('hands the box back with null, and the native default comes straight back', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        h.lab().declare({ width: 400, height: 60 });
        await flush();
        h.refresh();
        await until(() => (window.projection().frame.box?.width ?? 0) === 400, 'the declared box');
        // The withdrawal reaches the host, and the clamp answers with the native default again.
        const withdrawn: Array<{ width: number; height: number } | null> = [];
        const watch = setInterval(() => withdrawn.push(window.state.declared), 1);
        h.lab().declare(null);
        expect(h.sent('ui.setSearchBoxSize').at(-1)).toEqual({ paneID: 'pane-1', size: null });
        expect(window.state.declared).toBeNull();
        expect(window.projection().frame.box?.width).toBe(PANE_SEARCH_LIMITS.nativeWidth);
        await flush();
        clearInterval(watch);
        // And then the lab measures again and declares what it drew, which is the point of the pin
        // being RELEASED rather than the box staying at the native default for ever.
        h.refresh();
        await until(() => window.state.declared !== null, 'the lab to declare what it drew');
        expect(window.state.declared).not.toEqual({ width: 400, height: 60 });
    });

    it('refuses a pane the frame does not name, and nothing runs', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        const before = window.actions.length;
        await expect(h.send('ui.setSearchNeedle', { paneID: 'pane-2', text: 'x' })).rejects.toThrow(
            'That pane is not the one being searched.'
        );
        await expect(h.send('ui.searchNext', { paneID: 'forged' })).rejects.toThrow(
            'That pane is not the one being searched.'
        );
        expect(window.actions).toHaveLength(before);
    });

    it('refuses every call while no search is open, so a presenter cannot open one', async () => {
        const window = make(null);
        const h = await mount(window);
        await ready(h);
        for (const [method, args] of [
            ['ui.setSearchNeedle', { paneID: 'pane-1', text: 'x' }],
            ['ui.searchNext', { paneID: 'pane-1' }],
            ['ui.closeSearch', { paneID: 'pane-1' }]
        ] as const) {
            await expect(h.send(method, args as JsonObject)).rejects.toThrow('No search is open for this presenter.');
        }
        expect(window.actions).toEqual([]);
    });

    it('refuses a needle past the cap or with a line break in it', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        const before = window.actions.length;
        await expect(
            h.send('ui.setSearchNeedle', { paneID: 'pane-1', text: 'x'.repeat(PANE_SEARCH_LIMITS.needleChars + 1) })
        ).rejects.toThrow(/single line of at most/);
        await expect(h.send('ui.setSearchNeedle', { paneID: 'pane-1', text: 'a\nb' })).rejects.toThrow(
            /single line of at most/
        );
        expect(window.actions).toHaveLength(before);
    });

    it('carries no scrollback, no path, no workspace id and no plugin id in any frame it holds', async () => {
        const window = make({ ...SESSION, needle: 'anchor', total: 3, selected: 1 });
        const h = await mount(window);
        await ready(h);
        const serialised = JSON.stringify(h.lab().snapshot);
        for (const forbidden of ['scrollback', 'workspaceID', 'pluginID', 'testID', 'Users', 'panes']) {
            expect(serialised).not.toContain(forbidden);
        }
        expect(Object.keys(h.lab().snapshot!).sort()).toEqual([
            'box',
            'caseSensitive',
            'formFactor',
            'kind',
            'match',
            'needle',
            'needleTruncated',
            'paneID',
            'placement',
            'selected',
            'total',
            'visible'
        ]);
    });

    it('says so when the needle it was handed is longer than the frame can carry', async () => {
        const window = make({ ...SESSION, needle: 'x'.repeat(PANE_SEARCH_LIMITS.needleChars + 40) });
        const h = await mount(window);
        await ready(h);
        await until(() => h.lab().snapshot?.needleTruncated === true, 'the truncation to be reported');
        expect(h.lab().snapshot!.needle).toHaveLength(PANE_SEARCH_LIMITS.needleChars);
        expect(node('lab-search-count')?.title).toMatch(/longer than this bar can carry/);
    });

    it('fails the placement when the view throws where nothing catches it', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        h.lab().crash('listener');
        window.publish({ needle: 'anchor' });
        h.refresh();
        await until(() => h.lab().lastError !== null, 'the crash to be recorded');
        // A listener that merely throws is caught by the SDK and its frame is STILL acknowledged:
        // an acknowledgement proves a frame reached the sandbox, never that the view drew it.
        expect(h.thrown.map((error) => error.message)).toContain('Search Lab crashed on purpose.');
    });

    it('stops acknowledging once stalled, which is what the watchdog waits on', async () => {
        const window = make(null);
        const h = await mount(window);
        await ready(h);
        const before = h.acknowledged();
        h.lab().stall();
        window.open(SESSION);
        h.refresh();
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 30));
        // The frame that OPENS a session is the one the host waits for, and it never settles.
        expect(h.awaitedFrames()).toBeGreaterThan(0);
        expect(h.acknowledged()).toBe(before);
    });

    it('asks for no acknowledgement for a needle delta, so typing cannot fail a working presenter', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        const before = h.awaitedFrames();
        await type(h, 'anchor');
        window.publish({ total: 9, selected: 1 });
        h.refresh();
        await flush();
        expect(h.awaitedFrames()).toBe(before);
    });

    it('stays inside its own document: every call goes through the SDK', async () => {
        const window = make(SESSION);
        const h = await mount(window);
        await ready(h);
        await type(h, 'anchor');
        press('lab-search-next');
        press('lab-search-case');
        press('lab-search-close');
        await flush();
        // Every method the lab used is one of the eight declared ones, and nothing else was called.
        expect([...new Set(h.calls.map((entry) => entry.method))].sort()).toEqual([
            'ui.closeSearch',
            'ui.reportPresenterReady',
            'ui.searchNext',
            'ui.setSearchBoxSize',
            'ui.setSearchCaseSensitive',
            'ui.setSearchNeedle'
        ]);
    });
});
