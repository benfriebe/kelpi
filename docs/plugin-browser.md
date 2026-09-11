# Replaceable browser panes

Browser panes have a registered bundled renderer and a `browser` replacement placement.
A plugin can supply tabs, navigation, address editing, Find, favourites and page tools while
Kelpi retains the existing native pages and storage sessions. Switching renderers, reloading
the plugin or falling back to the bundled browser keeps those pages alive.

See the [plugin roadmap](plugin-roadmap.md) for overall scope and the
[development guide](plugin-development.md) for browser starters, dev watching and portable packages.

## Try Browser Lab alongside your installed Kelpi

From this checkout, after `pnpm install --frozen-lockfile`:

```sh
node scripts/dev-instance.mjs --state out/browser-plugin-playground
```

The script builds and starts a second Kelpi with its own daemon, database, sockets and
Electron profile. Install the absolute path to `examples/plugins/browser-lab` in that instance's
Settings → Plugins, accepting local plugin trust. Open a browser pane and choose **Browser Lab** in
its **Browser renderer** selector. The example requires no backend or separate build.

For an external terminal, use this instance's printed socket and this checkout's CLI:

```sh
KELPI_SOCKET='THE_PRINTED_SOCKET' KELPI_REQUIRE_SOCKET=1 \
  node packages/cli/dist/kelpi.js plugin install examples/plugins/browser-lab --trust
```

