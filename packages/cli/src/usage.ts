/**
 * Every usage block, verbatim from the shipped binary (`nex.swift`'s `print*Usage`).
 *
 * Which STREAM a block goes to is part of the contract and differs per command: help flags
 * print to stdout and exit 0, error paths print the same block to stderr and exit 1 — except
 * the top-level usage and `graft --help`, which go to stderr even on the success path (a
 * shipped quirk, kept).
 */

export type Writer = (text: string) => void;

export const globalUsage = `Usage:
  kelpi --version
  kelpi event stop|start|error|notification|session-start|session-end [--agent claude|codex] [--message ...] [--title ...] [--body ...]
  kelpi pane split [--direction horizontal|vertical] [--path /dir] [--name <label>] [--target <name-or-uuid>]
  kelpi pane create [--path /dir] [--name <label>] [--target <name-or-uuid>]
  kelpi pane close [--target <name-or-uuid>] [--workspace <name-or-uuid>]
  kelpi pane name <name>
  kelpi pane resize [--target <name-or-uuid>] [--workspace <name-or-uuid>] (--ratio <0..1> | --grow [amt] | --shrink [amt])
  kelpi pane send [--bare] --target <name-or-uuid> [--workspace <name-or-uuid>] <command...>
  kelpi pane send-key --target <name-or-uuid> [--workspace <name-or-uuid>] <key>
  kelpi pane move [left|right|up|down]
  kelpi pane move --target X (--above|--below|--left-of|--right-of) Y
  kelpi pane move-to-workspace --to-workspace <name-or-uuid> [--create]
  kelpi pane list [--workspace <name-or-id> | --current] [--json] [--no-header]
  kelpi pane capture [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--lines N] [--scrollback]
  kelpi pane sync (on|off|toggle|status) [--workspace <name-or-uuid>] [--json]
  kelpi pane sync exclude --target <name-or-uuid> [--workspace <name-or-uuid>]
  kelpi pane sync include --target <name-or-uuid> [--workspace <name-or-uuid>]
  kelpi pane id
  kelpi workspace list [--json] [--no-header]
  kelpi workspace create [--name "..."] [--path /dir] [--color blue] [--group <name>] [--profile <name>] [--json]
  kelpi workspace create --worktree <name> [--branch <name>] [--repo <path>] [--update-main] [--group <existing>]
  kelpi workspace move <name-or-id> (--group <name> | --top-level) [--index N]
  kelpi workspace delete <name-or-id> [<name-or-id> ...] [--force|-y] [--prune-worktree] [--json]
  kelpi workspace profile <name-or-id> (<profile> | --clear)
  kelpi workspace label <name-or-id> (--set v | --add v | --remove v | --clear) [--json]
  kelpi group list [--json] [--no-header]
  kelpi group create <name> [--color blue]
  kelpi group rename <name-or-id> <new-name>
  kelpi group delete <name-or-id> [--cascade]
  kelpi group reorder <name-or-id> --order <id1,id2,...> [--json]
  kelpi group sort <name-or-id> --by name|last-activity|last-accessed [--desc] [--json]
  kelpi layout cycle
  kelpi layout select <name>
  kelpi open [--here] <filepath>   # routes by file type: .md→markdown, .html/.pdf/images→web pane
  kelpi md [--here] <filepath>     # always opens a markdown preview pane
  kelpi diff [<path>]
  kelpi graft start [--workspace <name-or-uuid>] [--repo <name-or-path>]
  kelpi graft stop [--workspace <name-or-uuid>] [--repo <name-or-path>]
  kelpi graft status [--json]
  kelpi web open [--private] <url>
  kelpi web navigate <url> [--target <name-or-uuid>] [--workspace <name-or-uuid>]
  kelpi web url|back|forward|reload [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--hard]
  kelpi web capture [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--mode meta|text|screenshot]
  kelpi web private on|off [--target <name-or-uuid>] [--workspace <name-or-uuid>]
  kelpi web cookies list|clear|delete [...]
  kelpi web click <selector> [--target X] [--workspace Y] [--double] [--right] [--at x,y] [--json]
  kelpi web type <selector> <text> [--target X] [--workspace Y] [--submit] [--no-replace] [--json]
  kelpi web text <selector> [--target X] [--workspace Y] [--max-bytes N] [--json]
  kelpi web attr <selector> <attribute> [--target X] [--workspace Y] [--json]
  kelpi web count <selector> [--target X] [--workspace Y] [--json]
  kelpi web exists <selector> [--target X] [--workspace Y]   # exit 0 = yes, 1 = no
  kelpi web dom <selector> [--target X] [--workspace Y] [--max-bytes N] [--json]
  kelpi web wait (--selector <sel> | --url-match <substr-or-regex>) [--for visible|hidden|exists|count=N|text=X] [--timeout 10] [--target X] [--workspace Y] [--json]
  kelpi web select <selector> <value-or-label> [--target X] [--workspace Y] [--json]
  kelpi web scroll <selector> [--top|--bottom|--smooth] [--target X] [--workspace Y] [--json]
  kelpi web hover <selector> [--target X] [--workspace Y] [--json]
  kelpi web key <key-name> [--selector <sel>] [--target X] [--workspace Y] [--json]
  kelpi web console [--since N] [--level log|debug|info|warn|error] [--clear] [--follow] [--json]
  kelpi web exec (--file <path> | <js>) [--timeout 30] [--target X] [--workspace Y] [--json]
  kelpi doctor [--json]                                   # IPC health check
  kelpi install-hooks [--claude-dir <dir>] [--codex-dir <dir>] [--link] [--dry-run] [--json]

`;

