# Web Pane — Behavioral Specification

This document specifies the web pane as Kelpi implements it today. Where the behaviour lives (TypeScript):

- `packages/daemon/src/webpane/handlers.ts`: all `kelpi web *` socket handlers; `packages/daemon/src/ws/web-ui.ts` and `packages/daemon/src/ws/sync.ts`: the GUI-only WS verbs (batch inspect lifecycle, find, zoom, stop, dev tools, favourites, cookie writes, console subscriptions)
- `packages/daemon/src/webpane/*`: `service.ts` (the host RPC seam and event routing), `console.ts` + `ring.ts` (console buffer), `inspect.ts` (arm, queue, sanitiser, paste format), `batch.ts` (element pickup sessions), `find.ts` (needle memory), `favourites.ts`, `resolve.ts` (pane/tab resolution), `host.ts` (host registry, timeouts)
- `packages/daemon/src/store/reducers/web.ts`, `reducers/panes.ts`, `reducers/url.ts`: per-workspace web state (tabs, navigation, URL/title mirroring, open/close, URL normalization)
- `packages/protocol/src/wire/decode.ts`: wire parsing for the `web-*` command family
- `packages/cli/src/commands/web.ts`, `packages/cli/src/routing.ts`: the `kelpi web` / `kelpi open` CLI surface
- `packages/shell/src/webhost/*`: the Electron host, one `WebContentsView` + CDP session per tab (`tab.ts`), the verb dispatcher (`dispatch.ts`), the tab registry (`registry.ts`), injected page scripts (`scripts.ts`), console formatting (`console-format.ts`), storage partitions and cookies (`sessions.ts`), the error card (`error-page.ts`), chord forwarding (`keys.ts`), the automation viewport (`viewport-pin.ts`)
- `packages/client/src/webpane/*`: chrome (`WebPane.tsx`), panels (`BatchPanel.tsx`, `StoragePanel.tsx`, `FavouritesMenu.tsx`, `WebFindBar.tsx`), the keyboard layer (`priority.ts`), the progress strip (`progress.ts`), WS command bindings (`commands.ts`)
- `packages/daemon/src/db/persistence.ts`, `packages/daemon/src/db/schema.ts`, `packages/core/src/codec/json-columns.ts`: tab persistence

A web pane is a pane of type `"web"`: an embedded browser with tabs, a URL-bar chrome, favourites, find-in-page, a per-pane cookie store (optionally private/ephemeral), and a large agent-facing automation surface exposed over the newline-JSON socket protocol (`kelpi web …`). Each tab is an Electron `WebContentsView` hosted in the shell process and driven via CDP; the daemon owns the pane's state and proxies wire commands to the host over its own RPC seam (`packages/daemon/src/webpane/HOST_PROTOCOL.md`). **The wire protocol is byte-compatible with the pre-port `kelpi` CLI, which keeps working unchanged.**

---

## 1. Architecture map

Three layers of state:

1. **Workspace state** (persisted, reducer-owned): `Pane` (type `web`, title, label…) plus a sidecar `WebPaneState` in `workspace.webPanes[paneID] = {tabs, activeTabID, isPrivate}` (`packages/daemon/src/store/types.ts:41-45`), and nothing else. This is what CLI read commands and persistence see.
2. **Daemon runtime state** (`WebPaneService`, `packages/daemon/src/webpane/service.ts:140-149`; never persisted):
   - the per-pane console ring buffer and its follow subscribers (`console.ts`), shared by `kelpi web console --follow` and the WS `web-console-subscribe` stream (§9.3);
   - the inspector arm `{tabID, nonce, sendTo, submit}` (`inspect.ts:67-75`): `submit` ("append Enter after pasting the inspect payload", set by `kelpi web inspect --submit`) is a field of the arm rather than a separate map;
   - the inspect-result queue (cap 32), the batch-inspect session (`batch.ts`), the remembered find needle (`find.ts`), and the host RPC registry (`host.ts`).
   The URL-bar focus request (⌘L, blank-pane open) is client-side state, not daemon state: a per-pane request token (`packages/client/src/App.tsx:924`) whose bump tells the pane's chrome to focus + select-all the URL bar, and a diff of the on-screen blank web panes against the last snapshot for fresh opens (`packages/client/src/webpane/hooks.ts:179-217`).
3. **Host runtime** (Electron shell, `packages/shell/src/webhost/registry.ts`): the actual browser views, one `WebContentsView` + CDP session per tab, all sharing the pane's cookie/storage store, keyed by pane UUID then tab UUID. The daemon announces every web pane to the host as soon as the host registers (`service.ts:334-345`) or the pane is created (`service.ts:366-373`), and the host builds one view per tab immediately, not lazily (`registry.ts:111-131`); a re-announced pane is reconciled in place so live pages survive. Views survive UI rebuilds and workspace switches and are destroyed only when the pane closes (or when private mode flips). "The view isn't built yet" therefore means "no host is attached": wire reads fall back to state (`web-url`), cookie reads answer empty, and everything that needs a live page fails with `no web pane host connected` (§8.7).

Everything observable (URL/title changes, console lines, picker results, find counts, batch-marker interactions) flows from the runtime layer back into workspace state so persistence, pane headers, and CLI replies stay consistent.

---

## 2. Data model

```ts
interface WebTab {
  id: string;          // UUID
  url: string;         // last known / intended URL (normalized)
  title: string;       // last reported page title, "" until first report
}
// displayLabel(tab): title || host(url) || url || "New Tab"

// packages/daemon/src/store/types.ts:41-45 (persisted with the workspace)
interface WebPaneState {
  tabs: WebTab[];                    // display order
  activeTabID: string | null;       // falls back to tabs[0] when stale/null
  isPrivate: boolean;               // ephemeral storage partition
}

// Daemon runtime state, per pane, held by WebPaneService (never persisted)
interface WebPaneRuntime {
  // console capture (packages/daemon/src/webpane/console.ts)
  consoleBuffer: RingBuffer<ConsoleLine>;   // capacity 1000

  // element picker (single-shot) (packages/daemon/src/webpane/inspect.ts:67-75)
  inspectArm: {
    tabID: string;
    nonce: string;              // nonce installed at arm time
    sendTo: string | null;      // resolved destination pane UUID from --send-to
    submit: boolean;            // --submit: paste + Enter instead of paste only
  } | null;                     // null = not armed
  inspectResultQueue: InspectResult[];  // cap 32, oldest dropped

  // batch annotate session (null = none) (packages/daemon/src/webpane/batch.ts:41-51)
  batchInspect: BatchInspectState | null;
  // in-session memory of the last batch destination: a pane UUID, never a "local" marker
  lastBatchTarget: string | null;
}

interface ConsoleLine {
  tabID: string;
  level: "log" | "debug" | "info" | "warn" | "error";
  message: string;          // pre-joined argument string (JS side joins with " ")
  url: string;              // location.href at capture time
  lineNumber?: number;      // only for window error events
  columnNumber?: number;
  capturedAt: Date;         // set daemon-side on receipt
}

interface InspectResult {
  tabID: string;
  selector: string;         // CSS selector generated by the picker
  xpath: string;
  tag: string;              // lowercase tag name
  elementID: string;        // element's id attribute ("" if none)
  outerHTML: string;        // sanitised, ≤16KB
  attributes: Record<string, string>;   // each value ≤1KB, keys ≤128B
  rect: { x: number; y: number; w: number; h: number };  // viewport-relative
  text: string;             // trimmed textContent, ≤1KB (JS pre-clips at 200 chars + "…")
  contextHTML: string;      // parent.outerHTML, ≤4KB
  url: string;              // page URL, ≤4KB
  capturedAt: Date;
  comment: string;          // "" for single-shot picks; batch comment stamped at send/drain
}

interface BatchInspectItem {
  id: string;               // UUID minted app-side when the pick arrives
  result: InspectResult;
  comment: string;
}

interface BatchInspectState {
  items: BatchInspectItem[];
  focusedItemID: string | null;  // bidirectional list↔page focus
  panelVisible: boolean;         // panel shown + page picker armed; items survive hide
}

interface Favourite {
  id: string;               // UUID
  url: string;
  title: string;
  createdAt: Date;
}
```

### 2.1 RingBuffer (console)

Fixed-capacity buffer (`packages/daemon/src/webpane/ring.ts`) pairing each value with a monotonically increasing `seq` (uint64, never recycled, even after eviction or `clear()`).

```ts
class RingBuffer<T> {
  capacity: number;              // 1000 for console
  entries: { seq: number; value: T }[];  // insertion order, seq strictly increasing
  nextSeq: number = 0;           // next seq to assign; always > every live seq
  droppedSinceLastDrain = 0;

  append(v) {
    if (entries.length >= capacity) { entries.shift(); droppedSinceLastDrain++; }
    entries.push({ seq: nextSeq++, value: v });
  }
  entriesSince(since) {         // since==0 → whole live buffer;
    // entries are seq-sorted → binary search for first seq >= since
  }
  acknowledgeDrops(): number {  // returns and resets droppedSinceLastDrain
  }
  clear() { entries = []; /* nextSeq NOT reset — pollers see the gap */ }
}
```

Invariants: `seq` is per-pane-buffer monotonic; `entries(since:N)` returns insertion order; `clear` preserves the seq namespace so a `--since` poller never sees duplicate seqs.

---

## 3. Opening a web pane

### 3.1 Entry points

| Entry | Path | Behavior |
|---|---|---|
| Menu bar **File → New Web Pane** / ⌘⇧O (`open_web_pane`, default-bound) | the client sends `web-open` (§3.3) with `pane_id` = `target` = the focused pane (`packages/client/src/App.tsx:1651-1660`) | new blank pane split off the *focused* pane, URL bar auto-focused |
| Pane-header globe button | `web-open` with `target` = that pane and `direction`: click = split right (`horizontal`), ⇧-click = split down (`vertical`) | new blank pane split off *that* pane |
| Pane context menu "New Web Pane" | same, direction horizontal | |
| `kelpi web open [--private] <url>` | wire `web-open` | new pane in caller's workspace (below) |
| `kelpi open <url-or-hostname>` / `kelpi open <web-file>` | routes to `web-open` CLI-side (§8.3) | same |
| Favourites menu entry / URL bar submit on an existing pane | navigates, does not open |

### 3.2 `openWebPane` (workspace reducer)

`openWebPane` (`packages/daemon/src/store/reducers/panes.ts:491`). Inputs: pre-allocated `paneID` + `tabID` (caller mints them so a CLI reply can echo concrete ids *before* the state change lands), `url`, optional `reusePaneID`, `isPrivate` (default false), optional `sourcePaneID` + `direction` (default horizontal).

Algorithm:

