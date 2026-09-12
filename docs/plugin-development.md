# Develop a Kelpi plugin

Plugins are self-contained packages installed on the daemon machine. You can author one
outside this repository and test it beside your installed Kelpi.
The [plugin reference](plugins.md) describes the API and package contract;
the [roadmap](plugin-roadmap.md) tracks delivered capabilities and remaining work.
For work on Kelpi itself, the [agent handoff](plugin-handoff.md) records the current baseline
and the next implementation task.

## Prepare a source checkout

Use Node.js 24 or newer and pnpm. A fresh clone or worktree needs the vendored terminal
engine's ignored `dist/` before the app can build. Follow the
[vendor rebuild recipe](../vendor/ghostty-web-patched/PROVENANCE.md#rebuild-the-javascript-bundle)
from the checkout root. It copies this checkout's tracked TypeScript and patched WASM into a
unique temporary directory, builds the bundle, then runs `pnpm install --frozen-lockfile` in
the checkout. Run the recipe's embedded-WASM verification afterward.

At main `ab9be92` the override is `ghostty-web 0.4.0-nex.13`. Its JavaScript inlines the WASM,
so installing dependencies or copying the standalone WASM alone cannot repair an older
bundle. Repeat the recipe after vendor source/WASM changes. An existing checkout with a
verified matching bundle only needs `pnpm install --frozen-lockfile` for workspace dependencies.
The app launcher does not perform the vendor rebuild.

## Start a private instance

After preparing the checkout, run from its root:

~~~sh
node scripts/dev-instance.mjs --state out/plugin-playground
~~~

The launcher builds that checkout and prints its private socket, ports and state directory.
It uses a separate database and Electron profile. Keep it running while testing; Ctrl-C stops
the instance and retains its data for the next launch.
This launches a separate instance from the checkout; it does not install it over your current
Kelpi application or replace your global CLI.

Use the checkout's CLI and the socket printed by this launcher. In an external terminal,
define a helper with your actual checkout path and printed socket:

~~~sh
KELPI_PLUGIN_CHECKOUT=/path/to/plugin-checkout
KELPI_PLUGIN_TEST_SOCKET=tcp:127.0.0.1:PRINTED_PORT
kelpi_test() {
  KELPI_SOCKET="$KELPI_PLUGIN_TEST_SOCKET" KELPI_REQUIRE_SOCKET=1 \
    node "$KELPI_PLUGIN_CHECKOUT/packages/cli/dist/kelpi.js" "$@"
}
~~~

The required-socket flag makes a missing route fail instead of falling back to another local
daemon. You can also run the private instance's CLI directly from one of its terminal panes.

## Create and edit a project

~~~sh
kelpi_test plugin init ~/code/my-kelpi-pane --id example.my-pane --name "My Pane" --template pane
kelpi_test plugin validate ~/code/my-kelpi-pane
kelpi_test plugin dev ~/code/my-kelpi-pane --trust
~~~

`init`, `validate`, and `pack` work offline through the built CLI. `dev`, installation and
version switching require the selected daemon. The templates have no build step or
third-party runtime dependencies:

| Template | Starting point |
| --- | --- |
| `pane` (default) | Custom pane and optional sidebar placements with a backend workspace command. |
| `sidebar` | A custom sidebar that can occupy either side. |
| `document` | Read-only Markdown, Scratchpad and Diff source viewer using the native buffer. |
| `browser` | Native page attachment, tabs and navigation with Kelpi-owned browser sessions. |

While dev runs, use another terminal to open a pane template with
`kelpi_test plugin open example.my-pane example.my-pane.home`.
Choose sidebars through Settings → Plugins → Workbench views. For document and browser
templates, open a native pane and choose the replacement in Settings or its renderer picker.
There is no terminal scaffold template. The [Terminal Lab](../examples/plugins/terminal-lab)
demonstrates attachment with an actual terminal emulator;
the [Document Lab](../examples/plugins/document-lab) and
[Browser Lab](../examples/plugins/browser-lab) cover their more advanced operations.

The dev command prints JSON-line events: `watching`, `applying`, `applied`, `invalid`, `failed`
and `stopped`. It requires explicit trust because edited backend code can execute with your
account's access. It captures validated bytes, serializes installations, and waits for a
stable changed revision across polling reads. A valid first read at startup is installed immediately;
later changes must match on consecutive reads. The default polling interval is one second.
An incomplete manifest, missing entry, or failed backend update leaves the previous working
revision available. Edit again to repair it. An unchanged failed revision is not retried
repeatedly; change its bytes or restart dev to retry it.

The first valid manifest pins the plugin ID for that dev session. Restart dev to work on a
different ID. Each update also checks the originally selected daemon's stable identity.
An older or different daemon at the same socket cannot receive an unchecked dev installation.
Run `dev` on the daemon machine: snapshots are passed by filesystem path, not uploaded.
Ctrl-C or SIGTERM stops polling, waits for the current installation request to finish,
removes temporary snapshots, and leaves the last selected revision installed. The exit status
is 130 for Ctrl-C and 143 for SIGTERM. An in-flight installation has no CLI read deadline;
the watcher retains its captured files until the daemon replies or the connection ends.

If you use a framework or TypeScript, run its build watcher separately and point `plugin dev`
at the directory containing the built manifest, backend and UI assets. Bundle dependencies;
`node_modules` and `.git` are excluded. Validation checks package structure and API declarations,
not whether every UI interaction or backend operation will succeed.

## Share a version and recover

~~~sh
kelpi_test plugin pack ~/code/my-kelpi-pane --out /tmp/my-pane.kelpi-plugin
kelpi_test plugin install /tmp/my-pane.kelpi-plugin --trust
kelpi_test plugin history example.my-pane
kelpi_test plugin rollback example.my-pane
~~~

Choose an unused output filename outside the source directory, in an existing destination
directory. Packing never overwrites an existing file and does not publish it. Transfer the
artifact to the target daemon machine before installing it there. See the
[package format](plugins.md#package-format) and [SDK artifacts](plugins.md#sdk-artifacts) for
the distinction between a `.kelpi-plugin` plugin and the SDK's npm `.tgz`.

Settings → Plugins → Versions shows retained versions, full revision IDs on hover, installation
dates and the current selection. **Use this version** selects that exact retained build.
Compatibility problems appear beside the affected revision and disable its switch button.
The daemon checks again when the action runs, including changes to saved state since the
history was loaded. **Refresh versions** rereads the current history.

History retains up to 100 selected revisions. Rollback without `--revision` picks the most
recently selected other revision; use a full SHA-256 revision from history to select an exact
build, including a newer one. Package version labels do not replace content identity.

Updates and rollback preserve plugin panes, their saved state and native sessions. They
remount plugin views and restart plugin backends. They do not rewind data from a successful
version or undo external effects of trusted code. The [recovery contract](plugins.md#updates-and-recovery)
explains state-version checks, activation failure recovery and retained-history limits.

## Validate your plugin

Test the actual artifact in the private instance, exercise its views and commands, install a
changed version, and select the previous revision. Save pane state and keep native sessions
open while doing this. Increase a view's `stateVersion` only when you have implemented reading
and migrating its older state; writing the newer version prevents rollback to a renderer
that cannot read it.

The repository's `plugin-authoring` scenario automates this workflow with an external temporary
project, a real daemon/CLI/Electron instance, a native PTY and an owned loopback browser page:

~~~sh
node scripts/scenario.mjs plugin-authoring --window hidden
node scripts/scenario.mjs plugin-authoring --window onscreen --no-build
~~~

Use `--no-build` only if the checkout and its generated bundles have not changed since the
preceding build. Hidden runs verify behavior; use an onscreen run for visual inspection.
These are targeted authoring checks; see the [validation guide](plugin-validation.md) for
other feature scenarios and the recorded evidence. The SDK package also
has an external consumer check:

~~~sh
pnpm --filter @kelpi/plugin-sdk test:package
~~~

This packs the real SDK, installs it into a temporary external project, and checks Node-only
backend types, browser view types and runtime imports. It does not publish to npm.
