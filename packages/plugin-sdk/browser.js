/* Injected as a classic script into an opaque-origin iframe. No owner credentials. */
(() => {
    const config = globalThis.__KELPI_VIEW__;
    delete globalThis.__KELPI_VIEW__;
    let port, next = 0, live = config;
    const pending = new Map(), listeners = new Map(), contextListeners = new Set();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const send = message => port.postMessage(message);
    const on = (name, listener) => {
        const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group);
        return () => { group.delete(listener); if (!group.size) listeners.delete(name); };
    };
    const environment = () => ({ context: live.context, state: live.state, stateVersion: live.stateVersion, theme: live.theme ?? {}, visible: live.visible !== false });
    const deliverContext = (entry, value) => { void Promise.resolve().then(() => {
        if (contextListeners.has(entry)) return entry.listener(value);
    }).catch(error => console.error('plugin context listener', error)); };
    const notifyContext = () => { const value = environment(); for (const entry of contextListeners) deliverContext(entry, value); };
    const onContext = listener => {
        const entry = { listener }; contextListeners.add(entry);
        void ready.then(() => deliverContext(entry, environment()));
        return () => { contextListeners.delete(entry); };
    };
    const createWindowSubscription = (topic, method) => {
        let snapshot = null, initial = null, disposed = false;
        const entries = new Set();
        const freezeSnapshot = value => {
            if (value !== null && typeof value === 'object') {
                for (const item of Object.values(value)) freezeSnapshot(item);
                Object.freeze(value);
            }
            return value;
        };
        const deliver = (entry, value) => {
            if (disposed || !entries.has(entry) || value.sequence <= entry.sequence) return entry.draining;
            entry.sequence = value.sequence;
            entry.latest = value;
            if (!entry.draining) entry.draining = Promise.resolve().then(async () => {
                try {
                    while (!disposed && entries.has(entry) && entry.latest) {
                        const next = entry.latest; entry.latest = null;
                        const delivery = Promise.resolve().then(() => {
                            if (disposed || !entries.has(entry)) return;
                            if (next.type === topic) return entry.listener(next.value);
                            if (entry.onError) return entry.onError(new Error(next.error));
                            reportError(next.error);
                        }).catch(error => console.error(`plugin ${topic} listener`, error));
                        // Unsubscribing releases the frame even if an author callback never settles.
                        await Promise.race([delivery, entry.cancelled]);
                    }
                } finally { entry.draining = null; }
            });
            return entry.draining;
        };
        const subscribe = (listener, onError) => {
            if (typeof listener !== 'function' || (onError !== undefined && typeof onError !== 'function')) throw new Error('Window feed requires a listener and an optional error listener.');
            if (disposed) throw new Error('Window feed is unavailable after view disposal.');
            if (entries.size >= 64) throw new Error(`Too many ${topic} listeners.`);
            let cancel;
            const entry = { listener, onError, latest: null, draining: null, sequence: -1, cancelled: new Promise(resolve => { cancel = resolve; }) };
            entry.dispose = () => { entries.delete(entry); entry.latest = null; cancel(); };
            entries.add(entry);
            void ready.then(async () => {
                if (disposed || !entries.has(entry)) return;
                if (!snapshot) {
                    // The host only starts feeds for eligible views. This bounded initial call
                    // also reports an unavailable host to subscribers without failing unrelated
                    // remote-owned views that never requested this window feed.
                    initial ??= base.call(method).then(value => {
                        if (!snapshot && !disposed) snapshot = freezeSnapshot({ type: topic, sequence: 0, value });
                    }, error => {
                        if (!snapshot && !disposed) snapshot = { type: `${topic}-error`, sequence: 0, error: String(error.message ?? error).slice(0, 4096) };
                    });
                    await initial;
                }
                if (snapshot) return deliver(entry, snapshot);
            });
            return entry.dispose;
        };
        return {
            subscribe,
            async receive(data) {
                if (disposed || !Number.isSafeInteger(data.sequence) || data.sequence <= 0) return;
                if (!snapshot || data.sequence > snapshot.sequence) {
                    snapshot = freezeSnapshot(data);
                    await Promise.all([...entries].map(entry => deliver(entry, snapshot)));
                }
                if (!disposed) send({ type: `${topic}-ack`, sequence: data.sequence });
            },
            dispose() { disposed = true; snapshot = null; for (const entry of entries) entry.dispose(); }
        };
    };
    const navigationFeed = createWindowSubscription('navigation', 'ui.getNavigation');
    const chromeFeed = createWindowSubscription('chrome', 'ui.getChrome');
    const request = (method, args = {}, cancelled) => {
        if (pending.size >= 64) throw new Error('too many pending Kelpi calls');
        if (new TextEncoder().encode(JSON.stringify(args)).length > 256 * 1024) throw new Error('Kelpi call exceeds 256 KiB');
        const id = String(++next);
        return new Promise((resolve, reject) => {
            // Human interaction owns these requests' lifetime; the window cancels their
            // scope on view removal. A normal RPC deadline must not abandon an open prompt.
            const interactive = ['ui.showQuickPick', 'ui.showInput', 'ui.showDialog', 'ui.showNotification'].includes(method);
            const timer = interactive ? undefined : setTimeout(() => { pending.delete(id); reject(new Error('Kelpi call timed out')); }, 35_000);
            pending.set(id, { resolve, reject, timer });
            if (cancelled) void cancelled.then(() => {
                if (!pending.delete(id)) return;
                clearTimeout(timer); reject(new Error('Terminal session is disposed.'));
            });
            try { send({ type: 'call', id, method, args }); }
            catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
    };
    const call = async (method, args = {}) => { await ready; return request(method, args); };
    let terminalSession = null, terminalCounter = 0, terminalDisposed = false;
    const terminalSize = (cols, rows) => {
        if (![cols, rows].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)) throw new Error('Terminal dimensions must be integers from 1 through 65535.');
    };
    const isTerminalBytes = data => ArrayBuffer.isView(data) && Object.prototype.toString.call(data) === '[object Uint8Array]';
    const terminalBytes = data => {
        if (typeof data !== 'string' && !isTerminalBytes(data)) throw new Error('Terminal input must be a string or Uint8Array.');
        // Check before cloning, including a cheap UTF-16 lower bound before UTF-8 encoding.
        if (data.length > 128 * 1024) throw new Error('Terminal input exceeds 128 KiB.');
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        if (bytes.byteLength > 128 * 1024) throw new Error('Terminal input exceeds 128 KiB.');
        return typeof data === 'string' ? bytes : new Uint8Array(bytes);
    };
    const terminalError = (entry, error) => {
        if (entry.disposed) return;
        entry.dispose(); reportError(error?.message ?? error);
    };
    const attachTerminal = async options => {
        if (terminalDisposed) throw new Error('Terminal attachment is unavailable after view disposal.');
        if (terminalSession) throw new Error('This view already has a terminal session.');
        if (!options || typeof options.onFrame !== 'function' || (options.onAction !== undefined && typeof options.onAction !== 'function')) throw new Error('Terminal attachment requires onFrame and an optional onAction callback.');
        const { cols, rows } = options; terminalSize(cols, rows);
        let cancel;
        const entry = {
            id: `terminal-${++terminalCounter}`, disposed: false, requested: false,
            generation: 0, sequence: 0, processing: false, activeFrame: null, actions: new Set(),
            onFrame: options.onFrame, onAction: options.onAction,
            cancelled: new Promise(resolve => { cancel = resolve; }),
        };
        const assertActive = () => { if (entry.disposed) throw new Error('Terminal session is disposed.'); };
        entry.dispose = () => {
            if (entry.disposed) return;
            entry.disposed = true; entry.activeFrame = null; entry.actions.clear(); cancel();
            if (terminalSession === entry) terminalSession = null;
            if (entry.requested && port) {
                // A detached MessagePort may already be closed during pagehide.
                try { send({ type: 'terminal-detach', session: entry.id }); } catch {}
            }
        };
        const write = (data, direct, options = {}) => {
            assertActive();
            if (options === null || typeof options !== 'object' || Array.isArray(options) || (options.response !== undefined && typeof options.response !== 'boolean')) throw new Error('Terminal response option must be a boolean.');
            let response;
            if (options.response === true) {
                const frame = entry.activeFrame;
                if (!frame || !['replay', 'output'].includes(frame.type)) throw new Error('Terminal responses require an active replay or output callback.');
                response = { response: true, generation: frame.generation, sequence: frame.sequence };
            }
            send({ type: 'terminal-input', session: entry.id, data: terminalBytes(data), direct, ...response });
        };
        const session = Object.freeze({
            id: entry.id,
            write: data => write(data, false), writeDirect: (data, options) => write(data, true, options),
            resize: (cols, rows) => { assertActive(); terminalSize(cols, rows); send({ type: 'terminal-resize', session: entry.id, cols, rows }); },
            setCellHeight: cellHeight => {
                assertActive();
                if (!Number.isFinite(cellHeight) || cellHeight <= 0 || cellHeight > 512) throw new Error('Terminal cell height must be greater than zero and at most 512 CSS pixels.');
                send({ type: 'terminal-metrics', session: entry.id, cellHeight });
            },
            dispose: entry.dispose,
        });
        // Register before sending attach: the native subscription can synchronously deliver
        // its replay and modes before the host's attachment reply reaches this iframe.
        terminalSession = entry;
        try {
            await Promise.race([ready, entry.cancelled]); assertActive();
            entry.requested = true;
            await request('terminal.attach', { session: entry.id, cols, rows }, entry.cancelled);
            assertActive(); return session;
        } catch (error) { entry.dispose(); throw error; }
    };
    const receiveTerminalFrame = async data => {
        const entry = terminalSession;
        if (!entry || entry.disposed || entry.id !== data.session) return;
        if (!Number.isSafeInteger(data.generation) || data.generation <= 0 || !Number.isSafeInteger(data.sequence) || data.sequence <= 0) return terminalError(entry, 'Invalid terminal frame sequence.');
        if (data.generation < entry.generation || data.sequence <= entry.sequence) return;
        // The host keeps one posted frame in flight even across resyncs. Do not introduce a
        // second independently growing queue in the iframe, or ACK before its parser finishes.
        if (entry.processing) return terminalError(entry, 'Terminal host sent a frame before the previous frame was consumed.');
        const frame = data.frame;
        if (!frame || !['replay', 'output', 'resync', 'modes', 'exit', 'presentation'].includes(frame.type)
            || (['replay', 'output'].includes(frame.type) && !isTerminalBytes(frame.data))) return terminalError(entry, 'Invalid terminal frame.');
        entry.generation = data.generation; entry.sequence = data.sequence; entry.processing = true;
        entry.activeFrame = { type: frame.type, generation: data.generation, sequence: data.sequence };
        const delivery = Promise.resolve().then(() => { if (!entry.disposed) return entry.onFrame(frame); });
        let consumed = false;
        try {
            await Promise.race([delivery, entry.cancelled]);
            consumed = !entry.disposed;
        } catch (error) { terminalError(entry, error); }
        finally { entry.processing = false; entry.activeFrame = null; }
        // Release before sending the ACK so an immediate host response can run.
        if (consumed && !entry.disposed) send({ type: 'terminal-ack', session: entry.id, generation: data.generation, sequence: data.sequence });
    };
    const receiveTerminalAction = async data => {
        const entry = terminalSession;
        if (!entry || entry.disposed || entry.id !== data.session || typeof data.id !== 'string' || !data.id || entry.actions.has(data.id)) return;
        const reply = (result, error) => {
            if (entry.disposed) return;
            send({ type: 'terminal-action-reply', session: entry.id, id: data.id, result, ...(error === undefined ? {} : { error: String(error?.message ?? error).slice(0, 4096) }) });
        };
        if (entry.actions.size >= 32) { reply(null, 'Too many pending terminal actions.'); return; }
        entry.actions.add(data.id);
        const type = data.action?.type;
        try {
            if (!['selection', 'dispatchKey', 'paste', 'focus', 'blur', 'showKeyboard', 'hideKeyboard', 'modifiers'].includes(type)) throw new Error('Unsupported terminal action.');
            const delivery = Promise.resolve().then(() => {
                if (entry.disposed) return;
                return entry.onAction ? entry.onAction(data.action) : type === 'selection' ? '' : ['dispatchKey', 'paste'].includes(type) ? false : null;
            });
            let result = await Promise.race([delivery, entry.cancelled]);
            if (entry.disposed) return;
            if (type === 'selection') {
                if (typeof result !== 'string') throw new Error('Terminal selection must return a string.');
                if (result.length > 256 * 1024 || new TextEncoder().encode(result).byteLength > 256 * 1024) throw new Error('Terminal selection exceeds 256 KiB.');
            } else if (['dispatchKey', 'paste'].includes(type)) {
                if (typeof result !== 'boolean') throw new Error('Terminal key and paste actions must return a boolean.');
            } else {
                if (result !== null && result !== undefined) throw new Error('Terminal presentation actions must return null or undefined.');
                result = null;
            }
            reply(result);
        } catch (error) { reply(null, error); }
        finally { entry.actions.delete(data.id); }
    };
    const applyTheme = () => { for (const [key, value] of Object.entries(live.theme ?? {})) document.documentElement.style.setProperty(key, value); };
    addEventListener('message', function connect(event) {
        if (event.source !== parent || event.data?.type !== 'kelpi-plugin-connect' || event.data.nonce !== config.nonce || !event.ports[0] || port) return;
        port = event.ports[0]; removeEventListener('message', connect);
        port.onmessage = async ({ data }) => {
            if (data.type === 'reply') {
                const entry = pending.get(data.id); if (!entry) return;
                pending.delete(data.id); clearTimeout(entry.timer);
                if (data.error) entry.reject(new Error(data.error)); else entry.resolve(data.result);
            } else if (data.type === 'context') { live = { ...live, ...data.value }; applyTheme(); notifyContext(); }
            else if (data.type === 'navigation' || data.type === 'navigation-error') await navigationFeed.receive(data);
            else if (data.type === 'chrome' || data.type === 'chrome-error') await chromeFeed.receive(data);
            else if (data.type === 'terminal-frame') await receiveTerminalFrame(data);
            else if (data.type === 'terminal-action') await receiveTerminalAction(data);
            else if (data.type === 'event') {
                for (const listener of [...(listeners.get(data.event.name) ?? []), ...(listeners.get('*') ?? [])]) {
                    await Promise.resolve().then(() => listener(data.event)).catch(error => console.error('plugin listener', error));
                }
                send({ type: 'event-ack' });
            }
        };
        port.start(); applyTheme(); resolveReady();
    });
    const base = createKelpiAPI(call, () => live.context ?? {});
    globalThis.kelpi = Object.freeze({
        ...base,
        ready, onContext, get context() { return live.context; }, get state() { return live.state; },
        get stateVersion() { return live.stateVersion; }, get theme() { return live.theme; }, get visible() { return live.visible; },
        setState: async state => { const result = await base.call('views.setState', { state }); live = { ...live, state, stateVersion: result.stateVersion }; notifyContext(); },
        events: Object.freeze({ on }),
        terminal: Object.freeze({ ...base.terminal, attach: attachTerminal }),
        documents: Object.freeze({
            ...base.documents,
            stage: (text, revision) => base.call('documents.stage', { text, revision }),
            applyDraft: async (id, revision) => {
                try { return await base.call('documents.applyDraft', { id, revision }); }
                catch (error) {
                    const code = error.message?.split(':')[0];
                    if (code === 'DOCUMENT_CONFLICT' || code === 'DOCUMENT_DRAFT_SUPERSEDED') throw new KelpiError(error.message, { code, method: 'documents.applyDraft', cause: error });
                    throw error;
                }
            },
        }),
        ui: Object.freeze({
            ...base.ui,
            activateWorkspace: workspaceID => base.call('ui.activateWorkspace', { workspaceID }),
            focusPane: (workspaceID, paneID) => base.call('ui.focusPane', { workspaceID, paneID }),
            notify: message => base.call('ui.notify', { message }),
            getWorkbench: () => base.call('ui.getWorkbench'),
            selectView: async (slot, viewID) => { await base.call('ui.selectView', { slot, viewID }); },
            activateTab: async (containerID, slotID) => { await base.call('ui.activateTab', { containerID, slotID }); },
            getNavigation: () => base.call('ui.getNavigation'),
            selectWorkspace: async (hostID, workspaceID) => { await base.call('ui.selectWorkspace', { hostID, workspaceID }); },
            onNavigation: navigationFeed.subscribe,
            getChrome: () => base.call('ui.getChrome'),
            onChrome: chromeFeed.subscribe,
            executeChromeCommand: async (id, target = {}) => { await base.call('ui.executeChromeCommand', { id, target }); },
            showQuickPick: options => base.call('ui.showQuickPick', options),
            showInput: options => base.call('ui.showInput', options),
            showDialog: options => base.call('ui.showDialog', options),
            showNotification: options => base.call('ui.showNotification', options),
        })
    });
    const reportError = message => { void ready.then(() => send({ type: 'view-error', message: String(message).slice(0, 4096) })); };
    addEventListener('error', event => reportError(event.message ?? 'Plugin resource failed to load'), true);
    addEventListener('unhandledrejection', event => reportError(event.reason?.message ?? event.reason));
    addEventListener('pagehide', () => {
        navigationFeed.dispose(); chromeFeed.dispose();
        terminalDisposed = true; terminalSession?.dispose();
    });
    addEventListener('pointerdown', () => { if (port && live.visible !== false) send({ type: 'focus' }); }, true);
    addEventListener('focusin', () => { if (port && live.visible !== false) send({ type: 'focus' }); });
    addEventListener('keydown', event => {
        const modifiers = (event.shiftKey ? 4 : 0) | (event.ctrlKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.metaKey ? 8 : 0);
        if (!port || live.visible === false || event.isComposing || !(live.chords ?? []).includes(`${modifiers}/${event.code}`)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        send({ type: 'key', key: event.key, code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey });
    }, true);
    parent.postMessage({ type: 'kelpi-plugin-ready', nonce: config.nonce }, '*');
})();
