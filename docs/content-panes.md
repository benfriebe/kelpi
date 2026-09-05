# Content Panes: Markdown, Diff, Scratchpad

Behavioral specification of Kelpi's non-terminal "content" panes (markdown preview/edit
panes, git-diff panes, and scratchpad panes) plus the supporting services (the
`$VISUAL`/`$EDITOR` resolver, the per-pane file watcher, find-in-page, scroll preservation,
and the copy pipeline). It describes Kelpi as it is: a headless daemon that owns the pane
model, file reading, file watching, git invocation and the markdown/diff to HTML rendering,
and a web client that owns the sandboxed preview frame, scroll state, find-in-page, the
injected bridge script and clipboard access. Where behavior is user-visible it is described
as such, so that every attached client renders it the same way.

Source files this spec describes (TypeScript):

- `packages/daemon/src/content/markdown.ts`: markdown → HTML + CSS, front-matter extraction and rendering, bare-URL autolinking
- `packages/daemon/src/content/html.ts`: the shared document wrapper, HTML escaping, the luminance rule
- `packages/daemon/src/content/diff.ts`: git diff → HTML + CSS
- `packages/daemon/src/content/service.ts`: the daemon's content service (entries, loading, watching, edit mode, refresh)
- `packages/daemon/src/content/editor.ts`: the authoritative edit buffer (autosave, atomic write, shutdown flush)
- `packages/daemon/src/content/watcher.ts`: the per-file watcher behind the preview
- `packages/daemon/src/content/external-editor.ts`: $VISUAL/$EDITOR resolution for external edit mode
- `packages/daemon/src/ws/desktop.ts`: the `markdown-external-editor` verb (open / close)
- `packages/daemon/src/git/exec.ts`, `packages/daemon/src/git/service.ts`: the git process layer and `getDiff`
- `packages/daemon/src/graft/watcher.ts`: recursive directory watcher (used by Graft, spec'd here for completeness)
- `packages/daemon/src/store/reducers/panes.ts`, `packages/daemon/src/store/types.ts`: the pane model, the open/close/park/reopen reducers, closed-pane snapshots
- `packages/daemon/src/handlers/app/files.ts`: the `open` and `diff` wire commands
- `packages/client/src/content/ContentFrame.tsx`: the sandboxed preview host, find bar, copy menu, scroll restore
- `packages/client/src/content/bridge.ts`: the injected bridge script (copy button, links, find, chord relay, scroll) and its host-side effects
- `packages/client/src/content/copy.ts`: the whole-document copy commands
- `packages/client/src/content/MarkdownPane.tsx`, `DiffPane.tsx`, `ScratchpadPane.tsx`: the three pane bodies
- `packages/client/src/content/PlainTextEditor.tsx`, `gutter.ts`: the built-in plain-text editor and its line-number gutter
- `packages/client/src/content/scroll.ts`: the shared scroll-position store
- `packages/client/src/content/client.ts`: the client's content API (keystroke coalescing, mode, refresh)
- Plus the surrounding wiring in `packages/client/src/App.tsx`, `packages/client/src/grid/PaneHeader.tsx`,
  `packages/client/src/chrome/theme.ts` and `packages/core/src/config/bindings.ts`.

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
  agentProfileName?: string;     // the profile the agent session was launched under
  markdownFontSize: number;      // font size DOES survive close→reopen (unlike restart)
  webState?: unknown;            // web pane sidecar; irrelevant here
}
```

`reopenClosedPane` pops the newest snapshot, mints a new pane id, splits the focused
pane horizontally, and recreates the pane with
`isEditing = (type == "scratchpad")`. `agentKind`, `agentProfileName` and
`markdownFontSize` are restored from the snapshot (`agentSessionID` is not; it only
types the resume command). Markdown/scratchpad/diff/web reopens create no
PTY; only shell reopens spawn a surface (and possibly resume an agent session).
(`packages/daemon/src/store/reducers/panes.ts`, `snapshotForReopen` / `reopenClosedPane`;
`ClosedPaneSnapshot` in `packages/daemon/src/store/types.ts`.)

---

## 2. Opening content panes (entry points and placement)

### 2.1 Markdown pane — `openMarkdownFile(filePath, reusePaneID?)`

Entry points (all converge on this one action):

1. **⌘O** file picker (filtered to `.md`) and **drag-and-drop** of a `.md` file onto the
   window → app-level `openFileAtPath(path, fromPaneID?)`:
   - If no workspace is active yet, the `open` (or `diff`) command is dropped; the
     daemon keeps no pending-open queue (`route()` in
     `packages/daemon/src/handlers/app/files.ts` returns null and the handler returns
     without dispatching).
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
scratchpad do). Minor asymmetry, preserved on purpose (`openMarkdownPane` in
`packages/daemon/src/store/reducers/panes.ts`, marked as a quirk).

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
  → extractFrontMatter  → (yaml | null, body)
  → parse body as GitHub-flavored markdown (markdown-it, CommonMark + GFM tables and
    strikethrough, with `linkify` and `typographer` off and `html: true`)
  → renderTokens (token stream → HTML string; markdown-it only parses here, the HTML is
    emitted by Kelpi's own walker so the §3.3 contract holds)
  → fmHTML = yaml ? renderFrontMatter(yaml) : ""
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

Dark-mode detection (shared by markdown, diff, and the plain-text editors;
`isDarkBackground` in `packages/daemon/src/content/html.ts`, mirrored client-side by
`ghosttyBucket` in `packages/client/src/chrome/theme.ts`):

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
an iframe sandboxed to `allow-scripts` only (`packages/client/src/content/ContentFrame.tsx`),
so the document has an opaque origin and cannot script the app shell (see Compatibility
rationale, item 3).

### 3.4 Bare-URL autolinking

The parser only links `<>`-wrapped URLs and `[text](url)` (markdown-it's own linkify is
off). Plain-text nodes are additionally scanned for URLs (`AUTOLINK_PATTERN` and
`autolinkText` in `packages/daemon/src/content/markdown.ts`) with these rules:

- Only matches whose **source text starts with** one of
  `http://`, `https://`, `ftp://`, `file://`, `mailto:` (case-insensitive prefix
  check) become links. Schemeless domains (`example.com`) and bare emails
  (`foo@example.com`) are deliberately left as plain text — this is "terminal-style
  pasted-URL clickability", not GitHub fuzzy linkification.
