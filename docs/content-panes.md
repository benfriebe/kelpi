# Content Panes: Markdown, Diff, Scratchpad

Behavioral specification of Kelpi's non-terminal "content" panes — markdown preview/edit
panes, git-diff panes, and scratchpad panes — plus the supporting services
(`EditorService`, the per-pane file watcher, find-in-page, scroll preservation, and the
copy pipeline). Written for the TypeScript port (headless daemon + web client); no Swift
knowledge is assumed. Where behavior is macOS-app-specific, the *user-visible* behavior
is described so it can be re-created in the web UI.

Source files this spec was derived from (Swift, in `/Users/ben/code/kelpi`):

- `Nex/Features/MarkdownPane/MarkdownHTMLRenderer.swift` — markdown → HTML + CSS
- `Nex/Features/MarkdownPane/MarkdownFrontMatter.swift` — front-matter extraction + rendering
- `Nex/Features/MarkdownPane/MarkdownCodeCopyScript.swift` — code-block copy button JS
- `Nex/Features/MarkdownPane/MarkdownFindScript.swift` — find-in-page JS
- `Nex/Features/MarkdownPane/MarkdownFindController.swift` — find routing/reapply
- `Nex/Features/MarkdownPane/MarkdownPaneView.swift` — preview host, file watching, copy actions
- `Nex/Features/MarkdownPane/MarkdownEditorView.swift` — built-in plain-text editor
- `Nex/Features/MarkdownPane/LineNumberRulerView.swift` — editor line-number gutter
- `Nex/Features/DiffPane/DiffHTMLRenderer.swift` — git diff → HTML + CSS
- `Nex/Features/DiffPane/DiffPaneView.swift` — diff host, refresh semantics
- `Nex/Features/ScratchpadPane/ScratchpadEditorView.swift` — scratchpad editor
- `Nex/Services/EditorService.swift` — $VISUAL/$EDITOR resolution for external edit mode
- `Nex/Services/RecursiveFSWatcher.swift` — recursive FSEvents watcher (used by Graft, spec'd here for completeness)
- Plus the surrounding wiring in `WorkspaceFeature.swift`, `PaneGridView.swift`,
  `PaneHeaderView.swift`, `Pane.swift`, `PaneType.swift`, `GitService.swift`,
  `PaneFocusView.swift`, `KeyBinding.swift`, `NexCommands.swift`.

---

## 1. Data model

### 1.1 Pane fields relevant to content panes

```ts
type PaneType = "shell" | "markdown" | "scratchpad" | "diff" | "web";

interface Pane {
  id: string;                       // UUID
  label?: string;                   // user tag; markdown/diff panes get one at creation
  type: PaneType;
  title?: string;
  workingDirectory: string;         // markdown: file's parent dir; diff: repo path
  gitBranch?: string;               // detected async at open time
  filePath?: string;                // markdown: absolute file path; diff: optional scope path
  isEditing: boolean;               // markdown: view vs edit mode; scratchpad: always true
  externalEditorCommand?: string;   // TRANSIENT (not persisted). Non-null on a markdown
                                    // pane in edit mode means "edit in a terminal surface
                                    // running the user's $EDITOR" instead of the built-in
                                    // editor.
  scratchpadContent?: string;       // scratchpad text; persisted to DB, never to disk
  markdownFontSize: number;         // px, default 14; per-pane, IN-MEMORY only for live
                                    // panes but captured into closed-pane snapshots
  parkedSourcePaneID?: string;      // TRANSIENT. Set on a markdown/diff pane opened via
                                    // `--here`; points at the parked source terminal pane
  createdAt: Date;
  lastActivityAt: Date;
  // ... agent/status fields belong to the agent subsystem
}

const DEFAULT_MARKDOWN_FONT_SIZE = 14;  // Pane.defaultMarkdownFontSize
```

### 1.2 Persistence (SQLite `pane` table)

Content-pane relevant columns of `PaneRecord`:

- `filePath` (nullable text) — markdown file path / diff scope path.
- `content` (nullable text) — scratchpad content. This is the ONLY place scratchpad
  text lives; it is never written to any file.
- `type` — the `PaneType` raw string.

NOT persisted: `isEditing` (recomputed at load: `isEditing = (type == "scratchpad")` —
markdown panes always restore in view mode, scratchpads always restore in edit mode),
`externalEditorCommand`, `markdownFontSize` (restores to default 14 on app relaunch),
`parkedSourcePaneID`, scroll positions.

### 1.3 Closed-pane snapshots (⌘⇧T reopen)

When any pane closes, a snapshot is pushed to a per-workspace ring buffer
(max 10, oldest evicted):

```ts
interface ClosedPaneSnapshot {
  workingDirectory: string;
  label?: string;
  type: PaneType;
  filePath?: string;
  scratchpadContent?: string;
  agentSessionID?: string;
  agentKind?: "claude" | "codex";
  markdownFontSize: number;      // font size DOES survive close→reopen (unlike restart)
  webState?: unknown;            // web pane sidecar; irrelevant here
}
```

`reopenClosedPane` pops the newest snapshot, mints a new pane id, splits the focused
pane horizontally, and recreates the pane with
`isEditing = (type == "scratchpad")`. Markdown/scratchpad/diff/web reopens create no
PTY; only shell reopens spawn a surface (and possibly resume an agent session).

---

## 2. Opening content panes (entry points and placement)

### 2.1 Markdown pane — `openMarkdownFile(filePath, reusePaneID?)`

Entry points (all converge on this one action):

1. **⌘O** file picker (filtered to `.md`) and **drag-and-drop** of a `.md` file onto the
   window → app-level `openFileAtPath(path, fromPaneID?)`:
   - If no workspace is loaded yet (cold launch race), the path is queued in
     `pendingFileOpens` and drained once state loads. The queue is transient.
   - Relative paths are resolved against the originating pane's cwd (or the focused
     pane's cwd) before dispatch.
2. **Finder "Open With → Kelpi"** → same `openFileAtPath` path.
3. **CLI**: `kelpi md [--here] <file>` and the markdown route of `kelpi open [--here] <path>`
   send the `open` wire command
   `{"command":"open","path":"/abs/file.md","pane_id":"<uuid or absent>","reuse":true|false}`.
   Server side: if `pane_id` resolves to a live pane, that pane's workspace is targeted,
   the calling pane is focused first, and `reusePaneID = pane_id` when `reuse` is true;
   otherwise the active workspace is targeted with no reuse.

Behavior of `openMarkdownFile`:

```
newPaneID = uuid()
dir      = dirname(filePath)
fileName = basename(filePath)
newPane  = { id: newPaneID, label: fileName, type: "markdown", title: fileName,
             workingDirectory: dir, filePath, isEditing: false,
             markdownFontSize: 14 }

async: branch = gitService.getCurrentBranch(dir)   // errors → undefined
       dispatch paneBranchChanged(newPaneID, branch)  // shows in pane header

if reusePaneID and that pane exists:            // `--here`
    // Park the originating pane: its PTY stays alive off-layout.
    dismiss search overlay if it was on reusePaneID
    if a zoom is active, restore savedLayout and clear zoom
    newPane.parkedSourcePaneID = reusePaneID
    layout = layout.replacing(leaf reusePaneID -> leaf newPaneID)
    remove old pane from panes; append it to parkedPanes; append newPane
    focus newPaneID
else:
    // Split the focused pane horizontally. If focus is unset, fall back to ANY
    // existing pane in the layout (protects restored workspaces from being
    // clobbered by a cold-launch queued open); only a genuinely empty layout
    // becomes a single leaf.
    sourceID = focusedPaneID ?? layout.allPaneIDs.first
    if sourceID: layout = layout.splitting(sourceID, horizontal, newPaneID)
    else:        layout = leaf(newPaneID)
    append newPane; focus newPaneID
```

Note: the non-reuse markdown path does NOT restore a zoomed layout first (diff and
scratchpad do). Minor asymmetry in the source; harmless to normalize in the port.

### 2.2 Diff pane — `openDiffPane(repoPath, targetPath?, reusePaneID?)`

Entry points:

1. **CLI**: `kelpi diff [<path>]` — repoPath = CLI cwd, targetPath = optional scope.
   Wire: `{"command":"diff","repo_path":"...","target_path":"...?" ,"pane_id":"...?"}`.
2. **Keybinding** `open_diff` (default unbound) — opens a diff for the focused pane's
   repo context.
3. **GUI**: "plusminus" button next to a repo association in the workspace inspector.

Behavior mirrors `openMarkdownFile` with these differences:

```
scopeName = targetPath ? basename(targetPath) : basename(repoPath)
newPane = { label: scopeName, type: "diff", title: `diff: ${scopeName}`,
            workingDirectory: repoPath, filePath: targetPath }
```

- Same `--here` park/replace branch (identical to markdown).
- Non-reuse branch: splits the focused pane horizontally **after restoring any zoomed
  layout**; if no focused pane, layout becomes a single leaf.
- Same async git-branch detection, run against `repoPath`.

### 2.3 Scratchpad — `createScratchpad`

Entry: keybinding `create_scratchpad` (default **⌘⇧N**) or command palette.

```
newPane = { type: "scratchpad", title: "Scratchpad", isEditing: true,
            workingDirectory: <home dir>, scratchpadContent: undefined }
```

Placement: restore zoom if active, split focused pane horizontally (or become sole
leaf), focus the new pane. No label, no git branch detection, no file.

### 2.4 Closing content panes

`closePane(paneID)` specifics for content panes:

- **Unpark** (`--here` restore): if the closing pane has `parkedSourcePaneID` and that
  pane is still in the parked lane, the parked terminal is restored *in place of* the
  closing pane (layout leaf replaced back, focus set to the restored pane, both ids
  scrubbed from focus history). The markdown pane's own surface — which exists only if
  it entered external-editor mode — is destroyed. No closed-pane snapshot is taken on
  this path.
- Otherwise: snapshot to `recentlyClosedPanes` (see 1.3), remove from layout/panes.
  A markdown pane in external-editor mode has a backing terminal surface that must be
  destroyed on close (otherwise the PTY + editor process leak).
- If a **parked** pane's process dies (SIGHUP etc.), it is evicted from the parked lane
  and every live pane whose `parkedSourcePaneID` pointed at it gets that field nulled —
  closing such a markdown pane then takes the normal close path.
- **External editor exit**: when the shell process backing a markdown pane's
  external-editor surface terminates (user quits vim), the pane does NOT close; it
  flips back to view mode (`isEditing = false`, `externalEditorCommand = null`) and the
  surface is destroyed. The file watcher then reloads any on-disk changes.

---

## 3. Markdown render pipeline

### 3.1 Overview

```
file bytes (UTF-8)
  → FrontMatterExtractor.extract  → (yaml | null, body)
  → parse body as GitHub-flavored markdown (swift-markdown; port: any CommonMark+GFM
    parser with tables, strikethrough, task lists)
  → MarkdownHTMLRenderer (AST → HTML string)
  → fmHTML = yaml ? FrontMatterRenderer.render(yaml) : ""
  → full HTML document: doctype + <html class="dark|light"> + inline <style> + body =
      <div id="content"> fmHTML + bodyHTML </div>
```

Inputs to the document wrapper:

- `backgroundColor` — the ghostty terminal background color (from the user's ghostty
  config). Used ONLY to pick the light/dark theme; the page background itself is
  **transparent** (see 3.8).
- `backgroundOpacity` — accepted but currently unused inside the renderer (the pane
  container applies it; see 3.8).
- `baseFontSize` — `pane.markdownFontSize` (default 14).

Dark-mode detection (shared by markdown, diff, and the plain-text editors):

```
luminance = 0.299*r + 0.587*g + 0.114*b     // components in 0..1, sRGB
isDark = luminance < 0.5
```

`<html>` gets class `dark` or `light`; all dark styles are `.dark`-prefixed selectors.

### 3.2 HTML escaping

Everywhere: `& → &amp;`, `< → &lt;`, `> → &gt;`, `" → &quot;` (in that order).
Applied to text nodes, code contents, attribute values (link/image destinations and
titles), diff lines, and front-matter keys/values.

### 3.3 Element-by-element output contract

| Markdown node | HTML emitted |
|---|---|
| Document | children concatenated |
| Heading level n | `<hN>…</hN>\n` |
| Paragraph | `<p>…</p>\n` |
| Text | autolinked + escaped (see 3.4) |
| Emphasis | `<em>…</em>` |
| Strong | `<strong>…</strong>` |
| Strikethrough (GFM) | `<del>…</del>` |
| Inline code | `<code>ESCAPED</code>` |
| Code block (fenced/indented) | `<div class="code-block"><pre><code class="language-LANG"?>ESCAPED</code></pre><button class="code-copy-btn" type="button" aria-label="Copy code"></button></div>\n` — the `class="language-…"` attribute is omitted when the fence has no info string; the language string itself is HTML-escaped |
| Unordered list | `<ul>\nITEMS</ul>\n` |
| Ordered list | `<ol start="N"?>\nITEMS</ol>\n` — `start` attribute only when start ≠ 1 |
| List item (plain) | `<li>…</li>\n` |
| Task-list item | `<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked? disabled> CONTENT</li>\n` — `checked` present iff `[x]`; always `disabled` (checkboxes are read-only in the preview) |
| Link | `<a href="ESCAPED_DEST">CONTENT</a>` — missing destination renders `href=""`; autolinking is suppressed inside link children |
| Image | `<img src="ESCAPED_SRC" alt="RENDERED_CHILDREN" title="ESCAPED"?>` — autolinking suppressed inside alt children |
| Blockquote | `<blockquote>\n…</blockquote>\n` |
| Thematic break | `<hr>\n` |
| Soft break | `\n` |
| Hard line break | `<br>\n` |
| HTML block / inline HTML | **passed through raw, unescaped** |
| Table (GFM) | `<table>\n<thead>\n<tr><th>…</th>…</tr>\n</thead>\n<tbody>\n<tr><td>…</td>…</tr>\n…</tbody>\n</table>\n` — header cells are `<th>`, body cells `<td>`; no alignment attributes are emitted |
| Any other node | children concatenated (default visit) |

Raw HTML passthrough is intentional (matches GitHub-ish behavior). The preview runs in
an isolated webview in the current app; in the web-client port, consider the security
implications (see Port notes).

### 3.4 Bare-URL autolinking

swift-markdown only links `<>`-wrapped URLs and `[text](url)`. Plain-text nodes are
additionally scanned for URLs (macOS `NSDataDetector` link detection; port: a URL
regex/linkifier) with these rules:

- Only matches whose **source text starts with** one of
  `http://`, `https://`, `ftp://`, `file://`, `mailto:` (case-insensitive prefix
  check) become links. Schemeless domains (`example.com`) and bare emails
  (`foo@example.com`) are deliberately left as plain text — this is "terminal-style
  pasted-URL clickability", not GitHub fuzzy linkification.
- Output per match: `<a href="ESCAPED_CANONICAL_URL">ESCAPED_SOURCE_TEXT</a>` — the
  href is the detector's canonicalized URL when available, else the matched text;
  surrounding text is escaped normally.
- Autolinking is disabled inside explicit links and image alt text (a depth counter
  is incremented around their children) — text there is escape-only.

### 3.5 Front-matter extraction

`FrontMatterExtractor.extract(markdown) → { yaml: string | null, body: string }`.

Rules:

1. Strip a single leading BOM (`﻿`) before any checks.
2. **Opening fence**: the very first line must be `---` optionally followed by only
   spaces/tabs. Anything else (including leading whitespace before `---`) → no
   front-matter; return `(null, original markdown)`.
3. Line terminators: `\n`, `\r\n`, or `\r` all count.
4. Scan subsequent lines for a **closing fence**: a line that is `---` or `...` at
   column 0, optionally followed by only spaces/tabs.
5. **64 KiB guard**: while scanning, accumulate the UTF-8 byte length of each YAML
   line + 1 (for its newline). If the running total exceeds `64 * 1024` **before** a
   closing fence is found, bail: no front-matter, whole input is the body. This guards
   against YAML bombs / pathological files before the YAML text is even materialized.
6. On success:
   - `yaml` = the text between fences, with exactly one trailing newline grapheme
     removed (`\n` / `\r\n` / `\r`).
   - `body` = everything after the closing fence's newline (empty string if the fence
     was the last line).
