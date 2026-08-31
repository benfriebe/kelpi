/**
 * The menu-bar tray's GESTURES (§AGNT-086 / §APP-088; UI-FIDELITY U2, defect N16).
 *
 * `vitest.config.mts` says anything importing `electron` is left to `scripts/smoke.mjs`, and
 * that holds for everything in `status.ts` that needs a live window, a real socket or a real
 * menu bar. It does not hold for the part this file is about: which EVENTS the shell hands the
 * `Tray` a handler for, and what the menu it hands `setContextMenu` contains. Both are decided
 * in the main process before any window exists, from values a fake `Tray`/`Menu` can record —
 * so they are ordinary unit assertions, and the module's own `socketFactory` seam keeps the
 * daemon out of it.
 *
 * What they are guarding: macOS opens a tray's context menu on a LEFT click, and Electron
 * delivers a `click` event alongside it. The port registered `tray.on('click', () =>
 * host.showWindow())` next to `setContextMenu`, so one click both opened the menu AND pulled
 * the window forward under it — where the shipped app's status item does exactly one thing,
 * `togglePopover`, with no `activate` and no window raise (`StatusBarController.swift:32-39,
 * 117-126`). Raising the window is a row the user picks ("Show Kelpi", or a pane row), never a
 * side effect of looking at the menu.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSocket } from 'ws';

import type { DaemonLocation } from './daemon.js';
import { setLogStreams } from './log.js';

/**
 * The recorders the `electron` mock writes into. `vi.hoisted` because `vi.mock`'s factory runs
 * before the module body — this is the only way the test can hold a reference to what the mock
 * hands the module under test.
 */
const electronMock = vi.hoisted(() => {
    class FakeTray {
        /** Every event name the shell asked for a handler for. Parity says: none. */
        readonly listenedEvents: string[] = [];
        private readonly handlers = new Map<string, (...args: unknown[]) => void>();
        menu: unknown = null;
        tooltip = '';
        contextMenuCalls = 0;
        destroyed = false;

        constructor(public image: unknown) {
            trays.push(this);
        }

        on(event: string, handler: (...args: unknown[]) => void): this {
            this.listenedEvents.push(event);
            this.handlers.set(event, handler);
            return this;
        }

        once(event: string, handler: (...args: unknown[]) => void): this {
            this.listenedEvents.push(event);
            this.handlers.set(event, handler);
            return this;
        }

        addListener(event: string, handler: (...args: unknown[]) => void): this {
            this.listenedEvents.push(event);
            this.handlers.set(event, handler);
            return this;
        }

        /** What macOS does to a tray that has a context menu: opens it, and fires this too. */
        emit(event: string): void {
            this.handlers.get(event)?.();
        }

        /** Electron's `Tray` is an EventEmitter; the shell logs this count (`handlers=`). */
        eventNames(): string[] {
            return [...this.handlers.keys()];
        }

        setImage(image: unknown): void {
            this.image = image;
        }

        setToolTip(value: string): void {
            this.tooltip = value;
        }

        setContextMenu(menu: unknown): void {
            this.menu = menu;
            this.contextMenuCalls += 1;
        }

        destroy(): void {
            this.destroyed = true;
        }
    }

    const trays: FakeTray[] = [];

    const Menu = {
        buildFromTemplate(template: unknown[]): { template: unknown[] } {
            return { template };
        }
    };

    const dock = {
        setBadge: (_label: string): void => {},
        bounce: (_type: string): string => 'bounce'
    };

    return {
        trays,
        FakeTray,
        Menu,
        dock,
        app: { getVersion: (): string => '0.0.0-test', dock },
        nativeImage: {
            /** `status.ts` builds the tray image as an empty image plus one PNG per scale factor. */
            createEmpty: (): {
                representations: { scaleFactor?: number; dataURL?: string }[];
                template: boolean | null;
                addRepresentation: (options: { scaleFactor?: number; dataURL?: string }) => void;
                setTemplateImage: (value: boolean) => void;
            } => {
                const image = {
                    representations: [] as { scaleFactor?: number; dataURL?: string }[],
                    template: null as boolean | null,
                    addRepresentation(options: { scaleFactor?: number; dataURL?: string }): void {
                        image.representations.push(options);
                    },
                    setTemplateImage(value: boolean): void {
                        image.template = value;
                    }
                };
                return image;
            }
        },
        nativeTheme: {
            shouldUseDarkColors: false,
            on: (_event: string, _handler: () => void): void => {},
            off: (_event: string, _handler: () => void): void => {}
        },
        Notification: class {
            static isSupported(): boolean {
                return false;
            }
        }
    };
});