1. `normalized = normalizeURLInput(url)` (§4.1); build tab `{id: tabID, url: normalized, title: ""}`.
2. Build pane: `type: "web"`, `title: "Web"`, `workingDirectory: $HOME`, timestamps = now.
3. `webPanes[paneID] = { tabs: [tab], activeTabID: tabID, isPrivate }`.
4. If `reusePaneID` given and that pane exists (the `--here`-style park path — currently no caller passes it, but the machinery mirrors markdown's): cancel any active search on the reused pane, restore a zoom-saved layout, mark the new pane with `parkedSourcePaneID = reusePaneID`, replace the old leaf in the layout with the new pane, move the old pane into `parkedPanes` (closing the web pane later un-parks it). Focus new pane. Done.
5. Otherwise split: source = `sourcePaneID ?? focusedPaneID`. If a zoomed layout was saved, restore it first. Split the source leaf in `direction`, insert new pane; if there is no source (empty workspace), layout becomes a single leaf. Append pane, focus it, reset the predefined-layout index.

Blank-URL opens (`url === ""`) additionally make the client focus the fresh pane's URL bar (`packages/client/src/webpane/hooks.ts:179-217`: the client diffs the blank web panes on screen against its last snapshot, so a reload or re-attach adopts restored blank panes without stealing the caret, and only a pane that appeared after the first snapshot is treated as an open). The focus request must win the race against the web view claiming keyboard focus: the client hands the keyboard to the page only when no chrome text field holds the caret (`packages/client/src/webpane/WebPane.tsx:599-618`).

### 3.3 `web-open` socket handler (`handleWebOpen`)

Implemented in `packages/daemon/src/webpane/handlers.ts:181-229`.

- Target workspace: if the wire `pane_id` (caller's `KELPI_PANE_ID`) resolves to a pane, use *that pane's workspace*; else the active workspace. (So `kelpi web open` from a background-workspace pane lands next to the caller.) No workspace at all → `{"ok":false,"error":"no active workspace"}`.
- Optional `target` + `direction` (`packages/protocol/src/wire/decode.ts:417-431`): `target` names the pane to split off, honoured only when it is a visible pane of the routed workspace, otherwise the focused pane is split (`handlers.ts:188-204`); `direction` defaults to horizontal and an unrecognised value reads as absent, so a typo never drops the open. The client's globe button (click = `horizontal`, ⇧-click = `vertical`) and pane context menu send both (`packages/client/src/App.tsx:1651-1660`); the CLI never does (§8.6).
- Mint `newPaneID`, `newTabID`; reply **immediately** (before the state mutation):

```json
{"ok":true,"pane_id":"<uuid>","tab_id":"<uuid>","url":"https://example.com","private":false,"workspace_id":"<uuid>"}
```

`url` in the reply is the *normalized* URL; the raw URL is passed into `openWebPane`, which normalizes again (idempotent).

---

## 4. Coordinator: navigation, per-tab browser lifecycle

The host's tab registry (`packages/shell/src/webhost/registry.ts`, one entry per pane) owns one browser view per tab (`tab.ts`) plus the pane's storage partition (`sessions.ts`). Views are built as soon as the daemon announces the pane (`pane-open` on host registration or pane creation, §1), not lazily; the daemon's read paths consult state when no host is attached (§8.7). A `pane-close` notification (pane close) or a `pane-set-private` (private-mode flip) destroys every view of the pane (`registry.ts:106-110, 135-141`). Closing one tab tears down that tab's view, and the daemon's `forgetTab` clears the inspector arm if it pointed at that tab (`service.ts` `forgetTab`; tab-close must not leave the picker armed against a dead view).

Per-tab view creation (`packages/shell/src/webhost/tab.ts:305-330, 430-453`):

- Storage: the pane's shared store: the persistent `persist:kelpi-web` partition, or an in-memory `kelpi-web-private-<paneID>` partition when `isPrivate` (`sessions.ts:24-30`). Ordinary remote-content posture: `contextIsolation`, `sandbox`, no node integration, `webSecurity` on (§4.2); `backgroundThrottling: false` so hidden tabs keep running JS.
- Developer tools enabled (right-click → Inspect Element; see §16).
- Registers the `kelpiPost` CDP binding (`Runtime.addBinding`); the injected scripts post `{channel, body}` through it on the `kelpiInspect` and `kelpiBatchMarker` channels (`tab.ts:775-790`). Tab attribution comes from which CDP session fired; the main-frame check is rebuilt from `Runtime.executionContextCreated` (context → frame) plus `Page.frameNavigated` (which frame is the main one). Out-of-process frames have their own CDP target, so `frames.ts` auto-attaches to them and funnels their console lines into the same sink with the same tab id.
- Injects the page scripts (§7) with `Page.addScriptToEvaluateOnNewDocument` (document start, every frame; each script guards `window !== window.top` where it is main-frame only) and evaluates each once against the document that already exists (`tab.ts:440-448`). Console capture is CDP events, not a script (§7.1).
- Observes `did-navigate` / `did-navigate-in-page` (main frame) / `page-title-updated`; every URL/title change fires a `page-state` event `{paneID, tabID, url, title}`. Every loading/history change fires `nav-state {paneID, tabID, loading, canGoBack, canGoForward}` (no progress fraction: Chromium exposes none) with identical-payload dedup (`tab.ts:718-737`; Chromium fires `did-navigate` and `did-stop-loading` back to back on a fast page). Nothing is reported before the tab's first real navigate, so the bootstrap `about:blank` load cannot flash a progress strip.
- Seeds `lastAttemptedURL[tab] = tab.url` (`tab.ts:305`) and starts loading the tab's URL immediately if non-empty (restore path: the seed is what makes the error page's Retry work if the very first load fails).

### 4.1 URL input normalization — `normalizeURLInput(raw)`

`packages/daemon/src/store/reducers/url.ts:42` (`isLocalOrInternalHost` at `:9`). Promotes user-typed input to something parseable. Used by: URL bar submit, `openWebPane`, `webPaneNavigate`, `webPaneTabOpen`, and echoed in `web-open`/`web-navigate`/`web-tab-new` replies.

```
trim whitespace/newlines; empty → return as-is
contains "://" → return as-is
opaque scheme detection: first char is a letter AND there's a ":" AND
    the scheme part (before ":") is all [letters digits + - .] AND
    the char after ":" is NOT a digit         // digit ⇒ host:port, not scheme
  → return as-is   (covers data:, javascript:, mailto:, tel:, about:, file:)
host = text before first "/" then before first ":"
scheme = isLocalOrInternalHost(host) ? "http" : "https"
return scheme + "://" + trimmed
```

`isLocalOrInternalHost(host)` (case-insensitive):
- `localhost`, `127.0.0.1`, `0.0.0.0`, `::1` → true
- suffix `.local` or `.localhost` → true
- no `.` at all (single-label) → true (internal hostname / mDNS)
- IPv4 in RFC1918 / link-local: `10.*`, `192.168.*`, `172.16-31.*`, `169.254.*` → true
- else false

So `example.com` → `https://example.com`, `localhost:3000` → `http://localhost:3000`, `myhost` → `http://myhost`, `data:text/html,<h1>x</h1>` stays untouched.

### 4.2 Navigate / back / forward / reload / zoom

- `navigate(tab, to raw)`: normalize; unparseable → no-op. Record `lastAttemptedURL[tab]`; clear the tab's error-page flag; load via `loadURL` with the exact URL the daemon normalized (`packages/shell/src/webhost/tab.ts:920-923`). **`file://` URLs are loaded as-is with `webSecurity` left on** (`tab.ts:319`): Chromium already lets a `file://` document load sibling `<img>`/`<script>`/`<link>` assets (`./style.css`, images), which is the feature; `fetch`/XHR from a local page to a sibling file is blocked, a documented limitation rather than an accident (`tab.ts:45-52`). Remote URLs are a normal load.
- `goBack` / `goForward`: no-op unless the engine says it can; clears the error-page flag first.
- `reload(hard)`: if the tab currently shows the inline error page, reload retries `lastAttemptedURL` instead of redrawing the stub. Else normal reload; `hard` bypasses cache ("reload from origin").
- `adjustPageZoom(delta | null)`: null resets to 1.0; else `zoom += delta`; clamp to `[0.5, 3.0]` (`packages/shell/src/webhost/dispatch.ts:65-68`, applied again in `tab.ts:1136-1140`). Zoom is per-tab, not persisted: Electron stores zoom per origin in the session, so the host re-applies the tab's own factor after every navigation and load (`tab.ts:1124-1132`). The GUI drives it over WS `web-zoom {tab_id, direction: in|out|reset}` (±0.1 per step, `packages/daemon/src/ws/web-ui.ts:236-258`).

The wire handlers (`web-navigate`/`-back`/`-forward`/`-reload`, `packages/daemon/src/webpane/handlers.ts:232-313`) always target the **active tab**; `web-navigate` also optimistically writes the normalized URL into `tabs[active].url` (`packages/daemon/src/store/reducers/web.ts`) before the engine round-trips (so a save right now persists the intent, and a host that reconnects later carries it).

### 4.3 Load failure → inline error page

State per tab: `lastAttemptedURL: string?`, `showingErrorPage: bool`, plus identities of the stub's own navigations.

- On provisional or committed navigation failure: build a small self-contained dark error card (no external assets): "Couldn't load page", the failed URL (monospace, blue), the error message, and a **Retry** anchor whose `href` is the failed URL (clicking re-navigates through the normal pipeline). HTML-escape `& < > "` in all three interpolations. `failedURL = lastAttemptedURL ?? currentURL ?? ""`; display "(unknown)" when empty, message fallback "The page could not be loaded.". The stub is loaded with **baseURL = the failed URL** so the engine's reported URL stays on what the user tried (URL bar doesn't flip to about:blank).
- The message comes from `webErrorMessage` (`packages/shell/src/webhost/error-page.ts:51-77`): Chromium's net-error symbol is mapped to a sentence for the common cases (`ERR_NAME_NOT_RESOLVED` → "The server could not be found.", `ERR_CONNECTION_REFUSED`, `ERR_TIMED_OUT` / `ERR_CONNECTION_TIMED_OUT`, `ERR_INTERNET_DISCONNECTED`, `ERR_CONNECTION_RESET`, `ERR_CONNECTION_CLOSED`, the SSL/certificate errors, `ERR_FILE_NOT_FOUND`, `ERR_ADDRESS_UNREACHABLE`); any other symbol is shown verbatim; an empty description falls back to "The page could not be loaded.". The negative numeric code is appended inside the message paragraph, e.g. `(-105)` (`error-page.ts:136`). Only main-frame failures raise the card: subframe failures and `-3 ERR_ABORTED` (a navigation replaced by a redirect, a second load, or a user cancel) are ignored (`tab.ts:680-683`). A failure also closes the load bracket (`nav-state loading:false`) immediately, without waiting for Chromium's own error page to commit.
- Mark `showingErrorPage[tab] = true` and remember the stub load's identity.
- `didStartProvisionalNavigation`: if this navigation *is* the stub's own load → ignore. Any other provisional nav (URL bar, Retry, back/forward, page JS) clears `showingErrorPage`.
- `didFinish`: if the finished load is the stub (flag still set) → keep `lastAttemptedURL`. Otherwise clear `lastAttemptedURL` (a later unrelated failure must not resurrect the old attempt) and re-apply an open find (§10).

### 4.4 URL/title mirroring — `webPaneStateChanged`

The daemon forwards every host `page-state` event (§4) into the workspace reducer (`packages/daemon/src/store/reducers/web.ts`):

- Look up the tab; unknown → drop.
- **Placeholder guard**: `url == "" || url == "about:blank"` → keep the previous URL (placeholders show up early in loads and after failures; they must not wipe the URL bar or persisted URL). Title is always taken.
- No-op if nothing changed.
- If the changed tab is the pane's resolved active tab and title is non-empty, sync the pane header title (`pane.title = title`).

`syncWebPaneHeader(paneID)` (called after every activeTab change — tab open/close/select/cycle): `pane.title = activeTab.displayLabel ?? "Web"` (no-op when equal).

---

## 5. Tabs

