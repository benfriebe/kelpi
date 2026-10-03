# CSV Pane

Behavioural specification of Kelpi's native `csv` document pane (issue #324): a table view
and editor for `.csv` and `.tsv` files that stays responsive on files of any size, edits
cells, rows and columns in place, sorts and searches without loading the file into memory,
and works the same on a phone. It sits beside the other native document types described in
[content panes](content-panes.md) (markdown, scratchpad, diff) and shares their pane model,
placement path, renderer selection and plugin contract.

The design rule that shapes everything below: **a csv pane never moves a whole file**. Every
other content pane holds its source as one string in the daemon and sends that string to the
client. A csv pane does not. The daemon indexes the file once, serves rows by range in the
pane's view order, takes row-level edits, and writes them back by streaming the untouched
bytes of the original file around the edited rows. The client holds only the rows on screen.
The one exception is raw-text mode (⌘E), which is offered only for files small enough to
edit as text (§6.7).

Source files this spec describes (TypeScript):

- `packages/protocol/src/csv.ts`: the contract. Shapes, limits (`CSV_LIMITS`), verbs
  (`CSV_COMMANDS`), error codes and the shared validators.
- `packages/daemon/src/content/csv/channel.ts`: `CsvChannel`, the seam between the service
  and its callers (WS hub, plugin documents, content service, boot).
- `packages/daemon/src/content/csv/open.ts`, `dialect.ts`, `scan.ts`, `record.ts`: opening,
  dialect detection, the chunked scanner and record index, parse and serialise.
- `packages/daemon/src/content/csv/overlay.ts`, `undo.ts`, `writer.ts`: the edit overlay,
  undo history and the streaming writer.
- `packages/daemon/src/content/csv/sort.ts`, `find.ts`: view sort and find.
- `packages/daemon/src/content/csv/document.ts`, `service.ts`: one document per file, and the
  service that maps panes to documents, schedules saves and watches files.
- `packages/daemon/src/ws/sync.ts`: the `csv-*` WS verbs and `csv-updated` pushes.
- `packages/daemon/src/plugins/documents.ts`: the plugin and CLI `csv-*` document methods.
- `packages/daemon/src/content/service.ts`: the raw-text (⌘E) branch for csv panes.
- `packages/daemon/src/handlers/app/files.ts`, `packages/daemon/src/ws/desktop.ts`: opening
  by extension from the socket `open` and from a ⌘-click in a terminal.
- `packages/daemon/src/store/reducers/panes.ts`, `packages/daemon/src/db/schema.ts`: the pane
  type, `csvHeaderRow`, `set-csv-header-row`, and migration `v23_pane_csv_header_row`.
- `packages/client/src/content/csv/csv-client.ts`, `scroll-map.ts`, `CsvGrid.tsx`,
  `CsvPane.tsx`: the client's row cache, the scroll mapper, the grid and the pane body.
- `packages/cli/src/routing.ts`, `packages/cli/src/commands/openmd.ts`,
  `packages/cli/src/commands/document.ts`: CLI routing and the `kelpi document` csv actions.
- `packages/shell/src/main.ts`, `packages/shell/src/shell-actions.ts`,
  `packages/shell/forge.config.cjs`: File ▸ Open…, Finder forwarding and the bundle's
  document types.
- `packages/plugin-sdk/documents.d.ts`, `packages/plugin-sdk/api.js`: `documents.csv`.

---

## 1. Data model

### 1.1 Pane fields

A csv pane is an ordinary `Pane` with `type: "csv"`:

```ts
interface Pane {
  type: "csv";
  label?: string;              // the file's basename, set at open
  title?: string;              // the file's basename
  workingDirectory: string;    // the file's parent directory
  filePath: string;            // absolute path of the .csv/.tsv file
  isEditing: boolean;          // TRANSIENT: true while the pane shows raw text (⌘E)
  csvHeaderRow: boolean;       // PERSISTED, default true: logical row 0 is the header row
  parkedSourcePaneID?: string; // TRANSIENT, as for markdown (`--here`)
  // ... shared pane fields (id, gitBranch, createdAt, lastActivityAt, ...)
}
```

- `isEditing` reuses the markdown field: grid mode is `false`, raw-text mode is `true`. It is
  transient like markdown's, so a restart always reopens a csv pane in grid mode. The
  `set-markdown-editing` reducer accepts csv panes as well as markdown panes.
- `csvHeaderRow` is the pane's choice, not the file's. Two panes on one file can disagree. It
  changes through the store action `set-csv-header-row {workspaceID, paneID, on}` (reached by
  the `csv-set-header-row` verb, the pane-chrome toggle and the plugin/CLI `csv-header-row`
  method), which also updates a parked pane.
- Sort order, column widths, scroll position, selection and the find needle are per client
  and in memory only. None of them is persisted or synced.

### 1.2 Persistence

- `pane.type` is free text in SQLite; csv panes store `"csv"`.
- `pane.csvHeaderRow` is `BOOLEAN NOT NULL DEFAULT 1`, added by the daemon-only migration
  `v23_pane_csv_header_row` ([persistence](persistence.md)). Every existing row reads back as
  on, which means nothing for other pane types.