7. If EOF is reached with no closing fence → no front-matter.

Empty front-matter (`---\n---\n`) yields `yaml = ""` which renders to nothing (see
below), and the body excludes both fences.

### 3.6 Front-matter rendering

`FrontMatterRenderer.render(yaml) → html` (prepended before the markdown body inside
`#content`):

- If `yaml.trim() === ""` → return `""` (nothing rendered).
- Parse the YAML (Yams compose; port: a YAML lib that exposes node types + can
  round-trip serialize a node). On **parse error** or when the **root is not a
  mapping** → raw fallback:
  `<pre class="frontmatter-raw">ESCAPED_RAW_YAML</pre>\n`
- If the root mapping is empty → `""`.
- Otherwise emit a two-column table, one row per top-level key in document order:

```html
<table class="frontmatter">
<tbody>
<tr><th scope="row">KEY</th><td>VALUE</td></tr>
...
</tbody>
</table>
```

Key text: the scalar string of the key node (non-scalar keys stringify however the
YAML lib describes them), HTML-escaped.

Value rendering (`renderValue(node)`):

- **Scalar**: if the scalar string contains `\n` (block `|`, folded `>`, or any
  multi-line value) → nested pre (below); else escaped inline text.
- **Sequence**: if EVERY child is a single-line scalar → children escaped and joined
  with `", "`. Otherwise → nested pre.
