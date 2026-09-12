# Document Lab

An SDK-only renderer for existing Markdown, Scratchpad and Diff panes. No backend, build,
native imports or host DOM access is required.

After [preparing the source checkout](../../../docs/plugin-development.md#prepare-a-source-checkout), start
`node scripts/dev-instance.mjs --state out/plugin-documents-playground` from the checkout
root. In that private instance, install this directory's absolute path through Settings → Plugins, open a
document, and choose **Document Lab** in its renderer picker. Settings exposes the same choices
as `document.markdown`, `document.scratchpad` and `document.diff`.

The example reads and watches the daemon's native buffer, supports Markdown edit/preview and save,
shows raw diff lines, and persists a wrap preference separately from source. Every input is
staged outside the iframe before revision-checked writes are serialized. Autosave-only conflicts
retry once after verifying that source and editing context are unchanged. Competing edits or
context changes preserve the local text for explicit recovery.

Its Markdown preview intentionally supports a small set of headings, paragraphs and fenced
blocks. See [the document guide](../../../docs/plugin-documents.md) for source limits, API
contracts, recovery scope, remote ownership and implementation details.

Validate with `node scripts/scenario.mjs plugin-document-features --window hidden`; use
`--window onscreen` to inspect screenshots. The [validation record](../../../docs/plugin-validation.md)
records past runs against specific revisions.

With the private `kelpi_test` helper from the [development guide](../../../docs/plugin-development.md),
run `kelpi_test plugin dev examples/plugins/document-lab --trust` from the checkout root to
apply source changes. Settings → Plugins → Versions selects compatible retained code while
preserving native buffers and saved renderer preferences. A newer saved `stateVersion` can
block rollback to older code. `plugin reload` only restarts the installed copy.
See the [plugin roadmap](../../../docs/plugin-roadmap.md) for the wider scope and remaining work.
