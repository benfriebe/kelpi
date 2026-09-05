# Web-pane host protocol (daemon ↔ shell)

The daemon is headless: it owns web-pane *state* (which panes are web panes, their tabs, the
active tab, the private flag, the console ring buffers, the element-picker arms) but it cannot
render a page. Anything that needs a real browser is forwarded to a **host** — in v1 the
Electron shell, which owns one `WebContentsView` per tab plus its CDP session.

This document is the contract. The daemon side is `packages/daemon/src/webpane/`; the wire
behaviour the whole thing exists to preserve is `docs/web-pane.md` (referenced below as
§n). Message types live in `@kelpi/protocol` (`ws/messages.ts`).

---

## 1. Transport

The host is an ordinary WS client of the daemon (`/ws?token=…`, or an `Authorization: Bearer`
header — the same token gate as the web UI). That gate lives in the **handshake**: an upgrade
carrying a missing or wrong token still succeeds, and the `hello` below is what gets accepted
or refused (`{"type":"rejected","code":"unauthorized","reason":"bad-token",…}` then a 4003
close). It completes the normal handshake first:

```jsonc
// host → daemon
{"type":"hello","protocolVersion":1,"token":"…",
 "client":{"kind":"electron","name":"kelpi-shell","capabilities":["web-pane-host"],
           "windowID":"<uuid>"}}
```

Listing `web-pane-host` in `client.capabilities` claims the role as part of the handshake. The
explicit form works too, any time after `hello`:

```jsonc
{"type":"host-register","role":"web-pane","name":"kelpi-shell","windowID":"<uuid>"}  // host → daemon
{"type":"host-registered","role":"web-pane","hostID":"…","superseded":false}  // daemon → host
```

**`windowID` is optional but load-bearing for embedded views** (§3.5). A host that renders into
a window mints one id per window, declares it here, and loads the web UI with the same id in the
URL (`?shellWindow=<uuid>`). The daemon then compares the two on every geometry report and tells
the host whether a rect came from its **own** window — which is what stops a browser on another
machine from moving a desktop user's views. A host with no window (a headless automation host)
simply omits it and never gets `ownWindow:true`.

**Exactly one host is active.** A second registration wins, and the previous host is told:

```jsonc
{"type":"host-revoked","role":"web-pane","hostID":"…","reason":"superseded"}
```

`reason` is `superseded` (someone else registered), `shutdown` (the daemon is stopping), or
`unregistered` (only when the daemon revokes for its own reasons — a host that sends
`host-unregister` is not told about its own request). After a revoke the connection is an
ordinary client again: its `host-rpc-reply` and `host-event` frames are ignored, and any RPC it
still owed fails with `web pane host disconnected`.

Releasing the role: send `{"type":"host-unregister"}`, or just close the socket.

**On (re)registration the daemon replays state**: one `pane-open` notification per existing web
pane (§3), so a shell that starts after the daemon — or reconnects after a crash — rebuilds
exactly the panes the daemon has. Build them idempotently.

---

## 2. RPC

```jsonc
// daemon → host
{"type":"host-rpc","id":"…","verb":"actuate","args":{…},"timeoutMs":5000}
// host → daemon
{"type":"host-rpc-reply","id":"…","reply":{"ok":true, …}}
```

Rules:

- `reply` is the **envelope the CLI will see**. The daemon merges `pane_id`, `workspace_id` and
  (for tab-scoped verbs) `tab_id` into it and writes it to the control socket verbatim. An
  `ok:false` envelope is a legitimate answer (`{"ok":false,"error":"no match for selector: #x"}`
  → the CLI exits 1); it is not a protocol error.
- Answer **every** RPC. If the daemon's `timeoutMs` elapses first it answers the CLI itself with
  `web pane host did not answer '<verb>' within <n>ms` and discards your late reply.
- `id`s are opaque; echo them back unchanged.
- Never block the socket: the daemon may have several RPCs in flight.

Fire-and-forget mirroring of daemon-owned state (no reply, ever):