vi.mock('electron', () => ({
    Tray: electronMock.FakeTray,
    Menu: electronMock.Menu,
    Notification: electronMock.Notification,
    app: electronMock.app,
    nativeImage: electronMock.nativeImage,
    nativeTheme: electronMock.nativeTheme
}));

const { createStatusController } = await import('./status.js');

/** A `ws` stand-in: records what was sent, and lets the test play the daemon. */
interface FakeSocket {
    readonly sent: string[];
    readyState: number;
    on(event: string, handler: (...args: unknown[]) => void): FakeSocket;
    send(data: string): void;
    close(): void;
    removeAllListeners(): void;
    emit(event: string, ...args: unknown[]): void;
}

function createFakeSocket(): FakeSocket {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const socket: FakeSocket = {
        sent: [],
        // `WebSocket.OPEN`; `revealPane` refuses to send on anything else.
        readyState: 1,
        on(event, handler) {
            handlers.set(event, handler);
            return socket;
        },
        send(data) {
            socket.sent.push(data);
        },
        close() {},
        removeAllListeners() {
            handlers.clear();
        },
        emit(event, ...args) {
            handlers.get(event)?.(...args);
        }
    };
    return socket;
}

function createHost() {
    return {
        showWindow: vi.fn(),
        isWindowFocused: vi.fn(() => false),
        startDaemon: vi.fn(),
        quit: vi.fn(),
        revealPane: vi.fn()
    };
}

const LOCATION = {
    url: 'http://127.0.0.1:0',
    port: 0,
    token: 'test-token',
    pid: undefined,
    spawned: false,
    paths: {}
} as unknown as DaemonLocation;

type MenuRow = { label?: string; type?: string; enabled?: boolean; click?: () => void };

/** The template the tray's context menu was last built from. */
function menuTemplate(tray: InstanceType<typeof electronMock.FakeTray>): MenuRow[] {
    const menu = tray.menu as { template?: unknown[] } | null;
    return (menu?.template ?? []) as MenuRow[];
}

function rowLabelled(tray: InstanceType<typeof electronMock.FakeTray>, label: string): MenuRow | undefined {
    return menuTemplate(tray).find((row) => row.label === label);
}

/** The handshake, so `ready` is true and the menu carries rows rather than "not connected". */
const WELCOME = JSON.stringify({ type: 'welcome', daemon: { version: '0.0.0-test', pid: 1 }, settings: {} });

/** Enough of a `snapshot` frame for the agent model: one workspace, one waiting pane. */
const WAITING_SNAPSHOT = JSON.stringify({
    type: 'snapshot',
    state: {
        workspaces: [
            {
                id: 'w1',
                name: 'alpha',
                panes: [{ id: 'p1', status: 'waitingForInput', title: 'claude', label: null }]
            }
        ]
    }
});

