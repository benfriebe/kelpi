/**
 * The driver: everything an agent needs to drive a Kelpi instance and check what happened, in
 * one import, against either a freshly booted sandbox or a dev instance that is already up.
 *
 * WHY THIS EXISTS
 * ---------------
 * The UI audit (`../audit.mjs`) can drive the app, but it is a 127-step regression battery in
 * one 29,000-line file: the helpers a scenario needs (click a context-menu row, open a settings
 * tab, right-click a sidebar row, press what an action is bound to, read the pane list off the
 * DOM) are private functions inside it, and the only way to exercise a new behaviour was to add
 * a step to the monolith. So nobody did: thirteen fix agents in one day verified UI behaviour
 * with unit tests alone, and the promote's "full audit passed" never exercised what they changed
 * (issues #47, #53, #55 were all only unit-verified). This module lifts those helpers out,
 * adds the two bootstraps (boot a sandbox, or attach to a running instance) and a client for the
 * shell's `KELPI_HARNESS_SOCKET` channel, which is how a scenario reaches the native surfaces
 * CDP cannot: the application menu and its accelerators, native dialogs, the dock.
 *
 * The helpers are COPIED from audit.mjs, not moved: the battery keeps working untouched, and a
 * later change can point it at this file. The duplication is the price of not editing a file
 * the phone campaign is mid-way through.
 *
 * TWO WAYS IN
 *   const t = await boot({ repoRoot })                      // own sandbox: daemon + shell + CDP
 *   const t = await boot({ repoRoot, window: 'hidden' })    // the same, without the screen (#65)
 *   const t = await attach({ debugPort, harnessSocket })    // a `dev-instance.mjs` already up
 * Both give `{ page, harness, ... }`; `boot` also gives `cli`, `sandbox`, `stop()`.
 *
 * `window` is the functional lane: `hidden`, `offscreen` or `onscreen`, and unset is the window
 * every scenario got before the lane existed. Hidden frees the machine's screen and lets several
 * runs overlap, at the cost of the screenshots; `boot`'s own doc has what each placement is worth
 * and the README has the measurements.
 *
 * The page object is `lib/cdp.mjs`'s: eval / waitFor / click(selector) / clickAt / rightClick /
 * key(code, {modifiers}) / type / drag / box / screenshot. `harness` is the shell channel:
 * menu() / menuClick({id|path}) / press(accelerator) / counters() / armDialog({response}) /
 * notificationClick({index, action}) / notificationClose({index}) / window() / focus() /
 * blur() / hide() / minimize() / restore(). See ../README.md for the scenario contract.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { MOD, connect, listTargets, sleep, waitForPageTarget } from './cdp.mjs';
import {
    buildAll,
    clearBackgroundTaskPolicy,
    makeCli,
    makeSandbox,
    startDaemon,
    startShell,
    waitForHealthz
} from './stack.mjs';

export { MOD, sleep };

// ── the DOM contract ────────────────────────────────────────────────────────────────

/** The `data-testid` anchors a scenario may rely on. Add here when you add one to the client. */
export const PAGE = {
    app: '[data-testid="kelpi-app"]',
    sidebar: '[data-testid="sidebar"]',
    workspaceRows: '[data-testid="workspace-row"]',
    grid: '[data-testid="pane-grid"]',
    footer: '[data-testid="status-footer"]',
    topBar: '[data-testid="top-bar"]',
    settingsPanel: '[data-testid="settings-panel"]',
    contextMenu: '[data-testid="context-menu"]',
    contextSubmenu: '[data-testid="context-submenu"]',
    confirmDialog: '[data-testid="confirm-dialog"]',
    titlebarMenuToggle: '[data-testid="titlebar-menu-toggle"]',
    helpClose: '[data-testid="help-close"]'
};

/** The client window's page target, as opposed to the web panes' WebContentsView targets. */
export const isClientWindow = (target) => String(target?.url ?? '').includes('shellWindow=');

/** Pane ids in DOM order, counted off the pane HEADERS (exactly one per pane). */
const paneIDsExpr = `Array.from(document.querySelectorAll('[data-testid^="pane-header-"]')).map(el => el.getAttribute('data-testid').slice('pane-header-'.length))`;

// ── the harness channel client ──────────────────────────────────────────────────────