```jsonc
{"type":"host-notify","verb":"tab-open","args":{…}}
```

---

## 3. Verbs

`paneID` / `tabID` are always canonical uppercase UUIDs minted by the daemon.

### 3.1 Lifecycle (`host-notify`, no reply)

| verb | args | host must |
|---|---|---|
| `pane-open` | `{paneID, isPrivate, activeTabID, tabs:[{id,url,title}]}` | create/refresh the pane's view set and its storage partition (persistent, or an in-memory one when `isPrivate`); load each tab's URL. Idempotent — sent again on every host registration. |
| `pane-close` | `{paneID}` | destroy every view for that pane and its partition handles. |
| `pane-set-private` | `{paneID, isPrivate, activeTabID, tabs:[…]}` | the partition is sealed into the views, so **destroy and rebuild** the pane against the new store (§6). Live JS state is expected to be lost. |
| `tab-open` | `{paneID, tabID, url, makeActive}` | create the view, load `url`, show it when `makeActive`. |
| `tab-close` | `{paneID, tabID}` | destroy that tab's view; if the element picker was armed on it, disarm (§17.6). |
| `tab-select` | `{paneID, tabID}` | show that tab; background tabs keep running (agents rely on it). |
| `pane-geometry` | `{paneID, tabID?, rect:{x,y,w,h}, visible, devicePixelRatio, ownWindow, shellWindowID?, clientID?}` | §3.5 — place (or un-place) the pane's active view in the host's own window. |

### 3.5 Geometry: where an embedded view goes

The daemon owns no pixels and the host owns no layout: the **client** draws a web pane's chrome
(URL bar, tab strip, nav buttons) and leaves the page area empty, so it is the only party that
knows where the hole is. It reports that rect — CSS pixels, **relative to its viewport** — and
the daemon forwards it here, unmodified apart from the tagging below.

```jsonc
// client → daemon                                   // daemon → host
{"type":"web-geometry-report","paneID":"…",          {"type":"host-notify","verb":"pane-geometry",
 "tabID":"…","rect":{"x":12,"y":40,"w":900,"h":500},  "args":{…, "ownWindow":true}}
 "visible":true,"devicePixelRatio":2,
 "shellWindowID":"<uuid>"}
```

Rules:

- **`ownWindow` is the only field that authorises anything.** It is true when the reporter's
  `shellWindowID` equals the `windowID` this host declared at registration (§1) — i.e. the report
  came from the UI running inside the host's own window. Anything else (a browser on a phone, a
  second shell's window, a client that sends no id) arrives with `ownWindow:false` and **must be
  ignored**: those clients render the placeholder card instead. Re-check the id against your own
  window anyway; the daemon's tag is a convenience, not a capability.
- **`visible:false` means "put the view back"** — the pane was zoomed away, the workspace
  switched, the tab closed, or the client unmounted it. A zero-area rect is normalised to
  `visible:false` by the daemon so there is exactly one rule to implement.
