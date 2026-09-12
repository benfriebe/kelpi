/**
 * Settings Lab: the `settings.window` presenter.
 *
 * Public SDK only. `kelpi.ui.onSettingsPresentation` delivers the whole rail plus the routed
 * section's cards and fields, and six `kelpi.ui` verbs act on it: `setSettingsSection` routes,
 * `setSettingsDraft` holds an uncommitted value, `commitSettingsField` asks for the write,
 * `resetSettingsField` drops the draft, `closeSettings` is the dialog's own Close, and
 * `reportPresenterReady` confirms this view has painted.
 *
 * What is NOT here is the point of the example. There is no config key, no verb name, no file
 * path and no write closure anywhere in this file: a field is named by an opaque, window-local id
 * and the host owns the mapping, so nothing this view can say bypasses the daemon's allowlist.
 * There is no dialog frame, no backdrop and no modal registration either, because the host keeps
 * all of that: this view is mounted inside the dialog body and draws the rail and the panel only.
 *
 * Native sections are LISTED and never projected. Plugins, Remote, Profiles, Repositories, Labels,
 * Keybindings and Web report `native: true` with no fields, and General, Workspaces and Appearance
 * report `native: true` beside their projected fields because the host draws a hand-built
 * remainder below them. Both cases draw the note and leave the space to the host: the route back
 * to Plugins, where a presenter is switched off, must never depend on the presenter.
 *
 * Every value leaves through `allowed()`, which refuses what the contract forbids rather than
 * letting the host refuse it: a draft is capped at the field's own `maxLength`, a choice comes
 * from `choices`, a number is clamped into `min`/`max` and snapped onto `step`, a colour is
 * `#rrggbb`, and a control character is never sent at all.
 */
const api = globalThis.kelpi;
const element = id => document.getElementById(id);

/**
 * The scenario's whole view into this presenter, and `postMessage`-free: state to assert on plus
 * the two deliberate failure hooks the recovery paths are exercised with.
 */
const lab = { snapshot: null, ready: false, frames: 0, lastError: null, crash, stall };
globalThis.settingsLab = lab;

let disposed = false, painted = false, stalled = false, armed = null;
/** The routed section's fields by id, refreshed every frame: a handler reads the LIVE field. */
let fields = new Map();
/** This view's own refusals, keyed to the field. The host's own `error` always wins over one. */
const locals = new Map();

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
/** A call can be refused - the field may have gone - and no refusal may go unhandled. */
async function act(operation) {
    try { element('error').hidden = true; await operation(); } catch (error) { failed(error); }
}
/**
 * Two animation frames, so readiness is claimed after a paint rather than after a render call -
 * raced against a short deadline, because the host mounts this view while the dialog is CLOSED and
 * arms its 5 second readiness window on the first frame it delivers anyway. A frame that presents
 * nothing is never rendered, so waiting on an animation frame alone would miss that window and
 * hand the placement straight back.
 */
const afterPaint = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    const done = () => { clearTimeout(timer); resolve(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
});

/* -- what may be said --------------------------------------------------------------- */

/*
 * The whole C0 range, DEL and the two Unicode line separators. `~/.config/kelpi/config` and
 * `~/.config/ghostty/config` are LINE-ORIENTED, so a value carrying one of these does not write a
 * setting: it writes the setting, then whatever the rest of the string parses as. The host refuses
 * it and the daemon refuses it again; this view simply never sends one.
 */
const CONTROL = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/;

function refuse(field, reason) {
    locals.set(field.id, reason);
    return null;
}
/** Clamp into the published bounds, then onto the published step grid. */
function grid(field, value) {
    const clamped = Math.min(field.max, Math.max(field.min, value));
    const step = field.step;
    if (step === undefined || step <= 0) return clamped;
    const snapped = field.min + Math.round((clamped - field.min) / step) * step;
    // Binary floats: 0.1 + 15 * 0.05 is 0.8500000000000001, which is off its own grid. The step's
    // own decimal places are what the grid is expressed in, so that is what the value rounds to.
    const places = (String(step).split('.')[1] ?? '').length;
    return Number(Math.min(field.max, Math.max(field.min, snapped)).toFixed(places));
}
/**
 * The one door out. Returns the text to send, or null with the reason recorded against the field.
 *
 * Every constraint here is one the FRAME published, so refusing it is honouring what this view was
 * told rather than guessing: `maxLength`, `choices`, `min`, `max`, `step`, `#rrggbb`, and the
 * host's own `disabled`.
 */
