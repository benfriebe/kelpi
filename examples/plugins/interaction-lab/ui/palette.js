/**
 * Interaction Lab: the `interaction.palette` presenter.
 *
 * Public SDK only. `kelpi.ui.onInteraction` delivers the session, and `setPaletteQuery`,
 * `setPaletteSelection`, `activatePaletteItem` and `dismissPalette` act on it. The host owns the
 * session, its query and its selection; this view owns the matching rule, the keyboard and the box
 * it draws. Rows are descriptors: activation goes back through the host, which re-resolves the id
 * against a fresh read. No backend, no build step, no access to the host DOM.
 *
 * The view is mounted `absolute inset-0` over the content row, so it draws its own backdrop and a
 * centred panel and leaves the title bar and status footer alone.
 */
const api = globalThis.kelpi;
const element = id => document.getElementById(id);
const span = className => {
    const node = document.createElement('span');
    node.className = className;
    return node;
};

/**
 * The scenario's whole view into this presenter, and `postMessage`-free: state to assert on plus
 * the two deliberate failure hooks the recovery paths are exercised with.
 */
const lab = { snapshot: null, ready: false, frames: 0, lastError: null, matched: [], selectedID: null, crash, stall };
globalThis.interactionLab = lab;

let disposed = false, painted = false, stalled = false, armed = null;
let session = null, items = [], selectedID = null, pushed = null;

/**
 * Fail on purpose. The next frame's listener throws; `crash('uncaught')` also rethrows the error
 * where nothing catches it, which is what the SDK reports as a view error and the host fails on.
 * A listener that merely throws is caught by the SDK, so that frame is still acknowledged: an
 * acknowledgement proves a frame reached the sandbox, never that the view drew it.
 */
function crash(mode) { armed = mode === 'uncaught' ? 'uncaught' : 'listener'; }
/** Stop acknowledging: every frame from the next one on is never settled, so the watchdog fires. */
function stall() { stalled = true; }

function failed(error) {
    const message = error?.message ?? String(error);
    lab.lastError = message;
    if (disposed) return;
    const output = element('error');
    output.textContent = message; output.title = message; output.hidden = false;
}
/** Any presenter call can be refused - a stale session, a vanished row - and none may go unhandled. */
async function act(operation) {
    try { element('error').hidden = true; await operation(); } catch (error) { failed(error); }
}
/**
 * Two animation frames, so readiness is claimed after a paint rather than after a render call -
 * raced against a short deadline, because the host mounts this view HIDDEN and arms its 5 second
 * readiness window on the first frame it delivers. A hidden frame is never rendered, so waiting on
 * an animation frame alone would miss that window and hand the placement straight back.
 */
const afterPaint = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    const done = () => { clearTimeout(timer); resolve(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
});

/**
 * `item.icon` is a NAME, not a glyph: the host publishes its own tokens (`terminal`,
 * `rectangle.stack`, `doc.text`, `gearshape`, …) and each presenter draws them as it likes.
 * Printing the token straight into the row is what put "rectangle.stack" across the title. An
 * unrecognised token draws nothing rather than guessing, so a token added later cannot break a row.
 */
const GLYPHS = {
    terminal: '❯', 'doc.text': '▤', 'note.text': '✎', note: '✎', plusminus: '±',
    document: '◫', globe: '◍', 'rectangle.stack': '▥', gearshape: '⚙'
};

/**
 * The host's rule, loosely: a `w:`/`p:` prefix picks the scope (the snapshot reports the result),
 * then every term must appear in the row's text. A substring match, never fuzzy.
 */
function match(universe, query, scope) {
    const lowered = query.toLowerCase().replace(/^\s+/, '');
    const rest = lowered.startsWith('w:') || lowered.startsWith('p:') ? lowered.slice(2) : lowered;
    const terms = rest.split(' ').filter(term => term.length > 0);
    return universe.filter(item => (scope === 'all' || item.kind === scope)
        && terms.every(term => `${item.title} ${item.subtitle} ${item.workspaceName}`.toLowerCase().includes(term)));
}

function renderRows(matched) {
    const host = element('rows'), wanted = new Set(matched.map(item => item.id));
    for (const child of [...host.children]) if (!wanted.has(child.dataset.itemId)) child.remove();
    for (const [index, item] of matched.entries()) {
        let row = [...host.children].find(child => child.dataset.itemId === item.id);
        if (!row) {
            row = document.createElement('li');
            row.dataset.itemId = item.id; row.dataset.testid = 'lab-palette-row';
            row.setAttribute('role', 'option');
            row.append(span('icon'), span('label'), span('sub'), span('meta'));
            row.addEventListener('click', () => activate(row.dataset.itemId));
        }
        if (host.children[index] !== row) host.insertBefore(row, host.children[index] ?? null);
        const [icon, label, sub, meta] = row.children;
        icon.textContent = GLYPHS[item.icon] ?? '';
        icon.dataset.icon = item.icon;
        label.textContent = item.title; label.title = item.title;
        sub.textContent = item.subtitle; meta.textContent = item.shortcut ?? item.workspaceName;
        row.dataset.kind = item.kind;
        row.setAttribute('aria-selected', String(item.id === selectedID));
        row.setAttribute('aria-disabled', String(item.disabled === true));
    }
}

