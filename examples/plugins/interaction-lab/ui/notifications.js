/**
 * Interaction Lab: the `interaction.notifications` presenter.
 *
 * Public SDK only. `kelpi.ui.onInteraction` delivers the visible notification stack - other
 * plugins' `ui.showNotification` requests, oldest first - and `respondInteraction` settles one:
 * an action id for a pressed button, null for a dismissal. The requests belong to other owners, so
 * the view renders `owner.displayName` and never sees a plugin id.
 *
 * Two things this view does NOT own. The 10 second expiry is the host's: a notice that times out is
 * settled with null and simply leaves the next frame, so nothing here runs a clock. And the box it
 * draws into is the host's too - the window's bottom-right corner, at most 360 px wide - with only
 * its HEIGHT declared from here through `setNotificationBoxHeight`, which the host clamps. The
 * frame is not painted at all while the stack is empty, so an empty presenter covers nothing.
 *
 * `prompt`, `palette` and `queued` are another placement's business and are never read.
 */
const api = globalThis.kelpi;
const element = id => document.getElementById(id);

/**
 * The scenario's whole view into this presenter, and `postMessage`-free: state to assert on plus
 * the deliberate hooks the recovery and geometry paths are exercised with.
 */
const lab = { snapshot: null, ready: false, frames: 0, lastError: null, notices: [], boxHeight: null, crash, stall, declare };
globalThis.interactionLab = lab;

let disposed = false, painted = false, stalled = false, armed = null;
/** The last height sent to the host, so an unchanged frame spends no call budget. */
let declared = null;
/** A deliberate declaration, for the clamp: it survives re-renders until it is cleared. */
let override = null;

/**
 * Fail on purpose. The next frame's listener throws; `crash('uncaught')` also rethrows the error
 * where nothing catches it, which is what the SDK reports as a view error and the host fails on.
 * A listener that merely throws is caught by the SDK, so that frame is still acknowledged: an
 * acknowledgement proves a frame reached the sandbox, never that the view drew it.
 */
function crash(mode) { armed = mode === 'uncaught' ? 'uncaught' : 'listener'; }
/** Stop acknowledging: every frame from the next one on is never settled, so the watchdog fires. */
function stall() { stalled = true; }
/**
 * Ask the host for a specific box height instead of the measured one. `declare(null)` goes back to
 * measuring. The host clamps whatever arrives, which is what an absurd number here proves.
 */
function declare(pixels) {
    override = typeof pixels === 'number' ? pixels : null;
    sendHeight();
}

function failed(error) {
    const message = error?.message ?? String(error);
    lab.lastError = message;
    if (disposed) return;
    const output = element('error');
    output.textContent = message; output.title = message; output.hidden = false;
}
/** A settle can be refused - the notice may have expired - and no refusal may go unhandled. */
async function act(operation) {
    try { element('error').hidden = true; await operation(); } catch (error) { failed(error); }
}
/**
 * Two animation frames, so readiness is claimed after a paint rather than after a render call -
 * raced against a short deadline, because the host mounts this view HIDDEN (the stack is empty
 * until somebody notifies) and arms its 5 second readiness window on the first frame it delivers.
 * A hidden frame is never rendered, so waiting on an animation frame alone would miss that window
 * and hand the placement straight back.
 */
const afterPaint = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    const done = () => { clearTimeout(timer); resolve(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
});

function button(label, testid, data, onClick) {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.dataset.testid = testid;
    for (const [name, value] of Object.entries(data)) node.dataset[name] = value;
    node.addEventListener('click', onClick);
    return node;
}
function span(className, text) {
    const node = document.createElement('span');
    node.className = className; node.textContent = text;
    return node;
}
/** Settle one notice. An action id answers it; null dismisses it, exactly as an expiry does. */
function respond(requestID, value) { void act(() => api.ui.respondInteraction(requestID, value)); }

/** One card, built once per request id: its options never change under that id. */
function card(notice) {
    const row = document.createElement('li');
    row.dataset.testid = 'lab-notice';
    row.dataset.requestId = notice.requestID;
    row.dataset.tone = notice.options.tone ?? 'info';
    row.className = 'notice';
    row.setAttribute('role', notice.options.tone === 'error' ? 'alert' : 'status');

    const head = document.createElement('div');
    head.className = 'head';
    head.append(span('brand', 'LAB'));
    const owner = span('badge', notice.owner.displayName);
    owner.dataset.testid = 'lab-notice-owner';
    owner.dataset.ownerRef = notice.owner.ref;
    head.append(owner, span('spacer', ''));
    head.append(button('×', 'lab-notice-dismiss', { requestId: notice.requestID }, () => respond(notice.requestID, null)));
    row.append(head, span('text', notice.options.message));
    if (notice.options.detail) row.append(span('sub', notice.options.detail));
    if (notice.options.actions?.length) {
        const actions = document.createElement('div');
        actions.className = 'actions';
        for (const action of notice.options.actions) {
            actions.append(button(action.label, 'lab-notice-action', { actionId: action.id, requestId: notice.requestID },
                () => respond(notice.requestID, action.id)));
        }
        row.append(actions);
    }
    return row;
}

/**
 * Tell the host how tall this stack needs to be.
 *
 * The measured content height, or a deliberate declaration. Sent only when it MOVES: a frame that
 * changes nothing must not spend the presenter's call budget, and the host repaints the box only
 * when the number is different anyway.
 *
 * Nothing is declared for an EMPTY stack, and that is the interesting line: the host mounts this
 * view hidden with no notices in it, an unpainted frame measures zero, and declaring that zero
 * would replace the host's own default of one card's worth per notice - so the first real notice
 * would be drawn into a box of no height until this view had measured itself inside it.
 */
function sendHeight() {
    if (disposed) return;
    if (override === null && lab.notices.length === 0) return;
    const wanted = override ?? Math.ceil(element('stack').getBoundingClientRect().height);
    if (!Number.isFinite(wanted) || wanted < 0 || wanted === declared) return;
    declared = wanted;
    lab.boxHeight = wanted;
    void act(() => api.ui.setNotificationBoxHeight(wanted));
}

function render(snapshot) {
    // `visible: false` means present nothing, and an empty stack is the ordinary case: the host
    // does not paint this frame at all while there is nothing in it.
    const notices = snapshot.visible ? snapshot.notifications : [];
    document.body.dataset.formFactor = snapshot.formFactor;
    document.body.dataset.visible = String(notices.length > 0);
    document.body.dataset.count = String(notices.length);
    lab.notices = notices.map(notice => notice.requestID);

    const stack = element('stack');
    const wanted = new Set(lab.notices);
    // An expired or answered notice leaves; the ones still up keep the DOM they already have, so a
    // card the pointer is over does not flicker when a sibling goes.
    for (const child of [...stack.children]) if (!wanted.has(child.dataset.requestId)) child.remove();
    for (const [index, notice] of notices.entries()) {
        let row = [...stack.children].find(child => child.dataset.requestId === notice.requestID);
        if (!row) row = card(notice);
        if (stack.children[index] !== row) stack.insertBefore(row, stack.children[index] ?? null);
    }
    if (notices.length === 0) element('error').hidden = true;
    sendHeight();
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

// The box can change size without a frame - the window resized under it - so the declaration is
// re-measured then too. Nothing else here listens for a key: a notification answers no chord, and
// Escape and the Close chord belong to the prompt in front of it.
addEventListener('resize', () => { if (!disposed) sendHeight(); });

await api.ready;
const stop = api.ui.onInteraction(frame, failed);
addEventListener('pagehide', () => { disposed = true; stop(); });
