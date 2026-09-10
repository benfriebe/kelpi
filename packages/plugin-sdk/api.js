/** Shared by the injected browser bridge and the backend runner. No platform imports. */
export class KelpiError extends Error {
    // getKelpi() returns errors created by the injected runtime; author bundles may import
    // another copy of this class. Keep instanceof useful across those SDK copies/realms.
    static [Symbol.hasInstance](value) {
        return value !== null && typeof value === 'object' && value.name === 'KelpiError' && typeof value.code === 'string';
    }
    constructor(message, { code = 'KELPI_ERROR', method, details, cause } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'KelpiError';
        this.code = code;
        this.method = method;
        this.details = details;
    }
}

const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
// Built-in command DTOs use snake_case; the public facade uses the same camelCase/ID
// convention as context and snapshots. Never apply this to arbitrary plugin data/settings.
const camelKey = key => key.replace(/_([a-z]+)(?=_|$)/g, (_, word) =>
    ['id', 'ids', 'url'].includes(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1));
const camel = value => Array.isArray(value) ? value.map(camel) : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [camelKey(key), camel(item)])) : value;
const target = value => typeof value === 'string' ? { target: value }
    : clean({ target: value?.paneID, workspace: value?.workspaceID });

/** Create the platform-independent portion of the public API over a JSON transport. */
export function createKelpiAPI(transport, getContext = () => ({})) {
    const call = async (method, args = {}) => {
        try { return await transport(method, args); }
        catch (error) {
            if (error instanceof KelpiError) throw error;
            throw new KelpiError(error instanceof Error ? error.message : String(error), {
                code: 'TRANSPORT_ERROR', method, cause: error,
            });
        }
    };
    const command = (payload, context = {}) => call('command', { payload: clean(payload), context });
    const execute = async (name, fields = {}) => {
        const reply = await command({ command: name, ...fields });
        if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
            throw new KelpiError(`Invalid reply to ${name}`, { code: 'INVALID_REPLY', method: name, details: reply });
        }
        if (!reply.ok) throw new KelpiError(reply.error ?? `${name} failed`, {
            code: 'COMMAND_FAILED', method: name, details: reply,
        });
        return reply;
    };
    const run = async (name, fields = {}) => { const { ok, ...result } = await execute(name, fields); return camel(result); };
    const done = async (name, fields = {}) => { await execute(name, fields); };
    const list = async (name, field, fields = {}) => {
        const result = await run(name, fields);
        if (!Array.isArray(result[field])) throw new KelpiError(`Invalid ${field} reply to ${name}`, { code: 'INVALID_REPLY', method: name, details: result });
        return result[field];
    };
    const settings = async (name, fields) => (await execute(name, fields)).settings;
    const unavailableContext = method => new KelpiError(`${method} requires a paneID or workspaceID outside a Kelpi view or scoped command`, { code: 'CONTEXT_UNAVAILABLE', method });
    const creationTarget = options => {
        if (options.paneID !== undefined || options.workspaceID !== undefined) return target(options);
        const context = getContext();
        if (context.paneID) return { target: context.paneID };
        if (context.workspaceID) return { workspace: context.workspaceID };
        throw unavailableContext('pane-create');
    };
    const paneListScope = options => {
        if (options.workspaceID !== undefined) return { workspace: options.workspaceID, scope: 'all' };
        if (options.scope !== 'current') return { scope: options.scope ?? 'all' };
        const context = getContext();
        if (context.paneID) return { pane_id: context.paneID, scope: 'current' };
        if (context.workspaceID) return { workspace: context.workspaceID, scope: 'all' };
        throw unavailableContext('pane-list');
    };
    const sourcePane = async (options, method) => {
        if (options.paneID !== undefined) return options.paneID;
        const context = getContext();
        if (options.workspaceID === undefined && context.paneID) return context.paneID;
        if (options.reuse === true) throw new KelpiError('open with reuse requires an explicit paneID or a pane view context', { code: 'CONTEXT_UNAVAILABLE', method });
        const workspaceID = options.workspaceID ?? context.workspaceID;
        if (!workspaceID) throw unavailableContext(method);
        const panes = await list('pane-list', 'panes', { workspace: workspaceID, scope: 'all' });
        const paneID = (panes.find(pane => pane.isFocused) ?? panes[0])?.id;
        if (!paneID) throw new KelpiError(`${method} requires a source pane; workspace ${workspaceID} is empty`, { code: 'CONTEXT_UNAVAILABLE', method });
        return paneID;
    };
    const graftScope = (options, method) => {
        if (options.paneID !== undefined || options.workspaceID !== undefined || options.repo !== undefined) return clean({ workspace: options.workspaceID, repo: options.repo, pane_id: options.paneID });
        const context = getContext();
        if (context.paneID) return { pane_id: context.paneID };
        if (context.workspaceID) return { workspace: context.workspaceID };
        throw unavailableContext(method);
    };
    const panes = Object.freeze({
        list: async (options = {}) => list('pane-list', 'panes', paneListScope(options)),
        create: async (options = {}) => run('pane-create', { ...creationTarget(options), path: options.path, name: options.name }),
        split: (pane, options = {}) => run('pane-split', { ...target(pane), direction: options.direction, path: options.path, name: options.name }),
        close: pane => run('pane-close', target(pane)),
        rename: (pane, name) => run('pane-name', { ...target(pane), name }),
        resize: (pane, options) => run('pane-resize', { ...target(pane), ratio: options.ratio, delta: options.delta }),
        moveAdjacent: (pane, anchor, zone) => run('pane-move-adjacent', { ...target(pane), anchor, zone }),
        move: (paneID, direction) => done('pane-move', { pane_id: paneID, direction }),
        moveToWorkspace: (paneID, workspaceID, options = {}) => done('pane-move-to-workspace', { pane_id: paneID, name: workspaceID, text: options.create ? 'true' : 'false' }),
        reopen: workspaceID => run('reopen-closed-pane', { workspace_id: workspaceID }),
        scratchpad: workspaceID => run('create-scratchpad', { workspace_id: workspaceID }),
    });
    const documentCall = async (method, args) => {
        try { return await call(`documents.${method}`, clean(args)); }
        catch (error) {
            if (error.message?.startsWith('DOCUMENT_CONFLICT:')) throw new KelpiError(error.message, { code: 'DOCUMENT_CONFLICT', method: `documents.${method}`, cause: error });
            throw error;
        }
    };
    return Object.freeze({
        call, command,
        snapshot: () => call('state.snapshot'),
        openView: (viewID, options = {}) => call('views.open', clean({ viewID, ...options })),
        emit: (name, data = null) => call('events.emit', { name, data }),
        commands: Object.freeze({ execute: (command, args = {}) => call('commands.execute', { command, args }) }),
        storage: Object.freeze({ get: key => call('storage.get', { key }), set: async (key, value) => { await call('storage.set', { key, value }); } }),
        settings: Object.freeze({ get: () => call('settings.get'), set: async (key, value) => { await call('settings.set', { key, value }); } }),
        contributions: Object.freeze({ get: () => call('contributions.get'), update: patch => call('contributions.update', patch) }),
        files: Object.freeze({
            read: path => call('files.read', { path }),
            write: async (path, text) => { await call('files.write', { path, text }); },
            open: async (path, options = {}) => done('open', { path, pane_id: await sourcePane(options, 'open'), reuse: options.reuse ?? false }),
            reveal: (path, options = {}) => done('reveal-path', { path, select: options.select ?? false }),
        }),
        process: Object.freeze({ exec: (file, args = [], options = {}) => call('process.exec', clean({ file, args, ...options })) }),
        ui: Object.freeze({ reveal: async paneID => { await call('ui.reveal', { paneID }); } }),
        panes,
        documents: Object.freeze({
            get: (paneID = getContext().paneID) => documentCall('get', { paneID }),
            edit: (paneID, text, revision) => documentCall('edit', { paneID, text, revision }),
            save: (paneID, revision) => documentCall('save', { paneID, revision }),
            setMode: (paneID, mode, revision) => documentCall('mode', { paneID, mode, revision }),
            refresh: (paneID, revision) => documentCall('refresh', { paneID, revision }),
            watch: (paneID = getContext().paneID) => documentCall('watch', { paneID }),
            unwatch: async subscription => { await documentCall('unwatch', { subscription }); },
        }),
        workspaces: Object.freeze({
            list: (options = {}) => list('workspace-list', 'workspaces', { group: options.groupID }),
            create: (options = {}) => run('workspace-create', {
                name: options.name, path: options.path, color: options.color, group: options.groupID,
                profile: options.profile, worktree: options.worktree, branch: options.branch,
                update_main: options.updateMain ?? false, repo: options.repo,
            }),
            rename: (workspaceID, name) => run('rename-workspace', { workspace_id: workspaceID, name }),
            remove: (workspaceID, options = {}) => run('workspace-delete', { name: workspaceID, force: options.force ?? false }),
            move: (workspaceID, options = {}) => done('workspace-move', { name: workspaceID, group: options.groupID, index: options.index }),
            moveMany: (workspaceIDs, options = {}) => run('move-workspaces', { workspace_ids: workspaceIDs, group_id: options.groupID ?? null, index: options.index }),
            setProfile: (workspaceID, profile) => done('workspace-profile', { name: workspaceID, profile: profile ?? '' }),
            labels: (workspaceID, operation, values = []) => run('workspace-label', { name: workspaceID, label_op: operation, label_values: values }),
            setColor: (workspaceIDs, color) => run('set-bulk-color', { workspace_ids: workspaceIDs, color }),
            setIcon: (workspaceID, icon) => run('set-workspace-icon', { workspace_id: workspaceID, icon }),
        }),
        groups: Object.freeze({
            list: () => list('group-list', 'groups'),
            create: (name, options = {}) => run('create-group-for-workspaces', { name, color: options.color, workspace_ids: options.workspaceIDs ?? [] }),
            rename: (groupID, name) => done('group-rename', { name: groupID, new_name: name }),
            remove: (groupID, options = {}) => done('group-delete', { name: groupID, cascade: options.cascade ?? false }),
            reorder: (groupID, workspaceIDs) => run('group-reorder', { name: groupID, order: workspaceIDs }),
            sort: (groupID, by, options = {}) => run('group-sort', { name: groupID, by, descending: options.descending ?? false }),
            setCollapsed: (groupID, collapsed) => run('set-group-collapsed', { group_id: groupID, collapsed }),
            setColor: (groupID, color) => run('set-group-color', { group_id: groupID, color }),
            setIcon: (groupID, icon) => run('set-group-icon', { group_id: groupID, icon }),
        }),
        layout: Object.freeze({
            cycle: paneID => done('layout-cycle', { pane_id: paneID }),
            select: (paneID, name) => done('layout-select', { pane_id: paneID, name }),
            zoom: paneID => run('toggle-zoom', { pane_id: paneID }),
            setSplitRatio: (workspaceID, splitPath, ratio) => run('set-split-ratio', { workspace_id: workspaceID, split_path: splitPath, ratio }),
        }),
        agents: Object.freeze({
            list: async (options = {}) => (await panes.list(options)).filter(pane => pane.agent || pane.agentSessionID),
            restart: paneID => run('restart-pane-agent', { pane_id: paneID }),
            setStatus: (paneID, status) => run('set-pane-status', { pane_id: paneID, status }),
            clearStatus: paneID => run('clear-pane-status', { pane_id: paneID }),
            reportStart: (paneID, agent) => done('start', { pane_id: paneID, agent }),
            reportStop: (paneID, options = {}) => done('stop', { pane_id: paneID, background_tasks: options.backgroundTasks ?? 0 }),
            reportError: (paneID, message) => done('error', { pane_id: paneID, message }),
            notify: (paneID, title, body, options = {}) => done('notification', { pane_id: paneID, title, body, background_tasks: options.backgroundTasks ?? 0 }),
            sessionStart: (paneID, sessionID, agent, options = {}) => done('session-start', { pane_id: paneID, session_id: sessionID, agent, profile: options.profile }),
            sessionEnd: (paneID, sessionID) => done('session-end', { pane_id: paneID, session_id: sessionID }),
        }),
        terminal: Object.freeze({
            watch: paneID => call('terminal.watch', { paneID }),
            unwatch: async subscription => { await call('terminal.unwatch', { subscription }); },
            send: (pane, text, options = {}) => run('pane-send', { ...target(pane), text, bare: options.bare ?? false }),
            sendKey: (pane, key) => run('pane-send-key', { ...target(pane), key }),
            capture: async (pane, options = {}) => (await run('pane-capture', { ...target(pane), lines: options.lines, scrollback: options.scrollback ?? false })).text,
            sync: (workspaceID, action = 'status') => run('pane-sync', { workspace: workspaceID, action }),
            excludeFromSync: (pane, excluded) => run('pane-sync-exclude', { ...target(pane), excluded }),
            search: (workspaceID, action, options = {}) => run('terminal-search', { workspace_id: workspaceID, action, needle: options.needle, case_sensitive: options.caseSensitive }),
        }),
        git: Object.freeze({
            repositories: () => list('repo-registry', 'repos'),
            status: (workspaceID, options = {}) => list('workspace-repo-status', 'associations', { workspace_id: workspaceID, refresh: options.refresh ?? false }),
            addRepository: async (path, options = {}) => (await run('repo-add', { path, name: options.name })).repo,
            removeRepository: repoID => run('repo-remove', { repo_id: repoID }),
            renameRepository: async (repoID, name) => (await run('repo-rename', { repo_id: repoID, name })).repo,
            scan: (path, options = {}) => run('repo-scan', { path, max_depth: options.maxDepth }),
            associate: async (workspaceID, path) => (await run('add-repo-association', { workspace_id: workspaceID, path })).association,
            dissociate: (workspaceID, associationID, options = {}) => run('remove-repo-association', { workspace_id: workspaceID, association_id: associationID, delete_worktree: options.deleteWorktree ?? false }),
            addWorktree: (workspaceID, options) => run('workspace-add-worktree', { workspace_id: workspaceID, repo_id: options.repoID, repo_path: options.repoPath, name: options.name, branch: options.branch, update_main: options.updateMain ?? false }),
            diff: async (repoPath, options = {}) => done('diff', { repo_path: repoPath, target_path: options.targetPath, pane_id: await sourcePane(options, 'diff') }),
            graft: Object.freeze({
                status: () => list('graft-status', 'sessions'),
                start: async (options = {}) => run('graft-start', graftScope(options, 'graft-start')),
                stop: async (options = {}) => run('graft-stop', graftScope(options, 'graft-stop')),
            }),
        }),
        appSettings: Object.freeze({
            get: () => call('app.settings.get'),
            setGeneral: (key, value) => settings('set-general-setting', { key, value }),
            setAppearance: (key, value) => settings('set-ghostty-setting', { key, value }),
            setKeybinding: (action, trigger) => settings('set-keybinding', { action, trigger }),
            resetKeybindings: (action = null) => settings('reset-keybindings', { action }),
            setProfiles: profiles => settings('set-profiles', { profiles }),
            setRemoteDaemons: daemons => settings('set-remote-daemons', { daemons }),
        }),
        services: Object.freeze({
            list: () => call('services.list'),
            call: (service, version, method, args = {}, options = {}) => call('services.call', clean({ service, version, method, args, ...options })),
            select: (service, version, providerID) => call('services.select', { service, version, providerID }),
        }),
    });
}
