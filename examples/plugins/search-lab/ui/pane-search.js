/**
 * Search Lab: the `pane.search` presenter.
 *
 * Public SDK only. `kelpi.ui.onPaneSearch` delivers one frame about the ONE pane Kelpi is
 * searching, and six `kelpi.ui` verbs act on it: `setSearchNeedle`, `setSearchCaseSensitive`,
 * `searchNext`, `searchPrevious`, `closeSearch` and `setSearchBoxSize`, plus the shared
 * `reportPresenterReady`.
 *
 * What is NOT here is the point of the example. There is no scrollback, no pane path, no workspace
 * id, no plugin id and no match list: the frame carries a needle, three numbers and a rectangle,
 * and the buffer this bar is searching is read - by a plugin that wants it - through
 * `capture(pane, { scrollback })` under its own identity, never as a grant riding in on a UI
 * placement. There is no way to OPEN a search either: that stays the host's gesture.
 *
 * ── Geometry ────────────────────────────────────────────────────────────────────────
 *
 * ONE view for the whole grid. The host mounts this frame over the pane grid and clips it to the
 * box it granted, so the bar below is `position: absolute` at the `box` the frame carries - the
 * same coordinate space, no translation, and nothing drawn outside it can reach the screen or the
 * pointer. A frame with `visible: false` or `box: null` draws nothing at all.
 *
 * The SIZE is this view's own: it lays the bar out to its content (`width: max-content`), measures
 * what the browser actually produced and declares that with `setSearchBoxSize`. The host clamps it
 * to the smaller of 480 px and the pane's inner width, and to the smaller of 96 px and a quarter of
 * the pane, and hands the clamped rectangle back in the next frame. Reading that rectangle back as
 * a width would be a loop, so it is used for the position and never for the size.
 *
 * ── The caret, and the four chords ──────────────────────────────────────────────────
 *
 * This view owns a text input and the caret with it, exactly as the native bar's autofocus does.
 * On the frame that opens a session the field is focused with the caret at the END of whatever
 * needle was already there, which is the bundled bar's own rule and the one place this example
 * deliberately does NOT do what the first draft of the brief asked: `grid/PaneSearchOverlay.tsx`
 * records that selecting the text made the first keystroke silently replace a needle the user had
 * just come back to, so parity with the shipped bar means a caret at the end and no selection.
 *
 * Escape, the toggle-search chord, ⌘G and ⇧⌘G never reach this document: the SDK forwards exactly
 * those four to the host and stops them here. Everything else stays in the frame, which is why
 * Return and ⇧Return are bound below - they are this view's own keys, not the window's.
 */
const api = globalThis.kelpi;
const element = id => document.getElementById(id);

/**
 * The scenario's whole view into this presenter, and `postMessage`-free: state to assert on plus
 * the three deliberate hooks the recovery paths and the box authority are exercised with.
 */
const lab = { snapshot: null, ready: false, frames: 0, lastError: null, crash, stall, declare };
globalThis.searchLab = lab;

let disposed = false, painted = false, stalled = false, armed = null;
/** The session the field was last seeded for, so a needle echoed back does not fight the caret. */
let seededFor = null;
/**
 * Whether the user has typed into THIS field since it was seeded.
 *
 * Until they have, the field follows the frame's needle on every frame. That is the hand-over: a
 * ⌘F pressed before this view has painted opens the NATIVE bar, the user starts typing there, and
 * this view is fed the needle as it goes (the host hands over the needle it is still sending, not
 * the daemon's older one) - so when the native bar stands down mid-word, this field already holds
 * what was typed and the next keystroke lands after it.
 */
let typed = false;
/** The box last declared, so an unchanged declaration is not re-sent into the call budget. */
let sentBox = null;
/** A box pinned by `declare()`; the measuring rule leaves it alone until it is handed back. */
let pinnedBox = null;

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
 * Declare a box by hand, and keep the measuring rule off it.
 *
 * `null` hands it back and releases the pin. The clamp is the host's either way - this is the one
 * place a scenario can ask for a size and then measure what the bar actually got.
 */
function declare(size) {
    const paneID = lab.snapshot?.paneID ?? null;
    if (paneID === null) return;
    pinnedBox = size;
    sentBox = size === null ? null : `${size.width}x${size.height}`;
    void act(() => api.ui.setSearchBoxSize(paneID, size));
}