- **Mapping** (nested object) → nested pre.
- **Alias** → escaped literal `*anchorName` (the YAML source form).

Nested pre: re-serialize the node back to YAML text, trim surrounding whitespace,
escape, and emit `<pre class="frontmatter-nested">…</pre>` (no trailing newline).

### 3.7 Full document wrapper

```html
<!DOCTYPE html>
<html class="dark">            <!-- or "light" -->
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style> …inline CSS… </style>
</head>
<body>
<div id="content">
FRONTMATTER_HTML + BODY_HTML
</div>
</body>
</html>
```

### 3.8 Background and theme integration

- The document CSS sets `background-color: transparent;` on `body`. The webview itself
  is rendered non-opaque. The **pane container** behind the webview paints the ghostty
  terminal background color at the ghostty background opacity
  (`Color(ghosttyConfig.backgroundColor).opacity(ghosttyConfig.backgroundOpacity)`).
  This makes markdown/diff/scratchpad/web panes visually identical to terminal panes,
  including going fully transparent at 0% opacity, without double-painting.
- The background color still selects the light/dark text theme (luminance rule, 3.1).
- When the ghostty config background color/opacity changes at runtime (theme change),
  the currently loaded content is **re-rendered** (HTML regenerated with the new
  `isDark` class) without re-reading the file, and the container fill updates.

### 3.9 Markdown stylesheet (the exact CSS contract)

The full inline stylesheet, with `BASE` = baseFontSize px and
`CODE = max(BASE - 1, 6)` px. Reproduce faithfully (colors are GitHub-derived):

```css
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: BASEpx;
    line-height: 1.6;
    padding: 20px 28px;
    margin: 0;
    color: #1f2328;
    background-color: transparent;
}
.dark body { color: #e6edf3; }
/* Thin scrollbar matching the sidebar's overlay scroller. */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.4); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.6); }
::-webkit-scrollbar-corner { background: transparent; }
h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; }
h1 { font-size: 2em; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
.dark h1, .dark h2 { border-bottom-color: #3d444d; }
p { margin: 0.5em 0 1em; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
.dark a { color: #58a6ff; }
pre {
    background: #f6f8fa;
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: CODEpx;
    line-height: 1.45;
}
.dark pre { background: #161b22; }
code {
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
}
:not(pre) > code { background: #eff1f3; padding: 2px 6px; border-radius: 4px; }
.dark :not(pre) > code { background: #262c36; }
blockquote {
    border-left: 4px solid #d1d9e0;
    padding: 0 16px;
    color: #656d76;
    margin: 0.5em 0 1em;
}
.dark blockquote { border-left-color: #3d444d; color: #9198a1; }
table { border-collapse: collapse; width: 100%; margin: 0.5em 0 1em; }
th, td { border: 1px solid #d1d9e0; padding: 8px 12px; text-align: left; }
th { font-weight: 600; background: #f6f8fa; }
.dark th, .dark td { border-color: #3d444d; }
.dark th { background: #161b22; }
ul, ol { padding-left: 2em; margin: 0.5em 0; }
li { margin: 0.25em 0; }
li.task-list-item { list-style-type: none; }
/* -1.4em pulls the checkbox into the bullet column. Assumes ul/ol padding-left: 2em.
   Native disabled checkboxes render very faintly, so a GitHub-style box is drawn. */
li.task-list-item > input.task-list-item-checkbox {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border: 1.5px solid #8c959f;
    border-radius: 3px;
    background: transparent;
    margin: 0 0.4em 0.15em -1.4em;
    vertical-align: middle;
    cursor: default;
}
.dark li.task-list-item > input.task-list-item-checkbox { border-color: #7d8590; }
li.task-list-item > input.task-list-item-checkbox:checked {
    background-color: #1f6feb;
    border-color: #1f6feb;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8l3 3 7-7' stroke='white' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 12px 12px;
}
/* Inline the leading paragraph so it sits beside the checkbox. */
li.task-list-item > p:first-of-type { display: inline; }
hr { border: none; border-top: 1px solid #d1d9e0; margin: 2em 0; }
.dark hr { border-top-color: #3d444d; }
img { max-width: 100%; border-radius: 4px; }
del { color: #656d76; }
.dark del { color: #9198a1; }
table.frontmatter {
    margin: 0 0 1.5em;
    border: 1px solid #d1d9e0;
    border-radius: 6px;
    border-collapse: separate;
    border-spacing: 0;
    width: auto;
    min-width: 40%;
    max-width: 100%;
    font-size: 0.9em;
    overflow: hidden;
}
.dark table.frontmatter { border-color: #3d444d; }
table.frontmatter th, table.frontmatter td {
    border: none;
    border-bottom: 1px solid #d1d9e0;
    padding: 6px 12px;
    text-align: start;
    vertical-align: top;
}
.dark table.frontmatter th, .dark table.frontmatter td { border-bottom-color: #3d444d; }
table.frontmatter tr:last-child th, table.frontmatter tr:last-child td { border-bottom: none; }
table.frontmatter th {
    font-weight: 600;
    color: #656d76;
    background: #f6f8fa;
    white-space: nowrap;
    width: 1%;
}
.dark table.frontmatter th { background: #161b22; color: #9198a1; }
table.frontmatter td {
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.95em;
    word-break: break-word;
}
pre.frontmatter-raw, pre.frontmatter-nested {
    margin: 0;
    padding: 8px 10px;
    background: transparent;
    border: none;
    font-size: 0.85em;
    white-space: pre-wrap;
}
pre.frontmatter-raw { border-left: 3px solid #d1d9e0; padding-left: 10px; margin: 0 0 1.5em; }
.dark pre.frontmatter-raw { border-left-color: #3d444d; }
.code-block { position: relative; }
/* Margin on the wrapper, not the <pre>, so stacking matches a bare <pre>. */
.code-block > pre { margin: 0; }
.code-block { margin: 1em 0; }
.code-copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 28px;
    height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid #d1d9e0;
    border-radius: 4px;
    color: #1f2328;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, color 0.15s ease;
}
.code-block:hover .code-copy-btn,
.code-block:focus-within .code-copy-btn,
.code-copy-btn:focus { opacity: 1; }
.code-copy-btn:focus-visible { outline: 2px solid #0969da; outline-offset: 1px; }
.code-copy-btn:hover { background: #f6f8fa; }
.code-copy-btn.copied { color: #1a7f37; }
.dark .code-copy-btn { background: rgba(22, 27, 34, 0.85); border-color: #3d444d; color: #e6edf3; }
.dark .code-copy-btn:hover { background: #21262d; }
.dark .code-copy-btn.copied { color: #3fb950; }
.dark .code-copy-btn:focus-visible { outline-color: #58a6ff; }
/* Icon via mask so it inherits currentColor (grey normally, green when .copied). */
.code-copy-btn::before {
    content: "";
    display: block;
    width: 14px;
    height: 14px;
    background-color: currentColor;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: 14px 14px;
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z'/%3E%3Cpath d='M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z'/%3E%3C/svg%3E");
}
.code-copy-btn.copied::before {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z'/%3E%3C/svg%3E");
}
```