- Not persisted: `isEditing`, the sort, the undo history and anything held in the daemon's
  document. Unsaved edits are flushed to the file on every shutdown path (§3.8) rather than
  stored anywhere else.
- An older build that meets a `csv` row decodes the unknown type as an unavailable plugin pane
  and shows a placeholder, preserving the row; opening the database in a newer build brings
  the pane back.

### 1.3 Closed-pane snapshots

`ClosedPaneSnapshot` carries `csvHeaderRow`, so ⌘⇧T reopens a csv pane with the same header
choice (and, like every reopen, in grid mode).

### 1.4 Panes and documents

A pane is a view; the file's contents live in a **document**. The daemon keeps one
`CsvDocument` per file, keyed by its real path and `(dev, ino)`, and every pane showing that
file shares it. Edits from any pane, the CLI or a plugin land in the one document, and every
subscribed client sees them. What differs per pane is its **view state**: the header-row flag
and the sort permutation.

### 1.5 Addressing

Three coordinate systems, and the contract keeps them apart:

| Coordinate | Meaning | Used by |
| --- | --- | --- |
| **view index** | position in this pane's view order (its sort, the header row pinned at view 0 when on) | `csv-rows` requests, find steps, scrolling |
| **logical row** | position in file order; unchanged by sorting or saving | every edit, undo, find matches |
| **column id** | a stable number per column; `columns` lists them in display order | every edit except `insert-column.at`, which is a display index |

Each row of a `csv-rows` reply carries both its `view` and its logical `row`, so a client can
always turn what it shows into what it edits. The header row, when present, is logical row 0
and is edited like any other row.

`generation` (`"${incarnation}:${n}"`) names the shape of the document: it bumps when logical
row indices or the column set change (row or column insert or delete, an undo or redo of one,
a reload). Saving and sorting never change it. Every `csv-edit` carries the generation its ops
were computed against (§3.6). `revision` is a plain counter that bumps on every change a
client could render; a client drops any state older than the one it holds. `incarnation`
changes whenever the document is (re)opened.

---

## 2. Opening csv panes

### 2.1 Routing by extension

A path opens as a csv pane when its extension is `csv` or `tsv`, case-insensitively
(`isCsvPath` and `CSV_OPEN_EXTENSIONS` in `@kelpi/protocol`; `.CSV` counts, `.csv.gz` does
not). Everything converges on the same store action as markdown, `open-markdown-pane`, with
`paneType: 'csv'`, so `--here` parking, split placement, background opening and focus
behave exactly as [content panes §2.1](content-panes.md) describes. Label and title are the
basename; `workingDirectory` is the parent directory; the git branch is detected the same way.

| Entry point | What happens |
| --- | --- |
| `kelpi open [--here] [--focus] data.csv` | The CLI sends the ordinary `open` wire command; the daemon picks the csv pane by extension ([cli](cli.md) §13.4). |
| `kelpi md [--here] [--focus] data.csv` | Sends `open` with `as: 'markdown'`: the file opens as markdown source, not a table ([cli](cli.md) §13.5). |
| Socket `open` from any client | Routes by extension unless `as: 'markdown'` ([wire protocol](wire-protocol.md) §6.6, [socket handlers](socket-handlers.md) §8.1). |
| ⌘O / File ▸ Open… | The native panel (title "Open File") offers "Markdown and CSV" (`md`, `markdown`, `csv`, `tsv`), "Markdown" and "CSV" filters; the answer goes out as `open`. |
| Drag and drop | A `.csv`/`.tsv` dropped outside a terminal pane opens like a dropped `.md`. Dropped onto a terminal pane, its path is typed into the pane, as for every file. |
| Finder "Open With → Kelpi" | The bundle declares a "CSV Document" type (Editor, rank Alternate) over the system UTIs `public.comma-separated-values-text` and `public.tab-separated-values-text`; the shell forwards `.csv`/`.tsv` (`OPEN_FILE_EXTENSIONS`). Kelpi joins Open With without taking the default from Numbers or Excel. |
| ⌘-click a path in a terminal | A `.csv`/`.tsv` token opens a csv pane (reply `opened: 'csv'`); `.md` stays case-sensitive as before. |
| Plugin `files.open(path)` | Sends `open`, so it routes by extension too. |

A markdown pane opened on a csv file with `kelpi md` is not coordinated with a grid on the
same file; that is the same last-writer-wins relationship two markdown panes on one file
already have.

### 2.2 What a new pane shows first

The pane subscribes (`csv-subscribe`) and the daemon opens the document if no other pane has.
Rows are readable as soon as the first chunk is indexed (`loaded: true`), while the scan
continues; the status line shows progress ("Indexing… 1.2M rows"). Edits, sort and find wait
until the scan finishes (`scanning: null`), and say so.

---

## 3. The daemon engine

### 3.1 Open checks

- The file is opened `O_RDONLY | O_NONBLOCK` and `fstat`ed: only a regular file (`S_ISREG`)
  is accepted. A FIFO, device or directory is refused with an error state, read-only reason
  `not-regular`, so opening a named pipe never blocks the daemon.
- `(dev, ino, size, mtimeMs)` are recorded at open, and the scan reads only up to that size,
  so a file that keeps growing cannot keep a scan running forever (§3.9 handles the append).
