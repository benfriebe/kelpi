/**
 * Interaction Lab: the `interaction.prompts` presenter.
 *
 * Public SDK only. `kelpi.ui.onInteraction` delivers the one visible modal request - a quick pick,
 * an input or a dialog - and `respondInteraction` settles it; a null value cancels it. The requests
 * belong to other owners, so the view renders `owner.displayName` and never sees a plugin id.
 *
 * Two things are deliberately absent. A password input is always drawn by the bundled presenter, so
 * the frame reports `prompt: null` while one is visible and only `queued` counts it. Notifications
 * are bundled in this release: `notifications` is always empty and this view never assumes one.
 *
 * The view is mounted `fixed inset-0` in the window's modal portal: it draws its own backdrop and a
 * centred card, and the host keeps the modal registration, the focus release and Escape.
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
const lab = { snapshot: null, ready: false, frames: 0, lastError: null, requestID: null, kind: null, queued: 0, matched: [], selectedID: null, crash, stall };
globalThis.interactionLab = lab;

let disposed = false, painted = false, stalled = false, armed = null;
let request = null, selectedID = null;
/** The quick pick's enabled, currently matched rows, in render order: what arrows walk. */
let navigable = [];

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
/** A settle can be refused - the request may have gone - and no refusal may go unhandled. */
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

const text = (id, value) => {
    const node = element(id);
    node.textContent = value ?? '';
    node.hidden = !value;
};
function button(label, testid, data, onClick) {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.dataset.testid = testid;
    for (const [name, value] of Object.entries(data)) node.dataset[name] = value;
    node.addEventListener('click', onClick);
    return node;
}

/** Settle the visible request. `null` cancels it; an empty string is a real input answer. */
function respond(value) {
    if (request === null) return;
    const id = request.requestID;
    void act(() => api.ui.respondInteraction(id, value));
}
/** Answer with the current quick-pick row. `navigable` only ever holds enabled rows. */
function choose() {
    if (request?.kind === 'quickPick' && navigable.includes(selectedID)) respond(selectedID);
}
/** Paint the selection the rows already know about, without rebuilding any of them. */
function paintSelection() {
    for (const row of element('items').children) row.setAttribute('aria-selected', String(row.dataset.itemId === selectedID));
}
/**
 * Move the selection, which may only ever rest on an ENABLED row - the bundled presenter's rule,
 * so a click or an arrow can never park on one that answers nothing. Diagnostics move with it.
 */
function select(itemID) {
    if (!navigable.includes(itemID) || itemID === selectedID) return;
    selectedID = itemID; lab.selectedID = itemID;
    paintSelection();
}

function renderItems(matched) {
    const host = element('items'), wanted = new Set(matched.map(item => item.id));
    for (const child of [...host.children]) if (!wanted.has(child.dataset.itemId)) child.remove();
    for (const [index, item] of matched.entries()) {
        let row = [...host.children].find(child => child.dataset.itemId === item.id);
        if (!row) {
            row = document.createElement('li');
            row.dataset.itemId = item.id; row.dataset.testid = 'lab-prompt-item';
            row.setAttribute('role', 'option');
            row.append(span('label'), span('sub'));
            // A click selects the row it landed on and answers with THAT row; a disabled one
            // does neither, rather than answering with whatever was selected before it.
            row.addEventListener('click', () => {
                select(row.dataset.itemId);
                if (row.dataset.itemId === selectedID) choose();
            });
        }
        if (host.children[index] !== row) host.insertBefore(row, host.children[index] ?? null);
        const [label, sub] = row.children;
        label.textContent = item.label; label.title = item.label;
        sub.textContent = item.description ?? '';
        row.setAttribute('aria-selected', String(item.id === selectedID));
        row.setAttribute('aria-disabled', String(item.disabled === true));
    }
}

