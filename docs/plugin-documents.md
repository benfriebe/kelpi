# Replaceable document views

Markdown, Scratchpad, Diff and CSV are registered native features. A document host keeps the
native content subscription alive while its body uses a bundled feature or an isolated
plugin view. Switching views preserves the pane ID, layout, path, mode and daemon buffer.
The same host works locally, in embedded remote workspaces, in a directly connected browser,
and in phone pane/layout views.

[Document Lab](../examples/plugins/document-lab) demonstrates the Markdown, Scratchpad and Diff
replacements using only the public browser SDK, and attaches to CSV tables with a read-only
note. It has no backend or access to the host DOM.

See the [plugin roadmap](plugin-roadmap.md) for current scope and the
[development guide](plugin-development.md) for templates, live editing and portable packages.

## Try it beside the installed app

First [prepare the source checkout](plugin-development.md#prepare-a-source-checkout).
Then run from its root:

```sh
node scripts/dev-instance.mjs --state out/plugin-documents-playground
```

In that instance, paste the absolute path to `examples/plugins/document-lab` into Settings →
Plugins. Open a Markdown file, a Scratchpad or a Diff, then select **Document Lab** in its renderer picker.
Settings → Plugins → Workbench views exposes the same choices as `document.markdown`,
`document.scratchpad`, `document.diff` and `document.csv`.

Each choice applies to that document type across this client's windows on the same origin
and daemon identity. It does not rewrite individual pane records. A direct browser origin
has separate preferences; selecting an embedded remote renderer does not change the primary
daemon's choices. Disabling/removing a plugin restores native views while retaining the
preference for reenabling it. A failed renderer falls back to the native view with Retry.

The development instance owns its database, sockets, configuration and Electron profile.
For an external terminal, use its printed `KELPI_SOCKET`, `KELPI_REQUIRE_SOCKET=1`, and this
checkout's `node packages/cli/dist/kelpi.js`. The development guide's `kelpi_test` helper
keeps these together. Run `kelpi_test plugin dev examples/plugins/document-lab --trust` from
the checkout root to apply source edits; reload only restarts the installed copy.

## Declare a renderer

```json
{
  "id": "example.editor",
  "name": "Example Editor",
  "version": "1.0.0",
  "apiVersion": 1,
  "trust": "full",
  "contributes": {
    "views": [{
      "id": "example.editor.document",
      "title": "Example Editor",
      "entry": "ui/index.html",
      "placements": ["document.markdown", "document.scratchpad", "document.diff", "document.csv"]
    }]
  }
}
```

Document placements accept views, not containers. Only a view declaring the matching type
can attach to a native document. The host supplies the actual owning workspace and pane in
`kelpi.context`, including after an activation-time move. Closing, parking, reusing, updating
or cancelling while attachment is pending cannot grant a stale lease.

`setState` stores renderer UI preferences separately from document source, keyed by pane and
view. The view is responsible for reading and migrating older `stateVersion` values. Installing
or selecting a revision that cannot read saved state is rejected; writing a newer state version
can therefore prevent rollback. See [updates and recovery](plugins.md#updates-and-recovery).
This state shares a bounded 256 KiB JSON map per plugin; closed-pane
entries remain retained. Keep it small (wrap preferences, selections), never use it as the
source buffer. Native pane descriptors remain native.

## Shared document API

Browser views and backend plugins share `api.documents`. CLI operations use the same native
content service. The [standalone declarations](../packages/plugin-sdk/documents.d.ts) define
the snapshot: `paneID`, `workspaceID`, `kind`, `mode`, `path`, `text`, `loaded`, `dirty`,
`error`, and an opaque `revision` token. Diff `text` is the raw unified diff source. `kind` is
`markdown`, `scratchpad`, `diff` or `csv`; a csv table's `text` is its raw source only in
raw-text mode (`mode: 'edit'`, ⌘E) and `''` in grid mode, and raw source over the 256 KiB
transport cap comes back cut with `truncated: true` rather than failing (see
[CSV tables](#csv-tables)).

| Method | Behavior |
| --- | --- |
| `get(paneID?)` | Current source and save state; omitted pane uses the view/command context. |
| `edit(paneID, text, revision)` | Replace an editable native buffer with a guarded revision. |
| `save(paneID, revision)` | Flush the buffer through native persistence; reject failed saves. |
| `setMode(paneID, 'edit' \| 'view', revision)` | Markdown mode change; leaving edit requires a successful save. |
| `refresh(paneID, revision)` | Reread a clean document, or regenerate a diff. Dirty buffers reject. |
| `watch(paneID?)` | Return `{ subscription, state }` and start invalidations. |
| `unwatch(subscription)` | Release this view/backend's subscription. |

```js
const current = await api.documents.get(paneID);
const editable = current.mode === 'edit' ? current
    : await api.documents.setMode(paneID, 'edit', current.revision);
const edited = await api.documents.edit(paneID, editable.text + '\nMore text', editable.revision);
await api.documents.save(paneID, edited.revision);
```

Diff is read-only. Markdown requires edit mode and a successfully loaded source; external
editor ownership refuses document mutations. Scratchpads use native pane persistence.
Revision tokens change when content/state changes and when an entry is recreated, including
daemon restart. A stale token rejects as `KelpiError.code === 'DOCUMENT_CONFLICT'` before
mutation. Do not retry stale text with an automatically fetched token unless the latest source
and editing context still match the last acknowledged snapshot. Otherwise show the conflict
and let the person review it. Concurrent snapshots may already reflect a later update; validate
the returned text before chaining edits. The bundled editor retains its existing native
editing semantics; revision checks protect SDK/CLI writes against changes from other writers.

Install event listeners before `watch`. `documents.changed` carries `{subscription,paneID}`;
read `get` for current state rather than treating invalidations as an edit log. Native typing
notifies other clients on autosave, not every keystroke. `documents.closed` ends a watch when
its pane leaves the visible workspace set, including parking. Reattach when the view remounts.
View release, disconnect/cancellation, plugin disable/failure and daemon disposal clean up
watches. Subscriptions are capped at 128 per daemon and belong to their exact view lease or
backend. One lease cannot unwatch another lease's subscription.

Source edits are limited to 192 KiB **after JSON encoding**. API snapshots and envelopes use
the existing 256 KiB plugin transport limit. Oversized data rejects explicitly; native views
remain available for larger documents. CLI watch coalesces reads to initial/latest snapshots;
it does not promise a replay log or socket-level backpressure for slow consumers.

These methods operate on the owning daemon's content service, including remote views. They
do not select another daemon based on window navigation. Native saves remain authoritative
even when `kelpi.files` or other low-level service providers are replaced. Document methods
are not a replaceable save provider or new command-hook family. Existing public commands,
services, events and file/process APIs remain available to the renderer under the normal
full-trust plugin contract.

## CSV tables

A csv pane ([spec](csv-pane.md)) is never edited as whole text in grid mode: its rows and
cells go through `api.documents.csv`, which addresses rows the way the native grid does. Rows
come back in the pane's **view** order (its sort, the header row pinned first); edits address
**logical** rows (file order, unchanged by sorting or saving) and stable column ids, guarded by
the document's `generation`.

| Method | Daemon method | Behavior |
| --- | --- | --- |
| `csv.state(paneID?)` | `csv-state` | The pane's table state: `generation`, `rowCount`, `columns`, `headerRow`, `sort`, `dirty`, `readOnly`, `scanning` and more. |
| `csv.rows(paneID, {start, count, columnStart?, columnCount?})` | `csv-rows` | At most 500 rows by 256 columns from view index `start`. Stops at 200 KiB of cell text and returns `nextStart`; cells over 64 KiB come back cut and listed in `truncated`. |
| `csv.edit(paneID, generation, ops)` | `csv-edit` | Up to 1000 ops in order: `set-cell`, `insert-rows`, `delete-rows`, `insert-column`, `delete-column`, `undo`, `redo`. Autosave writes them. |
| `csv.sort(paneID, column \| null, direction?)` | `csv-sort` | Sort this pane's view by a column id; `null` returns to file order. Never edits the file. |
| `csv.find(paneID, query)` | `csv-find` | Count matching cells; resolves when complete (stops at 1,000,000). |
| `csv.findStep(paneID, query, direction, from?)` | `csv-find-step` | The next or previous match from `{view, column}`. |
| `csv.setHeaderRow(paneID, on)` | `csv-header-row` | Treat row 0 as headers in this pane; persisted per pane. |
| `csv.discard(paneID)` | `csv-discard` | Drop unsaved edits and reload from disk. |

```js
const table = await api.documents.csv.state(paneID);
const page = await api.documents.csv.rows(paneID, { start: 0, count: 50 });
const [first] = page.columnIDs;
await api.documents.csv.edit(paneID, page.generation, [
    { op: 'set-cell', row: page.rows[1].row, column: first, value: 'checked' },
]);
```

Failures reject with a `KelpiError` whose `code` is `CSV_STALE` (the generation is from another
incarnation or too old to translate: read again and recompute), `CSV_GONE` (the row or column
was deleted since), `CSV_READ_ONLY` (the file is read-only, or the pane is in raw-text mode),
`CSV_BUSY` (still indexing) or `CSV_INVALID` (malformed or over a limit). An edit against a
slightly older generation is translated forward through recent inserts and deletes rather than
rejected. As with text documents, never retry a rejected edit blindly. Validation is the same
shared decoder the native grid's WS verbs use, and the whole request still sits inside the
256 KiB plugin JSON cap. `documents.watch` emits `documents.changed` for csv revisions too.

## Preserve pending input

A document renderer must persist **every input** before queueing a daemon write. Browser
document views provide two additional methods:

```js
const draft = await kelpi.documents.stage(text, observedRevision);
const edited = await kelpi.documents.applyDraft(draft.id, observedRevision);
```

`stage` stores the text in the owning host window, outside the iframe. `applyDraft` applies
that exact draft through `documents.edit`. A newer stage invalidates the old ID with
`DOCUMENT_DRAFT_SUPERSEDED`; the host never replaces the newer recovery record when an older
edit settles. Document Lab stages immediately on input and serializes the guarded writes.
Autosave can change the revision without changing source, so a conflict triggers a fresh read
and at most one guarded retry when source, pane/workspace identity, kind, mode, path and loaded
state still match the last acknowledged snapshot. A changed source or editing context, or a
second conflict, stops editing and preserves the draft for review. Its small
Markdown preview supports headings, paragraphs and fenced blocks; it is an authoring example,
not a complete Markdown engine.

Calling `documents.edit` from a view also stages its submitted text automatically. Text held
only in an iframe's own queue cannot be recovered by Kelpi. Use `stage` before such a queue.
Draft APIs require a Markdown/Scratchpad renderer and use its context pane; backends have no
browser draft API. CSV row edits are not staged: each
`csv.edit` batch is applied or rejected whole.

Recovery records are scoped by daemon, browser-window session and pane. They survive a view
failure/reload and a reload of that window. Competing windows keep separate drafts. The host
clears an acknowledged record only when a matching saved snapshot arrives, or on explicit discard. Its
recovery bar offers Review, Restore and save, and Discard local draft. Restoration reads a
fresh revision only in response to that explicit action; a concurrent change still rejects.
If browser storage is unavailable, the host reports that the draft is held only in memory.
Native input can still save through the daemon; plugin staging rejects before applying it.
Closing the browser session or clearing its storage is outside this recovery guarantee.

Close commands from the owning window flush native pending input, await submitted edits and
refuse unapplied drafts. Pane/workspace deletion and group cascade also refuse daemon buffers
that cannot save, before tearing down any surfaces. A CLI/backend or another window cannot
inspect drafts that exist only in a different browser window. Unacknowledged remote writes
are not automatically replayed after reconnect; read current state and review recovery text.

## CLI

```sh
kelpi document get PANE_ID
kelpi document watch PANE_ID
kelpi document mode PANE_ID edit --revision TOKEN
kelpi document edit PANE_ID --revision TOKEN --file ./replacement.md
kelpi document save PANE_ID --revision TOKEN
kelpi document refresh PANE_ID --revision TOKEN
```

CSV tables have their own actions, which take no revision:

```sh
kelpi document csv-state PANE_ID
kelpi document rows PANE_ID --start 0 --count 100 [--column-start 0] [--column-count 20]
kelpi document csv-edit PANE_ID --generation GEN --ops '[{"op":"set-cell","row":1,"column":0,"value":"x"}]'
kelpi document csv-edit PANE_ID --generation GEN --ops-file ./ops.json
kelpi document sort PANE_ID --column 2 [--direction desc]
kelpi document sort PANE_ID --clear
kelpi document find PANE_ID --query needle
kelpi document header-row PANE_ID on|off
```

`rows` and `csv-state` return the `generation` that `csv-edit` needs. `csv-edit` takes exactly
one of `--ops` or `--ops-file` and validates the ops locally (the shared `decodeCsvEditOps`)
before sending; `rows` refuses more than 500 rows or 256 columns, and `find` a query over 1 KiB.

Use the revision returned by the preceding snapshot, not a token copied from this example.
`edit` accepts exactly one of `--file` or `--text`. One-shot replies are JSON snapshots;
watch emits JSON-line `{ok,result}` envelopes. Failures return a nonzero exit code and do not
retry mutations. `--force` on workspace deletion does not bypass a failed document save.

## Validation

Run `pnpm check` and `node scripts/scenario.mjs plugin-document-features --window hidden`.
The scenario uses private primary and remote daemons and real isolated frames. It covers rendering, switching,
rapid input, CLI reads/writes/watch, stale edits, failed disk saves, recovery after view/window
reload, renderer UI state, remote/phone ownership, daemon restart and plugin lifecycle.
Hidden runs validate behavior; an onscreen run is required to inspect screenshots. The
[validation record](plugin-validation.md) records completed runs and their source revisions.

Document bodies and their shared content lifecycle are implemented. Some native keyboard
actions remain in application assembly. [Terminal replacements](plugin-terminals.md) cover
external editor sessions, and [browser replacements](plugin-browser.md) retain native pages.
Portable packages, dev watching and compatible revision switching are also implemented; see
the development guide. The roadmap distinguishes these completed capabilities from remaining work.