- The real path is resolved once and kept; saves write beside it.
- Orphaned temp files from a crashed save, `.<base>.kelpi-<pid>-*.tmp` siblings whose pid is
  no longer running, are swept.

### 3.2 Dialect

`CsvDialect` = `{delimiter, lineEnding, bom, quoteAll}`:

- **Delimiter**: `.tsv` is tab. Anything else is sniffed over the first 64 KiB among
  `,` `;` tab `|`: the candidate whose records most consistently share the same field count
  (more than one field) wins, quotes honoured exactly as the scanner honours them; comma when
  nothing stands out.
- **Line ending**: the first record terminator's (`\n` or `\r\n`). Edited rows are written
  with it.
- **BOM**: a UTF-8 BOM is skipped for parsing and written back on save. A UTF-16 or UTF-32
  BOM makes the document read-only (`utf16`): only UTF-8 is supported.
- **Quote-all**: when every field of every complete sample record was quoted, edited rows
  quote every field too, so the file keeps its look.

### 3.3 Scan and index

- An async, chunked scan (1 MiB reads, yielding between chunks, cancellable) finds record
  boundaries with the **same quote rule as the parser**: a quote opens a quoted field only at
  the start of a field. Quoted fields may contain delimiters and newlines.
- Each record's start offset goes into a growable, chunked `Float64Array` index, so a file of
  tens of millions of rows costs eight bytes a row and no per-row objects.
- UTF-8 validity is checked for the whole file on boundary-aligned slices. Invalid bytes make
  the document read-only (`not-utf8`, "not UTF-8").
- A record longer than 16 MiB makes the document read-only (`oversized-record`, almost always
  an unbalanced quote), and row reads cap the bytes they parse per record, so one bad quote
  cannot pull a whole file into memory.
- Progress pushes (`scanning: {rows, bytes, totalBytes}`) are throttled to one per 200 ms.
- An empty file is a valid document with no rows. A final record without a trailing newline
  is a record.

### 3.4 Records

`record.ts` parses one record into fields plus a per-field "was quoted" flag (RFC 4180, lenient
about a stray quote inside an unquoted field) and serialises a row with the dialect: a field is
quoted when it needs to be (delimiter, quote, CR or LF inside), when it was quoted originally,
or always in a quote-all file. Quotes inside a quoted field are doubled. A **ragged** row (fewer
fields than the widest row) reads back with `''` for the missing cells and reports its real
`fieldCount`; it is written back with the fields it has unless an edit gives it more.

### 3.5 Overlay

Edits never rewrite the file in place. The document keeps a piece table over logical rows:
segments that are either `{base: [start, end)}` (untouched rows of the file on disk) or
`{rows: EditedRow[]}` (rows held in memory), plus a column map from display order to stable
column ids. A batch of ops is applied in order to a working copy of the overlay, so a large
paste or a block insert is one pass rather than one copy per op. Rows are copy-on-write: a
copy shares row objects with its source, every blank inserted row is one shared frozen row,
and an overlay copies a row the first time it changes one it does not own, so taking a copy
costs no per-row allocation. A `rows` segment holds at most 4,096 rows, so an insert or split
inside one copies a bounded slice, and a cell edit merges only the segments around it. The
number of segments is bounded by the edits made since the last save, because every save
rebases (§3.7).

### 3.6 Edits, generations and undo

- `csv-edit {generation, ops}` applies up to 1000 ops in order. Ops (`CsvEditOp`):
  `set-cell {row, column, value}`, `insert-rows {at, count, rows?}` (before logical row `at`,
  `at === rowCount` appends, `rows` optionally fills them), `delete-rows {start, count}`,
  `insert-column {at}` (an empty column before display index `at`), `delete-column {column}`,
  `undo`, `redo`. The `insert-rows` counts of one batch add up to at most 100,000.
- **A batch is atomic.** Its ops run on a working copy of the overlay over a pinned base; the
  live overlay changes only when the whole batch has applied. A failing op (out of range, a
  deleted column) drops the copy: nothing of the batch is applied, the undo history (including
  any `undo`/`redo` in the batch) is as it was, and the unsaved-edit count is unchanged. A
  synchronous save that lands while a batch is reading (a pane close, the quit pre-flight,
  SIGTERM) writes only whole batches; the batch's ops then replay onto the rebased file.
- **Stale edits**: the daemon keeps the last 64 structural ops. An edit computed against an
  older generation of the same incarnation is translated forward through them (an inserted row
  above shifts the target down, and so on). If its target row or column was deleted since, the
  batch rejects with `CSV_GONE`; if its generation is older than the log or from another
  incarnation, with `CSV_STALE`. Nothing in a rejected batch is applied.
- Clients send one batch at a time and wait for its reply before sending the next, so their
  own edits never race each other.
- **Undo/redo** are inverse ops in logical space (`set-cell` restores the old value; an insert
  and a delete undo each other, the delete keeping the removed rows' or column's values). They
  are not generation-guarded: an `undo` from any client undoes the document's last change.
- History is capped at 64 MiB per document. An op whose inverse would not fit (deleting a
  column of a multi-million-row file, say) clears the history when its batch is applied, and
  the pane says so first ("This can't be undone").

