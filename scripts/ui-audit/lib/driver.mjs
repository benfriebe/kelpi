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
 * blur() / hide() / minimize() / restore() / crash(paneID) / clipboardRead() /
 * clipboardWrite(text). See ../README.md for the scenario contract.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { MOD, connect, listTargets, sleep, waitForPageTarget } from './cdp.mjs';
import { watchRendererErrors } from './renderer-errors.mjs';
import {
    buildAll,
    clearBackgroundTaskPolicy,
    makeCli,
    makeSandbox,
    restartableDaemon,
    startShell
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
        /** Boot only: release the first client navigation after CDP subscriptions are live. */
        loadClient: () => request('load-client'),
        /** The application menu as a tree of { id, label, accelerator, enabled, visible, type, role, checked, submenu }. */
        menu: () => request('menu'),
        /** Click a menu item by `id` or by label `path` (['View', 'Toggle Sidebar']). */
        menuClick: (target) => request('menu-click', target),
        /** Land a native accelerator: clicks the first enabled menu item bound to it. */
        press: (accelerator) => request('press', { accelerator }),
        /**
         * { dockBounces, lastBounce, dialogs, lastDialog, notifications, lastNotification,
         * recentNotifications, externalOpens, lastExternalUrl }.
         *
         * `externalOpens` / `lastExternalUrl` are `shell.openExternal` calls (#83), and under
         * the harness the open is RECORDED INSTEAD OF PERFORMED, so nothing launches a browser.
         */
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
        /**
         * #76: kill the renderer behind a web pane's active tab, as macOS does under memory
         * pressure. Answers `{ paneID, tabID, crashed: true }`, or refuses when that pane has no
         * live view. The shell's own recovery is what a caller then watches for.
         */
        crash: (paneID) => request('crash', { paneID }),
        /**
         * #109: the system clipboard, through the MAIN process.
         *
         * The rule: a scenario seeds or reads the clipboard through here, never through the
         * page. The reason: `navigator.clipboard.writeText` / `readText` throw
         * `NotAllowedError: Document is not focused` the moment the window is not focused, and
         * a battery blurs it (`dock-bounce-stop-only`), hides it, or simply runs while the
         * machine's owner clicks elsewhere. Measured 2026-09-08 00:13:
         * `kitty-keeps-system-chords` failed its seed that way in the hidden lane and passed
         * alone. Electron's `clipboard` is the same NSPasteboard with no focus rule on it.
         *
         * `clipboardWrite` answers with the pasteboard read back AFTER the write, so a caller
         * gets its proof in the same round trip: `(await harness.clipboardWrite(x)).text === x`.
         */
        clipboardRead: () => request('clipboard-read'),
        clipboardWrite: (text) => request('clipboard-write', { text }),
        close() {
            socket?.end();
            socket = null;
        }
    };
}

/**
 * The lane's page-level focus: make the PAGE believe it is focused, without the OS window ever
 * being the key one.
 *
 * ## The rule (#109)
 *
 * A lane window (`--window hidden | offscreen | onscreen`) never becomes the key window on its
 * own, and the machine's real keyboard never reaches it. `packages/shell/src/audit-window.ts` ▸
 * `auditWindowFocusable` builds every lane placement `focusable: false` and has the measurement:
 * on the base tree, at `--window hidden`, the frontmost application right after boot was
 * `Electron`, `harness.focus()` took the key window back off the app the person had moved to,
 * and a CGEvent keystroke posted the way a physical one arrives landed in the run's terminal
 * pane: `echo caret-ok` typed through CDP came back from `kelpi pane capture` as
 * `echo urecaret-ok`, with `ure` typed on the machine. That is the shape PR #113 recorded and
 * could not attribute.
 *
 * ## What the lane does instead
 *
 * Every keystroke a lane delivers already goes through CDP (`Input.dispatchKeyEvent` and
 * friends), which the render widget answers directly and which needs no key status. The one
 * thing key status was still buying was the page's own belief that it is focused, which the
 * client genuinely reads: `client/src/terminal/TerminalPane.tsx` seeds `windowFocused` from
 * `document.hasFocus()`, `client/src/chrome/attention.ts` gates on it, and CDP key events are
 * only routed to the focused element of a focused page. `Emulation.setFocusEmulationEnabled`
 * supplies exactly that and nothing else: it does not touch `document.visibilityState`, so
 * `dock-bounce-stop-only`'s `harness.hide()` still drives the app inactive the way #113 made it.
 *
 * So, in the lane: `harness.focus()` means "make the page believe it is focused" and
 * `harness.blur()` the reverse, rather than "make the OS window key". See `boot`, which wraps
 * the two ops, and `packages/shell/src/harness.ts`, which holds up the main-process half.
 *
 * Best effort: an Electron without the domain must not take a run down over a signal the lane
 * only ever improves.
 */
