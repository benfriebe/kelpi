/**
 * Test doubles for the terminal layer — a scripted renderer and a scripted PTY API.
 *
 * Exported (not hidden in `__tests__`) for the same reason `connection/testing.ts` is: the
 * grid and assembly work packages need to render a `TerminalPane` in jsdom, where no engine
 * can open (no canvas 2D context), so they inject `createRenderer={fakeRendererFactory()}`.
 */

import type { PtyStreamHandle, PtySubscription } from '../connection';
import type {
    CellSize,
    TerminalEngine,
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
    repaints = 0;
    disposed = false;
    opened: HTMLElement | null = null;

    readonly ready: Promise<void>;

    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly bellListeners = new Set<() => void>();
    private readonly titleListeners = new Set<(title: string) => void>();
    private cell: CellSize;
    private settle: (() => void) | undefined;
    private fail: ((error: Error) => void) | undefined;

    constructor(readonly options: TerminalRendererOptions | undefined, fake: FakeRendererOptions = {}) {
        this.cell = fake.cell ?? { width: 10, height: 20 };
        if (fake.deferOpen === true) {
            this.ready = new Promise<void>((resolve, reject) => {
                this.settle = resolve;
                this.fail = reject;
            });
        } else if (fake.failOpen === true) {
            this.ready = Promise.reject(new Error('Failed to get 2D rendering context'));
            this.ready.catch(() => undefined);
        } else {
            this.ready = Promise.resolve();
        }
    }

    open(element: HTMLElement): Promise<void> {
        this.opened = element;
        return this.ready;
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
        this.writes.push(asText(data));
    }

    reset(): void {
        this.resets += 1;
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

    setTheme(theme: TerminalTheme): void {
        this.themes.push(theme);
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

    dispose(): void {
        this.disposed = true;
        this.dataListeners.clear();
        this.bellListeners.clear();
        this.titleListeners.clear();
    }

    // ── driving from a test ─────────────────────────────────────────────────────────

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
            const renderer = new FakeRenderer(options, fake);
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