(The two mask SVGs are the GitHub Octicons "copy" and "check" glyphs.)

### 3.10 Code-block copy button (injected JS)

A script injected at document-end wires a single delegated click listener (guarded by
`window.__kelpiCopyCodeBound` so re-injection is a no-op):

```
on document click:
  btn = event.target.closest('.code-copy-btn'); if none → ignore
  if btn already has class 'copied' → ignore        // re-entry guard: a second click
                                                    // during the copied window must not
                                                    // reset the animation
  wrap = btn.parentNode
  code = wrap.querySelector(':scope > pre > code')  // direct child only; a wrapper
                                                    // without an inner <code> (e.g. any
                                                    // future front-matter pre) is skipped
  if no code or code.textContent empty → ignore
  send code.textContent to the host                 // current app: webkit message handler
                                                    // 'copyCodeBlock' → host writes the
                                                    // string to the system clipboard
  btn.classList.add('copied')
  origLabel = btn.getAttribute('aria-label') || 'Copy code'
  btn.setAttribute('aria-label', 'Copied')          // announce success to assistive tech
  after 1500 ms:
    btn.classList.remove('copied')
    btn.setAttribute('aria-label', origLabel)
```

If posting to the host throws, nothing happens (no visual state change). The copied
text is the **raw code text** (not the HTML). Host-side: an empty string is ignored;
otherwise it replaces the clipboard contents as plain text.

Port: in a browser, `navigator.clipboard.writeText(text)` replaces the message-handler
hop; keep the aria-label swap and the 1.5 s `copied` window exactly.

### 3.11 Render/reload cycle and scroll preservation

The preview holds the current file content in memory (`currentContent`) plus a
`didLoadSuccessfully` flag.

`loadFile()`:

```
if filePath empty → no-op
try read file as UTF-8:
  ok  → content = bytes, loaded = true
  err → content = "> Failed to load file: <path>\n>\n> <error message>", loaded = false
        // i.e. the error itself is rendered as a markdown blockquote
didLoadSuccessfully = loaded          // set BEFORE the unchanged guard so an
                                      // initially-empty file still counts as loaded
if content === currentContent → return   // unchanged: skip re-render entirely
currentContent = content
renderAndReload(content)
```

`renderAndReload(content)`:

```
renderToken += 1 (wrapping); token = renderToken
html = renderToHTML(content, bg, opacity, fontSize)
baseURL = dirname(filePath)           // so relative <img src> etc. resolve
ask the page for window.scrollY (async):
  if a newer render started since (token != renderToken) → drop this one entirely
  load the new HTML (document replace) with baseURL
  if scrollY > 0: clear pendingScrollFraction; scrollTo(0, scrollY)
                                       // absolute-pixel restore for same-doc reloads
```

The monotonic token exists because rapid re-renders (holding ⌘= / ⌘-) can have several
scrollY round-trips in flight; a stale callback must not overwrite a newer render.

On document load completion (`didFinish`):

```
fraction = pendingScrollFraction ?? sharedScrollStore[paneID]
if fraction > 0:
  clear pendingScrollFraction
  scrollTo(0, fraction * max(1, scrollHeight - innerHeight))   // fractional restore
reapply active find needle (see 3.13) — the reload wiped the <mark>s
```

Scroll tracking: an injected scroll listener continuously posts
`fraction = maxScroll > 0 ? scrollY / maxScroll : 0` to the host, which stores it in a
process-wide map `paneID → fraction` (the "shared scroll store", also used by the
editor, diff, and scratchpad views). This is what makes scroll position survive
**view↔edit toggles** (different views, same store) and pane re-creation on workspace
switch. `pendingScrollFraction` is seeded from the store when the view is (re)built.

Precedence summary: same-document reloads (file change, font change, theme change)
restore the absolute `scrollY` captured just before the reload; fresh view builds and
mode switches restore the shared fractional position.

### 3.12 Live file watching (markdown preview)

Per open preview, a kqueue-style single-file watcher
(`open(filePath, O_EVTONLY)` + DispatchSource with mask
`[write, extend, rename, delete]`, events delivered on the main thread):

- **write / extend** → `loadFile()` (which no-ops if content is byte-identical).
- **rename / delete** → vim-style save handling (vim writes a new file and renames it
  over the old one, which invalidates the open fd):
  1. stop watching (closes the fd),
  2. wait **200 ms**,
  3. re-open the watch on the same path and `loadFile()`.
  If the file is truly gone, the reload renders the "Failed to load file" blockquote,
  and the re-watch silently fails (fd open fails → no watcher) until the view is
  rebuilt.
- Watching starts when the preview is built and on `filePath` change (old watch
  stopped first), and stops when the view is dismantled.

Port: Node `fs.watch` on the file (or its parent dir) with the same semantics: change
events reload; rename/delete events trigger a 200 ms delayed re-attach + reload.

### 3.13 Find-in-page (markdown preview)

The workspace-level search overlay (same UI as terminal scrollback search) drives
markdown panes through an injected JS namespace `window.__kelpiFind` with
`search(needle)`, `next()`, `prev()`, `clear()`.

State machine (host side, per pane): a controller keeps `paneID → lastNeedle` and a
handle to the pane's page. Workspace actions:

- `searchNeedleChanged(needle)` → `__kelpiFind.search(needle)` immediately (no debounce —
  it's local JS; terminal panes debounce, markdown does not). The needle is
  JSON-encoded for safe inlining into the JS call.
- `searchNavigateNext/Previous` → `__kelpiFind.next()` / `.prev()` (wraps around modulo
  match count).
- `searchClose` (Esc / close button) → clear stored needle + `__kelpiFind.clear()`.
- Entering markdown **edit mode** while searching force-closes the search overlay and
  clears marks (the preview is being replaced; the overlay would target nothing).
- After every document reload (file watcher, font, theme), the host **re-applies** the
  stored needle so the highlights survive the reload.

JS behavior contract:

- Highlight style (injected as a `<style>` by the script, deferred until `<head>`
  exists): `mark.kelpi-find-match { background:#F2D027; color:#000; border-radius:2px;
  padding:0 }` and current match `mark.kelpi-find-match.kelpi-find-current
  { background:#FF7A00; color:#000 }`. (These mirror ghostty's search-background /
  search-selected-background so terminal and markdown find share a palette.)
- `search(needle)`:
  - Clear all existing marks first (unwrap `<mark>` elements, re-normalize text nodes).
  - Empty needle → post `{total: 0, current: -1}` and stop.
  - Build a case-insensitive regex from the **escaped** needle (all regex
    metacharacters escaped — this is a literal substring search with case folding done
    by the regex engine, avoiding offset drift from `toLowerCase()` length changes,
    e.g. Turkish dotted I / eszett).
  - Walk all text nodes under `document.body`, skipping nodes inside
    `script/style/noscript` and inside existing match marks.
  - For each text node with matches, split it into text fragments and
    `<mark class="kelpi-find-match">` elements (zero-length matches are skipped by
    advancing lastIndex).
  - Current index = 0 if any matches; the current mark also gets class
    `kelpi-find-current` and is scrolled into view (`block:'center'`).
  - Post result `{total, current}` to the host.
- `next()/prev()`: `currentIndex = (currentIndex ± 1 + total) % total`, move the
  `kelpi-find-current` class, scroll into view, post result.
- `clear()`: unwrap all marks, post `{total: 0, current: -1}`.
- Result posting: every operation posts `{ total: number, current: number }` where
  `current` is `-1` when there are no matches. The host forwards this to the search
  overlay as "N matches / current is match M" (the overlay shows e.g. "3/12");
  a `current` of -1 is not forwarded as a selection. A total of 0 clears any stale
  selection so the overlay never shows "3/0".

### 3.14 Copy actions (whole-document)

Preview panes expose two copy commands, available from (a) the pane header's copy
button (a small `doc.on.doc` icon shown only on markdown panes in view mode, opening a
two-item menu) and (b) the preview's right-click context menu (two items prepended:
"Copy as Markdown", "Copy as Rich Text", then a separator, then the native menu).