export async function setPageFocusEmulation(page, enabled) {
    try {
        await page.send('Emulation.setFocusEmulationEnabled', { enabled });
        return true;
    } catch {
        return false;
    }
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

// ── clipboard chords: the focus the page has to believe it has ──────────────────────

/**
 * Turn CDP focus emulation on inside a frame's OWN target, not just the page's.
 *
 * `boot` enables emulation on the page session, which is what makes `document.hasFocus()` true in
 * a lane whose window is never the key window. A plugin view is a sandboxed iframe, and once
 * Chromium has put it out of process (which it does as soon as a sandbox has hosted other plugin
 * frames) the focused frame lives in a renderer that was never told the page is focused. The top
 * document then answers `hasFocus() === false` while its `activeElement` is the iframe,
 * `navigator.clipboard` rejects with "Document is not focused", and the Copy and paste chords do
 * nothing (#205). Emulating focus on the child session is the other half of what the OS supplies.
 *
 * Best effort: a frame the harness cannot reach must not take a run down over a signal that only
 * ever improves the lane.
 */
export async function setFrameFocusEmulation(page, frameSelector) {
    try {
        const { root } = await page.send('DOM.getDocument', { depth: 1 });
        const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: frameSelector });
        if (!nodeId) return false;
        const frameId = (await page.send('DOM.describeNode', { nodeId })).node?.frameId;
        const sessionId = frameId === undefined ? undefined : page.frameSessions?.get(frameId);
        if (sessionId === undefined) return false;
        await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 10_000, sessionId);
        return true;
    } catch {
        return false;
    }
}

/**
 * The page's focus and the caret, exactly as they stand. Recorded into a check's own detail.
 *
 * `onTheRenderer` is the caller's answer to "is the caret where this pane's chord needs it".
 * The default is the one a bundled terminal pane wants (the engine's hidden textarea lives inside
 * the pane body); a plugin view passes a probe that runs inside its own frame.
 */
export async function caretNow(page, paneID, { onTheRenderer } = {}) {
    const header = JSON.stringify(`[data-testid="pane-header-${paneID}"]`);
    const body = JSON.stringify(`[data-testid="pane-body-${paneID}"]`);
    const host = JSON.parse(
        await page.eval(
            `JSON.stringify({
                hasFocus: document.hasFocus(),
                active: String(document.activeElement?.outerHTML ?? document.activeElement?.nodeName ?? '<null>').slice(0, 90),
                appFocusedPane: document.querySelector(${header})?.getAttribute('data-focused') === 'true'
            })`
        )
    );
    const probe =
        onTheRenderer ??
        (() => page.eval(`(() => { const body = document.querySelector(${body}); return body !== null && body.contains(document.activeElement); })()`));
    return { ...host, onTheRenderer: await probe().catch(() => null) };
}