function failed(error) {
    const message = error?.message ?? String(error);
    lab.lastError = message;
    if (disposed) return;
    const output = element('error');
    output.textContent = message; output.title = message; output.hidden = false;
}
/** A call can be refused - the search may have closed - and no refusal may go unhandled. */
async function act(operation) {
    try { element('error').hidden = true; await operation(); } catch (error) { failed(error); }
}
/**
 * Two animation frames, so readiness is claimed after a paint rather than after a render call -
 * raced against a short deadline, because the host arms its 5 second readiness window on the FIRST
 * frame it delivers, and the first frame a search presenter gets normally has no search open in it
 * and therefore nothing to draw. Waiting on an animation frame alone would miss that window and
 * hand the bar straight back to the host.
 */
const afterPaint = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    const done = () => { clearTimeout(timer); resolve(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
});

/* -- the bar ------------------------------------------------------------------------ */

const root = element('root');

const field = document.createElement('input');
field.type = 'text';
field.className = 'field';
field.spellcheck = false;
field.autocomplete = 'off';
field.placeholder = 'Search';
field.setAttribute('aria-label', 'Search terminal output');
field.dataset.testid = 'lab-search-input';
field.addEventListener('input', () => {
    const paneID = lab.snapshot?.paneID ?? null;
    if (paneID === null) return;
    typed = true;
    // The field is echoed LOCALLY and the needle is sent: the host debounces a short one, so a bar
    // that waited for the frame to come back would lag a round trip behind the typing.
    void act(() => api.ui.setSearchNeedle(paneID, field.value));
});
field.addEventListener('keydown', event => {
    // Return and ⇧Return are THIS view's keys. Escape, the toggle chord and ⌘G / ⇧⌘G are relayed to
    // the host by the SDK and never arrive here at all.
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    step(event.shiftKey ? 'previous' : 'next');
});

const count = document.createElement('span');
count.className = 'count';
count.dataset.testid = 'lab-search-count';
count.setAttribute('role', 'status');

const button = (testid, label, text, onPress) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'button';
    node.dataset.testid = testid;
    node.title = label;
    node.setAttribute('aria-label', label);
    node.textContent = text;
    // The caret stays in the field: a button press that blurred it would send the next Return to
    // the button instead of to the search, which is the rule the bundled bar's chevrons follow.
    node.addEventListener('mousedown', event => event.preventDefault());
    node.addEventListener('click', event => { event.preventDefault(); onPress(); });
    return node;
};

const caseToggle = button('lab-search-case', 'Match case', 'Aa', () => {
    const snapshot = lab.snapshot;
    if (snapshot?.paneID == null) return;
    void act(() => api.ui.setSearchCaseSensitive(snapshot.paneID, !snapshot.caseSensitive));
});
const previous = button('lab-search-previous', 'Previous match (Shift Return)', '↑', () => step('previous'));
const next = button('lab-search-next', 'Next match (Return)', '↓', () => step('next'));
// The two a narrow box drops first: Return, ⇧Return, ⌘G and ⇧⌘G step without them.
previous.classList.add('step');
next.classList.add('step');
const close = button('lab-search-close', 'Close search (Escape)', '×', () => {
    const paneID = lab.snapshot?.paneID ?? null;
    if (paneID === null) return;
    void act(() => api.ui.closeSearch(paneID));
});

function step(direction) {
    const paneID = lab.snapshot?.paneID ?? null;
    if (paneID === null) return;
    void act(() => (direction === 'next' ? api.ui.searchNext(paneID) : api.ui.searchPrevious(paneID)));
}

root.dataset.testid = 'lab-search';
root.append(field, count, caseToggle, previous, next, close);

/**
 * The counter, in words rather than in the bundled bar's `3/17`.
 *
 * Deliberately different, because an example that reproduced the native string would not show that
 * the numbers are the presenter's to phrase. The STATES are the native bar's, though, and they have
 * to be: nothing at all while the field is empty, "counting" while the daemon has published no
 * total, and a selection only once there is one - `3 of 0` is not a pair Kelpi can publish, because
 * it drops the selection when the total goes to zero.
 */
function countText(snapshot) {
    if (snapshot.needle.length === 0) return '';
    if (snapshot.total === null) return 'counting';
    if (snapshot.total === 0) return 'no matches';
    if (snapshot.selected === null) return `${snapshot.total} matches`;
    return `${snapshot.selected + 1} of ${snapshot.total}`;
}

/**
 * The caret at the END of what is already there, and nothing selected: a bar re-opened on an old
 * needle is something you keep typing into rather than something whose first keystroke silently
 * replaces it.
 */
function caretToEnd() {
    field.focus();
    const end = field.value.length;
    field.setSelectionRange(end, end);
}

