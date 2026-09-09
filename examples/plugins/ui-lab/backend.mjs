/** @param {import('../../../packages/plugin-sdk/index.js').BackendAPI} api */
export async function activate(api) {
    const id = 'example.ui-lab';
    const itemIDs = [`${id}.counter`, `${id}.workspace`, `${id}.pane`];
    let count = 0, enabled = true, visible = true;
    let lastInvocation = null;
    let settings = await api.settings.get();
    let pending = Promise.resolve();
    // Commands and settings/gap events can overlap. Keep the example's read/change/publish
    // sequence ordered without relying on a browser view being mounted.
    const serialize = operation => {
        const next = pending.then(operation);
        pending = next.catch(() => {});
        return next;
    };
    const publish = () => api.contributions.update({
        context: { enabled, visible, count },
        items: Object.fromEntries(itemIDs.map(itemID => [itemID, {
            badge: String(count), tone: enabled ? 'info' : 'warning', enabled, visible,
            tooltip: `UI Lab count ${count}; step ${settings.step}; ${settings.density} layout`,
        }])),
    });
    api.commands.register(`${id}.increment`, (_args, context) => serialize(async () => {
        settings = await api.settings.get();
        lastInvocation = { workspaceID: context.workspaceID ?? null, paneID: context.paneID ?? null };
        count = Math.min(999_999, count + Number(settings.step));
        return publish();
    }));
    api.commands.register(`${id}.toggle`, args => serialize(() => {
        const field = args.field ?? 'enabled';
        if (field !== 'enabled' && field !== 'visible') throw new Error('field must be enabled or visible');
        if (args.value !== undefined && typeof args.value !== 'boolean') throw new Error('value must be boolean');
        if (field === 'enabled') enabled = args.value ?? !enabled;
        else visible = args.value ?? !visible;
        return publish();
    }));
    api.commands.register(`${id}.snapshot`, () => serialize(async () => ({ state: await api.contributions.get(), settings: await api.settings.get(), lastInvocation })));
    const refreshSettings = () => serialize(async () => { settings = await api.settings.get(); await publish(); });
    const offSettings = api.events.on('settings.changed', event => {
        if (event.pluginID !== id) return;
        return refreshSettings();
    });
    // A gap can replace settings.changed events, so recover the cache before publishing.
    const offGap = api.events.on('gap', refreshSettings);
    await publish();
    return () => { offSettings(); offGap(); };
}
