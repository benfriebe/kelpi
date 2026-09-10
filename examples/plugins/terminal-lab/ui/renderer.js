import { consumeTerminalFrame, createInputRouter, gridFromMetrics, keyEventInit, revealLocation, stickyKey, stickyText } from './helpers.js';
import { applyXtermModes, bindXtermMouse } from './xterm-adapter.js';

/** Public Kelpi SDK only. Private fields below belong to the pinned xterm adapter. */
export async function mountTerminalLab(terminal, api, root) {
    let session, disposed = false, replaying = false, ingesting = false, ready = false, sent = 0, saveTimer;
    let presentation = { focused: false, visible: true }, modes = {}, modifiers = { ctrl: false, alt: false };
    let composing = false, lastReveal, lastGrid, observed = false, frameCount = 0, replayCount = 0, revealCount = 0;
    let resolveInitial;
    const initialGrid = new Promise(resolve => { resolveInitial = resolve; });
    const pendingWrites = [], disposables = [], listeners = [];
    let pendingBytes = 0;
    const phone = matchMedia('(pointer: coarse)').matches;
    const document = root.ownerDocument, window = document.defaultView;
    const problem = error => {
        const message = String(error?.message ?? error);
        document.body.dataset.error = message;
        const banner = document.getElementById('problem');
        if (banner) { banner.hidden = false; banner.textContent = message; }
    };
    const emit = (data, direct, response = false) => {
        if (disposed || (replaying && response)) return;
        sent++;
        if (session) { if (direct) session.writeDirect(data, response && ingesting ? { response: true } : undefined); else session.write(data); return; }
        pendingBytes += typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
        if (pendingBytes > 128 * 1024) throw new Error('Terminal input exceeded its attachment buffer.');
        pendingWrites.push({ data, direct });
    };
    const router = createInputRouter(emit);
    const listen = (target, name, listener, options = true) => {
        target.addEventListener(name, listener, options);
        listeners.push(() => target.removeEventListener(name, listener, options));
    };
    const setModifiers = value => {
        modifiers = { ctrl: value.ctrl, alt: value.alt };
        document.body.dataset.ctrl = String(modifiers.ctrl); document.body.dataset.alt = String(modifiers.alt);
    };
    terminal.open(root);
    const area = terminal.textarea;
    if (!area) throw new Error('Terminal input could not be opened.');
    area.setAttribute('autocapitalize', 'off'); area.setAttribute('autocorrect', 'off'); area.setAttribute('spellcheck', 'false');
    area.inputMode = phone ? 'none' : 'text';
    // xterm 6 exposes accurate CSS cell dimensions and the user-input event here.
    // Mode restoration and mouse report scoping live in xterm-adapter.js.
    const core = terminal._core;
    if (!core?.coreService?.onUserInput || !core?._renderService) throw new Error('Terminal Lab requires its pinned xterm 6 adapter.');
    disposables.push(core.coreService.onUserInput(() => router.userInput()));
    disposables.push(terminal.onData(data => router.data(data)), terminal.onBinary(data => router.binary(data)));
    disposables.push(bindXtermMouse(terminal, router));
    // xterm installs textarea capture handlers in open(). Capture on an ancestor
    // so sticky modifiers can cancel the original key before xterm emits it.
    const listenInput = (type, listener) => listen(root, type, event => { if (event.target === area) listener(event); });
    for (const type of ['keydown', 'keypress', 'paste', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']) listenInput(type, () => router.mark('keyboard'));
    listenInput('keyup', () => router.mark('release'));
    listenInput('compositionstart', () => { composing = true; });
    listenInput('compositionend', () => { composing = false; });
    const synthetic = new WeakSet();
    const dispatchKey = key => {
        if (disposed || !session) return false;
        const init = keyEventInit(key), type = key.type ?? 'keydown', previous = sent;
        const event = new window.KeyboardEvent(type, init); synthetic.add(event);
        return router.run(type === 'keyup' ? 'release' : 'keyboard', () => {
            area.dispatchEvent(event);
            // Browsers produce keypress for printable keys; synthetic keydown does not.
            if (type === 'keydown' && sent === previous && !event.defaultPrevented && !key.ctrlKey && !key.altKey && !key.metaKey && [...key.key].length === 1) {
                const point = key.key.codePointAt(0);
                if (point > 65535) emit(key.key, false);
                else {
                    const press = new window.KeyboardEvent('keypress', { ...init, charCode: point, which: point }); synthetic.add(press); area.dispatchEvent(press);
                }
            }
            return type === 'keyup' || sent !== previous || event.defaultPrevented;
        });
    };
    listenInput('keydown', event => {
        if (synthetic.has(event)) return;
        const key = stickyKey(event, modifiers, composing); if (!key) return;
        event.preventDefault(); event.stopImmediatePropagation(); setModifiers({ ctrl: false, alt: false }); dispatchKey(key);
    });
    listenInput('beforeinput', event => {
        const key = stickyText(event, modifiers, composing); if (!key) return;
        event.preventDefault(); event.stopImmediatePropagation(); setModifiers({ ctrl: false, alt: false }); dispatchKey(key);
    });
    const fit = () => {
        if (disposed || !presentation.visible) return null;
        const cell = core._renderService.dimensions?.css?.cell;
        const bounds = root.getBoundingClientRect();
        const style = window.getComputedStyle(root);
        const grid = gridFromMetrics(bounds.width, bounds.height, cell, presentation.paddingX ?? (parseFloat(style.paddingLeft) || 0), presentation.paddingY ?? (parseFloat(style.paddingTop) || 0));
        if (!grid) return null;
        if (terminal.cols !== grid.cols || terminal.rows !== grid.rows) terminal.resize(grid.cols, grid.rows);
        if (session && (lastGrid?.cols !== grid.cols || lastGrid?.rows !== grid.rows)) session.resize(grid.cols, grid.rows);
        if (session && lastGrid?.cellHeight !== grid.cellHeight) session.setCellHeight(grid.cellHeight);
        lastGrid = grid; resolveInitial?.(grid); resolveInitial = undefined; return grid;
    };
    const observer = new ResizeObserver(() => fit());
    const reveal = value => {
        if (!ready || !value || value.seq === lastReveal) return;
        const location = revealLocation(terminal.buffer.active.length, terminal.rows, value);
        if (location) { terminal.scrollToLine(location.top); terminal.select(location.col, location.line, location.length); revealCount++; }
        lastReveal = value.seq;
    };
    const applyPresentation = value => {
        presentation = value;
        document.body.dataset.visible = String(value.visible); document.body.dataset.focused = String(value.focused);
        root.style.visibility = value.visible ? 'visible' : 'hidden';
        document.body.style.background = value.background ?? value.theme?.background ?? terminal.options.theme?.background ?? '#000000';
        if (value.theme) terminal.options.theme = value.theme;
        if (value.fontFamily) terminal.options.fontFamily = value.fontFamily;
        if (value.fontSize) terminal.options.fontSize = value.fontSize;
        if (value.allowTransparency !== undefined) terminal.options.allowTransparency = value.allowTransparency;
        if (value.paddingX !== undefined) root.style.paddingInline = `${value.paddingX}px`;
        if (value.paddingY !== undefined) root.style.paddingBlock = `${value.paddingY}px`;
        area.setAttribute('aria-label', value.accessibilityName ?? 'Terminal');
        if (value.visible && !observed) { observer.observe(root); observed = true; }
        if (!value.visible && observed) { observer.disconnect(); observed = false; }
        if (!value.visible || !value.focused) terminal.blur();
        // Logical focus is distinct from caret ownership: only explicit actions may focus.
        fit(); reveal(value.reveal);
    };
    const write = data => new Promise(resolve => terminal.write(data, resolve));
    const onFrame = async frame => {
        if (disposed) return;
        frameCount++;
        if (frame.type === 'presentation') { applyPresentation(frame.value); return; }
        if (frame.type === 'modes') { modes = frame.modes; applyXtermModes(terminal, modes); return; }
        if (frame.type === 'resync') { document.body.dataset.resync = frame.reason; return; }
        if (frame.type === 'exit') { document.body.dataset.exit = String(frame.exitCode); return; }
        const scroll = ready ? terminal.buffer.active.baseY - terminal.buffer.active.viewportY : Number(api.state?.linesAboveBottom) || 0;
        replaying = frame.type === 'replay'; ingesting = true;
        try { await consumeTerminalFrame(terminal, frame, write, () => applyXtermModes(terminal, modes)); }
        finally { replaying = false; ingesting = false; }
        if (frame.type === 'replay') {
            replayCount++;
            ready = true;
            if (session && globalThis.terminalLab?.session === session) document.body.dataset.ready = 'true';
            if (scroll > 0) terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - scroll));
            lastReveal = undefined; reveal(presentation.reveal);
        }
    };
    const onAction = action => {
        if (disposed) return null;
        switch (action.type) {
            case 'selection': return terminal.getSelection();
            case 'dispatchKey': return dispatchKey(action.key);
            case 'paste': if (!session) return false; router.run('keyboard', () => terminal.paste(action.text)); return true;
            case 'modifiers': setModifiers(action); return null;
            case 'showKeyboard': area.inputMode = 'text'; terminal.focus(); return null;
            case 'hideKeyboard': terminal.blur(); area.inputMode = phone ? 'none' : 'text'; root.focus({ preventScroll: true }); return null;
            case 'focus': if (presentation.visible) { if (phone && area.inputMode === 'none') root.focus({ preventScroll: true }); else terminal.focus(); } return null;
            case 'blur': terminal.blur(); return null;
            default: return null;
        }
    };
    disposables.push(terminal.onScroll(() => {
        if (!ready || replaying || disposed) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            if (!disposed) void api.setState({ linesAboveBottom: Math.max(0, terminal.buffer.active.baseY - terminal.buffer.active.viewportY) }).catch(problem);
        }, 200);
    }));
    const dispose = () => {
        if (disposed) return;
        disposed = true; resolveInitial?.(null); resolveInitial = undefined; clearTimeout(saveTimer); observer.disconnect(); session?.dispose();
        for (const off of listeners) off(); for (const item of disposables) item.dispose(); terminal.dispose();
    };
    listen(window, 'pagehide', dispose);
    await api.ready;
    if (disposed) return;
    presentation.visible = api.visible !== false;
    listeners.push(api.onContext(value => {
        if (disposed || session) return;
        presentation.visible = value.visible !== false;
        if (presentation.visible && !observed) { observer.observe(root); observed = true; }
        if (!presentation.visible && observed) { observer.disconnect(); observed = false; }
        fit();
    }));
    if (presentation.visible) { observer.observe(root); observed = true; }
    else { resolveInitial?.({ cols: terminal.cols, rows: terminal.rows, cellHeight: null }); resolveInitial = undefined; }
    fit();
    void document.fonts?.ready.then(() => fit());
    const initial = await initialGrid;
    if (disposed) return;
    try {
        session = await api.terminal.attach({ cols: initial.cols, rows: initial.rows, onFrame, onAction });
        if (disposed) { session.dispose(); return; }
        terminal.options.disableStdin = false;
        // Metrics were measured before attach, so report them explicitly once the session exists.
        if (initial.cellHeight !== null) session.setCellHeight(initial.cellHeight);
        lastGrid = undefined; fit();
        for (const entry of pendingWrites.splice(0)) if (entry.direct) session.writeDirect(entry.data); else session.write(entry.data);
        pendingBytes = 0;
        const diagnostics = { terminal, session, dispose, fit, get presentation() { return presentation; }, get modes() { return modes; }, get modifiers() { return modifiers; }, get frameCount() { return frameCount; }, get replayCount() { return replayCount; }, get revealCount() { return revealCount; } };
        globalThis.terminalLab = diagnostics;
        document.body.dataset.ready = String(ready);
        return diagnostics;
    } catch (error) { dispose(); throw error; }
}
