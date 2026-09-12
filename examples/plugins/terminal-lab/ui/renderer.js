import { consumeTerminalFrame, createInputRouter, gridFromMetrics, keyEventInit, revealLocation, stickyKey, stickyText } from './helpers.js';
import { applyXtermModes, bindXtermMouse } from './xterm-adapter.js';

/** Public Kelpi SDK only. Private fields below belong to the pinned xterm adapter. */
export async function mountTerminalLab(terminal, api, root) {
    let session, disposed = false, replaying = false, ingesting = false, ready = false, sent = 0, saveTimer;
    let presentation = { focused: false, visible: true }, modes = {}, modifiers = { ctrl: false, alt: false };
    let composing = false, lastReveal, lastGrid, observed = false, frameCount = 0, replayCount = 0, revealCount = 0;
    // The grid this emulator is MIRRORING, or null when it renders this view's own measured box.
    let mirror = null;
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
        setModifiers({ ctrl: false, alt: false });
        if (dispatchKey(key)) { event.preventDefault(); event.stopImmediatePropagation(); }
    });
    listenInput('beforeinput', event => {
        const key = stickyText(event, modifiers, composing); if (!key) return;
        setModifiers({ ctrl: false, alt: false });
        // Preserve the original text if xterm has no encoding for this modified key.
        if (dispatchKey(key)) { event.preventDefault(); event.stopImmediatePropagation(); }
    });
    // `ownsSize` absent means this window sizes the process: an older host states nothing, and the
    // host's own default for an omitted prop is the same answer. Only an explicit false mirrors.
    const owns = () => presentation.ownsSize !== false;
    const setMirror = value => {
        mirror = value;
        if (value) document.body.dataset.mirror = `${value.cols}x${value.rows}`;
        else delete document.body.dataset.mirror;
    };
    /**
     * Regaining ownership: the emulator follows this view's own box again, at once.
     *
     * Not through the measure path alone, which idles while hidden and for a zero-sized box and
     * would leave the emulator stranded on the ex-owner's grid. Reporting is left to `fit()`: the
     * host issues the forced PTY claim for this transition, so a report from here would be spam.
     */
    const unmirror = () => {
        if (mirror === null) return false;
        setMirror(null);
        if (lastGrid && (terminal.cols !== lastGrid.cols || terminal.rows !== lastGrid.rows)) terminal.resize(lastGrid.cols, lastGrid.rows);
        return true;
    };
    /**
     * A replay is a screen composed for the grid it was serialised at. While another client owns
     * the process size, those bytes are only meaningful at that grid: the serialiser writes a
     * soft-wrapped row and its continuation with no newline between them, so an emulator at any
     * other width lays the halves side by side and re-glues them on every later replay.
     *
     * A stated grid is therefore adopted BEFORE the bytes are written, so the in-band reset in
     * `consumeTerminalFrame` lands on an emulator that is already the right shape. `null` is an
     * older daemon stating nothing: keep the emulator where it is rather than guessing.
     */
    const adoptReplayGrid = grid => {
        if (owns()) { if (unmirror()) fit(); return; }
        if (!grid || !(grid.cols > 0) || !(grid.rows > 0)) return;
        setMirror({ cols: grid.cols, rows: grid.rows });
        if (terminal.cols !== grid.cols || terminal.rows !== grid.rows) terminal.resize(grid.cols, grid.rows);
    };
    const fit = () => {
        if (disposed || !presentation.visible) return null;
        const cell = core._renderService.dimensions?.css?.cell;
        const bounds = root.getBoundingClientRect();
        const style = window.getComputedStyle(root);
        const grid = gridFromMetrics(bounds.width, bounds.height, cell, presentation.paddingX ?? (parseFloat(style.paddingLeft) || 0), presentation.paddingY ?? (parseFloat(style.paddingTop) || 0));
        if (!grid) return null;
        // The emulator follows this box only while this window sizes the process. Under a mirror it
        // stays at the owner's grid; the MEASUREMENT below is still taken and still reported,
        // because that report is the daemon's takeover cache and this viewer's own snapshot
        // request. It is a measurement, never the mirrored grid.
        if (mirror === null && (terminal.cols !== grid.cols || terminal.rows !== grid.rows)) terminal.resize(grid.cols, grid.rows);
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
        // Regaining the process size un-mirrors now; losing it needs nothing, because the next
        // replay states the new owner's grid and establishes the mirror from it.
        if (owns()) unmirror();
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
        // `replaying` before the mirror resize, not after: a row-count change moves the viewport and
        // fires onScroll, which would otherwise arm the scroll-position save with the pre-replay
        // offset and persist a position for a screen that is about to be replaced.
        replaying = frame.type === 'replay'; ingesting = true;
        if (replaying) adoptReplayGrid(frame.grid);
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
        const diagnostics = { terminal, session, dispose, fit, get presentation() { return presentation; }, get modes() { return modes; }, get modifiers() { return modifiers; }, get frameCount() { return frameCount; }, get replayCount() { return replayCount; }, get revealCount() { return revealCount; }, get mirror() { return mirror; }, get measured() { return lastGrid ?? null; } };
        globalThis.terminalLab = diagnostics;
        document.body.dataset.ready = String(ready);
        return diagnostics;
    } catch (error) { dispose(); throw error; }
}