export const installHooksUsage = `Usage:
  kelpi install-hooks [--claude-dir <dir>] [--codex-dir <dir>] [--command <prefix>] \\
                    [--link [--install-dir <dir>]] [--dry-run] [--json]

Wires the kelpi lifecycle hooks into Claude Code and (when present) Codex CLI, so
panes track agent status and session ids. Safe to re-run: it MERGES, preserving
unrelated hooks, deduping kelpi-managed ones (absolute-path and --agent variants
included) and normalising stale matchers.

Options:
  --claude-dir <dir>   Claude Code config directory (default ~/.claude).
  --codex-dir <dir>    Codex CLI config directory (default ~/.codex). Skipped
                       when the directory does not exist.
  --command <prefix>   What the hooks invoke (default: bare \`kelpi\` when this
                       binary is on PATH, else its absolute path).
  --link               Also symlink this CLI into the install directory.
  --install-dir <dir>  Where --link puts the symlink (default /usr/local/bin,
                       or \$KELPI_INSTALL_DIR). Never uses sudo: an unwritable
                       directory prints the command to run by hand.
  --skill-source <dir> Directory holding the bundled kelpi-agentic SKILL.md
                       (default: beside this binary; skipped when absent).
  --dry-run            Report what would change; write nothing.
  --json               Print one structured result object instead of progress.
  -h, --help           Show this help.

Writes five Claude hooks (UserPromptSubmit/Stop/Notification/SessionStart —
matcher-less, so resumed sessions bind too — and SessionEnd) and four Codex
hooks with --agent codex (Codex has no SessionEnd or Notification event;
PermissionRequest carries the approval signal). An existing file is copied to
<file>.kelpi-backup before it changes; a file that is not valid JSON is refused,
never overwritten. The bundled kelpi-agentic skill is copied to
<claude-dir>/skills/kelpi-agentic/ when this build carries one.

Codex problems never fail the run: exit code follows the Claude half.

`;

