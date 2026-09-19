/**
 * Pane Lab: the `pane.chrome` presenter.
 *
 * Public SDK only. `kelpi.ui.onPaneChrome` delivers one frame carrying every visible pane of the
 * displayed workspace, and ten `kelpi.ui` verbs act on it: `focusChromePane`, `splitPane`,
 * `toggleZoom`, `renamePane` (which opens the HOST's inline field and takes no name),
 * `closePane` (which routes through the HOST's confirmation), `activatePaneControl` and
 * `runPaneHeaderItem` (both by opaque ref), `openPaneMenu`, `setPaneChromeHeight`,
 * `setPaneDragRegions` and `reportPresenterReady`.
 *
 * What is NOT here is the point of the example. There is no pane handle, no pid, no absolute path,
 * no plugin id and no command name anywhere in this file: a control is named by an opaque,
 * pane-scoped ref that means nothing outside the frame it arrived in, and the host re-resolves it
 * against a fresh model before anything runs. There is no confirmation dialog and no text input
 * either, because both are the host's - `closePane` raises the host's confirmation and `renamePane`
 * opens the host's field, and while that field is up the host takes the band back and the frame
 * says `renaming: true`.
 *
 * ── Geometry ────────────────────────────────────────────────────────────────────────
 *
 * ONE view for the whole grid. The host mounts this frame over the pane grid and clips it to the
 * bands it is drawing, so every header below is `position: absolute` at the `rect` its pane's
 * entry carries - the same coordinate space, no translation, and nothing drawn outside a rect can
 * reach the screen or the pointer. A pane with `rect: null` has not been measured yet and is not
 * drawn; a pane the budget withheld is not in `panes` at all and keeps the bundled header, which
 * the count in `withheld` is what says.
 *
 * ── The title area, offered to the host ─────────────────────────────────────────────
 *
 * A press inside this frame can never start the window's pane-move gesture: Chromium settles where
 * a mouse gesture is routed when the button goes down, so it stays in here. What this view can do
 * is say which parts of its band BEHAVE like a title bar, with `setPaneDragRegions`, and the host
 * lays its own transparent surfaces over them - so a user grabs the header where the header is, as
 * they do on a bundled pane.
 *
 * What is declared is the title's own run: after the status dot and the kind chip, before the other
 * plugins' items and the control row, on both lines of a tall band. Deliberately NOT the whole
 * band, because nothing is forwarded back into this document - a region over a control would hide
 * that control. The regions are re-declared whenever this view's own layout moves, which is what a
 * `ResizeObserver` over the bands is for: the rectangles are band-local, so a pane that merely
 * moves or resizes takes them with it and nothing has to be re-sent.
 *
 * ── Declared bands ──────────────────────────────────────────────────────────────────
 *
 * A pane at least `WIDE_PANE` px across gets a two-line band: the title row, then the directory,
 * the branch, the change counts and the agent clock. That is declared with
 * `setPaneChromeHeight(paneID, TALL_BAND)`, the host clamps it to the smaller of 96 px and a
 * quarter of that pane's height, and the pane's body - a terminal's rows, a web pane's native
 * bounds - moves under it. A pane that narrows back below the threshold hands the band back with
 * `null` rather than being torn down.
 */
const api = globalThis.kelpi;
const element = id => document.getElementById(id);

/**
 * The scenario's whole view into this presenter, and `postMessage`-free: state to assert on plus
 * the three deliberate hooks the recovery paths and the height authority are exercised with.
 */
const lab = { snapshot: null, ready: false, frames: 0, lastError: null, lastPress: null, pressMoves: 0, regions: {}, crash, stall, declare };
globalThis.paneLab = lab;

let disposed = false, painted = false, stalled = false, armed = null;
/** The bands this view has asked for, by pane id, so an unchanged declaration is not re-sent. */
const declared = new Map();
/** The drag regions last sent, by pane id, for the same reason. */
const sentRegions = new Map();
/** Pane ids that `declare()` has pinned by hand; the width rule leaves those alone. */
const pinned = new Set();

