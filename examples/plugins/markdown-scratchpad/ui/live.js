// Live-preview Markdown for CodeMirror. The scratchpad's text stays plain Markdown and this
// styles it where it stands: markers are dimmed rather than hidden, so nothing shifts as the
// caret moves, and only task boxes and bullets are drawn as widgets.
import {
    Decoration, EditorView, HighlightStyle, Language, LanguageSupport, Prec, ViewPlugin, WidgetType,
    deleteMarkupBackward, indentLess, indentMore, indentUnit, insertNewlineContinueMarkup, insertTab,
    keymap, markdownLanguage, syntaxHighlighting, syntaxTree, tags
} from './vendor/codemirror.js';

// GFM (tasks, tables, strikethrough) without indented code: a scratchpad holds pasted logs and
// shell output, and four leading spaces should not paint them as a code block. Sharing
// `markdownLanguage.data` keeps lang-markdown's Enter and Backspace commands active here.
const language = new Language(markdownLanguage.data, markdownLanguage.parser.configure({ remove: ['IndentedCode'] }), [], 'markdown');

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)/;
const TASK_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/;
// A box as people type one: `[]`, `[ ]` or `[x]`, with or without the list marker Markdown
// needs before it.
const LOOSE_TASK = /^(\s*)((?:[-*+]|\d+[.)])\s+)?\[([ xX]?)\](?=\s|$)/;
const BULLETS = ['•', '◦', '▪'];

class CheckboxWidget extends WidgetType {
    constructor(checked) { super(); this.checked = checked; }
    eq(other) { return other.checked === this.checked; }
    toDOM() {
        const box = document.createElement('span');
        box.className = 'cm-md-checkbox';
        box.dataset.checked = String(this.checked);
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', String(this.checked));
        return box;
    }
    // Let the editor see presses on the box, so the handler below can toggle it.
    ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
    constructor(glyph) { super(); this.glyph = glyph; }
    eq(other) { return other.glyph === this.glyph; }
    toDOM() {
        const bullet = document.createElement('span');
        bullet.className = 'cm-md-bullet';
        bullet.textContent = this.glyph;
        return bullet;
    }
}

function listDepth(node) {
    let depth = 0;
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth++;
    }
    return depth;
}

/**
 * The decorations for `[from, to]`: `decorations` for drawing, and `atomic`, the widgets alone,
 * which the caret and Backspace treat as one unit.
 */
export function buildDecorations(state, from, to) {
    const ranges = [], widgets = [];
    // `edged` blocks also mark their first and last lines, for the rounded ends of a code block.
    const lineClass = (node, name, edged = false) => {
        const first = state.doc.lineAt(node.from).number, last = state.doc.lineAt(node.to).number;
        const start = Math.max(first, state.doc.lineAt(from).number), end = Math.min(last, state.doc.lineAt(to).number);
        for (let number = start; number <= end; number++) {
            const edges = !edged ? '' : (number === first ? ` ${name}-first` : '') + (number === last ? ` ${name}-last` : '');
            ranges.push(Decoration.line({ class: name + edges }).range(state.doc.line(number).from));
        }
    };
    const widget = (start, end, value) => {
        const range = Decoration.replace({ widget: value }).range(start, end);
        ranges.push(range); widgets.push(range);
    };
    syntaxTree(state).iterate({
        from, to,
        enter(node) {
            const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
            if (heading) { lineClass(node, `cm-md-heading cm-md-h${heading[1]}`); return; }
            switch (node.name) {
            case 'Blockquote': lineClass(node, 'cm-md-quote'); return;
            case 'FencedCode': lineClass(node, 'cm-md-code', true); return;
            case 'HorizontalRule': lineClass(node, 'cm-md-rule'); return;
            case 'InlineCode': ranges.push(Decoration.mark({ class: 'cm-md-inline-code' }).range(node.from, node.to)); return;
            case 'TaskMarker': {
                const checked = state.sliceDoc(node.from + 1, node.from + 2) !== ' ';
                const item = node.node.parent?.parent;
                const mark = item?.name === 'ListItem' && item.parent?.name === 'BulletList' ? item.getChild('ListMark') : null;
                // A bullet task draws as one box where `- [ ]` was, so it lines up with bullets.
                widget(mark ? mark.from : node.from, node.to, new CheckboxWidget(checked));
                const task = node.node.parent;
                let start = node.to;
                while (task && start < task.to && /\s/.test(state.sliceDoc(start, start + 1))) start++;
                if (checked && task && task.to > start) ranges.push(Decoration.mark({ class: 'cm-md-done' }).range(start, task.to));
                return;
            }
            case 'ListMark': {
                const item = node.node.parent;
                if (item?.parent?.name !== 'BulletList' || item.getChild('Task')) return;
                widget(node.from, node.to, new BulletWidget(BULLETS[Math.min(listDepth(item), BULLETS.length) - 1]));
                return;
            }
            }
        }
    });
    return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(widgets, true) };
}

const livePlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.compute(view); }
    update(update) {
        if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.compute(update.view);
    }
    compute(view) {
        const { decorations, atomic } = buildDecorations(view.state, view.viewport.from, view.viewport.to);
        this.decorations = decorations; this.atomic = atomic;
    }
}, {
    decorations: plugin => plugin.decorations,
    provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.atomic ?? Decoration.none)
});

