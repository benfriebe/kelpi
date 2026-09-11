# Develop a Kelpi plugin

Plugins are self-contained packages installed on the daemon machine. You can author one
outside this repository and test it beside your installed Kelpi.

## Start a private instance

From the feature checkout:

~~~sh
pnpm install --frozen-lockfile
node scripts/dev-instance.mjs --state out/plugin-playground
~~~

The launcher builds that checkout and prints its private socket, ports and state directory.
It uses a separate database and Electron profile. Keep it running while testing; Ctrl-C stops
the instance and retains its data for the next launch.

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
kelpi_test plugin init ~/code/my-kelpi-pane --id example.my-pane --template pane
kelpi_test plugin validate ~/code/my-kelpi-pane
kelpi_test plugin dev ~/code/my-kelpi-pane --trust
~~~

The templates have no build step or third-party runtime dependencies:

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
The [Terminal Lab](../examples/plugins/terminal-lab) demonstrates a complete terminal emulator;
the [Document Lab](../examples/plugins/document-lab) and
[Browser Lab](../examples/plugins/browser-lab) cover their more advanced operations.

The dev command prints JSON-line events: `watching`, `applying`, `applied`, `invalid`, `failed`
and `stopped`. It requires explicit trust because edited backend code can execute with your
account's access. It captures validated bytes, serializes installations, and waits for a
stable changed revision across polling reads. The default polling interval is one second.
An incomplete manifest, missing entry, or failed backend update leaves the previous working
revision available. Edit again to repair it. An unchanged failed revision is not retried
repeatedly; change its bytes or restart dev to retry it.

The first valid manifest pins the plugin ID for that dev session. Restart dev to work on a
different ID. Each update also checks the originally selected daemon's stable identity.
An older or different daemon at the same socket cannot receive an unchecked dev installation.
Ctrl-C or SIGTERM stops polling, waits for the current installation request to finish,
removes temporary snapshots, and leaves the last selected revision installed.

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

Choose an unused output filename outside the source directory. Packing never overwrites an
existing file. See [package format and SDK artifacts](plugins.md#package-format) for the
portable format and installing the SDK into a project outside the monorepo.

Settings → Plugins → Versions shows retained versions, full revision IDs on hover, installation
dates and the current selection. **Use this version** selects that exact retained build.
Compatibility problems appear beside the affected revision and disable its switch button.
The daemon checks again when the action runs, including changes to saved state since the
history was loaded. **Refresh versions** rereads the current history.

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

Hidden runs verify behavior; use an onscreen run for visual inspection. The SDK package also
has an external consumer check:

~~~sh
pnpm --filter @kelpi/plugin-sdk test:package
~~~