### 3.7 Writer and rebase

There is one save pipeline per document. A generator yields Buffers:

- untouched base segments are **byte-copied** from the open file, so an unedited row is
  written back byte for byte (quoting, spacing and line endings included);
- edited and inserted rows are serialised with the dialect;
- a non-identity column map (a column inserted or deleted) re-serialises every row;
- a final row without a trailing newline followed by appended rows gets its terminator, and a
  file without a trailing newline keeps none when its last rows are deleted (the new last row
  is copied up to its terminator).

The writer builds the new record index as it writes. Before writing, and again right before
the rename, it re-checks the base file (`fstat` of the open fd, and the path's real path and
inode); a mismatch is a conflict (§3.9). The output goes to `.<base>.kelpi-<pid>-<n>.tmp`
beside the real path with the original file's mode, and is renamed over it (the same
conventions as the markdown editor's atomic write); a failure removes the temp file.

After the rename the document **rebases**: it opens the new file, swaps in the new fd and
index, resets the overlay to identity and closes the old fd. No inode is held after a save, the
overlay never grows without bound, and logical row indices are unchanged by a save.

### 3.8 Saving and flush paths

- **Autosave**: 500 ms after the last edit for files under 16 MiB; above that, 5 s idle with
  a 30 s maximum interval. Never more than one save in flight; edits during a save schedule
  another.
- **Async writer** (autosave, large-file flushes) carries an abort token. The **sync writer**
  runs only where the process cannot wait.
- **SIGTERM**: aborts any in-flight async save, deletes its temp file, then writes every dirty
  document synchronously.