export const paneCloseUsage = `Usage:
  kelpi pane close                          # close the calling pane (requires KELPI_PANE_ID)
  kelpi pane close --target <name-or-uuid>  # close a specific pane by label or UUID

Options:
  --workspace <name-or-uuid>  Scope label resolution to a specific workspace.
  -h, --help                  Show this help.

A bare positional argument is rejected on purpose — addressing a pane
other than the caller always goes through --target so a typo cannot
silently close the calling pane.

Exit codes: 0 on success, non-zero on failure (unknown target, ambiguous label,
transport failure, etc).

`;

export const paneSendUsage = `Usage:
  kelpi pane send [--bare] [--json] --target <name-or-uuid> [--workspace <name-or-uuid>] <command...>

Writes text to a pane's PTY and (unless --bare) presses Enter so it runs.

Options:
  --target <name-or-uuid>     Pane to write to. A UUID resolves globally; a
                              label needs a workspace scope (KELPI_PANE_ID or
                              --workspace) so it can't route to the wrong pane.
  --workspace <name-or-uuid>  Scope label resolution to a specific workspace.
  --bare                      Write the text without the trailing Enter (pair
                              with \`kelpi pane send-key\` to submit).
  --json                      Print the structured reply instead of the ack.
  -h, --help                  Show this help.

Works from outside a Kelpi pane (no KELPI_PANE_ID needed) when --target is a UUID
or --workspace is given. Exit codes: 0 on success, non-zero on failure.

`;

export const paneSplitUsage = `Usage:
  kelpi pane split [--direction horizontal|vertical] [--path /dir] [--name <label>] \\
                 [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--json]

Splits a pane, creating a new one beside it.

Options:
  --target <name-or-uuid>     Pane to split (UUID = global, label needs scope).
  --workspace <name-or-uuid>  Scope label resolution, or (alone) split that
                              workspace's focused pane.
  --direction h|v             Split direction (default horizontal).
  --path /dir                 Working directory for the new pane.
  --name <label>              Label for the new pane.
  --json                      Print the structured reply (incl. the new pane id).
  -h, --help                  Show this help.

Works from outside a Kelpi pane when --target or --workspace is given. The reply
carries the new pane's id. Exit codes: 0 on success, non-zero on failure.

`;

export const paneCreateUsage = `Usage:
  kelpi pane create [--path /dir] [--name <label>] [--workspace <name-or-uuid>] \\
                  [--target <name-or-uuid>] [--json]

Adds a pane to a workspace (splitting the focused pane, or creating the first
pane if the workspace is empty).

Options:
  --workspace <name-or-uuid>  Workspace to create the pane in.
  --target <name-or-uuid>     A pane whose workspace to create in (alternative
                              to --workspace).
  --path /dir                 Working directory for the new pane.
  --name <label>              Label for the new pane.
  --json                      Print the structured reply (incl. the new pane id).
  -h, --help                  Show this help.

Works from outside a Kelpi pane when --workspace or --target is given. The reply
carries the new pane's id. Exit codes: 0 on success, non-zero on failure.

`;

export const paneNameUsage = `Usage:
  kelpi pane name <name>                              # rename the calling pane
  kelpi pane name --target <name-or-uuid> <name>      # rename a specific pane

Options:
  --target <name-or-uuid>     Pane to rename (UUID = global, label needs scope).
  --workspace <name-or-uuid>  Scope label resolution to a specific workspace.
  --json                      Print the structured reply instead of the ack.
  -h, --help                  Show this help.

Without --target the calling pane is renamed (requires KELPI_PANE_ID). The new
label is the sole positional argument. Exit codes: 0 on success, non-zero on
failure.

`;