- Output per match: `<a href="ESCAPED_URL">ESCAPED_SOURCE_TEXT</a>`, where the href is
  the matched text itself, never re-canonicalized (`new URL()` would append slashes the
  source never had); surrounding text is escaped normally.
- Trailing sentence punctuation is not part of the link: `trimUrlTail` strips any run of
  `.`, `,`, `;`, `:`, `!`, `?` off the end of a match, and strips a trailing `)`, `]` or
  `}` only when it is unbalanced within the match (so `(see https://x.y/z)` links
  `https://x.y/z` but `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its paren). A
  match that trims to nothing is skipped.
- Autolinking is disabled inside explicit links and image alt text (a depth counter
  is incremented around their children) — text there is escape-only.

### 3.5 Front-matter extraction

`extractFrontMatter(markdown) → { yaml: string | null, body: string }`
(`packages/daemon/src/content/markdown.ts`).

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

`renderFrontMatter(yaml) → html` (prepended before the markdown body inside
`#content`; `packages/daemon/src/content/markdown.ts`):

- If `yaml.trim() === ""` → return `""` (nothing rendered).
- Parse the YAML (the `yaml` package's `parseDocument`, which exposes node types and
  can re-serialize a node). On **parse error** or when the **root is not a
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

- The document CSS sets `background-color: transparent;` on `body`, and the **pane
  container** behind the document paints the ghostty terminal background color at the
  ghostty background opacity (`--kelpi-term-bg`, the same fill terminal panes use). In
  the web client the document is shown in an `allow-scripts`-only sandboxed iframe: an
  opaque origin composited in its own process, which cannot inherit the container's
  transparency and would otherwise paint over a white canvas. So the client additionally
  injects `html { background-color: <ghostty bg at ghostty opacity, flattened over the
  window fill>; color-scheme: dark|light }` into the document after the daemon's own
  stylesheet (`frameBaseStyle` / `prepareContentDocument` in
  `packages/client/src/content/bridge.ts`; `ContentFrame` always passes a
  `documentBackground`, falling back to `FRAME_DOCUMENT_BACKGROUND`). Content panes
  therefore match the pane fill's colour but, unlike terminal panes, do not become
  see-through at 0% opacity. The daemon's HTML contract is untouched: a client that can
  composite transparency simply passes no background and gets the transparent document.
- The background color still selects the light/dark text theme (luminance rule, 3.1).
- When the ghostty config background color/opacity changes at runtime (theme change),
  the currently loaded content is **re-rendered** (HTML regenerated with the new
  `isDark` class) without re-reading the file, and the container fill updates.

### 3.9 Markdown stylesheet (the exact CSS contract)

The full inline stylesheet, with `BASE` = baseFontSize px and
`CODE = max(BASE - 1, 6)` px, emitted by `markdownStylesheet()` in
`packages/daemon/src/content/markdown.ts` (colors are GitHub-derived). Two rules, marked
S42 and S51, are Kelpi's own and are asserted by `markdown.test.ts`:

```css
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: BASEpx;
    line-height: 1.6;
    padding: 20px clamp(12px, 6%, 28px);   /* S42: a flat 28px left a 67px text column in a narrow split; identical to 28px above ~470px of pane */
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
    background: transparent;
    border: none;
    font-size: 0.85em;
    white-space: pre-wrap;
}
pre.frontmatter-nested { padding: 0; }   /* S51: the value sits in the cell's own 6/12 box, not a second one */
pre.frontmatter-raw { padding: 8px 10px; border-left: 3px solid #d1d9e0; padding-left: 10px; margin: 0 0 1.5em; }
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

A script injected at document-end wires a single delegated click listener. The listener
is one part of the content bridge script (`contentBridgeScript` in
`packages/client/src/content/bridge.ts`), which is guarded as a whole by
`window.__kelpiContentBridge` (re-injection is a no-op for the copy listener and for the
scroll/link/find/chord/context-menu handlers that ride the same script):

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
  send code.textContent to the host                 // postMessage {kind:'copy', text};
                                                    // the host writes the string to the
                                                    // clipboard (writeClipboardText)
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

The host half is `writeClipboardText` in `packages/client/src/content/bridge.ts`
(`navigator.clipboard.writeText`); the aria-label swap and the 1.5 s `copied` window
(`COPY_FEEDBACK_MS`) stay inside the frame.

The same bridge script installs the frame's other host hooks, because the sandboxed frame
is cross-origin and the host can see none of its events directly:

- **Chord relay**: a capture-phase `keydown` listener on `window` forwards ⌘E
  (`toggle-edit`) and ⌘F (`find-open`) to the host, and relays every other chord the
  app's binding map claims (seeded into the script at injection and refreshed by a
  `chords` message from the host on every `ready`), calling `preventDefault` on exactly
  those. An unclaimed chord is left to the document, so ⌘C still copies a selection.
  Capture phase on `window` means a script inside the rendered note cannot
  `stopPropagation()` a claimed chord (⌘W in particular) back to the native menu.
- **Context menu**: on right-click, while the host has told the frame it has a copy
  menu to show (`copy-menu {enabled}`, true only for a markdown pane whose last load
  succeeded), the frame suppresses the browser's menu and posts `{x, y, selection}`;
  the host draws the menu described in §3.14 and appends a plain "Copy" row when
  `selection` is non-empty. With no host menu the browser's own menu is left alone.
- **Focus**: a `mousedown` anywhere in the frame posts `focus` so the pane focuses (§4.3).

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

Explicit refresh: a markdown pane also accepts the same refresh a diff pane does
(`ContentService.refresh` in `packages/daemon/src/content/service.ts`, reached from the
client's `content.refresh(paneID)` and the `diff-refresh` wire verb, which is not
type-gated). On a markdown pane it re-reads the file through `reloadFromDisk`, with the
same unchanged-content guard as a watcher reload, so a refresh of an unchanged file
renders nothing.

### 3.12 Live file watching (markdown preview)

Per open preview, a single-file watcher owned by the daemon's content service
(`watchFile` in `packages/daemon/src/content/watcher.ts`: a non-persistent `fs.watch` on
the file itself):

- **change** → reload (`reloadFromDisk`, which no-ops if content is byte-identical).
- **rename**, or an `error` event on the watch handle (an ENOENT surfacing as an error is
  the delete half of the dance) → vim-style save handling (vim writes a new file and
  renames it over the old one, which invalidates the watch):
  1. stop watching (closes the handle),
  2. wait **200 ms** (`RENAME_REATTACH_DELAY_MS`),
  3. re-open the watch on the same path and reload.
  If the file is truly gone, the reload renders the "Failed to load file" blockquote,
  and the re-watch silently fails (the watch cannot be created → no watcher) until
  something rebuilds the watch.
- Watching starts when the first client subscribes to the pane (`content-subscribe`
  creates the entry and the watch) and again after a re-scope (`filePath` change under a
  live subscription: old watch stopped first). It is **suspended** while the pane is in
  edit mode (§4.2; `suspend()` detaches without forgetting the path, `resume()`
  re-attaches without firing) and closed when the last subscriber leaves, unless the edit
  buffer is still dirty, in which case the entry survives until the write lands (§4.2).

### 3.13 Find-in-page (markdown preview)

The workspace-level search overlay (same UI as terminal scrollback search) drives
markdown panes through an injected JS namespace `window.__kelpiFind` with
`search(needle)`, `next()`, `prev()`, `clear()`.

State (host side, per pane, **per client**): `ContentFrame`
(`packages/client/src/content/ContentFrame.tsx`) keeps the needle, the open/closed bar and
the last `{total, current}` in component state and replays the stored needle on every
`ready`; two clients searching the same pane never see each other's highlights. The bar
itself is the grid's `PaneSearchOverlay`, the same one every pane type gets. Actions:

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
  search-selected-background so terminal and markdown find share a palette.) Those are
  the defaults: all four colours are user-overridable through the kelpi config
  (`search-match-color`, `search-match-text-color`, `search-match-current-color`,
  `search-match-current-text-color`) and reach the script as a `FindPalette`; each value
  is validated to plain `#rrggbb` before it is interpolated into the stylesheet, anything
  else falling back to the default (`resolveFindPalette` in
  `packages/client/src/content/bridge.ts`).
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
    `kelpi-find-current` and is scrolled into view (`block:'center'`, with
    `inline:'nearest'` so stepping through matches inside a wide code block or table
    does not also scroll the document sideways).
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
two-item menu) and (b) the preview's right-click context menu (the host draws a menu
with "Copy as Markdown" and "Copy as Rich Text", then, when text is selected in the
document, a separator and a plain "Copy" row for that selection; the browser's own menu
is suppressed only while the host has such a menu to show, see §3.10).

