/** Compiled with the published declaration files; intentionally never executed. */
import { getKelpi, type BackendAPI, type BuiltinProviderMethods, type NativeGitStatus, type NativeWorktree, type WorkspaceInfo, type RepositoryAssociation } from './index.js';
// This import also checks every runtime contract fixture against the published declarations.
import './tests/service-fixtures.js';

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
    const branch = await api.services.call('kelpi.git', 1, 'getCurrentBranch', { repoPath: '/repo' });
    const maybeBranch: string | null = branch;
    // @ts-expect-error Built-in results are inferred without a caller-supplied return type.
    const branchNumber: number = branch;
    const status: NativeGitStatus = await api.services.call('kelpi.git', 1, 'getStatus', { repoPath: '/repo' });
    if (status.kind === 'dirty') void status.changedFiles;
    const trees: NativeWorktree[] = await api.services.call('kelpi.git', 1, 'listWorktrees', { repoPath: '/repo' });
    const removed: null = await api.services.call('kelpi.git', 1, 'removeWorktree', { repoPath: '/repo', worktreePath: '/repo-worktree' });
    const process = await api.services.call('kelpi.process', 1, 'exec', { file: 'printf', args: ['hello'] });
    const stdout: string = process.stdout;
    const rendered = await api.services.call('kelpi.content.render', 1, 'render', { kind: 'markdown', source: '# Hello', backgroundColor: '#111111', fontSize: 13, assetBase: null });
    const html: string = rendered.html;
    const text: string = await api.services.call('kelpi.files', 1, 'read', { path: '/tmp/example.txt' });
    // @ts-expect-error Native services use version 1.
    await api.services.call('kelpi.git', 2, 'getStatus', { repoPath: '/repo' });
    // @ts-expect-error The service determines its supported methods.
    await api.services.call('kelpi.git', 1, 'exec', { file: 'git' });
    // @ts-expect-error Built-in calls require their arguments.
    await api.services.call('kelpi.git', 1, 'getStatus');
    // @ts-expect-error Native Git primitives use repoPath, not a workspace ID.
    await api.services.call('kelpi.git', 1, 'getStatus', { workspaceID: 'workspace' });
    // @ts-expect-error The worktree primitive takes worktreePath, not repoPath.
    await api.services.call('kelpi.git', 1, 'writeTreeForWorktree', { repoPath: '/repo' });
    // @ts-expect-error Providers receive JSON, not an AbortSignal in their arguments.
    await api.services.call('kelpi.git', 1, 'getDiff', { repoPath: '/repo', signal: null });
    // @ts-expect-error worktreeAdd requires an explicit updateMain choice.
    await api.services.call('kelpi.git', 1, 'worktreeAdd', { repoPath: '/repo', worktreePath: '/worktree', branchName: 'feature' });
    // @ts-expect-error File writes require text.
    await api.services.call('kelpi.files', 1, 'write', { path: '/tmp/example.txt' });
    // @ts-expect-error Process argv must contain strings.
    await api.services.call('kelpi.process', 1, 'exec', { file: 'program', args: [123] });
    // @ts-expect-error Renderer fields are all required, including a nullable assetBase.
    await api.services.call('kelpi.content.render', 1, 'render', { kind: 'markdown', source: '', backgroundColor: '#111', fontSize: 13 });
    const files: BuiltinProviderMethods<'kelpi.files'> = {
        read: args => api.services.call('kelpi.files', 1, 'read', args, { provider: 'bundled' }),
        write: args => api.services.call('kelpi.files', 1, 'write', args, { provider: 'bundled' }),
    };
    api.providers.register<'kelpi.files'>('sample.plugin.files', files);
    api.providers.register<'kelpi.content.render'>('sample.plugin.renderer', {
        render: async (args, context) => {
            const paneID: string | undefined = context.paneID;
            const source: string = args.source;
            return api.services.call('kelpi.content.render', 1, 'render', args, { provider: 'bundled' });
        },
    });
    // @ts-expect-error A files provider must implement both required methods.
    api.providers.register<'kelpi.files'>('sample.plugin.files', { read: () => 'text' });
    api.providers.register<'kelpi.content.render'>('sample.plugin.renderer', {
        // @ts-expect-error Renderer providers return an html object.
        render: () => 'html',
    });
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
