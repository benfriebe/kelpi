/**
 * Test doubles for the terminal layer — a scripted renderer and a scripted PTY API.
 *
 * Exported (not hidden in `__tests__`) for the same reason `connection/testing.ts` is: the
 * grid and assembly work packages need to render a `TerminalPane` in jsdom, where no engine
 * can open (no canvas 2D context), so they inject `createRenderer={fakeRendererFactory()}`.
 */

import type { WsVtModes } from '@kelpi/protocol';

import type { FormFactorWindow } from '../chrome/form-factor';
import type { PtyStreamHandle, PtySubscription } from '../connection';
import type {
    CellSize,
    TerminalEngine,
    TerminalMatchLocation,
    TerminalRenderer,
    TerminalRendererFactory,
    TerminalRendererOptions,
    TerminalTheme
} from './renderer';

const decoder = new TextDecoder();

function asText(data: Uint8Array | string): string {
    return typeof data === 'string' ? data : decoder.decode(data);
}

export interface FakeRendererOptions {
    /** Cell metrics the fake reports; cols/rows are measured against these. */
    readonly cell?: CellSize;
    /** Leave `open()` pending until `settleOpen()` is called (engine-load race tests). */
    readonly deferOpen?: boolean;
    /** Reject `open()` (the "no 2D context" failure mode). */
    readonly failOpen?: boolean;
    /**
     * Reject `open()` on the first N renderers a FACTORY builds, then behave. That is the shape
     * of run-F N1: a start that dies on the shared WASM instance and comes straight up on a
     * fresh engine a moment later, which is what the pane's retry has to turn into a hiccup.
     */
    readonly failOpensBefore?: number;
    /** The error a failing `open()` rejects with; defaults to the N1 `RangeError`. */
    readonly openError?: () => Error;
    /**
     * §N35 — model the vendored engine's own `open()`, which ends with `this.focus()`.
     *
     * `Terminal.open()` creates a hidden `<textarea>` inside the host and focuses it —
     * "auto-focus so user can start typing immediately"
     * (`vendor/ghostty-web-patched/source/lib/terminal.ts:636`). It is unconditional, so it goes
     * around `shouldGrabFocus` entirely, and the fake could not express it. Off by default: only
     * the tests about who ends up with the caret ask for it.
     */
    readonly autoFocusOnOpen?: boolean;
}

export class FakeRenderer implements TerminalRenderer {
    readonly engine: TerminalEngine = 'xterm';
    cols = 80;
    rows = 24;

    /** Everything written, decoded, in order. */
    readonly writes: string[] = [];
    readonly resizes: { cols: number; rows: number }[] = [];
    readonly themes: TerminalTheme[] = [];
    resets = 0;
    focusCount = 0;
    blurCount = 0;
    /**
     * §N20 — every `setSurfaceFocus` report, in order.
     *
     * A list rather than a counter because the QUESTION is which state the surface is in and
     * how it got there: `[true, false]` (focused, then the window went away) and `[false]` (a
     * background pane that never had it) are different stories about the same final cursor.
     */
    readonly surfaceFocuses: boolean[] = [];
    repaints = 0;
    /** Every `revealMatch` the search overlay asked for, in order. */
    readonly revealed: TerminalMatchLocation[] = [];
    disposed = false;
    opened: HTMLElement | null = null;

    readonly ready: Promise<void>;

    /** The engine was abandoned mid-flight (`poison()`); it takes no further bytes. */
    failed = false;

    /**
     * §N24 — a fake has no canvas and no WASM cell storage, so it never holds its paint.
     * Present because `TerminalRenderer` declares it.
     */
    readonly paintHeld = false;
    readonly paintHoldTimeouts = 0;

    onPaintHoldChange(): () => void {
        return () => undefined;
    }

    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly bellListeners = new Set<() => void>();
    private readonly titleListeners = new Set<(title: string) => void>();
    private readonly selectionListeners = new Set<(selection: string) => void>();
    private readonly failureListeners = new Set<(error: unknown) => void>();
    /** What `selection()` reports; driven by `emitSelection` (§TERM-034). */
    private selected = '';
    private cell: CellSize;
    private settle: (() => void) | undefined;
    private fail: ((error: Error) => void) | undefined;

    constructor(
        readonly options: TerminalRendererOptions | undefined,
        private readonly fake: FakeRendererOptions = {},
        /** Which renderer this is, counting from 1 — `failOpensBefore` reads it. */
        readonly ordinal = 1
    ) {
        this.cell = fake.cell ?? { width: 10, height: 20 };
        const openError = fake.openError ?? ((): Error => new RangeError('offset is out of bounds'));
        const rejectThisOne = fake.failOpen === true || this.ordinal <= (fake.failOpensBefore ?? 0);
        if (fake.deferOpen === true) {
            this.ready = new Promise<void>((resolve, reject) => {
                this.settle = resolve;
                this.fail = reject;
            });
        } else if (rejectThisOne) {
            this.ready = Promise.reject(fake.failOpen === true ? new Error('Failed to get 2D rendering context') : openError());
            this.ready.catch(() => undefined);
        } else {
            this.ready = Promise.resolve();
        }
    }