Both bail silently when the last load failed (`didLoadSuccessfully == false`) — you
can't copy the synthetic error blockquote.

- **Copy as Markdown**: the *source* markdown of the whole document with front-matter
  stripped (`stripFrontMatter(text)` in `packages/client/src/content/copy.ts`, the same
  four fence/BOM/64 KiB rules as the daemon's `extractFrontMatter`) → clipboard as plain
  text. (Selection-aware copy was deliberately abandoned; the contract is whole-file.)
- **Copy as Rich Text**: the frame clones the rendered DOM of `#content`, removes all
  `.frontmatter, .frontmatter-raw, .frontmatter-nested` elements (the front-matter
  table breaks rich-text conversion) and all `.code-copy-btn` elements (they'd leak into
  the payload as a stray glyph), **absolutizes every `src` and `a[href]` against the
  document's `<base href>`** (the daemon's `/pane-assets/<paneID>/` route, so a sibling
  `src="diagram.png"` pastes as a daemon URL that keeps working in the paste target),
  and posts `innerHTML` plus the flattened `textContent`. The host writes two clipboard
  flavors, `text/html` and `text/plain`, through `ClipboardItem`, falling back to a
  plain-text write where `ClipboardItem` is missing (`writeRichText` in
  `packages/client/src/content/copy.ts`); there is no RTF flavor in a browser.

