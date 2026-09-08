/** Compiled with the published declaration files; intentionally never executed. */
import { getKelpi, type BackendAPI, type WorkspaceInfo, type RepositoryAssociation } from './index.js';

async function authoring(api: BackendAPI): Promise<void> {
    const workspaces: WorkspaceInfo[] = await api.workspaces.list();
    const first = workspaces[0];
    if (!first) return;
    const associations: RepositoryAssociation[] = await api.git.status(first.id);
    await api.panes.create({ workspaceID: first.id, name: associations[0]?.repoName });
    await api.panes.resize('pane', { ratio: 0.3 });
    // @ts-expect-error Exactly one resize operation is allowed.
    await api.panes.resize('pane', { ratio: 0.3, delta: 0.2 });
    // @ts-expect-error Status is an explicit public vocabulary.
    await api.agents.setStatus('pane', 'busy');
    // @ts-expect-error Browser-only focus is not a backend operation.
    await api.ui.focusPane('workspace', 'pane');
    api.hooks.register('sample.plugin.guard', async invocation => invocation.phase === 'before' ? { allow: true } : undefined);
    api.providers.register('sample.plugin.files', { read: async args => String(args.path) });
    await api.services.call<{ answer: number }>('sample.plugin.catalog', 1, 'read');
    const view = getKelpi();
    await view.ready;
    await view.ui.focusPane(first.id, 'pane');
    const unsubscribe = view.onContext(environment => { if (!environment.visible) return; void environment.context.workspaceID; });
    const workbench = await view.ui.getWorkbench();
    if (workbench.slots[0]) await view.ui.selectView(workbench.slots[0].id, 'sample.plugin.view');
    unsubscribe();
    // @ts-expect-error Provider registration is backend-only.
    view.providers.register('sample.plugin.provider', {});
}
void authoring;
