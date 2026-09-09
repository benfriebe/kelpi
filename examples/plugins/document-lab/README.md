# Document Lab

An SDK-only renderer for existing Markdown, Scratchpad and Diff panes. No backend, build,
native imports or host DOM access is required.

Start `node scripts/dev-instance.mjs --state out/plugin-documents-playground` from the worktree
root. In that private instance, install this directory through Settings → Plugins, open a
document, and choose **Document Lab** in its renderer picker. Settings exposes the same choices
as `document.markdown`, `document.scratchpad` and `document.diff`.

The example reads and watches the daemon's native buffer, supports Markdown edit/preview and save,
shows raw diff lines, and persists a wrap preference separately from source. Every input is
staged outside the iframe before revision-checked writes are serialized. Conflicts preserve
the local text for explicit recovery; they never trigger an automatic overwrite.

Its Markdown preview intentionally supports a small set of headings, paragraphs and fenced
blocks. See [the document guide](../../../docs/plugin-documents.md) for source limits, API
contracts, recovery scope, remote ownership and implementation details.

Validate with `node scripts/scenario.mjs plugin-document-features`. To load source changes,
install this directory again; `plugin reload` restarts the already installed copy.
