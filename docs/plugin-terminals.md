# Replaceable terminal views

Terminal panes have a registered bundled renderer and a `terminal` replacement placement.
The same feature host is used in the primary workspace, embedded remote workspaces and
phone views, including document panes temporarily running an external editor. The daemon
continues to own the pane, PTY process, terminal state, input synchronization and size policy.
Switching renderers attaches a different view to that process; it never restarts it.

The [plugin roadmap](plugin-roadmap.md) tracks overall progress. The
[development guide](plugin-development.md) covers private testing, packaging and retained versions.

## Try Terminal Lab alongside your installed Kelpi

First [prepare the source checkout](plugin-development.md#prepare-a-source-checkout),
including the vendored engine. Then, from the checkout root:

```sh
node scripts/build-terminal-lab.mjs
node scripts/dev-instance.mjs --state out/plugin-terminals-playground
```

The development instance has its own database, sockets, ports and Electron profile. In that
instance, use Settings → Plugins to install the absolute path to `examples/plugins/terminal-lab`,
accepting local plugin trust. Select **Terminal Lab** in the terminal's renderer picker, or choose it for
`terminal` under Settings → Plugins → Workbench views. Leave a shell application running
and switch between Terminal Lab and the bundled renderer.

For installation from an external terminal, use the development instance's printed
`KELPI_SOCKET` and this checkout's CLI, so the command reaches that instance:

```sh
KELPI_SOCKET='THE_PRINTED_SOCKET' KELPI_REQUIRE_SOCKET=1 \
  node packages/cli/dist/kelpi.js plugin install examples/plugins/terminal-lab --trust
```

For live edits, run `kelpi_test plugin dev examples/plugins/terminal-lab --trust` using the
development guide's helper. Rerun `node scripts/build-terminal-lab.mjs` after source changes;
dev installs the generated assets but does not run the build. Build before packing this example.
Settings → Plugins → Versions switches compatible retained code without restarting its native PTY.

The choice is stored per daemon in this client's origin. All terminal panes in that scope
use it; a remote daemon has its own choice. Reloading or disabling a plugin retains the
choice and native pane. A failed view falls back to the bundled terminal with an explicit
retry button. Source files being edited by an external editor keep their original pane type.

## Declare a renderer

```json
{
  "id": "example.my-terminal",
  "name": "My Terminal",
  "version": "1.0.0",
  "apiVersion": 1,
  "trust": "full",
  "contributes": {
    "views": [{
      "id": "example.my-terminal.renderer",
      "title": "My Terminal",
      "entry": "ui/index.html",
      "stateVersion": 1,
      "placements": ["terminal"]
    }]
  }
}
```

The view runs in the existing opaque iframe with the public browser SDK. No backend is
required. The host supplies the actual owning `context.paneID` and `context.workspaceID`;
a renderer cannot redirect its attachment to another pane by supplying a pane ID.
`setState` persists renderer preferences separately from process state, keyed by pane and
view. The existing per-plugin native-view state file has a total 256 KiB JSON limit.
Revision switches reject a renderer whose `stateVersion` cannot read that saved state. The
plugin must migrate older preferences itself; native PTY state is not a plugin migration.

## Renderer session

The [standalone types](../packages/plugin-sdk/terminal.d.ts) define `ViewTerminalAPI`,
`TerminalSession`, `TerminalFrame` and `TerminalAction`. Existing terminal
watch/send/capture/search/sync APIs remain available to all plugins. Renderer attachment
is a view-only API granted by the terminal feature host.

```js
const session = await kelpi.terminal.attach({
  cols: measuredColumns,
  rows: measuredRows,
  async onFrame(frame) {
    if (frame.type === 'replay') await renderer.replace(frame.data);
    else if (frame.type === 'output') await renderer.write(frame.data);
    else if (frame.type === 'modes') renderer.setModes(frame.modes);
    else if (frame.type === 'presentation') renderer.present(frame.value);
    else if (frame.type === 'resync') renderer.expectReplay();
    else if (frame.type === 'exit') renderer.showExit(frame.exitCode);
  },
  onAction: action => renderer.handleAction(action)
});
addEventListener('pagehide', () => session.dispose(), { once: true });
```

`renderer` above represents the author's emulator adapter. Terminal Lab contains a complete
adapter built with the repository's pinned xterm dependency. Build it before installation;
the generated bundle stays local and its source remains reviewable.

The SDK installs the callback before requesting attachment. A frame can arrive before
`attach()` resolves: do not await that promise inside `onFrame`. Resolve `onFrame` only
after the emulator has consumed its bytes, including asynchronous parser writes. The SDK
then acknowledges that exact delivery. A thrown/rejected callback fails the view.

| Session operation | Meaning |
| --- | --- |
| `write(stringOrBytes)` | Keyboard and paste bytes, including the pane's input-sync siblings. |
| `writeDirect(stringOrBytes)` | Pane-local mouse reports and key releases. |
| `writeDirect(stringOrBytes, { response: true })` | Parser replies to the data frame currently being consumed, including while hidden. |
| `resize(cols, rows)` | Report measured geometry through this window's native size-control path. |
| `setCellHeight(height)` | Supply the phone keyboard inset's minimum line height in CSS pixels. |
| `dispose()` | Detach this renderer, retaining the process and pane. Later writes reject. |

Input is raw UTF-8 or `Uint8Array`, limited to 128 KiB per call. The emulator decides
bracketed paste and keyboard encoding. Mouse reports and key releases must use the direct
path so coordinates and releases are never copied to input-sync siblings. Dimensions must
be integers from 1 through 65535; cell height must be finite, positive and at most 512.

Ordinary input is ignored while hidden. A parser's DA/DSR reply can still reach its process:
mark it as `response: true` while consuming a replay/output callback. The SDK and host bind
that reply to the exact callback's delivery generation and sequence. A still-running output
callback may answer its application's query after a newer replay arrives: snapshots do not
reproduce those queries, and its acknowledgement still grants no credit for the newer data.
This exception does not permit background keyboard or mouse input, replies from a completed
callback, or replies from an obsolete replay. Track input origin
in the emulator adapter rather than guessing from an escape-sequence prefix.

Presentation includes focus, visibility, terminal colors/font/padding, accessibility name
and search reveal coordinates anchored from the bottom of the buffer. A reveal's `seq`
distinguishes repeated requests for the same match. Logical pane focus is not permission
to steal the caret from a palette or dialog; use the explicit host focus action.

Actions also cover live selection, key dispatch, paste, keyboard visibility and the phone
bar's one-shot Ctrl/Alt modifiers. Return the emulator's current selection when asked,
not a cached previous highlight. The parent writes the clipboard. A selection reply is
limited to 256 KiB and must settle within five seconds. A key/paste action returns a handled
boolean; other actions return null or undefined. Renderer authors implement these actions
in their own input component; the opaque frame cannot expose its DOM to the parent.
Where supported, the host starts a promised clipboard write before the selection reply
arrives. An empty selection preserves the current clipboard. Browser clipboard permissions
and focus requirements still apply. With the default Windows/Linux bindings, an empty
Ctrl+C selection returns the key to the same live, focused renderer for interruption;
empty Cmd+C stays a quiet copy attempt. Synthetic keys dispatched for a host action bypass
the SDK shortcut relay so the renderer can encode them once. The phone bar clears armed
modifiers when its target renderer changes.

## Ordering, bounds and ownership

Renderer frames use a dedicated acknowledged port feed rather than generic plugin events.
At most one frame callback is in flight. A replay replaces the screen and parser state;
never append a snapshot to an old partial escape sequence. Replay/resync advances the
delivery generation, so an old callback's acknowledgement cannot grant credit for newer
bytes. Queued live output and its preceding replay/mode checkpoints finish before the
newest snapshot: screen state cannot recreate unanswered device queries. Snapshot-only
suffixes coalesce, and retained old generations receive no current output credit.
The window's existing PTY transport retains daemon replay, flow control and size
ownership. A slow view cannot stall the process or another window.
The latest mode metadata follows each replay, including a mode update that was still queued
when the old screen was superseded. Apply it to the emulator's supported input modes after
resetting the parser and screen.

The host bounds live backlog at 1 MiB, individual replay at 16 MiB, total retained replay
data at 32 MiB, and queued deliveries at 2048. A callback that does not consume its frame
within 30 seconds fails the view. Bounds
fail the entire renderer and restore native rendering; they never discard individual byte
fragments and continue with a corrupted parser. Host actions are limited to 16 pending
requests. These are view-lifetime limits, separate from generic plugin RPC/event limits.

Only one renderer owns a pane's local subscription. Handoff retires the old handle and
requests a fresh snapshot. Released handles cannot write, resize or acknowledge against
the new renderer. A replay already in transit may briefly precede the fresh authoritative
replay; every replay must replace the display. No attach/release operation launches or
terminates a PTY.

Renderers hidden within a mounted layout retain their session but cannot claim geometry.
Workspace navigation follows the existing native mount/eviction policy; remounting requests
a fresh snapshot of the same process. Initial/reconnect attach
omits geometry when hidden; becoming visible resumes measured resizing. The daemon still
decides whether this window owns process dimensions. Remote replacements use the remote
runtime's transport and storage.

## Replay geometry limitation

As of merged main `ab9be92`, the bundled renderer mirrors another size owner's grid before
consuming a replay, letterboxing or clipping it when necessary. The public terminal SDK does
not yet carry that replay grid or size-ownership presentation: replay frames contain bytes
only. Terminal Lab continues fitting its own measured box, so its multi-window geometry
behavior does not yet match the bundled renderer.

The native `PtySubscription.onReplay(data, grid)` callback supplies geometry, but
[the plugin bridge](../packages/client/src/plugins/terminal.ts) currently drops its second
argument. [TerminalFrame and TerminalPresentation](../packages/plugin-sdk/terminal.d.ts)
therefore cannot convey it. This is a source-confirmed contract gap; the existing plugin
scenario does not validate owner-grid mirroring. Completing that path and testing Terminal
Lab are the [next recommended task](plugin-roadmap.md#next-recommended-task-terminal-sdk-geometry-parity).

## Validation and remaining scope

Run `pnpm check` and `node scripts/scenario.mjs plugin-terminal-features --window hidden`. The live scenario
uses private daemons and a persistent terminal fixture to check process identity, replay,
input and renderer recovery. See the [validation record](plugin-validation.md) for actual
dated results and the distinction between emulated phone checks and physical-device testing.
Use `--window onscreen` to inspect screenshots.

This contract permits alternate terminal engines; it does not make every engine implement
the bundled renderer's complete keyboard, selection or touch behavior. Terminal Lab's
adapter details and limitations are documented with its source. Browser features have their
own [replacement contract](plugin-browser.md). Plugin distribution and update/rollback
through portable local artifacts and retained revisions are implemented; see the development
guide and [recovery contract](plugins.md#updates-and-recovery). Registry distribution, restricted
trust and other remaining work are tracked in the roadmap.