function allowed(field, raw) {
    if (field.disabled === true) return refuse(field, 'The host is refusing writes for this field.');
    if (field.kind === 'toggle') return raw === true || raw === 'true' ? 'true' : 'false';
    if (field.kind === 'select' || field.kind === 'segmented')
        return field.choices.some(choice => choice.value === raw)
            ? raw
            : refuse(field, 'That option is not one this field offers.');
    if (field.kind === 'color') {
        const text = String(raw).trim().toLowerCase();
        return /^#[0-9a-f]{6}$/.test(text) ? text : refuse(field, 'A colour has to be #rrggbb.');
    }
    if (field.kind === 'text') {
        // Capped at the field's OWN maxLength, not at the shared 4096: the input carries the same
        // number as an attribute, and a paste is the path that gets past an attribute.
        const text = String(raw).slice(0, field.maxLength);
        return CONTROL.test(text)
            ? refuse(field, 'Line breaks and control characters are never sent.')
            : text;
    }
    // An emptied box is a value on its way somewhere, and `Number('')` is 0 rather than NaN: a
    // cleared port field would otherwise have been sent as this row's minimum.
    const text = String(raw).trim();
    const value = text === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(value)) return refuse(field, 'That is not a number yet, so nothing was sent.');
    return String(grid(field, value));
}

/* -- the six verbs ------------------------------------------------------------------ */

/**
 * A dragged control coalesces; a typed one does not.
 *
 * A trackpad drag on a range fires one `input` event per pixel, and the presenter budget is 240
 * calls per rolling second. Breaching it does not drop a frame, it FAILS the presenter and hands
 * the dialog back to the bundled panel, so the two dragged kinds hold their last value for a beat
 * and send once. A draft writes nothing either way, so coalescing one loses nothing.
 */
const DRAFT_COALESCE_MS = 50;
/** fieldID -> the text waiting to be sent, and the timer that will send it. */
const holds = new Map();

function hold(fieldID, text) {
    const entry = holds.get(fieldID);
    if (entry !== undefined) clearTimeout(entry.timer);
    holds.set(fieldID, {
        text,
        timer: setTimeout(() => {
            holds.delete(fieldID);
            // A frame that presents nothing means the dialog closed or the bundled panel took it
            // between the drag and this timer, and a call then is one the host refuses outright.
            if (!disposed && lab.snapshot?.visible === true) void act(() => api.ui.setSettingsDraft(fieldID, text));
        }, DRAFT_COALESCE_MS)
    });
}
/** Take a coalescing value back, unsent. Returns null when nothing was waiting. */
function unhold(fieldID) {
    const entry = holds.get(fieldID);
    if (entry === undefined) return null;
    clearTimeout(entry.timer);
    holds.delete(fieldID);
    return entry.text;
}

/** Hold a value. Nothing is written until a commit asks for it. */
function draft(field, raw) {
    const text = allowed(field, raw);
    // A refusal supersedes whatever was coalescing: clearing a box must not let the value typed a
    // moment before it go out behind it.
    if (text === null) { unhold(field.id); repaint(); return; }
    // What is SENT is not always what was typed: a cap, a clamp or a snap changes it, and a row
    // that said nothing would leave the box and the held value quietly disagreeing.
    if (text === String(raw)) locals.delete(field.id);
    else locals.set(field.id, `Sent as ${text}.`);
    repaint();
    if (field.kind === 'number' || field.kind === 'slider') hold(field.id, text);
    else void act(() => api.ui.setSettingsDraft(field.id, text));
}
/** The controls with no draft phase - a switch, a picker, a segment - hold and commit in one go. */
function set(field, raw) {
    const text = allowed(field, raw);
    if (text === null) { repaint(); return; }
    locals.delete(field.id);
    void act(async () => {
        await api.ui.setSettingsDraft(field.id, text);
        await api.ui.commitSettingsField(field.id);
    });
}
function commit(field) {
    if (field.disabled === true) return;
    locals.delete(field.id);
    // A coalescing value goes out FIRST: a Commit clicked a moment after a drag ended would
    // otherwise commit the value from before the drag.
    const queued = unhold(field.id);
    void act(async () => {
        if (queued !== null) await api.ui.setSettingsDraft(field.id, queued);
        await api.ui.commitSettingsField(field.id);
    });
}
function reset(field) {
    if (field.disabled === true) return;
    locals.delete(field.id);
    unhold(field.id);
    void act(() => api.ui.resetSettingsField(field.id));
}
/** Redraw from the frame already in hand, for the one piece of state this view owns. */
function repaint() { if (lab.snapshot !== null) render(lab.snapshot); }

