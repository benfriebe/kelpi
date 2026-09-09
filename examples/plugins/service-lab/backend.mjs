const gitMethods = [
    'getCurrentBranch', 'getDiff', 'getRemoteURL', 'defaultBranch', 'fetch',
    'createWorktree', 'createWorktreeFromBase', 'worktreeAdd', 'toplevel', 'resolveRepoRoot',
    'getStatus', 'repoState', 'getHeadSha', 'resolveHeadPath', 'stashPushIncludeUntracked',
    'stashPopRef', 'writeTreeForWorktree', 'readTreeInto', 'checkoutBranchForce', 'checkoutHeadForce',
    'resetHard', 'resetMixed', 'listWorktrees', 'removeWorktree', 'pruneWorktrees',
];

export function activate(api) {
    const history = [];
    const record = (service, method, args) => {
        history.push({
            service, method, repoPath: args.repoPath ?? args.worktreePath ?? args.directory ?? null,
            ...(typeof args.file === 'string' ? { file: args.file } : {}),
            at: new Date().toISOString(),
        });
        if (history.length > 100) history.splice(0, history.length - 100);
    };
    const delegate = (service, method) => async args => {
        record(service, method, args);
        return api.services.call(service, 1, method, args, { provider: 'bundled' });
    };
    const disposers = [
        api.providers.register('example.service-lab.git', Object.fromEntries(
            gitMethods.map(method => [method, delegate('kelpi.git', method)]),
        )),
        api.providers.register('example.service-lab.renderer', {
            async render(args) {
                record('kelpi.content.render', 'render', args);
                const result = await api.services.call('kelpi.content.render', 1, 'render', args, { provider: 'bundled' });
                const banner = '<div id="service-lab-banner" style="padding:8px 12px;background:#3250a8;color:#fff;font:12px system-ui">Service Lab</div>';
                return { html: result.html.replace(/(<body\b[^>]*>)/i, (_match, body) => body + banner) };
            },
        }),
        api.providers.register('example.service-lab.process', { exec: delegate('kelpi.process', 'exec') }),
        api.commands.register('example.service-lab.history', () => history.map(entry => ({ ...entry }))),
        api.commands.register('example.service-lab.exec', args => api.process.exec(
            args.file, args.args ?? [], args.cwd === undefined ? {} : { cwd: args.cwd },
        )),
    ];
    return () => { for (const dispose of disposers.reverse()) dispose(); };
}
