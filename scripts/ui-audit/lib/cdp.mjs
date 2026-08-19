/**
 * A minimal Chrome DevTools Protocol client, sized for the UI audit and nothing more.
 *
 * The audit drives the SHELL's renderer the way a person does — real key events into the real
 * ghostty-web canvas, real mouse-downs on real dividers — so everything here goes through
 * `Input.*` rather than synthesising DOM events in page script. `Runtime.evaluate` is reserved
 * for *reading* (assertions) and for the handful of affordances that have no stable hit target.
 *
 * Why hand-rolled instead of puppeteer: the harness must run against a packaged `Nex.app` whose
 * only automation surface is `--remote-debugging-port`, must add zero dependencies outside the
 * packages that already have them, and needs ~10 CDP methods.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** CDP modifier bitmask (Input domain). */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * `ws` lives in the daemon/shell packages, not at the repo root. Resolve it from there so the
 * audit needs no dependency of its own; fall back to Node 24's global WebSocket if it is gone.
 */
function loadWebSocket(repoRoot) {
    for (const pkg of ['shell', 'daemon']) {
        try {
            const require = createRequire(path.join(repoRoot, 'packages', pkg, 'package.json'));
            const mod = require('ws');
            return mod.WebSocket ?? mod;
        } catch {
            // try the next one
        }
    }
    if (typeof WebSocket === 'function') return WebSocket;
    throw new Error('no WebSocket implementation available (install deps: pnpm install)');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `http://127.0.0.1:<port>/json` until a page target shows up. */
export async function waitForPageTarget(port, { timeoutMs = 60_000, match } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no response yet';
    for (;;) {
        try {
            const response = await fetch(`http://127.0.0.1:${String(port)}/json`);
            if (response.ok) {
                const targets = await response.json();
                const pages = targets.filter(
                    (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string'
                );
                const chosen = match === undefined ? pages[0] : pages.find(match);
                if (chosen !== undefined) return chosen;
                lastError = `no matching page target among ${String(targets.length)}`;
            } else {
                lastError = `/json responded ${String(response.status)}`;
            }
        } catch (error) {
            lastError = String(error.message ?? error);
        }
        if (Date.now() > deadline) throw new Error(`no CDP page target on :${String(port)} — ${lastError}`);
        await sleep(200);
    }
}

export async function listTargets(port) {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json`);
    if (!response.ok) throw new Error(`/json responded ${String(response.status)}`);
    return await response.json();
}

/** Open a CDP session against one target's `webSocketDebuggerUrl`. */
export async function connect(webSocketDebuggerUrl, { repoRoot, verbose = false } = {}) {
    const WS = loadWebSocket(repoRoot);
    const socket = new WS(webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
        const onOpen = () => resolve();
        const onError = (error) => reject(new Error(`CDP connect failed: ${String(error?.message ?? error)}`));
        if (typeof socket.once === 'function') {
            socket.once('open', onOpen);
            socket.once('error', onError);
        } else {
            socket.addEventListener('open', onOpen, { once: true });
            socket.addEventListener('error', onError, { once: true });
        }
    });

    let nextID = 0;
    const pending = new Map();
    const listeners = new Map();
    /** frameId → executionContextId, so the audit can read inside same-process iframes. */
    const contexts = new Map();
    /**
     * targetId → sessionId for out-of-process iframes.
     *
     * The markdown preview and the diff are `srcdoc` frames sandboxed to `allow-scripts`, which
     * gives them an opaque origin — and Chromium puts an opaque-origin frame in its own process,
     * i.e. its own CDP *target*. There is then no execution context on the page's session to
     * evaluate in at all; the only way to read the document the user is looking at is to attach
     * to the child target and talk to it over its own session (the "flat" protocol, where a
     * target's id and its frame id are the same string).
     */
    const frameSessions = new Map();

    const handle = (raw) => {
        let message;
        try {
            message = JSON.parse(String(raw));
        } catch {
            return;
        }
        if (message.id !== undefined) {
            const entry = pending.get(message.id);
            if (entry === undefined) return;
            pending.delete(message.id);
            if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
            else entry.resolve(message.result);
            return;
        }
        if (typeof message.method === 'string') {
            if (verbose) process.stderr.write(`[cdp] ${message.method}\n`);
            for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {});
        }
    };
    if (typeof socket.on === 'function') socket.on('message', handle);
    else socket.addEventListener('message', (event) => handle(event.data));

    const send = (method, params = {}, timeoutMs = 60_000, sessionId = undefined) =>
        new Promise((resolve, reject) => {
            const id = ++nextID;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${method} timed out after ${String(timeoutMs)}ms`));
            }, timeoutMs);
            timer.unref?.();
            pending.set(id, {
                method,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            });
            socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
        });

    const session = {
        send,
        contexts,
        frameSessions,

        /**
         * Attach to child targets (the content iframes) as they appear. Called once after the
         * page session opens; `flatten` keeps everything on this one WebSocket.
         */
        async watchFrames() {
            await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        },

        on(method, listener) {
            const existing = listeners.get(method) ?? [];
            existing.push(listener);
            listeners.set(method, existing);
            return () => listeners.set(method, (listeners.get(method) ?? []).filter((item) => item !== listener));
        },
        close() {
            try {
                socket.close();
            } catch {
                // already gone
            }
        },

        // ── reading ─────────────────────────────────────────────────────────────────

        /** Evaluate an expression in the page and return its value (awaits promises). */
        async eval(expression, { timeoutMs = 30_000 } = {}) {
            const result = await send(
                'Runtime.evaluate',
                { expression, returnByValue: true, awaitPromise: true },
                timeoutMs
            );
            if (result.exceptionDetails !== undefined) {
                const text =
                    result.exceptionDetails.exception?.description ??
                    result.exceptionDetails.text ??
                    'evaluation threw';
                throw new Error(`page eval failed: ${text}`);
            }
            return result.result?.value;
        },

        /** Poll an expression until it is truthy; returns the value. */
        async waitFor(expression, { timeoutMs = 20_000, intervalMs = 150, label = expression } = {}) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                let value;
                try {
                    value = await session.eval(expression);
                } catch (error) {
                    value = undefined;
                    if (Date.now() > deadline) throw error;
                }
                if (value !== undefined && value !== null && value !== false && value !== '' && value !== 0) {
                    return value;
                }
                if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
                await sleep(intervalMs);
            }
        },

        /** The page's visible text (what a person reads). */
        text() {
            return session.eval('document.body.innerText');
        },

        /**
         * Read inside a `srcdoc` content iframe (markdown preview, diff).
         *
         * Both content panes render into an iframe sandboxed to `allow-scripts`, which gives it
         * an opaque origin and its own execution context — `Runtime.evaluate` on the main frame
         * sees an empty `<iframe>` element and nothing else. To assert on what the user is
         * actually reading, resolve the element → its `frameId` (via the DOM domain) → the
         * execution context CDP announced for that frame, and evaluate there.
         */
        async evalInFrame(iframeSelector, expression, { timeoutMs = 20_000 } = {}) {
            const { root } = await send('DOM.getDocument', { depth: 1 });
            const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: iframeSelector });
            if (nodeId === 0) throw new Error(`evalInFrame: no iframe matches ${iframeSelector}`);
            const described = await send('DOM.describeNode', { nodeId });
            const frameId = described.node?.frameId;
            if (frameId === undefined) throw new Error(`evalInFrame: ${iframeSelector} is not a frame owner`);
            // Out-of-process first (the normal case for these sandboxed frames): evaluate on the
            // child target's own session, where the frame is simply "the page".
            const childSession = frameSessions.get(frameId);
            let result;
            if (childSession !== undefined) {
                result = await send(
                    'Runtime.evaluate',
                    { expression, returnByValue: true, awaitPromise: true },
                    timeoutMs,
                    childSession
                );
            } else {
                // Same-process fallback: a context CDP announced, or one we ask it to make.
                let contextId = contexts.get(frameId);
                if (contextId === undefined) {
                    const world = await send('Page.createIsolatedWorld', {
                        frameId,
                        worldName: 'nex-ui-audit',
                        grantUniveralAccess: false
                    });
                    contextId = world.executionContextId;
                }
                if (contextId === undefined) {
                    throw new Error(`evalInFrame: no way into frame ${String(frameId)}`);
                }
                result = await send(
                    'Runtime.evaluate',
                    { expression, returnByValue: true, awaitPromise: true, contextId },
                    timeoutMs
                );
            }
            if (result.exceptionDetails !== undefined) {
                throw new Error(
                    `frame eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
                );
            }
            return result.result?.value;
        },

        /** Bounding box of the first match, in CSS pixels, or null. */
        async box(selector) {
            return await session.eval(
                `(() => { const el = document.querySelector(${JSON.stringify(selector)});
                  if (el === null) return null;
                  const r = el.getBoundingClientRect();
                  return { x: r.x, y: r.y, width: r.width, height: r.height,
                           cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`
            );
        },

        // ── screenshots ─────────────────────────────────────────────────────────────

        async screenshot(file) {
            const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
            return file;
        },

        // ── input: mouse ────────────────────────────────────────────────────────────

        async mouse(type, x, y, { button = 'left', clickCount = 1, modifiers = 0, buttons } = {}) {
            await send('Input.dispatchMouseEvent', {
                type,
                x,
                y,
                button,
                clickCount,
                modifiers,
                buttons: buttons ?? (type === 'mouseMoved' && button === 'none' ? 0 : button === 'left' ? 1 : 2)
            });
        },

        async clickAt(x, y, { button = 'left', modifiers = 0, clickCount = 1 } = {}) {
            await session.mouse('mouseMoved', x, y, { button: 'none', buttons: 0, modifiers });
            await session.mouse('mousePressed', x, y, { button, clickCount, modifiers });
            await sleep(30);
            await session.mouse('mouseReleased', x, y, { button, clickCount, modifiers });
        },

        /** Click the centre of a selector. Throws when it is not on screen. */
        async click(selector, options = {}) {
            const box = await session.box(selector);
            if (box === null) throw new Error(`click: no element matches ${selector}`);
            if (box.width === 0 && box.height === 0) throw new Error(`click: ${selector} has a zero-size box`);
            await session.clickAt(box.cx, box.cy, options);
            return box;
        },

        async rightClick(selector) {
            return await session.click(selector, { button: 'right' });
        },

        /** A press-move-release drag, with intermediate moves so drag handlers see motion. */
        async drag(fromX, fromY, toX, toY, { steps = 12, button = 'left' } = {}) {
            await session.mouse('mouseMoved', fromX, fromY, { button: 'none', buttons: 0 });
            await session.mouse('mousePressed', fromX, fromY, { button, clickCount: 1 });
            for (let step = 1; step <= steps; step++) {
                const x = fromX + ((toX - fromX) * step) / steps;
                const y = fromY + ((toY - fromY) * step) / steps;
                await session.mouse('mouseMoved', x, y, { button, buttons: 1 });
                await sleep(16);
            }
            await session.mouse('mouseReleased', toX, toY, { button, clickCount: 1 });
        },

        // ── input: keyboard ─────────────────────────────────────────────────────────

        /**
         * One physical key. `code` is what the client's dispatcher reads (`chrome/keys.ts`
         * maps `event.code` → a config key name), so it is the field that must be right.
         */
        async key(code, { modifiers = 0, key, text, keyCode, hold = 12 } = {}) {
            const spec = KEYS[code] ?? {};
            const resolvedKey = key ?? spec.key ?? code;
            const resolvedCode = keyCode ?? spec.keyCode ?? 0;
            const payloadText = text ?? (modifiers === 0 ? spec.text : undefined);
            await send('Input.dispatchKeyEvent', {
                type: payloadText === undefined ? 'rawKeyDown' : 'keyDown',
                code,
                key: resolvedKey,
                windowsVirtualKeyCode: resolvedCode,
                nativeVirtualKeyCode: resolvedCode,
                modifiers,
                ...(payloadText === undefined ? {} : { text: payloadText, unmodifiedText: payloadText })
            });
            await sleep(hold);
            await send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                code,
                key: resolvedKey,
                windowsVirtualKeyCode: resolvedCode,
                nativeVirtualKeyCode: resolvedCode,
                modifiers
            });
        },

        /** Type printable text one key at a time — the terminal is a canvas, not an input. */
        async type(value, { perKeyMs = 14 } = {}) {
            for (const character of value) {
                const code = codeForCharacter(character);
                const shift = /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(character);
                await send('Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    code,
                    key: character,
                    text: character,
                    unmodifiedText: character,
                    windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0),
                    nativeVirtualKeyCode: character.toUpperCase().charCodeAt(0),
                    modifiers: shift ? MOD.shift : 0
                });
                await send('Input.dispatchKeyEvent', {
                    type: 'char',
                    text: character,
                    unmodifiedText: character,
                    key: character,
                    modifiers: shift ? MOD.shift : 0
                });
                await send('Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    code,
                    key: character,
                    windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0),
                    nativeVirtualKeyCode: character.toUpperCase().charCodeAt(0),
                    modifiers: shift ? MOD.shift : 0
                });
                await sleep(perKeyMs);
            }
        },

        /** Type into a focused text field (`insertText` is an IME-style commit, no keydown). */
        async insertText(value) {
            await send('Input.insertText', { text: value });
        },

        async enter() {
            await session.key('Enter');
        }
    };

    // Frame bookkeeping has to be live from the moment the session opens: a content pane can
    // mount at any point in the run, and `Runtime.enable` replays contexts that already exist.
    session.on('Runtime.executionContextCreated', (params) => {
        const frameId = params.context?.auxData?.frameId;
        if (typeof frameId === 'string') contexts.set(frameId, params.context.id);
    });
    session.on('Runtime.executionContextDestroyed', (params) => {
        for (const [frameId, id] of contexts) if (id === params.executionContextId) contexts.delete(frameId);
    });
    session.on('Runtime.executionContextsCleared', () => contexts.clear());
    session.on('Target.attachedToTarget', (params) => {
        if (params.targetInfo?.type === 'iframe') frameSessions.set(params.targetInfo.targetId, params.sessionId);
    });
    session.on('Target.detachedFromTarget', (params) => {
        for (const [frameId, id] of frameSessions) if (id === params.sessionId) frameSessions.delete(frameId);
    });

    return session;
}

/** Enough of the US layout for the audit's flows. `text` is what a terminal should receive. */
const KEYS = {
    Enter: { key: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', keyCode: 9, text: '\t' },
    Escape: { key: 'Escape', keyCode: 27, text: '' },
    Backspace: { key: 'Backspace', keyCode: 8, text: '\b' },
    Space: { key: ' ', keyCode: 32, text: ' ' },
    ArrowUp: { key: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', keyCode: 39 },
    KeyA: { key: 'a', keyCode: 65 },
    KeyD: { key: 'd', keyCode: 68 },
    KeyE: { key: 'e', keyCode: 69 },
    KeyF: { key: 'f', keyCode: 70 },
    KeyN: { key: 'n', keyCode: 78 },
    KeyO: { key: 'o', keyCode: 79 },
    KeyP: { key: 'p', keyCode: 80 },
    KeyR: { key: 'r', keyCode: 82 },
    KeyS: { key: 's', keyCode: 83 },
    KeyW: { key: 'w', keyCode: 87 },
    Digit1: { key: '1', keyCode: 49 },
    Digit2: { key: '2', keyCode: 50 },
    Digit3: { key: '3', keyCode: 51 },
    Comma: { key: ',', keyCode: 188 }
};

function codeForCharacter(character) {
    if (/[a-zA-Z]/.test(character)) return `Key${character.toUpperCase()}`;
    if (/[0-9]/.test(character)) return `Digit${character}`;
    const punctuation = {
        ' ': 'Space',
        '-': 'Minus',
        '=': 'Equal',
        '.': 'Period',
        ',': 'Comma',
        '/': 'Slash',
        ';': 'Semicolon',
        "'": 'Quote',
        '[': 'BracketLeft',
        ']': 'BracketRight',
        '\\': 'Backslash',
        '`': 'Backquote'
    };
    return punctuation[character] ?? 'Unidentified';
}

export { sleep };