/*
 * The frame gaining focus puts the caret in the field, in the same task.
 *
 * The host focuses this FRAME when the bar is shown; which element inside it has the caret is this
 * document's business. Waiting for the next frame to call `field.focus()` left a gap in which a
 * fast typist's keystroke landed on the body and was lost - the hop the native bar, which is one
 * document with the window, never had.
 */
addEventListener('focus', () => {
    if (!root.hidden && document.activeElement !== field) caretToEnd();
});

function render(snapshot) {
    const open = snapshot.visible && snapshot.paneID !== null && snapshot.box !== null;
    root.hidden = !open;
    document.body.dataset.visible = open ? 'true' : 'false';
    if (!open) {
        seededFor = null;
        root.removeAttribute('data-pane-id');
        return;
    }
    root.dataset.paneId = snapshot.paneID;
    root.style.left = `${snapshot.box.x}px`;
    root.style.top = `${snapshot.box.y}px`;
    /*
     * Lay out INSIDE the box the host granted, and let the field be what yields.
     *
     * The clip is not a layout: a bar wider than its box is drawn in full and then CUT, and what a
     * flex row loses to a cut on the trailing edge is the trailing end - the counter and every
     * button. Read off an onscreen screenshot on a 131 px pane: the needle and nothing else, with
     * next, previous, case and close all gone, which is a find bar you cannot step or close.
     *
     * The native bar answers this with `max-width` plus a field that may shrink (`min-width: 0`),
     * so the 22 px controls never move and the needle scrolls instead. This is the same answer:
     * the granted width is the ceiling, and `.field { flex: 0 1 auto; min-width: 0 }` is what gives
     * ground. The size this view DECLARES is still its natural one (see `publishBox`), so a pane
     * that widens gets the whole bar back.
     */
    root.style.maxWidth = `${snapshot.box.width}px`;
    root.style.maxHeight = `${snapshot.box.height}px`;
    grantedWidth = snapshot.box.width;

    /*
     * Re-seed when the SESSION moves rather than on every needle delta.
     *
     * The daemon echoes back what was just typed, and re-seeding on that would fight the caret: the
     * value is identical, but assigning it collapses a selection and can move the cursor to the end
     * mid-word. So the field is seeded once per session and then left to the user, exactly as the
     * bundled bar's `seededFor` ref does.
     */
    if (seededFor !== snapshot.paneID) {
        seededFor = snapshot.paneID;
        typed = false;
        field.value = snapshot.needle;
        caretToEnd();
    } else if ((!typed || document.activeElement !== field) && field.value !== snapshot.needle) {
        // Not typed into yet (the native bar still has the user's keystrokes), or somebody else
        // moved the needle (a second window, or another plugin through `terminal.search`) while
        // this field was not being typed into. Either way it follows.
        field.value = snapshot.needle;
        if (document.activeElement === field) caretToEnd();
    }

    const text = countText(snapshot);
    count.textContent = text;
    count.dataset.empty = snapshot.total === 0 ? 'true' : 'false';
    count.title = snapshot.needleTruncated ? 'The needle is longer than this bar can carry' : text;
    caseToggle.setAttribute('aria-pressed', snapshot.caseSensitive ? 'true' : 'false');
    const idle = snapshot.needle.length === 0 || snapshot.total === 0;
    previous.disabled = idle;
    next.disabled = idle;
    // Last, because the counter's text is part of what the bar needs room for.
    fit();
}

/* -- fitting the bar to the box ------------------------------------------------------ */

/** `.field`'s own width in style.css: what the needle gets when there is room. */
const FIELD_WIDTH = 160;
/** The narrowest the needle may get before a whole control gives way instead. */
const FIELD_FLOOR = 72;
/**
 * What the bar gives up, in order, when the box is narrower than the bar wants.
 *
 * Read off two onscreen screenshots. At ~246 px the field and the counter shrank TOGETHER (a flex
 * row shares a shortfall out by size, whatever the comments said about order), so the needle kept
 * most of its room and the counter lost its total: "1 of". At ~112 px the field went down to its own
 * padding, an empty square, and the × was cut off the trailing edge - a find bar you cannot close
 * with the mouse. So the needle yields first and alone, down to `FIELD_FLOOR`; then the ↑ ↓ buttons
 * go (Return, ⇧Return, ⌘G and ⇧⌘G still step); then the counter (its text moves to the field's
 * tooltip). The case toggle and the close button never go: one is the only sign the search is case
 * sensitive, and the other is the way out. Below the last tier the field alone shrinks further,
 * and the controls stay whole.
 */