export const paneMoveUsage = `Usage:
  kelpi pane move <left|right|up|down>                    # move the calling pane
  kelpi pane move --target X --below Y                    # dock pane X under pane Y
  kelpi pane move --target X --right-of Y                 # dock pane X beside pane Y

The directional form moves the calling pane (requires KELPI_PANE_ID) toward its
neighbour. The adjacent form is the CLI equivalent of GUI drag-and-drop: it
re-parents pane X onto an edge of pane Y (both name-or-uuid, resolved in the
same workspace).

Adjacent options:
  --target <name-or-uuid>     Pane to move (X). Required for the adjacent form.
  --above <name-or-uuid>      Dock X above the anchor (Y).
  --below <name-or-uuid>      Dock X below the anchor.
  --left-of <name-or-uuid>    Dock X to the left of the anchor.
  --right-of <name-or-uuid>   Dock X to the right of the anchor.
  --workspace <name-or-uuid>  Scope label resolution to a specific workspace.
  --json                      Print the structured reply instead of the ack.
  -h, --help                  Show this help.

Exactly one edge (--above / --below / --left-of / --right-of) is required for
the adjacent form. Exit codes: 0 on success, non-zero on failure.

`;

export const paneResizeUsage = `Usage:
  kelpi pane resize --ratio <0..1>                      # resize the calling pane
  kelpi pane resize --target <name-or-uuid> --ratio 0.4 # resize a specific pane
  kelpi pane resize --target coordinator --grow         # enlarge by a step
  kelpi pane resize --target worker-1 --shrink 0.1      # shrink by 0.1

Adjusts a pane's share of its immediate split against its sibling. Without
--target the calling pane is resized (requires KELPI_PANE_ID).

Options:
  --target <name-or-uuid>     Pane to resize (UUID = global, label needs scope).
  --workspace <name-or-uuid>  Scope label resolution to a specific workspace.
  --ratio <0..1>              Set the pane's share of its split exactly.
  --grow [amount]             Enlarge the pane's share (default step 0.05).
  --shrink [amount]           Shrink the pane's share (default step 0.05).
  --json                      Print the structured reply instead of the ack.
  -h, --help                  Show this help.

Exactly one of --ratio / --grow / --shrink is required. The effective share
is clamped to [0.1, 0.9]. Exit codes: 0 on success, non-zero on failure.

`;

export const paneCaptureUsage = `Usage:
  kelpi pane capture [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--lines N] [--scrollback]

Prints a pane's terminal contents to stdout. Without --target, captures the
calling pane (requires KELPI_PANE_ID).

Options:
  --target <name-or-uuid>     Pane to read (UUID = global, label needs scope).
  --workspace <name-or-uuid>  Scope label resolution to a specific workspace.
  --lines N                   Limit to the last N lines (positive integer).
  --scrollback                Include the full scrollback, not just the viewport.
  -h, --help                  Show this help.

The target is flag-only: a bare positional argument is rejected on purpose so
\`kelpi pane capture <uuid>\` can't silently fall back to capturing the caller.
Exit codes: 0 on success, non-zero on failure.

`;

export const paneListUsage = `Usage:
  kelpi pane list [--workspace <name-or-uuid> | --current] [--json] [--no-header]

Lists panes as a table (or a JSON array with --json).

Options:
  --workspace <name-or-uuid>  Only panes in this workspace.
  --current                   Only the calling pane's workspace (requires KELPI_PANE_ID).
  --json                      Print a JSON array instead of the table.
  --no-header                 Omit the table header row.
  -h, --help                  Show this help.

--workspace and --current are mutually exclusive. This command takes no
positional arguments. Exit codes: 0 on success, non-zero on failure.

`;

export const paneSyncUsage = `Usage:
  kelpi pane sync (on|off|toggle|status) [--workspace <name-or-uuid>] [--json]
  kelpi pane sync exclude --target <name-or-uuid> [--workspace <name-or-uuid>]
  kelpi pane sync include --target <name-or-uuid> [--workspace <name-or-uuid>]

When \`on\`, every keystroke typed in any pane of the workspace is mirrored
to the other panes in the workspace. Use \`exclude\` / \`include\` to opt a
specific pane out of (or back into) the sync group. \`status\` reports the
current sync state without mutating it.

Excludes are ephemeral within a single on-cycle: any \`on\` / \`off\` /
\`toggle\` clears the exclusion set. Sequence is \`sync on\` first, then
\`sync exclude --target <pane>\`; running exclude while sync is off has
no effect on the next on-cycle.

Workspace defaults to the calling pane's workspace (via KELPI_PANE_ID)
when --workspace is not supplied.

`;