/** A pane this wide gets two lines. Measured against the bundled header's own §S8 ladder. */
const WIDE_PANE = 420;
/** Four native bands is the host's ceiling; this asks for two lines' worth and lets it clamp. */
const TALL_BAND = 44;

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
 * Declare a band by hand, and keep the width rule off that pane.
 *
 * `null` hands it back and releases the pin. The clamp is the host's either way - this is the one
 * place a scenario can ask for a number and then measure what the pane actually got.
 */
function declare(paneID, pixels) {
    if (pixels === null) { pinned.delete(paneID); declared.delete(paneID); }
    else { pinned.add(paneID); declared.set(paneID, pixels); }
    void act(() => api.ui.setPaneChromeHeight(paneID, pixels));
}

function failed(error) {
    const message = error?.message ?? String(error);
    lab.lastError = message;
    if (disposed) return;
    const output = element('error');
    output.textContent = message; output.title = message; output.hidden = false;
}
/** A call can be refused - the pane may have gone - and no refusal may go unhandled. */
async function act(operation) {
    try { element('error').hidden = true; await operation(); } catch (error) { failed(error); }
}
/**
 * Two animation frames, so readiness is claimed after a paint rather than after a render call -
 * raced against a short deadline, because the host arms its 5 second readiness window on the first
 * frame it delivers whether or not that frame had anything to draw. A workspace whose panes are all
 * withheld renders nothing, so waiting on an animation frame alone would miss that window and hand
 * every band back.
 */
const afterPaint = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    const done = () => { clearTimeout(timer); resolve(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
});

/* -- drawing ------------------------------------------------------------------------ */

/** Keyed reconciliation, so a band that is only moving is moved rather than rebuilt. */
function reconcile(host, keys, create) {
    const wanted = new Set(keys);
    for (const child of [...host.children]) if (!wanted.has(child.dataset.key)) child.remove();
    const nodes = [];
    for (const [index, key] of keys.entries()) {
        let node = [...host.children].find(child => child.dataset.key === key);
        if (node === undefined) { node = create(key); node.dataset.key = key; }
        if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null);
        nodes.push(node);
    }
    return nodes;
}

const chip = (kind, text, title) => {
    const node = document.createElement('span');
    node.className = 'chip';
    node.dataset.chip = kind;
    node.textContent = text;
    if (title !== undefined) node.title = title;
    if (kind === 'branch') node.dataset.testid = 'lab-pane-branch';
    return node;
};

/** `doc 4 +120 -8`, which is the status footer's own wording for the same three numbers. */
const changesText = changes =>
    `doc ${changes.changedFiles} +${changes.additions} -${changes.deletions}`;

/**
 * One control, by REF.
 *
 * The ref is the whole of what this view knows about a control: no verb, no owning plugin, no test
 * id. It is minted per frame and scoped to its pane, so the listener reads the ref off the node at
 * click time rather than closing over the one the node was built with - a row that moved between
 * the render and the click then refuses at the host rather than running its neighbour.
 */
function controlNode() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'control';
    node.dataset.testid = 'lab-pane-control';
    node.addEventListener('click', event => {
        event.preventDefault();
        const paneID = node.closest('[data-pane-id]')?.dataset.paneId;
        if (paneID === undefined) return;
        void act(() => api.ui.activatePaneControl(paneID, node.dataset.ref));
    });
    return node;
}

/** One of another plugin's `pane.header` items, by ref. Drawing these is inheriting somebody
 * else's extension point rather than deleting it. */
function itemNode() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'item';
    node.dataset.testid = 'lab-pane-item';
    node.addEventListener('click', event => {
        event.preventDefault();
        const paneID = node.closest('[data-pane-id]')?.dataset.paneId;
        if (paneID === undefined) return;
        void act(() => api.ui.runPaneHeaderItem(paneID, node.dataset.ref));
    });
    return node;
}