- **A parked view keeps its layout.** `visible:false` moves the view off screen; it must not
  resize it. Most hides are a menu or a popover over the pane (§3.6), and a page reflowed to the
  automation viewport comes back scrolled and laid out differently: one wider than the pane has
  no sideways overflow at 1280 px, so its horizontal scroll is lost, and a header menu closing
  over such a page moved the whole page 300 px. The automation viewport (§8.4's 1280×800 @1×)
  is applied lazily, by the first automation read (`capture`, `actuate`, `exec`) that reaches a
  parked view, and cleared again by the next placement - so those verbs still answer against it,
  and a view nobody reads while it is parked comes back exactly as it left.
- **CSS px → DIP is the host's job.** `devicePixelRatio` is display scale × page zoom; dividing
  it by the window's own scale factor yields the CSS→DIP factor. Clamp the result to the window's
  content bounds — a pane can be scrolled or dragged partly off-screen, and a view must never be
  placed outside the window it lives in.
- **Reports are facts about *now***, never stored: the daemon keeps no geometry, so a host that
  reconnects gets nothing until the client's next report (which its own re-render produces).
  Panes that never get one — every pane while no client is attached — keep working exactly as
  before, off-screen: this whole section is additive to the automation surface.
- **A client that vanishes releases what it placed.** A closed tab, a reload or a crash never
  sends `visible:false`, so the daemon synthesises one per pane that connection had placed when
  its socket closes. Expect a hide you did not see a report for.
- The report is fire-and-forget; the daemon never answers it, and drops it when no host is
  attached or the pane is not a web pane.

### 3.6 Poster: the still frame a parked pane wears (issue #12)

A web pane's page is a native view composited **above** the client's document, so a menu drawn
over it can only be seen once the view goes back to the holder — and the pane then shows an empty
hole for as long as the menu is up. That is what the owner reported: right-click a web pane's
header and the page vanishes until the menu closes.

The client answers it by photographing the page **before** it parks. It holds the view on screen,
asks for one frame, paints that frame in the hole and only then reports `visible:false`, so the
menu ends up over a picture of the page rather than over nothing.

```jsonc
// client → daemon                                  // daemon → host
{"type":"command","id":"c1","payload":{             {"type":"host-rpc","id":"…","verb":"poster",
  "command":"web-poster","pane_id":"…",              "args":{"paneID":"…","tabID":"…"},
  "tab_id":"…"}}                                     "timeoutMs":2000}
// host → daemon → client
{"ok":true,"image_base64":"…","mime":"image/jpeg","base64_bytes":214512,
 "bounds":{"x":753,"y":88,"width":525,"height":706},"css_scale":1,"pane_id":"…"}
```

| verb | args | reply |
|---|---|---|
| `poster` | `{paneID, tabID}` | `{ok:true, image_base64, mime:"image/jpeg", base64_bytes, bounds?, css_scale?}` — the tab's **visible viewport as it is on screen**, at the pane's own size and the display's own scale, plus **the box it is a picture OF**. `{ok:false,error}` for every no. Budget: **2 s**. |

Rules, and each of them is load-bearing:

- **On-screen views only.** A tab in the off-screen holder is not what the person is looking
  at - and once an automation read has pinned it (§3.5) it is laid out at 1280×800 for nobody, so
  its frame is a picture of a page sized for nobody; painted into the pane's hole it would be a
  clipped, wrong-aspect corner. A host with the tab parked answers
  `{ok:false,error:"no on-screen view to poster"}` — never a frame it knows is wrong.
- **It is not `capture`.** `capture --mode screenshot` is the automation read: deterministic
  1280×800 @1× PNG, spilled to a temp file above 1 MB, 20 s of budget. A poster is the opposite
  of all four — the pane's real pixels, JPEG (a base64 PNG of a retina pane is megabytes *per
  menu*), inline-or-nothing (an `<img>` in a renderer cannot open a temp file), and answered in
  milliseconds or not at all.
- **Refuse rather than delay.** The client is holding a live view on screen and a half-drawn menu
  under it while this call is out. Anything a host cannot answer immediately — no renderer yet, a
  frame over the inline budget (`poster too large to send inline`), a capture that threw
  (`poster capture failed`) — is an `ok:false` now, not a slow `ok:true`. The client parks with an
  empty hole, exactly as it did before this verb existed, and stops asking that pane to be waited
  for until one succeeds.
- **Every refusal is SILENT at the other end.** No `ok:false` from this verb reaches the user:
  nobody asked for a poster, so nothing about one is news, and the pane's answer to every no is
  behaviour the person already knows. The client enforces that by keeping `web-poster` off the
  toasting path its gesture verbs use (`client/src/webpane/commands.ts` `SILENT_WEB_COMMANDS`,
  pinned in `App.window-chrome.test.tsx`) — without which a right-click over a page could raise
  an error card *per click*, and park every pane again for the card.
