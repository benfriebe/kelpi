const api = globalThis.kelpi;
const id = 'example.ui-lab';
const byID = id => document.getElementById(id);
let disposed = false, refreshID = 0, eventSequence = -1;
let state = { context: {}, items: {} }, settings = {}, lastInvocation = null;
const pendingPrompts = new Set();

function render() {
    if (disposed) return;
    const enabled = state.context.enabled === true, visible = state.context.visible === true;
    byID('count').textContent = String(state.context.count ?? 0);
    byID('state-summary').textContent = `${enabled ? 'Actions enabled' : 'Actions disabled'} · ${visible ? 'Items visible' : 'Items hidden'} · Step ${settings.step ?? 1}`;
    byID('increment').disabled = !enabled || !visible;
    byID('toggle-enabled').disabled = false;
    byID('toggle-visible').disabled = false;
    byID('toggle-enabled').textContent = enabled ? 'Disable actions' : 'Enable actions';
    byID('toggle-visible').textContent = visible ? 'Hide items' : 'Show items';
    byID('notification').disabled = pendingPrompts.has('notification') || settings.notifications === false;
    byID('snapshot').textContent = JSON.stringify({ state, settings, lastInvocation }, null, 2);
    document.body.dataset.density = settings.density === 'compact' ? 'compact' : 'comfortable';
    document.body.dataset.ready = 'true';
}
async function refresh() {
    const request = ++refreshID, before = eventSequence;
    const result = await api.commands.execute(`${id}.snapshot`);
    if (disposed || request !== refreshID) return;
    if (eventSequence === before) state = result.state;
    settings = result.settings;
    lastInvocation = result.lastInvocation;
    render();
}
async function act(operation) {
    try { byID('error').textContent = ''; await operation(); }
    catch (error) { if (!disposed) byID('error').textContent = error.message; }
}
const cleanups = [];
await api.ready;
cleanups.push(api.events.on('plugin.contributions.changed', event => {
    if (event.pluginID !== id || event.sequence <= eventSequence || disposed) return;
    eventSequence = event.sequence;
    state = event.data.state;
    render();
}));
cleanups.push(api.events.on('settings.changed', event => { if (event.pluginID === id) return act(refresh); }));
cleanups.push(api.events.on('gap', () => act(refresh)));
for (const [button, command, args] of [
    ['increment', 'increment', {}], ['toggle-enabled', 'toggle', { field: 'enabled' }], ['toggle-visible', 'toggle', { field: 'visible' }],
]) byID(button).addEventListener('click', () => { void act(async () => { await api.commands.execute(`${id}.${command}`, args); await refresh(); }); });
byID('refresh').addEventListener('click', () => { void act(refresh); });

const prompts = {
    pick: () => api.ui.showQuickPick({ title: 'UI Lab: choose a color', placeholder: 'Filter colors', selectedID: 'blue', items: [
        { id: 'blue', label: 'Blue', description: 'A calm accent' }, { id: 'green', label: 'Green', description: 'A fresh accent' }, { id: 'locked', label: 'Unavailable color', disabled: true },
    ] }),
    input: () => api.ui.showInput({ title: 'UI Lab: enter a label', prompt: 'Choose a label for this example.', value: 'Kelpi', placeholder: 'Your label', maxLength: 80 }),
    dialog: () => api.ui.showDialog({ title: 'UI Lab: confirm action', message: 'Try a shared Kelpi dialog.', detail: 'This example records your choice without changing a workspace.', cancelID: 'cancel', actions: [
        { id: 'cancel', label: 'Cancel' }, { id: 'confirm', label: 'Confirm', kind: 'primary' },
    ] }),
    notification: () => api.ui.showNotification({ message: 'UI Lab notification', detail: 'A shared notification from the example plugin.', tone: 'info', actions: [{ id: 'ack', label: 'Acknowledge' }] }),
};
for (const [name, prompt] of Object.entries(prompts)) byID(name).addEventListener('click', () => {
    const button = byID(name), output = byID(`${name}-result`);
    pendingPrompts.add(name);
    button.disabled = true; output.textContent = 'Waiting…';
    void (async () => {
        try { const result = await prompt(); if (!disposed) output.textContent = JSON.stringify(result); }
        catch (error) { if (!disposed) output.textContent = JSON.stringify({ error: error.message }); }
        finally { pendingPrompts.delete(name); if (!disposed) button.disabled = name === 'notification' && settings.notifications === false; }
    })();
});
addEventListener('pagehide', () => { disposed = true; for (const stop of cleanups) stop(); });
await act(refresh);