/* -- drawing ------------------------------------------------------------------------ */

/**
 * `section.icon` is an SF Symbol NAME, never a glyph: printing it raw would paint
 * "antenna.radiowaves" down the rail. An unknown name draws nothing and the name itself stays on
 * the cell for anyone reading the DOM.
 */
const GLYPHS = {
    gear: '⚙', paintbrush: '✻', externaldrive: '▤', tag: '◧',
    'person.badge.key': '⚿', command: '⌘', globe: '⊕',
    'square.grid.2x2': '▦', 'antenna.radiowaves': '≋'
};

/** Keyed reconciliation, so a row the user is typing into survives the next frame. */
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
const flag = (node, name, on) => { if (on) node.dataset[name] = 'true'; else delete node.dataset[name]; };
/** Never overwrite the control the caret is in: a frame arrives on every keystroke. */
const editing = node => document.activeElement === node;

function button(label, testid, fieldID, onClick) {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label;
    node.dataset.testid = testid; node.dataset.fieldId = fieldID;
    node.addEventListener('click', () => { const live = fields.get(fieldID); if (live !== undefined) onClick(live); });
    return node;
}

/**
 * The controls are built once per row and RE-DRESSED every frame (`paintControl`).
 *
 * Everything a control shows the user is republished on every frame - the label, a text row's
 * `maxLength`, a number's `min`/`max`/`step`, a picker's `choices` - so reading any of it only at
 * creation would leave a control describing a field the host has since changed. Only the element
 * itself, its kind and its listeners are made here.
 */
function control(field) {
    const id = field.id;
    if (field.kind === 'toggle') {
        const node = document.createElement('button');
        node.type = 'button'; node.className = 'switch'; node.setAttribute('role', 'switch');
        node.dataset.testid = 'lab-settings-input'; node.dataset.fieldId = id;
        node.addEventListener('click', () => {
            const live = fields.get(id);
            if (live !== undefined) set(live, !(live.draft !== undefined ? live.draft === 'true' : live.value));
        });
        return node;
    }
    if (field.kind === 'segmented') {
        const group = document.createElement('div');
        group.className = 'segmented'; group.setAttribute('role', 'group');
        return group;
    }
    if (field.kind === 'select') {
        const node = document.createElement('select');
        node.dataset.testid = 'lab-settings-input'; node.dataset.fieldId = id;
        node.addEventListener('change', () => { const live = fields.get(id); if (live !== undefined) set(live, node.value); });
        return node;
    }
    const node = document.createElement('input');
    node.dataset.testid = 'lab-settings-input'; node.dataset.fieldId = id;
    node.autocomplete = 'off'; node.spellcheck = false;
    if (field.kind === 'number') node.type = 'number';
    else if (field.kind === 'slider') node.type = 'range';
    else {
        // A colour is a text box rather than `<input type="color">`: the host's own picker stays
        // native, and a value this view cannot vouch for has to be refusable rather than silently
        // corrected into something the user did not ask for.
        node.type = 'text';
        if (field.kind === 'color') node.className = 'color';
    }
    node.addEventListener('input', () => { const live = fields.get(id); if (live !== undefined) draft(live, node.value); });
    /*
     * The edit is over, so the box has to show what is actually HELD.
     *
     * `paintControl` never writes into the control the caret is in, which is what keeps a frame
     * arriving on every keystroke from eating the caret - but it also means a capped, clamped or
     * snapped value never reaches the box while it is being typed in. `change` and `blur` are where
     * that ends, so any coalescing value goes out now and the box is caught up with it.
     */
    const settle = () => {
        const live = fields.get(id);
        if (live === undefined) return;
        const queued = unhold(id);
        // A row being REMOVED blurs the control inside it, and the frame that removed it may be the
        // one that stopped presenting: a call then is one the host refuses, so the value is dropped.
        if (lab.snapshot?.visible !== true) return;
        if (queued === null) node.value = live.draft ?? String(live.value);
        else {
            node.value = queued;
            void act(() => api.ui.setSettingsDraft(id, queued));
        }
    };
    node.addEventListener('change', settle);
    node.addEventListener('blur', settle);
    // Enter is this row's own commit, which is what a text or number box in the bundled panel does.
    // A slider has no caret to press it with, so it is not offered one.
    if (field.kind !== 'slider')
        node.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.isComposing) return;
            event.preventDefault();
            const live = fields.get(id);
            if (live === undefined) return;
            // `commit` takes the coalescing value and sends it ahead of the commit itself, so this
            // only has to catch the box up with what is about to go out.
            const queued = holds.get(id)?.text;
            if (queued !== undefined) node.value = queued;
            commit(live);
        });
    return node;
}

