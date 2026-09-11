# Browser Lab

An SDK-only replacement for a native Kelpi browser pane. The plugin supplies its own tabs, address bar, navigation, Find, bookmarks, page tools and private-mode confirmation. Kelpi continues to own the native page, its storage session, geometry, focus and crash recovery. There is no plugin backend or build step.

To try it without replacing your installed Kelpi, run a private development instance from the checkout root:

```sh
pnpm install --frozen-lockfile
node scripts/dev-instance.mjs --state out/browser-plugin-playground
```

In another terminal at the checkout root, use the `KELPI_SOCKET` value printed by that instance and the CLI built from the same checkout:

```sh
export KELPI_SOCKET='tcp:127.0.0.1:PORT_FROM_THE_INSTANCE'
export KELPI_REQUIRE_SOCKET=1
node packages/cli/dist/kelpi.js plugin validate "$PWD/examples/plugins/browser-lab"
node packages/cli/dist/kelpi.js plugin install "$PWD/examples/plugins/browser-lab" --trust
node packages/cli/dist/kelpi.js web open https://example.com
```

Choose **Browser Lab** in the pane's **Browser renderer** selector. Choosing the bundled browser, reloading the plugin, or reloading Kelpi's client retains the native tabs and their live page state. Private-mode changes explicitly reload all tabs against a different native storage session; Browser Lab asks before making that change.

With the same terminal environment, run `node packages/cli/dist/kelpi.js plugin dev examples/plugins/browser-lab --trust` while editing. Settings → Plugins → Versions selects compatible retained revisions without replacing the native tabs or storage sessions. The [development guide](../../../docs/plugin-development.md) covers packaging this example and the limits of rollback.

The example uses the injected `kelpi.browser` facade for daemon operations and `kelpi.browser.attach({element, onPresentation, onAction})` to reserve its page rectangle. The host decides whether native page display is available in the current client. Remote and phone clients can control the owning daemon's browser tabs, but they display an availability card when they cannot embed that shell's native page. A connected remote page host does not make native pixels available in the viewing window.

Tools and bookmarks are HTML popovers. Their `surface.setCovered(true)` calls park the native page while the popup covers its rectangle; closing the popup restores it. Find is a sibling row that resizes the page area. The SDK measures the element, and the host clips its native placement to the actual iframe and pane. The plugin never supplies a native window ID or absolute screen coordinates.

The `browser.changed` watch invalidates the view's snapshot. Reads are serialized, and an incoming navigation update preserves an address being edited. Page input goes directly to the native page. The host forwards address and Find shortcuts to the plugin through `onAction`, while `surface.focus()` returns focus to the native page.

The example deliberately keeps its UI small: it demonstrates shared favourites, text capture, native element inspection and page zoom. It does not reproduce every bundled browser control, batch pickup UI or cookie editor; those remain available in Kelpi's bundled browser and CLI. Captures and other SDK replies retain the host's size limits.

Run its private, owned-loopback live scenario from the repository:

```sh
node scripts/scenario.mjs plugin-browser-features --window hidden
node scripts/scenario.mjs plugin-browser-features --window onscreen
```

The scenario records native target identities, page state, placement logs and bundle hashes. Its onscreen harness captures the composed native window and also saves a separate native-page image. A normal DOM screenshot may omit the sibling `WebContentsView`, and hidden-lane screenshots are not visual evidence. The phone checks use Chromium emulation; physical-device keyboards and OS IME behavior still need device testing.

See the [browser contract](../../../docs/plugin-browser.md),
[dated validation record](../../../docs/plugin-validation.md), and
[plugin roadmap](../../../docs/plugin-roadmap.md) for supported behavior and remaining work.