const FITS = ['full', 'compact', 'tight'];
/** The width the host last granted, which is what the bar is fitted to. */
let grantedWidth = 0;
/** The width the bar wants with every control showing, which is what it declares. */
let wantedSize = null;

/** The bar's own laid-out width at `tier`, with no ceiling. */
function naturalWidth(tier) {
    root.dataset.fit = tier;
    return root.getBoundingClientRect().width;
}

/**
 * Pick the tier for the granted width and measure the size to declare, in one pass.
 *
 * Every measurement is taken and undone inside this call, so the only change the browser ever lays
 * out is the tier that was chosen - which is also what keeps the ResizeObserver below from being
 * fed a size change of its own making.
 */
function fit() {
    if (root.hidden) return;
    const ceiling = root.style.maxWidth;
    root.style.maxWidth = 'none';
    root.dataset.fit = 'full';
    const full = root.getBoundingClientRect();
    wantedSize = { width: Math.ceil(full.width), height: Math.ceil(full.height) };
    let chosen = FITS[FITS.length - 1];
    for (const tier of FITS) {
        const width = tier === 'full' ? full.width : naturalWidth(tier);
        if (width - FIELD_WIDTH + FIELD_FLOOR <= grantedWidth) { chosen = tier; break; }
    }
    root.dataset.fit = chosen;
    root.style.maxWidth = ceiling;
    // A hidden counter is still readable: it moves to the field's tooltip.
    field.title = chosen === 'tight' ? count.textContent : '';
}

/**
 * Measure what was drawn and declare it, only when it has moved.
 *
 * Every call is charged to the presenter's 240-per-second budget and a breach fails the placement,
 * so a declaration per frame would be a presenter that killed itself while somebody typed. The
 * comparison is on the rounded box, which is what the host stores.
 */
function publishBox() {
    const snapshot = lab.snapshot;
    if (snapshot?.paneID == null || root.hidden || pinnedBox !== null || wantedSize === null) return;
    /*
     * The size `fit()` measured with the ceiling LIFTED and every control showing, because what is
     * declared is what the bar wants and what is applied is what it was granted. Declaring the
     * clamped width, or the width of a tier that dropped controls, would be a ratchet: the host
     * clamps a declaration to the pane's room, so a bar that declared the clamped number could never
     * ask for more again and would stay narrow after the pane widened.
     */
    const size = wantedSize;
    if (size.width === 0 || size.height === 0) return;
    const key = `${size.width}x${size.height}`;
    if (sentBox === key) return;
    sentBox = key;
    void act(() => api.ui.setSearchBoxSize(snapshot.paneID, size));
}

/**
 * Re-measure when this view's own layout moves.
 *
 * The bar grows with its counter - `3 of 9` and `312 of 4096` are not the same width - and it is
 * this document reflowing that is the only thing the host cannot see. The pane moving or resizing
 * is not: the box travels in the frame and the host re-clamps it without being told.
 *
 * The refit is deferred to the next animation frame rather than run inside the observer's callback.
 * A refit can change the tier, which changes the bar's size, and a size change made inside a
 * ResizeObserver callback is reported as "ResizeObserver loop completed with undelivered
 * notifications" - an error event the SDK counts as this view failing.
 */
let refitQueued = false;
const barObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (refitQueued) return;
        refitQueued = true;
        requestAnimationFrame(() => { refitQueued = false; fit(); publishBox(); });
    })
    : null;
barObserver?.observe(root);

async function frame(snapshot) {
    lab.frames += 1; lab.snapshot = snapshot;
    if (stalled) return new Promise(() => {});
    if (armed !== null) {
        const mode = armed; armed = null;
        const error = new Error('Search Lab crashed on purpose.');
        lab.lastError = error.message;
        if (mode === 'uncaught') setTimeout(() => { throw error; });
        throw error;
    }
    try {
        render(snapshot);
        // After the paint, because the box is measured from what the browser actually laid out.
        publishBox();
        if (painted) return;
        painted = true;
        await afterPaint();
        await api.ui.reportPresenterReady();
        lab.ready = true;
        document.body.dataset.ready = 'true';
    } catch (error) { failed(error); }
}

await api.ready;
document.body.dataset.visible = 'false';
const stop = api.ui.onPaneSearch(frame, failed);
// Once: the page is going away, and a second teardown has nothing left to tear down. The box goes
// back with the view - the host drops the declaration when a presenter stands down - so nothing is
// withdrawn here into a host that has already stopped listening.
addEventListener('pagehide', () => { disposed = true; barObserver?.disconnect(); stop(); }, { once: true });