function row(field) {
    const node = document.createElement('div');
    node.className = 'field';
    node.dataset.testid = 'lab-settings-field';
    node.dataset.fieldId = field.id;
    node.dataset.kind = field.kind;
    const head = document.createElement('div'); head.className = 'field-head';
    const label = document.createElement('span'); label.className = 'label';
    const box = document.createElement('div'); box.className = 'control';
    box.append(control(field));
    if (field.kind === 'color') { const swatch = document.createElement('span'); swatch.className = 'swatch'; box.append(swatch); }
    head.append(label, box);
    const detail = document.createElement('p'); detail.className = 'detail';
    const message = document.createElement('p'); message.className = 'message'; message.setAttribute('role', 'alert');
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.append(
        button('Commit', 'lab-settings-commit', field.id, live => { commit(live); }),
        button('Reset', 'lab-settings-reset', field.id, live => { reset(live); })
    );
    node.append(head, detail, message, actions);
    return node;
}

function paintControl(box, field) {
    const input = box.firstElementChild;
    if (field.kind === 'segmented') {
        input.setAttribute('aria-label', field.label);
        const value = field.draft ?? field.value;
        // Rebuilt FROM `choices` every frame, so there is no spelling of a value this control can
        // produce that the field did not offer, and a choice the host withdrew goes with it.
        const segments = reconcile(input, field.choices.map(choice => choice.value), key => {
            const segment = document.createElement('button');
            segment.type = 'button';
            segment.dataset.testid = 'lab-settings-input'; segment.dataset.value = key; segment.dataset.fieldId = field.id;
            segment.addEventListener('click', () => { const live = fields.get(field.id); if (live !== undefined) set(live, key); });
            return segment;
        });
        for (const [index, segment] of segments.entries()) {
            const choice = field.choices[index];
            segment.textContent = choice.label;
            segment.setAttribute('aria-label', `${field.label}: ${choice.label}`);
            segment.setAttribute('aria-pressed', String(choice.value === value));
            segment.disabled = field.disabled === true;
        }
        return;
    }
    input.disabled = field.disabled === true;
    if (field.kind === 'toggle') {
        const on = field.draft !== undefined ? field.draft === 'true' : field.value;
        // The switch reads "On"/"Off", which names a state and not the setting it belongs to, so
        // the accessible name has to be the label the row prints beside it.
        input.setAttribute('aria-label', field.label);
        input.setAttribute('aria-checked', String(on));
        input.dataset.value = String(on);
        input.textContent = on ? 'On' : 'Off';
        return;
    }
    input.setAttribute('aria-label', field.label);
    if (field.kind === 'select') {
        const options = reconcile(input, field.choices.map(choice => choice.value), key => {
            const option = document.createElement('option');
            option.value = key;
            return option;
        });
        for (const [index, option] of options.entries()) option.textContent = field.choices[index].label;
    } else if (field.kind === 'text') input.maxLength = field.maxLength;
    else if (field.kind === 'number' || field.kind === 'slider') {
        input.min = String(field.min);
        input.max = String(field.max);
        if (field.step === undefined) input.removeAttribute('step');
        else input.step = String(field.step);
    } else input.maxLength = 7;
    const shown = field.draft ?? String(field.value);
    if (!editing(input)) input.value = shown;
    if (field.kind === 'color') box.lastElementChild.style.background = /^#[0-9a-f]{6}$/i.test(shown) ? shown : 'transparent';
}