- **Quit pre-flight** (`flush-saves-request`, the shell's 750 ms budget) and **pane close**
  (`prepareClose`): files under 16 MiB save synchronously, and a failed save refuses the close
  like a markdown pane's; larger files start (or keep) the async save, let the close proceed,
  and keep the document alive until the save lands. With no pane left, a background failure is
  broadcast as a client `notification` (kind `agent-error`, one per file: a desktop
  notification, or an in-app toast): "Couldn't save data.csv" when the save keeps failing (the
  edits stay in memory and the next flush, on shutdown, tries again), or "data.csv changed on
  disk" when the file was rewritten in place and the edits were discarded.
- `csv-discard` drops unsaved edits and reloads from disk: the escape hatch when a save keeps
  failing.

### 3.9 Watching and external changes

Watcher events are coalesced, with one rescan in flight. The document's own writes are
recognised by the post-rename `(ino, size, mtimeMs)` and ignored.

Growth on the same inode is treated as an append only when every byte already indexed is
unchanged. Each scan (and each save) records a **fingerprint** of the indexed bytes: a hash of
the first 64 KiB, of sixteen 4 KiB windows spread evenly over the rest, and of the last 4 KiB,
taken from the bytes as they were scanned. A grown file must reproduce every window at the
same offsets before only its tail is scanned; otherwise it is reloaded as an in-place rewrite.
A growth noticed while a scan is still running (the scan stops at the size it started with) is
checked again once the scan ends, so a file an agent keeps appending to still finishes
indexing instead of restarting from byte 0.

| What changed on disk | Document clean | Document dirty or saving |
| --- | --- | --- |
| Path replaced (new inode, e.g. another program's atomic save) | Rescan; the pane keeps its top row | Our save wins: the base inode is intact, so pending edits still apply and are written over the new file (markdown's last-writer-wins) |
| Same inode rewritten in place (detected by the `fstat` before each read batch and save) | Rescan | Unsaved edits cannot be applied safely to bytes that moved: they are dropped, the file is rescanned, and the pane shows "The file changed on disk; N unsaved edits were discarded." (`notice`) |
| Same inode grown (an append: the fingerprint still matches) | Only the tail is scanned | As for an in-place rewrite |

### 3.10 Shared documents and raw-text hand-off

- Documents stay alive while any pane on the file exists (switching workspaces does not
  release them). A clean document with no subscribers for 10 minutes is dropped, and a memory
  budget evicts the least recently used clean documents first.
- A per-document serial queue orders edits, saves, sorts and reloads, so a save never sees a
  half-applied batch.
- **Raw text (⌘E)** has a single owner, the content service's `setMode`. Going to raw mode
  awaits `CsvChannel.prepareRaw(paneID)`, which refuses over 2 MiB or when the document is
  read-only, aborts and flushes any save, and stops watching; other panes on the same file go
  read-only (`raw-elsewhere`). It resolves with the document's pinned real path and inode
  (`CsvRawTarget`), and the raw text is read from and saved to that real path, never through
  the pane's path, so a symlink retargeted after the grid opened the file cannot split the two.
  The read refuses a file whose inode is no longer the one handed off, and stops one byte past
  2 MiB, so a file that grew after the size check is refused rather than read whole. Only then
  is `set-markdown-editing` dispatched. Coming back flushes the text buffer, dispatches, then
  awaits `afterRaw(paneID)`, which reopens the same real path, rescans and makes the other
  panes writable again. While a pane is in raw mode, grid edits on it reject with
  `CSV_READ_ONLY`, and the content service rejects `setText`/`save`/`refresh` on a csv pane
  that is not in raw mode.

### 3.11 Sort

Sorting is a property of the pane's **view**, never an edit: the file is not reordered.

- `csv-sort {column, direction}` builds a `Uint32Array` permutation of logical rows; `column:
  null` returns to file order. With a header row, view 0 stays logical row 0 and is excluded.
- Keys are pre-parsed once: a category (number < text < empty), numbers in a `Float64Array`,
  an ASCII fast path for text, and `Intl.Collator` (numeric) only for non-ASCII. The sort is
  stable by logical row.
- Large files sort externally in 200,000-row batches: one batch stays in memory, further
  batches spill to a private (0700) per-process directory under the user cache directory
  (`~/Library/Caches/kelpi/csv-sort`, or `$XDG_CACHE_HOME/kelpi/csv-sort`), swept at boot. A
  full disk is a sort error, not a crash.
- Sorting is async and cancellable; while it runs, `sort.pending` is true and rows come back
  unsorted. A structural edit (row or column insert or delete) clears the sort; a cell edit
  keeps the permutation, so an edited row stays where it is until the next sort.

### 3.12 Find

- `csv-find {query}` scans the document in file order and collects matching cells (a cell
  matches when it contains the query) into sorted `Uint32Array`s of `(row, column)`, mapped to
  view order through the inverse permutation. Results are cached per document, an LRU of four
  queries shared by every client, so two panes searching the same text share one scan.
- Collection stops at 1,000,000 matches (`truncated: true`; the count reads "1,000,000+").
- A scan stops early when the document changes under it and is retried against the new
  revision; after two retries the partial result is returned with `complete: false`.
- `csv-find-step {query, direction, from}` returns the next or previous match from a view
  position by binary search, with its 1-based `index` among all matches once known.
- An empty query is valid and matches nothing.
- Clients highlight visible matches from their own row cache; the daemon only answers counts
  and steps.

### 3.13 Reading rows

`csv-rows {start, count, column_start?, column_count?}` returns at most 500 rows by 256
columns in view order. A reply stops adding rows once it carries 2 MiB of cell text (200 KiB
on the plugin path) and returns `nextStart`; a cell over 64 KiB is sent cut, its index listed
in `truncated`, and is read-only in the grid. Each read batch `fstat`s the base file first,
which is where an in-place rewrite is noticed. The reply's `columnIDs`, and the cells under
them, come from the overlay the records were read through, so a save or column edit that
lands during the read cannot shift cells under the wrong ids.

---

## 4. Wire

The csv verbs are WS-only, like the content verbs: they are matched before the wire decode,
answer through `command-reply` when their promise settles, and are not socket commands. Every
payload carries `pane_id`; fields are snake_case on the wire.

| Verb | Payload | Reply |
| --- | --- | --- |
| `csv-subscribe` | none | `{ok, pane_id, state}`, then `csv-updated` pushes |
| `csv-unsubscribe` | none | `{ok, pane_id}` |
| `csv-rows` | `start, count, column_start?, column_count?` | `{ok, pane_id, rows: CsvRowsReply}` |
| `csv-edit` | `generation, ops: CsvEditOp[]` | `{ok, pane_id, state}` |
| `csv-sort` | `column: number \| null, direction?` (`asc` default) | `{ok, pane_id, state}` |
| `csv-find` | `query` | `{ok, pane_id, find: CsvFindReply}` once complete |
| `csv-find-step` | `query, direction (next\|previous), from?: {view, column}` | `{ok, pane_id, step: CsvFindStepReply}` |
| `csv-set-header-row` | `on: boolean` | `{ok, pane_id, state}` (persisted per pane) |
| `csv-discard` | none | `{ok, pane_id, state}` |

`csv-updated` (`{type: 'csv-updated', paneID, state}`) goes only to sessions subscribed to that
pane. `CsvPaneState` carries `paneID, incarnation, revision, generation, filePath, loaded,
scanning, rowCount, columns, bytes, dialect, headerRow, sort, dirty, saving, canUndo, canRedo,
rawEditable, readOnly, error, notice` (see `packages/protocol/src/csv.ts` for each field).
A subscription survives reconnects only by re-subscribing; the client does that on every
reconnect.

**Errors** are thrown as `CODE: message`, the same convention as `DOCUMENT_CONFLICT:`:

| Code | Meaning |
| --- | --- |
| `CSV_STALE` | The edit's generation is from another incarnation or older than the translation log. Re-read and recompute. |
| `CSV_GONE` | The edit's row or column was deleted since its generation. |
| `CSV_READ_ONLY` | The document is read-only (`readOnly`) or the pane is in raw-text mode. |
| `CSV_BUSY` | The file is still being indexed. |
| `CSV_INVALID` | Malformed, or over one of the limits in §5. |

**Validation** is one shared set of decoders in `@kelpi/protocol` (`decodeCsvEditOps`,
`decodeCsvRowsRequest`, `decodeCsvSort`, `decodeCsvFindQuery`, `decodeCsvFindStep`), used by
the WS hub, the plugin documents API and the CLI, so every path refuses the same requests the
same way. Bounds against the document (a row past `rowCount`, an unknown column id) are the
daemon's to check.

---

## 5. Limits

Every bound the daemon enforces is in `CSV_LIMITS`; clients use the same numbers to stay
inside them.

| Limit | Value | Applies to |
| --- | --- | --- |
| `maxOpsPerBatch` | 1000 | ops in one `csv-edit` |
| `maxInsertRows` | 100,000 | the `insert-rows` counts of one `csv-edit`, added up |
| `maxCellBytes` | 1 MiB | one cell value (UTF-8) |
| `maxBatchBytes` | 8 MiB | a whole `csv-edit` payload |
| `maxFindQueryBytes` | 1 KiB | a find query |
| `maxRowsPerRequest` | 500 | rows in one `csv-rows` |
| `maxColumnsPerRequest` | 256 | columns in one `csv-rows` |
| `rowsReplyBudgetBytes` | 2 MiB | cell text in one `csv-rows` reply before `nextStart` |
| `pluginRowsReplyBudgetBytes` | 200 KiB | the same budget on the plugin/CLI path |
| `truncatedCellBytes` | 64 KiB | a longer cell is sent cut and is read-only in the grid |
| `rawEditLimitBytes` | 2 MiB | ⌘E raw text is offered up to this file size |
| `maxRecordBytes` | 16 MiB | a longer record makes the file read-only |
| `maxFindMatches` | 1,000,000 | find stops collecting (`truncated`) |
| `largeFileBytes` | 16 MiB | above this, autosave waits longer and quit/close save in the background |
| `undoBudgetBytes` | 64 MiB | undo history per document |

The plugin and CLI paths also sit inside the plugin transport's 256 KiB JSON cap, so a
`csv-edit` sent through `kelpi document csv-edit` or `documents.csv.edit` is bounded by that
cap before `maxBatchBytes` matters.

---

## 6. The client grid

### 6.1 Layout and virtualisation

- `CsvGrid` renders only the visible window of rows **and** columns (wide files are windowed
  horizontally too), with a sticky header row (when `headerRow` is on) and a sticky row-number
  column. Header labels come from logical row 0, or are `A, B, C, …` when the header row is
  off.
- Rows have a fixed height; a multi-line cell is clipped to one line with a newline marker.
- Column widths are measured in the grid's font from the header label and the loaded rows on
  screen (60 to 360 px). They only ever grow: when wider values scroll into view (or arrive as
  the scan finishes) the column widens, and it never narrows under the reader. Each sample is
  cut to 100 characters before it is measured. Dragging a header edge sets a width that auto
  sizing leaves alone. Widths are kept per pane in memory, for the 64 panes drawn most
  recently.
- `csv-client.ts` keeps a row-window cache keyed by `(incarnation, generation, revision,
  sort)`, fetches a window of rows and columns around the viewport (coalesced, at most two
  requests in flight, following `nextStart`), and on a revision change refetches only what is
  visible. It re-subscribes after a reconnect.
- Scrolling is native on both axes, with `overflow-anchor: none`. Past 8,000,000 px of content
  the spacer is capped and `scroll-map.ts` maps scroll offsets to rows: small deltas move 1:1,
  big jumps map proportionally, and re-centring waits until scrolling goes idle so iOS
  momentum is never interrupted. Every programmatic scroll (find, selection, Go to Row) goes
  through the mapper, so any row of any file is reachable.
- The pane background is the terminal background, as for every content pane
  ([content panes §8](content-panes.md)); the grid uses the theme's existing tokens.

### 6.2 Selection and keys

The grid container carries the pane-surface attribute, so app-level chords keep working while a
cell editor has focus.

| Key | Action |
| --- | --- |
| Arrows | Move the selection one cell |
| Home / End | First / last column of the row |
| PageUp / PageDown | One screen up / down |
| ⌘↑ / ⌘↓ | First / last row |
| Return, F2, double-click, or typing | Edit the selected cell (typing replaces its value) |
| Return (editing) | Commit and move down |
| Tab / ⇧Tab (editing) | Commit and move right / left |
| ⌥Return (editing) | Insert a newline in the cell |
| Escape (editing) | Cancel the edit |
| Delete / Backspace | Clear the selected cell |
| ⌘Z / ⌘⇧Z | Daemon undo / redo |
| ⌘C | Copy the selected cell, as one TSV field (quoted when it holds a tab, a line break or a leading quote) so ⌘V puts back exactly that value |
| ⌘V | Paste; a multi-cell TSV paste fills the block from the selection as one batch |
| ⌘F | Find in the table (§6.6) |
| ⌘E | Raw text, when available (§6.7) |

The selection is anchored to a logical row and column id, so it follows its row when the view
order changes (a sort, the header row toggled) once the rows in the new order arrive. It never
scrolls to follow, and a scroll made before they arrive drops the anchor. An edit is shown
optimistically until the daemon's push lands; edits queue behind the one batch in flight.

- A paste resolves the logical rows under its block in one generation: from the row cache
  where the cache is current, otherwise (or when the cache and the daemon disagree) the whole
  run from the daemon, and the batch is sent under that generation.
- A batch whose answer is lost (the connection dropped, or the reply timed out) is not a
  refusal. A batch of cell values is sent again, first in line, once the connection is back
  (at most three sends). A structural batch is not resent: the status line says the change
  could not be confirmed and the visible rows are refetched.
- ⌘E and closing the pane (or its workspace) first commit the cell being typed and wait until
  every queued batch is answered, because the daemon refuses a grid edit once the pane shows
  raw text or is gone. A batch that still fails after the grid has gone (another client
  switched the pane to raw text) raises the window's error toast.

### 6.3 Sorting

Clicking a column header cycles ascending, descending and off, with an arrow on the sorted
column. While the daemon is still sorting, rows show in their previous order, the arrow is an
ellipsis and the status line says "Sorting…". A header cell's value is edited by moving the
selection into the header row (↑ from row 1) and pressing Return; a click on it always sorts.

### 6.4 Context menu

Right-click on a cell or header (or a long press on a phone) opens the shared `ContextMenu`
with: Insert row above, Insert row below, Delete row, Insert column left, Insert column right,
Delete column, Sort ascending, Sort descending, Clear sort, a "First row is the header"
checkbox, Undo, Redo, and Go to row…. On a header cell, while the first row is the header, the only
row item is Insert row below, so a file that is only a header row gets its first data row
from there. Right-clicking empty space in a table with no body rows offers Insert row and Insert
column. Structural items are disabled while the file is indexing or read-only. Delete column on
a file over about 32 MiB, and a row delete estimated to exceed the undo budget, are labelled
"(can't be undone)" (§3.6).

### 6.5 Status line

The pane's status line shows the row and column count, the scan progress while indexing
("Indexing… 1,234,567 rows"), "Sorting…", "Saving…" or "Unsaved changes", a read-only reason
(`readOnly.message`), a load or save error (`error`) with a **Discard unsaved edits** button
when there are edits that cannot be saved, and one-off notices (`notice`). A Go to row field
(hinted `1-N`) jumps to a view row. On a phone the status line also carries Undo, Redo and the
header-row toggle, because phone pane mode hides the pane header.

### 6.6 Find

⌘F opens the same `PaneSearchOverlay` as the other content panes, in the same corner with the
same keys (Return / ⇧Return step, Escape closes). Typing sends `csv-find` (debounced 150 ms);
stepping sends `csv-find-step` from the current match, scrolls the cell into view and selects
it. Visible matches are highlighted from the client's row cache, the current one in its own
colour, with the find palette the other panes use. The counter reads `n/N` like the other
find bars; a search that reaches `maxFindMatches` stops counting at 1,000,000. Matching is a
case-insensitive literal substring of the cell's value, header cells included.

### 6.7 Raw text (⌘E)

When `rawEditable` is true (the file is at most 2 MiB, UTF-8 and not read-only), ⌘E or the
header's edit control switches the pane to the built-in `PlainTextEditor` over the file's
text, exactly as a markdown pane's edit mode works ([content panes §4](content-panes.md)),
and back again. Over the limit, the control is disabled with a tooltip that says why. See
§3.10 for what the daemon does on each switch. Going to raw text waits for the grid's edits
(§6.2). Coming back, the raw editor's recovery draft is settled only when the daemon was last
seen holding exactly that text on the current connection; text it never had (another client
switched the pane back, or the daemon restarted) stays as a draft with the recovery banner.

### 6.8 Pane chrome

- Type glyph: a table.
- The edit control is relabelled for csv: "Raw text (⌘E)" in grid mode and "Table (⌘E)" in
  raw mode, disabled over the raw limit.
- A **header-row** action control toggles `csvHeaderRow`, swapping its label and icon the way
  the edit control does. On a phone it is in the csv status line (§6.5).
- Split and close controls are as for every pane.

### 6.9 Phone

The phone renders the same `CsvGrid`.

- Tap selects a cell; tapping the selected cell edits it. A hidden textarea is already mounted
  over the selection so it can be focused synchronously inside the tap, which is what brings
  up the software keyboard; nothing focuses programmatically outside a gesture.
- A long press (500 ms, 8 px slop, as in the terminal) opens the same context menu at the
  touch point.
- Scrolling uses native momentum with the header row and row numbers pinned. A draggable
  scrubber reaches any row of a large file.
- A second tap edits the existing value with the caret at its end (typing over a selected cell
  on a desktop replaces it instead).
- Undo, Redo and the header-row toggle are in the status line (§6.5) and the long-press menu.

---

## 7. Plugins and the CLI

### 7.1 Placement and identity

- `document.csv` is a plugin placement (additive under plugin API version 1;
  [plugins](plugins.md), [plugin roadmap](plugin-roadmap.md)). A view declaring it can render
  csv panes; Settings → Plugins → Workbench views lists it beside the other document types.
  Containers cannot occupy it.
- `kelpi.csv` is the bundled renderer's reserved view id; it is not a valid container slot
  default.
- `pane.type` conditions accept `"csv"`, and `PaneType` and `PaneChromeKind` in the SDK
  include it (pane chrome presenters draw all seven kinds or none).

### 7.2 `documents` API

`documents.get` on a csv pane returns a `DocumentSnapshot` with `kind: 'csv'`: `text` is the
raw source only in raw-text mode (`mode: 'edit'`) and `''` in grid mode, with `loaded: true`,
so tools written for the other kinds keep working. In raw mode, source over the 256 KiB plugin
JSON cap comes back cut with `truncated: true` instead of failing. `documents.watch` emits
`documents.changed` for csv revisions too.

Rows and edits go through `documents.csv` ([plugin documents](plugin-documents.md)):

| Method | Daemon method | Notes |
| --- | --- | --- |
| `state(paneID?)` | `csv-state` | The pane's `CsvPaneState` |
| `rows(paneID, {start, count, columnStart?, columnCount?})` | `csv-rows` | 200 KiB reply budget, `nextStart` |
| `edit(paneID, generation, ops)` | `csv-edit` | Logical rows, column ids |
| `sort(paneID, column \| null, direction?)` | `csv-sort` | The pane's view only |
| `find(paneID, query)` | `csv-find` | Resolves when complete |
| `findStep(paneID, query, direction, from?)` | `csv-find-step` | |
| `setHeaderRow(paneID, on)` | `csv-header-row` | Persisted per pane |
| `discard(paneID)` | `csv-discard` | Drop unsaved edits and reload |

Failures reject with a `KelpiError` whose `code` is the daemon's prefix (`CSV_STALE`,
`CSV_GONE`, `CSV_READ_ONLY`, `CSV_BUSY`, `CSV_INVALID`). The methods are available to backend
plugins and to browser views through the same request path.

