/** Passive, bounded incident evidence. No focus repair, key replay, polling, or clipboard writes.
 * Wrappers/listeners add timing overhead; a passing instrumented run cannot establish the cause
 * of an earlier failure. Per-renderer monotonic clocks are separate, not a global total order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function redactFixtureText(value, allowed = [], limit = 160) {
    const text = String(value ?? '');
    return { length: text.length, ...(allowed.includes(text) ? { text: text.slice(0, limit), truncated: text.length > limit } : { redacted: true }) };
}

// Self-contained because this function runs in each renderer, including OOPIFs.
export function installRendererRecorder({ key, allowed, capacity, ownerId }) {
    if (globalThis[key]) throw new Error('incident recorder already armed');
    const generation = `${performance.timeOrigin}:${Math.random()}`;
    let sequence = 0, frozen = false;
    const events = [], restores = [], diagnosticErrors = [];
    const observedTerminal = globalThis.terminalLab?.terminal;
    const originalSelection = observedTerminal?.getSelection;
    const diagnosticError = (phase, error) => {
        let name = 'Error';
        try { name = String(error?.name ?? 'Error'); } catch { /* never let observation replace the operation */ }
        if (diagnosticErrors.length < 16) diagnosticErrors.push({ phase, error: name });
    };
    const safe = value => {
        const text = String(value ?? '');
        return { length: text.length, ...(allowed.includes(text) ? { text: text.slice(0, 160), truncated: text.length > 160 } : { redacted: true }) };
    };
    const state = () => {
        const terminal = globalThis.terminalLab?.terminal;
        const active = document.activeElement;
        return {
            hasFocus: document.hasFocus(), visibility: document.visibilityState,
            activation: navigator.userActivation ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null,
            activeElement: active ? { tag: active.tagName, testID: active.getAttribute('data-testid'), role: active.getAttribute('role') } : null,
            selection: safe(originalSelection ? originalSelection.call(observedTerminal) : globalThis.getSelection?.()?.toString()),
            terminals: [...document.querySelectorAll('[data-terminal-status]')].slice(0, 8).map(element => Object.fromEntries(
                [...element.attributes].filter(a => /^data-terminal-(selection|status|resizes|rows|cols|reset|replay)/.test(a.name)).map(a => [a.name, a.value]))),
            renderer: globalThis.terminalLab ? { frameCount: terminalLab.frameCount, replayCount: terminalLab.replayCount,
                revealCount: terminalLab.revealCount, resync: document.body?.dataset.resync } : null
        };
    };
    const record = (kind, detail = {}) => {
        if (frozen) return;
        try {
            let observed;
            try { observed = state(); } catch (error) { diagnosticError('state', error); observed = { unavailable: 'diagnostic state read failed' }; }
            events.push({ sequence: ++sequence, monotonicMs: performance.now(), kind, ...detail, state: observed });
            if (events.length > capacity) events.shift();
        } catch (error) { diagnosticError('record', error); }
    };
    // Never retain typed arbitrary text, composition text, page text, or clipboard payloads.
    const listener = event => { try { record(event.type, { trusted: event.isTrusted,
        ...(event.type.startsWith('key') ? { code: /^(Key[CV]|MetaLeft|MetaRight|ControlLeft|ControlRight|ShiftLeft|ShiftRight)$/.test(event.code) ? event.code : '[redacted]', meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey } : {}),
        ...(event.clipboardData ? { clipboard: safe(event.clipboardData.getData('text/plain')) } : {}) }); } catch (error) { diagnosticError('event', error); } };
    const types = ['keydown', 'keyup', 'copy', 'cut', 'paste', 'beforeinput', 'input', 'selectionchange', 'focus', 'blur', 'visibilitychange'];
    const eventTarget = typeof globalThis.addEventListener === 'function' ? globalThis : document;
    const wrap = (object, name, clipboard = false) => {
        if (typeof object?.[name] !== 'function') return;
        const descriptor = Object.getOwnPropertyDescriptor(object, name), original = object[name];
        const wrapper = function (...args) {
            try { record(`${name}:call`, clipboard && name === 'writeText' ? { value: safe(args[0]) } : name === 'select' ? { coordinates: args.slice(0, 3).map(value => typeof value === 'number' ? value : null) } : { bytes: typeof args[0] === 'string' ? args[0].length : args[0]?.byteLength }); } catch (error) { diagnosticError('call', error); }
            let result;
            try { result = original.apply(this, args); }
            catch (error) {
                try { record(`${name}:threw`, { error: String(error?.name ?? 'Error') }); } catch (observerError) { diagnosticError('original exception', observerError); }
                throw error;
            }
            try {
                if (clipboard && typeof result?.then === 'function') {
                    // Observe the original promise without replacing it or swallowing its rejection.
                    void result.then(value => { try { record(`${name}:resolved`, name === 'readText' ? { value: safe(value) } : {}); } catch (error) { diagnosticError('promise result', error); } },
                        error => { try { record(`${name}:rejected`, { error: String(error?.name ?? 'Error') }); } catch (observerError) { diagnosticError('promise rejection', observerError); } });
                } else record(`${name}:returned`, name === 'getSelection' ? { value: safe(result) } : {});
            } catch (error) { diagnosticError('result observation', error); }
            return result;
        };
        restores.push(() => { if (object[name] === wrapper) { if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name]; } });
        object[name] = wrapper;
        if (object[name] !== wrapper) throw new Error(`cannot instrument ${name}`);
    };
    const cleanupErrors = [];
    const restore = () => {
        const failed = [];
        for (const undo of restores.splice(0).reverse()) {
            try { undo(); } catch (error) { failed.unshift(undo); cleanupErrors.push(String(error?.message ?? error)); }
        }
        restores.push(...failed);
        if (globalThis[key] === recorder) {
            try { delete globalThis[key]; } catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
        }
        return { restored: restores.length === 0 && globalThis[key] !== recorder, errors: cleanupErrors.slice() };
    };
    const recorder = { ownerId, generation, snapshot: () => {
        frozen = true;
        let observed;
        try { observed = state(); } catch (error) { diagnosticError('snapshot', error); observed = { unavailable: 'diagnostic state read failed' }; }
        const dropped = Math.max(0, sequence - events.length);
        return { ownerId, generation, events: events.slice(), state: observed, diagnosticErrors: diagnosticErrors.slice(),
            targetAvailable: true, historyRetained: dropped === 0, incomplete: diagnosticErrors.length > 0 || dropped > 0,
            dropped, timeOrigin: performance.timeOrigin };
    }, restore };
    try {
        globalThis[key] = recorder;
        if (globalThis[key] !== recorder) throw new Error('cannot publish incident recorder');
        for (const type of types) {
            restores.push(() => eventTarget.removeEventListener(type, listener, true));
            eventTarget.addEventListener(type, listener, true);
        }
        wrap(navigator.clipboard, 'readText', true); wrap(navigator.clipboard, 'writeText', true);
        for (const method of ['write', 'reset', 'clear', 'resize', 'select', 'clearSelection', 'getSelection']) wrap(globalThis.terminalLab?.terminal, method);
        record('armed');
        return { ownerId, generation };
    } catch (error) {
        const cleanup = restore();
        if (cleanup.errors.length) diagnosticError('installation cleanup', error);
        throw error;
    }
}