The copy request travels pane-header button → a `copyToken` bump on the pane's
`ContentFrame`, which opens the two-item menu; "Copy as Markdown" uses the source text
the daemon already sent every subscriber, "Copy as Rich Text" asks the frame for the DOM
(`collect-rich-text` → `rich-text`, matched by token) and writes what comes back.

### 3.15 Link handling

Clicks on links in the preview do not navigate the pane, except in-document fragment
links (`href` starting `#`), which scroll the document. Every other anchor click is
cancelled inside the frame and posted to the host (`link` message), and the host opens
`http:`, `https:` and `mailto:` URLs outside the pane (`window.open` with `noopener`;
the Electron shell routes that to the system browser) and silently drops every other
scheme, including the `file://` and `ftp://` URLs §3.4 autolinks, because the href is
untrusted content and `javascript:` must never reach `window.open` on the app's own
origin (`openExternalLink` in `packages/client/src/content/bridge.ts`).

### 3.16 Font size (preview only)

Per-pane `markdownFontSize`, adjusted by keybindings (defaults: ⌘= increase, ⌘-
decrease, ⌘0 reset). Rules (enforced by the daemon reducer `set-markdown-font-size` in
`packages/daemon/src/store/reducers/panes.ts`):

- Only when the focused pane is `markdown` AND `isEditing == false` (the plain-text
  editor has a fixed 13 pt monospace font; diff panes currently receive the same
  per-pane value as their base font size but have no bindings to change it).
- Increase: `min(size + 1, 32)`. Decrease: `max(size - 1, 8)`. Reset: 14.
- A change re-renders the current content (no disk read) with absolute scroll restore.

---

## 4. Markdown edit mode

### 4.1 Toggle rules (`toggleMarkdownEdit(paneID)`)

Triggered by keybinding `toggle_markdown_edit` (default **⌘E**), dispatched only when
the focused pane is a markdown pane, by the pane-header edit/preview button (pencil
icon in view mode, eye icon in edit mode; tooltip "Edit (⌘E)" / "Preview (⌘E)"), or by
⌘E pressed inside the preview frame or the editor (both relay it to the host, §3.10).
The client half is `toggleMarkdownEdit` in `packages/client/src/App.tsx`; the daemon half
is `setMode` in `packages/daemon/src/content/service.ts`.

```
pane must exist and be type markdown, else no-op

if pane.externalEditorCommand != null:   // an external editor session is running
    markdown-external-editor {action:"close"}: kill the pane's PTY and dispose its
    terminal, isEditing = false, externalEditorCommand = null
                                         // the file watcher reloads on-disk changes
else:                                    // built-in editor only
    content.setMode(view ⇄ edit)         // wire: content-set-mode
    entering edit: if the search overlay is on this pane, close it (clear
                   needle/counts + JS marks); suspend the file watcher; seed the
                   daemon's edit buffer from the last-read content (unless the
                   buffer is already dirty)
    leaving edit:  flush the pending autosave, re-read the file from disk, resume
                   the watcher
```