### 7.3 CLI

```sh
kelpi open data.csv                          # a csv pane (kelpi md data.csv: markdown source)
kelpi document csv-state PANE_ID
kelpi document rows PANE_ID --start 0 --count 100 [--column-start 0] [--column-count 20]
kelpi document csv-edit PANE_ID --generation GEN --ops '[{"op":"set-cell","row":1,"column":0,"value":"x"}]'
kelpi document csv-edit PANE_ID --generation GEN --ops-file ./ops.json
kelpi document sort PANE_ID --column 2 --direction desc    # or --clear
kelpi document find PANE_ID --query needle
kelpi document header-row PANE_ID on|off
```

The CLI validates ops with `decodeCsvEditOps` before sending anything and checks the rows,
find and sort arguments against the same limits; results print as JSON. `rows` returns the
`generation` that `csv-edit` needs. A `csv-edit` batch travels as plugin JSON, so `--ops` or
`--ops-file` over 256 KiB is refused with a hint to split it; a file that cannot be read is
reported as such, not as bad JSON. `sort` and `find` are answered only when the whole file has
been sorted or searched, so they wait up to 10 minutes for the reply; the other actions wait
35 seconds. `kelpi open` prints no pane ID: `kelpi pane list --json` lists it (`type: "csv"`).

---

