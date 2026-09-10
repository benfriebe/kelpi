// Browser Lab uses only the injected public SDK. Kelpi owns the native pages, sessions and recovery.
const api = globalThis.kelpi;
const $ = id => document.getElementById(id);
let state, subscription, surface, presentation, stopped = false, reading = false, reread = false;
let panel = null, confirmPrivate = false, findSequence = 0, pendingFocus = false, addressEditing = false;
const actions = [];
const active = () => state?.tabs.find(tab => tab.id === state.activeTabID) ?? state?.tabs[0];

function problem(error) {
    $('problem').hidden = !error;
    $('problem').textContent = error?.message ?? error ?? '';
    document.body.dataset.error = $('problem').textContent;
}
function updatePresentation(next) {
    presentation = next;
    document.body.dataset.available = String(next.available);
    document.body.dataset.visible = String(next.visible);
    document.body.dataset.focused = String(next.focused);
    renderStatus();
}
function renderStatus() {
    const tab = active();
    $('status').textContent = !presentation ? 'Connecting…'
        : !presentation.available ? presentation.reason || 'Page display is unavailable in this client'
        : tab?.live === false ? 'Page needs recovery'
        : tab?.loading ? 'Loading…' : 'Native page connected';
    $('host').textContent = state?.host.available ? state.host.name || 'Kelpi app' : 'No page host';
    $('host').title = state?.host.available ? `Native page host: ${state.host.name || state.host.id}` : 'No native page host is connected';
}
function tabLabel(tab) {
    if (tab.title?.trim()) return tab.title;
    try { return new URL(tab.url).hostname || tab.url || 'New tab'; } catch { return tab.url || 'New tab'; }
}
function renderTabs() {
    const selected = active()?.id;
    const focused = document.activeElement?.dataset.tab;
    const children = state.tabs.map(tab => {
        const item = document.createElement('div'); item.className = `tab${tab.id === selected ? ' selected' : ''}`;
        const select = document.createElement('button'); select.type = 'button'; select.className = 'label';
        select.role = 'tab'; select.dataset.tab = tab.id; select.setAttribute('aria-selected', String(tab.id === selected));
        select.textContent = tabLabel(tab); select.title = tab.url || 'New tab';
        select.onclick = () => void action(() => api.browser.tabs.select(state.paneID, tab.id));
        const close = document.createElement('button'); close.type = 'button'; close.className = 'close';
        close.dataset.closeTab = tab.id; close.textContent = '×'; close.setAttribute('aria-label', `Close ${tabLabel(tab)}`);
        close.onclick = () => void action(() => api.browser.tabs.close(state.paneID, tab.id));
        item.append(select, close); return item;
    });
    $('tabs').replaceChildren(...children);
    if (focused) $('tabs').querySelector(`[data-tab="${CSS.escape(focused)}"]`)?.focus();
}
function renderBookmarks() {
    const items = state.favourites.map(favourite => {
        const item = document.createElement('div'); item.className = 'bookmark';
        const open = document.createElement('button'); open.className = 'open'; open.type = 'button';
        open.textContent = favourite.title || favourite.url; open.title = favourite.url;
        open.onclick = () => { showPanel(null); void navigate(favourite.url); };
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${favourite.title || favourite.url}`);
        remove.onclick = () => void action(() => api.browser.favourites.remove(favourite.id));
        item.append(open, remove); return item;
    });
    if (!items.length) {
        const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Save a page to find it here.'; items.push(empty);
    }
    $('bookmark-items').replaceChildren(...items);
}
function render() {
    if (!state) return;
    const tab = active();
    document.body.dataset.pane = state.paneID;
    document.body.dataset.tab = tab?.id ?? '';
    document.body.dataset.private = String(state.isPrivate);
    // Redirects and tab snapshots must not consume a half-typed address.
    if (!addressEditing) $('address').value = tab?.url ?? '';
    $('back').disabled = !tab || !state.host.available || !tab.canGoBack;
    $('forward').disabled = !tab || !state.host.available || !tab.canGoForward;
    $('reload').disabled = !tab || !state.host.available;
    $('reload').textContent = tab?.loading ? '×' : '↻';
    $('reload').setAttribute('aria-label', tab?.loading ? 'Stop loading' : 'Reload');
    $('private-label').hidden = !state.isPrivate;
    $('private').textContent = `${state.isPrivate ? 'Disable' : 'Enable'} private mode…`;
    const saved = state.favourites.some(item => item.url === tab?.url);
    $('favourite').setAttribute('aria-pressed', String(saved));
    $('favourite').textContent = saved ? '★ Saved' : '☆ Save';
    $('favourite').disabled = !tab?.url;
    for (const id of ['find', 'capture', 'inspect', 'zoom-in', 'zoom-out', 'zoom-reset']) $(id).disabled = !tab || !state.host.available;
    renderTabs(); renderBookmarks(); renderStatus();
}
function receive(next) {
    const changedTab = active()?.id !== (next.tabs.find(tab => tab.id === next.activeTabID) ?? next.tabs[0])?.id;
    state = next;
    if (changedTab) { findSequence++; $('matches').textContent = ''; $('capture-result').hidden = true; }
    render();
}
async function readLatest() {
    reread = true; if (reading || stopped) return;
    reading = true;
    try {
        do { reread = false; const next = await api.browser.get(); if (!stopped) receive(next); } while (reread && !stopped);
    } catch (error) { if (!stopped) problem(error); }
    finally { reading = false; }
}
async function action(invoke) {
    try { problem(null); const result = await invoke(); await readLatest(); return result; }
    catch (error) { if (!stopped) problem(error); }
}
function showPanel(next) {
    panel = next; confirmPrivate = false;
    // Native WebContentsViews draw above HTML, including this iframe. Park the page before
    // displaying a menu over its reserved rectangle; disposing the surface clears the cover.
    surface?.setCovered(next !== null);
    $('bookmarks-panel').hidden = next !== 'bookmarks'; $('tools-panel').hidden = next !== 'tools';
    $('confirmation').hidden = true;
    $('bookmarks').setAttribute('aria-expanded', String(next === 'bookmarks'));
    $('tools').setAttribute('aria-expanded', String(next === 'tools'));
}
function focusAddress() { showPanel(null); $('address').focus(); $('address').select(); }
function showFind() { showPanel(null); $('find-bar').hidden = false; $('find-input').focus(); $('find-input').select(); }
async function navigate(url) {
    const result = await action(() => api.browser.navigate(state.paneID, url));
    if (result !== undefined) {
        $('address').value = active()?.url ?? url;
        if (presentation?.available) addressEditing = false;
        // The SDK only transfers the caret when this client can display the native page.
        // Remote controls retain their local input focus after submitting an address.
        surface?.focus();
    }
}
async function find(kind = 'search') {
    const tabID = active()?.id, needle = $('find-input').value, sequence = ++findSequence;
    if (!tabID) return;
    try {
        const result = await api.browser.find(state.paneID, tabID, kind, needle);
        if (sequence !== findSequence || active()?.id !== tabID) return;
        $('matches').textContent = result.total ? `${result.current + 1} / ${result.total}` : 'No matches';
    } catch (error) { if (sequence === findSequence) problem(error); }
}
function hostAction(event) {
    actions.push(event.type); if (actions.length > 32) actions.shift();
    if (event.type === 'focusAddress') focusAddress();
    else if (event.type === 'showFind') showFind();
    else if (surface) surface.focus();
    else pendingFocus = true;
}
$('navigate').onclick = () => void navigate($('address').value);
$('address').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void navigate($('address').value); } };
$('address').onfocus = () => { addressEditing = true; };
$('address').onblur = event => {
    // Clicking Go blurs the field before its click handler. Retain the draft until that
    // handler reads it; clicks outside the address row abandon the edit and show the live URL.
    if (!$('navigation').contains(event.relatedTarget)) { addressEditing = false; if (state) $('address').value = active()?.url ?? ''; }
};
$('navigation').addEventListener('focusout', event => {
    if (!$('navigation').contains(event.relatedTarget)) { addressEditing = false; if (state) $('address').value = active()?.url ?? ''; }
});
$('back').onclick = () => void action(() => api.browser.back(state.paneID));
$('forward').onclick = () => void action(() => api.browser.forward(state.paneID));
$('reload').onclick = () => void action(() => active()?.loading ? api.browser.stop(state.paneID) : api.browser.reload(state.paneID));
$('new-tab').onclick = async () => { await action(() => api.browser.tabs.open(state.paneID)); focusAddress(); };
$('find').onclick = showFind;
$('find-input').oninput = () => void find();
$('find-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void find(event.shiftKey ? 'prev' : 'next'); } };
$('find-next').onclick = () => void find('next');
$('find-prev').onclick = () => void find('prev');
$('find-close').onclick = () => {
    $('find-bar').hidden = true; findSequence++;
    const tabID = active()?.id; if (tabID) void api.browser.find(state.paneID, tabID, 'clear').catch(problem);
    surface?.focus();
};
$('favourite').onclick = () => void action(() => api.browser.favourites.toggle(active().url, active().title ?? ''));
$('bookmarks').onclick = () => showPanel(panel === 'bookmarks' ? null : 'bookmarks');
$('tools').onclick = () => showPanel(panel === 'tools' ? null : 'tools');
for (const close of document.querySelectorAll('[data-close-panel]')) close.onclick = () => showPanel(null);
for (const direction of ['in', 'out', 'reset']) $(`zoom-${direction}`).onclick = () => void action(() => api.browser.zoom(state.paneID, active().id, direction));
$('capture').onclick = async () => {
    const result = await action(() => api.browser.capture(state.paneID, { mode: 'text' }));
    if (result) { $('capture-result').textContent = typeof result.text === 'string' ? result.text : JSON.stringify(result, null, 2); $('capture-result').hidden = false; }
};
$('inspect').onclick = () => { showPanel(null); void action(() => api.browser.inspect(state.paneID)); };
$('private').onclick = () => {
    confirmPrivate = true; $('tools-panel').hidden = true; $('confirmation').hidden = false;
    const enabling = !state.isPrivate;
    $('confirmation-title').textContent = `${enabling ? 'Enable' : 'Disable'} private mode?`;
    $('confirmation-message').textContent = enabling
        ? 'All tabs will reload in a separate temporary session. Unsaved page state will be lost. Private cookies are discarded when Kelpi quits.'
        : 'All tabs will reload using the saved session. Unsaved page state will be lost and saved cookies will become available again.';
    $('confirm-private').textContent = `${enabling ? 'Enable' : 'Disable'} private mode`;
    $('cancel-private').focus();
};
$('cancel-private').onclick = () => showPanel('tools');
$('confirm-private').onclick = async () => {
    if (!confirmPrivate) return;
    $('confirm-private').disabled = true;
    try { await action(() => api.browser.setPrivate(state.paneID, !state.isPrivate)); showPanel(null); }
    finally { $('confirm-private').disabled = false; }
};
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (panel || confirmPrivate)) { event.preventDefault(); event.stopPropagation(); showPanel(null); }
});
const stopChanged = api.events.on('browser.changed', event => { if (event.data.subscription === subscription) return readLatest(); });
const stopClosed = api.events.on('browser.closed', event => {
    if (event.data.subscription === subscription) { stopped = true; surface?.dispose(); problem('This browser pane was closed.'); }
});
addEventListener('pagehide', () => {
    stopped = true; stopChanged(); stopClosed(); surface?.dispose();
    if (subscription) void api.browser.unwatch(subscription).catch(() => {});
}, { once: true });
// Public diagnostics expose the real watch/presentation lifecycle for the local validation scenario.
globalThis.browserLab = { get state() { return state; }, get presentation() { return presentation; }, get surface() { return surface; }, actions };
try {
    await api.ready;
    const watched = await api.browser.watch(); subscription = watched.subscription; receive(watched.state);
    surface = await api.browser.attach({ element: $('page-slot'), onPresentation: updatePresentation, onAction: hostAction });
    if (pendingFocus) { pendingFocus = false; surface.focus(); }
    document.body.dataset.ready = 'true';
} catch (error) {
    problem(error);
    // Without the watch or native surface this renderer cannot function. Let the host
    // restore bundled controls; ordinary button-operation errors remain local above.
    throw error;
}
