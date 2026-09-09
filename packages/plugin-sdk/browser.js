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
    let navigation = null, navigationInitial = null, navigationDisposed = false;
    const navigationListeners = new Set();
    const freezeNavigation = value => {
        if (value !== null && typeof value === 'object') {
            for (const item of Object.values(value)) freezeNavigation(item);
            Object.freeze(value);
        }
        return value;
    };
    const deliverNavigation = (entry, value) => {
        if (navigationDisposed || !navigationListeners.has(entry) || value.sequence <= entry.sequence) return entry.draining;
        entry.sequence = value.sequence;
        entry.latest = value;
        if (!entry.draining) entry.draining = Promise.resolve().then(async () => {
            try {
                while (!navigationDisposed && navigationListeners.has(entry) && entry.latest) {
                    const next = entry.latest; entry.latest = null;
                    const delivery = Promise.resolve().then(() => {
                        if (navigationDisposed || !navigationListeners.has(entry)) return;
                        if (next.type === 'navigation') return entry.listener(next.value);
                        if (entry.onError) return entry.onError(new Error(next.error));
                        reportError(next.error);
                    }).catch(error => console.error('plugin navigation listener', error));
                    // Unsubscribing releases the frame even if an author callback never settles.
                    await Promise.race([delivery, entry.cancelled]);
                }
            } finally { entry.draining = null; }
        });
        return entry.draining;
    };
    const onNavigation = (listener, onError) => {
        if (typeof listener !== 'function' || (onError !== undefined && typeof onError !== 'function')) throw new Error('Navigation requires a listener and an optional error listener.');
        if (navigationDisposed) throw new Error('Navigation is unavailable after view disposal.');
        if (navigationListeners.size >= 64) throw new Error('Too many navigation listeners.');
        let cancel;
        const entry = { listener, onError, latest: null, draining: null, sequence: -1, cancelled: new Promise(resolve => { cancel = resolve; }) };
        entry.dispose = () => { navigationListeners.delete(entry); entry.latest = null; cancel(); };
        navigationListeners.add(entry);
        void ready.then(async () => {
            if (navigationDisposed || !navigationListeners.has(entry)) return;
            if (!navigation) {
                // The host only starts feeds for eligible views. This bounded initial call
                // also reports an unavailable host to subscribers without failing unrelated
                // remote-owned views that never requested window navigation.
                navigationInitial ??= base.call('ui.getNavigation').then(value => {
                    if (!navigation && !navigationDisposed) navigation = freezeNavigation({ type: 'navigation', sequence: 0, value });
                }, error => {
                    if (!navigation && !navigationDisposed) navigation = { type: 'navigation-error', sequence: 0, error: String(error.message ?? error).slice(0, 4096) };
                });
                await navigationInitial;
            }
            if (navigation) return deliverNavigation(entry, navigation);
        });
        return entry.dispose;
    };
    const call = async (method, args = {}) => {
        await ready;
        if (pending.size >= 64) throw new Error('too many pending Kelpi calls');
        if (new TextEncoder().encode(JSON.stringify(args)).length > 256 * 1024) throw new Error('Kelpi call exceeds 256 KiB');
        const id = String(++next);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('Kelpi call timed out')); }, 35_000);
            pending.set(id, { resolve, reject, timer }); send({ type: 'call', id, method, args });
        });
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
            else if (data.type === 'navigation' || data.type === 'navigation-error') {
                if (navigationDisposed || !Number.isSafeInteger(data.sequence) || data.sequence <= 0) return;
                if (!navigation || data.sequence > navigation.sequence) {
                    navigation = freezeNavigation(data);
                    await Promise.all([...navigationListeners].map(entry => deliverNavigation(entry, navigation)));
                }
                if (!navigationDisposed) send({ type: 'navigation-ack', sequence: data.sequence });
            }
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
            onNavigation,
        })
    });
    const reportError = message => { void ready.then(() => send({ type: 'view-error', message: String(message).slice(0, 4096) })); };
    addEventListener('error', event => reportError(event.message ?? 'Plugin resource failed to load'), true);
    addEventListener('unhandledrejection', event => reportError(event.reason?.message ?? event.reason));
    addEventListener('pagehide', () => {
        navigationDisposed = true; navigation = null;
        for (const entry of navigationListeners) entry.dispose();
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