- **The frame comes with the box it is OF** (`bounds`, DIP, relative to the window's content
  area — the placement `viewBounds` computed — and `css_scale`, the factor that turns those back
  into the client's CSS pixels, i.e. the inverse of the page zoom). **The client cannot derive
  this**, and the promoted build proved what happens when it tries: the shell rounds and clamps
  every edge before placing the view, and an `<img>` given only insets is not stretched to them —
  it is a replaced element, so it keeps its intrinsic aspect under Tailwind's
  `img{max-width:100%;height:auto}`. On a 2× display a 1050×1412 capture was laid out as
  528.99 × 711.38 where the view had been 525 × 706, so the page appeared to grow 0.76% the
  instant a menu opened, and snapped back when it closed. A host that cannot say where the view
  is may omit both fields; the client then falls back to the focus-ring gutter, which is the
  right box to within the rounding. **The box describes the view at REPLY time, not at capture
  time**: it is read when the reply is built, so a host must not answer with a placement it has
  since changed — and a host whose window changed display scale between the two must omit it
  rather than mix the client's last-reported `devicePixelRatio` with a scale factor that no longer
  holds. (`web-smoke`'s check compares the reply's `bounds` with the placement line the shell
  logged, which is only a fair comparison because of this rule.)
- **The client parks only once the picture is ON SCREEN.** Not a host rule but the other half of
  the same defect, recorded here because the budget above is sized for it: the park is a socket
  message the shell acts on within a millisecond, and an `<img>` committed in the same tick cannot
  appear before the next composited frame — measured at 8–12 ms of empty pane, one to two frames,
  which is what "it flickers" was. The client holds the view until a decode plus a double
  `requestAnimationFrame` says the frame exists, so a host that answers slowly costs a late menu
  and never a blink (`scripts/ui-audit/poster-swap-flicker.mjs` measures both ends).
- **Nothing is stored.** The daemon forwards and forgets: no frame is kept, cached or logged, and
  a pane that is never covered is never photographed. The shell logs that a frame was taken and
  how big it was, never the frame itself.
- **Who may ask: any authenticated session, including a paired device — a decision, not an
  oversight.** `web-poster` is an ordinary web command, so a phone attached over the tailnet with
  a `kd_` device token can call it and receive a picture of what is on the owner's screen in that
  pane. That is deliberate and it adds **no new class of access**: the same session can already
  call `web-capture --mode screenshot` for a PNG of the page, `--mode dom` for its HTML and
  `web-exec` to run script in it, and every one of those is older than this verb. The owner-only
  family is `remote-*` (pairing and revocation, `ws/remote.ts`), and a poster is not in it: it
  reads the same page the guest can already read, at the same trust boundary, and gating it alone
  would buy nothing while pretending otherwise. **If the web family is ever put behind a guest
  gate, this verb belongs behind the same one** — it is page content, not chrome.

### 3.2 Navigation (RPC)

| verb | args | reply |
|---|---|---|
| `navigate` | `{paneID, tabID, url}` (already normalized) | `{ok:true}` as soon as the load is *started* — the ack is optimistic by design (§17.4). |
| `back` / `forward` | `{paneID, tabID}` | `{ok:true}` (a no-op when history cannot move still acks ok). |
| `reload` | `{paneID, tabID, hard}` | `{ok:true}`. `hard` = bypass cache. If the tab shows the inline error page, retry `lastAttemptedURL` (§4.3). |
| `stop` | `{paneID, tabID?}` | Stop the load in flight (`webContents.stop()`), then emit `nav-state` with `loading:false`. `{ok:true}`, or `{ok:false,error}` from a host that cannot. WEB-032's ✕ glyph; GUI-only (`web-stop`). |
| `focus-view` | `{paneID, tabID?}` | Give the tab's view keyboard focus (`webContents.focus()`). `{ok:true}`. WEB-043: the pane is focused and no chrome text field has the caret — **the client decides that**, never the host. GUI-only (`web-focus-view`). |
| `url` | `{paneID, tabID}` | `{ok:true, url, title}` — the LIVE values. Anything else and the daemon falls back to its state copy. |
| `capture` | `{paneID, tabID, mode}` | §8.4: `meta` → `{ok:true, url, title}`; `text` → `+ text, byte_count`; `dom` → `+ html, byte_count`; `screenshot` → `+ png_base64` or `+ path`, `byte_count`; `all` → the composite (`text`, `text_byte_count`, `html`, `html_byte_count`, screenshot fields with `screenshot_byte_count`, `screenshot_error` on partial failure). Keep the byte clamps and truncation markers. Budget: 20 s. |

### 3.3 Automation (RPC)

| verb | args | reply |
|---|---|---|
| `actuate` | `{paneID, tabID, method, args:[…]}` | Call `window.__kelpiAct[method](...args)` in the tab's **main frame, page world**, with the promise awaited (CDP `Runtime.evaluate {awaitPromise:true, returnByValue:true}`), and return its object verbatim. `method` is one of `click, type, text, attr, count, exists, dom, select, scroll, hover, key, wait` (§7.4). Missing actuator → `{ok:false,error:"actuator not installed"}`; a dead tab → `{ok:false,error:"web pane has no live tab <uuid>"}`; a non-object/throwing evaluation → `{ok:false,error:"actuator evaluation failed: <detail>"}`. |
| `exec` | `{paneID, tabID, script}` | Wrap per §8.5 (`$`/`$$`/`kelpi` aliases, statement-vs-expression detection) and return `{ok:true, result}` or `{ok:false, error, js_error:{name,message,line,column}}`. Budget: 30 s. |
| `inspect-arm` | `{paneID, tabID, nonce, sticky}` | Arm the in-page picker with that **nonce**; `{ok:true}` on success, `{ok:false,error}` otherwise (the daemon substitutes `failed to arm inspector for active tab` when no error is given). |
| `inspect-disarm` | `{paneID}` | Sent as a notify. Tear the picker down. |
| `devtools` | `{paneID, tabID?, open?}` | Toggle the tab's docked dev tools (§16.5); `open` forces a state, absent toggles. Reply `{ok:true, open:<bool>}`. GUI-only — it reaches the daemon as the WS command `web-devtools`, never from the CLI. |

Budgets: `actuate` 5 s, except `wait`, which gets the caller's `timeout_ms` + 5 s (default
15 s) so the page-side timeout resolves first and the agent sees the real `{ok:false,
error:"timeout", condition, waited_ms}` envelope.