Both bail silently when the last load failed (`didLoadSuccessfully == false`) — you
can't copy the synthetic error blockquote.

- **Copy as Markdown**: the *source* markdown of the whole document with front-matter
  stripped (`FrontMatterExtractor.extract(currentContent).body`) → clipboard as plain
  text. (Selection-aware copy was deliberately abandoned; the contract is whole-file.)
- **Copy as Rich Text**: takes the rendered DOM of `#content`, clones it, removes all
  `.frontmatter, .frontmatter-raw, .frontmatter-nested` elements (the front-matter
  table breaks RTF conversion) and all `.code-copy-btn` elements (they'd leak into the
  payload as a stray glyph), and serializes `innerHTML`. The host then converts that
  HTML into rich text **with relative URLs resolved against the file's parent
  directory** (so `src="diagram.png"` next to the file keeps working in the paste
  target) and writes three clipboard flavors: plain text (the flattened string), RTF,
  and HTML.

In the current app the copy request travels pane-header → notification
(`{paneID, kind: "markdown"|"richText"}`) → the matching preview coordinator. Port
equivalent: a client-side message to the pane's iframe/component.

### 3.15 Link handling

Clicks on links in the preview do NOT navigate the pane. Any link-activated navigation
is cancelled and the URL is opened in the system default browser. (All other
navigations — the initial HTML load — proceed.)

### 3.16 Font size (preview only)

Per-pane `markdownFontSize`, adjusted by keybindings (defaults: ⌘= increase, ⌘-
decrease, ⌘0 reset). Rules (enforced host-side):

- Only when the focused pane is `markdown` AND `isEditing == false` (the plain-text
  editor has a fixed 13 pt monospace font; diff panes currently receive the same
  per-pane value as their base font size but have no bindings to change it).
- Increase: `min(size + 1, 32)`. Decrease: `max(size - 1, 8)`. Reset: 14.
- A change re-renders the current content (no disk read) with absolute scroll restore.

---

## 4. Markdown edit mode

### 4.1 Toggle rules (`toggleMarkdownEdit(paneID)`)

Triggered by keybinding `toggle_markdown_edit` (default **⌘E**) — dispatched only when
the focused pane is a markdown pane — or the pane-header edit/preview button (pencil
icon in view mode, eye icon in edit mode; tooltip "Edit (⌘E)" / "Preview (⌘E)").

```
pane must exist and be type markdown, else no-op

if pane.isEditing:                       // edit → view
    wasExternal = pane.externalEditorCommand != null
    pane.isEditing = false
    pane.externalEditorCommand = null
    if wasExternal: destroy the pane's terminal surface (kills the editor PTY)
else:                                    // view → edit
    if search overlay is on this pane: close it (clear needle/counts + JS marks)
    if pane.filePath set AND EditorService can build a command (see §6):
        pane.isEditing = true
        pane.externalEditorCommand = command
        spawn a terminal surface for this pane running `command` in
        pane.workingDirectory, with the workspace profile env injected
    else:
        pane.isEditing = true
        pane.externalEditorCommand = null   // built-in editor
```

While `isEditing` is true the pane body renders:

- `externalEditorCommand != null` → a full terminal surface (ghostty) running the
  user's `$EDITOR` on the file. When that process exits, the pane flips back to view
  mode automatically (see 2.4) and the file watcher picks up saved changes.
- else → the built-in plain-text editor (4.2).

### 4.2 Built-in editor behavior

A plain-text (never rich), monospace 13 px editor with:

- Undo enabled; smart quotes / smart dashes / automatic text replacement disabled;
  native find bar available.
- Content: the raw file bytes as UTF-8. Read failure renders the literal text
  `// Failed to load: <error message>` into the editor buffer (note: saving after that
  would write this placeholder — a known sharp edge, keep or fix in the port).
- **Line-number gutter**: right-aligned line numbers (1-based), 11 px monospace,
  gutter min width 36 px, growing to fit the largest line number + 8 px gutter
  padding + 4 px text padding. Gutter background = pane-header chrome color; number
  color = tertiary chrome text color. A trailing newline shows an extra final line
  number; an empty document shows "1". Line count = number of `\n` + 1.
- **Autosave**: on every text change, a 500 ms debounce timer (re)starts; on fire, the
  whole buffer is written to `filePath` atomically (temp file + rename). Write errors
  are logged, not surfaced.
- **Quit flush**: on app quit, all live editors synchronously flush any pending
  debounced save before exit so up to 500 ms of typing isn't lost (issue #129). Port:
  daemon-side, flush on client disconnect/shutdown for any dirty editor buffers.
- **Scroll persistence**: same shared fraction store as the preview — scroll fraction
  saved on scroll, restored on build — so toggling ⌘E keeps your place bidirectionally.
- Text/caret color: luminance rule against the ghostty background —
  dark background → near-white text (`white 0.90`), light → near-black (`white 0.12`);
  the editor surface itself is transparent over the pane's ghostty-colored background.
- No file watching in edit mode: external changes to the file while the built-in
  editor is open are NOT live-merged (last writer wins on the next autosave). The
  preview re-reads on the next toggle back (view is rebuilt → `loadFile()`).

### 4.3 Focus semantics (all content panes)

- Clicking anywhere in a content pane focuses that pane (the embedded view posts the
  same pane-focused event as terminal surfaces).