export async function armIncidentDiagnostics({ page, harness, rec, allowed = [], capacity = 1024 }) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024) throw new Error('invalid diagnostic capacity');
    const key = '__kelpiIncidentRecorder', ownerId = randomUUID();
    const targets = [], restores = [], events = [];
    let sequence = 0, frozen = false, first, closed = false, navigationScript, hostGeneration = 1;
    const record = (kind, detail = {}) => {
        if (frozen) return;
        events.push({ sequence: ++sequence, monotonicMs: performance.now(), kind, ...detail });
        if (events.length > capacity) events.shift();
    };
    const safe = value => redactFixtureText(value, allowed);
    const ownedExpression = body => `(() => { const recorder = globalThis[${JSON.stringify(key)}];
        if (!recorder || recorder.ownerId !== ${JSON.stringify(ownerId)}) return {unavailable:'owned recorder absent',targetAvailable:false};
        ${body} })()`;
    const install = `(${installRendererRecorder.toString()})(${JSON.stringify({ key, allowed, capacity, ownerId })})`;
    const addRenderer = async (name, evaluate, isPresent) => {
        // A failed acquisition remains known, but every subsequent operation is owner checked.
        const target = { name, evaluate, isPresent }; targets.push(target);
        const installed = await evaluate(install);
        target.generation = installed?.generation;
    };
    const wrap = (object, name, detail) => {
        if (typeof object?.[name] !== 'function') return;
        const descriptor = Object.getOwnPropertyDescriptor(object, name), original = object[name];
        const wrapper = function (...args) {
            try { record(`${name}:call`, detail(args)); } catch { record('diagnostic-error', { phase: `${name}:call` }); }
            const observed = result => {
                try { record(`${name}:resolved`, name.startsWith('clipboard') ? { value: safe(result?.text) } : {}); }
                catch { record('diagnostic-error', { phase: `${name}:result` }); }
            };
            const rejected = error => { try { record(`${name}:rejected`, { error: error?.name ?? 'Error' }); } catch { record('diagnostic-error', {phase:`${name}:rejection`}); } };
            try {
                const result = original.apply(this, args);
                try {
                    if (result instanceof Promise) void result.then(observed, rejected);
                    else observed(result);
                } catch { record('diagnostic-error', {phase:`${name}:result`}); }
                return result;
            } catch (error) { rejected(error); throw error; }
        };
        restores.push([`wrapper ${name}`, () => {
            if (object[name] !== wrapper) return;
            if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name];
        }]);
        object[name] = wrapper;
        if (object[name] !== wrapper) throw new Error(`cannot instrument ${name}`);
    };
    const snapshot = async target => {
        if (target.retired) return { ...target.retired, name: target.name };
        try {
            const saved = await target.evaluate(ownedExpression('return recorder.snapshot();'));
            const replaced = target.generation !== saved?.generation;
            return { name: target.name, ...saved, ...(replaced ? { incomplete:true, historyRetained:false,
                missingGeneration:target.generation ?? null, historyError:'document replaced without retained history' } : {}) };
        } catch (error) { return { name:target.name, targetAvailable:false, historyRetained:false, unavailable:String(error?.message ?? error) }; }
    };
    const freeze = (reason = 'completed') => {
        if (first) return first;
        frozen = true;
        first = Promise.all(targets.map(snapshot)).then(renderers => {
            const dropped = Math.max(0, sequence - events.length);
            const targetAvailable = renderers.length > 0 && renderers.every(renderer => renderer.state && !renderer.unavailable);
            const historyRetained = dropped === 0 && renderers.every(renderer => renderer.historyRetained === true);
            const complete = targetAvailable && historyRetained && !renderers.some(renderer => renderer.incomplete) && !events.some(event => event.kind === 'diagnostic-error');
            rec.check('incident diagnostics complete without observer errors', complete, complete ? 'all required renderer states and preceding history retained' : 'missing renderer capture, preceding history, or observer errors retained in incident evidence', 'harness');
            const file = path.join(rec.outDir, `${rec.name}-first-incident.json`);
            fs.writeFileSync(file, JSON.stringify({ reason, ownerId, complete, targetAvailable, historyRetained, capacity, events: events.slice(), dropped, renderers,
                limitations: ['Instrumentation adds timing overhead; passing does not prove a prior failure cause.', 'Monotonic sequences are per process/renderer; clocks do not establish cross-process total order.', 'Only exact allowlisted synthetic strings are retained; arbitrary contents are redacted.', 'Clipboard evidence is observed operation results, not an extra read or retry.', 'Buffer loss or unretained document generations make required preceding history incomplete.', 'No native-menu dispatch, bridge request/response, or PTY-input ordering instrumentation.'] }, null, 2) + '\n', { flag: 'wx' });
            rec.note(`incident evidence: ${file}`);
            return file;
        });
        return first;
    };
    const ensureHost = async () => {
        const target = targets.find(target => target.name === 'host');
        const current = await page.eval(ownedExpression('return {generation:recorder.generation};'));
        if (target && !target.retired && current?.generation === target.generation) return;
        if (target) {
            target.name = `host:document-${hostGeneration++}`;
            target.retired ??= { unavailable:'host document replaced without retained history', incomplete:true, targetAvailable:false, historyRetained:false, generation:target.generation };
        }
        if (current?.generation) targets.push({name:'host',evaluate:expression => page.eval(expression),generation:current.generation});
        else await addRenderer('host', expression => page.eval(expression));
        record('host-rearmed-before-input', { priorDocumentHistoryRetained: target?.retired?.historyRetained === true });
    };
    const restoreTarget = async target => {
        const result = await target.evaluate(ownedExpression('return recorder.restore();'));
        if (result?.unavailable) return { contextReplaced:true };
        if (result?.restored !== true || result.errors?.length) throw new Error(JSON.stringify(result));
        return result;
    };
    const retireRenderer = async name => {
        const target = targets.find(target => target.name === name);
        if (!target || target.retired) return;
        await rec.flushFirstFailure();
        target.retired = { ...await snapshot(target), retiredBeforeLaterOperations:true, retiredAt:performance.now() };
        if (target.retired.incomplete || !target.retired.state) {
            rec.check(`incident capture: ${name}`, false, 'renderer history incomplete before retirement', 'harness');
            await rec.flushFirstFailure();
        }
        // Cleanup failures are independent: a failed navigation undo cannot skip the renderer.
        const errors = await cleanupSteps([
            ['navigation script', async () => {
                if (name !== 'host' || !navigationScript) return;
                await page.send('Page.removeScriptToEvaluateOnNewDocument', {identifier:navigationScript}); navigationScript = undefined;
            }],
            [name, async () => { await restoreTarget(target); target.restored = true; }]
        ], (label, detail) => rec.check(`diagnostic cleanup: ${label}`, false, detail, 'cleanup'));
        if (errors.length) throw new Error(errors.join('; '));
    };
    const off = rec.onFirstFailure(({ label }) => freeze(label));
    const close = async () => {
        if (closed) return; closed = true;
        try { await freeze(); } catch (error) { rec.check('incident evidence retained', false, String(error), 'harness'); }
        const cleanup = [];
        const attempt = async (name, action) => {
            try { cleanup.push({name,...await action()}); }
            catch (error) { cleanup.push({name,error:String(error)}); rec.check(`diagnostic cleanup: ${name}`, false, String(error), 'cleanup'); }
        };
        await attempt('failure observer', () => { off(); return {restored:true}; });
        for (const [name, restore] of restores.reverse()) await attempt(name, () => {restore();return {restored:true};});
        if (navigationScript) await attempt('navigation script', async () => {
            await page.send('Page.removeScriptToEvaluateOnNewDocument', {identifier:navigationScript}); return {restored:true};
        });
        for (const target of targets) await attempt(target.name, async () => {
            if (target.restored) return {restoredBeforeUnmount:true};
            if (target.isPresent && !await target.isPresent()) return {contextAbsentFromCurrentDocument:true};
            return restoreTarget(target);
        });
        try { fs.writeFileSync(path.join(rec.outDir, `${rec.name}-incident-cleanup.json`), JSON.stringify(cleanup, null, 2) + '\n', { flag:'wx' }); }
        catch (error) { rec.check('diagnostic cleanup evidence retained', false, String(error), 'cleanup'); }
    };
    try {
        // Acquire the current document first. A duplicate arm cannot install a navigation hook.
        await addRenderer('host', expression => page.eval(expression));
        if (typeof page.send === 'function') {
            await page.send('Page.enable');
            const result = await page.send('Page.addScriptToEvaluateOnNewDocument', { source:`if (globalThis.top === globalThis && !globalThis[${JSON.stringify(key)}]) { ${install}; }` });
            navigationScript = result.identifier;
        }
        wrap(page, 'key', args => ({ code:/^(Key[CV]|MetaLeft|MetaRight)$/.test(args[0]) ? args[0] : '[redacted]' }));
        for (const name of ['clipboardRead', 'clipboardWrite']) wrap(harness, name, args => name === 'clipboardWrite' ? {value:safe(args[0])} : {});
        return {addRenderer,ensureHost,retireRenderer,freeze,close};
    } catch (error) {
        rec.check('incident instrumentation armed before input', false, error?.message ?? error, 'harness');
        await close(); throw error;
    }
}

/** Delete only the private remote daemon's stale store, after leaving that daemon's view. */
export async function removeOwnedRemoteStore(page, daemonID, rec) {
    if (!daemonID) { rec.check('cleanup: private remote daemon identity is known', false, 'refusing to remove an unscoped store', 'cleanup'); return; }
    const key = `kelpi.workbench.v1:${daemonID}`;
    const removed = await page.eval(`(() => { localStorage.removeItem(${JSON.stringify(key)}); return localStorage.getItem(${JSON.stringify(key)}) === null; })()`);
    rec.check('cleanup: private remote workbench store removed', removed === true, key, 'cleanup');
}

/** Await every cleanup step even when an earlier one fails; never turn failures into notes. */
export async function cleanupSteps(steps, recordFailure) {
    const errors = [];
    for (const [label, step] of steps) {
        try { await step(); } catch (error) {
            const detail = `${label}: ${String(error?.message ?? error)}`;
            errors.push(detail);
            try { recordFailure?.(label, detail); } catch (observerError) { errors.push(`cleanup reporting: ${String(observerError?.message ?? observerError)}`); }
        }
    }
    return errors;
}