⌘E never resolves `$EDITOR`. The external editor is a separate gesture: the "$EDITOR"
chip drawn bottom-right over the preview (`MarkdownPane.tsx`, aria-label "Open in
$EDITOR"), which sends the wire command `markdown-external-editor {pane_id,
action:"open"}` (`packages/daemon/src/ws/desktop.ts`). `open` resolves the editor (§6;
it awaits the probe if warm-up has not finished), fails with "no $VISUAL or $EDITOR is
set" when nothing resolves (there is no silent fallback to the built-in editor on this
path), kills any previous PTY on the pane so a re-entered editor never replays the last
session's screen, dispatches `set-markdown-editing` with `externalEditorCommand`, and
spawns the pane's PTY running the command with cwd `pane.workingDirectory` and the
workspace profile env every terminal pane gets. The spawn waits for the client's own
measurement of the pane when a client is attached (the editor is as unreflowable as a
shell prompt); a spawn failure logs, clears `isEditing`, and replies with the error.
This is a deliberate departure from the pre-port app, which preferred the external editor
whenever one resolved: Kelpi ships a real built-in editor, and silently swapping it for
`vim` on a machine where `$EDITOR` happens to be set would be the worse surprise.

While `isEditing` is true the pane body renders:

- `externalEditorCommand != null` → a full terminal surface running the user's `$EDITOR`
  on the file. When that process exits, the pane flips back to view mode automatically
  (see 2.4) and the file watcher picks up saved changes. ⌘E or `action:"close"` ends
  the session the same way.
- else → the built-in plain-text editor (4.2).

### 4.2 Built-in editor behavior

A plain-text (never rich), monospace 13 px editor (`PlainTextEditor` in
`packages/client/src/content/PlainTextEditor.tsx`, a `textarea`; shared with scratchpads)
with:

- Undo enabled (the textarea's own); spellcheck, autocorrect and autocapitalize
  disabled. No find bar: `toggle_search` over a markdown pane in edit mode declines
  (`toggleSearch` in `packages/client/src/App.tsx`) and the chord falls through to the
  host.
- Content: the raw file bytes as UTF-8. A read failure seeds the edit buffer with the
  same `> Failed to load file: <path>` blockquote the preview renders (§3.11), and
  `setMode('edit')` re-seeds from that content; this is still a known sharp edge, the
  first keystroke autosaves that text over the file.
- **Tab** (unmodified) inserts a `\t` at the caret rather than moving focus; ⇧Tab and
  any modified Tab are left to the browser as navigation. `tab-size` is 4.
- **Wrapping**: the markdown editor soft-wraps to the pane (`wrap="soft"`); the
  scratchpad editor does not (`wrap="off"`, a horizontal scrollbar instead, see §7).
- **Metrics**: an 8 px inset on every side and a fixed 16 px row height, shared with the
  gutter so the numbers and the rows never drift.
- **Line-number gutter**: right-aligned line numbers (1-based), 11 px monospace,
  gutter min width 36 px, growing to fit the largest line number + 8 px gutter
  padding + 4 px text padding. Gutter background = pane-header chrome color; number
  color = tertiary chrome text color. A trailing newline shows an extra final line
  number; an empty document shows "1". Line count = number of `\n` + 1.
- **Autosave**: the client coalesces keystrokes for 300 ms (`CONTENT_TEXT_DEBOUNCE_MS`
  in `packages/client/src/content/client.ts`) before sending the buffer to the daemon
  as `content-set-text`; on receipt the daemon (re)starts a 500 ms debounce timer
  (`EDITOR_AUTOSAVE_DEBOUNCE_MS` in `packages/daemon/src/content/editor.ts`) and, on
  fire, writes the whole buffer to `filePath` atomically (temp file + rename, preserving
  the original mode). A write therefore lands up to ~800 ms after the last keystroke.
  The client also flushes whatever the 300 ms window still holds when the textarea
  loses focus or unmounts (⌘E back to preview, workspace switch). Write errors are
  logged, not surfaced; the buffer stays dirty so the next keystroke or the shutdown
  flush retries.
- **Buffer authority**: the daemon's buffer is authoritative, not any client's.
  `setText` updates it and restarts the debounce without notifying subscribers; other
  clients viewing the same pane receive the new text only when the save fires
  (`onSaved` → re-render + emit), and the typist's own textarea adopts an incoming
  buffer only while it is unfocused, so a keystroke is never moved or lost mid-edit. A
  dirty buffer keeps its entry alive after the last client unsubscribes, until the
  write lands or the shutdown flush runs.
- **Quit flush**: at daemon shutdown, `content.flushSync()`
  (`packages/daemon/src/boot/compose.ts`) synchronously saves every dirty buffer before
  the persist gate closes, markdown files and scratchpads alike, so up to 500 ms of
  typing isn't lost (issue #129). A pane that closes mid-edit is flushed on the way out
  (`forget`).
- **Scroll persistence**: same shared fraction store as the preview — scroll fraction
  saved on scroll, restored on build — so toggling ⌘E keeps your place bidirectionally.
- Text/caret color: luminance rule against the ghostty background —
  dark background → near-white text (`white 0.90`), light → near-black (`white 0.12`);
  the editor surface itself is transparent over the pane's ghostty-colored background.
- No file watching in edit mode: the watcher is suspended on entering edit mode, so
  external changes to the file while the built-in editor is open are NOT live-merged
  (last writer wins on the next autosave). Leaving edit mode flushes the buffer,
  re-reads the file and resumes the watcher (`setMode` in
  `packages/daemon/src/content/service.ts`).

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
  `-- <targetPath>` appended when the scope is non-empty. Implementation: spawn the
  first `git` on the daemon's `PATH` (`KELPI_GIT` overrides; the bare name is the last
  resort so a missing git is a normal ENOENT; `resolveGitExecutable` in
  `packages/daemon/src/git/exec.ts`) with cwd = repoPath, capture stdout; non-zero exit
  throws a `GitCommandError` carrying the command, exit code, and trimmed stderr. A
  newer load aborts the previous child through an `AbortSignal` (`getDiff` in
  `packages/daemon/src/git/service.ts`).
- On git failure the pane renders the plain text
  `Failed to run git diff in <repo>:\n<error message>` **through the normal diff
  renderer** (so it appears as loose context lines, not a special error page).
- Empty/whitespace-only diff → centered "No changes" placeholder
  (`<div class="empty">No changes</div>`).

### 5.2 Refresh triggers

The diff re-runs `git diff` when ANY of:

1. `repoPath` or `targetPath` changes: the daemon re-runs git itself when the pane's
   `workingDirectory` or `filePath` moves under a live subscription (`pane-upserted`
   in `packages/daemon/src/content/service.ts`), cancelling the in-flight read first;
2. the header **refresh button** (clockwise-arrow icon, tooltip "Refresh diff") is
   clicked: the client sends `content.refresh(paneID)` (wire verb `diff-refresh`) and
   the daemon re-runs git, re-rendering only when the text changed;
3. the pane transitions unfocused → focused (refresh-on-focus: come back to the diff
   pane and it's current; `DiffPane.tsx`, seeded with the mount-time value so a pane
   that mounts focused does not run git twice);
4. (No equivalent: the sandboxed frame has no reload gesture to remap. Refresh is
   triggers 1-3 only.)

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

`BASE` = baseFontSize px (default 13; the daemon passes `pane.markdownFontSize`, so the
shared per-pane font size applies, default 14). Emitted by `diffStylesheet()` in
`packages/daemon/src/content/diff.ts`; the rules marked S41 are Kelpi's own and are
asserted by `diff.test.ts`:

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
.file-path {
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace; font-weight: 500;
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;   /* S41 */
}
.file-status {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 1px 6px; border-radius: 3px;
    flex-shrink: 0;   /* S41 */
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
    flex-shrink: 0;   /* S41 */
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

(S41: in a narrow split the path is what yields, ellipsized; the status badge and the
+N/-M counts never shrink.)

Same doctype/html-class/head wrapper as markdown (3.7) but the body is the diff HTML
directly (no `#content` wrapper).