function render(snapshot) {
    // `visible: false` means present nothing, whatever else the frame carries.
    const palette = snapshot.visible ? snapshot.palette : null;
    document.body.dataset.formFactor = snapshot.formFactor;
    document.body.dataset.visible = String(palette !== null);
    document.body.dataset.session = palette?.sessionID ?? '';
    element('backdrop').hidden = palette === null;
    if (palette === null) {
        session = null; items = []; selectedID = null;
        lab.matched = []; lab.selectedID = null;
        delete element('panel').dataset.testid;
        element('rows').replaceChildren();
        return;
    }
    element('panel').dataset.testid = 'lab-palette';
    const fresh = palette.sessionID !== session;
    if (fresh) { session = palette.sessionID; selectedID = null; pushed = null; element('error').hidden = true; }
    items = palette.items;
    element('remote').hidden = !palette.remoteWorkspaceSelected;
    element('scope').textContent = palette.scope === 'all' ? '' : palette.scope === 'workspace' ? 'Workspaces only' : 'Panes only';
    const field = element('query');
    // The host owns the query; the field is only fought over while the caret is in it.
    if (document.activeElement !== field && field.value !== palette.query) field.value = palette.query;
    const matched = match(items, palette.query, palette.scope);
    lab.matched = matched.map(item => item.id);
    /*
     * The host's selection wins while it names a matched row; otherwise this view keeps its own,
     * else the top row. Whatever it lands on is pushed back, so the host's session - and the
     * bundled presenter, if this one fails - carries the same choice.
     */
    selectedID = lab.matched.includes(palette.selectedID) ? palette.selectedID
        : lab.matched.includes(selectedID) ? selectedID : matched[0]?.id ?? null;
    lab.selectedID = selectedID;
    renderRows(matched);
    element('empty').hidden = matched.length > 0;
    element('count').textContent = `${matched.length} of ${items.length}`;
    if (fresh) field.focus();
    // `pushed` is what this view has already asked for: a frame that has not caught up with it
    // yet is not a reason to ask again.
    if (selectedID !== palette.selectedID && selectedID !== pushed) {
        const id = session, itemID = selectedID;
        pushed = itemID;
        void act(() => api.ui.setPaletteSelection(id, itemID));
    }
}

function select(itemID) {
    if (session === null || itemID === undefined || itemID === selectedID) return;
    selectedID = itemID; lab.selectedID = itemID; pushed = itemID;
    for (const row of element('rows').children) row.setAttribute('aria-selected', String(row.dataset.itemId === itemID));
    const id = session;
    void act(() => api.ui.setPaletteSelection(id, itemID));
}

/** A disabled row never activates; the host would refuse it too. */
function activate(itemID) {
    const item = items.find(row => row.id === itemID);
    if (session === null || item === undefined || item.disabled === true) return;
    const id = session;
    void act(() => api.ui.activatePaletteItem(id, itemID));
}

/**
 * Escape is relayed to the host as well, which dismisses the session itself, so whichever call
 * lands second is refused with "no longer open". That refusal is the other half doing its job and
 * is not shown; every other call reports through `act`.
 */
function dismiss() {
    if (session === null) return;
    void api.ui.dismissPalette(session).catch(() => {});
}

async function frame(snapshot) {
    lab.frames += 1; lab.snapshot = snapshot;
    if (stalled) return new Promise(() => {});
    if (armed !== null) {
        const mode = armed; armed = null;
        const error = new Error('Interaction Lab crashed on purpose.');
        lab.lastError = error.message;
        if (mode === 'uncaught') setTimeout(() => { throw error; });
        throw error;
    }
    try {
        render(snapshot);
        if (painted) return;
        painted = true;
        await afterPaint();
        await api.ui.reportPresenterReady();
        lab.ready = true;
        document.body.dataset.ready = 'true';
    } catch (error) { failed(error); }
}

/*
 * Arrows, Enter and typing belong to this view; only Escape and the Close chord are relayed to the
 * host. Escape is handled here as well, so one code path closes the palette either way. A
 * composing keystroke never selects or activates.
 */
document.addEventListener('keydown', event => {
    // `disposed` first: the listener outlives the frame's teardown in a host that reuses the
    // document, and a key pressed then must not reach a view whose DOM has already gone.
    if (disposed || session === null || event.isComposing || event.key === 'Process') return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const order = lab.matched;
        if (order.length === 0) return;
        const at = order.indexOf(selectedID);
        // Clamped, never wrapping - the bundled palette's rule.
        const next = Math.min(order.length - 1, Math.max(0, (at < 0 ? 0 : at) + (event.key === 'ArrowDown' ? 1 : -1)));
        select(order[next]);
        return;
    }
    if (event.key === 'Enter') { event.preventDefault(); activate(selectedID); return; }
    if (event.key === 'Escape') { dismiss(); return; }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) element('query').focus();
});
element('query').addEventListener('input', () => {
    if (session === null) return;
    const id = session, text = element('query').value;
    void act(() => api.ui.setPaletteQuery(id, text));
});
element('backdrop').addEventListener('mousedown', event => { if (event.target === element('backdrop')) dismiss(); });

await api.ready;
const stop = api.ui.onInteraction(frame, failed);
addEventListener('pagehide', () => { disposed = true; stop(); });