export const workspaceUsage = `Usage:
  kelpi workspace list|create|move|delete|profile|label [...]

Subcommands:
  list      List every workspace (grouped + top-level).
  create    Create a new workspace (optionally with a git worktree).
  move      Move a workspace into a group or to the top level.
  delete    Delete one or more workspaces.
  profile   Assign or clear a workspace's profile.
  label     Set/add/remove/clear a workspace's labels.

Run \`kelpi workspace <subcommand> --help\` for subcommand-specific usage.

`;

export const workspaceListUsage = `Usage:
  kelpi workspace list [--group <name-or-id>] [--json] [--no-header]

Lists workspaces as a table, or a JSON array with --json. Each entry
carries id, name, group, color, pane count, created_at, last_accessed_at,
last_activity_at, labels, and the agent session id (when present).

Options:
  --group <name-or-id>  Only list workspaces in this group.
  --json                Print a JSON array instead of the table.
  --no-header           Omit the table header row.
  -h, --help            Show this help.

Exit codes: 0 on success, non-zero on failure.

`;

export const workspaceCreateUsage = `Usage:
  kelpi workspace create [--name "..."] [--path /dir] [--color blue] \\
                       [--group <name>] [--profile <name>] [--json]
  kelpi workspace create --worktree <name> [--branch <name>] [--repo <path>] \\
                       [--update-main] [--group <existing>] [--json]

Creates a new workspace and returns its id.

Options:
  --name <name>      Workspace name.
  --path /dir        Working directory for the workspace's first pane.
  --color <color>    Workspace color.
  --group <name>     Place the workspace in this group (created if missing,
                     unless --worktree is given, which requires an existing group).
  --profile <name>   Assign a workspace profile at creation.
  --worktree <name>  Create a git worktree and open the first pane in it.
  --branch <name>    Branch for the worktree (defaults to the worktree name).
  --repo <path>      Source repo for the worktree (defaults to the cwd).
  --update-main      Fetch and branch off origin/<default> for the worktree.
  --json             Print the structured reply (incl. the new workspace id).
  -h, --help         Show this help.

Exit codes: 0 on success, non-zero on failure.

`;

export const workspaceMoveUsage = `Usage:
  kelpi workspace move <name-or-id> (--group <name> | --top-level) [--index N]

Moves a workspace into a group or detaches it to the top level.

Options:
  --group <name>   Destination group (must already exist).
  --top-level      Detach the workspace from its current group.
  --index N        Position within the destination (0-based).
  -h, --help       Show this help.

Exactly one of --group / --top-level is required. Exit codes: 0 on success,
non-zero on failure.

`;

export const workspaceDeleteUsage = `Usage:
  kelpi workspace delete <name-or-id> [<name-or-id> ...] [--force|-y] \\
                       [--prune-worktree] [--json]

Deletes one or more workspaces (closing any remaining panes). Refuses to
delete the last remaining workspace.

Options:
  --force, -y        Delete even when a workspace still has running agents.
  --prune-worktree   Best-effort \`git worktree remove\` of the deleted dir.
  --json             Print a per-id JSON result array.
  -h, --help         Show this help.

Exit codes: 0 on success, non-zero if any delete failed.

`;

export const workspaceProfileUsage = `Usage:
  kelpi workspace profile <name-or-id> (<profile> | --clear)

Assigns or clears a workspace's profile.

Options:
  --clear        Clear the workspace's profile assignment.
  -h, --help     Show this help.

Exactly one of <profile> / --clear is required. Exit codes: 0 on success,
non-zero on failure.

`;