/**
 * A client for the shell's `KELPI_HARNESS_SOCKET` channel (packages/shell/src/harness.ts):
 * newline-delimited JSON requests with an id, one response line each.
 */
export function harnessClient(socketPath, { timeoutMs = 10_000 } = {}) {
    let socket = null;
    let buffer = '';
    let nextID = 1;
    const pending = new Map();

    const open = () =>
        new Promise((resolve, reject) => {
            const s = net.createConnection(socketPath);
            s.setEncoding('utf8');
            s.once('connect', () => resolve(s));
            s.once('error', reject);
            s.on('data', (chunk) => {
                buffer += chunk;
                let index;
                while ((index = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, index);
                    buffer = buffer.slice(index + 1);
                    if (line.trim() === '') continue;
                    let message;
                    try {
                        message = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    const waiter = pending.get(message.id);
                    if (waiter === undefined) continue;
                    pending.delete(message.id);
                    clearTimeout(waiter.timer);
                    if (message.ok) waiter.resolve(message.result);
                    else waiter.reject(new Error(`harness ${waiter.op}: ${String(message.error)}`));
                }
            });
            s.on('close', () => {
                for (const [id, waiter] of pending) {
                    pending.delete(id);
                    clearTimeout(waiter.timer);
                    waiter.reject(new Error(`harness ${waiter.op}: socket closed`));
                }
            });
        });

    const request = async (op, fields = {}) => {
        if (socket === null) socket = await open();
        const id = nextID++;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`harness ${op}: no reply within ${String(timeoutMs)} ms`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer, op });
            socket.write(`${JSON.stringify({ id, op, ...fields })}\n`);
        });
    };

    return {
        path: socketPath,
        ping: () => request('ping'),
        /** The application menu as a tree of { id, label, accelerator, enabled, visible, type, role, checked, submenu }. */
        menu: () => request('menu'),
        /** Click a menu item by `id` or by label `path` (['View', 'Toggle Sidebar']). */
        menuClick: (target) => request('menu-click', target),
        /** Land a native accelerator: clicks the first enabled menu item bound to it. */
        press: (accelerator) => request('press', { accelerator }),
        /** { dockBounces, lastBounce, dialogs, lastDialog, notifications, lastNotification, recentNotifications }. */
        counters: () => request('counters'),
        /** The NEXT native dialog resolves with this instead of showing. One-shot. */
        armDialog: ({ response, checkboxChecked = false }) => request('dialog-arm', { response, checkboxChecked }),
        /**
         * Click a notification the shell showed, as the OS would (#67): the body tap, or the
         * named action button ('Open' / 'Dismiss', agent-lifecycle.md §7.5). `index` is a
         * position in `counters().recentNotifications` (newest last, negatives from the end);
         * omitted means the most recent one.
         */
        notificationClick: ({ index, action } = {}) =>
            request('notification-click', {
                ...(index === undefined ? {} : { index }),
                ...(action === undefined ? {} : { action })
            }),
        /** Close one, firing its close handler exactly as a swiped-away banner does. */
        notificationClose: ({ index } = {}) => request('notification-close', index === undefined ? {} : { index }),
        window: () => request('window'),
        focus: () => request('focus'),
        blur: () => request('blur'),
        /**
         * What ⌘H / ⌘M do, and the two events that undo them (#75). Each answers
         * `{ visible, minimized }` read back AFTER the call, or nulls with no window.
         *
         * These are real `BrowserWindow` calls: the shell parks every web pane's view on `hide`
         * and `minimize` and restores it on `show` and `restore`, so a scenario that wants that
         * behaviour has to move the actual window. `menu-click` refuses role rows, which is why
         * ⌘H cannot be driven through the menu.
         */
        hide: () => request('hide'),
        minimize: () => request('minimize'),
        restore: () => request('restore'),
        close() {
            socket?.end();
            socket = null;
        }
    };
}

/** Walk a harness `menu()` tree; returns the first node whose label matches `needle` (string or RegExp). */
export function findMenuItem(items, needle) {
    const test = needle instanceof RegExp ? (label) => needle.test(label) : (label) => label.toLowerCase() === String(needle).toLowerCase();
    for (const item of items ?? []) {
        if (test(item.label ?? '')) return item;
        if (item.submenu) {
            const hit = findMenuItem(item.submenu, needle);
            if (hit !== null) return hit;
        }
    }
    return null;
}