All tab state lives in `WebPaneState`; the runtime layer keeps a live view per tab (background tabs keep loading / running JS while hidden — only the active tab's view is visible).

- **Open** (`webPaneTabOpen(paneID, tabID, url, makeActive=true)`): caller mints `tabID`; duplicate id → drop. Append `WebTab(id, normalizeURLInput(url))`; if `makeActive` set active + sync header. Blank-URL new tab from the GUI (⌘T / `+` button) also bumps the URL-bar focus token; a preset-URL tab leaves focus alone.
- **Close** (`webPaneTabClose(paneID, tabID)`):
  - If it's the **only** tab: the GUI path converts this to a whole-pane close (full `closePane` flow). The **wire** path refuses instead: `{"ok":false,"error":"cannot close the only tab in a web pane, use `kelpi pane close` to close the pane itself"}`.
  - Else remove the tab; if it was active, activate the *left neighbour* (index `max(idx-1, 0)` of the new array). Sync header. Destroy the tab's runtime view. If find-in-page was open on this pane and the closed tab was active, re-run the needle on the new active tab (§10).
- **Select** (`webPaneTabSelect`): unknown id or already active → no-op. Set active, sync header, retarget an open find.
- **Cycle** (`webPaneTabCycle(offset)`): wraps modulo tab count (`+1` next / `-1` prev); no-op with ≤1 tab. Retargets find.
- **Reorder** (`webPaneTabReorder(orderedTabIDs)`): applied only when the id list is an exact permutation of the current tabs, else dropped. Reachable over WS as `web-tab-reorder {order}`, whose reply carries the post-mutation `order` and `applied: bool` (`packages/daemon/src/ws/web-ui.ts:182-203`). (No GUI drag currently drives it.)
- **Focused-pane conveniences** used by keyboard shortcuts (the client's priority layer, `packages/client/src/webpane/priority.ts`): tab cycle and close-active-tab operate on the focused pane iff it is a web pane.

### 5.1 Tab wire commands

`tabRef` resolution (`web-tab-close` / `web-tab-select`): a UUID string → must be a tab of this pane (`no tab with UUID '<ref>' in this web pane`); else an integer → 0-based index into `tabs` (`tab index 3 out of range (0..<2)`); else `tab ref must be a UUID or numeric index, got '<ref>'`.

- `web-tabs` reply:

```json
{"ok":true,"pane_id":"…","workspace_id":"…",
 "tabs":[{"id":"…","url":"https://…","title":"…","index":0,"active":true}, …]}
```

`active` compares against the *resolved* active tab (fallback tabs[0]).

- `web-tab-new` `{url, make_active}` → mints tab id, replies `{ok, pane_id, tab_id, workspace_id, url:<normalized>, active:<makeActive>}` then dispatches the open.
- `web-tab-close` / `web-tab-select` → `{ok, pane_id, workspace_id, tab_id}` (close refuses the last tab, see above).

### 5.2 Host-initiated tab death and popups

- **`window.open` is denied outright** (`setWindowOpenHandler` → `deny`, `packages/shell/src/webhost/tab.ts:602-608`): the daemon mints tab ids, so the host cannot conjure a tab for a popup. `target=_blank` links and scripted popups do nothing.
- **Renderer crash / destroyed view**: `render-process-gone` and `destroyed` (outside the host's own teardown) emit a `tab-closed` host event (`tab.ts:700-707`). The shell forgets the view without trying to destroy it again (`packages/shell/src/webhost/index.ts:316-320`); the daemon drops the inspector arm if it pointed at that tab and dispatches `web-tab-close` (`packages/daemon/src/webpane/service.ts:569-581`), which activates the left neighbour exactly as a wire close does.
- **Single-tab pane**: the reducer refuses to remove the only tab (`packages/daemon/src/store/reducers/web.ts:104-106`), so a crashed sole tab stays in daemon state with no host view. Every later verb addressed to it fails `web pane has no live tab <uuid>` (`packages/shell/src/webhost/dispatch.ts:355-365`) until the pane is closed or the host re-registers and rebuilds it.

---

## 6. Private mode

- `isPrivate` selects the storage partition at view creation: the shared persistent `persist:kelpi-web` partition vs an in-memory `kelpi-web-private-<paneID>` partition, one per pane so two private panes cannot see each other's cookies (`packages/shell/src/webhost/sessions.ts:24-30`). The partition is sealed into the browser views, so **flipping the flag destroys the pane's views**: the daemon notifies the host `pane-set-private` and the registry destroys and rebuilds every tab against the new store (tabs reload from their state URLs; live JS state is lost). The registry keeps a defensive backstop: a `pane-open` whose `isPrivate` doesn't match the existing views' partition triggers the same destroy + rebuild (`packages/shell/src/webhost/registry.ts:135-141`).
- GUI: the storage panel (§13) hosts the toggle behind a confirmation dialog. Enabling: "Tabs will reload in a non-persistent session. Live JS state will be lost; cookies created in private mode are discarded on quit." Disabling: "Tabs will reload against the persistent store. Live JS state will be lost; previously-saved cookies become visible again."
- Wire: `web-private` `{private: bool}` (required). Reply `{ok, pane_id, workspace_id, private:<requested>, changed:<bool>}`; idempotent (no state change / no view rebuild when already equal). CLI: `kelpi web private on|off` (accepts on/true/1/yes, off/false/0/no) → prints `private on: <pane_id>` or `… (no change)`.
- Persistence (§15): `isPrivate` is always persisted, but a private pane's tabs/URLs are **not** — restart restores a blank private pane.
- Chrome: the storage button shows a filled lock + accent tint when private.

---

## 7. Injected page scripts

Five scripts are injected into every tab at document start via CDP `Page.addScriptToEvaluateOnNewDocument` (`packages/shell/src/webhost/scripts.ts:1756-1758`, in this order: a `kelpiPost` bridge, the actuator (§7.4), the element picker (§7.2), find (§7.5) and batch markers (§7.3)). The injection runs in all frames, so each main-frame-only script carries `if (window !== window.top) return`. All are idempotent (guard flag; re-injection is a no-op so in-flight state survives same-document reinjection and bfcache restores). Each is a real TypeScript function serialised with `Function.prototype.toString()`, so a script may only reference what it defines itself. Scripts that talk to the host post `{channel, body}` through the `kelpiPost` CDP binding (`Runtime.addBinding`); the bridge also installs a `webkit.messageHandlers.<name>.postMessage(obj)` shim so the legacy channel calls keep working. Console capture is not a script (§7.1).

### 7.1 Console capture (`kelpiConsole` channel; all frames, document start)

There is no `kelpiConsole` script and no `kelpiConsole` channel any more: the console script is deliberately not injected (`packages/shell/src/webhost/scripts.ts:20-23`), because the CDP branch below already covers everything it wrapped and installing both would double-report every line. The host subscribes to `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.responseReceived` and `Network.loadingFailed` on each tab's CDP session (`tab.ts:818-884`), and on each out-of-process frame's child session with the same tab id (`frames.ts`), and formats them into the same message strings the injected wrapper produced (`packages/shell/src/webhost/console-format.ts`). Each line is `{level, message, url[, line, column]}`; `url` is the exception's or log entry's own URL when it has one, else the tab's current URL.

- `Runtime.consoleAPICalled` → `console.log/debug/info/warn/error`: arguments rendered per-arg and joined with a single space. CDP types map `warning` → `warn`, `verbose`/`trace` → `debug`, `assert`/`exception` → `error`, anything else → `log` (`console-format.ts:42-49`).
- `console.assert(falsy, ...rest)` → level `error`, message `"Assertion failed: " + join(rest)` (`"Assertion failed:"` alone when there is nothing to join).
- `Runtime.exceptionThrown` (uncaught errors) → level `error`; message = the exception's `description` (its stack) plus ` (source:line:col)` when a source URL is present; `line`/`column` are converted from CDP's 0-based numbers to the 1-based ones `window.onerror` reports (`console-format.ts:185-208`).
- An exception whose text contains `(in promise)` → `"Unhandled promise rejection: " + description`.
- `Log.entryAdded` → one line at the entry's level (same level map); entries with source `network` are dropped, because the `Network.*` handlers below already render exactly those failures and one failure must not become two lines (`console-format.ts:222-233`).
- `Network.loadingFailed`: `Fetch` requests → `"fetch failed — <errorText> — <url>"`; `XHR` → `"XHR error — <method> <url>"`; any other resource type → `"resource load failed: <tag> <url>"` with the tag derived from the CDP resource type (`Image`→`img`, `Script`→`script`, `Stylesheet`/`Font`/`Manifest`→`link`, `Media`→`video`, `Document`→`iframe`, else `resource`). Cancelled requests are not failures (navigating away cancels in-flight requests), and the main frame's own document failure is left to `did-fail-load` (§4.3) so a navigation failure is not labelled as a failed `<iframe>` (`tab.ts:865-883`).
- `Network.responseReceived` with status ≥ 400, `fetch`/XHR only: `"fetch <status> <statusText> — <url>"` / `"XHR <status> — <method> <url> — <statusText>"` (the statusText tail omitted when empty) (`console-format.ts:284-303`).

Differences from the injected wrapper, stated plainly (`console-format.ts:18-27`): object arguments render as Chromium's bounded preview rather than `JSON.stringify` output (`[Circular]` appears only for values the host serialises itself); `console.exception` and `securitypolicyviolation` are whatever Chromium reports for them.

Host side: each line becomes a `ConsoleLine` (tab id from the CDP session that fired, `capturedAt` = receipt time) sent to the daemon as a `console` host event and appended to the pane's ring buffer (`packages/daemon/src/webpane/console.ts:125-138`), followed by fan-out to follow subscribers (§9.3).

### 7.2 Element picker (`kelpiInspect` channel; main frame, document start)

Guard: `__kelpiInspectorInstalled`. Exposes:

- `window.__kelpiInspectorEnable(nonce, sticky)` — arm. Re-arming while armed disarms first. Sets `cursor: crosshair` on the document element (restoring the previous value on disarm). Installs **capture-phase** listeners for `mousemove`, `click`, `keydown`.
- `window.__kelpiInspectorDisable()` — full teardown: cursor restore, overlay hidden, listeners removed, state cleared.

Behavior while armed:
- **Hover**: a `position:fixed pointer-events:none` blue outline overlay (2px `#007AFF` border, `rgba(0,122,255,0.18)` fill, z-index 2147483647, 60ms position transitions) tracks the hovered element's bounding rect. Suspended (hidden) while the batch comment popover is open, and never outlines Kelpi's own overlay surfaces (elements carrying `data-kelpi-overlay` / `data-kelpi-batch-marker(s)` / `data-kelpi-batch-popover` / `data-kelpi-batch-focus-ring`, checked up the ancestor chain).
- **Click**: clicks on Kelpi overlay surfaces pass through untouched (badge clicks focus that marker; popover interactions are its own). While the batch popover is open, page clicks also pass through without capturing (finish the current comment first). Otherwise: `preventDefault + stopPropagation + stopImmediatePropagation`, capture the target, post the payload, and — unless sticky — self-disable.
- **Escape**: if the batch popover is open, Esc belongs to it (skip). Else snapshot the nonce, disable, and post `{nonce, cancelled: true}` (nonce must be snapshotted *before* disable clears it, or the host would drop the cancel).

Captured payload:

```json
{
  "nonce": "<armed nonce>",
  "selector": "<generated CSS selector>",
  "xpath": "<xpath>",
  "tag": "button", "element_id": "submit",
  "outer_html": "<button …>…</button>",
  "attributes": {"class": "…", …},
  "rect": {"x":…, "y":…, "w":…, "h":…},
  "text": "<trimmed textContent, ≤200 chars + '…'>",
  "context_html": "<parent.outerHTML, ≤4096 chars>",
  "url": "<location.href>",
  "captured_at": "<ISO>"
}
```

Selector generation (priority order): `#id` (CSS-escaped) → `[data-testid="…"]` / `[data-test="…"]` → `tag[name="…"]` → a chained path of up to 6 ancestors, each part `tag[.first2classes]:nth-of-type(n)`, stopping early at an id'd ancestor (`tag#id`). XPath: `//*[@id="…"]` when the element has an id, else a `/html/tag[n]/…` positional path.

Validation of `kelpiInspect` messages: the host accepts the binding call only from the main frame (`packages/shell/src/webhost/tab.ts:775-790`); the daemon then requires the armed tab to match and the payload nonce to equal the armed nonce (128-bit random hex minted per arm, `packages/daemon/src/webpane/inspect.ts:295`; defends against page JS spoofing the channel), silently dropping mismatches (`packages/daemon/src/webpane/service.ts:461-468`). `cancelled:true` → disarm, no result; and if a batch session exists, the whole session is dropped, items included, and empty markers are republished (`service.ts:469-478`, see §12.1). Single-shot (non-sticky) arms auto-disarm *before* the result is surfaced; sticky (batch) arms stay live until explicitly disarmed.

### 7.3 Batch markers (`kelpiBatchMarker` channel; main frame, document start)

Guard: `__kelpiBatchMarkersInstalled` (`packages/shell/src/webhost/scripts.ts`, `batchMarkerMain`). Renders numbered badges over each collected batch item plus a comment popover, all inside a full-viewport `position:fixed pointer-events:none` container (z-index 2147483646). API:

- `__kelpiBatchSetMarkers([{id, selector, label, comment}])` — diff-rebuild the badge set (does NOT clear the focused id — the focus ring/popover must survive re-syncs on every new pick). Entries whose selector no longer resolves via `querySelector` are skipped. Empty list → full teardown of badges + focus surfaces. If a `highlight(id)` arrived before its marker was synced (`pendingFocusID`), it is applied now. If the focused item vanished from the set, clear ring + popover; else refresh their content/positions.
- `__kelpiBatchClearMarkers()` — remove everything incl. popover; resets `__kelpiBatchHasOpenPopover`.
- `__kelpiBatchHighlight(id, scrollIntoView)` — focus a marker: remember as pending if not yet synced; else set focused, optionally `scrollIntoView({behavior:'smooth', block:'center'})`, pulse the badge (scale 1.6 → 1 over ~320ms), sync popover content, position ring + popover, and re-refresh after 400ms when scrolling (so ring/popover land where the scroll settled).
- `__kelpiBatchUnfocus()` — hide ring + popover (markers stay).
- `__kelpiBatchUpdateComment(id, comment)` — external (panel-side) comment push; updates the marker record and the popover textarea **only when the textarea does not have keyboard focus** (never clobber the user's cursor).

Visuals/behavior:
- **Badge**: fixed-position pill (`#007AFF` bg, white text+border, ≥18px round), positioned at the element's rect top-left minus 6px; re-query the selector on every refresh so badges track live DOM/layout changes; hidden when the element is collapsed (0×0) or fully off-viewport (partially visible elements keep their badge un-clamped). Badges are `pointer-events:auto`; click posts `{id}`.
- **Focus ring**: separate fixed div (2px `#007AFF` border, glow shadow), 3px outset around the focused element's rect; hidden when collapsed/off-screen.
- **Popover**: a dark fixed dialog (280px start, user-resizable via `resize:both`, min 220×130, max 90vw/80vh) containing a label line (`#<label> <selector>`, cyan monospace), a comment textarea (placeholder "Add a comment…"), and a footer with **Remove** (red outline) and **Done** (blue) buttons. Placement: below the element when there's room (or more room below than above), else above; vertically clamped 8px inside the viewport; horizontally centered in the *viewport*. Whenever shown it sets `window.__kelpiBatchHasOpenPopover = true` (cross-script signal read by the picker); hiding resets it. Textarea input posts `{commentChanged:{id, comment}}` live per keystroke. Esc or Cmd-Enter in the textarea (Cmd-Enter suppressed mid-IME-composition) posts `{dismiss:{id}}`; Done posts `{dismiss:{id}}`; Remove posts `{remove:{id}}`. Clicks/mousedowns inside the popover don't bubble to the page. The popover forces `cursor:default` (the picker put crosshair on the root).
- Scroll + resize listeners (capture) reposition badges/ring/popover continuously.

Message envelopes (host validates main-frame): `{id}` badge click; `{commentChanged:{id,comment}}`; `{dismiss:{id}}`; `{remove:{id}}`.

### 7.4 Actuator (`window.__kelpiAct`; main frame, document start)

No message channel: invoked synchronously by the host through JS evaluation (`packages/shell/src/webhost/scripts.ts`, `actuatorMain`; call wrapper at `:1770`). This namespace is the single source of truth for every `kelpi web` action/read verb; the host never parses selectors or walks the DOM. Every actuator call on a view that is not on screen is measured against the fixed automation viewport (§8.4).

**Selector grammar** (one string, three explicit forms + auto-detect; leading whitespace trimmed before detection, trailing preserved):

| Form | Meaning |
|---|---|
| `css:<sel>` | `querySelector(sel)` |
| `text:<exact>` | first (smallest-enclosing) element whose trimmed `textContent` === exact |
| `text:/<pattern>/<flags>` | same but regex match (bad regex → invalid: `bad regex: <msg>`) |
| `role:<role>` | first element with matching ARIA role (explicit `role=` attr, else implicit map) |
| `role:<role>:name=<name>` | + accessible name must match exactly |
| bare | auto: leading char in `. # [ > * :` → CSS; else `text:` exact |

Explicit prefixes always win (a literal class "css:foo" is reachable via `text:css:foo`).

**Smallest-enclosing-element rule** (text/role forms): a TreeWalker over elements that rejects `<script>/<style>/<template>` subtrees, skips non-matches, and — crucially — skips any match that has a matching descendant, yielding only the innermost matching elements (a page's `<html>`/`<body>` both "contain" the text; agents want the `<button>`). `findAll` follows the same rule. `exists` uses a cheaper first-hit walker without the descendant check (CSS goes straight to `querySelector`).

**Implicit role map** (deliberately minimal): `a[href]→link, button→button, nav→navigation, main→main, header→banner, footer→contentinfo, aside→complementary, article→article, section→region, dialog→dialog, textarea→textbox, select→(multiple?listbox:combobox)`; `input[type]`: button/submit/reset/image/file→button, checkbox, radio, range→slider, search→searchbox, number→spinbutton, text/email/tel/url→textbox, **anything else (incl. hidden/password/color/date) → no role** (allowlist-only, so `role:textbox` can't accidentally hit a hidden CSRF token or a password field).

**Accessible name** (fallback chain, not full AccName): `aria-label` → `aria-labelledby` (joined referenced texts) → `<label for=id>` → `alt` → `title` → trimmed textContent.

**Methods** (each returns a plain object; `ok:false` always carries `error`):

- `find(sel)` / `findAll(sel)` — element lookup, exposed to `exec` as `$` / `$$`.
- `click(sel, {double, right, at:{x,y}})` — no match → `no match for selector: <sel>`. Dispatches the full synthetic sequence pointerdown → mousedown → pointerup → mouseup at the element's center (or the `at` element-local offset), `button:2` + a `contextmenu` event for right-click. For plain clicks it then calls the native `element.click()` (respects disabled state and native anchor/submit semantics) + optional `dblclick`; for `at`-clicks it dispatches a synthetic `click` carrying the coordinates instead (canvas UIs need clientX/Y; trade-off: native trusted-event semantics don't fire). Reply `{ok:true, matched:true, text:<trimmed textContent>}`.
- `type(sel, text, {submit, replace=true})` — not typable (`isTypable`: contentEditable, `<textarea>`, or `<input>` with a text-shaped type in [text, search, email, tel, url, password, number, date, datetime-local, time, month, week]) → `element is not typable (tag=…, type=…)`. Focuses first. contentEditable path: set textContent (append when `replace:false`), fire `input`, optional Enter keydown/keyup; reply `{ok:true, value:<textContent>}`. Input/textarea path: write via the **prototype value setter** (so React/Vue/Svelte controlled inputs accept the write), fire `input` + `change`; `submit` additionally fires an Enter keydown/keyup **and** `form.requestSubmit()` when the element belongs to a form; reply `{ok:true, value:<el.value>}`. Key events are keydown+keyup only (no deprecated keypress).
- `text(sel, {maxBytes=1_000_000})` — prefers `innerText` (human-visible: collapses whitespace, skips display:none), falls back to `textContent`; byte-clip on UTF-8 code-point boundary; reply `{ok, text, truncated}`.
- `attr(sel, name)` — empty name → error. Reply `{ok, name, value: string|null, present: bool, truncated}`; `present` (hasAttribute) distinguishes "absent" from "present but empty" (`<input disabled>`); value clipped at 64KB.
- `count(sel)` → `{ok, count}` (smallest-enclosing matches; invalid selector → `{ok:false,error}`).
- `exists(sel)` → `{ok:true, found: bool}` (never errors; invalid selector → found:false).
- `dom(sel, {maxBytes=16384})` → `{ok, outer_html, truncated}`.
- `select(sel, valueOrLabel)` — must be a `<select>`. Match by option `value` first, then by trimmed visible label. No match → `no option with value or label: <needle>`. Focus, write via the prototype setter, fire `input`+`change`. Reply `{ok, value, label}`.
- `scroll(sel, {block='center', behavior='instant'})` — `scrollIntoView({block, behavior})` with a plain `scrollIntoView()` fallback. Reply `{ok, behavior[, rect:{x,y,width,height}]}` — rect omitted for `smooth` (the animation hasn't run; a pre-animation rect would mislead).
- `hover(sel)` — synthetic pointerover/pointerenter + mouseover (bubbling) + mouseenter (non-bubbling), coordinates at element center. CSS `:hover` states will NOT respond (JS listeners only). Reply `{ok, matched:true}`.
- `key(name, {selector})` — key table (case-insensitive): enter/return, tab, escape/esc, space, backspace, delete, arrowup/…/arrowright plus up/down/left/right aliases, home, end, pageup, pagedown — each with `key`, `code`, legacy `keyCode`/`which`. Unknown → `unknown key: <name>`. Target = selector match (focused first) or `document.activeElement || body`. Dispatch keydown+keyup. Reply `{ok, key, code}`.
- `wait(opts)` → **returns a Promise**; polls every 100ms until the condition passes or timeout (default 10000ms; `opts.timeout` must be a positive number to override). Condition selection: `opts.for` if given, else `url-match` when `opts.urlMatch` present, else `exists`. Conditions (all selector-based ones require `opts.selector`, error otherwise):
  - `visible` — element found AND connected AND `getClientRects().length > 0` AND computed `visibility !== 'hidden'` (getClientRects, not offsetParent, so fixed-position toasts/modals count as visible).
  - `hidden` — not found, or fails the visibility test.
  - `exists` — first-hit existence.
  - `count=N` — smallest-enclosing match count === N (N parsed as non-negative int; compile the selector once up front).
  - `text=X` — target element's trimmed text === X, or matches `/re/flags` when X is slash-delimited.
  - `url-match` — `location.href` contains the string, or matches `/re/flags` (`opts.urlMatch` required).
  Success `{ok:true, condition, waited_ms}`; timeout `{ok:false, error:"timeout", condition, waited_ms}`; bad input resolves `{ok:false, error}` immediately.
- Underscore-prefixed internals `_parseSelector/_compile/_accessibleName/_implicitRole/_clipToBytes` are exposed for tests only.

Regex predicates reset `lastIndex` before every test (stateful `/g`//`y` flags would otherwise skip alternate candidates).

### 7.5 Find-in-page (`window.__kelpiWebFind`, `kelpiWebFind` channel; main frame, document **end**)

Guard: existing `window.__kelpiWebFind` (`packages/shell/src/webhost/scripts.ts:1582-1660`). Despite the heading, the script is injected at document start like the others (§7); the body-dependent work is deferred instead (style injection retries on rAF until `document.head` exists). API: `search(needle)`, `next()`, `prev()`, `clear()`. Every call **returns** `{total: int, current: int}` (current is `-1` when there are no matches, else 0-based index of the active match); the host reads it straight off the evaluation (`scripts.ts:1823-1830`, `dispatch.ts:578-594`). The script still posts the same object on the `kelpiWebFind` channel, but the host's binding handler ignores that channel (`tab.ts:782-783`), so the post is vestigial.

- Injects a `<style>`: `mark.kelpi-webfind-match { background:<match>; color:<matchText>; border-radius:2px }`, current match `<current>`/`<currentText>`. The colours are placeholders substituted at build time from the find-palette settings, at boot and again on every `settings-changed`, defaulting to `#F2D027`/`#000000` and `#FF7A00`/`#000000` (the terminal/markdown find palette; `scripts.ts:35-80`). Only `#rrggbb` values are accepted. A page that has already loaded keeps the colours it installed until it reloads.
- `search`: clear old marks first. Empty needle or no body → post `{0,-1}`. Build `new RegExp(escapeRegex(needle), 'gi')` — engine-side case folding avoids offset drift from locale-sensitive `toLowerCase()`. TreeWalker over text nodes, skipping `<script>/<style>/<noscript>` subtrees and text already inside a match mark. For each matching text node, split it into fragments wrapping every occurrence in `<mark class="kelpi-webfind-match">` (zero-length matches skipped by bumping lastIndex). First match becomes current and is scrolled to center.
- `next()/prev()`: modulo-wrap current index; scroll into view; repost counts.
- `clear()`: unwrap every mark (moving children out, then `normalize()` the parent to merge text nodes), reset state, post `{0,-1}`.

Host-side integration (§10) drives it per-tab and re-applies the remembered needle after navigation.

---

## 8. Wire protocol — the `web-*` command family

All `web-*` commands are **request/response**: the server holds the client FD, the daemon writes exactly one newline-terminated JSON object (`{"ok":true,…}` or `{"ok":false,"error":"…"}`), then closes → EOF to the CLI. Exception: `web-console` with `follow:true` keeps the channel open and streams (§9.3).

### 8.1 Addressing / scope resolution

Every command except `web-open` carries the shared pane-target scope:

- `pane_id`: the caller's own pane UUID (from `KELPI_PANE_ID`), optional.
- `target` — name(label)-or-UUID of the pane to address, optional.
- `workspace` — name-or-UUID narrowing label resolution, optional.

Wire-level parse (`packages/protocol/src/wire/decode.ts:147-150`): empty strings normalize to absent; **at least one of `pane_id`/`target` must be present**. A message with neither is answered `{"ok":false,"error":"<command> requires pane_id or target"}` and the handle closed (`packages/daemon/src/control/server.ts:162-169`: every `web-*` verb is a reply command, `packages/protocol/src/allowlist.ts:35-60`, so a guard rejection is answered rather than dropped). The CLI pre-validates, so this only hits foreign clients.

Daemon-level resolution (`resolvePaneTarget`, `packages/core/src/resolve/pane-target.ts:90`, shared with `pane name` etc.): a UUID `target` resolves globally across all workspaces; a label `target` requires a scope, the `workspace` filter or the caller's own workspace via `pane_id`; ambiguous / unknown → error string. No `target` → the caller's own pane. Then `resolveWebPane` (`packages/daemon/src/webpane/resolve.ts:52`) layers web-specific checks, each a distinct `ok:false` error:

- `pane not found: <uuid>`
- `pane is not a web pane (type: shell)` (etc.)
- `web pane state missing for <uuid>` (invariant violation)
- plus resolution errors from `resolvePaneTarget` verbatim.

Commands that touch the active tab additionally fail with `web pane has no active tab` when the pane has zero tabs.

### 8.2 Command catalogue

Requests below omit the scope fields (`pane_id`/`target`/`workspace`) for brevity; replies omit `pane_id`/`workspace_id`, which are present in every success reply. `tab_id` (the active tab) rides every reply that addressed a tab: navigate, url, back, forward, reload, capture, inspect (arm), exec and all actuator verbs (`packages/daemon/src/webpane/handlers.ts:250-256, 262-268, 292-313, 344-350, 531-537, 715-722`). Handlers live in `handlers.ts`; the daemon answers state questions itself and forwards anything that needs a live page to the host as an awaited RPC (§8.7 for the host-less case).

| Command | Request extras | Reply extras / behavior |
|---|---|---|
| `web-open` | `url` (required non-empty), `private?`, `target?` + `direction?` (GUI anchor, §3.3) | §3.3. Reply sent before the pane exists. |
| `web-navigate` | `url` (required) | `{tab_id, url:<normalized>}`; navigates active tab. Reply is sent once the host acks the navigate (still before the load finishes, `handlers.ts:232-256`); the normalized URL is written to state first. |
| `web-url` | — | `{tab_id, url, title}`: live values read from the host; falls back to state's active-tab url/title when no host is attached or the host answers `ok:false` (`handlers.ts:259-288`). |
| `web-back` / `web-forward` | — | `{}` ack (optimistic; a no-op when history can't move still acks ok). |
| `web-reload` | `hard?` | `{}` ack. |
| `web-capture` | `mode` (default `meta`) | §8.4. Unknown mode → `unknown capture mode 'x' (allowed: meta, text, screenshot, dom, all)`. |
| `web-tabs` / `web-tab-new` / `web-tab-close` / `web-tab-select` | §5.1 | §5.1 |
| `web-console` | `since?`, `level?`, `clear?`, `follow?` | §9 |
| `web-inspect` | `send_to?`, `submit?`, `disarm?` | §11.2 |
| `web-inspect-result` | `clear?` | §11.5 |
| `web-private` | `private` (required) | §6 |
| `web-cookies-list` / `-clear` / `-delete` | §13.2 | §13.2 |
| `web-click` | `selector` (req), `double?`, `right?`, `at_x?`+`at_y?` | actuator → `click` |
| `web-type` | `selector`, `text` (req; may be ""), `submit?`, `replace?` (default true) | actuator → `type` (the `replace` flag is only shipped when false) |
| `web-q-text` | `selector`, `max_bytes?` | actuator → `text` |
| `web-q-attr` | `selector`, `attribute` (req) | actuator → `attr` |
| `web-q-count` | `selector` | actuator → `count` |
| `web-q-exists` | `selector` | actuator → `exists` |
| `web-q-dom` | `selector`, `max_bytes?` | actuator → `dom` |
| `web-wait` | `selector?` XOR `url_match?` (exactly one; both/neither → `{"ok":false,"error":"web-wait requires exactly one of selector / url_match"}`, `packages/protocol/src/wire/decode.ts:585-587`), `for?`, `timeout_ms?` (0/absent → JS default 10000) | actuator → `wait` (the daemon pads the host budget past the wait, `verbs.ts`) |
| `web-select` | `selector`, `value_or_label` (req) | actuator → `select` |
| `web-scroll` | `selector`, `block` (default `center`), `behavior` (default `instant`) | actuator → `scroll` |
| `web-hover` | `selector` | actuator → `hover` |
| `web-key` | `key` (req), `selector?` | actuator → `key` |
| `web-exec` | `script` (req non-empty) | §8.5 |

Wire JSON keys use snake_case exactly as listed (`send_to`, `make_active`, `max_bytes`, `at_x`/`at_y`, `value_or_label`, `url_match`, `for`, `timeout_ms`, `private`).

**Actuator dispatch** (shared by click/type/q-*/wait/select/scroll/hover/key; daemon side `handlers.ts:158-178`, host side `packages/shell/src/webhost/dispatch.ts:541-551`): resolve pane → require active tab → one host RPC `actuate` carrying the method name and argument list → the host builds the JS call `__kelpiAct.<method>(<json-literal args>)` wrapped in `try { if (!window.__kelpiAct) return JSON.stringify({ok:false,error:'actuator not installed'}); var r = await __kelpiAct.m(...); return JSON.stringify(r === undefined ? null : r); } catch (e) { return JSON.stringify({ok:false, error: e.message}) }` (`scripts.ts:1770-1780`) and evaluates it as an **async function whose returned Promise is awaited**: CDP `Runtime.evaluate` with `awaitPromise:true, returnByValue:true` (plain evaluation would serialize the pending Promise as `{}`). Argument literals are built by JSON-encoding each argument (JSON literals are valid JS). A view that is not on screen is laid out at the automation viewport first (§8.4). Outcomes:

- tab's view is gone → `web pane has no live tab <uuid>`
- evaluation returned a non-string / non-JSON-object / threw → `actuator evaluation failed: <detail>` (details: `actuator returned non-string reply`, `reply not JSON object`, or the engine's own exception text; `dispatch.ts:324-343`), `exec` uses the label `exec` instead of `actuator`.
- success → parse the JSON envelope, merge in `pane_id`, `workspace_id`, `tab_id`, send. Note `ok:false` envelopes (e.g. "no match for selector") flow through this same path — the CLI turns `ok:false` into exit 1.

### 8.3 `kelpi open` routing (CLI-side, reuses `web-open`)

`webTargetForOpenArg(arg)` (`packages/cli/src/routing.ts:135`) decides URL-vs-file (mirror of `localFileURL`, `routing.ts:103`):

1. If `localFileURL` recognizes it as a local file (explicit `/`, `./`, `../`, `~` prefix, or a bare name matching an existing regular file **with an extension** in cwd) → not a web target.
2. Contains `://` → web target as-is.
3. Strip path/query/fragment → authority; peel an all-digit `:port`. `localhost` → web. IPv4 dotted-quad → web. Any host:port → web. Bare dotted hostname → web **only when the final label is in `webOpenCommonTLDs`** (`routing.ts:50`, a curated list: com/org/net/io/dev/… + common ccTLDs, deliberately excluding extension-colliding TLDs like sh/ai/app/pl/rs/zip/md so `kelpi open run.sh` stays a file).
4. Else → file router: markdown extensions (`md markdown mdown mkd mkdn mdwn markdn`) → markdown pane; web extensions (`html htm pdf svg png jpg jpeg gif webp`) → web pane via `file://` URL; anything else → usage error. `--here` applies only to the markdown route (URLs/web files print a stderr note and open a new pane).

`localFileURL` is also applied to the URL argument of `kelpi web open` / `navigate` / `tab-new`, so `kelpi web open foo.html` opens the local file (percent-encoded `file://` URL resolved against cwd, `~` expanded); bare hostnames, single-label hosts colliding with cwd *directories*, and extensionless names always pass through as hosts; `./name` forces local.

### 8.4 Capture matrix (`web-capture`)

Host side `packages/shell/src/webhost/dispatch.ts:422-471`; daemon side `handlers.ts:316-351`. Common fields in every reply: `ok, pane_id, workspace_id, tab_id, url, title, mode`, url/title snapshot from the live view (fallback to state's tab url/title).

| mode | extra fields |
|---|---|
| `meta` | none (cheap default) |
| `text` | `text` (visible page text = `document.body.innerText`, "" pre-load), `byte_count` (UTF-8 bytes). Clamp 1MB on a UTF-8 boundary + trailing `"\n[truncated]"`. |
| `dom` | `html` (`document.documentElement.outerHTML`, "" pre-load), `byte_count`. Clamp 5MB + `"\n<!-- truncated -->"`. |
| `screenshot` | Visible-viewport PNG (after pending screen updates). ≤ 1,000,000 bytes → `png_base64` + `byte_count`; larger → written to the OS per-app temp dir as `kelpi-web-capture-<paneID>-<unixts>.png`, reply carries `path` + `byte_count`. Capture failure → **`ok:false`** with `error:"screenshot capture failed"` (or `failed to write screenshot to <path>`). |
| `all` | Composite: `text` + `text_byte_count`, `html` + `html_byte_count`, plus the screenshot fields with `screenshot_byte_count`; a screenshot failure here degrades to a `screenshot_error` field while `ok` stays true. |

**Automation viewport.** Every read except `meta` is measured against one fixed viewport when the view is not on screen: before a non-meta `capture`, every actuator method (§7.4) and `exec` (§8.5), the host calls `pinViewport()` (`dispatch.ts:436-438, 546-548, 558-560`). A view that is not embedded in the shell window is laid out at `DEFAULT_VIEWPORT` 1280×800 with `deviceScaleFactor: 1` via `Emulation.setDeviceMetricsOverride` (`tab.ts:91-92, 463-481`; scale 1 rather than the display's, so a retina Mac does not double every screenshot's bytes). The pin is lazy (`viewport-pin.ts:23-38`): a fresh tab is born pinned; placing the view in the shell window clears the pin; parking it (a menu, a popover, a tab switch) changes nothing until the next automation read, so a page that nobody reads while parked comes back exactly as it left. A read on a view that is on screen pins nothing: the pane's own rect and the display's scale are its viewport. So screenshots, element rects, `wait visible` and `innerText` can differ between an on-screen pane and a parked/background one.

CLI printing: `kelpi web capture --mode meta|text|screenshot` only. The shipped CLI rejects `dom` and `all` with `unknown --mode` and exit 1 (`packages/cli/src/commands/web.ts:267-277`, a compatibility pin on the 0.32.0 flag set; both modes stay valid on the wire for other clients, `handlers.ts:41`), and `capture` has no `--json` (`web.ts:13-17`). `text` → raw text to stdout; `screenshot` → prints the temp-file path, or the base64 blob (pipe to `base64 -D`); `meta` → `url:`, `title:`, `bytes:` lines. (The printer keeps `dom` → raw HTML and `all` → the whole reply as one JSON line for replies only a foreign client could provoke, `web.ts:287-304`.)

### 8.5 `web exec`

`kelpi web exec [--file <path> | <js>] [--timeout S]` → `web-exec {script}`. The host wraps the author script (`wrapExecScript`, `packages/shell/src/webhost/scripts.ts:1790-1812`), after laying a parked view out at the automation viewport (§8.4):

- Statement-vs-expression detection: regex `(?m)(?:^\s*|;\s*)(return|throw|if|for|while|switch|try|do|let|const|var)\b` — a keyword at line start or right after `;`. Match → treat as statement body verbatim; else strip one trailing `;` and wrap as `return (<expr>);`.
- Wrapper: bail with `{ok:false,error:'actuator not installed'}` if `__kelpiAct` missing; else run `await (async ($, $$, kelpi) => { <body> })(find, findAll, __kelpiAct)` inside try/catch → success `{ok:true, result: <value ?? null>}`, throw → `{ok:false, error, js_error:{name,message,line,column}}` — all JSON.stringify'd, evaluated with awaited Promise like the actuator.
- So `$`/`$$`/`kelpi` alias `__kelpiAct.find`/`findAll`/the whole namespace; a single trailing expression auto-returns; multi-statement scripts need explicit `return`.
- CLI result printing (non-`--json`): result null/absent → nothing; string → raw; bool → true/false; number → integer-clean string; object/array → compact sorted JSON.
- Timeouts: CLI default 30s (exec scripts routinely `await kelpi.wait(...)` for 10s); socket read timeout = max(ceil(timeout)+5, global default 5s / `KELPI_REPLY_TIMEOUT`). `web wait` similarly pads its read timeout past the wait budget.

### 8.6 CLI conventions (whole `kelpi web` family)

- `attachWebTargetScope` (`packages/cli/src/commands/web.ts:56`; every verb except `open`): attaches `target`/`workspace`/`pane_id` (from `KELPI_PANE_ID`) to the payload, then pre-validates: label `--target` with no `--workspace` and no `KELPI_PANE_ID` → error `--target by label requires --workspace <name-or-id> when called outside a Kelpi pane`; no `--target` and no `KELPI_PANE_ID` → `no --target supplied and KELPI_PANE_ID is not set`. Both exit 1 without touching the socket.
- `kelpi web open` rejects `--target`/`--workspace` outright with a hint to use `navigate`/`tab-new`, and rejects URLs starting with `-`.
- Shared reply decode: transport failure / empty reply / invalid JSON → stderr + exit 1; `--json` pretty-prints the full reply (sorted keys); `ok:false` → `kelpi web <verb>: <error>` on stderr (suppressed under `--json`, which already printed it) + exit 1.
- Success prints (non-JSON): `open/navigate/back/forward/reload/tab-*` → `"<verb> ok: <pane_id>[ (<url>)]"`; `url` → `"<url>\t<title>"` (or just url); actuator verbs → `clicked[: "text"]`, `typed: <value>`, `matched <cond> in <ms> ms`, `selected: <label|value>`, `scrolled`, `hovered`, `key: <Key>`; read verbs print the bare value (`text`, `attr` value, `count`, `dom` html).
- Exit-code semantics beyond ok/error: `exists` exits 0/1 on `found` (even under `--json`); `attr` exits 1 when the attribute is absent (`present:false`), else prints the (possibly empty) value; `wait` timeout is `ok:false` → exit 1; `cookies delete` with 0 matches prints `no cookie matched name 'x'` and exits 1.
- `click`/`type`/`select` support a `--` positional-tail terminator so payloads that look like flags (`--submit` as literal text) survive.
- `console --level` validated client-side against log|debug|info|warn|error; `--since` must be an unsigned int.
- `web tabs` table: `IDX  A  TITLE(24, clipped)  URL`; `--json` prints just the tabs array.

### 8.7 Host-less daemon (no Electron shell connected)

The daemon runs headless; the browser views live in the Electron shell, which registers itself as the web-pane host over WS. Until a host is registered (`service.hasHost`, `packages/daemon/src/webpane/service.ts:150`), the `web-*` family splits (`packages/daemon/src/webpane/handlers.ts`):

- **Fail `{ok:false, error:"no web pane host connected"}`** (`host.ts:26`): `web-navigate`, `web-back`, `web-forward`, `web-reload`, `web-capture` (after the mode check), every actuator verb, `web-exec`, and `web-inspect` when arming (`handlers.ts:143-146, 234-237, 328-331, 507-510`).
- **Answer from daemon state**: `web-open`, `web-tabs`, `web-tab-new`/`-close`/`-select`, `web-private`, `web-console` (poll and `--follow`), `web-inspect --disarm`, `web-inspect-result`. `web-url` falls back to the active tab's state url/title (`handlers.ts:270-274`); `web-cookies-list` answers an empty list and `web-cookies-clear`/`-delete` answer `deleted: 0` (`handlers.ts:606-609`).
- State mutations made while no host is attached (opens, navigates written optimistically, tab changes) are replayed to the next host that registers (§1), which rebuilds every view from them.

Two more daemon-authored failures exist once a host is attached: `web pane host disconnected` (the host went away mid-call, `host.ts:28`) and `web pane host did not answer '<verb>' within <n>ms` (`host.ts:92`). Per-verb budgets (`verbs.ts:40-57`): 5 s default, 20 s for `capture`, 30 s for `exec` (matching the CLI's own 30 s default), the caller's `wait` budget plus 5 s slack, and 2 s for the GUI poster.

---

## 9. Console: buffer, drain, follow-stream

### 9.1 Ingest

Every console line the host reports (§7.1) → `ConsoleLine` → append to the pane's ring buffer (capacity 1000) → notify subscribers (`packages/daemon/src/webpane/console.ts:125-138`). Ordering: the append is committed first; the fan-out (§9.3) runs afterwards and reads the appended entry (this ordering is load-bearing, the fan-out must observe the appended line).

### 9.2 Poll drain — `web-console` (follow=false)

```json
// request
{"command":"web-console","pane_id":"…","since":42,"level":"error","clear":false,"follow":false}
// reply
{"ok":true,"pane_id":"…","workspace_id":"…",
 "lines":[{"seq":42,"tab_id":"…","level":"error","message":"…","url":"https://…",
           "captured_at":"2026-08-18T05:12:03.123Z","line":10,"column":5}, …],
 "next_since":57,"dropped":3,"follow":false}
```

- `lines` = buffer entries with `seq >= since` (since=0 → whole buffer), then filtered by `level` when given. `line`/`column` only present when captured.
- `next_since` = the buffer's `nextSeq` (pass it back as `--since` to get only new lines).
- `dropped` = `droppedSinceLastDrain` at read time; after the reply, the handler always dispatches an acknowledge (reset to 0), so the next call reports only new drops.
- `clear:true` additionally empties the buffer after the read (seq namespace preserved).
- Timestamps ISO8601 with fractional seconds.

CLI (non-JSON): drops notice to stderr `(dropped N lines before this batch — buffer was full)`, then `[seq] level: message` per line, then `(next_since=N)` to stderr.

### 9.3 Follow-stream — `web-console --follow`

- The reply above (with `"follow":true`) is sent **without closing** the handle — it is line 1 of the stream (the catch-up drain, honoring `since`/`level`/`clear`).
- The handle is registered in the pane's follower set (`console.ts` `subscribe`; daemon handler `packages/daemon/src/webpane/handlers.ts:451-483`).
- On every subsequent appended line, fan-out pushes **one JSON object per line** to every live subscriber of that pane — the same shape as an entry of `lines` (seq, tab_id, level, message, url, captured_at, line?, column?). If drops accumulated since the last acknowledgement, the *next* pushed line carries an extra `"dropped": N` key (drops ride on a real line so ordering between the notice and the live lines is unambiguous), and the counter is acknowledged.
- **Quirk, preserved deliberately (see Compatibility rationale):** streamed lines are NOT filtered by the `level` given at subscribe time, only the catch-up drain is.
- **WS twin**: GUI clients subscribe with `web-console-subscribe {pane_id, since?, level?, clear?}` (`packages/daemon/src/ws/sync.ts:2549-2585`). The reply is the same catch-up drain object (with `follow: true`), every later line arrives as its own `web-console-line {paneID, line}` message from the same per-pane follower set, and `web-console-unsubscribe` (or re-subscribing, which replaces the old handle so one pane never has two streams) ends it. Because the fan-out acknowledges drops once for all followers, a drop notice is delivered to whichever consumer's line goes out first, CLI `--follow` or a WS client.
- Teardown: (a) client disconnects (EOF / Ctrl-C closes its socket) → the control server fires the reply handle's disconnect callbacks, which unsubscribe that follower (`handlers.ts:482`). (b) The pane closes → the pane's console buffer is disposed, every follower is ended (its handle closed) and the entry dropped (a closed pane can never catch the client up; `console.ts:177`, `service.ts:358-364`). Subscribers are never persisted.
- CLI `--follow`: installs a SIGINT handler that closes the socket FD (so the server sees EOF) and exits 130; sends the request, disables the read timeout, and loops on newline-delimited JSON until EOF. First line: `ok:false` → error+exit; else print the drain (as in §9.2) + `(following — press Ctrl-C to stop)` on stderr; subsequent lines print `[seq] level: message` (with a stderr `(dropped N lines)` notice when the line carries `dropped`). `--json` prints each raw JSON line instead.

---

## 10. Find-in-page (GUI)

The pane search overlay is shared across pane types; for web panes it drives `__kelpiWebFind` on the **active tab** through the WS-only verb `web-find {pane_id, tab_id, action: search|next|prev|clear, needle}` (`packages/daemon/src/ws/web-ui.ts:223-234`, `packages/daemon/src/webpane/find.ts`, client `WebFindBar.tsx`). Find state is per-tab in the page (marks live in the DOM), but the bar is per-pane, so tab changes must migrate it. The remembered needle is daemon state rather than client chrome: two windows looking at the same pane are looking at the same marks.

- Open: `toggle_search` (shortcut) works when the focused pane is shell, web, or non-editing markdown; sets `searchingPaneID`, clears needle/counts. ⌘F inside the page is forwarded to the client by the shell (§16.6).
- Typing (`searchNeedleChanged`): run `search(needle)` on the active tab directly (no debounce, it's local JS). The daemon remembers the needle per pane (`find.ts`) so navigation/reload can re-apply; an empty needle clears highlights but keeps the bar open.
- Next/Prev: `next()`/`prev()` on the active tab (wrap-around).
- Close: clear search state; `runFindClose(activeTab)` — clears marks AND forgets the remembered needle (navigations stop re-applying).
- Result counts: every find pass returns `{total, current}`, and the `web-find` reply echoes the `tab_id` it was measured on; the UI **drops results from a tab that is not the pane's resolved active tab** (an outgoing tab's `clear()` during a switch would otherwise clobber the incoming tab's count), then feeds total (and current when ≥ 0) into the overlay ("current+1/total"-style display; total 0 clears the selection).
- Tab switch / cycle while find is open: `retargetWebFind` — close find on the outgoing tab, re-run the needle on the incoming one. Closing the *active* tab: destroy clears the closed tab's find implicitly; the needle is re-run on the tab that takes over. Closing the searched pane dismisses search state.
- After every successful page load (`didFinish`, not the error stub): if the find bar is open with a non-empty needle for that tab, re-run the search (the load wiped the marks and rebuilt a fresh `__kelpiWebFind`).

Kelpi drives the injected implementation (§7.5) rather than Electron's native `webContents.findInPage`: it is what guarantees identical counts and highlight styling across tabs, follows the find palette settings, and keeps the `{total, current}` semantics and re-apply-on-navigation.

---

## 11. Element picker / inspect pipeline

Two modes share the in-page picker: **single-shot** (CLI-armed, one click) and **batch** (GUI "element pickup" panel, sticky arm, N clicks + comments).

### 11.1 Arm state

- Daemon: one `InspectArm {paneID, tabID, nonce, sendTo, submit}` per pane (`packages/daemon/src/webpane/inspect.ts:67-75, 278-327`): `nonce` is fresh 128-bit hex per arm, minted by the daemon; `sendTo` is the resolved destination pane UUID (null = queue locally); `submit` is set when armed with `--submit`. Arming replaces any previous arm for the pane; disarm clears it and notifies the host.
- Host/page: the arm is installed with `__kelpiInspectorEnable(nonce, sticky)` on the addressed tab (`packages/shell/src/webhost/dispatch.ts:564-576`), and the page-side disable runs on `inspect-disarm`. Re-arming while armed disarms the page picker first (§7.2).

### 11.2 `web-inspect` (CLI arm)

Handler: `packages/daemon/src/webpane/handlers.ts:486-537`.

- `disarm:true` path: reply `{ok:true, pane_id, workspace_id, armed:false}`; clear the daemon arm; notify the host `inspect-disarm` (fire-and-forget, so it works with no host attached). (No active-tab requirement.)
- Arm path: require active tab. If `send_to` given, resolve it via the standard pane-target rules **up front** and require the destination to be a `.shell` pane (only shell panes have a PTY to paste into), failures reply `--send-to: <resolution error>` / `--send-to: pane not found: …` / `--send-to: destination must be a shell pane (got: markdown)`. No host → `no web pane host connected` (§8.7).
- Mint the nonce and arm the page picker through the host (`inspect-arm {tabID, nonce, sticky:false}`); failure → the host's own error, or `failed to arm inspector for active tab` when it named none (the page answers false when the picker script never installed, e.g. an `about:` URL with no document). Record the arm (+ `submit` when `--submit`). Reply:

```json
{"ok":true,"pane_id":"…","tab_id":"…","armed":true,"send_to":"<uuid-or-empty-string>","submit":false}
```

CLI prints `inspect armed: <pane> — click an element in the web pane to capture`, or `… → will paste to <uuid> (+submit)`; disarm prints `inspect disarmed: <pane>`.

Re-arming before a click is clean (the new arm replaces nonce + page listeners).

### 11.3 Payload delivery

Page click → host binding (main frame only) → daemon validates armed tab + nonce (`packages/daemon/src/webpane/service.ts:461-468`) → the raw payload is sanitised (`sanitizeInspectPayload`, `inspect.ts:191`, §11.6) into an `InspectResult` → routed by `service.ts`:

- **Batch visible** (`batchInspect.panelVisible == true`): wrap in a new `BatchInspectItem` (fresh UUID, empty comment), append to the batch, re-sync page markers, and focus the new item with origin `page` (ring + badge pulse, no scroll — the element is already under the cursor; the panel scrolls its row into view and focuses its comment field). Picker stays armed (sticky). No paste happens until Send.
- **Otherwise (single-shot; includes a hidden/paused batch)**: read `sendTo` and `submit` from the arm (then disarm, which clears both); enqueue the result on the pane's `inspectResultQueue` (cap 32, oldest dropped); and if `sendTo` is set, paste `formatForPaste(result)` into that pane's PTY, bare write when `submit` is false (default: paste only), command-write (text + Enter) when true (`packages/daemon/src/boot/compose.ts:615-618`).

A hidden batch is deliberately "paused": `kelpi web inspect --send-to` can arm a single-shot pick on top of it without hijacking the batch.

### 11.4 Paste formats

Single result (`formatForPaste`, `packages/daemon/src/webpane/inspect.ts:268`):

```
# kelpi inspect 2026-08-18T05:12:03.123Z
```json
{ …pretty-printed, sorted keys: selector, xpath, tag, id, url, text,
  rect{x,y,w,h}, attributes, captured_at [, outer_html] [, context_html] }
```
```

(The fenced block is literal — a one-line directive followed by a ```json fence; easy for an LLM to detect, readable on a terminal.) `outer_html`/`context_html` included only when non-empty.

Batch (`formatBatchForPaste`, `packages/daemon/src/webpane/batch.ts:228`): header `# kelpi inspect batch <ISO now> (N items)` then one fenced JSON **array**; each entry = the same fields plus `"comment"` (clamped to 4KB via the sanitiser).

### 11.5 `web-inspect-result` (drain)

Reply merges **both** pending sources, in order: the single-shot `inspectResultQueue`, then the current batch's items (each annotated with its comment):

```json
{"ok":true,"pane_id":"…","workspace_id":"…","results":[
  {"tab_id":"…","selector":"#login","xpath":"…","tag":"button","id":"login",
   "url":"https://…","text":"Sign in","attributes":{…},
   "rect":{"x":10,"y":20,"w":80,"h":30},
   "captured_at":"…"[,"outer_html":"…"][,"context_html":"…"][,"comment":"…"]}, …]}
```

(`outer_html`/`context_html`/`comment` only when non-empty.) `clear:true` empties the queue and — only if a batch exists — cancels the batch (which also disarms the picker; a single-shot arm without a batch survives a `--clear`). CLI: `--json` prints the results array; plain prints `tag  selector  (url)` per row or `(no pending inspect results)`.

### 11.6 Payload sanitisation (`InspectPayloadSanitiser`)

`packages/daemon/src/webpane/inspect.ts:85-265`. Applied to every picker payload before it enters state (it will cross a PTY boundary; web content can contain ANSI escapes / C0 bytes that would reposition the cursor or fire OSC 52 clipboard writes on the receiving terminal):

- `stripUnsafeControlCharacters`: drop ESC-led ANSI sequences — CSI (`ESC [` … through final byte 0x40–0x7E), OSC (`ESC ]` … through BEL or ESC-\\), any other two-char `ESC x` — plus every C0 control char except `\n` and `\t`, plus DEL (0x7F).
- `clampField(raw, limit)`: strip, then UTF-8 byte-clamp on a code-point boundary leaving room for, and appending, the marker `"... [truncated]"`.
- Budgets: selector/xpath 1024, tag 64, element_id 256, outer_html 16384, context_html 4096, text 1024, url 4096, attribute keys 128, attribute values 1024, batch comment 4096.
- Attributes: non-string values stringified. rect parsed from `{x,y,w,h}` doubles (default 0).
- Reject (return null → payload silently dropped) when selector AND tag AND url are all empty after clamping (spoof/garbage guard beyond the nonce).

---

## 12. Batch inspect ("element pickup")

### 12.1 Session lifecycle (app-level actions)

Sessions live in the daemon (`packages/daemon/src/webpane/batch.ts`, driven by `service.ts`); the panel talks to them over the WS-only verbs `web-batch-state|toggle|cancel|remove|comment|focus|send` (`packages/daemon/src/ws/web-ui.ts:260-338`), every reply carrying `{ok, pane_id, batch}` with the post-mutation session, and every change is fanned out to all windows as a `web-batch {paneID, batch}` broadcast.

- **Start**: requires an active tab. Sets `batchInspect = {items:[], focusedItemID:null, panelVisible:true}`, syncs (empty) markers, arms the picker **sticky** on the active tab, records the arm (`sendTo: null`, fresh nonce). If the arm fails (no host, no tab) the session is torn down again rather than leaving a panel open over a picker that will never fire.
- **Toggle** (`web-batch-toggle`, the chrome scope button): no batch → start; batch with visible panel → hide; hidden → show. Reply adds `armed` and `toggled: started|shown|hidden`.
- **Hide**: `panelVisible=false`, clear on-page markers (sync computes an empty marker list when hidden), disarm the picker (state + page). Items **survive** in state.
- **Show**: `panelVisible=true`, re-sync markers (numbered from the surviving items), re-arm sticky.
- **Cancel** (`web-batch-cancel`: panel Cancel button, `inspect-result --clear` with a batch, or **Esc in the page** while the picker is armed and no comment popover is open: the picker posts `{nonce, cancelled:true}` and the daemon drops the whole session, items included, `service.ts:469-478`): clear the submit flag, `batchInspect=nil`, clear markers, disarm.
- **Send** (`web-batch-send {send_to?}`): read `submit` from the session (then clear). If the batch is non-empty and a pane was chosen, remember that pane as the pane's in-session `lastTarget` (`batch.ts:178-187`; a pane UUID only, never a `local` marker, since the local-queue branch never records one; in-memory only, so a fresh daemon always starts unselected). Then teardown (clear batch, markers, disarm) and:
  - `sendTo != null` → paste `formatBatchForPaste(items)` into that pane (bare unless submit).
  - `sendTo == null` (local queue) → for each item, stamp `result.comment = item.comment` and enqueue on `inspectResultQueue` for `kelpi web inspect-result` to drain. (The current panel UI never offers this path — Send is disabled until a pane is chosen — but the action supports it.)
  - Empty batch → teardown only.

Every mutation of the item set re-runs `syncBatchMarkers(paneID)`: markers = hidden-panel → `[]`, else items enumerated with `label = String(index+1)` (1-based), pushed to the page (or `clearBatchMarkers` when empty).

### 12.2 Focus sync (list ↔ page)

`web-batch-focus {item_id, origin: panel|page}` (`service.ts` `focusBatchItem`):
- Set `batchInspect.focusedItemID` (drives the panel row highlight).
- Push the page highlight: ring + badge pulse always; `scrollIntoView` only when `origin == panel` (a page-originated click is already under the cursor).

Sources: panel row tap → origin panel; a comment field gaining keyboard focus (tab-key or click) → origin panel; a new pick → origin page; a page badge click → origin page (via the badge-click message).

Done/Esc in the page popover (`{dismiss:{id}}` marker message): clear `focusedItemID`, unfocus on the page (hide ring + popover; markers stay).

### 12.3 Comment editing, both sides

- Panel field edit → `web-batch-comment {item_id, comment, tab_id}` (state) + a `batch-comment` push to the page (`web-ui.ts:297-316`), the page updates its record and the popover textarea only when its textarea isn't focused.
- Page popover edit (per keystroke) → `commentChanged` marker message → state update only (no push back, bouncing the value into the page would clobber the textarea cursor).
- Page popover Remove → `{remove:{id}}` marker message → item removed + marker re-sync. Panel row ✕ → `web-batch-remove {item_id}`, same.

### 12.4 Panel UI (recreate in web client)

A strip under the chrome while `panelVisible` (`packages/client/src/webpane/BatchPanel.tsx`):
- Header: scope icon + "Element pickup" + right-aligned "N item(s)".
- Empty state: "Click elements in the page to add them. Esc cancels."
- Rows (up to 3 visible, then inner scroll; ~64px each): numbered chip matching the page badge, `TAG` (uppercase, accent) + selector (mono, middle-truncated) — clicking this line focuses the item — and a "Comment (optional)" text field. Focused row gets an accent fill/border; new picks auto-scroll into view and auto-focus their comment field. ✕ removes the row.
- Footer: **Cancel** · destination picker · **Send N**. The picker lists every *other shell pane in the same workspace*, labelled by pane label or `shell: <cwd tail>` (with `~` substitution); the source web pane and all non-shell panes are excluded. Initial selection seeds from `lastBatchTarget` when that pane still exists, else "Select destination…" (accent-bordered when unselected). Send is disabled while the batch is empty or no destination is chosen. If the chosen pane disappears mid-batch, selection reverts to unselected (never silently reroute).
- While the picker is armed the page cursor is crosshair; the panel forces the normal arrow cursor over itself.
- The chrome scope button reflects state (`packages/client/src/webpane/WebPane.tsx:1144-1168`): accent + tinted while the panel is visible; a small count badge shows whenever items exist, panel visible or hidden. Tooltip cycles: "Start element pickup" (no batch) / "Hide element pickup" (visible) / "Show element pickup" (hidden, empty) / "Show element pickup (N items waiting)" (hidden with items).

---

## 13. Storage panel & cookies

### 13.1 GUI storage panel

Toggled by the chrome lock button (filled + accent when private; accent fill while the panel is open). A disclosure strip under the URL bar (`packages/client/src/webpane/StoragePanel.tsx`, all reads and writes over the wire verbs of §13.2 plus the WS-only `web-cookie-set`):

- **Private mode row**: switch + explanatory caption ("Cookies + caches discarded on quit; tabs blank on restart." / "Cookies + caches persist across restarts."). Flipping always goes through the confirmation dialog (§6).
- **Cookies section**: count, refresh button, add (`+`) button, and a trash button behind a confirmation ("Clear all site data for this pane? Removes cookies, local storage, IndexedDB, and caches. Logged-in sessions on this data store will be signed out.") which removes *all* site data types since the epoch.
- Cookie list grouped by **canonical domain** (leading `.` stripped), groups sorted alphabetically, cookies name-sorted within; accordions default collapsed. Per-group: add-cookie for that domain, delete-all-for-domain. Per-cookie row: name + value preview (60-char clip), delete, and an inline edit form.
- Edit/create form fields: Name, Value, Domain (editable only in the top-level create form), Path (default "/"), Secure checkbox, "Session only" checkbox (off reveals an expiry date picker, prefilled +30 days). HttpOnly is preserved through edits but not editable. Save requires non-empty trimmed name + domain. Editing **deletes the original cookie then sets the new one** (so renames don't leave the old cookie behind); creation just sets. The write goes over `web-cookie-set {cookie: {name, value, domain, path, is_secure, is_http_only, expires?}, original?: {name, domain, path?}}` (`packages/client/src/webpane/commands.ts:245-266`, `packages/daemon/src/ws/web-ui.ts:340-354`): `is_secure`/`is_http_only` are explicit booleans, and `original` is what the host deletes before setting. Invalid combinations (domain fails validation) fail silently to a log.
- Empty states: "No cookies for this data store yet." / private: "No cookies (private mode — fresh on every launch)."

### 13.2 Cookie wire commands

All operate on the pane's cookie store via the host (`packages/shell/src/webhost/sessions.ts`); **if no host is attached, reads return empty and deletes return 0**, no error (`packages/daemon/src/webpane/handlers.ts:606-609`, §8.7).

- `web-cookies-list` →

```json
{"ok":true,"pane_id":"…","workspace_id":"…","private":false,
 "cookies":[{"name":"sid","value":"…","domain":".example.com","path":"/",
             "is_secure":true,"is_http_only":true,
             "expires":1766000000.0,          // unix seconds; absent = session
             "session_only":true              // only when session-only
            }, …]}
```

CLI table `DOMAIN(24) NAME(20) VALUE(40)` sorted by domain then name, or `(no cookies)`; `--json` prints the cookies array.

- `web-cookies-clear` `{domain?, all?}`: `--all` + `--domain` rejected client- and server-side (`--all and --domain are mutually exclusive`). `all:true` → remove every site-data type (cookies, caches, local storage, IndexedDB) since epoch (`session.clearStorageData()`, `sessions.ts:104-105`); reply `{ok, …, "cleared_site_data": true}` (count unknowable). Else delete cookies matching the canonical domain (or every cookie when no domain); reply `{ok, …, "deleted": N[, "domain": "<as passed>"]}`. CLI prints `cleared all site data` / `deleted N cookies[ for d]`.
- `web-cookies-delete` `{name, domain?}` — delete cookies with exactly that name (optionally domain-scoped, canonical compare); reply `{ok, …, "deleted": N, "name": "…"[, "domain": "…"]}`. CLI exits 1 when N==0.

Domain matching everywhere uses `canonicalDomain` = strip one leading `.`.

---

## 14. Favourites

- Storage: **`favourites.json`** beside the daemon database (`packages/daemon/src/webpane/favourites.ts:9-22`, `packages/daemon/src/boot/compose.ts:327-329`; in memory when the database is `:memory:`), a JSON array of `{id, url, title, createdAt(ISO8601)}`, the same row shape as the legacy `web.favourites` payload so an old value can be dropped in verbatim. Loaded at daemon start; every mutation rewrites the whole file synchronously and immediately (no debounce). Clients read and mutate it over WS (`packages/daemon/src/ws/web-ui.ts:28-37, 71-129`): `web-favourites-list`, `web-favourite-toggle {url, title}`, `web-favourite-remove {id}`, `web-favourite-rename {id, title}`, `web-favourite-move {from, to}`; these are the only web verbs with no pane. Every reply carries the post-mutation list (each entry with an extra `label` and `created_at`), and a `web-favourites` broadcast keeps every window's star and menu in step.
- Matching (`favourites.ts:40`): normalize both sides, trim, lowercase **scheme and host only** (paths/queries stay case-sensitive), strip all trailing `/`, and compare exactly. Used for the star state.
- Actions: `toggleFavourite(url, title)` — trimmed-empty URL is a no-op; existing match → remove; else append `{uuid, url, title, now}`. `renameFavourite(id, title)`, `removeFavourite(id)`, `moveFavourite(from, to)` (reorder).
- Chrome: a star embedded at the trailing edge of the URL bar — filled yellow when the displayed URL matches a favourite; disabled (30% opacity, unclickable) when the URL is empty. Toggling saves the *currently displayed* URL + title pair (title tracked from the same state-change event as the URL, so a stale title is never saved under a new URL). A book icon opens the favourites menu: each favourite as a menu item (label = title || host || url, mid-truncated at 50 chars — head 25 + "…" + tail 24 — so both host and page name survive), clicking navigates the **current pane's active tab** (does not open a new pane); empty state "No favourites yet / Click the star to save the current page"; "Manage favourites…" opens Settings → Web tab (deep-link survives cold-open of the settings window).
- Settings → Web (`packages/client/src/settings/WebTab.tsx`): list with drag-reorder plus ↑/↓ buttons beside each row (a drag with no keyboard equivalent is unreachable for some users), inline title rename (commit on submit/blur, trimmed, no-op when unchanged), per-row remove.

---

## 15. Persistence & pane close/reopen

### 15.1 Database

Pane records carry four nullable columns (SQLite migrations v12–v14, `packages/daemon/src/db/schema.ts:159`; row codec `packages/core/src/codec/json-columns.ts`; `packages/daemon/src/db/persistence.ts:183`): `webURL` (legacy single-tab fallback), `webTabsJSON` (JSON `[WebTab]`), `webActiveTabID`, `webIsPrivate`.

Save (per web pane): `webIsPrivate` always written; when **not** private also write `webURL = activeTab.url`, `webTabsJSON` (when tabs non-empty), `webActiveTabID`. Private panes write nil tabs/URL — restart restores the pane shell (still web, still private) with **zero tabs** (blank pane, "Type a URL above…" empty state).

Load: prefer `webTabsJSON`; fall back to a single tab from `webURL`; `activeTabID` = stored id if it's in the tab list, else first tab. Restored tabs keep their UUIDs and titles; the host builds their views as soon as it learns of the pane (§1) and they immediately load their URLs.

Console buffers, inspector arms, batches, follow-subscribers, `lastBatchTarget` are never persisted.

### 15.2 Close

`closePane` for a web pane:
- Snapshot for reopen (ring of last 10 closed panes): pane fields + `webState` **unless private** (private → nil, reopen restores a blank tab-less pane… actually a nil webState snapshot).
- Remove `webPanes[paneID]`, remove the pane, repair layout/focus.
- The daemon notifies the host `pane-close` and the host destroys every tab view (`packages/daemon/src/webpane/service.ts:358-365`, `packages/shell/src/webhost/registry.ts:171-175`); PTY-less so nothing else leaks.
- `WebPaneService` disposes the pane's console buffer (ending every follower, whose handles are closed), inspect arm + queue, find needle and batch session (`service.ts:358-364`).

### 15.3 Reopen (`reopenClosedPane`)

`reopen-closed-pane` (`packages/daemon/src/ws/panes.ts`). New pane id; split right of the focused pane; if the snapshot was a web pane with a saved `webState`, install it verbatim (same tab ids/URLs/titles/isPrivate). No surface/agent-resume logic applies to web panes.

---

## 16. Chrome UI (recreate in web client)

Layout top-to-bottom: nav/URL row → (tab strip when >1 tab) → optional storage panel → optional batch panel → content (or empty state). A 1px divider at the bottom of the chrome with the progress strip overlaid.

### 16.1 Nav/URL row

`← → ⟳ [URL bar ★] 📖 + 🎯 🔒 </>`, all 22×22 icon buttons (`packages/client/src/webpane/WebPane.tsx:1030-1190`):
- Back/Forward disabled (30% opacity) when history can't move, driven by the host's `web-nav-state` report (§16.3); tooltips "Back (⌘←)" / "Forward (⌘→)".
- Reload shows an ✕ while loading and then **is** a stop button: it sends the WS-only `web-stop`, which the host answers with `webContents.stop()` and closes the progress bracket (`WebPane.tsx:1046-1063`, `packages/daemon/src/ws/web-ui.ts:204-211`, `packages/shell/src/webhost/tab.ts:944-949`). Otherwise it sends `web-reload` with `hard` = ⌥ held (cache-bypassing). Tooltips: "Reload (⌘R, ⌥-click bypasses the cache)" / "Stop loading (⌘R reloads)". Reload is never disabled.
- `+` new tab ("New tab (⌘T)").
- 🎯 scope = element pickup toggle (§12.4).
- 🔒 storage panel toggle (§13.1).
- `</>` toggles the docked dev-tools inspector (§16.5).
- 📖 bookmarks menu (§14).

Narrow panes (owner-directed, `WebPane.tsx:228-295`): the row measures itself and the address keeps a 60 px minimum; to pay for it the row sheds `</>` first (below ~272 px of pane) and then 🎯 (below ~244 px). Both stay reachable from the pane header's context menu ("Toggle Developer Tools", "Element Pickup") at every width. Once both are shed and a 60 px address still does not fit, the floor is released rather than pushing the remaining controls off the pane. Storage, bookmarks and new-tab are never shed.

### 16.2 URL bar editing semantics (subtle)

The bar shows `displayedURL` (live engine URL, filtered: empty/`about:blank` updates are ignored so a failed load keeps showing what the user tried). Reconciliation rules (`packages/client/src/webpane/WebPane.tsx:457-489`):

- Track `lastWritten` = what the client last wrote into the field. When the underlying URL changes: if the field is focused AND its content differs from `lastWritten` (user mid-edit), do NOT overwrite, stash as `pending` and apply it when editing ends (blur), so an abandoned draft doesn't stick around. Otherwise overwrite immediately (tab switches update the bar even while focused-but-untouched; mere focus via ⌘L/click is not "editing").
- Enter submits the raw field text → navigate (normalization happens downstream); any pending URL is discarded (the navigation will surface the canonical URL).
- ⌘L (focus token bump): focus the field and select all.
- Placeholder "Enter URL"; monospaced 11pt.

### 16.3 Load progress strip

A 2px accent strip pinned to the chrome block's bottom edge (`packages/client/src/webpane/progress.ts`, `WebPane.tsx:988-1013`). Electron reports no load fraction, so the strip is indeterminate: the host emits `nav-state {loading, can_go_back, can_go_forward}` per tab (`did-start-loading` opens the bracket, `did-stop-loading`/`did-fail-load` close it; identical consecutive reports are dropped; nothing is reported before the tab's first real navigate, `tab.ts:718-737`), the daemon broadcasts it as `web-nav-state {paneID, tabID, loading, can_go_back, can_go_forward}` (`packages/daemon/src/webpane/service.ts:433-442`, `packages/daemon/src/boot/compose.ts:635-644`), nothing is stored, and the client keeps the last report per (pane, tab).
- On loading=true: cancel any fade-out; the strip appears immediately (the head-start that used to be `max(progress, 0.05)` exists so the click registers) and a 40%-wide sweep animates.
- On loading=false: snap to full width (the one real width there is), hold 300ms, fade out (~300ms), then after another 150ms settle reset to idle (guards against a stale event redrawing a full bar for a frame).
- Reports are filtered to the pane's active tab. On tab switch, snap to the incoming tab's last report (sweeping if it's loading, else hidden) with no animation from the old tab's state, otherwise a strip frozen mid-load leaks across tabs.
- The strip is positioned out of the layout flow, so its appearance never moves the page hole (the shell would otherwise re-place the native view for each frame). The same report dims Back/Forward (§16.1).

### 16.4 Tab strip & pills

Horizontal scroll, only when tabs.count > 1. Pill: `displayLabel`, mono 11pt, max width 180, tail-truncated; active = accent fill (0.18) + accent border, inactive = faint gray. Close ✕ appears on hover or on the active pill, overlaid on the trailing edge (pill footprint doesn't change on hover); the title fades out under it via a gradient mask (solid to 82%, clear at 100%). Click selects; ✕ closes ("Close tab (⌘W)").

### 16.5 Dev-tools inspector

The `</>` button toggles a docked web inspector for the active tab. It sends the WS-only `web-devtools {tab_id, open?}` (`packages/daemon/src/ws/sync.ts:975-980`), forwarded straight to the host, which calls `webContents.openDevTools({mode:'bottom'})` / `closeDevTools()`; `open` absent means toggle on `isDevToolsOpened()` (`packages/shell/src/webhost/tab.ts:1171-1185`). Only the shell can open dev tools, so the button is disabled in a browser client (`WebPane.tsx:1184-1186`).

### 16.6 Focus & keyboard

- When the pane is focused and no text field is being edited, the active tab's web view holds keyboard focus (page gets keystrokes). The URL bar wins while editing; the ⌘L request always wins. Mechanics: the page is a separate renderer, so when a web pane gains focus the client sends the WS-only `web-focus-view` unless a chrome text field holds the caret (`packages/client/src/webpane/WebPane.tsx:599-618`); a committing navigation that stole the keyboard from somebody hands it back (`packages/shell/src/webhost/tab.ts:958-980`).
- A user click inside the page is the one gesture the client can never see, so the host reports `input-event` presses as a `view-focus` host event (`tab.ts:582-593`) and the daemon fans it out as `web-view-focus {paneID, workspaceID, windowID}` (`packages/daemon/src/webpane/service.ts:450-458`); the client in that window then moves its focus ring exactly as a terminal body click would.
- Chord forwarding: keystrokes land in the page's renderer first, so the shell intercepts ⌘F, ⌘L, ⌘R, ⌘T, ⌘W, ⌘←, ⌘→, ⌘⇧[, ⌘⇧], ⌘=, ⌘- and ⌘0 in `before-input-event` (key-downs only, ⌘ without ⌃/⌥, matched by physical `code`), cancels them in the page and replays them into the Kelpi window as `web-chord:<code>[:shift]` menu commands (`packages/shell/src/webhost/keys.ts:57-92`, `tab.ts:549-561`). The client replays each as a real `keydown`, so the palette guard, the priority layer below and the normal binding lookup all run in order (`packages/client/src/webpane/priority.ts:197-251`; ⌘F reaches `toggle_search` this way). Bare ⌘[ / ⌘] stay with the page.
- Priority shortcut layer (`priority.ts`), **only when the focused pane is a web pane** (checked before the user keybinding map, so global bindings keep working elsewhere):

| Keys | Action |
|---|---|
| ⌘L | focus URL bar (select all) |
| ⌘R | reload (soft) |
| ⌘← / ⌘→ | back / forward — **unless** the URL bar (any text field) is editing, in which case fall through to cursor movement |
| ⌘T | new blank tab (URL bar focused) |
| ⌘W | close active tab, only when tabs > 1; with 1 tab fall through to the normal close-pane binding |
| ⌘⇧[ / ⌘⇧] | prev / next tab (skip while URL bar editing) |
| ⌘= (also ⌘⇧=) | zoom in +0.1 |
| ⌘- | zoom out −0.1 |
| ⌘0 | reset zoom |

- Bindable actions (config `keybind =` names, `packages/core/src/config/actions.ts`) all default-unbound except `open_web_pane` (⌘⇧O): `web_focus_url_bar`, `web_back`, `web_forward`, `web_reload`, `web_tab_new`, `web_tab_close`, `web_tab_prev`, `web_tab_next`, `web_zoom_in`, `web_zoom_out`, `web_zoom_reset`. Their dispatch requires the focused pane to be a web pane; `web_tab_close` also requires >1 tab.
- Menu bar: File → New Web Pane (⌘⇧O) → blank pane split from the focused pane.

### 16.7 Empty state

Tab-less pane (fresh blank open, or a restored private pane): globe glyph, "New web pane", "Type a URL above and press Return".

---

## 17. Cross-cutting invariants

1. Pane/tab UUIDs are minted by the *initiator* (reducer or socket handler) before any effect runs, so CLI replies can echo real ids; duplicate tab ids are rejected on open.
2. `activeTab` is always resolved with a `tabs.first` fallback — `activeTabID` may be momentarily stale after a close; every consumer (chrome, host, wire replies) must share this fallback.
3. `webPanes[paneID]` exists iff the pane exists with type web; it is created in `openWebPane`, removed in `closePane`, restored by persistence/reopen. `web pane state missing` is an invariant-violation error, not a user error.
4. Wire replies are optimistic: they are sent before (or independent of) the underlying navigation/effect (`web-navigate` waits for the host's ack, never for the load). Failures surface via later reads (`web-url`, `web-capture`), the error page, or the console, not via the ack. The exception is a daemon with no host attached, which fails the verbs that need a live page up front (§8.7).
5. Console `seq` is monotonic per pane and survives `clear`; `droppedSinceLastDrain` is reset by exactly two paths, a poll drain's acknowledge and the follow fan-out that attached the count to a line (one fan-out serves both `--follow` and WS `web-console-subscribe`, so the notice reaches whichever consumer's line goes out first, §9.3).
6. Inspector nonce: every arm mints a new nonce; a payload without the current nonce (or from a non-main frame, or from a non-armed tab) is silently dropped. Disarm on: delivery (single-shot), Esc-cancel, explicit `--disarm`, batch hide/cancel/send, tab destroy of the armed tab.
7. Text/HTML/attribute reads are byte-clamped on UTF-8 boundaries with explicit truncation markers (`[truncated]` / `<!-- truncated -->` / `... [truncated]` / `truncated:true` flags) so a consumer can always tell content was cut.
8. Everything pasted into a PTY passes through the ANSI/C0 sanitiser (§11.6).
9. Only `.shell` panes are valid paste destinations (inspect `--send-to`, batch send targets).
10. Private panes never persist tab content, only the flag.

---

## Compatibility rationale (Electron `WebContentsView` + CDP)

These items record the quirks Kelpi preserves on purpose, so that the pre-port `kelpi` CLI, hook scripts and saved state keep working, and explain the odd corners of the Electron host that exist because of them.

**Topology.** Pane ⇒ a tab registry; tab ⇒ one `WebContentsView` (hosted in the Electron shell, orchestrated by the daemon) + one attached CDP session. The registry keyed pane→tab (`packages/shell/src/webhost/registry.ts`) owns lifecycle and survives client (web UI) reconnects. The daemon is headless: the browser views live in the Electron shell process, so the daemon reaches them over the host RPC seam (`packages/daemon/src/webpane/HOST_PROTOCOL.md`) and proxies wire commands to it (§8.7). Remote/mobile clients viewing a web pane need pixel or DOM streaming, which is out of scope; the seam does not assume the daemon can render.

**Wire compatibility is the contract.** All `web-*` commands, key names, reply shapes, error strings' *semantics* (exact strings are nice-to-have; the CLI only branches on `ok`/`found`/`present`/`deleted`), exit-code behaviors, and the console streaming framing are unchanged from the pre-port app. The shipped CLI's `capture` flag set is pinned to the 0.32.0 binary for the same reason (§8.4).

Per-capability mapping:

- **Script injection**: `Page.addScriptToEvaluateOnNewDocument` replaces user scripts. It runs in **all frames**, so the inspector/batch/actuator/find scripts self-guard with `if (window !== window.top) return;` to keep their main-frame-only behavior (`scripts.ts:4-9`). The find script's "document end" timing is honoured by injecting at start and deferring the body-dependent work (the style injection rAF-retries, §7.5).
- **Host↔page messaging**: `webkit.messageHandlers.X.postMessage` is replaced by `Runtime.addBinding("kelpiPost")` plus a tiny shim (`window.webkit = {messageHandlers:{X:{postMessage: o => kelpiPost(JSON.stringify({channel:'X', body:o}))}}}`) so the injected scripts keep their legacy call sites; `Runtime.bindingCalled` gives `{channel, body}` plus the frame's execution context (context→frame enforces the main-frame checks). Tab attribution comes from which CDP session fired.
- **Actuator/exec evaluation**: `Runtime.evaluate` with `awaitPromise: true, returnByValue: true` (a plain evaluate would return the Promise object; `__kelpiAct.wait` is the method that bites).
- **Console**: CDP `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded` + `Network.loadingFailed`/`responseReceived` cover strictly more than the injected wrapper the pre-port app used (including engine-level network errors the wrapper existed to approximate). Kelpi reimplements the same formatting from CDP events (`console-format.ts`; args joined with " ", `Assertion failed:` prefix, `fetch 404 …` strings) and injects no wrapper, so nothing is double-reported. Preserved: the level set {log,debug,info,warn,error} (CDP `warning`→`warn` etc.), per-line `url`, optional line/column, ring-buffer + seq + dropped semantics.
- **Screenshot**: `Page.captureScreenshot {format:'png'}` (visible viewport, against the automation viewport when parked, §8.4). The 1MB inline-vs-tempfile split and the filename pattern are kept; the OS temp dir is used.
- **Text/DOM capture**: `Runtime.evaluate("document.body?document.body.innerText:''")` etc.; the byte clamps + markers are kept.
- **Click fidelity**: the actuator dispatches *synthetic JS events* with documented trade-offs (`:hover` doesn't work; `at`-clicks skip native semantics). CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent` would produce **trusted** events and strictly improve hover/click fidelity, but they change observable behavior (e.g. navigation on anchor clicks with modifiers, real `:hover`). The JS actuator stays the compatibility baseline (it is also what `exec`'s `$`/`kelpi` aliases compose with); trusted-input variants would be an additive flag.
- **Find**: the injected script is kept rather than `webContents.findInPage` + `found-in-page` events (identical counts/colours, custom palette). Preserved: per-pane needle memory, re-apply after navigation, retarget on tab switch/close, `{total, current(-1)}` reporting filtered to the active tab.
- **Zoom**: `webContents.setZoomFactor`. Electron zoom is per-origin by default, so the host re-applies the tab's factor after every navigation and load to keep it per-tab (`tab.ts:1124-1132`). Clamp [0.5, 3.0], reset→1.0.
- **Private mode**: Electron session partitions: persistent = `persist:kelpi-web`, private = an in-memory `kelpi-web-private-<paneID>` partition per pane. The partition is fixed at `WebContentsView` creation, so the flip-destroys-and-rebuilds rule carries over directly (§6).
- **Cookies/site data**: `session.cookies.get/set/remove` + `session.clearStorageData()` (for `--all` / clear-all-site-data). `canonicalDomain` (strip leading dot) grouping/matching and the delete-then-set edit rule are kept; the pre-port app's omit-unless-true secure/httpOnly quirk is explicit booleans on the wire (`is_secure`/`is_http_only`). `expires` in the wire reply stays unix seconds; absent = session cookie.
- **file:// loading**: the pre-port WKWebView needed an explicit parent-directory read grant; Electron `file:` loads work by default with `webSecurity` left on, which is the deliberate posture (a local HTML file referencing sibling assets works; local `fetch`/XHR does not, §4.2). The CLI-side `file://` resolution (`localFileURL`) is transport-independent and unchanged.
- **URL/title/progress tracking**: `webContents` events: `did-navigate`, `did-navigate-in-page`, `page-title-updated`, `did-start-loading`/`did-stop-loading`. Electron has **no `estimatedProgress`**, so the progress strip is an indeterminate animation between start/stop, but the visibility state machine (head-start, hold-at-full, fade, snap-on-tab-switch) is kept (§16.3). The `about:blank`/empty-URL placeholder guard is preserved when mirroring into state (§4.4).
- **Error page**: `did-fail-load` (with `errorDescription`, `validatedURL`) replaces the delegate callbacks. Kept: lastAttemptedURL bookkeeping, the stub with Retry href, the URL bar continuing to show the attempted URL (the client owns `displayedURL`, so the pre-port `baseURL` trick is unnecessary; state is simply not overwritten on failure), reload-on-stub retries the original URL, and `-3 ERR_ABORTED` (user-initiated cancels and replaced navigations) is ignored because WKWebView never surfaced those as failures either.
- **Dev tools**: `webContents.openDevTools({mode:'bottom'})` / `closeDevTools` / `isDevToolsOpened` replace the pre-port private-SPI + container-view dance entirely; there is no container concept (§16.5).
- **First-responder/focus juggling** (§16.6 claim rules) is ordinary DOM focus management in the web client plus the `web-focus-view` / `web-view-focus` handoffs; the *policy* is kept (web view holds focus unless a text field is editing; the URL-bar request wins).
- **Background tabs**: hidden `WebContentsView`s stay attached with `backgroundThrottling: false` so background tabs keep running JS, the behavior agents rely on (e.g. a `wait` racing in one tab while another is shown).
- **Follow-stream plumbing**: the per-pane follower set, the disconnect callback on FD close, and close-pane cleanup sit on the daemon's socket layer (§9.3). The one asymmetry preserved deliberately: streamed lines ignore the `--level` filter, exactly as the pre-port app streamed them.
- **UUID discipline**: server-minted pane/tab ids ride every reply; the CLI scripts against them.
- **Things from the macOS app with no counterpart here**: NSTextField first-responder details (the *semantics* of §16.2's lastWritten/pending reconciliation are kept; they are what make the URL bar feel right), SwiftUI notification plumbing, `WKUserScript` idempotency across process-pool reinjection (CDP injects per-navigation; the `if (installed) return` guards still matter for bfcache/same-document navigations), Swift 6 concurrency notes.
- **Security posture**: the nonce channel was designed for an in-process message handler; with CDP bindings the same nonce scheme works and is kept (page JS can call the binding, the nonce is what it cannot forge). `contextIsolation` is on for the view; the injected scripts intentionally live in the page world (the actuator must see the page's React internals via prototype setters, so it is not in an isolated world).