/**
 * The page's focus and the caret, read IMMEDIATELY before a clipboard chord, and repaired.
 *
 * A platform Copy or paste is the one kind of check that cannot be asserted through any path the
 * page does not have to be focused for. Chromium routes a CDP key event only to the focused
 * element of a FOCUSED page, and the product's own copy goes through `navigator.clipboard`, which
 * answers `NotAllowedError: Document is not focused` the instant the page is not. The lane's
 * window is never the key window by construction (#109), so `document.hasFocus()` is true only
 * while CDP focus emulation is on, and emulation is turned OFF by `harness.blur()`, which earlier
 * scenarios in the same sandbox use on purpose. One that forgets to turn it back on takes every
 * later clipboard chord with it, silently (#205, #207).
 *
 * So the state is RECORDED into the check's own detail either way - a failure that says
 * `hasFocus:false` names its reason instead of leaving it to be guessed - and, when the page has
 * been left believing it is not focused, repaired through the harness before the press. The repair
 * is honest about what it is: a focused window is the product's own precondition for a copy, the
 * lane can only supply it through emulation, and the runner's post-condition still names the
 * scenario that turned it off.
 *
 * `refocus` is how the caller puts the caret back, and it matters more than it looks: the default
 * clicks the pane body, which is right for a pane with nothing selected and WRONG immediately
 * after a drag, because a click inside a terminal clears the selection the Copy is about and the
 * engine's copy-on-select would overwrite the clipboard the paste is about. Call this BEFORE the
 * selection, or pass a `refocus` that stays off the grid.
 *
 * A repair that cannot be made is FATAL, after it has been recorded. `setFrameFocusEmulation` is
 * the one best-effort step (an Electron without the domain must not take a run down over a signal
 * that only ever improves the lane); a `refocus` that throws and a pane header that is not in the
 * DOM both mean the next chord would be pressed at nothing, so they are noted and then rethrown
 * rather than turned into a note under a green scenario.
 */
export async function clipboardCaret(page, harness, paneID, { label = 'the clipboard chord', note = () => {}, onTheRenderer, refocus, frameSelector } = {}) {
    const read = () => caretNow(page, paneID, { onTheRenderer });
    const putTheCaretBack = refocus ?? (() => focusPaneBody(page, paneID));
    let state = await read();
    if (state.hasFocus !== true || state.onTheRenderer !== true) {
        note(`${label}: the page was not focused on the renderer (${JSON.stringify(state)}); restoring focus before the chord`);
        await harness.focus();
        if (frameSelector !== undefined) await setFrameFocusEmulation(page, frameSelector);
        try {
            await putTheCaretBack();
        } catch (error) {
            // Recorded, then rethrown. A repair that cannot reach the pane means the scenario is
            // about to press a chord at nothing, and a scenario that carries on and goes green with
            // a note nobody reads is the exact failure #205 was filed about.
            note(`${label}: the focus repair could not reach the pane (${error instanceof Error ? error.message : String(error)})`);
            throw error;
        }
        state = await read();
        note(`${label}: after the harness repair ${JSON.stringify(state)}`);
    }
    if (state.hasFocus !== true) {
        /*
         * The focus-independent route, and the one the product itself uses. `app/clipboard.ts`
         * reads the FOCUSED PANE from the app's own registry, not from the DOM, and asks that
         * pane's live renderer for its selection across the frame boundary, so the chord works
         * with the caret on the pane's header, where the top document holds it and
         * `navigator.clipboard` is allowed to run. Measured: with the caret in a plugin's
         * out-of-process textarea the top document answers `hasFocus() === false` and the write is
         * refused; one click on the header and both chords land (#205).
         */
        try {
            await clickPaneHeader(page, paneID);
        } catch (error) {
            // Recorded, then rethrown, for the reason above: this is the last route there is, and a
            // chord pressed after it failed proves nothing about the product.
            note(`${label}: the pane header is unreachable (${error instanceof Error ? error.message : String(error)})`);
            throw error;
        }
        state = { ...(await read()), route: 'the pane header, so the host document holds the caret' };
        note(`${label}: after taking the caret back into the host document ${JSON.stringify(state)}`);
    }
    return state;
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

/**
 * Right-click a sidebar row (or the group header) whose text contains `needle`.
 *
 * This is the one helper the audit and the scenarios now SHARE rather than keep two copies of:
 * the measure-once-and-press body both files had is what #204 was, and a fix that landed in one
 * copy would have left the other pressing the sidebar footer. `lib/aim.mjs` has the reasoning.
 */
export { openSidebarMenu } from './aim.mjs';

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
    const rendererErrors = await watchRendererErrors(page);
    await page.waitFor(`document.querySelector('${PAGE.app}') !== null`, { timeoutMs, label: 'the client app root' });
    return { page, rendererErrors };
}

/**
 * Attach to an instance that is already running: a `node scripts/dev-instance.mjs` prints its
 * debug port and harness socket. Nothing is started and nothing is stopped by `close()`.
 */
