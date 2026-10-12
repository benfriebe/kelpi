/** @param {import('../../../packages/plugin-sdk/index.js').BackendAPI} api */
export function activate(api) {
    // A backend asks in the window whose shortcut, palette or menu ran the command (#389). From
    // `kelpi plugin run` there is no such window, so showDialog rejects with code NO_WINDOW.
    api.commands.register('example.interaction-lab.ask', async () => {
        const action = await api.ui.showDialog({
            title: 'Run it?', message: 'Interaction Lab asks before it runs anything.', cancelID: 'cancel',
            actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'run', label: 'Run', kind: 'primary' }],
        });
        await api.ui.showNotification({
            message: action === null ? 'Interaction Lab: cancelled' : `Interaction Lab: ${action}`,
            tone: action === 'run' ? 'success' : 'info',
        }).catch(() => null);
        return action;
    });
}