function paintRow(node, field) {
    const [head, detail, message, actions] = node.children;
    const [label, box] = head.children;
    node.dataset.kind = field.kind;
    label.textContent = field.label;
    detail.textContent = field.detail;
    detail.hidden = field.detail === '';
    flag(node, 'disabled', field.disabled === true);
    flag(node, 'busy', field.busy === true);
    flag(node, 'draft', field.draft !== undefined);
    // The host's refusal is the one that matters; this view's own only shows when there is no host
    // error for the field, because a stale local note beside a live one reads as two problems.
    const reason = field.error ?? locals.get(field.id) ?? '';
    message.hidden = reason === '';
    message.textContent = reason;
    message.dataset.local = String(reason !== '' && field.error === undefined);
    if (reason === '') delete node.dataset.error; else node.dataset.error = reason;
    paintControl(box, field);
    // Every row has a button reading "Commit" and one reading "Reset", so the visible text alone
    // names none of them: the accessible name has to carry the field.
    const [commitButton, resetButton] = actions.children;
    commitButton.setAttribute('aria-label', `Commit ${field.label}`);
    resetButton.setAttribute('aria-label', `Reset ${field.label}`);
    for (const child of actions.children) child.disabled = field.disabled === true;
}

/** Test ids exist only while this presenter is painting, so their presence is the signal. */
const MARKS = [['root', 'lab-settings'], ['rail', 'lab-settings-rail'], ['dirty', 'lab-settings-dirty'], ['close', 'lab-settings-close']];

function blank() {
    element('root').hidden = true;
    for (const [id] of MARKS) delete element(id).dataset.testid;
    delete element('native-note').dataset.testid;
    element('native-note').hidden = true;
    element('rail').replaceChildren();
    element('panel').replaceChildren();
    locals.clear();
}

function railItem() {
    const item = document.createElement('button');
    item.type = 'button'; item.className = 'rail-item';
    item.dataset.testid = 'lab-settings-rail-item';
    const icon = document.createElement('span'); icon.className = 'icon';
    // Decoration: the entry is named by its title, and a screen reader announcing a glyph beside
    // that title would read the section's name twice, the second time as a symbol.
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'rail-label';
    item.append(icon, label);
    // Every section routes, native ones included: the way back to Plugins, where a presenter is
    // switched off, cannot be something this view is able to withhold.
    item.addEventListener('click', () => { void act(() => api.ui.setSettingsSection(item.dataset.sectionId)); });
    return item;
}

function card() {
    const node = document.createElement('section');
    node.className = 'card';
    const title = document.createElement('h2'); title.className = 'card-title';
    const detail = document.createElement('p'); detail.className = 'card-detail';
    const rows = document.createElement('div'); rows.className = 'card-rows';
    node.append(title, detail, rows);
    return node;
}

/**
 * The card a field lands in when its `groupID` names no group in the frame.
 *
 * A field is not allowed to go missing because the card it named did not arrive: the frame is the
 * host's, the pairing is the host's, and a presenter that silently dropped a row would hide a
 * setting from the only surface drawing it.
 */
const UNGROUPED = 'lab:ungrouped';