// ── settle-waits ────────────────────────────────────────────────────────────────────

/** Poll `predicate` until true, at most `ceilingMs`. Returns true if it became true. */
export async function settle(predicate, { ceilingMs = 5_000, intervalMs = 50 } = {}) {
    const deadline = Date.now() + ceilingMs;
    for (;;) {
        if (await predicate()) return true;
        if (Date.now() > deadline) return false;
        await sleep(intervalMs);
    }
}

/** Poll a page expression until it is truthy. */
export async function settleDom(page, expression, options = {}) {
    return await settle(async () => (await page.eval(`Boolean(${expression})`)) === true, { intervalMs: 40, ...options });
}

// ── app helpers (lifted from audit.mjs) ─────────────────────────────────────────────

/** Pane ids in DOM order, the way a user points at them. */
export async function domPaneIDs(page) {
    return (await page.eval(paneIDsExpr)) ?? [];
}

export async function clickPaneHeader(page, paneID) {
    const box = await page.box(`[data-testid="pane-header-${paneID}"]`);
    if (box === null) throw new Error(`no pane header for ${paneID}`);
    await page.clickAt(box.x + Math.min(14, box.width / 4), box.y + box.height / 2);
    await sleep(200);
    return box;
}

export async function focusPaneBody(page, paneID) {
    const box = await page.box(`[data-testid="pane-body-${paneID}"]`);
    if (box === null) throw new Error(`no pane body for ${paneID}`);
    await page.clickAt(box.x + Math.min(60, box.width / 2), box.y + Math.min(40, box.height / 2));
    await sleep(200);
    return box;
}

/** Type a shell command into the focused terminal and press Return. */
export async function runInTerminal(page, command, { settleMs = 900 } = {}) {
    await page.type(command);
    await page.key('Enter');
    await sleep(settleMs);
}

export async function openSettingsRoot(page) {
    await page.key('Comma', { modifiers: MOD.meta });
    await settleDom(page, `document.querySelector('${PAGE.settingsPanel}')`, { ceilingMs: 3_000 });
}

export async function openSettingsTab(page, tab) {
    await openSettingsRoot(page);
    await page.click(`[data-testid="settings-tab-button-${tab}"]`);
    await settleDom(page, `document.querySelector('[data-testid="settings-tab-${tab}"]')`, { ceilingMs: 3_000 });
}