function render(snapshot) {
    // `visible: false` means present nothing, and so does a frame with no prompt in it.
    const prompt = snapshot.visible ? snapshot.prompt : null;
    document.body.dataset.formFactor = snapshot.formFactor;
    document.body.dataset.visible = String(prompt !== null);
    document.body.dataset.kind = prompt?.kind ?? '';
    document.body.dataset.request = prompt?.requestID ?? '';
    element('backdrop').hidden = prompt === null;
    lab.queued = snapshot.queued;
    lab.requestID = prompt?.requestID ?? null;
    lab.kind = prompt?.kind ?? null;
    // Never assumed: a presenter presents modal requests only, and this release sends none.
    if (snapshot.notifications.length > 0) failed(new Error('This release never sends notifications to a presenter.'));
    if (prompt === null) {
        request = null; selectedID = null; navigable = []; lab.matched = []; lab.selectedID = null;
        delete element('panel').dataset.testid;
        element('items').replaceChildren(); element('actions').replaceChildren();
        return;
    }
    const fresh = prompt.requestID !== request?.requestID;
    request = prompt;
    const options = prompt.options, panel = element('panel'), field = element('field');
    panel.dataset.testid = 'lab-prompt';
    panel.dataset.requestId = prompt.requestID; panel.dataset.kind = prompt.kind;
    element('owner').textContent = prompt.owner.displayName;
    element('owner').dataset.ownerRef = prompt.owner.ref;
    element('queued').dataset.count = String(snapshot.queued);
    element('queued').textContent = snapshot.queued === 0 ? 'Nothing queued' : `${snapshot.queued} waiting`;
    element('title').textContent = options.title;
    text('message', prompt.kind === 'dialog' ? options.message : prompt.kind === 'input' ? options.prompt : '');
    text('detail', prompt.kind === 'dialog' ? options.detail : '');

    field.hidden = prompt.kind === 'dialog';
    if (field.hidden) field.dataset.role = 'none';
    else {
        // One field, two jobs: the quick pick's own filter, or the input's value.
        field.dataset.role = prompt.kind === 'quickPick' ? 'filter' : 'value';
        field.placeholder = options.placeholder ?? '';
        field.setAttribute('aria-label', options.title);
        if (prompt.kind === 'input') {
            field.maxLength = options.maxLength ?? 4096;
            if (fresh) field.value = options.value ?? '';
        } else {
            field.removeAttribute('maxlength');
            if (fresh) field.value = '';
        }
    }

    element('items').hidden = prompt.kind !== 'quickPick';
    if (prompt.kind === 'quickPick') {
        if (fresh) selectedID = options.selectedID ?? null;
        const term = field.value.trim().toLowerCase();
        const matched = options.items.filter(item => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(term));
        lab.matched = matched.map(item => item.id);
        // The bundled presenter's rule: the selection is an enabled matched row, or the first one,
        // or nothing at all - never a row that would answer nothing.
        navigable = matched.filter(item => item.disabled !== true).map(item => item.id);
        selectedID = navigable.includes(selectedID) ? selectedID : navigable[0] ?? null;
        lab.selectedID = selectedID;
        renderItems(matched);
    } else { navigable = []; lab.matched = []; lab.selectedID = null; element('items').replaceChildren(); }

    // A request's options never change under its id, so the buttons are built once per request:
    // rebuilding them on an unrelated frame - a queue count moving - would drop the caret.
    if (!fresh) return;
    const actions = element('actions');
    actions.replaceChildren();
    if (prompt.kind === 'dialog') {
        for (const action of options.actions) actions.append(button(action.label, 'lab-prompt-action', {
            actionId: action.id, kind: action.kind ?? 'default', cancel: String(action.id === options.cancelID)
        }, () => respond(action.id)));
    } else if (prompt.kind === 'input') actions.append(button('Submit', 'lab-prompt-submit', {}, () => respond(field.value)));
    else actions.append(button('Choose', 'lab-prompt-submit', {}, () => choose()));
    // Dismissal, for every kind. A dialog's own cancel action answers with its id instead.
    actions.append(button('Cancel', 'lab-prompt-cancel', {}, () => respond(null)));
    element('error').hidden = true;
    if (prompt.kind === 'dialog') {
        const cancel = [...actions.children].find(node => node.dataset.cancel === 'true');
        (cancel ?? actions.firstElementChild)?.focus();
    } else field.focus();
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
 * Typing, arrows and Enter belong to this view. Escape and the Close chord are relayed to the host,
 * which cancels the request itself, so there is no local Escape handler here. A composing keystroke
 * never answers anything.
 */
document.addEventListener('keydown', event => {
    // `disposed` first: the listener outlives the frame's teardown in a host that reuses the
    // document, and a key pressed then must not reach a view whose DOM has already gone.
    if (disposed || request === null || event.isComposing || event.key === 'Process') return;
    if (request.kind === 'quickPick' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        // Enabled rows only, and it WRAPS - the bundled quick pick's own navigation. A disabled
        // row is drawn and stepped over, so the selection always names something answerable.
        if (navigable.length === 0) return;
        const at = navigable.indexOf(selectedID);
        select(navigable[(Math.max(0, at) + (event.key === 'ArrowUp' ? -1 : 1) + navigable.length) % navigable.length]);
        return;
    }
    if (event.key !== 'Enter') return;
    if (request.kind === 'input') { event.preventDefault(); respond(element('field').value); return; }
    // A dialog's buttons answer Enter themselves; a quick pick confirms its selection.
    if (request.kind === 'quickPick') { event.preventDefault(); choose(); }
});
// The filter is this view's own state, so a keystroke re-renders from the frame already in hand.
element('field').addEventListener('input', () => { if (element('field').dataset.role === 'filter' && lab.snapshot !== null) render(lab.snapshot); });

await api.ready;
const stop = api.ui.onInteraction(frame, failed);
addEventListener('pagehide', () => { disposed = true; stop(); });