function bandNode() {
    const node = document.createElement('div');
    node.className = 'band';
    node.dataset.testid = 'lab-pane-header';
    // The whole band focuses its pane, which is shell-ui.md §4.1's rule and the bundled header's
    // own `onPointerDown`. Every control inside it stops the press, exactly as a native button
    // consumes its own tap.
    node.addEventListener('pointerdown', event => {
        const paneID = node.dataset.paneId;
        // What the last press was, and how many moves the FRAME saw while the button was down.
        // The second number is the measurement behind the host's drag grip: a press that lands in
        // here keeps the whole gesture in here, whatever the host does afterwards.
        lab.lastPress = { paneID: paneID ?? null, button: event.button, target: event.target?.className ?? null };
        lab.pressMoves = 0;
        /*
         * A band is chrome, not prose.
         *
         * Without this the browser starts a native text SELECTION on a press and drags it across
         * the header, which is what a user gets instead of anything useful - and the selection also
         * keeps the gesture in this document. `user-select: none` in the stylesheet says the band
         * holds nothing selectable; this says the press itself is not the start of one. The pane
         * move is the host's own grip at the leading edge of the band, in the host's own document,
         * because a press in here can never reach the window's gesture (see the README).
         */
        event.preventDefault();
        if (paneID === undefined) return;
        void act(() => api.ui.focusChromePane(paneID));
    });
    node.addEventListener('dblclick', event => {
        event.preventDefault();
        void act(() => api.ui.toggleZoom(node.dataset.paneId));
    });
    node.addEventListener('contextmenu', event => {
        event.preventDefault();
        void act(() => api.ui.openPaneMenu(node.dataset.paneId));
    });
    /*
     * Two rows, each split into a FACTS box and a reconciled box.
     *
     * The split is not decoration: the facts are rebuilt wholesale every frame (they are strings),
     * while the controls and the items are reconciled BY REF so a button the pointer is already on
     * is moved rather than replaced. Reconciling a box that also held rebuilt children would take
     * the rebuilt ones out on every pass, because they carry no key to be wanted by.
     */
    const one = document.createElement('div'); one.className = 'line line-one';
    const facts = document.createElement('div'); facts.className = 'line facts';
    // The facts half of the row: everything in it is a FACT rather than a control. Named so a test
    // can aim at a part of the band that is never a button; the DRAG handle is the host's own grip
    // at the leading edge, outside this frame entirely.
    facts.dataset.testid = 'lab-pane-facts';
    const items = document.createElement('div'); items.className = 'line items';
    const controls = document.createElement('div'); controls.className = 'line controls';
    one.append(facts, items, controls);
    const two = document.createElement('div'); two.className = 'line line-two';
    const detail = document.createElement('div'); detail.className = 'line facts';
    two.append(detail);
    node.append(one, two);
    return node;
}

