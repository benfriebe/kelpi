// A complete browser-only renderer: no host DOM, native imports, filesystem or backend.
const api = globalThis.kelpi;
const $ = id => document.getElementById(id);
const editor = $('editor');
let state, subscription, reading = false, reread = false, stopped = false;
let inputs = 0, accepted = 0, queued = null, writing = false, blocked = false, writeRevision;
let wrapping = true;

function problem(error) {
    $('problem').hidden = !error;
    $('problem').textContent = error?.message ?? error ?? '';
    document.body.dataset.error = $('problem').textContent;
}
function preview(text, kind) {
    const target = $('preview'); target.replaceChildren();
    if (kind === 'diff') {
        const lines = document.createElement('div'); lines.className = 'diff';
        for (const line of text.split('\n')) {
            const row = document.createElement('div'); row.textContent = line;
            row.className = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : '';
            lines.append(row);
        }
        target.append(lines); return;
    }
    // Intentionally small Markdown preview. Source is always textContent, never executable HTML.
    let code = null;
    for (const line of text.split('\n')) {
        if (line.startsWith('```')) {
            if (code) code = null; else { code = document.createElement('pre'); target.append(code); }
        } else if (code) code.textContent += `${line}\n`;
        else {
            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            const row = document.createElement(heading ? `h${heading[1].length}` : 'p');
            row.textContent = heading ? heading[2] : line; target.append(row);
        }
    }
}
function render() {
    if (!state) return;
    const pending = inputs !== accepted || writing;
    const editable = state.kind !== 'diff' && (state.kind === 'scratchpad' || state.mode === 'edit');
    document.body.dataset.kind = state.kind;
    document.body.dataset.pane = state.paneID;
    document.body.dataset.pending = String(pending);
    $('title').textContent = state.path?.split('/').pop() ?? (state.kind === 'diff' ? 'Git diff' : 'Scratchpad');
    $('kind').textContent = state.kind;
    $('identity').textContent = state.paneID.slice(0, 8);
    $('mode').hidden = state.kind !== 'markdown';
    $('mode').textContent = state.mode === 'edit' ? 'Preview' : 'Edit';
    $('mode').disabled = pending || blocked;
    $('save').disabled = !editable || pending || blocked || !state.loaded;
    $('refresh').disabled = pending || blocked || state.dirty;
    $('recovery').hidden = !blocked;
    editor.hidden = !editable; editor.readOnly = !state.loaded || blocked;
    $('preview').hidden = editable;
    if (!pending && !blocked) editor.value = state.text;
    if (!editable) preview(state.text, state.kind);
    $('status').textContent = blocked ? 'Local edits need review' : pending ? 'Sending edits…' : state.error ? 'Save failed' : state.dirty ? 'Unsaved changes' : 'Saved';
    if (state.error) problem(state.error);
}
function receive(next) {
    state = next;
    // A remote invalidation must never rebase text which this view has not applied yet.
    if (inputs === accepted && !writing && !blocked) writeRevision = next.revision;
    render();
}
async function readLatest() {
    reread = true; if (reading) return;
    reading = true;
    try { do { reread = false; const next = await api.documents.get(); if (!stopped) receive(next); } while (reread && !stopped); }
    catch (error) { if (!stopped) problem(error); }
    finally { reading = false; }
}
async function pump() {
    if (writing || blocked || stopped) return;
    writing = true;
    try {
        while (queued && !blocked && !stopped) {
            const edit = queued; queued = null;
            try {
                const next = await api.documents.applyDraft(edit.id, writeRevision);
                if (next.text !== edit.text) throw new Error('The document changed before this edit was acknowledged. Review the preserved draft.');
                writeRevision = next.revision; state = next; accepted = edit.number;
            } catch (error) {
                if (error.code !== 'DOCUMENT_DRAFT_SUPERSEDED') { blocked = true; problem(error); }
            }
        }
    } finally { writing = false; render(); }
}
editor.addEventListener('input', () => {
    const number = ++inputs, text = editor.value;
    // Every input crosses the host bridge immediately. Only daemon writes are serialized.
    void api.documents.stage(text, writeRevision).then(draft => {
        if (number !== inputs || stopped) return;
        queued = { id: draft.id, text, number }; void pump();
    }).catch(error => { blocked = true; problem(error); render(); });
    render();
});
async function action(invoke) {
    try { problem(null); receive(await invoke()); } catch (error) { problem(error); }
}
$('save').onclick = () => void action(() => api.documents.save(state.paneID, state.revision));
$('mode').onclick = () => void action(() => api.documents.setMode(state.paneID, state.mode === 'edit' ? 'view' : 'edit', state.revision));
$('refresh').onclick = () => void action(() => api.documents.refresh(state.paneID, state.revision));
$('reload').onclick = async () => {
    try {
        const next = await api.documents.get();
        // Explicit user choice: load daemon text while the host keeps the conflicting draft.
        queued = null; inputs = accepted = 0; blocked = false; problem(null); receive(next);
    } catch (error) { problem(error); }
};
$('wrap').onclick = () => {
    wrapping = !wrapping; editor.style.whiteSpace = wrapping ? 'pre-wrap' : 'pre';
    document.body.dataset.wrap = String(wrapping);
    $('wrap').setAttribute('aria-pressed', String(wrapping));
    void api.setState({ wrap: wrapping }).catch(problem);
};
const stopChanged = api.events.on('documents.changed', event => { if (event.data.subscription === subscription) return readLatest(); });
const stopClosed = api.events.on('documents.closed', event => { if (event.data.subscription === subscription) { stopped = true; editor.readOnly = true; problem('This document was closed.'); } });
addEventListener('pagehide', () => {
    stopped = true; stopChanged(); stopClosed();
    if (subscription) void api.documents.unwatch(subscription).catch(() => {});
}, { once: true });
try {
    await api.ready;
    wrapping = api.state.wrap !== false; editor.style.whiteSpace = wrapping ? 'pre-wrap' : 'pre';
    document.body.dataset.wrap = String(wrapping);
    $('wrap').setAttribute('aria-pressed', String(wrapping));
    const watched = await api.documents.watch(); subscription = watched.subscription; receive(watched.state);
    document.body.dataset.ready = 'true';
} catch (error) { problem(error); }
