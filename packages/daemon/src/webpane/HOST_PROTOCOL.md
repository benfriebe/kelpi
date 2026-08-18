# Web-pane host protocol (daemon ↔ shell)

The daemon is headless: it owns web-pane *state* (which panes are web panes, their tabs, the
active tab, the private flag, the console ring buffers, the element-picker arms) but it cannot
render a page. Anything that needs a real browser is forwarded to a **host** — in v1 the
Electron shell, which owns one `WebContentsView` per tab plus its CDP session.

This document is the contract. The daemon side is `packages/daemon/src/webpane/`; the wire
behaviour the whole thing exists to preserve is `docs/current/web-pane.md` (referenced below as
§n). Message types live in `@nex/protocol` (`ws/messages.ts`).

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
 "client":{"kind":"electron","name":"nex-shell","capabilities":["web-pane-host"]}}
```

Listing `web-pane-host` in `client.capabilities` claims the role as part of the handshake. The
explicit form works too, any time after `hello`:

```jsonc
{"type":"host-register","role":"web-pane","name":"nex-shell"}   // host → daemon
{"type":"host-registered","role":"web-pane","hostID":"…","superseded":false}  // daemon → host
```

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

### 3.2 Navigation (RPC)

| verb | args | reply |
|---|---|---|
| `navigate` | `{paneID, tabID, url}` (already normalized) | `{ok:true}` as soon as the load is *started* — the ack is optimistic by design (§17.4). |
| `back` / `forward` | `{paneID, tabID}` | `{ok:true}` (a no-op when history cannot move still acks ok). |
| `reload` | `{paneID, tabID, hard}` | `{ok:true}`. `hard` = bypass cache. If the tab shows the inline error page, retry `lastAttemptedURL` (§4.3). |
| `url` | `{paneID, tabID}` | `{ok:true, url, title}` — the LIVE values. Anything else and the daemon falls back to its state copy. |
| `capture` | `{paneID, tabID, mode}` | §8.4: `meta` → `{ok:true, url, title}`; `text` → `+ text, byte_count`; `dom` → `+ html, byte_count`; `screenshot` → `+ png_base64` or `+ path`, `byte_count`; `all` → the composite (`text`, `text_byte_count`, `html`, `html_byte_count`, screenshot fields with `screenshot_byte_count`, `screenshot_error` on partial failure). Keep the byte clamps and truncation markers. Budget: 20 s. |

### 3.3 Automation (RPC)

| verb | args | reply |
|---|---|---|
| `actuate` | `{paneID, tabID, method, args:[…]}` | Call `window.__nexAct[method](...args)` in the tab's **main frame, page world**, with the promise awaited (CDP `Runtime.evaluate {awaitPromise:true, returnByValue:true}`), and return its object verbatim. `method` is one of `click, type, text, attr, count, exists, dom, select, scroll, hover, key, wait` (§7.4). Missing actuator → `{ok:false,error:"actuator not installed"}`; a dead tab → `{ok:false,error:"web pane has no live tab <uuid>"}`; a non-object/throwing evaluation → `{ok:false,error:"actuator evaluation failed: <detail>"}`. |
| `exec` | `{paneID, tabID, script}` | Wrap per §8.5 (`$`/`$$`/`nex` aliases, statement-vs-expression detection) and return `{ok:true, result}` or `{ok:false, error, js_error:{name,message,line,column}}`. Budget: 30 s. |
| `inspect-arm` | `{paneID, tabID, nonce, sticky}` | Arm the in-page picker with that **nonce**; `{ok:true}` on success, `{ok:false,error}` otherwise (the daemon substitutes `failed to arm inspector for active tab` when no error is given). |
| `inspect-disarm` | `{paneID}` | Sent as a notify. Tear the picker down. |

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
| `console` | `{level, message, url, line?, column?}` | Appends to the pane's ring buffer (capacity 1000, monotonic `seq`, drop accounting) and fans out to `nex web console --follow` readers and WS subscribers. `level` is mapped onto `log/debug/info/warn/error` (`warning`→`warn`, `verbose`→`debug`, `assert`→`error`, anything unknown→`log`). Send one event per line, already argument-joined per §7.1. |
| `page-state` | `{url?, title?}` | Mirrors into the tab record and the pane header. `""`/`about:blank` URLs are ignored as placeholders (§4.4); titles are always taken. Send on `did-navigate`, `did-navigate-in-page`, `page-title-updated`. |
| `inspect` | the picker payload (§7.2) — `{nonce, selector, xpath, tag, element_id, outer_html, attributes, rect, text, context_html, url, captured_at}`, or `{nonce, cancelled:true}` | Validates the nonce against the current arm (mismatch → silently dropped), sanitises it (ANSI/C0 stripping + byte clamps, §11.6), disarms the single-shot arm, queues the result for `nex web inspect-result` (cap 32) and, when the arm carried `--send-to`, pastes the formatted block into that shell pane's PTY. |
| `tab-closed` | `{}` with `tabID` | The host closed a tab on its own (`window.close()`, a crash): the daemon drops it from the tab list and re-activates the left neighbour. |

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
  web panes in v1; nothing in this protocol requires pixels to reach the daemon.
- **Not implemented daemon-side yet** (client/shell milestones own them): the batch "element
  pickup" session (§12) beyond `inspect-result --clear`, favourites (§14 — no wire surface), the
  find-in-page bar (§10), zoom, and dev-tools toggling. They add verbs to this table; they do
  not change the ones above.