function paintBand(node, pane) {
    const rect = pane.rect;
    node.dataset.paneId = pane.paneID;
    node.dataset.kind = pane.kind;
    node.dataset.status = pane.status;
    node.dataset.focused = String(pane.focused);
    node.dataset.height = String(pane.height);
    node.style.left = `${rect.x}px`;
    node.style.top = `${rect.y}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
    const tall = rect.height >= 30;
    node.dataset.tall = String(tall);

    const [one, two] = node.children;
    /*
     * The other plugins' items live on the FIRST line beside the controls, not on the second.
     * The second line only exists on a band tall enough to have one, and an item row drawn into a
     * 21 px band would be clipped by the band's own `overflow: hidden` - which is a presenter
     * deleting somebody else's extension point by accident.
     */
    const [factsBox, itemsBox, controlsBox] = one.children;
    const [detailBox] = two.children;
    const first = [];
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.dataset.status = pane.status;
    first.push(dot);
    first.push(chip('kind', pane.kind));
    if (pane.label !== null) first.push(chip('label', pane.label));
    const title = document.createElement('span');
    title.className = 'title';
    title.dataset.testid = 'lab-pane-title';
    const head = document.createElement('span'); head.className = 'title-head'; head.textContent = pane.titleParts.head;
    const tail = document.createElement('span'); tail.className = 'title-tail'; tail.textContent = pane.titleParts.tail;
    title.append(head, tail);
    first.push(title);
    if (pane.zoom.zoomed && pane.zoom.available) first.push(chip('zoom', 'ZOOM'));
    if (pane.sync.active) first.push(chip('sync', pane.sync.excluded ? 'SYNC OFF' : 'SYNC'));
    // On a one-line band the second row's facts have to go somewhere, so they join the first.
    if (!tall) {
        if (pane.branch !== null) first.push(chip('branch', pane.branch));
        if (pane.changes !== null) first.push(chip('changes', changesText(pane.changes)));
        if (pane.agent !== null) first.push(chip('agent', pane.agent.text));
    }
    const spacer = document.createElement('span'); spacer.className = 'spacer';
    first.push(spacer);
    factsBox.replaceChildren(...first);

    /*
     * The trailing row: the host's own controls and the other plugins' commands among them, in the
     * order the frame states, with the pinned ✕ last because the host never folds it away.
     * `size.folded` says how many the host's own ladder would have folded at this width; this view
     * simply draws the whole row and lets the band clip, which is a presenter's choice to make.
     */
    const controls = reconcile(controlsBox, pane.controls.map(control => control.ref), controlNode);
    for (const [index, node] of controls.entries()) {
        const control = pane.controls[index];
        node.dataset.ref = control.ref;
        node.dataset.kind = control.kind;
        node.dataset.pinned = String(control.pinned);
        node.dataset.icon = control.icon;
        node.textContent = SHORT[control.icon] ?? control.icon;
        node.title = control.label;
        node.setAttribute('aria-label', control.label);
        node.disabled = !control.enabled;
    }
    const items = reconcile(itemsBox, pane.items.map(item => item.ref), itemNode);
    for (const [index, node] of items.entries()) {
        const item = pane.items[index];
        node.dataset.ref = item.ref;
        node.dataset.tone = item.tone;
        node.textContent = item.badge === null ? item.text : `${item.text} ${item.badge}`;
        node.title = item.tooltip ?? item.text;
        node.setAttribute('aria-label', item.text);
        node.disabled = !item.enabled;
    }
    // The second line is the two-line band's own row; on a one-line band it carries only the
    // other plugins' items, which have nowhere else to go.
    const second = [];
    if (tall) {
        second.push(chip('dir', pane.directory, pane.directory));
        if (pane.branch !== null) second.push(chip('branch', pane.branch));
        if (pane.changes !== null) second.push(chip('changes', changesText(pane.changes)));
        if (pane.agent !== null) {
            const elapsed = pane.agent.elapsedSeconds === null ? '' : ` ${pane.agent.elapsedSeconds}s`;
            second.push(chip('agent', `${pane.agent.text}${elapsed}`));
        }
    }
    const gap = document.createElement('span'); gap.className = 'spacer';
    second.push(gap);
    detailBox.replaceChildren(...second);
    two.hidden = !tall;
}

/** A control's glyph, by the SF Symbol-style NAME the frame carries. An unknown name prints itself. */
const SHORT = {
    'split-right': '⊣', 'split-down': '⊥', globe: '⊕', close: '✕', copy: '⧉',
    pencil: '✎', eye: '◉', refresh: '↻', plugin: '◆', document: '▤', note: '▦',
    plusminus: '±', 'split-left': '⊢'
};

/** Everything this view draws exists only while it is painting, so removal is the signal. */
function blank() {
    element('root').hidden = true;
    element('root').replaceChildren();
    delete document.body.dataset.section;
    document.body.dataset.visible = 'false';
}

function render(snapshot) {
    document.body.dataset.visible = String(snapshot.visible);
    document.body.dataset.panes = String(snapshot.panes.length);
    document.body.dataset.withheld = String(snapshot.withheld);
    document.body.dataset.workspace = snapshot.visible ? snapshot.workspaceID : '';
    // `visible: false` means present nothing: the window is showing another workspace, the grid is
    // hidden, or the bundled header has the bands back.
    if (!snapshot.visible) {
        blank();
        sentRegions.clear();
        lab.regions = {};
        return;
    }
    const root = element('root');
    root.hidden = false;
    // A pane with no measured rect is a pane the grid has not laid out yet. Drawing it at 0,0 would
    // put a header over the top-left pane, which is a worse answer than drawing nothing for a frame.
    const drawn = snapshot.panes.filter(pane => pane.rect !== null);
    const bands = reconcile(root, drawn.map(pane => pane.paneID), bandNode);
    for (const [index, node] of bands.entries()) {
        paintBand(node, drawn[index]);
        bandObserver?.observe(node);
    }

    /*
     * The withheld count, said out loud - INSIDE the first carried band.
     *
     * A withheld pane keeps its bundled header, so nothing is missing from the window; a presenter
     * that ignored the count would be drawing an incomplete row and calling it the whole one. But
     * the host clips this frame to the bands it granted, so anything drawn beside them is either
     * clipped away or, where a band happens to be underneath it, painted straight over that pane's
     * own title - which is what the first cut did. A chip in the first band's own layout is inside
     * the clip by construction and cannot overlap anything, because flexbox gave it its own box.
     */
    const box = bands[0]?.querySelector('.line-one .facts') ?? null;
    if (box !== null && snapshot.withheld > 0) {
        const notice = chip('withheld', `+${snapshot.withheld} bundled`,
            `${snapshot.withheld} pane${snapshot.withheld === 1 ? '' : 's'} did not fit this frame and keep the bundled header`);
        notice.dataset.testid = 'lab-pane-withheld';
        notice.dataset.count = String(snapshot.withheld);
        // Into the row's own layout, before the spacer, so the title gives ground to it rather than
        // being painted over by it. `paintBand` rebuilds this box every frame, so there is never a
        // stale one to remove.
        box.insertBefore(notice, box.lastElementChild);
    }
}

/* -- the band this view asks for ---------------------------------------------------- */

/**
 * Declare a two-line band on the panes wide enough to read one, and hand it back on the rest.
 *
 * Driven from `size.width`, which is the host's own measurement of the pane and the same number its
 * badge ladder was computed from - a presenter cannot measure a header it has not drawn yet, and
 * two answers to how wide a pane is would be two answers to how tall its band should be. Nothing is
 * re-sent while it has not changed: the budget is 240 calls per rolling second and a breach fails
 * the placement, so a declaration per frame per pane would be a presenter that killed itself during
 * a divider drag.
 */
function declareBands(snapshot) {
    const live = new Set(snapshot.panes.map(pane => pane.paneID));
    for (const paneID of [...declared.keys()]) {
        if (live.has(paneID) || pinned.has(paneID)) continue;
        // A pane that left the frame: the host withdraws its own band when the pane goes, so this
        // only drops the local record and never sends a call about a pane the frame does not carry.
        declared.delete(paneID);
    }
    if (!snapshot.visible) return;
    for (const pane of snapshot.panes) {
        if (pinned.has(pane.paneID)) continue;
        const wanted = pane.size.width !== null && pane.size.width >= WIDE_PANE ? TALL_BAND : null;
        if (declared.get(pane.paneID) === (wanted ?? undefined)) continue;
        if (wanted === null && !declared.has(pane.paneID)) continue;
        if (wanted === null) declared.delete(pane.paneID);
        else declared.set(pane.paneID, wanted);
        void act(() => api.ui.setPaneChromeHeight(pane.paneID, wanted));
    }
}

/**
 * Where this band's title actually is, in the band's own coordinates.
 *
 * Measured rather than computed, because the answer depends on what the browser did with a flex row
 * at this width: the title gives ground first, the chips and the buttons do not. The region runs
 * from the end of the kind chip to the start of whichever box comes next (the other plugins' items,
 * or the controls), which is the part of the row that is text and space rather than buttons.
 */
function titleRegion(node, line) {
    const band = node.getBoundingClientRect();
    const facts = line.querySelector('.facts');
    if (facts === null) return null;
    const box = facts.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    // A control or an item inside this box would be hidden by the surface, so the region stops at
    // the first one. `.facts` holds none today; the guard is what keeps that true if it ever does.
    const blocker = [...facts.querySelectorAll('.control, .item')]
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.width > 0)
        .sort((a, b) => a.left - b.left)[0];
    const right = blocker === undefined ? box.right : Math.min(box.right, blocker.left);
    const width = right - box.left;
    if (width <= 0) return null;
    return {
        x: Math.round(box.left - band.left),
        y: Math.round(box.top - band.top),
        width: Math.round(width),
        height: Math.round(box.height)
    };
}

/**
 * Publish this view's drag regions, one band at a time and only when they have moved.
 *
 * Every call is charged to the presenter's 240-per-second budget and a breach fails the placement,
 * so a re-declaration per frame per pane would be a presenter that killed itself during a divider
 * drag. The comparison is on the rectangles themselves.
 */
function publishRegions() {
    for (const node of document.querySelectorAll('[data-testid="lab-pane-header"]')) {
        const paneID = node.dataset.paneId;
        if (paneID === undefined) continue;
        const regions = [];
        for (const line of node.querySelectorAll('.line-one, .line-two')) {
            if (line.hidden) continue;
            const region = titleRegion(node, line);
            if (region !== null) regions.push(region);
        }
        const key = JSON.stringify(regions);
        if (sentRegions.get(paneID) === key) continue;
        sentRegions.set(paneID, key);
        lab.regions[paneID] = regions;
        void act(() => api.ui.setPaneDragRegions(paneID, regions.length === 0 ? null : regions));
    }
}

/**
 * Re-measure when this view's own layout moves.
 *
 * The rectangles are band-local, so a pane that merely moves or resizes carries them along and
 * nothing has to be sent. What does change them is this document reflowing - a title that now fits,
 * an item that appeared, a band that went from one line to two - and that is exactly what a
 * `ResizeObserver` over the bands reports.
 */
const bandObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => publishRegions()) : null;

async function frame(snapshot) {
    lab.frames += 1; lab.snapshot = snapshot;
    if (stalled) return new Promise(() => {});
    if (armed !== null) {
        const mode = armed; armed = null;
        const error = new Error('Pane Lab crashed on purpose.');
        lab.lastError = error.message;
        if (mode === 'uncaught') setTimeout(() => { throw error; });
        throw error;
    }
    try {
        render(snapshot);
        declareBands(snapshot);
        // After the paint, because the regions are measured from what the browser actually laid out.
        publishRegions();
        if (painted) return;
        painted = true;
        await afterPaint();
        await api.ui.reportPresenterReady();
        lab.ready = true;
        document.body.dataset.ready = 'true';
    } catch (error) { failed(error); }
}

/*
 * How many moves THIS DOCUMENT sees while a button is down.
 *
 * On the document rather than on the band, because a drag leaves the band almost immediately and a
 * listener on the band would count one move and stop - which is not the question. The question is
 * whether the gesture stays in this frame at all once a press has landed in it, and the answer is
 * what the host's drag grip exists for.
 */
addEventListener('pointermove', event => {
    if (event.buttons !== 0 && typeof lab.pressMoves === 'number') lab.pressMoves += 1;
}, true);

await api.ready;
const stop = api.ui.onPaneChrome(frame, failed);
// Once: the page is going away, and a second teardown has nothing left to tear down. The bands go
// back with the view - the host drops every declaration when a presenter stands down - so nothing
// is withdrawn here into a host that has already stopped listening.
addEventListener('pagehide', () => { disposed = true; stop(); }, { once: true });
