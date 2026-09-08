import { AsyncLocalStorage } from 'node:async_hooks';
const callContext = new AsyncLocalStorage();
// A plugin gets its own Node process. This is fault isolation, not an OS sandbox.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createKelpiAPI } from '../../../plugin-sdk/api.js';

const pending = new Map();
const listeners = new Map();
const commands = new Map();
const hooks = new Map();
const providers = new Map();
let sequence = 0;
let deactivate;
let closing = false;
const send = message => { if (process.connected) process.send(message, () => {}); };
const call = (method, args = {}) => new Promise((resolve, reject) => {
    if (closing) return reject(new Error('plugin is stopping'));
    if (pending.size >= 128) return reject(new Error('too many plugin calls'));
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    const parent = callContext.getStore();
    send({ type: 'call', id, method, args, context: parent?.context ?? {}, ...(parent ? { parentCallID: parent.id } : {}) });
});
const on = (name, listener) => {
    const set = listeners.get(name) ?? new Set();
    set.add(listener); listeners.set(name, set);
    return () => { set.delete(listener); if (set.size === 0) listeners.delete(name); };
};
const base = createKelpiAPI(call, () => callContext.getStore()?.context ?? {});
const api = Object.freeze({
    ...base,
    events: Object.freeze({ on }),
    commands: Object.freeze({ ...base.commands, register(id, handler) {
        if (commands.has(id) || typeof handler !== 'function') throw new Error(`invalid or duplicate command ${id}`);
        commands.set(id, handler); return () => commands.delete(id);
    } }),
    hooks: Object.freeze({ register(id, handler) {
        if (hooks.has(id) || typeof handler !== 'function') throw new Error(`invalid or duplicate hook ${id}`);
        hooks.set(id, handler); return () => hooks.delete(id);
    } }),
    providers: Object.freeze({ register(id, methods) {
        if (providers.has(id) || !methods || typeof methods !== 'object' || !Object.keys(methods).length || Object.values(methods).some(handler => typeof handler !== 'function')) throw new Error(`invalid or duplicate provider ${id}`);
        providers.set(id, Object.freeze({ ...methods })); return () => providers.delete(id);
    } }),
});

process.on('message', async message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'reply') {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (typeof message.error === 'string') entry.reject(new Error(message.error || 'plugin API call failed')); else entry.resolve(message.result);
    } else if (message.type === 'invoke' || message.type === 'hook' || message.type === 'service') {
        try {
            const handler = message.type === 'hook' ? hooks.get(message.hook) : message.type === 'service' ? providers.get(message.provider)?.[message.method] : commands.get(message.command);
            if (typeof handler !== 'function') throw new Error(`handler not registered: ${message.hook ?? message.provider ?? message.command}`);
            const context = message.context ?? message.operation?.context ?? {};
            const result = await callContext.run({ context, id: message.id }, () => message.type === 'hook' ? handler(message.operation) : handler(message.args, context));
            send({ type: 'result', id: message.id, result: result ?? null });
        } catch (error) { send({ type: 'result', id: message.id, error: String(error?.message ?? error) }); }
    } else if (message.type === 'event') {
        for (const listener of [...(listeners.get(message.event.name) ?? []), ...(listeners.get('*') ?? [])]) {
            try { await listener(message.event); } catch (error) { console.error('plugin event:', error); }
        }
        send({ type: 'event-ack' });
    } else if (message.type === 'stop') {
        closing = true;
        try { await deactivate?.(); } finally { process.exit(0); }
    }
});
process.on('disconnect', () => process.exit(0));
try {
    const module = await import(pathToFileURL(path.resolve(process.argv[2], process.argv[3])).href);
    if (typeof module.activate !== 'function') throw new Error('backend must export activate(api)');
    const result = await module.activate(api);
    deactivate = typeof result === 'function' ? result : module.deactivate;
    send({ type: 'ready', commands: [...commands.keys()], hooks: [...hooks.keys()], providers: [...providers.keys()], providerMethods: Object.fromEntries([...providers].map(([id, methods]) => [id, Object.keys(methods)])) });
} catch (error) {
    send({ type: 'failed', error: String(error?.message ?? error) });
    process.exitCode = 1;
    process.disconnect?.();
}