    open(element: HTMLElement): Promise<void> {
        this.opened = element;
        if (this.fake.autoFocusOnOpen !== true) return this.ready;
        // The grab is the LAST thing the real `open()` does, so it happens when the engine has
        // finished coming up — not when the call is made. That ordering is the whole point: the
        // pane's own focus effect has long since run by then, which is why a release on
        // `focused === false` cannot cover this and the undo has to.
        return this.ready.then(() => {
            const area = element.ownerDocument.createElement('textarea');
            area.setAttribute('aria-label', 'Terminal input');
            element.appendChild(area);
            area.focus();
            // …and the engine's own delayed BACKUP focus (`terminal.ts:844-860`, "some browsers
            // may need this if DOM isn't fully settled"), which lands after any one-shot undo.
            setTimeout(() => area.focus(), 0);
        });
    }

    /** Resolve a deferred `open()`. */
    settleOpen(): void {
        this.settle?.();
        this.settle = undefined;
    }

    /** Reject a deferred `open()`. */
    failOpen(error = new Error('engine failed')): void {
        this.fail?.(error);
        this.fail = undefined;
    }

    write(data: Uint8Array | string): void {
        if (this.failed) return;
        this.writes.push(asText(data));
    }

    reset(): void {
        if (this.failed) return;
        this.resets += 1;
    }

    onEngineFailure(listener: (error: unknown) => void): () => void {
        this.failureListeners.add(listener);
        return () => this.failureListeners.delete(listener);
    }

    /**
     * The engine threw from inside itself after it was live — what `AdapterRenderer.poison()`
     * does when a ghostty-web `write()` raises `RangeError: offset is out of bounds`.
     */
    poison(error: unknown = new RangeError('offset is out of bounds')): void {
        if (this.failed) return;
        this.failed = true;
        for (const listener of [...this.failureListeners]) listener(error);
    }

    onData(listener: (data: string) => void): () => void {
        this.dataListeners.add(listener);
        return () => this.dataListeners.delete(listener);
    }

    onBell(listener: () => void): () => void {
        this.bellListeners.add(listener);
        return () => this.bellListeners.delete(listener);
    }

    onTitleChange(listener: (title: string) => void): () => void {
        this.titleListeners.add(listener);
        return () => this.titleListeners.delete(listener);
    }

    selection(): string {
        return this.selected;
    }

    onSelectionChange(listener: (selection: string) => void): () => void {
        this.selectionListeners.add(listener);
        return () => this.selectionListeners.delete(listener);
    }

    clearSelection(): void {
        if (this.selected === '') return;
        this.emitSelection('');
    }

    resize(cols: number, rows: number): void {
        this.cols = cols;
        this.rows = rows;
        this.resizes.push({ cols, rows });
    }

    focus(): void {
        this.focusCount += 1;
    }

    blur(): void {
        this.blurCount += 1;
    }

    /** §N20 — every surface-focus report, in order; the last one is the live state. */
    setSurfaceFocus(focused: boolean): void {
        this.surfaceFocuses.push(focused);
    }

    setTheme(theme: TerminalTheme): void {
        this.themes.push(theme);
    }

    /**
     * C2 - every `setTextInputAttributes` call, in order. Empty is the desktop assertion: a
     * desktop pane must never reach the renderer for this at all.
     */
    readonly textInputAttributes: Readonly<Record<string, string | null>>[] = [];

    setTextInputAttributes(attributes: Readonly<Record<string, string | null>>): void {
        this.textInputAttributes.push(attributes);
        // …and onto a real element, so a test can assert the DOM the keyboard would read rather
        // than the call that was made. The adapter finds the engine's own textarea; the fake
        // only has one when `autoFocusOnOpen` built it, which is the case that models the engine.
        const target = this.opened?.querySelector('textarea') ?? null;
        if (target === null) return;
        for (const [name, value] of Object.entries(attributes)) {
            if (value === null) target.removeAttribute(name);
            else target.setAttribute(name, value);
        }
    }

    cellSize(): CellSize {
        return this.cell;
    }

    setCellSize(cell: CellSize): void {
        this.cell = cell;
    }

    repaint(): void {
        this.repaints += 1;
    }

    revealMatch(match: TerminalMatchLocation): void {
        this.revealed.push(match);
    }