- When a pane transitions to focused, its inner view claims keyboard focus, but only
  on a genuine unfocused→focused transition (so unrelated re-renders — e.g. typing in
  the command palette — don't yank focus), and never while a sidebar text field is
  being edited.
- Editors additionally *release* keyboard focus explicitly on focused→unfocused so the
  next pane's claim isn't blocked.

---

## 5. Diff panes

### 5.1 Inputs and lifecycle

- `repoPath` = `pane.workingDirectory` (the repo), `targetPath` = `pane.filePath`
  (optional file/dir scope). No `--staged` or ref-range support.
- Diff text source: `git diff --no-color` run in `repoPath`, with
  `-- <targetPath>` appended when the scope is non-empty. Implementation: spawn
  `/usr/bin/git` with cwd = repoPath, capture stdout; non-zero exit throws an error
  carrying the command, exit code, and trimmed stderr.
- On git failure the pane renders the plain text
  `Failed to run git diff in <repo>:\n<error message>` **through the normal diff
  renderer** (so it appears as loose context lines, not a special error page).
- Empty/whitespace-only diff → centered "No changes" placeholder
  (`<div class="empty">No changes</div>`).

### 5.2 Refresh triggers

The diff re-runs `git diff` when ANY of:

1. `repoPath` or `targetPath` changes;
2. the header **refresh button** (clockwise-arrow icon, tooltip "Refresh diff") is
   clicked — implemented as a per-pane monotonically incremented `refreshToken`
   (wrapping u64, client-local state, not persisted); a token change forces a reload;
3. the pane transitions unfocused → focused (refresh-on-focus: come back to the diff
   pane and it's current);
4. a "reload page" gesture inside the webview (⌘R / right-click → Reload) — the
   navigation is cancelled and mapped to a re-fetch (a raw reload would land on
   about:blank since the HTML was string-loaded).

Font-size or background/theme changes WITHOUT any of the above re-render the cached
diff text without re-running git. Each new load cancels any in-flight git invocation.
Scroll restore across reloads: identical to markdown (absolute scrollY before reload,
fractional store on fresh build / didFinish).

Link clicks open in the system browser (same policy as markdown). No file watching —
refresh is purely event-driven per the list above.

### 5.3 Diff parsing → HTML

Input: raw unified `git diff` output. Split into lines on `\n` (keeping empties).

**File chunking**: group lines into chunks starting at each line that begins with
`diff --git ` (that line is both `headerLine` and the chunk's first content line). Any
lines before the first `diff --git ` form a headerless *preamble* chunk.

Whole-body structure:

```html
<div class="diff">
  [preamble lines, if any, rendered loose]
  <details class="file" open> ... </details>   <!-- one per file -->
  ...
</div>
```

**Preamble chunk** (headerLine == null): each line rendered loose (no `<details>`):
`<div class="line line-CLASS">ESCAPED_LINE</div>`.

**Per-file chunk**:

```html
<details class="file" open>
  <summary class="file-summary">
    <span class="caret"></span>
    <span class="file-path">PATH</span>
    <span class="file-status status-STATUSCLASS">STATUSLABEL</span>
    <!-- only when additions>0 or deletions>0: -->
    <span class="diff-stats">
      <span class="stat-add">+N</span>
      <span class="stat-del">-M</span>
    </span>
  </summary>
  <div class="hunks"><div class="hunks-inner">
    <div class="line line-CLASS">ESCAPED_LINE</div>   <!-- every chunk line, incl. the
                                                           diff --git line itself -->
    ...
  </div></div>
</details>
```

All files start expanded (`open`). Clicking the summary toggles collapse — native
`<details>` behavior, no JS. The summary is `position: sticky; top: 0` so the current
file's header stays pinned while scrolling its hunks. `.hunks` is the per-file
horizontal scroll container (`overflow-x: auto`), with `.hunks-inner` as
`display:inline-block; min-width:100%` so add/del background stripes extend across the
full widest-line width while the summary stays viewport-width.

**Line classification** (`classify(line)`, order matters — file-header markers before
`+`/`-` because of `+++`/`---`):

```
prefix "diff --git " | "index " | "--- " | "+++ " | "new file mode" |
       "deleted file mode" | "similarity index" | "rename " | "copy " |
       "Binary files" | "old mode" | "new mode"      → "file-header"
prefix "@@"                                          → "hunk"
prefix "+"                                           → "add"
prefix "-"                                           → "del"
otherwise                                            → "context"
```

Note `"--- "` / `"+++ "` include the trailing space; `"new file mode"` etc. do not.
A `\ No newline at end of file` line classifies as `context`.

**File status detection** (per chunk, scanning all lines):

```
hasNewFileMode      = any line startsWith "new file mode"
hasDeletedFileMode  = any line startsWith "deleted file mode"
renameFrom          = text after "rename from "     (if present)
hasRenameTo         = any line startsWith "rename to "
hasBinary           = any line startsWith "Binary files"
hasModeChange       = any line startsWith "old mode" or "new mode"
hasContentChange    = any line startsWith "@@"

status = hasNewFileMode              → added
       : hasDeletedFileMode          → deleted
       : renameFrom && hasRenameTo   → renamed(from)
       : hasBinary                   → binary
       : hasModeChange && !hasContentChange → mode      // chmod+edit shows as modified
       : otherwise                   → modified

labels / css classes: added, deleted, modified, renamed, binary, mode
(status badge text = label, uppercased by CSS)
```

**Add/del counts**: over the chunk's lines, skip lines starting `+++` or `---`; count
lines starting `+` as additions and `-` as deletions. (A pure rename shows no stats
span; the `diff --git` line itself never matches.)

**Display path**: from the `diff --git a/<path> b/<path>` header line, take everything
after the LAST occurrence of `" b/"` (backwards search — tolerates spaces in paths for
the common case; if `" b/"` is absent the whole header line is shown). For renames the
path shown is `"<renameFrom> → <destPath>"` (with a real arrow character).

### 5.4 Diff stylesheet (exact contract)

`BASE` = baseFontSize px (default 13; the GUI passes `pane.markdownFontSize`, so the
shared per-pane font size applies, default 14):

```css
html, body { margin: 0; padding: 0; }
body {
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: BASEpx;
    line-height: 1.45;
    color: #1f2328;
    background-color: transparent;
    overflow-y: auto;
    overflow-x: hidden;
}
.dark body { color: #e6edf3; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.4); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.6); }
::-webkit-scrollbar-corner { background: transparent; }
.diff { padding-bottom: 8px; }
details.file { display: block; }
.hunks { overflow-x: auto; }
.hunks-inner { display: inline-block; min-width: 100%; }
details.file > summary {
    position: sticky;
    top: 0;
    z-index: 2;
    list-style: none;
    cursor: pointer;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-weight: 600;
    color: #1f2328;
    background: #f6f8fa;
    border-top: 1px solid #d1d9e0;
    border-bottom: 1px solid #d1d9e0;
    padding: 6px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
}
details.file > summary::-webkit-details-marker { display: none; }
details.file:first-child > summary { border-top: none; }
.dark details.file > summary {
    background: #161b22; color: #e6edf3;
    border-top-color: #3d444d; border-bottom-color: #3d444d;
}
.caret { display: inline-block; width: 10px; color: #8b949e; transition: transform 0.12s ease; }
.caret::before { content: "\25B6"; font-size: 9px; }   /* ▶ */
details[open] > summary .caret { transform: rotate(90deg); }
.file-path { font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace; font-weight: 500; }
.file-status {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 1px 6px; border-radius: 3px;
}
.status-added    { background: rgba(46,160,67,0.18);  color: #1a7f37; }
.dark .status-added    { color: #4ac26b; background: rgba(46,160,67,0.22); }
.status-deleted  { background: rgba(248,81,73,0.18);  color: #cf222e; }
.dark .status-deleted  { color: #ff7b72; background: rgba(248,81,73,0.22); }
.status-modified { background: rgba(56,139,253,0.18); color: #0969da; }
.dark .status-modified { color: #58a6ff; background: rgba(56,139,253,0.22); }
.status-renamed  { background: rgba(163,113,247,0.18); color: #8250df; }
.dark .status-renamed  { color: #d2a8ff; background: rgba(163,113,247,0.22); }
.status-binary, .status-mode { background: rgba(101,109,118,0.18); color: #57606a; }
.dark .status-binary, .dark .status-mode { color: #8b949e; background: rgba(139,148,158,0.18); }
.diff-stats {
    margin-left: auto;
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; display: inline-flex; gap: 8px;
}
.stat-add { color: #1a7f37; font-weight: 600; }   .dark .stat-add { color: #4ac26b; }
.stat-del { color: #cf222e; font-weight: 600; }   .dark .stat-del { color: #ff7b72; }
.line { display: block; padding: 0 16px; white-space: pre; }
.line:empty::before { content: "\00a0"; }          /* keep empty lines 1 line tall */
.line-add  { background: #e6ffec; color: #1a7f37; }
.dark .line-add { background: rgba(46,160,67,0.15); color: #4ac26b; }
.line-del  { background: #ffebe9; color: #cf222e; }
.dark .line-del { background: rgba(248,81,73,0.15); color: #ff7b72; }
.line-hunk { background: #ddf4ff; color: #57606a; }
.dark .line-hunk { background: rgba(56,139,253,0.15); color: #8b949e; }
.line-file-header { color: #57606a; font-size: 0.92em; padding-top: 2px; padding-bottom: 2px; }
.dark .line-file-header { color: #8b949e; }
.empty {
    text-align: center; color: #57606a;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: 14px; padding: 80px 20px;
}
.dark .empty { color: #8b949e; }
```

Same doctype/html-class/head wrapper as markdown (3.7) but the body is the diff HTML
directly (no `#content` wrapper).

Diff panes do not participate in find-in-page (only terminal, markdown, and web panes
do).

---

## 6. EditorService ($VISUAL/$EDITOR resolution for external edit mode)

Purpose: decide whether ⌘E opens the user's terminal editor instead of the built-in
one, and build the exact shell command to run it. GUI apps on macOS don't inherit the
login shell env, so this is done by interrogating the user's shell once.

### 6.1 API

```ts
interface EditorService {
  resolveEditor(): string | null;                 // e.g. "nvim", "code -w"; null if
                                                  // unresolved / still resolving
  buildCommand(filePath: string): string | null;  // full shell command or null
  warmUp(): void;                                 // kick off async resolution; called
                                                  // once at app launch
}
```

Both getters are **non-blocking**: while resolution is in flight they return null and
the caller falls back to the built-in editor. (So the very first ⌘E after a cold
launch may use the built-in editor even for a user with `$EDITOR` set, if warmup
hasn't finished — warmUp at launch makes this rare.)

### 6.2 Resolution algorithm

1. Determine the user's login shell: passwd database (`getpwuid`) → `$SHELL` env →
   `/bin/sh`.
2. Spawn it as `shell -l -i -c 'printf "\n%s\n%s\n%s\n%s\n%s\n" "__KELPI_EDITOR_BEGIN__" "$VISUAL" "$EDITOR" "$PATH" "__KELPI_EDITOR_END__"'`
   — login + interactive so `.zshrc`/`.bashrc`/`.zprofile` are all sourced (that's
   where users actually set `$EDITOR`).
3. Drain stdout and stderr **concurrently while the process runs** (a chatty init
   printing > ~64 KB would otherwise deadlock on the pipe buffer). A **2 s watchdog**
   terminates a hung shell.
4. Parse: find the line equal to `__KELPI_EDITOR_BEGIN__`; the next three lines
   (trimmed) are VISUAL, EDITOR, PATH; a line equal to `__KELPI_EDITOR_END__` in one of
   those slots reads as empty. Missing begin marker → all empty. Sentinels exist
   because init scripts print banners/MOTD/direnv noise that would wreck positional
   parsing.
5. Chosen editor: VISUAL if non-empty, else EDITOR, else failure. Non-zero shell exit
   is failure.
6. On failure, fall back to this process's own env (`$VISUAL` → `$EDITOR`, with its
   `$PATH`) — mostly relevant for CLI/test launches.
7. Caching: a success is cached for the process lifetime. A **failure is cached for
   30 s**, after which the next query retries in the background (so one slow/hung
   shell doesn't permanently disable external editing).

### 6.3 Command construction

```
singleQuoteEscape(s): replace ' with '\''      // POSIX single-quote escaping

formatCommand(editor, filePath, loginPath):
  file = singleQuoteEscape(filePath)
  if loginPath empty/null:  "<editor> '<file>'"
  else:                     "/usr/bin/env PATH='<singleQuoteEscape(loginPath)>' <editor> '<file>'"
```

The `editor` value is deliberately NOT quoted — `"code -w"` must stay two words. The
`/usr/bin/env PATH=…` prefix exists because the terminal runtime wraps commands as
`bash -c "exec -l <command>"`, where `exec` won't parse a bare `VAR=value` prefix as
an assignment; `env` is a real binary so it works. The captured login `$PATH` is
injected so the editor binary is findable in the minimal env a GUI app gets; no nested
login shell is spawned at launch time (that would cost 1-2 s of rc-file sourcing per
⌘E).

The resulting command is spawned in a terminal surface with cwd =
`pane.workingDirectory` and the workspace profile env; process exit returns the pane
to view mode (see 2.4/4.1).

---

## 7. Scratchpad panes

An in-memory plain-text editor. Content is NEVER written to disk; every change is
reported to state (`scratchpadContentChanged(paneID, content)` → sets
`pane.scratchpadContent`) which the debounced persistence layer stores in the DB's
`pane.content` column. Restart restores the text.

Behavior = the built-in markdown editor (4.2) with these differences:

- **Save target**: instead of writing a file, the 500 ms debounced change handler
  sends the full buffer to state. Note the debounce means up to 500 ms of typing can
  be lost on an abrupt kill; unlike the markdown editor there is no quit-flush hook
  for scratchpads (the DB persistence layer has its own 500 ms debounce on top). A
  port may want to close that gap.
- **Initial content**: `pane.scratchpadContent ?? ""`, seeded once at view build.
  There is no reload-from-state path while the view lives (the editor is the source
  of truth while open).
- No file, no file watching, no view mode: `isEditing` is always true, there is no
  preview/⌘E toggle, no copy-as-markdown, no font-size bindings (fixed 13 px
  monospace).
- Header: note icon, title "Scratchpad", no label chip logic difference, no git
  branch.
- Same line-number gutter, scroll-fraction persistence, undo, find bar, transparent
  background over the ghostty-colored pane fill, luminance-based text color.
- Close/reopen: content rides the closed-pane snapshot, so ⌘⇧T restores the text.

---

## 8. Pane chrome (headers) for content panes

Header layout (all panes share one header bar; content-pane specifics):

- **Type icon** (left, 10 px, secondary color): markdown `doc.text` (document),
  scratchpad `note.text`, diff `plusminus`, web `globe`; shell panes show the colored
  status dot instead.
- **Label chip**: shown for any pane with a non-empty label EXCEPT markdown panes
  (their label is the filename, which would duplicate the title text).
- **Title text** (monospace 11 px, middle-truncated): scratchpad → `Scratchpad`;
  markdown → basename of `filePath`; diff → `diff: <scope>` where scope = basename of
  `targetPath` if set else basename of repo dir; shell → home-abbreviated
  title/working directory.
- **Git branch chip**: shown when `pane.gitBranch` is set (markdown and diff panes get
  it via the async detection at open; scratchpads never do).
- **Markdown-only buttons** (view mode only): copy menu button (`doc.on.doc` icon,
  tooltip "Copy whole file") → menu with "Copy as Markdown" / "Copy as Rich Text";
  edit/preview toggle button (pencil in view mode with tooltip "Edit (⌘E)"; eye in
  edit mode with tooltip "Preview (⌘E)"). The copy button is hidden while editing.
- **Diff-only button**: refresh (`arrow.clockwise`, tooltip "Refresh diff") → bumps
  the pane's refreshToken (5.2).
- Standard buttons (split right / split down / close) follow.
- Context-menu "Open in Finder"-equivalent: markdown reveals `filePath`; diff reveals
  `filePath` when non-empty, else opens `workingDirectory`; others open the working
  directory.

Pane body background (behind any content pane's transparent view): the ghostty
terminal background color at ghostty background opacity — this is what makes content
panes blend with the terminal theme (see 3.8).

---

## 9. Scroll-position store (shared)

A process-wide (client-side, in-memory, not persisted) map:

```ts
scrollFractions: Map<paneID, number>   // 0..1 fraction of max scroll
```

Writers: markdown preview (JS scroll events → fraction), markdown editor + scratchpad
(scroll observer → `contentOffsetY / maxScroll`, only when maxScroll > 0), diff pane
(JS scroll events). Readers: each view on build (and the webviews again on every
document-finish). `clearScrollFraction(paneID)` exists for cleanup. Because it's keyed
by pane id and outlives view rebuilds, position survives workspace switches and
view/edit toggles, but not app restarts.

---

## 10. RecursiveFSWatcher (directory watcher service)

Not used by content panes (the markdown preview uses its own single-file watcher,
§3.12) — it drives Graft's worktree mirroring — but it lives in the assigned surface,
so its contract:

- `start(rootPath, debounce = 500ms, ignoredComponents = {".git", "node_modules", "target", ".DS_Store"}) → AsyncStream<string[]>`
  Recursive watch over `rootPath` (FSEvents file-level events, no-defer). Events are
  path strings; a path is dropped if ANY of its `/`-separated components is in
  `ignoredComponents`.
- **Debounced batching**: changed paths accumulate in a set; each new event resets the
  debounce timer; after `debounce` of quiet the batch is emitted as a **sorted, deduped
  array**. Empty batches are never emitted.
- Stream termination (consumer cancel) or `stopAll()` tears the watch down; teardown
  cancels any pending batch (a final partial batch may be silently dropped).
- Zero cost at rest (event-driven). One OS stream per active watch.
- Test backend: no OS watcher; tests inject paths which go through the same component
  filter but bypass debounce (one synchronous batch per inject).

Port: chokidar/@parcel/watcher with equivalent ignore + 500 ms trailing-debounce
batch semantics.

---

## 11. Edge cases & invariants (checklist)

Markdown:

- Empty file → empty preview, but counts as successfully loaded (copy actions work,
  copying yields empty string body).
- File read failure (missing/permission/non-UTF-8) → the error is rendered as a
  markdown blockquote in the preview; copy actions are disabled until a successful
  load.
- Content-unchanged reload is a no-op (prevents scroll flicker on `touch`).
- BOM is stripped only for front-matter detection; parsing body content still includes
  whatever the extractor returned (BOM removal happens on the extractor's working copy;
  when there is NO front matter the ORIGINAL string — BOM included — is returned as
  body; when front matter exists the body starts after the closing fence so the BOM is
  gone).
- Front-matter fences: opening must be `---` (not `...`); closing may be `---` or
  `...`; trailing spaces/tabs allowed on fence lines; indented fences never match.
- Front-matter > 64 KiB (scanned bytes incl. newlines) → treated as ordinary markdown
  (the `---` line renders as a thematic break / setext artifacts per the parser).
- Malformed YAML / non-mapping root → raw escaped `<pre class="frontmatter-raw">`.
- Task-list checkboxes are disabled — clicking them does nothing and never mutates the
  file.
- Raw HTML in markdown passes through unescaped.
- Link clicks leave the app (system browser); the preview never navigates.
- `--here` panes restore their parked terminal on close; if the parked terminal's
  process died first, close behaves normally.

Diff:

- `renderChunk` includes the `diff --git` line itself inside the `<details>` body as a
  `line-file-header` row (the summary is additional chrome, not a replacement).
- Binary-file chunks have no `@@` lines → status `binary`, no stats span, body is just
  header lines.
- A chunk with only mode lines → status `mode`; mode + content → `modified`.
- Empty lines inside hunks keep their height via the `\00a0` pseudo-content.
- Refresh-on-focus means simply focusing the pane re-runs git — cheap and expected.
- In-flight git runs are cancelled by newer loads (stale results never render).

Scratchpad:

- `scratchpadContent` may be null (fresh pane) → editor seeds with "".
- Content persists via DB only; nothing ever touches disk.

Fonts (defaults, bindable):

- ⌘E toggle_markdown_edit; ⌘= / ⌘- / ⌘0 markdown font size (guarded: markdown pane,
  view mode); ⌘⇧N create_scratchpad; open_diff default unbound.

---

## Port notes

1. **Where rendering happens.** In the Swift app, markdown/diff HTML is generated
   natively and pushed into a WKWebView. In the port, the natural split is: the
   **daemon** owns the pane model, file reading, file watching, git invocation, and
   (recommended) the markdown/diff → HTML transformation (so all clients render
   identically and the CLI could someday reuse it); the **web client** owns scroll
   state, find-in-page, the copy button JS, and clipboard access. The HTML/CSS/JS
   contracts in §3.9/3.10/3.13/5.4 are the compatibility target regardless of where
   they're produced.

2. **Markdown parser parity.** swift-markdown is cmark-gfm underneath. Use a
   CommonMark+GFM-compliant JS parser (e.g. remark-gfm or markdown-it with the gfm
   tables/strikethrough/task-list plugins) but implement the HTML emission yourself to
   match §3.3 exactly (class names, attribute order need not be byte-identical, but
   classes/structure must match the CSS and copy-button JS). Note the non-standard
   bits: the `code-block` wrapper + copy button, task-list markup, autolink scheme
   allowlist (§3.4 — do NOT use GFM autolink extension semantics, which link bare
   domains), and raw-HTML passthrough.

3. **Raw HTML / sanitization.** The current app passes raw HTML through into an
   isolated, JS-enabled webview whose only host bridges are scroll/find/copy. In a web
   client the preview MUST be similarly isolated (sandboxed iframe with its own
   origin, or sanitize). Preserve the behavior (users rely on inline HTML in notes)
   but do not let pane content script against the app shell.

4. **Relative resources.** The preview is loaded with baseURL = the file's directory
   so relative images work; copy-as-rich-text resolves relative URLs the same way. In
   the port the daemon must serve sibling files of an opened markdown file (scoped
   static route) and set `<base>` accordingly — a plain `srcdoc` iframe would break
   relative images.

5. **Clipboard.** `navigator.clipboard.writeText` for plain text; for copy-as-rich-
   text write both `text/html` and `text/plain` flavors via `ClipboardItem` (browsers
   can't write RTF — HTML flavor is the practical equivalent and pastes fine into rich
   editors). Keep front-matter and copy-button stripping (§3.14).

6. **File watching.** Replace the kqueue single-file watcher with `fs.watch` on the
   parent directory (more reliable for the vim rename dance on all platforms) or
   chokidar on the single file; keep the 200 ms re-attach delay and the
   unchanged-content short-circuit. Watchers live in the daemon; pushes to clients are
   "content changed" events (send new content or a rendered-HTML invalidation).

7. **Autosave authority.** The built-in editor's 500 ms debounced write and the
   preview's file watcher form a loop through the filesystem; the current app avoids
   echo because view and edit modes never run simultaneously for one pane. Preserve
   that invariant (edit mode suspends the watcher-driven preview). With multiple
   clients attached to one daemon, the daemon must arbitrate: one editing client's
   buffer is authoritative; other clients viewing the same pane should follow the
   autosaved writes. Implement the quit-flush (flush pending debounced saves on
   shutdown/disconnect) — and consider extending it to scratchpads, which today can
   lose up to ~1 s (editor debounce + DB debounce) on a hard kill.

8. **External editor mode** translates directly: EditorService resolution
   (§6.2 — login+interactive shell probe with sentinels, concurrent pipe drain, 2 s
   watchdog, 30 s failure TTL) runs in the daemon (Node `child_process` +
   `os.userInfo().shell` / `/etc/passwd`); "spawn a surface running the command" means
   the daemon points the pane's PTY at the editor command; process-exit → flip back to
   view mode. The non-blocking contract matters: never stall the toggle waiting on
   shell init.

9. **Theme source.** Light/dark is derived from the ghostty background color's
   luminance, NOT the OS theme. The web client should compute `isDark` from the same
   config-provided color and paint the pane container with
   `rgba(bgColor, bgOpacity)` behind a transparent preview. Re-render (or live-swap
   the `dark` class + repaint) on config change.

10. **Refresh tokens are client-local.** The diff refreshToken is UI state (a counter
    per pane in the grid component), not daemon state. In the port, "refresh" can just
    be a client → daemon `diff.refresh(paneID)` request; keep refresh-on-focus and the
    reload-gesture remap.

11. **Scroll store.** Keep it client-side and per-pane-id; it should survive workspace
    switches (component unmount/remount) but need not survive reload. If pane DOM is
    kept alive across workspace switches (as terminal surfaces are), much of this
    machinery collapses to "don't destroy the node".

12. **Find-in-page.** The JS in §3.13 is portable as-is (it's plain DOM). Keep the
    host-side needle cache + reapply-after-reload, the markdown/terminal palette
    match, and the force-close on entering edit mode. Result posting becomes a
    postMessage to the client shell, which updates the shared search overlay
    (`total`, `current`; -1 current not forwarded; total 0 clears selection).

13. **Known quirks worth fixing (or knowingly preserving):**
    - Built-in editor read failure puts `// Failed to load: …` into an *editable*
      buffer that autosave will happily write to the file on the first keystroke.
    - Markdown non-reuse open doesn't unzoom first (diff/scratchpad do).
    - Diff `extractFilePath` breaks on paths whose name contains `" b/"`; statuses/
      counts are line-prefix heuristics (fine for `git diff --no-color`, not for
      arbitrary input).
    - `backgroundOpacity` is threaded into both renderers but unused inside them
      (transparency + container fill made it moot); keep the parameter or drop it
      consciously.
    - Diff panes share `markdownFontSize` as their base font but have no bindings to
      change it (bindings are markdown-view-only), so diffs effectively always render
      at the pane's default 14 px unless the pane previously was… it never was —
      practically constant. The port can simply give diffs a fixed 13-14 px base or
      wire the bindings properly.

14. **CLI compatibility.** The `open` and `diff` wire commands (and `--here` reuse
    semantics, including pane parking/unparking) are part of the frozen wire protocol
    the existing `kelpi` CLI expects. Parking (`parkedPanes` lane keeping the PTY alive
    off-layout, restore-on-close) must exist in the daemon's workspace model.
