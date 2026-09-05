# Config & Keybindings Subsystem — Behavioral Specification

Source of truth for this spec (Swift, current app):
- `Nex/Services/ConfigParser.swift`
- `Nex/Models/KeyBinding.swift`
- `Nex/Services/KeybindingService.swift`
- `Nex/Services/GlobalHotkeyService.swift` + `Nex/Services/AppActivation.swift`
- `Nex/Services/WorkspaceProfilesClient.swift`
- `Nex/Commands/NexCommands.swift` (menu-bar layer + `PaneShortcutMonitor`)
- `Nex/Features/Config/ConfigHotkeyFeature.swift` (state + persistence actions)
- `Nex/Features/Settings/*` (Settings UI surface)
- `Nex/Ghostty/SurfaceView.swift` (env injection at PTY spawn)

This subsystem covers: the `~/.config/nex/config` file format and its parser/writer, the
keybinding data model (triggers, actions, the binding map, defaults), the two keyboard
dispatch layers and their conditional rules, the system-wide global hotkey, workspace
profiles (named env-var sets injected into PTYs), and the Settings UI that edits all of it.

---

## 1. The config file: `~/.config/nex/config`

A single plain-text file, Ghostty-style `key = value` syntax. It is the ONLY config file;
the app also uses macOS UserDefaults for some settings (appearance, worktree base path,
etc. — see section 12), but everything in this file is the canonical store for:

- general settings: `focus-follows-mouse`, `focus-follows-mouse-delay`, `theme`,
  `tcp-port`, `global-hotkey`, `global-hotkey-hide-on-repress`
- keybinding overrides: `keybind = <trigger>=<action>`
- workspace profiles: `profile = <name>:<KEY>=<value>`

Path resolution: literally `~/.config/nex/config` with `~` expanded to `$HOME`. It is NOT
XDG-aware beyond that (no `$XDG_CONFIG_HOME` lookup).

### 1.1 Line syntax (shared by all parsers)

Every parser walks the file line-by-line (`split on newline`), and for each line:

1. Trim leading/trailing whitespace.
2. Skip if empty or starts with `#` (comment). Comments must be whole-line; there is no
   inline-comment support (`focus-follows-mouse = true # hi` would parse the value as
   `true # hi` and therefore NOT equal `"true"` — i.e. it disables the setting).
3. Find the FIRST `=`. No `=` → skip the line.
4. `key` = trimmed text before the first `=`; `rawValue` = trimmed text after it.
5. Dispatch on `key`. Unknown keys are silently ignored (forward compatibility).

Values are compared lowercased for general settings, EXCEPT `theme`, which preserves the
original case (theme names are case-sensitive filenames).

When the same key appears multiple times, later lines win (the loop just keeps
overwriting) — except `keybind` and `profile`, which accumulate (see below).

If the file does not exist or is unreadable, every parser returns its defaults / empty
result without error.

### 1.2 General settings

Parsed into this shape (defaults shown):

```ts
interface GeneralSettings {
  focusFollowsMouse: boolean;          // default false
  focusFollowsMouseDelay: number;      // ms, default 100
  theme: string | null;                // default null; original case preserved
  tcpPort: number;                     // default 0 = disabled
  globalHotkey: KeyTrigger | null;     // default null
  globalHotkeyHideOnRepress: boolean;  // default true
}
```

Per-key parse rules:

| key | rule |
|---|---|
| `focus-follows-mouse` | `true` (lowercased) → `true`; anything else → `false` |
| `focus-follows-mouse-delay` | integer; clamped to `max(0, n)`; non-integer values are ignored (keeps prior/default value) |
| `theme` | raw value stored verbatim (case preserved). Consumed at launch: matched by exact string against the built-in terminal theme ids (see section 11); unknown names are ignored |
| `tcp-port` | integer; accepted only if in `1..65535`, else ignored (stays 0/prior) |
| `global-hotkey` | value `none`, `unbind`, or empty → cleared (null). Otherwise parsed as a trigger string (section 3.2); unparseable values are silently ignored (stays null/prior) |
| `global-hotkey-hide-on-repress` | `false` (lowercased) → `false`; ANY other value (incl. garbage) → `true` |

Example file:

```
# Kelpi config
focus-follows-mouse = true
focus-follows-mouse-delay = 150
theme = Catppuccin Mocha
tcp-port = 19400
global-hotkey = ctrl+alt+space
global-hotkey-hide-on-repress = true

keybind = super+shift+d=split_down
keybind = super+e=unbind

profile = work:CLAUDE_CONFIG_DIR=~/.claude-accounts/work
profile = work:FOO=bar
profile = personal:CLAUDE_CONFIG_DIR=~/.claude-accounts/personal
```

### 1.3 Writing a general setting (`setGeneralSetting(key, value)`)

Used when the user changes a general setting in the Settings UI. Behavior:

1. Read the existing file (if any). For each line: if the line's key (text before its first
   `=`, trimmed) equals the target key, replace the entire line with `<key> = <value>`
   (canonical spacing); otherwise keep the line verbatim (comments, blanks, keybinds,
   profiles all preserved byte-for-byte).
   - Edge: if the key appears on multiple lines, EVERY one of those lines is replaced
     with the same new line (duplicates persist as duplicates).
2. If no line matched: strip trailing blank lines, then append `<key> = <value>`.
3. Ensure the output ends with a trailing newline.
4. Create the parent directory if needed; write atomically. All write errors are silently
   swallowed.

Settings written through this path: `focus-follows-mouse`, `focus-follows-mouse-delay`,
`tcp-port`, `global-hotkey` (value = trigger config string, or `none` when cleared),
`global-hotkey-hide-on-repress`. Note `theme` is NEVER written back to this file by the
app — the config `theme` key is a read-at-launch input only; the theme picked in Settings
persists to UserDefaults instead.

### 1.4 `keybind` lines

```
keybind = <trigger>=<action>
```

Parsing (per matching line, in file order, accumulated into a list of overrides):

1. Line key must be exactly `keybind` (lines are pre-filtered by prefix `keybind` and then
   verified `key == "keybind"` — so e.g. `keybindx = ...` is skipped).
2. The value (`super+shift+d=split_down`) is split at its LAST `=`:
   text before = trigger string, text after = action string. (Last-`=` split is what lets
   the `=` key itself be bound: `keybind = super+==increase_markdown_font_size` →
   trigger `super+=`, action `increase_markdown_font_size`.)
   No `=` in the value → warn + skip.
3. Trigger string parsed per section 3.2; unknown key/modifier → warn + skip line.
4. Action string must be a known `KelpiAction` raw value (section 4) or `unbind`;
   unknown → warn + skip line.

The result is an ordered override list applied ON TOP of the hardcoded defaults
(section 5.2): a trigger mapped to `unbind` removes that trigger; any other action
replaces/adds the trigger→action mapping. Later lines win for the same trigger.

Load-time behavior (`KeybindingService.loadFromDisk`, run once at app launch):

```
if config file missing/unreadable -> defaults
overrides = parseKeybindings(file)
if overrides empty -> defaults
else -> defaults.applying(overrides)
```

There is no file watcher: hand-edits to `keybind` lines require an app restart. Edits made
through the Settings UI update in-memory state immediately AND write the file.

### 1.5 `profile` lines

```
profile = <name>:<KEY>=<value>
```

One environment variable per line. Split rules on the value:

1. Split at the FIRST `:` → profile name (trimmed) | assignment. Missing `:` → warn + skip.
2. Split the assignment at its FIRST `=` → env key (trimmed) | env value (trimmed).
   Missing `=` → warn + skip.