    dispose(): void {
        this.disposed = true;
        this.dataListeners.clear();
        this.bellListeners.clear();
        this.titleListeners.clear();
        this.selectionListeners.clear();
        this.failureListeners.clear();
    }

    // ── driving from a test ─────────────────────────────────────────────────────────

    /** The engine made (or cleared) a selection — what a drag does when nothing intercepts it. */
    emitSelection(selection: string): void {
        this.selected = selection;
        for (const listener of [...this.selectionListeners]) listener(selection);
    }

    /** The user typed: what the engine would emit on `onData`. */
    emitData(data: string): void {
        for (const listener of [...this.dataListeners]) listener(data);
    }

    emitBell(): void {
        for (const listener of [...this.bellListeners]) listener();
    }

    emitTitle(title: string): void {
        for (const listener of [...this.titleListeners]) listener(title);
    }
}

export interface FakeRendererFactory {
    readonly factory: TerminalRendererFactory;
    /** Every renderer built, oldest first. */
    readonly instances: FakeRenderer[];
    last(): FakeRenderer;
}

export function createFakeRendererFactory(fake: FakeRendererOptions = {}): FakeRendererFactory {
    const instances: FakeRenderer[] = [];
    return {
        factory: (options?: TerminalRendererOptions): TerminalRenderer => {
            const renderer = new FakeRenderer(options, fake, instances.length + 1);
            instances.push(renderer);
            return renderer;
        },
        instances,
        last(): FakeRenderer {
            const renderer = instances.at(-1);
            if (renderer === undefined) throw new Error('no renderer was created');
            return renderer;
        }
    };
}

export interface FakePaneStream {
    readonly paneID: string;
    readonly subscription: PtySubscription;
    readonly handle: PtyStreamHandle;
    /** Bytes the pane sent upstream, decoded. */
    readonly input: string[];
    readonly resizes: { cols: number; rows: number }[];
    unsubscribed: boolean;
    /** Push a daemon replay frame at the pane. */
    replay(data: string): void;
    /** Push live output at the pane. */
    output(data: string): void;
    exit(exitCode: number | null, signal?: string): void;
    resync(reason?: string): void;
    /**
     * Push a `pane-modes` update at the pane (§TERM-037). Partial: only the members a test
     * cares about, on top of "nothing set".
     */
    modes(modes: Partial<WsVtModes>): void;
}

export interface FakePtyApi {
    subscribe(paneID: string, subscription: PtySubscription): PtyStreamHandle;
    /** Every subscribe call, oldest first — a re-attach after eviction appends a new entry. */
    readonly streams: FakePaneStream[];
    last(): FakePaneStream;
}

const encoder = new TextEncoder();

export function createFakePtyApi(): FakePtyApi {
    const streams: FakePaneStream[] = [];
    const api: FakePtyApi = {
        subscribe(paneID: string, subscription: PtySubscription): PtyStreamHandle {
            const input: string[] = [];
            const resizes: { cols: number; rows: number }[] = [];
            const stream: FakePaneStream = {
                paneID,
                subscription,
                input,
                resizes,
                unsubscribed: false,
                handle: {
                    paneID,
                    write(data: Uint8Array | string): void {
                        input.push(asText(data));
                    },
                    resize(cols: number, rows: number): void {
                        resizes.push({ cols, rows });
                    },
                    ack(): void {
                        /* the fake has no flow control */
                    },
                    get unacked(): number {
                        return 0;
                    },
                    unsubscribe(): void {
                        stream.unsubscribed = true;
                    }
                },
                replay(data: string): void {
                    const bytes = encoder.encode(data);
                    if (subscription.onReplay !== undefined) subscription.onReplay(bytes);
                    else subscription.onData(bytes);
                },
                output(data: string): void {
                    subscription.onData(encoder.encode(data));
                },
                exit(exitCode: number | null, signal?: string): void {
                    subscription.onExit?.(exitCode, signal);
                },
                resync(reason = 'flow-control'): void {
                    subscription.onResync?.(reason);
                },
                modes(modes: Partial<WsVtModes>): void {
                    subscription.onModes?.({
                        applicationCursorKeys: false,
                        bracketedPaste: false,
                        mouseTracking: 'none',
                        mouseFormat: 'x10',
                        kittyKeyboardFlags: 0,
                        ...modes
                    });
                }
            };
            streams.push(stream);
            return stream.handle;
        },
        streams,
        last(): FakePaneStream {
            const stream = streams.at(-1);
            if (stream === undefined) throw new Error('no pane stream was subscribed');
            return stream;
        }
    };
    return api;
}

/** jsdom has no `ResizeObserver`; install a controllable one for a test file. */
export interface FakeResizeObservers {
    /** Fire every observer's callback (as a resize would). */
    trigger(): void;
    readonly observed: Element[];
    restore(): void;
}