/** Click a context-menu row by its visible label (a checked row's leading tick is ignored). */
export async function clickMenuItem(page, label) {
    const clicked = await page.eval(
        `(() => {
            const menu = document.querySelector('${PAGE.contextMenu}');
            if (menu === null) return 'no-menu';
            const text = (el) => (el.textContent ?? '').trim().replace(/^[✓✔]\\s*/, '');
            const rows = Array.from(menu.querySelectorAll('[role="menuitem"]'));
            const row = rows.find(el => text(el).startsWith(${JSON.stringify(label)}));
            if (row === undefined) return 'no-row:' + rows.map(r => (r.textContent ?? '').trim()).join('/');
            const r = row.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
    );
    if (typeof clicked !== 'string' || !clicked.startsWith('{')) {
        throw new Error(`context menu item "${label}" not found (${String(clicked)})`);
    }
    const point = JSON.parse(clicked);
    await page.clickAt(point.x, point.y);
    await sleep(300);
}

/** Open a submenu by HOVERING its parent row (clicking would dismiss the menu); returns its rows. */
export async function openSubmenu(page, label) {
    const opened = await page.eval(
        `(() => {
            const menu = document.querySelector('${PAGE.contextMenu}');
            if (menu === null) return 'no-menu';
            const text = (el) => (el.textContent ?? '').trim().replace(/^[✓✔–]\\s*/, '');
            const rows = Array.from(menu.querySelectorAll('[role="menuitem"]'));
            const row = rows.find(el => text(el).startsWith(${JSON.stringify(label)}));
            if (row === undefined) return 'no-row:' + rows.map(el => text(el)).join('/');
            const r = row.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
    );
    if (typeof opened !== 'string' || !opened.startsWith('{')) {
        throw new Error(`context menu item "${label}" not found (${String(opened)})`);
    }
    const point = JSON.parse(opened);
    await page.mouse('mouseMoved', point.x, point.y, { button: 'none', buttons: 0 });
    await sleep(400);
    const rows = await page.eval(
        `(() => {
            const sub = document.querySelector('${PAGE.contextSubmenu}');
            if (sub === null) return '[]';
            return JSON.stringify(Array.from(sub.querySelectorAll('[data-menu-item]')).map(el => ({
                id: el.getAttribute('data-menu-item'),
                label: (el.textContent ?? '').trim().replace(/^[✓✔–]\\s*/, ''),
                checked: el.getAttribute('data-checked')
            })));
        })()`
    );
    return JSON.parse(String(rows));
}

/** Click a row inside the open submenu by its `data-menu-item` id. */
export async function clickSubmenuItem(page, id) {
    const clicked = await page.eval(
        `(() => {
            const row = document.querySelector('${PAGE.contextSubmenu} [data-menu-item="${id}"]');
            if (row === null) return 'no-row';
            const r = row.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
    );
    if (typeof clicked !== 'string' || !clicked.startsWith('{')) {
        throw new Error(`submenu item "${id}" not found (${String(clicked)})`);
    }
    const point = JSON.parse(clicked);
    await page.clickAt(point.x, point.y);
    await sleep(400);
}

/** Right-click a sidebar row (or the group header) whose text contains `needle`. */
export async function openSidebarMenu(page, selector, needle) {
    const target = await page.eval(
        `(() => {
            const el = Array.from(document.querySelectorAll('${selector}'))
                .find(node => (node.innerText ?? '').includes(${JSON.stringify(needle)}));
            if (el === undefined) return null;
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2 });
        })()`
    );
    if (target === null) throw new Error(`no ${selector} matching "${needle}"`);
    const point = JSON.parse(String(target));
    await page.clickAt(point.x, point.y, { button: 'right' });
    await sleep(450);
}

/** The rows of the open context menu, as trimmed labels. */
export async function contextMenuRows(page) {
    const rows = await page.eval(
        `JSON.stringify(Array.from(document.querySelectorAll('${PAGE.contextMenu} [role="menuitem"]')).map(el => (el.textContent ?? '').trim()))`
    );
    return JSON.parse(String(rows ?? '[]'));
}

/** Click a button inside the confirm dialog by its visible label. */
export async function clickDialogButton(page, label) {
    const clicked = await page.eval(
        `(() => {
            const dialog = document.querySelector('${PAGE.confirmDialog}');
            if (dialog === null) return 'no-dialog';
            const buttons = Array.from(dialog.querySelectorAll('button'));
            const button = buttons.find(el => (el.textContent ?? '').trim().toLowerCase() === ${JSON.stringify(String(label).toLowerCase())});
            if (button === undefined) return 'no-button:' + buttons.map(b => (b.textContent ?? '').trim()).join('/');
            const r = button.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`
    );
    if (typeof clicked !== 'string' || !clicked.startsWith('{')) {
        throw new Error(`dialog button "${label}" not found (${String(clicked)})`);
    }
    const point = JSON.parse(clicked);
    await page.clickAt(point.x, point.y);
    await sleep(300);
}

// ── the recorder ────────────────────────────────────────────────────────────────────

/**
 * What a scenario reports through. Every `check` is a named boolean with an optional detail;
 * screenshots land beside the results so a human (or an agent with eyes) can look at a failure.
 *
 * `placement` is the harness lane the instance is running at (#65), and the only thing the
 * recorder does with it is tell the truth about the pictures. A screenshot taken at `hidden`
 * comes back blank and one taken at `offscreen` comes back at half resolution, and a note that
 * just says `shot: foo.png` invites the reader to conclude the app rendered nothing. Every note
 * from a lane that is not painting truthfully carries the caveat, so a picture is never silently
 * worth less than it looks.
 */
export function recorder({ name, outDir, placement }) {
    const shotCaveat = {
        hidden: 'BLANK: a zero-opacity window composites to white through CDP; assertions only',
        offscreen: '1x backing store: half resolution, sub-pixel geometry quantised differently'
    }[placement];
    fs.mkdirSync(outDir, { recursive: true });
    const results = [];
    const notes = [];
    let shots = 0;
    return {
        name,
        outDir,
        results,
        check(label, ok, detail) {
            results.push({ label, ok: ok === true, ...(detail === undefined ? {} : { detail: String(detail) }) });
            process.stdout.write(`    ${ok === true ? 'ok  ' : 'FAIL'} ${label}${detail === undefined || ok === true ? '' : `  (${String(detail).slice(0, 200)})`}\n`);
            return ok === true;
        },
        note(message) {
            notes.push(String(message));
            process.stdout.write(`         ${String(message)}\n`);
        },
        async shot(page, label) {
            shots += 1;
            const file = path.join(outDir, `${name}-${String(shots).padStart(2, '0')}-${label.replace(/[^a-z0-9-]+/gi, '-')}.png`);
            await page.screenshot(file);
            const note = shotCaveat === undefined ? `shot: ${file}` : `shot: ${file}  [${placement}: ${shotCaveat}]`;
            notes.push(note);
            if (shotCaveat !== undefined) process.stdout.write(`         ${note}\n`);
            return file;
        },
        get failed() {
            return results.filter((r) => !r.ok);
        },
        summary() {
            return {
                name,
                ...(placement === undefined ? {} : { placement }),
                checks: results.length,
                failed: results.filter((r) => !r.ok).length,
                results,
                notes
            };
        }
    };
}

// ── bootstraps ──────────────────────────────────────────────────────────────────────

async function connectClient(debugPort, { repoRoot, timeoutMs }) {
    const target = await waitForPageTarget(debugPort, { timeoutMs, match: isClientWindow });
    const page = await connect(target.webSocketDebuggerUrl, { repoRoot });
    await page.waitFor(`document.querySelector('${PAGE.app}') !== null`, { timeoutMs, label: 'the client app root' });
    return page;
}

/**
 * Attach to an instance that is already running: a `node scripts/dev-instance.mjs` prints its
 * debug port and harness socket. Nothing is started and nothing is stopped by `close()`.
 */
export async function attach({ debugPort, harnessSocket, repoRoot = process.cwd(), timeoutMs = 30_000 }) {
    const page = await connectClient(debugPort, { repoRoot, timeoutMs });
    const harness = harnessSocket === undefined ? null : harnessClient(harnessSocket);
    if (harness !== null) await harness.ping();
    return {
        page,
        harness,
        debugPort,
        async close() {
            harness?.close();
            page.close();
        },
        // Parity with boot(): a scenario can be written once and run either way.
        async stop() {
            await this.close();
        }
    };
}

/**
 * The placements `boot({ window })` accepts; `boot`'s doc says what each costs.
 *
 * There is deliberately no default member. `window` unset means the lane does not open and the
 * shell builds the window it has always built: the same rectangle, the same throttling, the
 * same everything, so a run that does not ask for the lane is unchanged by its existence. That
 * matters more than it sounds: `onscreen` was tried as the default and it parks the frame at the
 * work area's origin, where nothing ever covers it, which makes the window permanently
 * un-occluded and quietly breaks every check that needs an INACTIVE app (see
 * `scripts/scenarios/dock-bounce-stop-only.mjs`).
 */
export const WINDOW_PLACEMENTS = ['hidden', 'offscreen', 'onscreen'];
/** What `windowPlacement` reports when no placement was asked for: the shell's own choice. */
export const SHIPPED_WINDOW_PLACEMENT = 'default';

/**
 * Boot a private sandbox (own run dir, socket, DB, ports; throwaway state) with the daemon, the
 * dev Electron shell and a CDP connection to the client window. The shell carries
 * KELPI_HARNESS (it quits if this process dies) and KELPI_HARNESS_SOCKET (the channel).
 *
 * `window` is the harness functional lane (#65), and it is what lets more than one scenario run
 * on one machine at a time. Unset is the shipped window, exactly as before the lane existed:
 *
 *   - `hidden`: the same window, same bounds, same backing scale, at zero opacity and
 *     click-through. The screen stays the owner's and N runs can overlap. Assertions are
 *     unaffected (DOM, CDP input, the harness channel, the CLI, and the app's own activity
 *     signalling); `page.screenshot` composites the window's alpha and comes back BLANK, so
 *     `rec.shot` says so in the note it writes rather than leaving a white PNG to be puzzled over.
 *   - `offscreen`: parked past the work area. Also frees the screen, screenshots are real, but
 *     AppKit gives an off-screen window a 1× backing store: half the resolution and every
 *     sub-pixel quantity quantised differently (`packages/shell/src/audit-window.ts` has the
 *     numbers). It is also never occluded, so the app never looks inactive there.
 *   - `onscreen`: visible, parked at the work area's origin. The lane's visible member, useful
 *     as a control; same never-occluded caveat as `offscreen`.
 *
 * The placement is verified rather than assumed: the shell logs `harness-window: placement=…` at
 * window creation, and the boot waits for that line, so a lane that silently did not open fails
 * here instead of hundreds of assertions later.
 */
export async function boot({ repoRoot, label = 'scenario', build = true, log = () => {}, timeoutMs = 60_000, window } = {}) {
    if (window !== undefined && !WINDOW_PLACEMENTS.includes(window)) {
        throw new Error(`unknown window placement: ${String(window)} (want ${WINDOW_PLACEMENTS.join(' | ')})`);
    }
    if (build) await buildAll(repoRoot, { log });
    // clientDir is what makes the daemon serve the app rather than its placeholder (#37).
    const sandbox = await makeSandbox(repoRoot, {
        label,
        clientDir: path.join(repoRoot, 'packages', 'client', 'dist'),
        harnessWindow: window
    });
    const harnessSocket = sandbox.harnessSocket ?? path.join(sandbox.root, 'harness.sock');
    const daemon = startDaemon(sandbox, { repoRoot });
    clearBackgroundTaskPolicy(daemon.child?.pid);
    await waitForHealthz(sandbox.base);
    const shell = startShell(sandbox, { repoRoot, extraEnv: { KELPI_HARNESS_SOCKET: harnessSocket } });
    clearBackgroundTaskPolicy(shell.child?.pid);
    // Before CDP, because a `hidden` window that did not actually go hidden is a run that has
    // taken the owner's screen without saying so. The shell only logs this line when the lane
    // opened, so waiting for it is also the check that both halves of the gate arrived.
    const windowLogLine =
        window === undefined
            ? null
            : String(await shell.waitForLine(/harness-window: placement=/, `the shell to place its window (${window})`, 45_000));
    if (windowLogLine !== null && !windowLogLine.includes(`placement=${window}`)) {
        throw new Error(`the shell placed its window elsewhere: ${windowLogLine}`);
    }
    const page = await connectClient(sandbox.debugPort, { repoRoot, timeoutMs });
    const harness = harnessClient(harnessSocket);
    await settle(async () => {
        try {
            await harness.ping();
            return true;
        } catch {
            return false;
        }
    }, { ceilingMs: timeoutMs, intervalMs: 200 });
    const raw = makeCli(sandbox, { repoRoot });
    const cli = {
        /** { code, stdout, stderr }; pass { env: { KELPI_PANE_ID } } to speak as a pane. */
        run: (args, opts = {}) => raw.run(args, opts),
        /** Run and require exit 0; returns stdout. The failure names the command and its stderr. */
        async ok(args, opts = {}) {
            const result = await raw.run(args, opts);
            if (result.code !== 0) throw new Error(`kelpi ${args.join(' ')} exited ${String(result.code)}: ${result.stderr || result.stdout}`);
            return result.stdout;
        }
    };
    let stopped = false;
    return {
        sandbox,
        daemon,
        shell,
        page,
        harness,
        cli,
        /** The placement this instance is actually running at, proven by the shell's own log line. */
        windowPlacement: window ?? SHIPPED_WINDOW_PLACEMENT,
        windowLogLine,
        debugPort: sandbox.debugPort,
        async stop() {
            if (stopped) return;
            stopped = true;
            harness.close();
            try {
                page.close();
            } catch {
                /* already gone */
            }
            try {
                await shell.quit();
            } catch {
                /* already gone */
            }
            try {
                await daemon.stop();
            } catch {
                /* already gone */
            }
            sandbox.cleanup();
        }
    };
}

/** Debug targets of a running instance, for a quick "is the client up" check. */
export async function targets(debugPort) {
    return await listTargets(debugPort);
}