3. Empty name or empty env key → warn + skip.
4. Values MAY contain both `:` and `=` (e.g. `profile = work:URL=http://x:8080/a=b` gives
   key `URL`, value `http://x:8080/a=b`). Names cannot contain `:` or `=` (the first one
   terminates the name / key).
5. Quotes are literal — no stripping, ever.
6. Tilde expansion: if the value starts with `~`, it is expanded to an absolute path —
   but only when the caller requests it (`expandTilde: true`, the default). The Settings
   profile editor parses with `expandTilde: false` so a UI round-trip never rewrites the
   user's `~` paths in the file. Env resolution at PTY spawn uses the expanding parse.

Merge rules: repeated lines with the same profile name merge into one profile; on env-key
collision, the LATER line wins. Profiles are ordered by first appearance in the file
(this order drives the profile pickers).

Result shape:

```ts
interface Profile {
  name: string;
  env: Record<string, string>;
}
// parseProfiles(contents, expandTilde=true): Profile[]  (order = first appearance)
```

### 1.6 Writing profiles (`writeProfiles(profiles[])`)

Full-replacement write of the profile section, preserving everything else:

1. Read the existing file; DROP every line whose key is `profile`; keep all other lines
   verbatim. Strip trailing blank lines.
2. Serialize the given profiles: for each profile in ARRAY order, one
   `profile = <name>:<KEY>=<value>` line per env var, env keys sorted alphabetically
   within each profile.
   - A profile whose trimmed name is empty is skipped entirely.
   - Vars with an empty key are skipped.
   - Consequence: a profile needs at least one valid var to survive a round-trip (the
     Settings editor guarantees this by always serializing a `NEX_PROFILE=<name>` marker
     var — see section 9.5).
3. If any profile lines were produced: append one blank separator line (only when the
   preserved section is non-empty), then the profile lines.
4. Ensure trailing newline; mkdir -p the parent; write atomically; errors swallowed.
   (If both the preserved section and profile lines are empty, the file is written empty.)

### 1.7 `remote-daemon` lines — multi-daemon groups