/** Flip the task box on the line at `pos`; null when that line is not a task. */
export function toggleTaskAt(state, pos) {
    const line = state.doc.lineAt(pos), task = TASK_ITEM.exec(line.text);
    if (!task) return null;
    const at = line.from + task[1].length + 1;
    return { changes: { from: at, to: at + 1, insert: task[2] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' };
}

/** `[]`, `[ ]` or `[x]` as a Markdown task, `- [ ]` or `- [x]`, keeping a list marker it has. */
function looseTask(line) {
    const loose = LOOSE_TASK.exec(line.text);
    if (!loose) return null;
    const [whole, indent, marker, mark] = loose;
    return { from: line.from + indent.length, to: line.from + whole.length, insert: `${marker ?? '- '}[${mark || ' '}]` };
}

/**
 * ⌘↩ over the selected lines. Lines that are not tasks become open tasks (a list item gains a
 * box, a bare `[ ]` gains its `- `, any other line gains `- [ ] `); when every line is already a
 * task, they are all ticked, or all cleared when every one was ticked.
 */
export function toggleTasks(state) {
    const numbers = new Set();
    for (const range of state.selection.ranges) {
        const last = state.doc.lineAt(range.to).number;
        for (let number = state.doc.lineAt(range.from).number; number <= last; number++) numbers.add(number);
    }
    const lines = [...numbers].map(number => {
        const line = state.doc.line(number), task = TASK_ITEM.exec(line.text);
        return { line, task, list: task ? null : LIST_ITEM.exec(line.text) };
    });
    const specs = [];
    if (lines.some(entry => !entry.task)) {
        for (const { line, task, list } of lines) {
            if (task) continue;
            const loose = looseTask(line);
            if (loose) specs.push(loose);
            else if (list) specs.push({ from: line.from + list[0].length, insert: '[ ] ' });
            else specs.push({ from: line.from + /^\s*/.exec(line.text)[0].length, insert: '- [ ] ' });
        }
    } else {
        const tick = lines.some(entry => entry.task[2] === ' ');
        for (const { line, task } of lines) {
            const at = line.from + task[1].length + 1;
            specs.push({ from: at, to: at + 1, insert: tick ? 'x' : ' ' });
        }
    }
    const changes = state.changes(specs);
    // Mapped forward, so a caret on a line that just gained `- [ ] ` ends up after it.
    return { changes, selection: state.selection.map(changes, 1), scrollIntoView: true, userEvent: 'input.toggle' };
}

function selectionTouchesList(state) {
    return state.selection.ranges.some(range => {
        const last = state.doc.lineAt(range.to).number;
        for (let number = state.doc.lineAt(range.from).number; number <= last; number++) {
            if (LIST_ITEM.test(state.doc.line(number).text)) return true;
        }
        return false;
    });
}

/**
 * A space typed after `[]`, `[ ]` or `[x]` at the start of a line makes the line a task, as in
 * most note apps: Markdown draws a box only inside a list item, so the line gains the `- ` it
 * needs. The space lands first, on its own, so ⌘Z takes the line back to the brackets as typed.
 */
export function typeTaskShorthand(view, from, to, text) {
    if (text !== ' ' || from !== to || view.state.selection.ranges.length > 1) return false;
    const line = view.state.doc.lineAt(from), typed = line.text.slice(0, from - line.from);
    const loose = LOOSE_TASK.exec(typed);
    // Only brackets that end at the caret, and not a line that is already a task.
    if (!loose || loose[0].length !== typed.length || (loose[2] && loose[3])) return false;
    const task = looseTask({ from: line.from, text: typed });
    view.dispatch({ changes: { from, insert: ' ' }, selection: { anchor: from + 1 }, scrollIntoView: true, userEvent: 'input.type' });
    view.dispatch({ changes: task, selection: { anchor: task.from + task.insert.length + 1 }, userEvent: 'input.task' });
    return true;
}

const markdownKeys = Prec.high(keymap.of([
    { key: 'Enter', run: insertNewlineContinueMarkup },
    { key: 'Backspace', run: deleteMarkupBackward },
    { key: 'Mod-Enter', run: view => { view.dispatch(toggleTasks(view.state)); return true; } },
    // Tab nests a list item from its line start; anywhere else it types a tab, as the native
    // scratchpad does.
    { key: 'Tab', run: view => selectionTouchesList(view.state) ? indentMore(view) : insertTab(view), shift: indentLess }
]));

const pressCheckbox = EditorView.domEventHandlers({
    mousedown(event, view) {
        const box = event.target instanceof Element ? event.target.closest('.cm-md-checkbox') : null;
        if (!box || event.button !== 0) return false;
        // Leave the caret where it was: ticking a box is not an edit at the click point.
        event.preventDefault();
        const spec = toggleTaskAt(view.state, view.posAtDOM(box));
        if (spec) view.dispatch(spec);
        return true;
    }
});

const highlight = HighlightStyle.define([
    { tag: tags.heading, fontWeight: '700' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, color: 'var(--kelpi-accent, #6f9bd8)' },
    { tag: tags.quote, color: 'var(--kelpi-fg-secondary, #9a9aa0)' },
    { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName, tags.url, tags.comment], color: 'var(--kelpi-fg-tertiary, #6b6b70)' }
]);

const theme = EditorView.theme({
    '&': { height: '100%', color: 'var(--kelpi-fg, #e6e6ea)', backgroundColor: 'transparent', fontSize: '13px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.5', overflow: 'auto' },
    '.cm-content': { padding: '8px 0 32px', caretColor: 'var(--kelpi-fg, #e6e6ea)' },
    '.cm-line': { padding: '0 12px' }
});

/** Everything Markdown-specific: the language, the styling, the widgets and the keys. */
export function livePreview() {
    return [
        new LanguageSupport(language),
        indentUnit.of('\t'),
        EditorView.lineWrapping,
        syntaxHighlighting(highlight),
        livePlugin,
        pressCheckbox,
        EditorView.inputHandler.of(typeTaskShorthand),
        markdownKeys,
        theme
    ];
}
