/* A build-free UI: every Kelpi interaction goes through the public window.kelpi API. */
(() => {
    const api = window.kelpi;
    const instanceID = crypto.randomUUID();
    const view = document.body.dataset.view;
    const workspacesView = view === 'workspaces';
    const $ = id => document.getElementById(id);
    const paths = {
        grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
        search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
        refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17"/>',
        edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-4-4L5 15Z"/>',
        branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10M18 8c0 6-12 2-12 9"/>',
        terminal: '<path d="m5 7 5 5-5 5M13 17h6"/>',
        inspector: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M14 3v18M17 8h1M17 12h1M17 16h1"/>',
    };
    const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.grid}</svg>`;
    const el = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const button = (label, className, action, title) => {
        const element = el('button', className, label); element.type = 'button';
        element.dataset.action = 'true'; element.disabled = busy;
        if (title) element.title = title;
        element.addEventListener('click', () => { void perform(action); });
        return element;
    };
    $('sidebar-root').innerHTML = `<div class="shell">
        <header class="top"><div class="brand"><span class="brand-mark">${icon(workspacesView ? 'grid' : 'inspector')}</span><h1>${workspacesView ? 'Workspaces' : 'Inspector'}</h1></div>
            ${workspacesView ? '<button id="new-workspace" type="button" class="inline-action primary">+ New</button>' : ''}
            <button id="refresh" type="button" class="icon-button" aria-label="Refresh ${workspacesView ? 'workspaces' : 'repositories'}" title="Refresh">${icon('refresh')}</button></header>
        <p id="scope" class="scope">Connecting…</p><p id="navigation-note" class="scope" role="status" hidden></p>
        <div id="error" class="error" role="alert" hidden><p id="error-message"></p><button id="retry" type="button" class="inline-action">Refresh data</button></div>
        <form id="workspace-editor" class="editor" hidden>
            <h2 id="editor-title">New workspace</h2>
            <label>Name<input id="workspace-name" aria-label="Workspace name" required maxlength="120" autocomplete="off" placeholder="A new idea"></label>
            <label id="workspace-path-field">Folder <span>(optional)</span><input id="workspace-path" aria-label="Workspace folder" autocomplete="off" placeholder="/path/to/project"></label>
            <div class="actions"><button id="workspace-save" type="button" data-submit class="primary">Create workspace</button><button id="workspace-cancel" type="button">Cancel</button></div>
        </form>
        ${workspacesView ? `<div class="toolbar"><label class="filter">${icon('search')}<input id="filter" type="search" aria-label="Filter workspaces" placeholder="Filter workspaces…" autocomplete="off"></label>
            <div class="preferences"><select id="sort" aria-label="Workspace sort"><option value="recent">Workspace order</option><option value="name">Name A–Z</option></select><label class="check"><input id="show-counts" type="checkbox">Pane counts</label></div></div>
            <nav id="workspace-list" class="workspace-list" aria-label="Workspaces"><p class="empty">Loading workspaces…</p></nav>` : `<section class="section">
                <select id="inspect-workspace" class="workspace-picker" aria-label="Inspect workspace"></select>
                <p id="workspace-title" class="workspace-name">Loading workspace…</p><p id="workspace-summary" class="workspace-summary"></p>
                <div class="actions"><button id="rename-workspace" type="button" class="inline-action">Rename</button><button id="new-terminal" type="button" class="inline-action primary">+ Terminal</button></div>
            </section>
            <section class="section"><div class="section-heading"><h2>Repositories</h2><span id="repo-count" class="count"></span></div>
                <label class="check preferences"><input id="show-paths" type="checkbox">Show folder paths</label>
                <div id="repositories"></div>
                <details id="registered-repositories"><summary>All registered repositories</summary><div id="repository-registry"></div></details>
                <form id="add-repository" class="add-repo"><label class="field">Add repository to this workspace<input id="repository-path" aria-label="Repository path" placeholder="/path/to/repository" required autocomplete="off"></label><button id="associate-repository" type="button" data-submit class="inline-action">Add repository</button></form>
            </section>
            <section class="section"><div class="section-heading"><h2>Panes & terminals</h2><span id="pane-count" class="count"></span></div><div id="panes" class="pane-list"></div>
                <form id="terminal-form" class="terminal-form"><label class="field">Send to terminal<select id="terminal-target" aria-label="Target terminal"></select></label>
                    <label class="field">Command<textarea id="terminal-command" aria-label="Terminal command" placeholder="pwd" rows="2"></textarea></label>
                    <div class="actions"><button id="send-command" type="button" data-submit class="primary inline-action">Run command</button><button id="capture-output" type="button" class="inline-action">Read output</button></div></form>
                <details id="terminal-output-details" hidden><summary>Recent output</summary><pre id="terminal-output" class="output"></pre></details>
            </section>`}
        <footer id="status" class="status-bar" role="status" aria-live="polite">Loading…</footer>
    </div>`;

    let preferences = { filter: '', sort: 'recent', showCounts: true, showPaths: true, showRegistry: false };
    let workspaces = [], panes = [], repositories = [], associations = [], navigation = null, navigationError = '';
    let workspaceID = null, editingID = null, busy = false, ready = false, disposed = false;
    let preferencesWrite = Promise.resolve(), refreshPromise = null, refreshWanted = false, forceWanted = false;
    let refreshTimer = null, pointerReleaseTimer = null, pointerActive = false, renderPending = false;
    const disposers = [];
    const preferenceKey = `sidebar.${view}.preferences`;
    const colors = { red: '#dd8a8a', orange: '#dca36a', yellow: '#d4c26d', green: '#86b58e', blue: '#8da8d8', purple: '#b39adb', pink: '#d795ba', gray: '#a1a2ae', black: '#9393a0', white: '#c8c8d4' };
    const message = cause => cause instanceof Error ? cause.message : String(cause);
    const showError = cause => { if (disposed) return; $('error-message').textContent = message(cause); $('error').hidden = false; $('status').textContent = 'Could not complete the request.'; };
    const clearError = () => { $('error').hidden = true; };
    const setBusy = value => {
        busy = value;
        for (const node of document.querySelectorAll('[data-action], [data-submit], #refresh, #new-workspace')) node.disabled = value || node.dataset.unavailable === 'true';
        if (!workspacesView) syncActionAvailability();
    };
    const readPreferences = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        preferences = {
            filter: typeof value.filter === 'string' ? value.filter.slice(0, 200) : '',
            sort: value.sort === 'name' ? 'name' : 'recent',
            showCounts: value.showCounts !== false, showPaths: value.showPaths !== false,
            showRegistry: value.showRegistry === true,
        };
    };
    const applyPreferences = () => {
        if (workspacesView) { $('filter').value = preferences.filter; $('sort').value = preferences.sort; $('show-counts').checked = preferences.showCounts; }
        else { $('show-paths').checked = preferences.showPaths; $('registered-repositories').open = preferences.showRegistry; }
    };
    const savePreferences = () => {
        const value = { ...preferences };
        preferencesWrite = preferencesWrite.catch(() => {}).then(async () => {
            await api.storage.set(preferenceKey, value);
            await api.emit('preferences.changed', { view, preferences: value, instanceID });
        });
        preferencesWrite.catch(showError);
        return preferencesWrite;
    };
    async function perform(action) {
        if (busy || disposed) return;
        clearError(); setBusy(true); $('status').textContent = 'Working…';
        try { await preferencesWrite; await action(); }
        catch (cause) { showError(cause); }
        finally { if (!disposed) setBusy(false); }
    }
    function bindForm(id, action) {
        const form = $(id);
        const run = () => { if (form.reportValidity()) void perform(action); };
        // The iframe deliberately cannot submit HTML forms or navigate itself.
        // Use ordinary buttons and handle Enter locally before browser submission.
        form.querySelector('[data-submit]').onclick = run;
        form.onsubmit = event => { event.preventDefault(); run(); };
        form.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement) { event.preventDefault(); run(); }
        });
    }
    function editor(id = null) {
        editingID = id;
        $('editor-title').textContent = id ? 'Rename workspace' : 'New workspace';
        $('workspace-save').textContent = id ? 'Save name' : 'Create workspace';
        $('workspace-path-field').hidden = id !== null;
        $('workspace-name').value = id ? workspaces.find(row => row.id === id)?.name ?? '' : '';
        $('workspace-path').value = '';
        $('workspace-editor').hidden = false;
        $('workspace-name').focus(); $('workspace-name').select();
    }
    function empty(root, title, detail) {
        const box = el('div', 'empty'); box.append(el('strong', '', title), document.createTextNode(detail)); root.append(box);
    }
    async function selectWorkspace(id) {
        const owner = navigation?.hosts.find(host => host.kind === 'local');
        if (owner) await api.ui.selectWorkspace(owner.id, id);
        else await api.ui.activateWorkspace(id);
        workspaceID = id;
        await refresh();
    }
    function navigationNote() {
        const owner = navigation?.hosts.find(host => host.kind === 'local');
        const activeHost = navigation?.hosts.find(host => host.id === navigation.active?.hostID);
        const mismatch = !workspacesView && owner && activeHost && owner.id !== activeHost.id;
        $('navigation-note').textContent = navigationError
            ? `Window navigation is unavailable here. This view still controls its own daemon. ${navigationError}`
            : mismatch ? `The window is showing ${activeHost.name}. This inspector remains on ${owner.name}.` : '';
        $('navigation-note').hidden = !$('navigation-note').textContent;
        document.body.dataset.navigationMismatch = String(Boolean(mismatch));
        return owner;
    }
    function renderWorkspaces() {
        if (pointerActive) { renderPending = true; return; }
        const root = $('workspace-list'); root.replaceChildren();
        const query = preferences.filter.trim().toLocaleLowerCase();
        const hosts = navigation?.hosts ?? [{ id: 'owner', name: 'This daemon', kind: 'local', connection: 'connected', workspaces }];
        let count = 0, total = 0;
        for (const host of hosts) {
            total += host.workspaces.length;
            const matches = host.workspaces.map(row => host.kind === 'local' ? { ...row, ...workspaces.find(local => local.id === row.id) } : row)
                .filter(row => `${host.name} ${row.name} ${row.groupName ?? row.group?.name ?? ''} ${(row.labels ?? []).join(' ')}`.toLocaleLowerCase().includes(query));
            if (preferences.sort === 'name') matches.sort((a, b) => a.name.localeCompare(b.name));
            count += matches.length;
            if (!matches.length && query) continue;
            const hostSection = el('section', 'host'); hostSection.dataset.hostId = host.id; hostSection.dataset.hostName = host.name;
            if (hosts.length > 1) hostSection.append(el('h2', 'host-title', host.name));
            if (host.connection !== 'connected') hostSection.append(el('p', 'empty compact', `Connection: ${host.connection}. Workspaces will return when connected.`));
            const groups = new Map();
            for (const row of matches) { const label = row.groupName ?? row.group?.name ?? 'Workspaces'; const group = groups.get(label) ?? []; group.push(row); groups.set(label, group); }
            for (const [group, rows] of groups) {
                hostSection.append(el('h2', 'group-title', group));
                for (const row of rows) {
                    const selected = navigation ? navigation.active?.hostID === host.id && navigation.active?.workspaceID === row.id : row.id === workspaceID;
                    const wrapper = el('div', 'workspace-row'); wrapper.dataset.workspaceId = row.id; wrapper.dataset.hostId = host.id; wrapper.dataset.active = String(selected);
                    const main = button('', 'workspace-button', async () => {
                        if (navigation) await api.ui.selectWorkspace(host.id, row.id); else await selectWorkspace(row.id);
                    }, `${row.name} · ${host.name}`);
                    main.dataset.unavailable = String(host.connection !== 'connected'); main.disabled = busy || host.connection !== 'connected';
                    main.setAttribute('aria-label', `Open ${row.name}`); main.setAttribute('aria-current', selected ? 'page' : 'false');
                    const avatar = el('span', 'avatar', row.name.slice(0, 1).toLocaleUpperCase()); avatar.style.setProperty('--workspace-color', colors[row.color] ?? colors.blue);
                    const copy = el('span', 'row-copy'); copy.append(el('span', 'row-title', row.name));
                    const active = host.kind === 'local' ? panes.filter(pane => pane.workspaceID === row.id && pane.status !== 'idle').length : 0;
                    const detail = [...(row.labels ?? []), ...(active ? [`${active} active`] : [])].join(' · ');
                    if (detail) copy.append(el('span', 'row-detail', detail));
                    main.append(avatar, copy);
                    if (preferences.showCounts) main.append(el('span', 'count', String(row.paneCount)));
                    if (selected) main.append(el('span', 'active-dot'));
                    wrapper.append(main);
                    if (host.kind === 'local') {
                        const rename = button('', 'icon-button rename', async () => editor(row.id), `Rename ${row.name}`);
                        rename.innerHTML = icon('edit'); rename.setAttribute('aria-label', `Rename ${row.name}`); rename.dataset.renameWorkspace = row.id; wrapper.append(rename);
                    }
                    hostSection.append(wrapper);
                }
            }
            root.append(hostSection);
        }
        if (!count) empty(root, total ? 'No matching workspaces' : 'Make room for a new idea', total ? 'Try another name, host, group, or label.' : 'Create a workspace to get started.');
        const owner = navigationNote();
        $('scope').textContent = `Create and rename on ${owner?.name ?? 'this daemon'}`;
        $('new-workspace').title = `Create a workspace on ${owner?.name ?? 'this daemon'}`;
        $('status').textContent = query ? `${count} of ${total} workspaces` : `${total} workspaces · changes update automatically`;
    }
    function repositoryCard(association) {
        const card = el('article', 'repository'); card.dataset.associationId = association.id;
        const heading = el('div', 'repository-header'); heading.append(el('strong', '', association.repoName));
        const kind = association.status.kind;
        const status = el('span', 'git-state', kind === 'dirty' ? 'Changes' : kind === 'clean' ? 'Clean' : 'Unknown'); status.dataset.kind = kind; heading.append(status);
        const branch = el('div', 'branch'); branch.innerHTML = icon('branch'); branch.append(document.createTextNode(association.branch ?? 'No branch'));
        card.append(heading, branch);
        if (preferences.showPaths) card.append(el('p', 'repo-path', association.worktreePath));
        if (kind === 'dirty') {
            const stats = el('div', 'diff-stats'); stats.append(el('span', '', `${association.status.changedFiles} file${association.status.changedFiles === 1 ? '' : 's'}`), el('span', 'added', `+${association.status.additions}`), el('span', 'deleted', `−${association.status.deletions}`)); card.append(stats);
        }
        const actions = el('div', 'actions');
        const diff = button('Open diff', 'inline-action', async () => { await selectWorkspace(workspaceID); await api.git.diff(association.worktreePath, { workspaceID }); await refresh(); $('status').textContent = 'Diff opened in this workspace.'; });
        diff.dataset.openDiff = association.id; diff.dataset.unavailable = String(panes.length === 0); diff.disabled = busy || panes.length === 0;
        if (!panes.length) diff.title = 'Create a terminal in this workspace first';
        const terminal = button('+ Terminal', 'inline-action', () => createTerminal(association.worktreePath)); terminal.dataset.repoTerminal = association.id;
        actions.append(diff, terminal); card.append(actions); return card;
    }
    async function createTerminal(path) {
        if (!workspaceID) throw new Error('Choose a workspace first.');
        const result = await api.panes.create({ workspaceID, ...(path ? { path } : {}) });
        await selectWorkspace(workspaceID); await api.ui.focusPane(workspaceID, result.paneID);
        $('status').textContent = 'Terminal created.';
    }
    function renderInspector() {
        if (pointerActive) { renderPending = true; return; }
        const workspace = workspaces.find(row => row.id === workspaceID);
        const owner = navigationNote();
        $('scope').textContent = `Inspecting ${owner?.name ?? "this view's daemon"}`;
        $('workspace-title').textContent = workspace?.name ?? 'Choose a workspace';
        $('workspace-summary').textContent = workspace ? [workspace.groupName, ...workspace.labels, `${panes.length} pane${panes.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') : 'Create a workspace before adding panes or repositories.';
        $('inspect-workspace').replaceChildren(...workspaces.map(row => { const option = el('option', '', row.name); option.value = row.id; return option; }));
        $('inspect-workspace').value = workspaceID ?? '';
        document.body.dataset.workspaceId = workspaceID ?? '';
        const repos = $('repositories'); repos.replaceChildren(...associations.map(repositoryCard));
        $('repo-count').textContent = String(associations.length);
        if (!associations.length) empty(repos, 'No repositories here yet', 'Add a repository path or choose one below.');
        const registry = $('repository-registry'); registry.replaceChildren();
        for (const repo of repositories) {
            const row = el('div', 'registry-row'); row.dataset.repoId = repo.id;
            row.append(el('strong', 'row-title', repo.name));
            if (preferences.showPaths) row.append(el('p', 'repo-path', repo.path));
            const associated = associations.some(item => item.repoID === repo.id);
            const action = button(associated ? 'Added to this workspace' : 'Use in this workspace', 'inline-action', async () => { await api.git.associate(workspaceID, repo.path); await refresh(true); });
            action.dataset.unavailable = String(associated || !workspaceID); action.disabled = busy || associated || !workspaceID;
            const actions = el('div', 'actions'); actions.append(action); row.append(actions); registry.append(row);
        }
        if (!repositories.length) registry.append(el('p', 'empty compact', 'Registered repositories will appear here.'));
        const paneList = $('panes'); paneList.replaceChildren(); $('pane-count').textContent = String(panes.length);
        for (const pane of panes) {
            const row = el('div', 'pane-row'); row.dataset.paneId = pane.id;
            const name = pane.label ?? pane.title ?? (pane.type === 'shell' ? 'Terminal' : pane.type);
            const focus = button('', 'pane-focus', async () => { await selectWorkspace(workspaceID); await api.ui.focusPane(workspaceID, pane.id); await refresh(); });
            focus.setAttribute('aria-label', `Focus ${name}`); focus.setAttribute('aria-pressed', String(pane.isFocused)); focus.innerHTML = icon(pane.type === 'shell' ? 'terminal' : 'grid');
            const copy = el('span', 'row-copy'); copy.append(el('span', 'row-title', name), el('span', 'pane-kind', `${pane.type === 'shell' ? 'terminal' : pane.type} · ${pane.status}`)); focus.append(copy); row.append(focus);
            if (pane.type === 'shell') { const split = button('Split', 'inline-action', async () => { const result = await api.panes.split(pane.id); await selectWorkspace(workspaceID); await api.ui.focusPane(workspaceID, result.paneID); }); split.dataset.splitPane = pane.id; row.append(split); }
            paneList.append(row);
        }
        if (!panes.length) paneList.append(el('p', 'empty compact', 'Create a terminal to start working.'));
        const previousTarget = $('terminal-target').value;
        const terminals = panes.filter(pane => pane.type === 'shell');
        $('terminal-target').replaceChildren(...terminals.map(pane => { const option = el('option', '', pane.label ?? pane.title ?? 'Terminal'); option.value = pane.id; return option; }));
        $('terminal-target').value = terminals.some(pane => pane.id === previousTarget) ? previousTarget : (terminals.find(pane => pane.isFocused) ?? terminals[0])?.id ?? '';
        $('status').textContent = 'Repository and pane changes update automatically.';
        syncActionAvailability();
    }
    function syncActionAvailability() {
        if (workspacesView) return;
        for (const id of ['rename-workspace', 'new-terminal', 'associate-repository']) $(id).disabled = busy || !workspaceID;
        for (const id of ['terminal-target', 'terminal-command', 'send-command', 'capture-output']) $(id).disabled = busy || !$('terminal-target').value;
    }
    function refresh(force = false) {
        refreshWanted = true; forceWanted ||= force;
        if (refreshPromise) return refreshPromise;
        refreshPromise = (async () => {
            while (refreshWanted && !disposed) {
                refreshWanted = false; const refreshRepos = forceWanted; forceWanted = false;
                $('refresh').setAttribute('aria-busy', 'true');
                if (!busy) $('status').textContent = workspacesView ? 'Updating workspaces…' : 'Updating repositories…';
                try {
                    const nextWorkspaces = await api.workspaces.list();
                    const nextID = nextWorkspaces.some(row => row.id === api.context.workspaceID) ? api.context.workspaceID : (nextWorkspaces.find(row => row.isActive) ?? nextWorkspaces[0])?.id ?? null;
                    const values = await Promise.all([
                        api.panes.list(workspacesView || !nextID ? {} : { workspaceID: nextID }),
                        !workspacesView ? api.git.repositories() : [],
                        !workspacesView && nextID ? api.git.status(nextID, { refresh: refreshRepos }) : [],
                    ]);
                    if (disposed) return;
                    workspaces = nextWorkspaces; workspaceID = nextID; [panes, repositories, associations] = values;
                    if (workspacesView) renderWorkspaces(); else renderInspector();
                    document.body.dataset.ready = 'true'; document.body.dataset.daemonId = api.context.daemonID; document.body.dataset.workspaceId = workspaceID ?? '';
                } catch (cause) { showError(cause); }
                finally { $('refresh').removeAttribute('aria-busy'); }
            }
        })().finally(() => { refreshPromise = null; });
        return refreshPromise;
    }
    function scheduleRefresh(force = false) {
        forceWanted ||= force;
        if (!ready || api.visible === false || refreshTimer !== null || disposed) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 100);
    }
    $('refresh').onclick = () => { clearError(); void refresh(true); };
    $('retry').onclick = () => { clearError(); void refresh(true); };
    $('workspace-cancel').onclick = () => { $('workspace-editor').hidden = true; };
    $('workspace-editor').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); $('workspace-editor').hidden = true; } });
    bindForm('workspace-editor', async () => {
            const name = $('workspace-name').value.trim(); if (!name) throw new Error('Give the workspace a name.');
            if (editingID) { await api.workspaces.rename(editingID, name); $('workspace-editor').hidden = true; await refresh(); $('status').textContent = 'Workspace renamed.'; }
            else {
                const path = $('workspace-path').value.trim();
                const result = await api.workspaces.create({ name, ...(path ? { path } : {}) });
                preferences.filter = ''; await savePreferences(); applyPreferences();
                $('workspace-editor').hidden = true; await refresh(); await selectWorkspace(result.workspaceID);
            }
    });
    if (workspacesView) {
        $('new-workspace').onclick = () => editor();
        $('filter').oninput = () => { preferences.filter = $('filter').value; renderWorkspaces(); void savePreferences(); };
        $('sort').onchange = () => { preferences.sort = $('sort').value; renderWorkspaces(); void savePreferences(); };
        $('show-counts').onchange = () => { preferences.showCounts = $('show-counts').checked; renderWorkspaces(); void savePreferences(); };
    } else {
        $('inspect-workspace').onchange = () => { void perform(() => selectWorkspace($('inspect-workspace').value)); };
        $('rename-workspace').onclick = () => editor(workspaceID);
        $('new-terminal').onclick = () => { void perform(() => createTerminal()); };
        $('show-paths').onchange = () => { preferences.showPaths = $('show-paths').checked; renderInspector(); void savePreferences(); };
        $('registered-repositories').ontoggle = () => { if (!ready || preferences.showRegistry === $('registered-repositories').open) return; preferences.showRegistry = $('registered-repositories').open; void savePreferences(); };
        bindForm('add-repository', async () => { const path = $('repository-path').value.trim(); if (!path || !workspaceID) throw new Error('Choose a workspace and enter a repository path.'); await api.git.associate(workspaceID, path); $('repository-path').value = ''; await refresh(true); $('status').textContent = 'Repository added.'; });
        bindForm('terminal-form', async () => { const target = $('terminal-target').value; const command = $('terminal-command').value; if (!target || !command.trim()) throw new Error('Choose a terminal and enter a command.'); await api.terminal.send(target, command); $('terminal-command').value = ''; $('status').textContent = 'Command sent to the selected terminal.'; });
        $('terminal-target').onchange = () => { $('terminal-output-details').hidden = true; $('terminal-output').textContent = ''; syncActionAvailability(); };
        $('capture-output').onclick = () => { void perform(async () => { const target = $('terminal-target').value; if (!target) throw new Error('Choose a terminal first.'); $('terminal-output').textContent = await api.terminal.capture(target, { scrollback: true, lines: 80 }); $('terminal-output-details').hidden = false; $('terminal-output-details').open = true; $('status').textContent = 'Read the last 80 lines.'; }); };
    }
    async function boot() {
        await api.ready;
        readPreferences(await api.storage.get(preferenceKey)); applyPreferences();
        if (typeof api.ui.getNavigation === 'function') {
            try { navigation = await api.ui.getNavigation(); }
            catch (cause) { navigationError = message(cause); }
            disposers.push(api.ui.onNavigation(value => {
                navigation = value; navigationError = '';
                if (ready) { if (workspacesView) renderWorkspaces(); else renderInspector(); }
            }, cause => { navigation = null; navigationError = message(cause); if (ready) { if (workspacesView) renderWorkspaces(); else renderInspector(); } }));
        }
        disposers.push(api.events.on('state.changed', () => scheduleRefresh()));
        disposers.push(api.events.on('gap', () => scheduleRefresh(true)));
        disposers.push(api.events.on('services.invalidated', () => scheduleRefresh(true)));
        disposers.push(api.events.on('*', event => { if (event.name.startsWith('daemon.') && /repo|git|graft/.test(event.name)) scheduleRefresh(); }));
        disposers.push(api.events.on('example.sidebar-lab.preferences.changed', event => {
            if (event.data?.view !== view || event.data.instanceID === instanceID) return;
            readPreferences(event.data.preferences); applyPreferences(); if (ready) { if (workspacesView) renderWorkspaces(); else renderInspector(); }
        }));
        disposers.push(api.onContext(() => scheduleRefresh()));
        ready = true; await refresh(true);
    }
    // Live status must not replace a pressed button before its click is delivered.
    const releasePointer = () => {
        clearTimeout(pointerReleaseTimer);
        pointerReleaseTimer = setTimeout(() => {
            pointerActive = false;
            if (!disposed && renderPending) { renderPending = false; if (workspacesView) renderWorkspaces(); else renderInspector(); }
        }, 0);
    };
    window.addEventListener('pointerdown', () => { clearTimeout(pointerReleaseTimer); pointerActive = true; }, true);
    window.addEventListener('pointerup', releasePointer, true);
    window.addEventListener('pointercancel', releasePointer, true);
    window.addEventListener('blur', releasePointer);
    window.addEventListener('pointerout', event => { if (event.relatedTarget === null) releasePointer(); }, true);
    window.addEventListener('pagehide', () => { disposed = true; clearTimeout(refreshTimer); clearTimeout(pointerReleaseTimer); for (const off of disposers) off(); }, { once: true });
    void boot().catch(showError);
})();
