/** @param {import('../../../packages/plugin-sdk/index.js').BackendAPI} api */
export async function activate(api) {
    let history = await api.storage.get('operations') ?? [];
    api.commands.register('example.workbench-lab.open', () => api.openView('example.workbench-lab.dashboard'));
    api.commands.register('example.workbench-lab.history', () => history);
    api.commands.register('example.workbench-lab.dependency-history', () => api.commands.execute('example.agent-board.history'));
    // Deliberately narrow demonstration: ordinary workspace creation is unaffected.
    api.hooks.register('example.workbench-lab.guard', operation => operation.payload.name === 'Blocked by Workbench Lab'
        ? { allow: false, reason: 'Workbench Lab blocked this demonstration workspace.' }
        : { allow: true });
    api.hooks.register('example.workbench-lab.observe', async operation => {
        history = [...history, { id: operation.id, name: operation.payload.name ?? null, source: operation.source, result: operation.result ?? null }].slice(-50);
        await api.storage.set('operations', history);
    });
    api.providers.register('example.workbench-lab.files', {
        read: async args => `[Workbench Lab]\n${await api.services.call('kelpi.files', 1, 'read', args, { provider: 'bundled' })}`,
        write: args => api.services.call('kelpi.files', 1, 'write', args, { provider: 'bundled' })
    });
}