export const workspaceLabelUsage = `Usage:
  kelpi workspace label <name-or-id> --set <label> [--set <label> ...]
  kelpi workspace label <name-or-id> --add <label> [--add <label> ...]
  kelpi workspace label <name-or-id> --remove <label> [--remove <label> ...]
  kelpi workspace label <name-or-id> --clear

Reads, then rewrites a workspace's labels. Changes render live in the
sidebar and persist. Exactly one operation per invocation.

Options:
  --set <label>      Replace all labels with the given value(s).
  --add <label>      Add the given label(s), preserving existing ones.
  --remove <label>   Remove the given label(s).
  --clear            Remove all labels.
  --json             Print the structured reply (incl. resulting labels).
  -h, --help         Show this help.

Exit codes: 0 on success, non-zero on failure (unknown/ambiguous
workspace, etc).

`;

export const groupUsage = `Usage:
  kelpi group list|create|rename|delete|reorder|sort [...]

Subcommands:
  list      List groups and their member workspaces.
  create    Create a new group.
  rename    Rename a group.
  delete    Delete a group (children promote unless --cascade).
  reorder   Rewrite a group's member order from an explicit id list.
  sort      Sort a group's members by name|last-activity|last-accessed.

Run \`kelpi group <subcommand> --help\` for subcommand-specific usage.

`;

export const groupReorderUsage = `Usage:
  kelpi group reorder <name-or-id> --order <id1,id2,...> [--json]

Rewrites a group's member order to the given sequence. Each token is a
workspace UUID or a name unique within the group. Members omitted from
--order keep their relative order at the tail; a token that isn't a member
is an error. Changes render live and persist.

Options:
  --order <list>   Comma- or space-separated member ids/names.
  --json           Print the structured reply (incl. resulting order).
  -h, --help       Show this help.

Exit codes: 0 on success, non-zero on failure.

`;

export const groupSortUsage = `Usage:
  kelpi group sort <name-or-id> --by name|last-activity|last-accessed [--desc] [--json]

Sorts a group's members by a known key. Default direction is ascending;
pass --desc for descending (e.g. most-recently-active first). Changes
render live and persist.

Sort keys:
  name             Alphabetical by workspace name (case-insensitive).
  last-activity    Most recent pane activity in the workspace.
  last-accessed    When the workspace was last opened (alias: last-modified).

Options:
  --by <key>       One of the sort keys above.
  --desc           Reverse the sort direction.
  --json           Print the structured reply (incl. resulting order).
  -h, --help       Show this help.

Exit codes: 0 on success, non-zero on failure.

`;

export const graftUsage = `Usage:
  kelpi graft start [--workspace <name-or-uuid>] [--repo <name-or-path>]
  kelpi graft stop  [--workspace <name-or-uuid>] [--repo <name-or-path>]
  kelpi graft status [--json]

With no filters, start/stop default to the caller's workspace
(requires KELPI_PANE_ID). Use --repo to target a single
association; use --workspace to scope across every association
in another workspace.

`;