## 8. Edge cases and invariants (checklist)

- [ ] A csv pane never sends a whole file over the WS except in raw-text mode, which is capped
      at 2 MiB.
- [ ] `.csv`/`.tsv` route to a csv pane case-insensitively from every entry point; `kelpi md`
      (`as: 'markdown'`) forces markdown; an older daemon ignores `as` and opens markdown.
- [ ] Opening a FIFO, device or directory never blocks and never reads; it shows an error.
- [ ] A quoted field spanning a 1 MiB chunk boundary, a CRLF split across chunks, a BOM, an
      empty file, a missing final newline and ragged rows all index correctly.
- [ ] An unbalanced quote makes the file read-only instead of reading it all as one record.
- [ ] Invalid UTF-8 and UTF-16/32 BOMs open read-only with a reason.
- [ ] Untouched rows are written back byte for byte; only edited rows are re-serialised, unless
      the column set changed.
- [ ] A save never leaves a partial file: temp file beside the real path, mode copied, rename,
      temp removed on failure; orphaned temp files from dead processes are swept.
- [ ] After a save the overlay is identity and the old inode is released; logical rows keep
      their indices.
- [ ] An edit against an old generation is translated, or rejected as `CSV_GONE`/`CSV_STALE`
      with nothing applied.
- [ ] Sorting and saving never change `generation`; structural edits always do.
- [ ] Two panes on one file share edits, undo and saves; each keeps its own sort and header row.
- [ ] Raw-text mode on one pane makes the others read-only until it ends; grid edits on a pane
      in raw mode reject.
- [ ] An in-place external rewrite with unsaved edits drops them and says how many; a replaced
      file with unsaved edits is overwritten by our save (last writer wins).
- [ ] SIGTERM writes every dirty document synchronously; quit and close save small files
      synchronously and large files in the background, keeping the document alive until done.
- [ ] Undo history never exceeds 64 MiB; an op that cannot be undone is announced first.
- [ ] Find stops at 1,000,000 matches and says so; an empty query matches nothing.
- [ ] Every row of a file of any size is reachable by scrolling, Go to Row or the phone
      scrubber, and programmatic scrolls go through the scroll mapper.
- [ ] A restart reopens every csv pane in grid mode with its header-row choice; ⌘⇧T does too.
- [ ] An older build preserves a `csv` pane row as an unavailable placeholder.

---

## Out of scope

- `.xlsx` and other spreadsheet formats; formulas.
- Multi-cell range selection beyond paste; persisting sort order or column widths across
  restarts.
- Encodings other than UTF-8: such files open read-only.