Diff panes participate in find-in-page exactly as markdown previews do (§3.13): the same
injected `__kelpiFind`, the same per-pane bar, opened by `toggle_search` when a diff
pane is focused (`DiffPane.tsx` passes `findToken` into `ContentFrame`; `toggleSearch`
in `packages/client/src/App.tsx` admits `pane.type === 'diff'`).

---

## 6. EditorService ($VISUAL/$EDITOR resolution for external edit mode)

Purpose: resolve the user's terminal editor for the "Open in $EDITOR" gesture (§4.1)
and build the exact shell command to run it. A GUI-launched daemon doesn't inherit the
login shell env (the packaged app's daemon inherits the Electron shell's minimal env), so
this is done by interrogating the user's shell once
(`packages/daemon/src/content/external-editor.ts`).

### 6.1 API

```ts
interface EditorResolver {
  current(): EditorResolution | null;             // { editor: "nvim" | "code -w" …,
                                                  //   path: loginPATH | null,
                                                  //   source: "shell" | "process-env" };
                                                  // null if unresolved / still resolving
  buildCommand(filePath: string): string | null;  // full shell command or null
  warmUp(): void;                                 // kick off async resolution; called
                                                  // once at daemon boot
  resolve(): Promise<EditorResolution | null>;    // await the in-flight (or a fresh)
                                                  // probe
}
```

`current()` / `buildCommand()` are **non-blocking**: null while resolution is in flight
or within the 30 s failure TTL (a stale failure re-arms the probe in the background and
still answers null for that call). `resolve()` awaits the in-flight or a fresh probe and
is what the user-initiated "Open in $EDITOR" command uses, so an explicit open may wait
up to the 2 s watchdog; `warmUp()` at daemon boot makes that rare. With no editor
resolvable the open command fails ("no $VISUAL or $EDITOR is set"); ⌘E does not consult
the resolver at all (§4.1).

### 6.2 Resolution algorithm