The development guide's `kelpi_test` helper supplies this same route. Run
`kelpi_test plugin dev examples/plugins/browser-lab --trust` from the checkout root to install
source changes as you edit. Settings → Plugins → Versions selects compatible retained code;
updates and rollback preserve native tabs and sessions. A revision unable to read saved renderer
preferences is rejected under the [recovery contract](plugins.md#updates-and-recovery).

The renderer choice is stored per daemon in the current client origin and applies to that
daemon's browser panes. Remote daemons have independent choices. Missing, disabled or failed
renderers restore the bundled browser; an explicit retry loads a recovered view. Renderer
preferences saved with `setState` belong to the pane/view pair, separate from native tabs,
cookies and page state.

## Declare and attach a renderer

```json
{
  "id": "example.my-browser",
  "name": "My Browser",
  "version": "1.0.0",
  "apiVersion": 1,
  "trust": "full",
  "contributes": {
    "views": [{
      "id": "example.my-browser.renderer",
      "title": "My Browser",
      "entry": "ui/index.html",
      "placements": ["browser"]
    }]
  }
}
```

Browser replacements use isolated views. The owning feature host grants attachment only
to the selected renderer and supplies its actual pane/workspace context. A plugin cannot
change the attachment target by supplying a pane or native window ID.

```js
await kelpi.ready;
const status = document.querySelector('#status');
const address = document.querySelector('#address');
let surface, pendingFocus = false;
surface = await kelpi.browser.attach({
  element: document.querySelector('#page-slot'),
  onPresentation(value) {
    status.textContent = value.available ? '' : value.reason;
  },
  onAction(action) {
    pendingFocus = false;
    if (action.type === 'focusAddress') address.focus();
    else if (action.type === 'showFind') showFind();
    else if (surface) surface.focus();
    else pendingFocus = true;
  }
});
if (pendingFocus) surface.focus();
addEventListener('pagehide', () => surface.dispose(), { once: true });
```

The element must be a real slot in the plugin document. The SDK observes its layout and
visibility; the host clips measured bounds to the actual iframe and window viewport. Native
page geometry cannot extend outside the plugin's allocated rectangle. Kelpi reserves the
existing focus-ring gutter and supplies empty, unavailable and crashed-page cards with
native reload recovery.

Both callbacks may run before `attach()` resolves. Do not await that promise from either
callback; defer actions needing the surface until attachment completes, as above.
Presentation receives local availability, visibility and focus, with initial/latest
delivery and one callback awaiting acknowledgement at a time. Callback failure or a
30-second timeout fails the renderer and restores the bundled view. Actions return
undefined/null; action rejection fails that request. There are at most 16 pending actions,
each with a five-second deadline, and at most 128 attachments over a view's lifetime.

Native pages paint above HTML. Use `surface.setCovered(true)` before opening a plugin popup
over the page slot; it hides both the native page and host recovery card. Restore with
`setCovered(false)` when the popup closes. Find bars and other persistent controls can be
sibling rows that resize the slot. Kelpi's own menus and dialogs retain their existing
native-page parking and poster handling.

`surface.focus()` releases a plugin text caret and focuses its visible, uncovered native
page. It cannot claim focus while unavailable or hidden. The host sends address/Find
actions for native shortcuts, preserving their owning pane and daemon. Pending host actions
are cancelled when the pane becomes hidden or loses focus. Ordinary editing stays in the
plugin input. Browser Lab also preserves address drafts while navigation updates arrive;
renderer authors manage that draft behavior in their own UI.
`dispose()` removes placement and observers without closing a tab or clearing storage.

## Shared browser API

The [public declarations](../packages/plugin-sdk/browser-pane.d.ts) describe the complete
`browser` facade available to backend and view plugins. Only `attach` is view-only.

| Area | Methods |
| --- | --- |
| State | `get`, `watch`, `unwatch` |
| Navigation | `navigate`, `url`, `back`, `forward`, `reload`, `stop`, `focus`, `blur` |
| Tabs and storage session | `tabs.open/select/close/reorder`, `setPrivate` |
| Page tools | `find`, `zoom`, `toggleDevTools`, `capture`, `exec`, `console` |
| Shared favourites | `favourites.list/toggle/remove/rename/move` |
| Cookies | `cookies.list/clear/delete/set` |
| Element selection | `inspect`, `inspectResult`, `batch.state/toggle/cancel/remove/comment/focus/send` |

Snapshots include tabs, navigation history availability, loading, private mode, shared
favourites, native host identity and bounded inspector metadata. Register event listeners
before `watch()`, which returns both a subscription ID and initial state. `browser.changed`
invalidates that subscription's snapshot; call `get()` for current state. Serialize reads
and reread when another invalidation arrives in flight. `browser.closed` ends the watch.
Unmount, disconnect and plugin release clean up their subscriptions and pending operations.
The daemon bounds browser subscriptions at 128 across all owners.

`inspection.revision` changes for native picker results and batch edits, including comment
changes that leave the item count unchanged. Read `batch.state()` or `inspectResult()` when
that revision changes. Snapshots carry small counts/flags, keeping captured DOM and page
text out of navigation updates. Inspector results retain their existing consumptive clear
option; replacements choose explicitly whether to clear them.

Operations capture their pane, tab, host and storage-session generation. Closing/reusing a
tab, changing hosts, releasing the view, parking a pane or rebuilding its private session
rejects obsolete work. Explicit background-tab targets remain bound to that tab even if
selection changes during the request. `exec` preserves arbitrary keys in returned page
JSON. Captures and other replies retain the existing 256 KiB plugin JSON limit; an oversized
result rejects. These are trusted local-plugin capabilities, including page code and
cookies, within the existing plugin trust model.

Shared actions run through the corresponding native `web-*` operation hooks once, so
before hooks can veto them and after hooks observe their result. Targets are captured
before an asynchronous hook runs and checked again before effects. Cancellation releases
pending waits; it does not roll back a native action already delivered to the page host.
The bundled UI reads native state through its own transport, so large native favourites
or tab collections cannot remove embedding merely by exceeding a plugin reply limit.

`setPrivate` explicitly rebuilds every native tab against the other storage session. Page
JavaScript state does not survive that operation. Browser Lab asks for confirmation before
making it; ordinary renderer swaps perform no storage-session rebuild.

## Remote clients and native ownership

The same replacement host is used by the primary workspace, embedded remote workspaces,
direct browser attachments and phone views. Browser operations always target the owning
daemon. Its connected Electron host can execute them remotely, but only the UI in that
host's native window can embed its page. `snapshot.host.available` therefore differs from
the view's `presentation.available`: a remote page can be controllable without local pixels.
Clients without local embedding show an availability card and retain browser controls.

Kelpi keeps its existing single registered browser host per daemon. This change does not
stream native page pixels to browsers/phones or distribute page ownership among several
Electron hosts. Moving a pane between workspaces preserves its native page; explicitly
parking/closing it retains the existing native lifecycle.

## Validation

Run `pnpm check` and `node scripts/scenario.mjs plugin-browser-features --window hidden`.
The scenario uses private daemons and owned loopback pages to verify native page identity,
navigation, focus, placement, fallback, host loss and remote ownership. The
[validation record](plugin-validation.md) records source revisions, completed gates and visual
evidence from past runs.
Phone checks use browser emulation; physical-device keyboards/IME and packaged-release
validation are separate checks.