### 3.4 Cookies (RPC)

| verb | args | reply |
|---|---|---|
| `cookies-list` | `{paneID}` | `{ok:true, cookies:[{name,value,domain,path,is_secure,is_http_only[,expires][,session_only]}]}` — `expires` is unix **seconds**; absent means a session cookie. |
| `cookies-clear` | `{paneID, all, domain?}` | `all:true` → wipe every site-data type since the epoch, `{ok:true, cleared_site_data:true}`. Otherwise delete cookies matching the canonical domain (leading `.` stripped) or all of them, `{ok:true, deleted:N}`. |
| `cookies-delete` | `{paneID, name, domain?}` | `{ok:true, deleted:N}`. |

With **no host attached** the daemon answers these itself with the "no coordinator yet" shape
from §13.2 — empty list, `deleted:0` — never an error.

---

## 4. Events (host → daemon)

```jsonc
{"type":"host-event","event":"console","paneID":"…","tabID":"…","payload":{…}}
```

| event | payload | daemon does |
|---|---|---|
| `console` | `{level, message, url, line?, column?}` | Appends to the pane's ring buffer (capacity 1000, monotonic `seq`, drop accounting) and fans out to `kelpi web console --follow` readers and WS subscribers. `level` is mapped onto `log/debug/info/warn/error` (`warning`→`warn`, `verbose`→`debug`, `assert`→`error`, anything unknown→`log`). Send one event per line, already argument-joined per §7.1. |
| `page-state` | `{url?, title?}` | Mirrors into the tab record and the pane header. `""`/`about:blank` URLs are ignored as placeholders (§4.4); titles are always taken. Send on `did-navigate`, `did-navigate-in-page`, `page-title-updated`. |
| `nav-state` | `{loading, can_go_back, can_go_forward}` with `tabID` | WEB-032/WEB-033. Broadcast to clients as `web-nav-state` (per **tab**, so WEB-034's tab snap works); never stored. Send on `did-start-loading`, `did-stop-loading`, `did-navigate` and a main-frame `did-fail-load`. Chromium has no `estimatedProgress`, so this bracket is all the progress there is — the client draws an indeterminate strip between the two edges. Suppress the bootstrap `about:blank` load, and drop an unchanged repeat. An event without `tabID` is ignored. |
| `inspect` | the picker payload (§7.2) — `{nonce, selector, xpath, tag, element_id, outer_html, attributes, rect, text, context_html, url, captured_at}`, or `{nonce, cancelled:true}` | Validates the nonce against the current arm (mismatch → silently dropped), sanitises it (ANSI/C0 stripping + byte clamps, §11.6), disarms the single-shot arm, queues the result for `kelpi web inspect-result` (cap 32) and, when the arm carried `--send-to`, pastes the formatted block into that shell pane's PTY. |
| `tab-closed` | `{}` with `tabID` | The host closed a tab on its own (`window.close()`, a crash): the daemon drops it from the tab list and re-activates the left neighbour. |
| `view-focus` | `{}` with `tabID` | §N29. The **user** gave this pane's page keyboard focus — a click inside the native view, which reaches Chromium and nothing else. Broadcast to clients as `web-view-focus` (`{paneID, workspaceID, windowID?}`, scoped to the reporting host's window); never stored, and the daemon does **not** move focus itself — the client runs the same focused-pane path a terminal body click runs and reports back with an ordinary `focus-report`. Send it only for a gesture the host did not cause: filter out the host's own `webContents.focus()` (the `focus-view` verb below), and report only for a view actually embedded in a window — a focus event on an off-screen holder view is automation, not a click, and moving the user's ring for it would be a defect of its own. A pane the daemon does not know as a web pane is dropped. |

