# Markdown Scratchpad

A Scratchpad renderer that edits Markdown in place, with no separate preview to switch to: the
text stays plain Markdown in the daemon's scratchpad buffer, and the editor styles it where it
stands as you type. Switch one scratchpad to it with the checklist button in its header ("Show
as Markdown"), and back with the same button ("Show as plain text"). To use it for every
scratchpad, choose it under Settings → Plugins → Workbench views (`document.scratchpad`).
Switching back to the native Scratchpad keeps the same text.

What it draws:

- `- [ ] task` as a box you can click to tick (`- [x]`); a ticked task is struck through
- headings larger and bold, `**bold**`, `_italic_`, `~~struck~~`, `` `code` `` and links styled,
  with their markers dimmed rather than hidden, so nothing shifts as the caret moves
- bullets as `•` `◦` `▪` by depth, fenced code blocks on a tinted ground, quotes with a bar

Keys:

| Key | Does |
| --- | --- |
| Space after `[]`, `[ ]` or `[x]` at a line start | Makes the line a task: Markdown draws a box only in a list item, so `- ` is added (⌘Z puts the brackets back) |
| Return | Continues a list or task list; on an empty item, ends the list |
| ⌘Return | Turns the selected lines into tasks (a bare `[ ]` gains its `- `), or ticks them (clears them when all are ticked) |
| Tab / ⇧Tab | Indents or outdents list items; elsewhere Tab types a tab, as the native scratchpad does |
| ⌘Z / ⇧⌘Z | Undo and redo, including ticking a box |

Indented text is never read as a code block, so pasted logs and shell output stay as they are.
Raw HTML in the text is shown as text, never rendered.

The editor is [CodeMirror 6](https://codemirror.net), vendored as one prebuilt module in
`ui/vendor` (see its README for versions and the rebuild recipe). The view has no backend.

## How it saves

Edits go through the shared document API the way [Document Lab](../document-lab) does: every input
is staged in the host window, then written against the last acknowledged revision, newest input
only. A revision moved by autosave alone is retried once. If another window, a phone or the CLI
changed the text first, editing stops with a message, the host keeps your text as a recovery draft
(Review / Restore / Discard above the pane), and **Load latest text** takes the daemon's copy.
Text changed elsewhere while this view has nothing unsaved is applied in place, so the caret stays
where it was. The caret and scroll position are kept in the view's state, so a workspace switch
comes back to the same place.

## Differences from the native Scratchpad

- ⌘F does not search it: the find chord is Kelpi's, and document views do not receive it.
- Lines always soft-wrap, and there is no line-number gutter. The header's wrap toggle has no
  effect on this view.
- Copy-on-select and middle-click paste are Kelpi features of its own editors and terminals, so
  they do not apply inside this view. ⌘C, ⌘X and ⌘V work as usual.
- One edit is limited to the plugin bridge's 192 KiB. A larger scratchpad shows an error here;
  the native renderer still edits it.

## Try it

From the checkout root, against a private instance (`node scripts/dev-instance.mjs`) and its
`kelpi_test` helper from the [development guide](../../../docs/plugin-development.md):

~~~sh
kelpi_test plugin install examples/plugins/markdown-scratchpad --trust
~~~

Open a scratchpad (⇧⌘N) and press the checklist button in its header. The installed copy does
not follow edits to this directory; install again, or run `kelpi_test plugin dev
examples/plugins/markdown-scratchpad --trust` while working on it.

`packages/client/src/plugins/markdown-scratchpad.test.ts` loads the shipped modules unchanged
and covers the decorations, the task commands and the save rules.
