# Replaceable document views

Markdown, Scratchpad and Diff are registered native features. A document host keeps the
native content subscription alive while its body uses a bundled feature or an isolated
plugin view. Switching views preserves the pane ID, layout, path, mode and daemon buffer.
The same host works locally, in embedded remote workspaces, in a directly connected browser,
and in phone pane/layout views.

[Document Lab](../examples/plugins/document-lab) demonstrates all three replacements using
only the public browser SDK. It has no backend or access to the host DOM.

## Try it beside the installed app

From this worktree:

```sh
node scripts/dev-instance.mjs --state out/plugin-documents-playground
```

In that instance, install `examples/plugins/document-lab` through Settings → Plugins. Open
a Markdown file, a Scratchpad or a Diff, then select **Document Lab** in its renderer picker.
Settings → Plugins → Workbench views exposes the same choices as `document.markdown`,
`document.scratchpad` and `document.diff`.

Each choice applies to that document type across this client's windows on the same origin
and daemon identity. It does not rewrite individual pane records. A direct browser origin
has separate preferences; selecting an embedded remote renderer does not change the primary
daemon's choices. Disabling/removing a plugin restores native views while retaining the
preference for reenabling it. A failed renderer falls back to the native view with Retry.

The development instance owns its database, sockets, configuration and Electron profile.
For an external terminal, use its printed `KELPI_SOCKET` and this checkout's
`node packages/cli/dist/kelpi.js`. The installed Kelpi is unaffected.

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
      "placements": ["document.markdown", "document.scratchpad", "document.diff"]
    }]
  }
}
```

Document placements accept views, not containers. Only a view declaring the matching type
can attach to a native document. The host supplies the actual owning workspace and pane in
`kelpi.context`, including after an activation-time move. Closing, parking, reusing, updating
or cancelling while attachment is pending cannot grant a stale lease.

`setState` stores renderer UI preferences separately from document source, keyed by pane and
view. State versioning uses the existing `stateVersion` contract: the view migrates old state
when needed. This state currently shares a bounded 256 KiB JSON map per plugin; closed-pane
entries remain retained. Keep it small (wrap preferences, selections), never use it as the
source buffer. Native pane descriptors remain native.

## Shared document API

Browser views and backend plugins share `api.documents`. CLI operations use the same native
content service. The [standalone declarations](../packages/plugin-sdk/documents.d.ts) define
the snapshot: `paneID`, `workspaceID`, `kind`, `mode`, `path`, `text`, `loaded`, `dirty`,
`error`, and an opaque `revision` token. Diff `text` is the raw unified diff source.

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
browser draft API.

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

Use the revision returned by the preceding snapshot, not a token copied from this example.
`edit` accepts exactly one of `--file` or `--text`. One-shot replies are JSON snapshots;
watch emits JSON-line `{ok,result}` envelopes. Failures return a nonzero exit code and do not
retry mutations. `--force` on workspace deletion does not bypass a failed document save.

## Validation

Run `pnpm check` and `node scripts/scenario.mjs plugin-document-features`. The scenario uses
private primary and remote daemons and real isolated frames. It covers rendering, switching,
rapid input, CLI reads/writes/watch, stale edits, failed disk saves, recovery after view/window
reload, renderer UI state, remote/phone ownership, daemon restart and plugin lifecycle.
Hidden runs validate behavior; an onscreen run is required to inspect screenshots.

This phase extracts document bodies and their content lifecycle. Some native keyboard actions
remain in application assembly. Terminal and browser feature extraction, and plugin
distribution/update workflows, remain later phases.