`remote-daemon = <name>:<url>` registers ANOTHER kelpi daemon this client may attach to.
The value splits at its FIRST `:` (the name — therefore colon-free); the remainder is the
URL verbatim, which is exactly the pairing URL the other daemon's Settings ▸ Remote hands
out (`https://host[:port]/?token=kd_…` — origin plus per-device credential in one string).
Merge rules are `profile`'s: repeated names, the LATER line wins; order is first
appearance. Writing is `writeRemoteDaemons` — `writeProfiles`' twin, full-replacement with
every unrelated line preserved — reached over the WS as `set-remote-daemons`
(`setProfiles`' twin; names must be non-blank and colon-free, URLs non-blank).

The registry rides the settings snapshot (`remoteDaemons`, additive — older daemons omit
it and the hydrator fills `[]`). The client builds one full runtime per entry — its own
connection, command RPC, PTY streams and store mirror (`app/remote-daemons.ts`) — and:

- the sidebar renders each remote daemon as a trailing section (name, connection dot, its
  workspaces; `RemoteDaemonSections` through the Sidebar's `trailingSections` slot);
- selecting a remote workspace swaps the workspace area to `RemoteWorkspaceView`: the same
  grid + terminal surfaces, fed by the REMOTE runtime, with focus/split/close/rename/zoom
  and divider drags routed to the remote daemon's commands. Content and web panes render
  an honest placeholder there (staged); while a remote workspace is showing, the LOCAL
  pane keymap stands down (`hasActiveWorkspace` answers false) so a ⌘D cannot split the
  hidden local workspace;
- the New Group sheet gains a "Runs on" picker (rendered only when the registry is
  non-empty, defaulting to "This Mac"): choosing a remote creates the group ON that daemon
  over its own connection — no local row exists;
- Settings ▸ Remote's "Daemons" card manages the registry (add by pasting a pairing URL,
  remove; rows elide the token). The credential lives in the config file only — never in
  localStorage — with the same same-UID trust the run dir has.

---

## 2. Data model summary (TS shapes)

```ts
// A physical key combination. Matching is by PHYSICAL KEY (macOS virtual keyCode),
// not by produced character — layout-independent in the current app.
interface KeyTrigger {
  keyCode: number;      // macOS virtual key code (see table, section 3.4)
  modifiers: ModSet;    // set of "super" | "shift" | "alt" | "ctrl"
}

type KelpiActionId = string;  // one of the 51 raw values in section 4, or "unbind"

// trigger -> action dictionary. One action per trigger; an action may own
// multiple triggers.
type KeyBindingMap = Map<KeyTriggerKey, KelpiActionId>;

interface ConfigHotkeyState {
  keybindings: KeyBindingMap;               // starts = defaults
  focusFollowsMouse: boolean;               // false
  focusFollowsMouseDelay: number;           // 100 (ms)
  tcpPort: number;                          // 0 = off
  tcpPortError: string | null;              // "Port N is unavailable"
  globalHotkey: KeyTrigger | null;
  globalHotkeyHideOnRepress: boolean;       // true
  globalHotkeyRegistrationError: string | null;
  // derived: collision of globalHotkey with an in-app binding (section 8.5)
  globalHotkeyConflictWithInApp: Conflict | null;
}
```

---

## 3. KeyTrigger: encoding, parsing, serialization

### 3.1 Normalization / matching

A trigger is `(keyCode, modifierSet)`. When constructing a trigger from a real key event,
and when matching an event against a trigger, the following modifier-like flags are
ALWAYS stripped and never distinguish triggers:

- `numericPad` and `function` — so arrow keys (which carry these flags on macOS) match
  cleanly against user-written triggers like `super+left`.
- `capsLock` — a binding must fire regardless of Caps Lock state (AppKit menu shortcuts
  ignore it; VNC servers synthesize uppercase by wrapping keypresses in CapsLock
  toggles).

Only `command`(super)/`shift`/`option`(alt)/`control` participate. Matching is EXACT set
equality of the remaining modifiers plus keyCode equality — `super+d` does not fire on
`super+shift+d`.

Hash/equality key: `(keyCode, modifierBits)`.

### 3.2 Parsing a trigger string (`KeyTrigger.parse`)

Input examples: `"super+shift+d"`, `"ctrl+alt+space"`, `"escape"`, `"super+="`.

Algorithm:

```
s = input.lowercased()
parts = s.split("+", dropping empty parts)     // "super+=" -> ["super", "="]
if parts empty -> null
keyName = parts.last
modifierNames = parts[0..last)
keyCode = keyNameToCode[keyName]  ?? return null
flags = {}
for m in modifierNames:
  flag = modifierNameToFlag[m]    ?? return null
  flags.insert(flag)
return { keyCode, flags }
```

Notes:
- Case-insensitive (whole string lowercased first).
- The literal `+` key is not representable (splitting on `+` consumes it), and `+` is not
  in the key table anyway.
- Zero-modifier triggers are legal from the config file (e.g. `keybind = escape=close_search`
  is the shipped default for Escape). The Settings recorder additionally REQUIRES a
  modifier except for Escape and F1–F12 (section 12.6), but the file format does not.

Modifier name aliases (all map into the 4-flag set):

| names | flag |
|---|---|
| `super`, `cmd`, `command` | command (⌘) |
| `ctrl`, `control` | control (⌃) |
| `alt`, `opt`, `option` | option (⌥) |
| `shift` | shift (⇧) |

### 3.3 Serialization

Two output formats:

**Config string** (`configString`) — what gets written to the file. Modifiers in the fixed
order `ctrl`, `alt`, `shift`, `super`, joined with `+`, then the key name:

- printable keys use their character (`d`, `1`, `[`, `=`, `-`, `;`, `'`, `` ` ``, `,`,
  `.`, `/`, `\`)
- named keys use: `return`, `tab`, `escape`, `delete`, `space`, `forward_delete`,
  `left`, `right`, `down`, `up`, `f1`…`f12`
- unknown keyCode serializes as `unknown` (will not re-parse; effectively lost on
  round-trip)

Example: ⌘⇧D → `shift+super+d`. ⌃⌥Space → `ctrl+alt+space`.

Note the asymmetry: the parser accepts many aliases (`cmd`, `command`, `opt`, `enter`,
`esc`, `backspace`, `one`…`zero`, `open_bracket`, `equals`, …) but the writer always
emits the canonical names above. Round-trip through the Settings UI therefore normalizes
alias spellings.

**Display string** (`displayString`) — for UI. macOS symbol order `⌃ ⌥ ⇧ ⌘` concatenated
(no separator), then the key: uppercased character, or display name (`Return`, `Tab`,
`Esc`, `Delete`, `Space`, `Fwd Del`, `←`, `→`, `↓`, `↑`, `F1`…`F12`), or `?` for unknown.
Example: `⌘⇧D`, `⌃⌥Space` renders as `⌃⌥Space`.

### 3.4 Complete key-name → macOS keyCode table

(These are the ANSI-layout macOS virtual key codes; parsing accepts every name below.)

Letters: `a`=0 `b`=11 `c`=8 `d`=2 `e`=14 `f`=3 `g`=5 `h`=4 `i`=34 `j`=38 `k`=40 `l`=37
`m`=46 `n`=45 `o`=31 `p`=35 `q`=12 `r`=15 `s`=1 `t`=17 `u`=32 `v`=9 `w`=13 `x`=7 `y`=16
`z`=6

Digits (both spellings): `1`/`one`=18 `2`/`two`=19 `3`/`three`=20 `4`/`four`=21
`5`/`five`=23 `6`/`six`=22 `7`/`seven`=26 `8`/`eight`=28 `9`/`nine`=25 `0`/`zero`=29

Special: `return`/`enter`=36 `tab`=48 `escape`/`esc`=53 `space`=49
`delete`/`backspace`=51 `forward_delete`=117

Arrows: `left`=123 `right`=124 `down`=125 `up`=126

Punctuation: `[`/`open_bracket`=33 `]`/`close_bracket`=30 `semicolon`=41 `quote`=39
`backquote`/`grave`=50 `comma`=43 `period`=47 `slash`=44 `backslash`=42
`-`/`minus`=27 `=`/`equal`/`equals`=24

Function keys: `f1`=122 `f2`=120 `f3`=99 `f4`=118 `f5`=96 `f6`=97 `f7`=98 `f8`=100
`f9`=101 `f10`=109 `f11`=103 `f12`=111

Reverse (keyCode → printable char, used by both serializers): the exact inverse of the
letters/digits/punctuation rows above (e.g. 41→`;` 39→`'` 50→`` ` `` 43→`,` 47→`.`
44→`/` 42→`\`).

### 3.5 Platform semantics: `super` is the primary chord modifier

`super` names the platform's PRIMARY chord modifier, not a physical key: ⌘ on macOS,
**Ctrl on Windows and Linux**. The shell's Electron accelerators have always applied this
rule (`acceleratorForTrigger` spells `super` as `CommandOrControl`); the client's DOM
matcher applies the same rule by **canonicalization**
(`canonicalTriggerForPlatform` / `canonicalKeyBindingsForPlatform`):

- On a mac-like platform the map is untouched.
- On a Ctrl-primary platform (`macLikePlatform` answers false for `Win*`, `Linux*`, and
  the BSDs; the empty/unknown strings a test DOM reports stay mac), every trigger's
  `super` is rewritten to `ctrl` (deduped, `MODIFIER_ORDER`ed) before the map is keyed.
  `super+d=split_right` therefore fires on Ctrl+D there, one config file works on every
  platform, and the physical Super/Win key — which the OS largely owns — matches nothing.
- When canonicalization makes two triggers identical (both `super+x` and `ctrl+x`
  bound), the LAST one in map order wins. Overrides are applied after defaults, so a
  user's explicit `ctrl+x` line beats a shipped `super+x` default deterministically.

Display follows the platform too (`keyTriggerDisplayStringForPlatform`): the §3.3 glyph
form (`⇧⌘D`) on macOS, `+`-joined text names (`Ctrl+Shift+D`, `MODIFIER_TEXT_NAMES`, in
`MODIFIER_DISPLAY_ORDER`) elsewhere. The config-file serialization (§3.3 `configString`)
is platform-independent and always spells what the user wrote.

---

## 4. KelpiAction: the complete action list

51 bindable actions + the pseudo-action `unbind` (config-file only; removes a default
trigger, never appears in UI lists).

Legend:
- **Layer** — which dispatch layer executes it: `menu` = menu-bar layer (section 7.1),
  `monitor` = pane-shortcut monitor (section 7.2).
- **Condition** — extra runtime condition in the monitor before the action fires; when the
  condition fails the keystroke is NOT consumed and falls through (usually to the
  terminal).
- Actions listed with default `—` ship UNBOUND (13 of them): `open_diff`,
  `toggle_sync_input`, and all 11 `web_*` per-pane actions.

### Category "Pane Management" (visible in Settings)

| raw value | display name | default | layer | condition / effect |
|---|---|---|---|---|
| `split_right` | Split Right | ⌘D | monitor | split focused pane horizontally |
| `split_down` | Split Down | ⌘⇧D | monitor | split focused pane vertically |
| `close_pane` | Close Pane | ⌘W | monitor | needs a focused pane. If it's the LAST pane in the workspace: runs the workspace-delete gate (confirmation dialog when the workspace has active agents and the "confirm delete" setting is on) and deletes the whole workspace; consume either way. Otherwise closes the focused pane |
| `reopen_closed_pane` | Reopen Closed Pane | ⌘⇧T | monitor | unconditional |
| `toggle_zoom` | Toggle Zoom | ⌘⇧Return | monitor | unconditional |
| `cycle_layout` | Cycle Layout | ⌘⇧Space | monitor | unconditional |
| `move_pane_left` | Move Pane Left | ⌃⇧← | monitor | unconditional |
| `move_pane_right` | Move Pane Right | ⌃⇧→ | monitor | unconditional |
| `move_pane_up` | Move Pane Up | ⌃⇧↑ | monitor | unconditional |
| `move_pane_down` | Move Pane Down | ⌃⇧↓ | monitor | unconditional |
| `create_scratchpad` | New Scratchpad | ⌘⇧N | monitor | unconditional |
| `toggle_sync_input` | Toggle Synchronise Input | — | monitor | toggles workspace-wide input sync |
| `open_web_pane` | Open Web Pane | ⌘⇧O | menu | opens a fresh web pane with a blank URL, URL bar focused |

### Category "Navigation" (visible)

| raw value | display name | default | layer | condition |
|---|---|---|---|---|
| `focus_next_pane` | Focus Next Pane | ⌘] and ⌘⌥→ | monitor | unconditional |
| `focus_previous_pane` | Focus Previous Pane | ⌘[ and ⌘⌥← | monitor | unconditional |
| `command_palette` | Command Palette | ⌘P | menu | toggles the palette |

### Category "Workspaces" (visible)

| raw value | display name | default | layer |
|---|---|---|---|
| `new_workspace` | New Workspace | ⌘N | menu |
| `next_workspace` | Next Workspace | ⌘⌥↓ | monitor |
| `previous_workspace` | Previous Workspace | ⌘⌥↑ | monitor |
| `rename_workspace` | Rename Workspace | ⌘⇧R | monitor (begins inline rename of active workspace) |
| `new_group` | New Group | ⌘⇧G | menu (creates group with unique placeholder name "New Group"/"New Group 2"/… and enters inline rename) |
| `switch_to_workspace_1`…`switch_to_workspace_9` | Switch to Workspace N | ⌘1…⌘9 | menu (switches by sidebar index 0–8) |

### Category "View" (visible)

| raw value | display name | default | layer |
|---|---|---|---|
| `toggle_sidebar` | Toggle Sidebar | ⌘⇧S | menu |
| `toggle_inspector` | Toggle Inspector | ⌘I | menu |

### Category "Files" (visible)

| raw value | display name | default | layer | condition |
|---|---|---|---|---|
| `open_file` | Preview Markdown | ⌘O | menu | opens file picker filtered to markdown |
| `toggle_markdown_edit` | Toggle Markdown Edit | ⌘E | monitor | only when focused pane is a markdown pane; else falls through |
| `increase_markdown_font_size` | Increase Markdown Font Size | ⌘= | monitor | only when focused pane is markdown AND not in edit mode; else falls through |
| `decrease_markdown_font_size` | Decrease Markdown Font Size | ⌘- | monitor | same condition |
| `reset_markdown_font_size` | Reset Markdown Font Size | ⌘0 | monitor | same condition |
| `open_diff` | Open Diff | — | monitor | needs a focused pane; opens a diff pane for that pane's working directory |

### Category "Search" (visible)

| raw value | display name | default | layer | condition |
|---|---|---|---|---|
| `toggle_search` | Toggle Search | ⌘F | monitor | unconditional |
| `close_search` | Close Search | Escape (no modifiers) | monitor | only when a pane search is active in the workspace; else falls through (Escape reaches the terminal) |

### Category "Web Pane (active when web pane focused)" (HIDDEN from Settings)

These 11 ship unbound and are NOT rendered in the Settings keybindings table (the table
renders only the six categories above). They exist so a user can bind them in the config
file if they want, but the primary delivery mechanism for web-pane shortcuts is the
hard-coded priority layer (section 7.3). Each is dispatched by the monitor ONLY when the
focused pane is a web pane; otherwise the trigger falls through to whatever else it means.

| raw value | display name | effect |
|---|---|---|
| `web_focus_url_bar` | Web: Focus URL Bar | focus the pane's URL bar |
| `web_back` | Web: Back | history back |
| `web_forward` | Web: Forward | history forward |
| `web_reload` | Web: Reload | reload (non-hard) |
| `web_tab_new` | Web: New Tab | new tab in the pane |
| `web_tab_close` | Web: Close Tab | close active tab; when the pane has only ONE tab this handler declines (falls through so the user's map can route the key to `close_pane`) |
| `web_tab_prev` | Web: Previous Tab | cycle tab −1 |
| `web_tab_next` | Web: Next Tab | cycle tab +1 |
| `web_zoom_in` | Web: Zoom In | zoom +0.1 |
| `web_zoom_out` | Web: Zoom Out | zoom −0.1 |
| `web_zoom_reset` | Web: Reset Zoom | zoom → default |

### `unbind`

Raw value `unbind`. Not bindable, not listed. Only meaningful as the ACTION side of a
`keybind` line: it deletes the trigger from the map (used to disable a default).

### Menu-bar action set

`isMenuBarAction == true` for exactly: `new_workspace`, `open_file`, `open_web_pane`,
`new_group`, `switch_to_workspace_1..9`, `toggle_sidebar`, `toggle_inspector`,
`command_palette` (16 actions). The monitor never consumes events for these — the menu
layer owns them (section 7).

---

## 5. KeyBindingMap semantics

### 5.1 Operations

```ts
action(trigger)          // lookup; null if unbound
triggers(action)         // ALL triggers bound to the action, sorted by configString
                         // (deterministic order across launches; the FIRST one is used
                         // for the menu shortcut)
setBinding(trigger, action)   // upsert; steals the trigger from any other action
removeBinding(trigger)
removeAllBindings(action)
applying(overrides: [trigger, action][])  // section 1.4 semantics
```

One trigger maps to at most one action. One action may own any number of triggers
(defaults give `focus_next_pane`/`focus_previous_pane` two each).

### 5.2 The default map (40 triggers)

Exactly the defaults listed in section 4's tables. (`super` here is the primary chord
modifier — ⌘ on macOS, Ctrl on Windows/Linux; §3.5.)

```
super+n=new_workspace                super+o=open_file
shift+super+o=open_web_pane          super+1..super+9=switch_to_workspace_1..9
shift+super+s=toggle_sidebar         super+i=toggle_inspector
super+d=split_right                  shift+super+d=split_down
super+w=close_pane
super+]=focus_next_pane              alt+super+right=focus_next_pane
super+[=focus_previous_pane          alt+super+left=focus_previous_pane
alt+super+down=next_workspace        alt+super+up=previous_workspace
shift+super+r=rename_workspace       super+e=toggle_markdown_edit
super+==increase_markdown_font_size  super+-=decrease_markdown_font_size
super+0=reset_markdown_font_size     shift+super+return=toggle_zoom
shift+super+t=reopen_closed_pane     super+f=toggle_search
escape=close_search                  shift+super+space=cycle_layout
super+p=command_palette              shift+super+n=create_scratchpad
shift+super+g=new_group
ctrl+shift+left=move_pane_left       ctrl+shift+right=move_pane_right
ctrl+shift+down=move_pane_down       ctrl+shift+up=move_pane_up
```

### 5.3 Writing keybinding overrides (`writeKeybindings(map)`)

The config file stores only the DIFF from defaults. Algorithm:

```
defaults = the hardcoded default map
preserved = all lines of the existing file EXCEPT lines starting with "keybind" that
            contain "=", trailing blanks stripped
lines = []

// pass 1: for every bindable action A:
//   (a) triggers now bound to A that don't map to A in defaults
for A in bindableActions:
  for t in map.triggers(A):
    if defaults.action(t) != A:
      lines += "keybind = {t.configString}={A.rawValue}"
//   (b) default triggers of A that are no longer bound to anything
  for t in defaults.triggers(A):
    if map.action(t) == null:
      lines += "keybind = {t.configString}=unbind"

// pass 2: default triggers REBOUND to a different action — normally already
// emitted by pass 1(a) for the new action; dedup by trigger configString.
written = set of trigger strings already in `lines`
for A in bindableActions:
  for t in defaults.triggers(A):
    newA = map.action(t)
    if newA != null and newA != A and t.configString not in written:
      lines += "keybind = {t.configString}={newA.rawValue}"

if lines empty and preserved empty: DELETE the file; return
output = preserved (+ one blank separator if both non-empty) + lines + trailing newline
mkdir -p; write atomically; errors swallowed
```

Consequences worth preserving:
- Resetting everything to defaults writes a file with zero `keybind` lines (all prior
  keybind lines dropped, everything else kept), or deletes the file entirely if nothing
  else is in it.
- Hand-written alias spellings (`cmd+d=...`) are rewritten in canonical form on the next
  Settings-driven write.
- A default trigger rebound to another action appears once as `trigger=newAction`
  (no separate `unbind` line needed — applying that override replaces the mapping).

### 5.4 Mutation actions (Settings UI → state + file)

Each of these updates in-memory state immediately, then rewrites the keybind section of
the config file with the full diff algorithm above:

- `setKeybinding(trigger, action)` — upsert (steals the trigger if another action had it;
  the recorder UI prevents this by rejecting conflicts first, but the state op itself
  would steal).
- `removeKeybinding(trigger)` — the little "x" next to a chip in Settings.
- `resetBindingsForAction(action)` — removes all the action's current triggers, then
  re-adds its default triggers. NOTE: this can steal a default trigger back from another
  action the user had rebound it to.
- `resetKeybindings` — whole map back to defaults.

---

## 6. Startup / bootstrap sequence

At app launch (single pass, no watcher):

1. `KeybindingService.loadFromDisk()` → binding map into state
   (`keybindingsLoaded`).
2. `ConfigParser.parseGeneralSettings(file)` → `configLoaded` with all six general
   settings. This:
   - copies focus-follows-mouse/delay, tcp-port, global hotkey + hide-on-repress into
     config state (and clears any stale registration error);
   - if `theme` names a known built-in terminal theme, applies it as if the user picked
     it in Settings (section 11);
   - attempts global-hotkey registration; on failure records
     `globalHotkeyRegistrationError` but KEEPS the configured value in state so the user
     can see and fix it in Settings.
3. TCP listener start is driven separately by the socket-server lifecycle reading
   `tcpPort` from this state.

Because steps run concurrently, the binding map and the global hotkey may land in state
in either order — this is why the "global hotkey shadows an in-app binding" warning is a
DERIVED/computed value, not set at load time (section 8.5).

---

## 7. The two dispatch layers

Every keystroke in the main window is seen by both layers; the division of labor:

- **Layer 1 — menu bar**: OS-level menu items whose keyboard shortcuts are DERIVED from
  the binding map. Owns the 16 `isMenuBarAction` actions. Because the shortcut lives on
  the menu item, the OS dispatches it; the monitor explicitly refuses to consume these
  triggers.
- **Layer 2 — pane-shortcut monitor**: an app-local key-down interceptor that runs BEFORE
  normal key handling, used for everything that needs focused-pane context. Returning
  "consumed" swallows the event (the terminal never sees it); "not consumed" lets the
  event continue (to the menu system, the focused text field, or the terminal PTY).

### 7.1 Menu bar layer

Menus and their items (shortcut = FIRST trigger of the action, in configString sort
order; if the trigger's key can't be represented as a menu key-equivalent — F-keys and
`forward_delete` cannot — the item simply has no displayed shortcut and the binding is
dead unless the monitor also handled it, which for menu actions it does not):

- **File-ish group (replaces "New")**: New Workspace, New Group, Preview Markdown…,
  New Web Pane, Command Palette, divider, Switch to Workspace 1–9, divider,
  Select All Workspaces (no binding), Deselect All Workspaces (disabled when no
  multi-selection).
- **View group**: Toggle Sidebar, Toggle Inspector.
- **Help**: "Kelpi Help" hard-bound ⌘? (not part of the binding map).
- App menu: "Check for Updates" (Sparkle, unbound).
- DEBUG builds only: Debug ▸ Seed Test Group.

Behavior details:
- "New Group" creates immediately with a unique placeholder name (`New Group`,
  `New Group 2`, …) and drops into inline rename.
- "New Web Pane" opens a fresh web pane with empty URL and the URL bar focused.
- Menu shortcuts update live when bindings change (they read the current map).

### 7.2 Pane-shortcut monitor pipeline

Pseudocode of the key-down handler (return `true` = consume):

```
handleKeyDown(event):
  // 0. Secondary windows own their keys.
  if a secondary window (Settings, Help) is key -> return false
     // "is secondary" = the key window is not the registered primary main window;
     // before the primary is registered, fall back to: key window != first visible
     // non-panel window.

  // 1. Command palette open: let typing through untouched.
  if commandPaletteVisible -> return false

  // 2. Escape clears an active workspace multi-selection (before any binding).
  if event.keyCode == 53 (Escape) and workspaceMultiSelection is non-empty:
     clearSelection; return true

  // 3. Need an active workspace for anything pane-related.
  if activeWorkspaceID == null -> return false

  trigger = KeyTrigger(event)   // normalized per section 3.1

  // 4. Global hotkey shadowing guard: if the trigger equals the configured global
  //    hotkey, never dispatch the in-app binding (the OS normally consumes it first
  //    anyway; this keeps behavior consistent if it doesn't).
  if trigger == globalHotkey -> return false

  // 5. Web pane priority layer (section 7.3). Tri-state:
  //    consumed / deliberately-not-consumed / not-applicable.
  r = webPanePriority(trigger)
  if r != notApplicable -> return r

  // 6. Normal lookup.
  action = keybindings.action(trigger)
  if action == null -> return false
  if action.isMenuBarAction -> return false      // menu layer owns it

  // 7. Dispatch with per-action conditions (section 4 tables). Handlers return
  //    false (fall through) when their condition fails.
  return dispatch(action)
```

### 7.3 Web-pane priority layer (hard-coded)

Runs ONLY when the focused pane of the active workspace is a web pane. It consults a
hard-coded table BEFORE the user's binding map, so browser-style shortcuts work in web
panes while the same keys keep their global meaning in every other pane type. (This is
why the 11 `web_*` actions can ship unbound.)

`urlBarIsEditing` = the window's first responder is a text editor (the URL bar's field
editor) — i.e. the user is typing in the URL bar.

| keys | effect | notes |
|---|---|---|
| ⌘L | focus URL bar | |
| ⌘R | reload (non-hard) | |
| ⌘← | history back | if `urlBarIsEditing`, NOT handled → falls through so ⌘← moves the text cursor |
| ⌘→ | history forward | same URL-bar exception |
| ⌘T | new tab | |
| ⌘W | close active tab | ONLY when the pane has >1 tab; with a single tab it is not-applicable → falls to the normal map, where ⌘W = `close_pane` |
| ⌘⇧[ | previous tab | URL-bar exception applies |
| ⌘⇧] | next tab | URL-bar exception applies |
| ⌘= or ⌘⇧= | zoom in +0.1 | |
| ⌘- | zoom out −0.1 | |
| ⌘0 | reset zoom | |

Design decision (issue #229): back/forward are ⌘←/⌘→, NOT ⌘[/⌘], so ⌘[/⌘] keep meaning
focus-previous/next-pane even inside a web pane.

Modifier matching in this table: entries marked ⌘ require modifiers == exactly
`{command}`; ⌘⇧ rows require exactly `{command, shift}`; the ⌘= row also accepts
`{command, shift}` (so ⌘+ works on layouts where + is shift-=).

Everything not in the table is "not applicable" and proceeds to the normal binding map —
which itself can then hit a `web_*` action (each guarded on pane.type == web).

---

## 8. Global hotkey (system-wide)

A single app-wide hotkey that summons Kelpi from any application. Implemented with the OS
global-hotkey facility (Carbon `RegisterEventHotKey` — notably requires NO Accessibility
permission; the Settings UI advertises this).

### 8.1 Config keys

```
global-hotkey = ctrl+alt+space        # any trigger string; "none"/"unbind"/"" clears
global-hotkey-hide-on-repress = true  # default true
```

### 8.2 Press behavior (`toggleAppFrontmost`)

```
if hideOnRepress and app is currently the active (frontmost) application:
    hide the app          // toggle semantics
else:
    activate the app (stealing focus)
    de-miniaturize every miniaturized non-panel window
    // deliberately does NOT pick a specific window: normal window ordering
    // restores the most-recently-focused one
```

### 8.3 Registration lifecycle

- Registered at launch from the parsed config value, and re-registered whenever the user
  records/clears it in Settings.
- Registering `null` unregisters.
- **Staged swap**: the new trigger is registered FIRST; only after the OS accepts it is
  the previous registration dropped. If the OS rejects it (typically: another app already
  owns the combo), the old registration stays live and the call fails.
- Re-registering the identical trigger is a no-op.
- Error messages: `eventHotKeyExistsErr` → "This shortcut is already claimed by another
  app."; other failures → "Could not register hotkey (OSStatus N)." / "Could not install
  hotkey handler (OSStatus N)."

### 8.4 State transitions on set/failure

- `setGlobalHotkey(trigger)` (user records in Settings): optimistically set state, clear
  error, attempt registration.
  - Success → write `global-hotkey = <configString>` (or `none`) to the config file.
  - Failure → ROLL BACK state to the previous trigger, surface the error string; the
    config file is left untouched (the user's working hotkey is never silently dropped).
- Launch-path failure (`configLoaded` registration fails): state KEEPS the configured
  (failing) value, error is surfaced — so the user can see and edit the bad value in
  Settings.
- `setGlobalHotkeyHideOnRepress(bool)`: set state, write
  `global-hotkey-hide-on-repress = true|false`.

### 8.5 Conflicts with in-app bindings

Conflict check (shared helper):

```
check(trigger, map, globalHotkey, excluding?, ignoreGlobalHotkey?):
  if !ignoreGlobalHotkey and globalHotkey == trigger -> conflict "globalHotkey"
       // message: 'Already bound to the global hotkey'
  if map.action(trigger) exists and != excluding    -> conflict "action(A)"
       // message: 'Already bound to "<A.displayName>"'
  else null
```

- Recording an in-app binding: reject if it equals the global hotkey OR is owned by a
  DIFFERENT action (`excluding` = the action being recorded, so re-recording an action's
  own combo is a no-op, not a self-collision).
- Recording the global hotkey: `ignoreGlobalHotkey = true` (re-recording the same global
  combo is fine), reject if any in-app action owns it.
- A conflict can still ARISE (e.g. hand-edited config): the derived
  `globalHotkeyConflictWithInApp` re-computes on every state change and Settings shows a
  warning: *"Shadows in-app shortcut: Already bound to "X". The in-app shortcut will not
  fire while Kelpi is frontmost."* Runtime behavior matches: the monitor skips in-app
  dispatch for the global-hotkey trigger (section 7.2 step 4).

---

## 9. Workspace profiles

Named environment-variable sets defined in the config file and assigned per workspace.
Flagship use case: multi-account Claude Code — one workspace per `CLAUDE_CONFIG_DIR`.

### 9.1 Model & resolution

```ts
interface WorkspaceProfilesAPI {
  // env dict for a workspace assigned profile `name`
  resolveEnv(name: string): Record<string, string>;
  // profile names in config-file first-appearance order (drives pickers)
  listProfiles(): string[];
}
```

`resolveEnv(name)`:

```
profiles = parseProfiles(configFile, expandTilde = true)   // fresh read, every call
env = profiles.find(p => p.name == name)?.env ?? {}
if env empty and name != "default": log warning (undefined profile)
env["NEX_PROFILE"] = name    // merged LAST: a config line spoofing NEX_PROFILE loses
return env
```

The config file is re-read and re-parsed on EVERY call — no watcher, no cache. This is
deliberate: newly spawned panes always see fresh definitions; live PTYs are unaffected
because env is injected only at spawn.

### 9.2 The built-in `default` baseline

Profile name `"default"` is reserved and always exists:

- A workspace with NO explicit assignment (stored `profileName == null`) resolves the
  `default` profile at spawn. So every pane, always, gets `NEX_PROFILE` (= `default`
  unless assigned) plus any vars the user chose to define under `default`.
- `default` is "virtual" until the user gives it vars — it has no lines in the config
  file, resolves to just `{NEX_PROFILE: "default"}`, and the empty-env warning is
  suppressed for it.
- **normalizedAssignment(raw)** — applied to every user-supplied assignment (CLI
  `kelpi workspace profile`, `workspace create --profile`, socket, UI picker):

  ```
  trim(raw); if empty or == "default" -> null; else the trimmed name
  ```

  So `default`, `--clear`, empty string, and a fresh workspace are ONE stored state
  (null). Round-trip invariant: assigning "default" then listing shows no assignment.

### 9.3 Spawn-time injection (the ONLY injection point)

Environment is injected when a terminal surface/PTY is created, never later. Live PTYs
keep their birth env; profile edits and re-assignment affect only panes spawned
afterwards (the Settings UI states this verbatim).

Merged env order for a new PTY:

```
mergedEnvVars(paneID, path, profileEnv):
  result = [
    ("NEX_PANE_ID", paneID-uuid-string),
    ("PATH", helpersDir + ":" + inheritedPATH),
        // helpersDir = <app bundle>/Contents/Helpers, prepended so the `kelpi` CLI
        // shadows the `Kelpi` app binary on case-insensitive filesystems;
        // inheritedPATH = process PATH, fallback "/usr/local/bin:/usr/bin:/bin"
  ]
  for (k, v) in profileEnv sorted by key:       // deterministic order
    if k in {"NEX_PANE_ID", "PATH"}: skip       // reserved — built-ins always win
    result.append((k, v))
```

Reserved keys: `NEX_PANE_ID`, `PATH`. A profile line defining either is silently ignored.
(`NEX_PROFILE` is not in the reserved set, but `resolveEnv` overwrites it last, which has
the same effect: the marker is always canonical.)

Every spawn path must thread the profile env — reducer pane-creation effects, the socket
workspace/group create paths, the restart-restore path (`claude --resume` must land in a
PTY already on the right account), and any lazy view-driven surface creation fallback
that races the reducer effect. Profile resolution at each site is:

```
env = resolveEnv(workspace.profileName ?? "default")
```

### 9.4 Assignment surfaces

- Workspace inspector picker and workspace context menu: list = `["default"] + listProfiles()
  minus "default"`; displayed selection = `profileName ?? "default"`.
- CLI: `kelpi workspace profile <ws> (<name> | --clear)` (fire-and-forget wire command
  `workspace-profile`), `kelpi workspace create --profile <name>`.
- Persistence: `profileName` (nullable) is stored on the workspace record.

### 9.5 Settings ▸ Profiles editor behavior

Master–detail editor over the config file (the file is the source of truth — no app
state):

- **Load** (on tab appear): `parseProfiles(expandTilde: false)` so `~` values round-trip
  unmodified. The stored `NEX_PROFILE` var is filtered out of the editable rows (it's
  rendered as a locked, derived row instead). Vars display sorted by key. The `default`
  profile is pinned FIRST in the list — moved there if present in the file, synthesized
  (empty) if not.
- **Locked marker row**: every profile's var list is headed by a non-editable
  `NEX_PROFILE = <name>` row with a lock icon and tooltip "Injected automatically —
  always matches the profile name".
- **Name field**: characters `:` and `=` are stripped as typed (they'd break the line
  format). Renaming any profile TO the literal name `default` is refused (input
  rejected). The `default` profile's own name field is disabled, and it shows the caption
  "Built-in baseline — applies to every workspace without an explicit profile."
- **Var rows**: key field strips `=` as typed; value field placeholder notes "leading ~
  expands at spawn". Add Variable appends an empty row; minus button removes a row.
- **Add profile**: generates a unique name `profile-<n>` (n starts at count+1, bumped past
  collisions), zero vars, selects it.
- **Remove profile**: disabled for `default`; otherwise removes and selects the neighbor.
- **Write-through** (on EVERY edit, after initial load completes): serialize all editor
  profiles →
  - drop vars with blank keys (keys trimmed); duplicate keys → last wins;
  - the `default` profile is OMITTED from the file while it has no vars (it's
    re-synthesized on load — keeps the file free of a redundant marker-only line);
  - every other profile gets `NEX_PROFILE = <trimmed name>` added to its env so a
    name-only profile still has one line and survives the round-trip (resolveEnv
    overrides it with the canonical name at spawn regardless);
  - `writeProfiles` (section 1.6) rewrites the file's profile section.
- Footer: "Config: ~/.config/nex/config" + "Changes apply to panes opened afterwards —
  live panes keep the env they were born with."
- Empty state copy explains what a profile is and points at the workspace context
  menu/inspector for assignment.

---

## 10. Focus follows mouse

Config: `focus-follows-mouse` (bool, default false) + `focus-follows-mouse-delay`
(ms, default 100, clamp ≥0; Settings slider range 0–500 step 25).

Behavior (per pane, on mouse-enter/leave):

```
onHover(pane, hovering):
  if !focusFollowsMouse: return
  cancel any pending focus timer                 // for any pane
  if hovering and pane != focusedPane:
    if delay > 0: schedule focusPane(pane) after delay ms (cancellable)
    else:         focusPane(pane) immediately
```

Moving the mouse across several panes within the delay window focuses only the last one
(each new hover cancels the previous timer); leaving all panes before the delay elapses
focuses nothing.

Both values are editable in Settings ▸ General ▸ Panes (toggle + slider, slider only
visible while enabled) and write through to the config file immediately.

---

## 11. `theme` config key

`theme = <id>` selects a built-in TERMINAL theme by exact id match at launch. Known ids
(id → display name):

```
"Dracula", "Catppuccin Mocha", "Catppuccin Latte", "Catppuccin Macchiato",
"Catppuccin Frappe" (displayed "Catppuccin Frappé"), "Nord", "Gruvbox Dark",
"Gruvbox Light", "iTerm2 Solarized Dark" (displayed "Solarized Dark"),
"iTerm2 Solarized Light" (displayed "Solarized Light")
```

The ids are ghostty theme filenames. On match, the launch path applies the theme exactly
as if picked in Settings ▸ Appearance ▸ Terminal: it persists the choice to app settings
(UserDefaults, key survives independent of the config file) and rebuilds the terminal
config with an override (`theme = <id>` + `background-opacity`) so all surfaces
re-render. Unknown names are silently ignored. The app never writes `theme` back to
`~/.config/nex/config` — it is a read-only input from the file's perspective; subsequent
Settings changes persist elsewhere, so a `theme` line in the config effectively re-asserts
itself at every launch.

---

## 12. TCP port

`tcp-port = <port>` (1–65535) enables the localhost TCP transport for the CLI wire
protocol (dev containers / SSH tunnels; binds 127.0.0.1 only). 0/absent = disabled.

Settings ▸ General ▸ Network: an on/off toggle (turning on seeds port 19400) + port field
with an Apply button (shown when the field differs from the applied port).

`setTCPPort(port)` behavior: clamp to `0..65535`, clear error, stop the TCP listener,
then if port > 0 try to start it:
- start OK (or port == 0) → write `tcp-port = <port>` to the config file;
- start FAILED → set `tcpPortError = "Port <port> is unavailable"`, do NOT write the
  config file (state keeps the requested port; the listener is down).

---

## 13. Settings UI inventory (behavior level)

Settings window: 7 tabs, resizable, min 500×440.

1. **General**
   - *Worktrees*: base path text field (supports a `<repo>` placeholder — at the start of
     the path it resolves to the full repo path, elsewhere to the repo directory name).
   - *Repositories*: "Auto-detect from pane directories" toggle (auto-associate a repo
     with the workspace when a pane's cwd is inside it; auto-removed a few seconds after
     no pane remains; manual associations never auto-removed).
   - *Workspaces*: "Inherit group when creating a new workspace" toggle; "Expand group
     when a workspace is dropped into it" toggle; "New workspace placement" picker
     (Next to selection / End of list); "New group placement" picker (same options);
     "Confirm before deleting a workspace with active agents" toggle (the GUI delete
     gate; CLI `--force` bypasses regardless).
   - *Panes*: focus-follows-mouse toggle + delay slider (section 10).
   - *Quit*: "Confirm before quitting" toggle (⌘Q dialog listing running/waiting agents).
   - *Network*: TCP listener toggle + port (section 12).
   - Persistence: Worktrees/Repositories/Workspaces/Quit settings → UserDefaults via the
     settings domain; Panes/Network → the config file via this subsystem.
2. **Appearance** — chrome theming (all persisted to UserDefaults, NOT the config file):
   preset chrome-theme gallery; export/import as `.nextheme` file or copy/paste share
   code; light/dark/system chrome appearance; per-color chrome overrides (separate
   light/dark buckets, editing the currently-resolved scheme); agent status dot colors;
   sidebar color intensity + fill/stroke opacities; TERMINAL theme picker ("None
   (Custom)" + the 10 built-ins of section 11) with custom background color when no
   theme + background opacity slider; status-bar system stats (per-metric toggles,
   sparkline style/color/width).
3. **Repositories** — the repo registry (default branch, paths).
4. **Labels** — label presets (name + color) management; every label applied anywhere
   must exist here (gray default when CLI-created). With no presets, the placeholder sits
   at the vertical centre of the panel below the header row; the caption and the
   "Labels not defined here" adoption section settle at the foot of the tab, and the
   placeholder holds centre until that copy needs more than half of the free height,
   then gives way upward rather than overlapping. With presets the list reads top-down.
5. **Profiles** — the workspace-profile editor (section 9.5). Storeless: reads/writes the
   config file directly.
6. **Keybindings** — see 13.1.
7. **Web** — web-pane favourites: list with inline rename, delete, drag reorder; empty
   state points at the star button in a web pane's URL bar and sits at the vertical
   centre of the panel below the heading (the caption and the footer note settle at the
   foot of the tab). Deep-linkable from a web pane's "Manage favourites…" menu.

### 13.1 Keybindings tab

- **Global section**: global-hotkey row — recorded combo shown as a chip (`⌃⌥Space`
  style) with an "x" clear button, or "—" when unset; a Record button; "Press again to
  hide" toggle (bound to `global-hotkey-hide-on-repress`, disabled while no hotkey is
  set); an orange warning label when registration failed (the error string of
  section 8.3); an orange warning when the hotkey shadows an in-app binding
  (section 8.5).
- **Action table**: sections in fixed order `Pane Management, Navigation, Workspaces,
  View, Files, Search` (the web-pane category and `unbind` are excluded). Each row:
  display name; ALL bound trigger chips (configString-sorted), each with an "x" to
  remove that one trigger; a Record button; a Reset button enabled only when the
  action's trigger list differs from its default list.
- **Footer**: "Config: ~/.config/nex/config" + "Reset All to Defaults" button.

### 13.2 Recorder sheets

Two modal recorders; both capture the next key-down as a trigger:

- Acceptance rule: the combo must include ≥1 modifier, UNLESS the key is Escape or an
  F-key (F1–F12) — those are accepted bare.
- On capture, run the conflict check (section 8.5). Conflict → show the message in red
  ("Already bound to "X"" / "Already bound to the global hotkey") and stay open for
  another attempt. No conflict → commit and close.
- Action recorder: `excluding` = the action being recorded (re-recording its own combo is
  a silent no-op commit). Commit dispatches `setKeybinding`.
- Global recorder: `ignoreGlobalHotkey = true`. Commit dispatches `setGlobalHotkey` (which
  may still fail at OS registration → rollback + error label, section 8.4).
- Cancel button (also bound to Escape... via the standard cancel action) closes without
  change.

---

## 14. Invariants & edge cases checklist

- One trigger → one action; action → many triggers; menu shows only the FIRST
  (configString-sorted) trigger.
- Trigger matching is exact-modifier-set, physical-key based; capsLock/numpad/fn flags
  never matter.
- The config file stores only the diff from default bindings; "all defaults" = zero
  keybind lines; empty file gets deleted by the keybinding writer.
- Unknown config keys, unknown actions, unparseable triggers, malformed profile lines:
  warn (log) + skip, never fail the parse.
- `close_search` (Escape) falls through to the terminal when no search is active;
  workspace multi-selection intercepts Escape before everything else.
- Monitor never consumes menu-bar actions, never consumes while the command palette is
  open, never consumes in secondary windows, never consumes the global-hotkey trigger.
- Web priority layer beats the user's map only when a web pane is focused; URL-bar
  editing exempts ⌘←/⌘→/⌘⇧[/⌘⇧]; single-tab ⌘W falls to close_pane.
- Global hotkey registration is transactional (old registration survives a failed swap);
  Settings-set failures roll state back, launch failures keep the configured value +
  error.
- Profile assignment storage: null ⇔ "default" ⇔ cleared; `NEX_PROFILE` always injected,
  always canonical; `NEX_PANE_ID`/`PATH` unoverridable; injection is spawn-time only;
  definitions re-read from disk at every spawn.
- Profile write-through preserves every non-profile config line; keybinding write-through
  preserves every non-keybind line; general-setting writes preserve everything else
  line-for-line. The three writers are mutually safe on the shared file.

---

## Port notes

Things the TypeScript daemon/web port must get right or deliberately do differently:

1. **KeyCode encoding is macOS-specific.** `KeyTrigger.keyCode` uses macOS virtual key
   codes (physical, ANSI layout), which don't exist in the browser. The port needs a
   translation layer: config names (section 3.4) ↔ a platform-neutral key identity.
   Recommendation: keep the CONFIG-FILE names as the canonical identity (they already
   are stable strings) and map them to browser `KeyboardEvent.code` values
   (`"d"` → `KeyD`, `"left"` → `ArrowLeft`, `"["` → `BracketLeft`, `"="` → `Equal`, …),
   preserving physical-key matching. Preserve the alias table on parse and the canonical
   names on write so existing config files round-trip identically. Drop the numeric
   keyCodes entirely; they should not appear on the wire or in storage.
2. **Modifier naming**: `super` = ⌘ on macOS. In a web client on non-Mac hardware decide
   the mapping (`super`→Ctrl or →Meta) once and document it; the config format already
   has distinct `ctrl` and `super` names, so don't conflate them in storage.
3. **Ignored-flag semantics** must be re-created in the web client: ignore CapsLock,
   NumLock-style, and fn state when matching; compare the exact remaining modifier set.
4. **Two dispatch layers collapse into one** in a web UI (no OS menu bar). All 51 actions
   can go through a single keydown interceptor, but three behaviors of the split must
   survive: (a) shortcuts must not fire while a modal/palette/secondary surface has
   focus; (b) conditional actions must FALL THROUGH to the terminal when their condition
   fails (markdown-only keys, close_search with no search, web keys on non-web panes,
   single-tab web ⌘W → close_pane); (c) the web-pane hard-coded priority table runs
   before the user map, with the URL-bar-editing exemptions. If the Electron shell adds
   a native menu, derive its accelerators from the binding map like `KelpiCommands` does
   (first trigger per action) and keep the map as the single source of truth.
5. **Browser-reserved shortcuts**: ⌘W/⌘N/⌘T/⌘L etc. are meaningful to the browser chrome
   for the plain web client. The Electron shell can intercept them; a plain browser tab
   cannot always (⌘W especially). The defaults table should stay as-spec for the shell,
   with the web client documenting which defaults the browser steals.
6. **Config ownership moves to the daemon.** Parsing/writing `~/.config/nex/config`
   should live daemon-side (single writer). Keep the three surgical writers'
   preservation guarantees (sections 1.3, 1.6, 5.3) — users hand-edit this file, and the
   current writers never clobber unrelated lines or comments outside their own key
   family. Also keep: no watcher for keybinds (load at daemon start + explicit
   reload/edit API), fresh re-read of profiles at every PTY spawn.
7. **Keybindings become client-relevant state**: the daemon should expose the merged
   binding map (defaults + overrides) to clients over the WS protocol so web/Electron
   render and dispatch from the same map, and accept mutation ops equivalent to
   `setKeybinding` / `removeKeybinding` / `resetBindingsForAction` / `resetKeybindings`
   / the general-setting setters, each persisting with the same diff-vs-defaults file
   format so the file stays compatible with hand edits and with the old app.
8. **Global hotkey is host-OS functionality.** In the port it belongs to the Electron
   shell (`globalShortcut.register`), not the daemon or web client. Keep: staged-swap
   error handling (registration failure must not lose the previous working hotkey),
   rollback-on-set-failure vs keep-and-warn-on-launch-failure, the hide-on-repress
   toggle behavior (app frontmost+hideOnRepress → hide; else activate + de-minimize),
   and the shadowing guard (an in-app binding equal to the global hotkey never fires).
   The trigger still serializes as `global-hotkey = <configString>` in the shared file.
   Electron's accelerator strings need translation from the trigger encoding.
9. **Profiles: PTY env injection moves to the daemon.** The daemon owns PTY spawn, so it
   implements `mergedEnvVars`: `NEX_PANE_ID` first, `PATH` with the kelpi CLI's directory
   prepended (whatever location the port ships the CLI to), then sorted profile vars
   minus reserved keys, and `NEX_PROFILE` forced last. Tilde expansion of profile values
   happens at resolution time (daemon-side, against the daemon's `$HOME`). Preserve
   `normalizedAssignment` (null ⇔ "default") in the daemon's workspace state and in the
   `workspace-profile` / `workspace create --profile` wire handling — the CLI contract
   depends on it.
10. **The `theme` config key** currently maps to ghostty theme filenames and mutates
    ghostty's config. With ghostty-vt/ghostty-web rendering, port it as: match against
    the same 10 ids, apply the equivalent terminal palette. Keep it read-only-from-file
    and last-writer-wins with the UI-persisted theme choice at startup.
11. **Focus-follows-mouse and its delay** are client-side view behavior (hover timers per
    section 10) but the SETTING is stored in the shared config file — the daemon should
    serve it to clients with the rest of general settings.
12. **tcp-port** likely changes meaning in the port (the daemon IS a network server).
    Preserve the key for CLI back-compat but reinterpret per the new transport design;
    keep the failure behavior of not persisting a port that couldn't be bound.
13. **Settings UI parity**: the web Settings surface needs the recorder-sheet semantics
    (capture-next-chord, modifier requirement except Escape/F-keys, inline conflict
    message with retry), per-trigger remove chips, per-action reset (enabled only when
    differing from default), reset-all, and the profiles master-detail editor with the
    locked NEX_PROFILE row, `:`/`=` input stripping, reserved `default` name, and
    write-through-on-every-edit against the config file.
14. **Count sanity for tests**: 52 enum cases total; 51 bindable (excludes `unbind`);
    13 ship unbound (`open_diff`, `toggle_sync_input`, 11 `web_*`); the default map has
    exactly 40 trigger entries (38 distinct actions bound; focus next/prev own two
    triggers each). The Settings table shows 40 actions (51 minus the 11 hidden web
    actions).