Events from a connection that is not the current host are ignored.

---

## 5. Client-facing console subscription

Any client (the web UI) can read the same buffer over its own WS connection:

```jsonc
// client → daemon
{"type":"command","id":"c1","payload":{"command":"web-console-subscribe","pane_id":"…","since":0,"level":"error"}}
// daemon → client: the catch-up drain, then one message per line
{"type":"command-reply","id":"c1","reply":{"ok":true,"pane_id":"…","lines":[…],"next_since":42,"dropped":0,"follow":true}}
{"type":"web-console-line","paneID":"…","line":{"seq":42,"tab_id":"…","level":"error","message":"…","url":"…","captured_at":"…"}}
```

`web-console-unsubscribe` stops it; so does closing the connection or closing the pane. As on
the control socket, the catch-up drain honours `level`/`since`/`clear` and the streamed lines
do **not** apply the level filter (§9.3, a deliberately preserved quirk).

---

## 6. Which verbs need a host

The split is what makes the daemon usable headlessly, and it is a contract of its own — the
`no web pane host connected` string is what an agent sees when the shell is not running.

| CLI verb | with no host |
|---|---|
| `web open`, `web tabs`, `web tab-new/close/select`, `web private`, `web console`, `web inspect --disarm`, `web inspect-result` | **works** — daemon state; the host is notified when it exists |
| `web url` | **works** — falls back to the state's active-tab url/title (§8.2's "view not built yet") |
| `web cookies-list/clear/delete` | **works** — empty list / `deleted:0` (§13.2's "no coordinator") |
| `web navigate`, `back`, `forward`, `reload`, `capture`, `click`, `type`, `q-*`, `wait`, `select`, `scroll`, `hover`, `key`, `exec`, `web inspect` (arm) | `{"ok":false,"error":"no web pane host connected"}` |
| `web-poster` (GUI-only, §3.6) | `{"ok":false,"error":"no web pane host connected"}` — the client reads that as "park with no frame" |

Failure strings the daemon can author, all stable:

- `no web pane host connected` — nothing has claimed the role.
- `web pane host disconnected` — the host went away (or was superseded) with the call in flight.
- `web pane host did not answer '<verb>' within <n>ms` — budget elapsed.

---

## 7. Notes for the implementer

- **Injection**: `Page.addScriptToEvaluateOnNewDocument` runs in all frames — the inspector,
  batch-marker, actuator and find scripts must self-guard with `if (window !== window.top)
  return;`; the console script deliberately runs everywhere (§7).
- **Page world, not isolated**: the actuator writes through prototype value setters so React and
  friends accept the input. Moving it to an isolated world breaks `type` (§ port notes).
- **Nonce**: the daemon mints it and validates every payload against it. Page JS can call the
  CDP binding, so the nonce is the only thing that makes a picked element trustworthy — pass it
  through unchanged and re-check it host-side too.
- **Background tabs keep running.** Agents race a `wait` in one tab while another is visible.
- **The daemon never assumes it can render.** A remote browser client shows a placeholder for
  web panes; nothing in this protocol requires pixels to reach the daemon. `pane-geometry` is
  the *host's* affordance for putting a view on screen in its own window, not a rendering
  channel — no image ever crosses this socket.
- **A pane with no geometry is a working pane.** Views live in the host's off-screen holder
  until a report from the host's own window moves them, and go straight back there when one says
  `visible:false`. Every automation verb behaves identically in both places, which is what keeps
  the headless surface (and its live smoke) honest.
### The GUI-only half (find, zoom, element pickup, favourites, storage writes)

All of it is now wired, and none of it has a CLI verb — the Swift app has none either, so these
are **WS-only** commands (`daemon/src/ws/web-ui.ts`, matched in `ws/sync.ts` before the wire
decoder) rather than additions to the `kelpi web` vocabulary.

New host verbs this adds to the tables above:

| verb | kind | args | notes |
|---|---|---|---|
| `find` | rpc | `{paneID, tabID, action, needle}` | Was already implemented host-side; the daemon now drives it (§10). Reply `{ok, total, current}`. |
| `zoom` | rpc | `{paneID, tabID, factor?/delta?/reset?}` | Ditto (§4.2). The daemon sends ±0.1 per step and `reset` for ⌘0; the host clamps to [0.5, 3.0]. |
| `cookies-set` | rpc | `{paneID, cookie, original?}` | §13.2's write half. Deletes `original` first so a rename cannot leave a stale twin (WEB-052). |
| `batch-markers` | notify | `{paneID, tabID, items}` | Replace the numbered badges (§12). An empty list tears the page surfaces down. |
| `batch-clear` | notify | `{paneID, tabID}` | |
| `batch-highlight` | notify | `{paneID, tabID, itemID, scrollIntoView}` | Panel-origin focus scrolls; page-origin does not (WEB-130). |
| `batch-unfocus` | notify | `{paneID, tabID}` | |
| `batch-comment` | notify | `{paneID, tabID, itemID, comment}` | A panel-side edit; the page refuses it while its textarea has focus (WEB-141). |

And one new host **event**: `batch-marker`, carrying the page's own intents — `{id}` (a badge was
clicked), `{commentChanged:{id, comment}}`, `{dismiss:{id}}`, `{remove:{id}}`.

**Chord forwarding is not on this socket.** A page in a `WebContentsView` has its own keyboard
focus, so ⌘F / ⌘L / ⌘T never reach Kelpi's renderer once a user clicks the page. The host takes
those chords (`shell/src/webhost/keys.ts`), cancels them in the page, and replays them into its
own window over the daemon's existing `menu-request` → `menu-command` relay. No new message type,
and the daemon is not involved beyond fanning the relay out.

Where the state lives: the find needle (`webpane/find.ts`) and the batch session
(`webpane/batch.ts`) are **daemon** state, because the page-side half lives in a page the host
owns and two windows must see the same marks and the same numbering. Favourites
(`webpane/favourites.ts`) persist to `favourites.json` beside the database.
