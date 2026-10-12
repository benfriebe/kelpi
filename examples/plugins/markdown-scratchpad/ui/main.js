// A scratchpad renderer that edits Markdown in place: one editor, no preview to switch to.
import { Annotation, Compartment, EditorSelection, EditorState, EditorView, Transaction, defaultKeymap, history, historyKeymap, keymap } from './vendor/codemirror.js';
import { livePreview } from './live.js';
import { createDocumentSync, textChange } from './sync.js';

const api = globalThis.kelpi;
const $ = id => document.getElementById(id);
const fromDaemon = Annotation.define();
const access = new Compartment();
let view = null;

const editable = on => [EditorView.editable.of(on), EditorState.readOnly.of(!on)];

function showProblem(message, conflict) {
    $('problem').hidden = message === null;
    $('problem-text').textContent = message ?? '';
    $('reload').hidden = !conflict;
    document.body.dataset.problem = message ?? '';
    view?.dispatch({ effects: access.reconfigure(editable(!sync.blocked)) });
}

const sync = createDocumentSync(api, {
    onText(text) {
        if (!view) return;
        const change = textChange(view.state.doc.toString(), text);
        // Another writer's text, applied as a change so the caret keeps its place. It is not
        // this view's edit, so it stays out of undo and is not written back.
        if (change) view.dispatch({ changes: change, annotations: [fromDaemon.of(true), Transaction.addToHistory.of(false)] });
    },
    onProblem: (message, { conflict }) => showProblem(message, conflict),
    onClosed: () => showProblem('This scratchpad was closed.', false)
});

// Light or dark scrollbars and form controls, following Kelpi's theme rather than the OS.
function applyColorScheme() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--kelpi-bg').trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
    if (!hex) return;
    const [r, g, b] = [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);
    document.documentElement.style.colorScheme = 0.299 * r + 0.587 * g + 0.114 * b < 0.5 ? 'dark' : 'light';
}

// The caret and scroll position, so a workspace switch (which remounts this view) comes back
// to the same place.
let saveTimer = 0;
function saveViewState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        if (!view) return;
        const { anchor, head } = view.state.selection.main;
        void api.setState({ anchor, head, scrollTop: Math.round(view.scrollDOM.scrollTop) }).catch(() => {});
    }, 800);
}
function savedSelection(length) {
    const { anchor, head } = api.state ?? {};
    if (!Number.isInteger(anchor) || !Number.isInteger(head)) return undefined;
    return EditorSelection.single(Math.min(anchor, length), Math.min(head, length));
}

// Kelpi focuses this frame when the pane gains focus; hand that to the editor. A press inside
// the editor focuses it on its own, so only an unclaimed frame focus is passed on. Focusing
// the editor unasked would pull pane focus here, so nothing else does.
addEventListener('focus', () => setTimeout(() => { if (view && !view.hasFocus) view.focus(); }));
addEventListener('pagehide', () => sync.stop(), { once: true });

try {
    await api.ready;
    applyColorScheme();
    api.onContext(applyColorScheme);
    const initial = await sync.start();
    view = new EditorView({
        parent: $('editor'),
        state: EditorState.create({
            doc: initial.text,
            selection: savedSelection(initial.text.length),
            extensions: [
                history(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                livePreview(),
                access.of(editable(!sync.blocked)),
                EditorView.contentAttributes.of({ 'aria-label': 'Scratchpad', spellcheck: 'false' }),
                EditorView.updateListener.of(update => {
                    if (update.docChanged && !update.transactions.some(tr => tr.annotation(fromDaemon))) sync.edit(update.state.doc.toString());
                    if (update.docChanged || update.selectionSet) saveViewState();
                })
            ]
        })
    });
    view.scrollDOM.addEventListener('scroll', saveViewState, { passive: true });
    const scrollTop = api.state?.scrollTop;
    if (Number.isFinite(scrollTop)) requestAnimationFrame(() => { view.scrollDOM.scrollTop = scrollTop; });
    if (document.hasFocus()) view.focus();
    document.body.dataset.ready = 'true';
} catch (error) {
    showProblem(error?.message ?? String(error), false);
}

$('reload').addEventListener('click', () => { void sync.reload().catch(error => showProblem(error?.message ?? String(error), true)); });