function render(snapshot) {
    document.body.dataset.visible = String(snapshot.visible);
    document.body.dataset.section = snapshot.visible ? snapshot.sectionID : '';
    fields = new Map(snapshot.fields.map(field => [field.id, field]));
    // A note this view wrote belongs to a field this view is drawing. A section change, a row the
    // host withdrew and a closed dialog all end one, so the notes are pruned to the live frame
    // rather than left to reappear beside a row they were never about.
    for (const id of [...locals.keys()]) if (!fields.has(id)) locals.delete(id);
    // `visible: false` means present nothing: the dialog is closed, or the bundled panel has it.
    if (!snapshot.visible) { blank(); return; }
    element('root').hidden = false;
    for (const [id, testid] of MARKS) element(id).dataset.testid = testid;

    const items = reconcile(element('rail'), snapshot.sections.map(section => section.id), railItem);
    for (const [index, node] of items.entries()) {
        const section = snapshot.sections[index];
        node.dataset.sectionId = section.id;
        node.dataset.native = String(section.native);
        node.children[0].textContent = GLYPHS[section.icon] ?? '';
        node.children[0].dataset.icon = section.icon;
        node.children[1].textContent = section.title;
        node.setAttribute('aria-current', String(section.id === snapshot.sectionID));
    }

    element('section-title').textContent =
        snapshot.sections.find(section => section.id === snapshot.sectionID)?.title ?? snapshot.sectionID;
    element('dirty').dataset.count = String(snapshot.dirty);
    element('dirty').textContent = snapshot.dirty === 0 ? 'No unsaved edits' : `${snapshot.dirty} unsaved`;

    // Fields name the group they belong to, so a card holds exactly the ones that named it - and
    // anything that named no card in this frame still gets drawn, in one of its own at the end.
    const known = new Set(snapshot.groups.map(group => group.id));
    const orphans = snapshot.fields.filter(field => !known.has(field.groupID));
    const wanted = [
        ...snapshot.groups.map(group => ({
            id: group.id,
            title: group.title,
            detail: group.detail,
            fields: snapshot.fields.filter(field => field.groupID === group.id)
        })),
        ...(orphans.length === 0 ? [] : [{ id: UNGROUPED, title: 'Other', detail: undefined, fields: orphans }])
    ];
    const cards = reconcile(element('panel'), wanted.map(entry => entry.id), card);
    for (const [index, node] of cards.entries()) {
        const entry = wanted[index];
        node.children[0].textContent = entry.title;
        node.children[1].textContent = entry.detail ?? '';
        node.children[1].hidden = entry.detail === undefined;
        const rows = reconcile(node.children[2], entry.fields.map(field => field.id), key => row(fields.get(key)));
        for (const [at, line] of rows.entries()) paintRow(line, entry.fields[at]);
    }

    const note = element('native-note');
    note.hidden = !snapshot.native;
    if (!snapshot.native) { delete note.dataset.testid; return; }
    note.dataset.testid = 'lab-settings-native-note';
    // Both shapes of `native: true`: a section drawn entirely by the host, and a projected one
    // whose hand-built remainder the host draws below these fields.
    note.dataset.native = snapshot.fields.length === 0 ? 'full' : 'remainder';
    note.textContent = snapshot.fields.length === 0
        ? 'The host draws this whole section below.'
        : 'The host draws the rest of this section below.';
}

async function frame(snapshot) {
    lab.frames += 1; lab.snapshot = snapshot;
    if (stalled) return new Promise(() => {});
    if (armed !== null) {
        const mode = armed; armed = null;
        const error = new Error('Settings Lab crashed on purpose.');
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

// The dialog's own Close, which is the only window verb a presenter has. There is no open, and
// Escape is the host's: `PluginView` relays the chord and the slot answers it outside this frame.
element('close').addEventListener('click', () => { void act(() => api.ui.closeSettings()); });

await api.ready;
const stop = api.ui.onSettingsPresentation(frame, failed);
// Once: the page is going away, and a second teardown has nothing left to tear down. A coalescing
// draft is dropped rather than fired into a view that has already stopped listening.
addEventListener('pagehide', () => {
    disposed = true;
    for (const id of [...holds.keys()]) unhold(id);
    stop();
}, { once: true });