export const webUsage = `Usage:
  kelpi web open      [--private] <url>
  kelpi web navigate  [--target <name-or-uuid>] [--workspace <name-or-uuid>] <url>
  kelpi web url       [--target <name-or-uuid>] [--workspace <name-or-uuid>]
  kelpi web back     [--target <name-or-uuid>] [--workspace <name-or-uuid>]
  kelpi web forward  [--target <name-or-uuid>] [--workspace <name-or-uuid>]
  kelpi web reload   [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--hard]
  kelpi web capture  [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--mode meta|text|screenshot]
  kelpi web tabs        [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--json] [--no-header]
  kelpi web tab-new     [<url>] [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--no-focus]
  kelpi web tab-close   <ref> [--target <name-or-uuid>] [--workspace <name-or-uuid>]
  kelpi web tab-select  <ref> [--target <name-or-uuid>] [--workspace <name-or-uuid>]
  kelpi web console     [--target ...] [--workspace ...] [--since N] [--level log|debug|info|warn|error] [--clear] [--follow] [--json]
  kelpi web inspect     [--target ...] [--workspace ...] [--send-to <pane>] [--submit] [--disarm]
  kelpi web inspect-result [--target ...] [--workspace ...] [--clear] [--json]
  kelpi web private    on|off [--target ...] [--workspace ...]
  kelpi web cookies    list|clear|delete [...]
  kelpi web click   [--target ...] [--workspace ...] <selector> [--double] [--right] [--at x,y] [--json]
  kelpi web type    [--target ...] [--workspace ...] <selector> <text> [--submit] [--no-replace] [--json]
  kelpi web text    [--target ...] [--workspace ...] <selector> [--max-bytes N] [--json]
  kelpi web attr    [--target ...] [--workspace ...] <selector> <attribute> [--json]
  kelpi web count   [--target ...] [--workspace ...] <selector> [--json]
  kelpi web exists  [--target ...] [--workspace ...] <selector>   # exit 0 = yes, 1 = no
  kelpi web dom     [--target ...] [--workspace ...] <selector> [--max-bytes N] [--json]
  kelpi web wait    [--target ...] [--workspace ...] (--selector <sel> | --url-match <sub-or-regex>) [--for visible|hidden|exists|count=N|text=X] [--timeout 10] [--json]
  kelpi web select  [--target ...] [--workspace ...] <selector> <value-or-label> [--json]
  kelpi web scroll  [--target ...] [--workspace ...] <selector> [--top|--bottom|--smooth] [--json]
  kelpi web hover   [--target ...] [--workspace ...] <selector> [--json]
  kelpi web key     [--target ...] [--workspace ...] <key-name> [--selector <sel>] [--json]
  kelpi web exec    [--target ...] [--workspace ...] (--file <path> | <js>) [--timeout S] [--json]

\`web exec\` runs author-supplied JS inside an async wrapper with
$ / $$ / kelpi bound to __kelpiAct.find / __kelpiAct.findAll / __kelpiAct.
A single trailing expression is returned automatically; for
multi-statement scripts, use an explicit \`return\`. \`--timeout\`
bounds how long the CLI waits for a reply (default 30s, since
\`kelpi.wait\` alone can run for 10s).

\`web console --follow\` streams new console lines as they arrive
(one JSON object per line with --json) until Ctrl-C.

\`open\`, \`navigate\`, and \`tab-new\` resolve local file paths: an
explicit path (./x, ../x, /x, ~/x), or a bare name that matches a
file with an extension in the current directory, is converted to
a \`file://\` URL — so \`kelpi web open foo.html\` just works. Bare
hostnames (example.com) and single-label hosts (app, api) stay
URLs; use ./name to force a local path.

When invoked from outside a Kelpi pane, --target must be a UUID
or --workspace <name-or-id> must be passed (label resolution
needs an explicit workspace scope).

For \`click\`, \`type\`, and \`select\`, use \`--\` to terminate options
when the positional payload looks like a flag (e.g. typing the
literal string "--submit" into a search box, or selecting an
option whose value is "--json"):
  kelpi web type css:#i -- --submit
  kelpi web select css:#s -- --json

`;

export const webCookiesUsage = `Usage:
  kelpi web cookies list   [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--json]
  kelpi web cookies clear  [--target <name-or-uuid>] [--workspace <name-or-uuid>] [--domain <d>] [--all]
  kelpi web cookies delete <name> [--domain <d>] [--target <name-or-uuid>] [--workspace <name-or-uuid>]

--all on \`clear\` removes cookies AND caches/local storage/indexed db for
this pane's data store. Without --domain, \`clear\` removes every cookie.

`;

/** Print a stored block through a writer (stdout for help, stderr for errors). */
export function printUsageBlock(block: string, write: Writer): void {
    write(block);
}