describe('the tray gesture (§AGNT-086 / §APP-088 — UI-FIDELITY U2)', () => {
    let host: ReturnType<typeof createHost>;
    let socket: FakeSocket;
    let controller: ReturnType<typeof createStatusController>;
    let logged: string[];

    beforeEach(() => {
        logged = [];
        setLogStreams({
            out: {
                write: (chunk: string) => {
                    logged.push(chunk);
                    return true;
                }
            },
            err: { write: () => true }
        });
        electronMock.trays.length = 0;
        host = createHost();
        socket = createFakeSocket();
        controller = createStatusController({
            location: LOCATION,
            host,
            socketFactory: () => socket as unknown as WebSocket
        });
        controller.start();
    });

    /** Play the daemon: the socket opens, hands a `welcome`, then a snapshot with one agent. */
    function connect(): void {
        socket.emit('open');
        socket.emit('message', WELCOME, false);
        socket.emit('message', WAITING_SNAPSHOT, false);
    }

    afterEach(() => {
        controller.stop();
        setLogStreams({ out: process.stdout, err: process.stderr });
    });

    it('gives the tray NO event handler — the context menu is the whole gesture', () => {
        const tray = electronMock.trays[0];
        expect(tray).toBeDefined();
        // Not "no click handler": no handler at all. macOS routes a left-click, a right-click
        // and a double-click to the same context menu, so any of the three raising a window
        // would be the same defect wearing a different event name (N16's sweep).
        expect(tray?.listenedEvents).toEqual([]);
        expect(tray?.contextMenuCalls).toBeGreaterThan(0);
    });

    it('says so in its own log, from the tray’s registry — the only view from outside', () => {
        // A native tray cannot be screenshotted or introspected from another process, so
        // `handlers=` is what `smoke.mjs` and the audit have to go on. It is a COUNT off the
        // real object (`tray.eventNames()`), which is why it is worth asserting at all.
        const ready = logged.find((line) => line.includes('tray ready'));
        expect(ready).toBeDefined();
        expect(ready).toContain('handlers=0');
    });

    /** What `trayImage` hands the tray: the mock's empty-image shape, filled in. */
    function trayImageShape(): { representations: { scaleFactor?: number; dataURL?: string }[]; template: boolean | null } {
        const tray = electronMock.trays[0];
        expect(tray).toBeDefined();
        return tray?.image as ReturnType<(typeof electronMock)['nativeImage']['createEmpty']>;
    }

    it('hands the tray a 16pt image with a real @2x representation', () => {
        // One PNG per scale factor on one empty image — NSImage's points + retina backings.
        // A bare `createFromDataURL` of the 2x PNG would be a 32-POINT image in the menu bar.
        const image = trayImageShape();
        expect(image.representations.map((rep) => rep.scaleFactor)).toEqual([1, 2]);
        for (const rep of image.representations) expect(rep.dataURL).toMatch(/^data:image\/png;base64,/);
        // …and the two backings really are different renders, not one PNG registered twice.
        expect(image.representations[0]?.dataURL).not.toBe(image.representations[1]?.dataURL);
        // Boot state is `disconnected` — a dotted state, which cannot be a template (§AGNT-087).
        expect(image.template).toBe(false);
    });

    it('flips to a template image when the daemon connects with nothing running (§AGNT-087)', () => {
        socket.emit('open');
        socket.emit('message', WELCOME, false);
        socket.emit('message', JSON.stringify({ type: 'snapshot', state: { workspaces: [] } }), false);
        const image = trayImageShape();
        // Idle carries no status dot, so the glyph tints with the menu bar.
        expect(image.template).toBe(true);
        expect(image.representations.map((rep) => rep.scaleFactor)).toEqual([1, 2]);
    });

    it('never raises the window on its own — not on boot, not on the click macOS still fires', () => {
        // The whole boot path: create the tray, publish, connect, take a snapshot. The Swift
        // status item raises nothing until a popover row is clicked, and neither does this.
        connect();
        expect(host.showWindow).not.toHaveBeenCalled();
        // …and then the gesture itself. macOS opens the context menu on a left-click and
        // Electron emits `click`, `double-click` and `right-click` next to it; with no handler
        // registered every one of them is inert, which is the whole of the fix.
        const tray = electronMock.trays[0];
        for (const event of ['click', 'double-click', 'right-click']) tray?.emit(event);
        expect(host.showWindow).not.toHaveBeenCalled();
    });

    it('keeps window-raising reachable: the menu carries a plain "Show Kelpi" row', () => {
        const tray = electronMock.trays[0];
        const row = rowLabelled(tray as InstanceType<typeof electronMock.FakeTray>, 'Show Kelpi');
        expect(row).toBeDefined();
        expect(row?.enabled).not.toBe(false);
        row?.click?.();
        expect(host.showWindow).toHaveBeenCalledTimes(1);
    });

    it('keeps the popover’s own path too: a pane row raises AND reveals (§AGNT-093)', () => {
        connect();
        const tray = electronMock.trays[0];
        const paneRow = menuTemplate(tray as InstanceType<typeof electronMock.FakeTray>).find(
            (row) => row.label?.includes('claude') === true && row.click !== undefined
        );
        expect(paneRow).toBeDefined();
        paneRow?.click?.();
        expect(host.showWindow).toHaveBeenCalledTimes(1);
        expect(host.revealPane).toHaveBeenCalledWith('w1', 'p1');
    });
});

describe('the tray gesture — no handler creeps back in anywhere else (N16 sweep)', () => {
    it('no file in the shell registers a Tray event handler', () => {
        const src = path.dirname(fileURLToPath(import.meta.url));
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                    continue;
                }
                if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
                const lines = fs
                    .readFileSync(full, 'utf8')
                    .split('\n')
                    // Comments only DISCUSS a handler — this file's own reasoning, and
                    // `status.ts`'s, both name the call they are arguing against.
                    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line));
                // `tray.on(…)` / `tray.once(…)` in any casing of the receiver. The one Tray this
                // app owns is `status.ts`'s; a second one would still be caught by the name.
                const hit = lines.find((line) => /\b[Tt]ray\w*\.(?:on|once|addListener)\(/.test(line));
                if (hit !== undefined) offenders.push(`${path.relative(src, full)}: ${hit.trim()}`);
            }
        };
        walk(src);
        // A tray event handler is not automatically wrong — but macOS delivers `click`,
        // `double-click` and `right-click` for the gesture that ALREADY opens the context menu,
        // so any new one has to be argued against `StatusBarController.swift:32-39,117-126`
        // first (UI-FIDELITY U2 / N16), and this test is where that argument gets written down.
        expect(offenders).toEqual([]);
    });
});