1. Determine the user's login shell: passwd database (`os.userInfo().shell`) → `$SHELL`
   env → `/bin/sh`.
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
`/usr/bin/env PATH=…` prefix is kept byte-for-byte: the command is handed to a shell as
`sh -c '<command>'` (the pre-port runtime wrapped it as `bash -c "exec -l <command>"`,
where `exec` won't parse a bare `VAR=value` prefix as an assignment), and `env` is a
real binary so it works in both, which also means a pane's `externalEditorCommand` reads
identically to one written before the port. The captured login `$PATH` is injected so
the editor binary is findable in the minimal env a GUI-launched process gets; no nested
login shell is spawned at launch time (that would cost 1-2 s of rc-file sourcing per
open).

The resulting command is spawned as the pane's PTY with cwd = `pane.workingDirectory`
and the workspace profile env; process exit returns the pane to view mode (see
2.4/4.1).

---

## 7. Scratchpad panes

An in-memory plain-text editor. Content is NEVER written to disk; every change is
reported to state (`scratchpadContentChanged(paneID, content)` → sets
`pane.scratchpadContent`) which the debounced persistence layer stores in the DB's
`pane.content` column. Restart restores the text.

Behavior = the built-in markdown editor (4.2) with these differences:

- **Save target**: instead of writing a file, the client coalesces keystrokes for
  300 ms, then `content-set-text` lands in the daemon's edit buffer, whose 500 ms
  debounce dispatches `scratchpad-content-changed(paneID, content)`; the persistence
  layer then debounces that into the DB. The buffer is flushed on editor blur, on
  unmount, and synchronously at daemon shutdown (`flushSync` covers scratchpads as well
  as markdown files; `flushAll` in `packages/daemon/src/content/editor.ts` saves every
  buffer regardless of target), so the quit-flush gap the pre-port app had is closed.
- **Initial content**: `pane.scratchpadContent ?? ""`, from the daemon's first
  snapshot. The textarea is read-only until that snapshot arrives, so a keystroke into
  the empty pre-load buffer cannot go out as a `content-set-text` that wipes a restored
  scratchpad (`ScratchpadPane.tsx`). While open, the daemon buffer is authoritative and
  an incoming buffer is adopted only while the textarea is unfocused (§4.2).
- No file, no file watching, no view mode: `isEditing` is always true, there is no
  preview/⌘E toggle, no copy-as-markdown, no font-size bindings (fixed 13 px
  monospace).
- Header: note icon, title "Scratchpad", no label chip logic difference, no git
  branch.
- Same line-number gutter, scroll-fraction persistence, undo, transparent
  background over the ghostty-colored pane fill, luminance-based text color. Like the
  markdown editor it has no find bar (`toggle_search` declines for scratchpads and the
  chord falls through to the host). Unlike the markdown editor it does not soft-wrap:
  the scratchpad textarea keeps `wrap="off"` and scrolls horizontally.
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
- **Diff-only button**: refresh (`arrow.clockwise`, tooltip "Refresh diff") → sends
  `content.refresh(paneID)` (5.2).
- **Markdown-only body control**: a "$EDITOR" chip (aria-label "Open in $EDITOR") is
  drawn bottom-right over the preview body, not in the header, whenever the pane is in
  view mode; it sends `markdown-external-editor {action:"open"}` (§4.1;
  `packages/client/src/content/MarkdownPane.tsx`). There are no font +/- header buttons:
  preview font size is reachable only through the ⌘= / ⌘- / ⌘0 bindings (§3.16).
- Standard buttons (split right / split down / close) follow.
- Context-menu "Open in Finder"-equivalent: markdown reveals `filePath`; diff reveals
  `filePath` when non-empty, else opens `workingDirectory`; others open the working
  directory.

Pane body background (behind any content pane's transparent view): the ghostty
terminal background color at ghostty background opacity — this is what makes content
panes blend with the terminal theme (see 3.8).

---

## 9. Scroll-position store (shared)

A process-wide (client-side, in-memory, not persisted) map
(`contentScrollStore` in `packages/client/src/content/scroll.ts`):

```ts
scrollPositions: Map<paneID, { top: number; fraction: number }>
  // top:      absolute offset in CSS px, restored on a same-mount reload
  // fraction: 0..1 of max scroll, restored on a fresh build (§3.11 precedence)
```

Writers: markdown preview (JS scroll events → `{top, fraction}`), markdown editor +
scratchpad (textarea scroll → `scrollTop / maxScroll`, only when maxScroll > 0), diff
pane (JS scroll events). Readers: each view on build (and the frames again on every
`ready`). `clear(paneID)` exists for cleanup. Because it's keyed by pane id and outlives
view rebuilds, position survives workspace switches and view/edit toggles, but not app
restarts. Components take a `scrollStore` prop so a test can hand them an isolated one.

---

## 10. RecursiveFSWatcher (directory watcher service)

Not used by content panes (the markdown preview uses its own single-file watcher,
§3.12); it drives Graft's worktree mirroring, but it is spec'd here for completeness.
It lives in `packages/daemon/src/graft/watcher.ts` (`watchRecursive`) and is specified
authoritatively in graft-git.md §9.1; its contract:

- `watchRecursive({ root, onBatch, debounceMs = 500, ignored = [".git", "node_modules", "target", ".DS_Store"] }) → { close(), flush(), watching, pending }`
  Recursive watch over `root` (a recursive, non-persistent `fs.watch`). Events are path
  strings; a path is dropped if ANY of its `/`-separated components is in `ignored`.
  Filtering runs on the path **relative to the root** (a worktree that lives under a
  directory called `target` is still watched); the emitted paths are absolute.
- **Debounced batching**: changed paths accumulate in a set; each new event resets the
  trailing debounce timer; after `debounceMs` of quiet the batch is handed to `onBatch`
  as a **sorted, deduped array**. Empty batches are never emitted.
- `close()` tears the watch down and drops any pending batch (a final partial batch may
  be silently dropped). `flush()` emits the current batch immediately (used by tests).
- Zero cost at rest (event-driven). One recursive `fs.watch` handle per active watch.
- Test seam: the `watch` option replaces the OS watcher with a fake whose injected
  events go through the same component filter and the same debounce; `flush()` collapses
  the wait.

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
- Link clicks on `http:`/`https:`/`mailto:` leave the app (system browser); other
  schemes are dropped; only an in-document `#fragment` link moves the preview, and the
  preview never navigates to another document (§3.15).
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

## Compatibility rationale

These items record quirks and design choices preserved on purpose, so that the pre-port
`kelpi` CLI, hook scripts and saved state keep working and so the code's oddities read
as decisions rather than accidents.

1. **Where rendering happens.** The **daemon** owns the pane model, file reading, file
   watching, git invocation, and the markdown/diff → HTML transformation (so all clients
   render identically and the CLI could someday reuse it); the **web client** owns scroll
   state, find-in-page, the bridge JS (copy button, links, chords), and clipboard
   access (`packages/daemon/src/content/`, `packages/client/src/content/`). The
   HTML/CSS/JS contracts in §3.9/3.10/3.13/5.4 are the compatibility target regardless
   of where they're produced.

2. **Markdown parser parity.** The pre-port renderer was cmark-gfm underneath. Kelpi
   parses with markdown-it (CommonMark + GFM tables/strikethrough) and emits the HTML
   itself (`renderTokens` in `packages/daemon/src/content/markdown.ts`) to match §3.3
   exactly (class names, attribute order need not be byte-identical, but
   classes/structure must match the CSS and copy-button JS). Note the non-standard
   bits: the `code-block` wrapper + copy button, task-list markup, autolink scheme
   allowlist (§3.4: GFM autolink extension semantics, which link bare domains, are
   deliberately NOT used; markdown-it's `linkify` is off), and raw-HTML passthrough.

3. **Raw HTML / sanitization.** Raw HTML passes through unsanitized into an iframe
   sandboxed to `allow-scripts` only, whose only host bridges are the `postMessage`
   channel in `packages/client/src/content/bridge.ts` (scroll/find/copy/link/focus/
   chords). `allow-scripts` and `allow-same-origin` are never both set. The behavior is
   preserved (users rely on inline HTML in notes) but pane content cannot script
   against the app shell.

4. **Relative resources.** The daemon serves sibling files of an opened markdown file
   on a scoped, credentialed static route (`/pane-assets/<paneID>/`) and emits
   `<base href>` for it, so relative images work even though the frame is loaded
   through `srcdoc` (a plain `srcdoc` iframe would resolve them against the client
   page); copy-as-rich-text resolves relative URLs against the same base (§3.14). The
   client re-inserts the `<base>` tag if a document lacks one.

5. **Clipboard.** `navigator.clipboard.writeText` for plain text; copy-as-rich-text
   writes both `text/html` and `text/plain` flavors via `ClipboardItem` (browsers can't
   write RTF; the HTML flavor is the practical equivalent and pastes fine into rich
   editors), falling back to plain text where `ClipboardItem` is missing. Front-matter
   and copy-button stripping are kept (§3.14).

6. **File watching.** The single-file watcher is `fs.watch` on the file itself
   (`packages/daemon/src/content/watcher.ts`) with the 200 ms re-attach delay for the
   vim rename dance and the unchanged-content short-circuit. Watchers live in the
   daemon; pushes to clients are `content-updated` events carrying the new state and
   rendered document.

7. **Autosave authority.** The built-in editor's 500 ms debounced write and the
   preview's file watcher form a loop through the filesystem; echo is avoided because
   view and edit modes never run simultaneously for one pane (edit mode suspends the
   watcher). With multiple clients attached to one daemon, the daemon arbitrates: its
   edit buffer is authoritative and other clients viewing the same pane follow the
   autosaved writes (§4.2). The quit-flush runs at daemon shutdown and covers
   scratchpads as well as markdown files (§7), closing the ~1 s (editor debounce + DB
   debounce) loss the pre-port app had on a hard kill.

8. **External editor mode.** Resolution (§6.2: login+interactive shell probe with
   sentinels, concurrent pipe drain, 2 s watchdog, 30 s failure TTL) runs in the daemon
   (`child_process.spawn` + `os.userInfo().shell`); "spawn a surface running the
   command" means the daemon points the pane's PTY at the editor command; process-exit
   flips the pane back to view mode. The non-blocking contract of `current()` and
   `buildCommand()` still holds; the explicit "Open in $EDITOR" command is the one path
   that awaits `resolve()`, and ⌘E never stalls on shell init because it never
   consults the resolver (§4.1). The command format is byte-for-byte the pre-port one
   so a persisted `externalEditorCommand` reads identically (§6.3).

9. **Theme source.** Light/dark is derived from the ghostty background color's
   luminance, NOT the OS theme. The web client computes `isDark` from the same
   config-provided color (`ghosttyBucket` in `packages/client/src/chrome/theme.ts`) and
   paints the pane container with `rgba(bgColor, bgOpacity)` behind the document; the
   sandboxed frame additionally gets that fill flattened to an opaque colour (§3.8).
   The daemon re-renders on config change.

10. **Refresh is a request, not client state.** There is no per-pane refresh token;
    "refresh" is a client → daemon `content.refresh(paneID)` request (wire verb
    `diff-refresh`), refresh-on-focus is kept in `DiffPane.tsx`, and the reload-gesture
    remap has no equivalent because the sandboxed frame has no reload gesture (§5.2).

11. **Scroll store.** Client-side and per-pane-id (`packages/client/src/content/scroll.ts`);
    it survives workspace switches (component unmount/remount) but not a page reload.
    It holds both an absolute `top` and a `fraction` so the two restore paths of §3.11
    each get the unit that is truthful for them.

12. **Find-in-page.** The JS in §3.13 is plain DOM, injected as part of the bridge
    script. The host-side needle cache + reapply-after-reload, the markdown/terminal
    palette match (now user-overridable), and the force-close on entering edit mode
    are all kept. Result posting is a `postMessage` to the client, which updates the
    per-pane search overlay (`total`, `current`; -1 current not forwarded; total 0
    clears selection).

13. **Known quirks knowingly preserved:**
    - Built-in editor read failure puts the `> Failed to load file: …` blockquote
      into an *editable* buffer that autosave will happily write to the file on the
      first keystroke (§4.2).
    - Markdown non-reuse open doesn't unzoom first (diff/scratchpad do); marked as a
      quirk in `openMarkdownPane`.
    - Diff `extractFilePath` breaks on paths whose name contains `" b/"`; statuses/
      counts are line-prefix heuristics (fine for `git diff --no-color`, not for
      arbitrary input).
    - `backgroundOpacity` is threaded into both renderers but unused inside them
      (transparency + container fill made it moot); the parameter is kept for parity
      (`ContentAppearance` in `packages/daemon/src/content/html.ts`).
    - Diff panes share `markdownFontSize` as their base font (falling back to
      `DEFAULT_DIFF_FONT_SIZE` when the pane has none) but have no bindings to change
      it (bindings are markdown-view-only), so diffs render at the pane's default
      14 px in practice.

14. **CLI compatibility.** The `open` and `diff` wire commands (and `--here` reuse
    semantics, including pane parking/unparking) are part of the frozen wire protocol
    the existing `kelpi` CLI expects (`packages/daemon/src/handlers/app/files.ts`).
    Parking (`parkedPanes` lane keeping the PTY alive off-layout, restore-on-close)
    exists in the daemon's workspace model (`packages/daemon/src/store/reducers/panes.ts`).