export async function attach({ debugPort, harnessSocket, repoRoot = process.cwd(), timeoutMs = 30_000 }) {
    const { page, rendererErrors } = await connectClient(debugPort, { repoRoot, timeoutMs });
    const harness = harnessSocket === undefined ? null : harnessClient(harnessSocket);
    if (harness !== null) await harness.ping();
    return {
        page,
        rendererErrors,
        harness,
        /*
         * No daemon handle, deliberately (#199). This instance was started by somebody else, its
         * daemon may be a developer's own, and a scenario that stopped it would take their
         * session down with it. A scenario whose arm needs one checks for null and says so, the
         * way it already does for `shell`.
         */
        daemon: null,
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
 * un-occluded.
 *
 * No placement, `hidden` included, is a way to make the app look INACTIVE: measured for #109,
 * AppKit counts a zero-opacity frame as visible too, so a blurred window reports
 * `visibilityState: 'visible'` everywhere unless something is in front of it. A scenario that
 * needs an inactive app drives it with `harness.hide()` and restores afterwards
 * (`scripts/scenarios/dock-bounce-stop-only.mjs` is the worked example).
 *
 * And no placement is ever the KEY window (#109). All three are built `focusable: false`, so the
 * machine's keyboard cannot reach a run and a run cannot take the machine's keyboard; the page's
 * own sense of being focused comes from CDP focus emulation instead. `setPageFocusEmulation`
 * above has the rule, the reason and the measurement.
 */
export const WINDOW_PLACEMENTS = ['hidden', 'offscreen', 'onscreen'];
/** What `windowPlacement` reports when no placement was asked for: the shell's own choice. */
export const SHIPPED_WINDOW_PLACEMENT = 'default';

/**
 * Boot a private sandbox (own run dir, socket, DB, ports; throwaway state) with the daemon, the
 * dev Electron shell and a CDP connection to the client window. The shell carries
 * KELPI_HARNESS (it quits if this process dies) and KELPI_HARNESS_SOCKET (the channel).
 *
 * The shell holds its first client navigation behind KELPI_HARNESS_DEFER_LOAD plus the harness
 * socket gate. Boot attaches to an inert about:blank document, subscribes to renderer errors,
 * then releases that navigation. `rendererErrors.finish(rec)` drains the verdict into a recorder;
 * a failed first mount returns with its errors even if the app root never appeared. `beforeLoad`
 * optionally receives the watched CDP page for setup such as new-document scripts.
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
 *     numbers). It is never occluded, so blurring alone never makes the app look inactive there.
 *   - `onscreen`: visible, parked at the work area's origin. The lane's visible member, useful
 *     as a control; same never-occluded caveat as `offscreen`. Neither caveat blocks a scenario
 *     any more: `harness.hide()` reaches the inactive state at every placement (#109).
 *
 * The placement is verified rather than assumed: the shell logs `harness-window: placement=…` at
 * window creation, and the boot waits for that line, so a lane that silently did not open fails
 * here instead of hundreds of assertions later. That line also carries `focusable=false`, which
 * is #109's key-window rule: a lane window never becomes the key window, so the machine's real
 * keyboard never reaches the run and the run never takes it from the person at the machine. The
 * page is told it is focused over CDP instead, and `harness.focus()` / `harness.blur()` in the
 * lane mean "make the page believe it is focused / unfocused" rather than "make the OS window
 * key". `setPageFocusEmulation` above has the measurement.
 */
export async function boot({ repoRoot, label = 'scenario', build = true, log = () => {}, timeoutMs = 60_000, window, beforeLoad } = {}) {
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
    /*
     * A RESTARTABLE daemon rather than one process (#199): `stack.mjs` ▸ `restartableDaemon` has
     * the rule and the two limits. `start()` does what the three lines here used to do (spawn,
     * clear the background-task policy, wait for healthz), and the instance's own `stop()` below
     * stops whichever process is current, so a scenario that restarted the daemon still leaves a
     * sandbox this runner can tear down.
     */
    const daemon = restartableDaemon(sandbox, { repoRoot });
    let shell;
    let page;
    let rawHarness;
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        try { rawHarness?.close(); } catch { /* already gone */ }
        try { page?.close(); } catch { /* already gone */ }
        try { await shell?.quit(); } catch { /* already gone */ }
        try { await daemon.stop(); } catch { /* already gone */ }
        sandbox.cleanup();
    };
    try {
        await daemon.start();
        shell = startShell(sandbox, { repoRoot, extraEnv: {
            KELPI_HARNESS_SOCKET: harnessSocket,
            KELPI_HARNESS_DEFER_LOAD: '1'
        } });
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
        // An empty URL belongs to a never-navigated window with no running renderer. Wait for
        // the shell's inert blank document so Runtime.enable can acknowledge before client load.
        const target = await waitForPageTarget(sandbox.debugPort, {
            timeoutMs, match: (target) => target.url === 'about:blank'
        });
        page = await connect(target.webSocketDebuggerUrl, { repoRoot });
        const rendererErrors = await watchRendererErrors(page, { timeoutMs });
        if (rendererErrors.enableError !== null) {
            throw new Error(`the renderer could not be watched: Runtime.enable: ${rendererErrors.enableError}`);
        }
        /*
         * #109: the lane's window is never the key window (see `setPageFocusEmulation`), so the page
         * would report `document.hasFocus() === false` for the whole run and CDP keys would have no
         * focused page to route to. Emulation is turned on here, before a scenario runs a line, so
         * the page starts in the same state it used to reach by stealing the machine's keyboard.
         * Unset `window` is the shipped window: it can be key, so nothing is emulated.
         */
        const laneFocus = window !== undefined;
        if (laneFocus) await setPageFocusEmulation(page, true);
        rawHarness = harnessClient(harnessSocket);
        /*
         * In the lane, `focus` and `blur` mean "make the page believe it is focused / unfocused".
         * The main-process call still happens (`harness.focus()` orders the frame front and hands
         * the keyboard to the web contents; `blur()` is a no-op on a window that was never key), and
         * the page-level half is added here because this is the side holding the CDP session. The
         * ORDER matters for `blur`: emulation goes off first, so a scenario that reads
         * `document.hasFocus()` straight after the await never sees the stale `true`.
         */
        const harness = laneFocus
            ? {
                  ...rawHarness,
                  focus: async () => {
                      const answer = await rawHarness.focus();
                      await setPageFocusEmulation(page, true);
                      return answer;
                  },
                  blur: async () => {
                      await setPageFocusEmulation(page, false);
                      return await rawHarness.blur();
                  },
                  close: () => rawHarness.close()
              }
            : rawHarness;
        const harnessReady = await settle(async () => {
            try {
                await harness.ping();
                return true;
            } catch {
                return false;
            }
        }, { ceilingMs: timeoutMs, intervalMs: 200 });
        if (!harnessReady) throw new Error('the shell harness did not become ready');
        // Test setup (e.g. new-document scripts) runs under the already armed watcher.
        await beforeLoad?.(page);
        const loaded = await rawHarness.loadClient();
        if (loaded.released !== true) throw new Error('the shell did not hold the initial client load');
        // A broken first mount must reach the scenario recorder with its original error, instead
        // of timing out here on the absent root and losing the evidence with the boot failure.
        const clientReady = await settle(async () => {
            if (rendererErrors.hasErrors) return true;
            try {
                return await page.eval(`document.querySelector('${PAGE.app}') !== null`);
            } catch {
                return false; // The initial navigation can destroy the blank execution context.
            }
        }, { ceilingMs: timeoutMs, intervalMs: 100 });
        if (!clientReady) throw new Error('the client app root did not appear');
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
        return {
            sandbox,
            /**
             * This sandbox's daemon, restartable in place: `stop()`, `start()`, `restart()`, plus
             * `pid`, `child`, `generation`, `exited`, `text()` and `lastStopMs` / `lastStartMs`.
             * `stack.mjs` ▸ `restartableDaemon` has what a restart is and is not. Null under `attach`,
             * where the runner did not start the daemon and must not stop somebody else's.
             */
            daemon,
            shell,
            page,
            rendererErrors,
            harness,
            cli,
            /** The placement this instance is actually running at, proven by the shell's own log line. */
            windowPlacement: window ?? SHIPPED_WINDOW_PLACEMENT,
            windowLogLine,
            debugPort: sandbox.debugPort,
            stop
        };
    } catch (error) {
        await stop();
        throw error;
    }
}

/** Debug targets of a running instance, for a quick "is the client up" check. */
export async function targets(debugPort) {
    return await listTargets(debugPort);
}