export function installFakeResizeObserver(): FakeResizeObservers {
    const callbacks: (() => void)[] = [];
    const observed: Element[] = [];
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

    class StubResizeObserver {
        constructor(private readonly callback: () => void) {
            callbacks.push(() => this.callback());
        }
        observe(element: Element): void {
            observed.push(element);
        }
        unobserve(): void {
            /* no-op */
        }
        disconnect(): void {
            /* no-op */
        }
    }

    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
    return {
        trigger(): void {
            for (const callback of [...callbacks]) callback();
        },
        observed,
        restore(): void {
            (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
        }
    };
}

// ── a phone with a software keyboard (C2) ───────────────────────────────────────────

/**
 * A `FormFactorWindow` that answers `phone` and whose visual viewport a test can drive.
 *
 * Shared between `keyboard-inset.test.ts` and `TerminalPane.keyboard.test.tsx` because both need
 * exactly the same thing and it is the only way to have a software keyboard at all off a device:
 * jsdom has no layout, no `visualViewport` worth the name and no keyboard. `raiseKeyboard` models
 * what iOS actually does - the viewport shrinks over several ANIMATION frames, each one firing
 * `resize` - which is the input the settle rule exists to absorb.
 */
export interface FakePhoneWindow extends FormFactorWindow {
    /** Shrink the viewport to `innerHeight - inset` over `frames` resize events. */
    raiseKeyboard(inset: number, frames?: number): void;
    /** Restore it, over `frames` resize events. */
    lowerKeyboard(frames?: number): void;
    /** Every `resize` event the viewport has fired since the window was made. */
    viewportEvents(): number;
    /** Live listener count, so a test can pin that a desktop pane subscribes to nothing. */
    listenerCount(): number;
    /** Flip `(pointer: coarse)`, as pairing a Bluetooth mouse to an iPad does. */
    setPointer(next: boolean): void;
}

/** iPhone 14/15 in CSS px - the device MOBILE-PLAN.md names, and the audit's phone viewport. */
export const FAKE_PHONE_VIEWPORT = { width: 390, height: 844 };

export function createFakePhoneWindow(
    init: { width?: number; height?: number; coarse?: boolean } = {}
): FakePhoneWindow {
    const width = init.width ?? FAKE_PHONE_VIEWPORT.width;
    const height = init.height ?? FAKE_PHONE_VIEWPORT.height;
    let coarse = init.coarse ?? true;
    let viewportHeight = height;
    let fired = 0;
    const media = new Set<() => void>();
    const windowResize = new Set<() => void>();
    const viewportListeners = new Map<string, Set<() => void>>();
    const bucket = (type: string): Set<() => void> => {
        const existing = viewportListeners.get(type);
        if (existing !== undefined) return existing;
        const created = new Set<() => void>();
        viewportListeners.set(type, created);
        return created;
    };
    const fire = (type: string): void => {
        fired += 1;
        for (const listener of [...bucket(type)]) listener();
    };

    const step = (target: number, frames: number): void => {
        const from = viewportHeight;
        const count = Math.max(1, frames);
        for (let index = 1; index <= count; index += 1) {
            viewportHeight = Math.round(from + ((target - from) * index) / count);
            fire('resize');
        }
    };

    return {
        innerWidth: width,
        innerHeight: height,
        visualViewport: {
            width,
            get height(): number {
                return viewportHeight;
            },
            offsetTop: 0,
            addEventListener(type: string, listener: () => void): void {
                bucket(type).add(listener);
            },
            removeEventListener(type: string, listener: () => void): void {
                bucket(type).delete(listener);
            }
        },
        location: { search: '' },
        matchMedia(query: string) {
            return {
                get matches(): boolean {
                    return query === '(pointer: coarse)' ? coarse : false;
                },
                addEventListener(_type: 'change', listener: () => void): void {
                    media.add(listener);
                },
                removeEventListener(_type: 'change', listener: () => void): void {
                    media.delete(listener);
                }
            };
        },
        addEventListener(type: string, listener: () => void): void {
            if (type === 'resize') windowResize.add(listener);
        },
        removeEventListener(type: string, listener: () => void): void {
            windowResize.delete(listener);
        },
        raiseKeyboard(inset: number, frames = 15): void {
            step(height - inset, frames);
        },
        lowerKeyboard(frames = 15): void {
            step(height, frames);
        },
        viewportEvents(): number {
            return fired;
        },
        listenerCount(): number {
            let total = media.size + windowResize.size;
            for (const set of viewportListeners.values()) total += set.size;
            return total;
        },
        setPointer(next: boolean): void {
            coarse = next;
            for (const listener of [...media]) listener();
        }
    };
}
