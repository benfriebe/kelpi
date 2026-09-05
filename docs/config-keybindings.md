# Config & Keybindings Subsystem — Behavioral Specification

Implementation this spec describes (TypeScript, current Kelpi):
- `packages/core/src/config/lines.ts`, `general.ts`, `keys.ts`, `actions.ts`, `bindings.ts`,
  `keybinds.ts`, `profiles.ts`, `write.ts`, `chrome.ts`, `themes.ts` (parsers, writers, the
  binding model)
- `packages/core/src/env/merged-env.ts` (profile env resolution and the spawn-time merge)
- `packages/daemon/src/boot/config.ts` + `packages/daemon/src/settings/service.ts` (the daemon
  as config owner: file location, reads, the watcher, write-through, the settings snapshot)
- `packages/shell/src/hotkey.ts` + `packages/shell/src/main.ts` (system-wide global hotkey)
- `packages/shell/src/menu.ts` (the native menu bar)
- `packages/client/src/chrome/keys.ts` (the client's keydown interceptor)
- `packages/client/src/settings/*` (Settings UI surface)
- `packages/daemon/src/handlers/pane/support.ts` + `packages/daemon/src/boot/resume.ts` (env
  injection at PTY spawn)

This document specifies: the `~/.config/kelpi/config` file format and its parser/writer, the
keybinding data model (triggers, actions, the binding map, defaults), keyboard dispatch and
its conditional rules, the system-wide global hotkey, workspace profiles (named env-var sets
injected into PTYs), and the Settings UI that edits all of it.

---

## 1. The config file: `~/.config/kelpi/config`

A single plain-text file, Ghostty-style `key = value` syntax. It is the ONLY Kelpi config
file; the terminal's own appearance keys (`theme`, `background`, `font-*`, …) live in
ghostty's `~/.config/ghostty/config` (see section 13), but this file is the canonical store
for:

- general settings: `focus-follows-mouse`, `focus-follows-mouse-delay`, `theme`,
  `tcp-port`, `global-hotkey`, `global-hotkey-hide-on-repress`, plus the additive keys of
  section 1.2
- keybinding overrides: `keybind = <trigger>=<action>`
- workspace profiles: `profile = <name>:<KEY>=<value>`
- remote daemons: `remote-daemon = <name>:<url>` (section 1.7)

Path resolution: literally `~/.config/kelpi/config` with `~` expanded to `$HOME`
(`packages/daemon/src/boot/config.ts:41-50`). It is NOT XDG-aware beyond that (no
`$XDG_CONFIG_HOME` lookup). `KELPID_CONFIG_PATH` overrides the location for the daemon and
the shell alike (tilde-expanded, then resolved; `packages/shell/src/hotkey.ts:38-50`). It is
a dev/test affordance so a dev daemon or a test never reads the developer's real config. The
pre-rename `~/.config/nex/config` is read by the shell's hotkey loader only until the kelpi
file exists, and is copied (never over an existing file) by `kelpid import`
(`packages/daemon/src/main.ts:895-911`); the daemon itself never reads it. Two sibling
overrides cover the other files the settings service touches: `KELPID_GHOSTTY_CONFIG` names
the ghostty config (`packages/daemon/src/settings/service.ts:75-76`) and
`KELPID_GHOSTTY_THEME_DIRS` replaces the theme search path (section 11).

### 1.1 Line syntax (shared by all parsers)

Every parser walks the file line-by-line (`split on newline`, `parseConfigLines` in
`packages/core/src/config/lines.ts`), and for each line:

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

Additive keys (`parseGeneralSettings`, `packages/core/src/config/general.ts:19-135` and
`packages/core/src/config/general.ts:188-221`; `parseChromeSettings`,
`packages/core/src/config/chrome.ts`). These have no pre-port equivalent in the file: the
pre-port app kept them in macOS UserDefaults, which a multi-client daemon has no equivalent
of, so they live in this file so every attached client agrees. Every one of them is writable
through `set-general-setting` (section 1.3; `WS_WRITABLE_GENERAL_KEYS`,
`packages/protocol/src/ws/settings.ts:461-510`):

| key | rule |
|---|---|
| `confirm-workspace-delete` | default true; only the literal `false` (lowercased) disables. The GUI workspace-delete gate (section 4, `close_pane`) |
| `confirm-quit-when-active` | default true; only `false` disables. The ⌘Q dialog; both the dialog's "Don't ask again" and Settings write it |
| `auto-detect-repos` | default true; only `false` disables |
| `inherit-group-on-new-workspace` | default true; only `false` disables |
| `expand-group-on-workspace-drop` | default true; only `false` disables |
| `clipboard-write` | default false; only the literal `true` enables (the OSC 52 write gate; there is no `clipboard-read` twin, reads are refused outright) |
| `worktree-base-path` | stored verbatim, case preserved; a blank value means the shipped default `~/kelpi/worktrees/<repo>` rather than the filesystem root |
| `new-workspace-placement`, `new-group-placement` | `end-of-list` (default) or `near-selection` (lowercased); anything else ignored |
| chrome and status-bar family | `chrome-appearance`, `chrome-colors`, `sidebar-color-intensity`, `sidebar-avatar-fill`, `sidebar-avatar-stroke`, `sidebar-group-fill`, `sidebar-group-stroke`, `show-system-stats`, `system-stats`, `show-system-stat-graphs`, `sparkline-style`, `sparkline-color`, `sparkline-width`, `search-match-color`, `search-match-text-color`, `search-match-current-color`, `search-match-current-text-color` (parse rules and defaults in `packages/core/src/config/chrome.ts`; shell-ui.md §2, §8.1) |

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

Used when the user changes a general setting in the Settings UI (WS verb
`set-general-setting`, applied by the daemon's `SettingsService` with the writer in
`packages/core/src/config/write.ts:29`). Behavior:

1. Read the existing file (if any). For each line: if the line's key (text before its first
   `=`, trimmed) equals the target key, replace the entire line with `<key> = <value>`
   (canonical spacing); otherwise keep the line verbatim (comments, blanks, keybinds,
   profiles all preserved byte-for-byte).
   - Edge: if the key appears on multiple lines, EVERY one of those lines is replaced
     with the same new line (duplicates persist as duplicates).
2. If no line matched: strip trailing blank lines, then append `<key> = <value>`.
3. Ensure the output ends with a trailing newline.
4. Create the parent directory if needed; write atomically; re-read the file and broadcast
   the resulting snapshot (the daemon trusts the file, not what it just wrote). An IO
   failure is a `SettingsError` (`could not write …`) returned to the caller as an error
   reply, which the Settings UI surfaces; it is not swallowed
   (`packages/daemon/src/settings/service.ts:436-457`).

Settings written through this path (`WS_WRITABLE_GENERAL_KEYS`,
`packages/protocol/src/ws/settings.ts:461-510`): `focus-follows-mouse`,
`focus-follows-mouse-delay`, `tcp-port`, `global-hotkey` (value = trigger config string, or
`none` when cleared), `global-hotkey-hide-on-repress`, and every additive key of section 1.2.
Note `theme` is NEVER written to this file by Kelpi: the config `theme` key is a read-only
input (section 11); the terminal theme picked in Settings ▸ Appearance is written to
`~/.config/ghostty/config` instead (`set-ghostty-setting`).

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

Load-time behavior (daemon `SettingsService`, `packages/daemon/src/settings/service.ts`, at
daemon start and on every change):

```
if config file missing/unreadable -> defaults
overrides = parseKeybindings(file)
if overrides empty -> defaults
else -> defaults.applying(overrides)
```

The daemon WATCHES the file (`packages/daemon/src/settings/watch.ts`: `fs.watch` with a 60 ms
debounce, rename re-attach for editor saves, and a parent-directory watch while the file does
not yet exist) and re-reads it together with `~/.config/ghostty/config` on any change
(`packages/daemon/src/settings/service.ts:397-422`), broadcasting `settings-changed` only when
the resulting snapshot differs. Hand-edits to `keybind` lines therefore apply live in every
attached client; no restart is needed. Settings-UI edits write through the daemon to the file
and arrive back the same way; there is no in-memory map a hand-edit could contradict.

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
6. Tilde expansion: a value that is exactly `~` or starts with `~/` is expanded against the
   daemon's `$HOME` (`~user/…` is left verbatim; `expandLeadingTilde`,
   `packages/core/src/config/profiles.ts:25-31`), but only when the caller requests it
   (`expandTilde: true`, the default, together with a `home`; expansion is a no-op without
   one, and the daemon passes `os.homedir()` at boot and per spawn,
   `packages/daemon/src/boot/config.ts:86,100`). The settings snapshot the Settings profile
   editor reads carries the UNEXPANDED parse (`expandTilde: false`) so a UI round-trip never
   rewrites the user's `~` paths in the file. Env resolution at PTY spawn uses the expanding
   parse.

Merge rules: repeated lines with the same profile name merge into one profile; on env-key
collision, the LATER line wins. Profiles are ordered by first appearance in the file
(this order drives the profile pickers).

Result shape:

```ts
interface Profile {
  name: string;
  env: Record<string, string>;
}
// parseProfiles(contents, { expandTilde = true, home }): Profile[]  (order = first appearance)
```

### 1.6 Writing profiles (`writeProfiles(profiles[])`)

Full-replacement write of the profile section (`packages/core/src/config/write.ts:51`,
reached over the WS as `set-profiles`), preserving everything else:

1. Read the existing file; DROP every line whose key is `profile`; keep all other lines
   verbatim. Strip trailing blank lines.
2. Serialize the given profiles: for each profile in ARRAY order, one
   `profile = <name>:<KEY>=<value>` line per env var, env keys sorted alphabetically
   within each profile.
   - A profile whose trimmed name is empty is skipped entirely.
   - Vars with an empty key are skipped.
   - Consequence: a profile needs at least one valid var to survive a round-trip (the
     Settings editor guarantees this by always serializing a `KELPI_PROFILE=<name>` marker
     var — see section 9.5).
3. If any profile lines were produced: append one blank separator line (only when the
   preserved section is non-empty), then the profile lines.
4. Ensure trailing newline; mkdir -p the parent; write atomically; an IO failure is a
   `SettingsError` returned to the caller (section 1.3 step 4). (If both the preserved
   section and profile lines are empty, the file is written empty.)

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
// not by produced character — layout-independent. Clients map `KeyboardEvent.code`
// onto the same codes (`CODE_TO_KEY_CODE`, packages/client/src/chrome/keys.ts).
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

In Kelpi this state is split across processes rather than held in one reducer: the daemon's
settings snapshot (`WsSettingsSnapshot`, `packages/protocol/src/ws/settings.ts`) carries the
`keybind` lines and the general settings to every attached client and is rebuilt from the
file on every change (section 1.4); `globalHotkeyRegistrationError` is the `error` of the
shell's `hotkey-status` report (section 8.4); `tcpPortError` is derived client-side from
`welcome.transport.tcp` (section 12); and `globalHotkeyConflictWithInApp` is computed
client-side from the current map and hotkey (`inAppConflict`,
`packages/client/src/settings/GlobalHotkeySection.tsx`).

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
`super+shift+d`. In the client this falls out of `modifiersFromEvent`
(`packages/client/src/chrome/keys.ts`), which reads only `ctrlKey`/`altKey`/`shiftKey`/
`metaKey`; Caps Lock, Num Lock and fn state never enter the trigger, and a key whose
`KeyboardEvent.code` has no config-file name yields no trigger at all.

Hash/equality key: `(keyCode, modifierBits)`.

### 3.2 Parsing a trigger string (`KeyTrigger.parse`)

`parseKeyTrigger` in `packages/core/src/config/keys.ts`, shared by the daemon, the shell and
the client. Input examples: `"super+shift+d"`, `"ctrl+alt+space"`, `"escape"`, `"super+="`.

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
  modifier except for Escape and F1–F12 (section 13.2), but the file format does not.

Modifier name aliases (all map into the 4-flag set):

| names | flag |
|---|---|
| `super`, `cmd`, `command` | command (⌘) |
| `ctrl`, `control` | control (⌃) |
| `alt`, `opt`, `option` | option (⌥) |
| `shift` | shift (⇧) |

### 3.3 Serialization

Two output formats:

**Config string** (`configString`; `keyTriggerConfigString` and `KEY_CODE_TO_CONFIG_NAME`,
`packages/core/src/config/keys.ts:53-73`): what gets written to the file. Modifiers in the
fixed order `ctrl`, `alt`, `shift`, `super`, joined with `+`, then the key name:

- printable keys use their character (`d`, `1`, `[`, `=`, `-`, `;`, `'`, `` ` ``, `,`,
  `.`, `/`, `\`). Note that the last seven are written as characters the PARSER does not
  accept (it knows only `semicolon`, `quote`, `backquote`/`grave`, `comma`, `period`,
  `slash`, `backslash`; `KEY_NAME_TO_CODE`, `keys.ts:45-48`), so a binding on one of those
  keys does not survive a Settings-driven rewrite of the keybind section: `ctrl+semicolon`
  serializes as `ctrl+;`, which `parseKeyTrigger` rejects, and the line is dropped on the
  next write. Quirk preserved on purpose (Compatibility rationale, item 1).
- named keys use: `return`, `tab`, `escape`, `delete`, `space`, `forward_delete`,
  `left`, `right`, `down`, `up`, `f1`…`f12`
- unknown keyCode serializes as `unknown` (will not re-parse; effectively lost on
  round-trip)

Example: ⌘⇧D → `shift+super+d`. ⌃⌥Space → `ctrl+alt+space`.

Note the asymmetry: the parser accepts many aliases (`cmd`, `command`, `opt`, `enter`,
`esc`, `backspace`, `one`…`zero`, `open_bracket`, `equals`, …) but the writer always
emits the canonical names above. Round-trip through the Settings UI therefore normalizes
alias spellings.

**Display string** (`displayString`; `keyTriggerDisplayString`, `MODIFIER_DISPLAY_ORDER`,
`packages/core/src/config/keys.ts:84-119`): for UI. macOS symbol order `⌃ ⌥ ⇧ ⌘`
concatenated (no separator), then the key: uppercased character, or display name (`Return`,
`Tab`, `Esc`, `Delete`, `Space`, `Fwd Del`, `←`, `→`, `↓`, `↑`, `F1`…`F12`), or `?` for
unknown. Example: the chord ⌘⇧D renders as `⇧⌘D`; ⌃⌥Space renders as `⌃⌥Space`.

### 3.4 Complete key-name → macOS keyCode table

(These are the ANSI-layout macOS virtual key codes; parsing accepts every name below;
`KEY_NAME_TO_CODE` in `packages/core/src/config/keys.ts`. The client maps
`KeyboardEvent.code` onto the same codes, `CODE_TO_KEY_CODE` in
`packages/client/src/chrome/keys.ts`, so a trigger parsed from the file and one built from a
DOM event share one identity; the codes never appear on the wire or in storage, only the
names do.)

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
trigger, never appears in UI lists). `KELPI_ACTIONS` and `MENU_BAR_ACTIONS` in
`packages/core/src/config/actions.ts`; the handlers are the `keyActions` table in
`packages/client/src/App.tsx`.

Legend:
- **Layer**: `menu` = one of the 16 `MENU_BAR_ACTIONS` (section 7.1: carried by the shell's
  native menu, and the only actions the client dispatcher fires while a chrome text field has
  focus), `monitor` = dispatched only by the client's keydown interceptor (section 7.2).
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
| `web_tab_close` | Web: Close Tab | close active tab; with a single tab (or no tab yet) it closes the PANE itself rather than falling through (`packages/client/src/App.tsx:2772-2781`, the `closePane` fallback of §WEB-013). The hard-coded ⌘W of section 7.3 is the one that declines on a single tab |
| `web_tab_prev` | Web: Previous Tab | cycle tab −1 |
| `web_tab_next` | Web: Next Tab | cycle tab +1 |
| `web_zoom_in` | Web: Zoom In | zoom +0.1 |
| `web_zoom_out` | Web: Zoom Out | zoom −0.1 |
| `web_zoom_reset` | Web: Reset Zoom | zoom → default |

### `unbind`

Raw value `unbind`. Not bindable, not listed. Only meaningful as the ACTION side of a
`keybind` line: it deletes the trigger from the map (used to disable a default).

### Menu-bar action set

`MENU_BAR_ACTIONS` (`packages/core/src/config/actions.ts:84`) is exactly: `new_workspace`,
`open_file`, `open_web_pane`, `new_group`, `switch_to_workspace_1..9`, `toggle_sidebar`,
`toggle_inspector`, `command_palette` (16 actions). The shell's native menu carries their
chords; the client dispatcher fires them too (there is no separate OS layer in the client),
and they are the only actions that fire while a chrome text field has focus (section 7).

---

## 5. KeyBindingMap semantics

### 5.1 Operations

(`packages/core/src/config/bindings.ts`: `actionForTrigger`, `triggersForAction`,
`setBinding`, `removeBinding`, `removeAllBindings`, `applyKeybindOverrides`.)

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

`packages/core/src/config/write.ts:111`. The config file stores only the DIFF from
defaults. Algorithm:

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
mkdir -p; write atomically; an IO failure (write or delete) is a SettingsError
returned to the caller (section 1.3 step 4)
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

The daemon exposes two WS-only verbs (`packages/protocol/src/ws/settings.ts:422-448`;
`packages/daemon/src/settings/service.ts:119-129` and `:454-481`). Each resolves the map
from the file, applies the change, rewrites the keybind section with the full diff algorithm
above and replies with the re-read snapshot (which also reaches every other client as
`settings-changed`):

- `set-keybinding {action, trigger}`: upsert (steals the trigger from whatever held it; the
  recorder UI prevents this by rejecting conflicts first, but the op itself would steal).
  `trigger: null` removes ALL of the action's triggers (`removeAllBindings`). An unknown
  action or an unparseable trigger is a `SettingsError` reply.
- `reset-keybindings {action}`: `resetBindingsForAction`, removes all the action's current
  triggers, then re-adds its default triggers. NOTE: this can steal a default trigger back
  from another action the user had rebound it to. `action: null` → `resetKeybindings`, the
  whole map back to defaults.

There is no per-trigger remove verb. The little "×" next to a chip in Settings
(`removeTrigger`, `packages/client/src/settings/KeybindingsTab.tsx:437-450`) sends
`set-keybinding(action, null)` followed by one `set-keybinding` per remaining trigger, so the
file (and every client) passes through a momentary all-unbound state for that action: two or
more writes, one visible result, and the file ends with exactly the lines section 5.3 would
have produced.

---

## 6. Startup / bootstrap sequence

At daemon start (`packages/daemon/src/boot/compose.ts`):

1. `loadDaemonConfig()` (`packages/daemon/src/boot/config.ts`) reads the file once for boot:
   `parseGeneralSettings` picks the TCP listener port (`configuredTcpPort`; `KELPID_TCP_PORT`
   or an explicit option outranks the file) and `parseProfiles` (expanded) feeds the restore
   path's PTY spawns from a single per-launch read (section 9.3).
2. `createSettingsService` parses the file again into the settings snapshot (`keybind`
   lines, general settings, unexpanded profiles, remote daemons, and the terminal theme
   resolved per section 11) and attaches the watcher (section 1.4). The snapshot reaches
   every attached client and is re-broadcast as `settings-changed` after every change; the
   binding map is resolved client-side from the snapshot's `keybindLines`
   (`clientKeyBindings`, `packages/client/src/chrome/keys.ts`).
3. The Electron shell reads `global-hotkey` and `global-hotkey-hide-on-repress` from the
   same file (`readGlobalHotkeySettings`, `packages/shell/src/hotkey.ts:115`) and attempts
   registration (`registerGlobalHotkey('launch')`, `packages/shell/src/main.ts:681-713`); on
   failure it KEEPS the configured value and reports the error as `hotkey-status` so the
   user can see and fix it in Settings (section 8.4).
4. TCP listener start is driven separately by the control-server lifecycle from the port
   chosen in step 1 (section 12).

The binding map (daemon snapshot) and the global hotkey (shell report) reach a client
independently and in either order, this is why the "global hotkey shadows an in-app
binding" warning is a DERIVED/computed value, not set at load time (section 8.5).

---

## 7. The two dispatch layers

Every keystroke in the main window can be seen by two surfaces; the division of labor:

- **Layer 1, menu bar**: the Electron shell's native menu items
  (`packages/shell/src/menu.ts`), whose keyboard shortcuts are DERIVED from the binding map.
  Carries the 16 `MENU_BAR_ACTIONS`. A native accelerator outranks the page, so a real key
  press on one of these chords reaches the shell first; each row relays to the client
  (`menu-request` → daemon → `menu-command`), which answers through the same `act.*` entry
  point the keybinding and the on-screen button use. A browser tab has no such layer.
- **Layer 2, the client's keydown interceptor** (`createKeyDispatcher`,
  `packages/client/src/chrome/keys.ts`, installed on `window` by `App.tsx`): a key-down
  handler that runs BEFORE normal key handling, used for everything that needs
  focused-pane context. It dispatches the menu-bar actions as well (section 7.2), so both
  surfaces land on one handler. Returning "consumed" swallows the event (the terminal never
  sees it); "not consumed" lets the event continue (to the focused text field or the
  terminal PTY).

### 7.1 Menu bar layer

Menus and their items (`packages/shell/src/menu.ts`, assembled in
`packages/shell/src/main.ts`; shortcut = FIRST trigger of the action, in configString sort
order; if the trigger's key can't be represented as a menu key-equivalent — F-keys and
`forward_delete` cannot, the item simply has no displayed shortcut, and the binding still
fires through the client dispatcher, which handles menu-bar actions too, section 7.2):

- **File-ish group (replaces "New")**: New Workspace, New Group, Preview Markdown…,
  New Web Pane, Command Palette, divider, Switch to Workspace 1–9, divider,
  Select All Workspaces (no binding), Deselect All Workspaces (disabled when no
  multi-selection).
- **View group**: Toggle Sidebar, Toggle Inspector.
- **Help**: "Kelpi Help" hard-bound ⌘? (not part of the binding map); opens the client's
  Help overlay through the daemon.
- App menu: "Check for Updates…" (unbound).
- Unpackaged (dev) builds only (`app.isPackaged` is false): Debug ▸ Seed Test Group.

Behavior details:
- "New Group" creates immediately with a unique placeholder name (`New Group`,
  `New Group 2`, …) and drops into inline rename.
- "New Web Pane" opens a fresh web pane with empty URL and the URL bar focused.
- Menu shortcuts update live when bindings change (they read the current map).

### 7.2 Pane-shortcut monitor pipeline

Pseudocode of the key-down handler (return `true` = consume). Implementation:
`createKeyDispatcher` (`packages/client/src/chrome/keys.ts:320-367`), wired in
`packages/client/src/App.tsx:2879-2917`; the overlay gate and its close-chord exception are
`closeModalOverlay` (`App.tsx:2819-2870`):

```
handleKeyDown(event):
  // 0/1. Modal overlays own their keys. While the command palette, Settings, Help or the
  //      New Workspace sheet is open, return false for everything EXCEPT the chord the map
  //      resolves to `close_pane` (⌘W by default): that closes the palette or Help overlay,
  //      and is swallowed (consumed, not closed) over Settings and the create sheet, so the
  //      shell's File ▸ Close never falls back to closing the window. Settings keeps its
  //      Escape/close-button dismiss; the create sheet is owned by the sidebar.
  if a modal overlay is open:
     if trigger resolves to close_pane -> closeModalOverlay(); return true
     return false

  // 2. Escape clears an active workspace multi-selection (before any binding).
  if event.keyCode == 53 (Escape) and workspaceMultiSelection is non-empty:
     clearSelection; return true

  // 3. Need an active workspace for anything pane-related. A REMOTE workspace showing in
  //    the area counts as none (section 1.7), so a ⌘D cannot split the hidden local one.
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

  // 6. Normal lookup. There is ONE layer here: menu-bar actions dispatch through it too.
  //    While a CHROME text field (sidebar filter, inline rename, palette field) has focus
  //    only menu-bar actions fire; a pane's own surface (terminal host, scratchpad or
  //    markdown textarea) is not chrome text, so the full pane keymap stays live there.
  action = keybindings.action(trigger)
  if action == null -> return false
  if chromeTextFieldFocused and action not in MENU_BAR_ACTIONS -> return false

  // 7. Dispatch with per-action conditions (section 4 tables). Handlers return
  //    false (fall through) when their condition fails.
  return dispatch(action)
```

### 7.3 Web-pane priority layer (hard-coded)

Runs ONLY when the focused pane of the active workspace is a web pane. It consults a
hard-coded table BEFORE the user's binding map, so browser-style shortcuts work in web
panes while the same keys keep their global meaning in every other pane type. (This is
why the 11 `web_*` actions can ship unbound.)

`urlBarIsEditing` = a chrome text field has focus (the URL bar; `isChromeTextEditing` in
`packages/client/src/webpane/priority.ts`): i.e. the user is typing in the URL bar.

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

A single app-wide hotkey that summons Kelpi from any application. Implemented in the
Electron shell with the OS global-hotkey facility (`globalShortcut.register`,
`packages/shell/src/main.ts:646-713`; the pure half, config read and accelerator
translation, is `packages/shell/src/hotkey.ts`). It requires NO Accessibility permission,
and the Settings UI advertises this ("Works from any app. No Accessibility permission
required."). The trigger is translated to an Electron accelerator (`acceleratorForTrigger`,
`hotkey.ts:81`; `super` spells `CommandOrControl`).

### 8.1 Config keys

```
global-hotkey = ctrl+alt+space        # any trigger string; "none"/"unbind"/"" clears
global-hotkey-hide-on-repress = true  # default true
```

### 8.2 Press behavior (`toggleAppFrontmost`)

```
if hideOnRepress and any Kelpi window is focused:      // BrowserWindow.isFocused()
    hide the app          // toggle semantics: macOS app.hide(); the main window's hide() elsewhere
else:
    present the main window: build it if it was closed, restore it if minimized,
    show, focus, focus its web contents, then app.focus({steal: true}) on macOS
```

Kelpi has one main window, so there is no "pick a window" step (`toggleFrontmost`,
`packages/shell/src/main.ts:653-662`; `presentWindow`,
`packages/shell/src/window-present.ts:74-92`).

### 8.3 Registration lifecycle

- Registered at launch from the parsed config value, and re-registered on every
  `settings-changed` the daemon broadcasts (`packages/shell/src/main.ts:1276-1283`), so a
  value recorded or cleared in Settings, or hand-edited into the file, applies without a
  restart. `swapGlobalHotkey` short-circuits when the accelerator is unchanged, so an
  unrelated settings write never touches `globalShortcut`.
- Registering `null` unregisters.
- **Staged swap**: the new trigger is registered FIRST; only after the OS accepts it is
  the previous registration dropped. If the OS rejects it (typically: another app already
  owns the combo), the old registration stays live and the call fails.
- Re-registering the identical trigger is a no-op.
- Error messages (`swapGlobalHotkey`, `packages/shell/src/hotkey.ts:229-243`): OS rejection
  (`globalShortcut.register` answers false) → "This shortcut is already claimed by another
  app."; a thrown registration error → its own message; a trigger with no Electron
  accelerator spelling (an unmapped keyCode) → "“<configString>” cannot be registered as a
  system shortcut on this platform.", reported as a failure without a registration attempt
  (`hotkey.ts:181-186`, `main.ts:694-698`).

### 8.4 State transitions on set/failure

- Recording or clearing in Settings writes `global-hotkey = <configString>` (or `none`)
  through the daemon FIRST (`set-general-setting`,
  `packages/client/src/settings/GlobalHotkeySection.tsx:143-145`); the shell re-registers on
  the resulting `settings-changed` (staged swap, section 8.3) and reports the outcome to
  every client as `hotkey-status` (`accelerator`, `configString`, `ok`, `error`,
  `source: launch | settings`; `registerGlobalHotkey`, `packages/shell/src/main.ts:681-713`).
  On failure the previous accelerator stays registered (the user's working hotkey is never
  silently dropped) but the config file KEEPS the new, failing value and Settings shows the
  error: there is no rollback; the user edits or clears it.
- Launch-path failure behaves the same (value kept, error surfaced, so the user can see and
  edit the bad value in Settings). The launch report is remembered and replayed on every
  (re)connect of the shell's status socket (`main.ts:1206-1211`), so it is never lost to a
  socket that was not up yet.
- `global-hotkey-hide-on-repress` is written the same way (`set-general-setting`); the shell
  re-reads it on every `settings-changed`.

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
- A conflict can still ARISE (e.g. hand-edited config): the derived conflict
  (`inAppConflict`, `packages/client/src/settings/GlobalHotkeySection.tsx:99-111`)
  re-computes from the current map and hotkey on every render and Settings shows an amber
  advisory: *"This is also bound to “X” in the app. While Kelpi is frontmost the global
  hotkey wins and the in-app shortcut won't fire."* Runtime behavior matches: the client
  dispatcher skips in-app dispatch for the global-hotkey trigger (section 7.2 step 4).

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

`resolveEnv(name)` (`resolveProfileEnv`, `packages/core/src/env/merged-env.ts:57-65`, over
the daemon's `createProfileReader`, `packages/daemon/src/boot/config.ts:93-103`):

```
profiles = parseProfiles(configFile, expandTilde = true, home)   // fresh read, every spawn
env = profiles.find(p => p.name == name)?.env ?? {}
if env empty and name != "default": log warning (undefined profile)
env["KELPI_PROFILE"] = name    // merged LAST: a config line spoofing KELPI_PROFILE loses
return env
```

The config file is re-read and re-parsed at EVERY spawn, with no cache (the settings watcher of
section 1.4 plays no part in this path). This is deliberate: newly spawned panes always see
fresh definitions; live PTYs are unaffected because env is injected only at spawn. Boot
restore is the one exception: it resolves every restored pane from a single per-launch read
(section 9.3).

### 9.2 The built-in `default` baseline

Profile name `"default"` is reserved and always exists:

- A workspace with NO explicit assignment (stored `profileName == null`) resolves the
  `default` profile at spawn. So every pane, always, gets `KELPI_PROFILE` (= `default`
  unless assigned) plus any vars the user chose to define under `default`.
- `default` is "virtual" until the user gives it vars — it has no lines in the config
  file, resolves to just `{KELPI_PROFILE: "default"}`, and the empty-env warning is
  suppressed for it.
- **normalizedAssignment(raw)** (`packages/core/src/env/merged-env.ts:33-41`; applied by the
  `set-workspace-profile` reducer, `packages/daemon/src/store/reducers/workspaces.ts:346-350`):
  applied to every user-supplied assignment (CLI `kelpi workspace profile`,
  `workspace create --profile`, socket, UI picker):

  ```
  trim(raw); if empty or == "default" -> null; else the trimmed name
  ```

  So `default`, `--clear`, empty string, and a fresh workspace are ONE stored state
  (null). Round-trip invariant: assigning "default" then listing shows no assignment.

### 9.3 Spawn-time injection (the ONLY injection point)

Environment is injected when a terminal surface/PTY is created, never later. Live PTYs
keep their birth env; profile edits and re-assignment affect only panes spawned
afterwards (the Settings UI states this verbatim).

Merged env order for a new PTY (`mergedEnvVars`,
`packages/core/src/env/merged-env.ts:89-106`):

```
mergedEnvVars(paneID, path, socketRoute, profileEnv):
  result = [
    ("KELPI_PANE_ID", paneID-uuid-string),
    ("PATH", helpersDir + ":" + inheritedPATH),
        // helpersDir = the bundled-CLI directory the shell hands the daemon
        // (KELPID_HELPERS_DIR, packages/daemon/src/boot/compose.ts:909-918), prepended
        // so the `kelpi` CLI shadows the `Kelpi` app binary on case-insensitive
        // filesystems; when unset PATH is just inheritedPATH, never a leading ':'
        // (an empty PATH element means "the current directory" to every shell);
        // inheritedPATH = process PATH, fallback "/usr/local/bin:/usr/bin:/bin"
    ("KELPI_SOCKET", socketRoute),   // only when the control server has a tcp: route
                                     // (`tcp:127.0.0.1:<port>`), so the pane's `kelpi`
                                     // reaches the daemon that spawned it
  ]
  for (k, v) in profileEnv sorted by key:       // deterministic order
    if k in {"KELPI_PANE_ID", "KELPI_SOCKET", "PATH"}: skip   // reserved — built-ins always win
    result.append((k, v))
```

Reserved keys: `KELPI_PANE_ID`, `KELPI_SOCKET`, `PATH`. A profile line defining any of them
is silently ignored. (`KELPI_PROFILE` is not in the reserved set, but `resolveEnv` merges it
last, which has the same effect: the marker is always canonical.) No `NEX_*` variable is
injected: Kelpi and the pre-port app run side by side with no shared environment, and moving
data between the two is `kelpid import`'s job, not the environment's. The `kelpi` CLI reads
`KELPI_PANE_ID` and `KELPI_PROFILE` (`packages/cli/src/env.ts:35-37,62-65`).

Every spawn path threads the profile env: the pane-creation handlers (`spawnEnvVars`,
`packages/daemon/src/handlers/pane/support.ts:151-192`), the socket workspace/group create
paths, and the restart-restore path (`restoreEnvVars`,
`packages/daemon/src/boot/resume.ts:95-111`; `claude --resume` must land in a PTY already on
the right account). Profile resolution at each site is:

```
env = resolveEnv(normalizedAssignment(sessionProfileName ?? workspace.profileName) ?? "default")
```

`sessionProfileName` is the profile a recorded agent session was launched under (the
`KELPI_PROFILE` the hook observed beside the session id, stored on the resume tuple). It
overrides the workspace's CURRENT assignment for that one spawn, so a pane about to type a
resume command gets the environment the session actually knows rather than whatever the
workspace points at now. On restore it is honoured only for a tuple whose session id
produces a typed resume command (`resume.ts:128-137`); every other pane belongs to the
workspace's current assignment. A non-`default` name with no `profile` lines behind it is
logged as a warning (the marker is still injected; an empty `default` is never warned
about). Ordinary spawns re-read the file (section 9.1); boot restore instead resolves every
restored pane from a single per-launch read (`packages/daemon/src/boot/config.ts:9-14`).

### 9.4 Assignment surfaces

- Workspace inspector picker (`packages/client/src/chrome/Inspector.tsx:322-328,458-467`)
  and workspace context menu: list = `["default"] + listProfiles() minus "default"`, plus
  the workspace's assigned name when it is no longer in the config (so the picker never
  renders blank after a profile leaves the file); displayed selection =
  `profileName ?? "default"`. Choosing `default` sends null; the reducer stores
  `normalizedAssignment(profile)` (section 9.2).
- CLI: `kelpi workspace profile <ws> (<name> | --clear)` (fire-and-forget wire command
  `workspace-profile`), `kelpi workspace create --profile <name>`.
- Persistence: `profileName` (nullable) is stored on the workspace record.

### 9.5 Settings ▸ Profiles editor behavior

Master–detail editor over the config file (`packages/client/src/settings/ProfilesTab.tsx`,
rules in `packages/client/src/settings/model.ts`). The file is the source of truth in both
directions: drafts seed from the daemon snapshot's profiles, every commit sends the WHOLE
set through `set-profiles`, and the broadcast that follows re-seeds the drafts; nothing is
stored client-side:

- **Load**: the snapshot's UNEXPANDED parse (`expandTilde: false`, section 1.5) so `~`
  values round-trip unmodified. The stored `KELPI_PROFILE` var is filtered out of the
  editable rows (it's rendered as a locked, derived row instead). Vars display sorted by
  key. The `default` profile is pinned FIRST in the list, moved there if present in the
  file, synthesized (empty) if not.
- **Locked marker row**: every profile's var list is headed by a non-editable
  `KELPI_PROFILE = <name>` row with a lock icon and tooltip "Injected automatically, 
  always matches the profile name".
- **Name field**: characters `:` and `=` are stripped as typed (they'd break the line
  format). Renaming any profile TO the literal name `default` is refused (input
  rejected). The `default` profile's own name field is disabled, and it shows the caption
  "Built-in baseline — applies to every workspace without an explicit profile."
- **Var rows**: key field strips `=` as typed; value field placeholder notes "leading ~
  expands at spawn". Add Variable appends an empty row; minus button removes a row.
- **Add profile**: generates a unique name `profile-<n>` (n starts at count+1, bumped past
  collisions), zero vars, selects it.
- **Remove profile**: disabled for `default`; otherwise removes and selects the previous
  row (index − 1, which is `default` at the lowest).
- **Write-through** (on a field's blur or Enter, and on any add/remove of a profile or var,
  not per keystroke, so a rename does not produce one daemon write, one file write and one
  broadcast per character typed; `ProfilesTab.tsx:15-18`): serialize all editor profiles →
  - drop vars with blank keys (keys trimmed); duplicate keys → last wins;
  - the `default` profile is OMITTED from the file while it has no vars (it's
    re-synthesized on load — keeps the file free of a redundant marker-only line);
  - every other profile gets `KELPI_PROFILE = <trimmed name>` added to its env so a
    name-only profile still has one line and survives the round-trip (resolveEnv
    overrides it with the canonical name at spawn regardless);
  - `writeProfiles` (section 1.6) rewrites the file's profile section.
  A rename to a name another profile already has is refused at the field with
  "“X” already exists" (repeated `profile` lines with one name would silently merge), as
  is a rename to `default` ("“default” is the built-in baseline"; `profileNameError`,
  `model.ts:168-180`). Escape in a name field reverts the draft.
- **Deselect**: clicking the rail's empty space, or Escape while focus is in the rail with
  a selection, clears the selection and shows the "No profile selected" placeholder; with
  nothing selected Escape falls through and closes Settings (`ProfilesTab.tsx:160-176`).
- Footer: "Config: ~/.config/kelpi/config" + "Changes apply to panes opened afterwards, 
  live panes keep the env they were born with."
- Empty state copy explains what a profile is and points at the workspace context
  menu/inspector for assignment.

---

## 10. Focus follows mouse

Config: `focus-follows-mouse` (bool, default false) + `focus-follows-mouse-delay`
(ms, default 100, clamp ≥0; Settings slider range 0–500 step 25).

Behavior (per pane, on mouse-enter/leave; `packages/client/src/grid/PaneGrid.tsx`, read
off the daemon's settings snapshot):

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

Both values are editable in Settings ▸ Workspaces ▸ Panes (toggle + slider, slider only
visible while enabled; `packages/client/src/settings/WorkspacesTab.tsx`; Settings ▸ General
points there, section 13) and write through to the config file immediately.

---

## 11. `theme` config key

`theme = <id>` in the kelpi config is a FALLBACK that selects a built-in TERMINAL theme by
exact id match: a `theme` line in `~/.config/ghostty/config` wins whenever present
(`resolveTerminalTheme`, `packages/daemon/src/settings/service.ts:174-203`). Known ids
(id → display name; `BUILT_IN_TERMINAL_THEMES`, `packages/core/src/config/themes.ts:24-50`):

```
"Dracula", "Catppuccin Mocha", "Catppuccin Latte", "Catppuccin Macchiato",
"Catppuccin Frappe" (displayed "Catppuccin Frappé"), "Nord", "Gruvbox Dark",
"Gruvbox Light", "iTerm2 Solarized Dark" (displayed "Solarized Dark"),
"iTerm2 Solarized Light" (displayed "Solarized Light")
```

The ids are ghostty theme filenames. The kelpi value is honoured only when it names one of
the ten ids above (exact, case-sensitive: `dracula` and a typo select nothing, leaving the
terminal on whatever ghostty already resolved); ghostty's own `dark:X,light:Y` form is
reduced to one name by the config background's light/dark verdict (`selectThemeName`,
`packages/daemon/src/settings/theme.ts:114`). The daemon then resolves the name to a theme
FILE (`packages/daemon/src/settings/theme.ts:141-200`), searching in order: the `themes/`
dir beside the ghostty config it actually read, `$XDG_CONFIG_HOME/ghostty/themes`,
`~/.config/ghostty/themes`, `~/Library/Application Support/com.mitchellh.ghostty/themes`,
`$GHOSTTY_RESOURCES_DIR/themes`, the Ghostty.app bundles (per-user and `/Applications`) and
the two Unix share paths; `KELPID_GHOSTTY_THEME_DIRS` (colon-separated) replaces the whole
list. It parses only the keys the file defines (the six document colours plus
`palette = N=#hex`; `config-file` includes are not followed) and carries the result on the
settings snapshot as `appearance.terminalTheme` (`name`, `path`, `palette`, `error`;
`packages/protocol/src/ws/settings.ts:263-297`). It reaches every client live through
`settings-changed`; nothing is persisted elsewhere and no relaunch is involved, so a
hand-edit to either file repaints the terminal. A name that resolves to no file (or an
unreadable file, or one with nothing colour-shaped in it) leaves the terminal palette
unchanged and carries a reason string in `error`, which Settings ▸ Appearance renders. A
theme's `background` becomes the resolved terminal background only when the ghostty config
names no explicit `background` line. Kelpi never writes the kelpi `theme` key: it is a
read-only input from the file's perspective; the terminal-theme picker in Settings ▸
Appearance ▸ Terminal writes `theme` to the GHOSTTY config (`set-ghostty-setting`,
`packages/protocol/src/ws/settings.ts:517-534`), or removes the line for "None".

---

## 12. TCP port

`tcp-port = <port>` (1–65535) enables the localhost TCP transport for the CLI wire
protocol (dev containers / SSH tunnels; binds 127.0.0.1 only). 0/absent = disabled.

Settings ▸ General ▸ Network (`packages/client/src/settings/GeneralTab.tsx:202-255`): an
on/off toggle (turning on seeds port 19400; turning off writes `0`) + port field with an
Apply button (shown when the field differs from the applied port; blur/Enter commit too). A
non-numeric or out-of-range entry falls back to 19400 rather than writing a value the parser
would silently ignore.

Writing the key re-binds the listener live: `tcp-port` is the one general setting whose
effect is a listener, so the daemon's settings subscriber applies every change rather than
filing it away for the next start (`applyTcpPortSetting`,
`packages/daemon/src/boot/compose.ts:595`, `:723-761`). The re-bind is `stopTCP` then a fresh
bind on the control server that owns the configured port
(`packages/daemon/src/control/server.ts:427-451`); only the TCP listener moves, the Unix
socket and the connections it is serving stay up, which is what makes it safe under a
connected CLI. `tcp-port` is written regardless of whether the port can bind: a failed bind
is not an error, it lands on the listener status. The bind OUTCOME travels separately from
`settings-changed` (which carries what the FILE says), on `welcome.transport.tcp` at attach
and `transport-changed` after each re-bind (`requested`, `bound`, `host`, `error`;
`compose.ts:761`), and the row renders it (`tcpListenerDetail`, `GeneralTab.tsx:54-79`):
"Listening on 127.0.0.1:N", "Port N unavailable: …" (destructive tone; Unix-socket clients
are unaffected), "Disabled" when the file asks for nothing and nothing is bound, or "takes
effect on the next daemon start" only when the daemon reports no TCP listener at all
(`GeneralTab.tsx:78`). `KELPID_TCP_PORT` (or an explicit option) outranks the file for a dev
daemon, at boot and afterwards: a config write never tears down an env-requested listener
(`compose.ts:729`), so a listener can be up that the config file does not name; the row says
so rather than reporting "Disabled". When no compat server exists, the configured port shares
the run-dir server with the pane route, so disabling it re-binds an ephemeral port instead of
stranding the injected `KELPI_SOCKET` (`compose.ts:752-757`).

---

## 13. Settings UI inventory (behavior level)

Settings is an in-client modal overlay (`packages/client/src/settings/SettingsOverlay.tsx`:
Escape or a backdrop click closes it, Tab is trapped inside it, width
`clamp(560px, 92%, 880px)`, height `min(620px, 90%)`) with nine tabs (`SETTINGS_TABS`,
`packages/client/src/settings/catalog.ts:174-184`): the shipped seven, General,
Appearance, Repositories, Labels, Profiles, Keybindings, Web, in that order, then the
Kelpi-only **Workspaces** and **Remote** appended at the end of the rail. Every settings
control persists to `~/.config/kelpi/config` or, for Appearance's terminal keys, to
`~/.config/ghostty/config` (the Repositories, Labels and Web tabs edit daemon-owned
registries instead); nothing persists to a per-app preferences store.

1. **General** (`packages/client/src/settings/GeneralTab.tsx`; every row is a section 1.2
   key written through `set-general-setting`)
   - *Worktrees*: base path text field (supports a `<repo>` placeholder — at the start of
     the path it resolves to the full repo path, elsewhere to the repo directory name;
     `worktree-base-path`).
   - *Repositories*: "Auto-detect from pane directories" toggle (auto-associate a repo
     with the workspace when a pane's cwd is inside it; auto-removed a few seconds after
     no pane remains; manual associations never auto-removed; `auto-detect-repos`).
   - *Workspaces*: "Inherit group when creating a new workspace" toggle; "New workspace
     placement" picker (Next to selection / End of list); "New group placement" picker
     (same options).
   - *Network*: TCP listener toggle + port (section 12).
   - The Panes rows (focus-follows-mouse), the "Expand group when a workspace is dropped
     into it" toggle and both confirmation toggles live on the Workspaces tab (item 8); a
     note at the foot of General points there rather than duplicating a control (two
     switches for one value is how they drift).
   - Persistence: every row → the config file via this subsystem.
2. **Appearance** (`packages/client/src/settings/AppearanceTab.tsx`), chrome theming,
   persisted to the config file's chrome family (section 1.2; the `chrome-*` and
   `sidebar-*` keys are Kelpi-owned and never reach the ghostty file): preset chrome-theme
   gallery; export/import as `.nextheme` file or copy/paste share code; light/dark/system
   chrome appearance; per-color chrome overrides (separate light/dark buckets, editing the
   currently-resolved scheme); agent status dot colors; sidebar color intensity +
   fill/stroke opacities; TERMINAL theme picker ("None (Custom)" + the 10 built-ins of
   section 11; writes `theme` to the GHOSTTY config, or removes it) with custom background
   color when no theme + background opacity slider (ghostty keys, `set-ghostty-setting`);
   search-highlight colours (`search-match-*`); status-bar system stats (per-metric
   toggles, sparkline style/color/width).
3. **Repositories**: the repo registry (`packages/client/src/settings/RepositoriesTab.tsx`):
   a filter field and a "Show auto-detected" toggle (`:162-186`), a path field with a
   native directory chooser when the shell provides one (`:124-126`, `:199-203`), an
   editable name per row (`:273`) and the "Auto-detect from pane directories" toggle
   (`:369-375`). No branch control exists: the default branch is not a registry field,
   the git service resolves it on demand for worktree creation (`defaultBranch`,
   `packages/daemon/src/git/service.ts:74`, `:287`).
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
8. **Workspaces** (Kelpi-only; `packages/client/src/settings/WorkspacesTab.tsx`): a
   *Workspaces* section: "Confirm before deleting a workspace with active agents" (the GUI
   delete gate; CLI `--force` bypasses regardless), "Expand group when a workspace is
   dropped into it", "Confirm before quitting with active agents" (the ⌘Q dialog; a
   browser client has no ⌘Q and the row says so); a *Panes* section: focus-follows-mouse
   toggle + 0–500/25 delay slider, shown only while the toggle is on (section 10); and the
   `clipboard-write` toggle (OSC 52; the row states that clipboard reads are refused
   regardless). Values are read straight off the daemon snapshot with no optimistic local
   state, so two windows cannot disagree about what the file says.
9. **Remote** (Kelpi-only): device pairing (`kelpid pair` / `devices` / `url --tailnet`
   in-app) and the section 1.7 daemon registry.

### 13.1 Keybindings tab

- **Global section** (`packages/client/src/settings/GlobalHotkeySection.tsx`):
  global-hotkey row, recorded combo shown as a chip (`⌃⌥Space` style) with an "x" clear
  button (writes `global-hotkey = none`), or "—" when unset; a Record button; subtitle
  "Works from any app. No Accessibility permission required."; "Press again to hide"
  toggle (bound to `global-hotkey-hide-on-repress`, disabled while no hotkey is set); a
  destructive-toned `role="alert"` error when registration failed (the `hotkey-status`
  error string of section 8.3, cleared by any later `ok` report); an amber advisory when
  the hotkey shadows an in-app binding (section 8.5).
- **Action table** (`packages/client/src/settings/KeybindingsTab.tsx`): sections in fixed
  order `Pane Management, Navigation, Workspaces, View, Files, Search` (the web-pane
  category and `unbind` are excluded). Each row: display name; ALL bound trigger chips
  (configString-sorted), each with an "x" to remove that one trigger (section 5.4); a
  Record button (the inline recorder of section 13.2); a Reset button enabled only when the
  action's trigger list differs from its default list (`reset-keybindings {action}`).
- **Footer**: "Config: ~/.config/kelpi/config" + "Reset All to Defaults" button
  (`reset-keybindings {action: null}`), disabled while no visible action differs from its
  default (`KeybindingsTab.tsx:423-431`).

### 13.2 Recorder sheets

Two recorders, each inline in its own row rather than a sheet (`recordKeyEvent`,
`packages/client/src/settings/recorder.ts`, driven by `KeybindingsTab.tsx:104-140` and
`GlobalHotkeySection.tsx`): arming a row installs a capture-phase `keydown` listener on
`window` that calls `preventDefault`, so the browser's own ⌘W/⌘D never fire and the client
dispatcher (already gated by the Settings overlay, section 7.2) never sees the combo. Both
capture the next key-down as a trigger:

- Acceptance rule: the combo must include ≥1 modifier, UNLESS the key is Escape or an
  F-key (F1–F12) — those are accepted bare.
- A bare key is refused with "Add at least one modifier (⌘, ⌃, ⌥ or ⇧)"
  (`NEEDS_MODIFIER_MESSAGE`, `recorder.ts:92-100`); the row stays armed.
- On capture, run the conflict check (section 8.5). Conflict → show the message in red
  ("Already bound to "X"" / "Already bound to the global hotkey") and stay open for
  another attempt. An action conflict carries a "Rebind it" link that scrolls to the owning
  row and arms it instead (`KeybindingsTab.tsx:248-278`). No conflict → commit and close.
- Action recorder: `excluding` = the action being recorded (re-recording its own combo is
  a silent no-op commit). Commit dispatches `set-keybinding`; the captured chord is shown in
  the row's Record button for 700 ms (`CAPTURED_FEEDBACK_MS`) before the row disarms, or
  sooner when the daemon's broadcast lands first, and a second keystroke during that beat
  does not record again.
- Global recorder: `ignoreGlobalHotkey = true` (structural: the in-app map is the only
  conflict source it consults, and the hotkey is not in it). Commit dispatches
  `set-general-setting('global-hotkey', …)`, which may still fail at OS registration → the
  value is kept and the error label shown, section 8.4.
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
- The client dispatcher fires menu-bar actions too; while a modal overlay (palette,
  Settings, Help, create sheet) is open it consumes only the `close_pane` chord; while a
  chrome text field has focus it fires only menu-bar actions; it never consumes the
  global-hotkey trigger.
- Web priority layer beats the user's map only when a web pane is focused; URL-bar
  editing exempts ⌘←/⌘→/⌘⇧[/⌘⇧]; single-tab ⌘W falls to close_pane.
- Global hotkey registration is transactional (old registration survives a failed swap);
  neither a Settings-set failure nor a launch failure rolls the file back: the configured
  value is kept and the error surfaced as `hotkey-status`.
- Profile assignment storage: null ⇔ "default" ⇔ cleared; `KELPI_PROFILE` always injected,
  always canonical; `KELPI_PANE_ID`/`KELPI_SOCKET`/`PATH` unoverridable; injection is
  spawn-time only; definitions re-read from disk at every spawn (boot restore: one read per
  launch); a recorded agent session's profile overrides the workspace's for its resume
  spawn.
- Profile write-through preserves every non-profile config line; keybinding write-through
  preserves every non-keybind line; general-setting writes preserve everything else
  line-for-line. The three writers are mutually safe on the shared file, and the daemon is
  the single writer; every write is followed by a re-read and a broadcast, and hand-edits
  arrive through the watcher (section 1.4).

---

## Compatibility rationale

These items record the quirks Kelpi preserves on purpose so the pre-port `kelpi` CLI, hook
scripts and saved state (the config file above all) keep working, and where each concern
lives now:

1. **KeyCode encoding is macOS-specific.** `KeyTrigger.keyCode` uses macOS virtual key
   codes (physical, ANSI layout), which don't exist in the browser. The CONFIG-FILE names
   (section 3.4) are the canonical identity (they are stable strings that existing config
   files already contain), and the client maps browser `KeyboardEvent.code` values onto
   them (`"d"` ↔ `KeyD`, `"left"` ↔ `ArrowLeft`, `"["` ↔ `BracketLeft`, `"="` ↔ `Equal`,
   …; `CODE_TO_KEY_CODE`, `packages/client/src/chrome/keys.ts`), preserving physical-key
   matching. The alias table on parse and the canonical names on write are kept, including
   the punctuation asymmetry of section 3.3, so existing config files round-trip
   identically. The numeric keyCodes never appear on the wire or in storage.
2. **Modifier naming**: `super` = ⌘ on macOS and the primary chord modifier (Ctrl) on
   Windows and Linux, applied by canonicalization at match time (section 3.5); the config
   format keeps distinct `ctrl` and `super` names, and storage never conflates them.
3. **Ignored-flag semantics** are re-created in the client: CapsLock, NumLock-style and fn
   state never enter a trigger, and the exact remaining modifier set is compared
   (section 3.1).
4. **Two dispatch layers collapse into one** in the client (a browser tab has no OS menu
   bar). All 51 actions go through a single keydown interceptor, and three behaviors of the
   original split survive: (a) shortcuts do not fire while a modal/palette/secondary
   surface has focus (the one exception is the `close_pane` chord, which closes the
   overlay, section 7.2); (b) conditional actions FALL THROUGH to the terminal when their
   condition fails (markdown-only keys, close_search with no search, web keys on non-web
   panes); (c) the web-pane hard-coded priority table runs before the user map, with the
   URL-bar-editing exemptions and single-tab ⌘W falling to `close_pane`. The Electron
   shell's native menu is meant to derive its accelerators from the binding map (first
   trigger per action) so the map stays the single source of truth (section 7.1).
5. **Browser-reserved shortcuts**: ⌘W/⌘N/⌘T/⌘L etc. are meaningful to the browser chrome
   for the plain web client. The Electron shell intercepts them; a plain browser tab
   cannot always (⌘W especially). The defaults table stays as specified for the shell, and
   the web client is where the browser may steal a default.
6. **Config ownership lives in the daemon.** Parsing/writing `~/.config/kelpi/config` is
   daemon-side (single writer, `SettingsService`), and the three surgical writers keep
   their preservation guarantees (sections 1.3, 1.6, 5.3): users hand-edit this file, and
   the writers never clobber unrelated lines or comments outside their own key family. The
   daemon watches the file (section 1.4; a deliberate departure from the pre-port app,
   whose long-lived clients could be asked to relaunch), and profiles are re-read fresh at
   every PTY spawn.
7. **Keybindings are client-relevant state**: the daemon exposes the `keybind` lines to
   clients over the WS protocol so web and Electron clients render and dispatch from the
   same map, and accepts the mutation verbs of section 5.4 (`set-keybinding`,
   `reset-keybindings`) plus `set-general-setting`, each persisting with the same
   diff-vs-defaults file format so the file stays compatible with hand edits and with the
   pre-port app. The verbs are WS-only, not `WIRE_COMMANDS`: the pre-port CLI has no way
   to send them, and a new CLI verb would be a compatibility surface owed forever.
8. **Global hotkey is host-OS functionality.** It belongs to the Electron shell
   (`globalShortcut.register`), not the daemon or web client. Kept: staged-swap error
   handling (registration failure never loses the previous working hotkey), keep-and-warn
   on both the Settings-set and the launch path (section 8.4), the hide-on-repress toggle
   behavior (a Kelpi window focused + hideOnRepress → hide; else present the main window),
   and the shadowing guard (an in-app binding equal to the global hotkey never fires). The
   trigger still serializes as `global-hotkey = <configString>` in the shared file; the
   shell translates it to an Electron accelerator string.
9. **Profiles: PTY env injection lives in the daemon.** The daemon owns PTY spawn, so it
   implements `mergedEnvVars`: `KELPI_PANE_ID` first, `PATH` with the bundled `kelpi`
   CLI's directory prepended, `KELPI_SOCKET` when there is a TCP route, then sorted profile
   vars minus reserved keys, and `KELPI_PROFILE` forced last. Tilde expansion of profile
   values happens at resolution time (daemon-side, against the daemon's `$HOME`).
   `normalizedAssignment` (null ⇔ "default") is preserved in the daemon's workspace state
   and in the `workspace-profile` / `workspace create --profile` wire handling: the CLI
   contract depends on it. The pre-port app injected `NEX_PANE_ID` and `NEX_PROFILE`; Kelpi
   injects only `KELPI_*` so the two can run side by side with no shared environment.
10. **The `theme` config key** maps to ghostty theme filenames. It matches the same 10 ids,
    the daemon resolves the theme file to a palette itself (there is no libghostty) and
    serves it live (section 11). The key stays read-only-from-file, and the user's own
    ghostty `theme` line wins over it.
11. **Focus-follows-mouse and its delay** are client-side view behavior (hover timers per
    section 10) but the SETTING is stored in the shared config file; the daemon serves it
    to clients with the rest of general settings.
12. **tcp-port** keeps its key for CLI back-compat. The daemon IS the network server, so the
    key names the control socket's optional `127.0.0.1` listener, bound once at daemon
    start; the port is written whether or not it could bind, and the bind outcome is
    reported separately (section 12).
13. **Settings UI parity**: the Settings surface keeps the recorder semantics
    (capture-next-chord, modifier requirement except Escape/F-keys, inline conflict
    message with retry), per-trigger remove chips, per-action reset (enabled only when
    differing from default), reset-all, and the profiles master-detail editor with the
    locked `KELPI_PROFILE` row, `:`/`=` input stripping, reserved `default` name, and
    write-through (on blur, Enter and structural change) against the config file.
14. **Count sanity for tests**: 52 enum cases total; 51 bindable (excludes `unbind`);
    13 ship unbound (`open_diff`, `toggle_sync_input`, 11 `web_*`); the default map has
    exactly 40 trigger entries (38 distinct actions bound; focus next/prev own two
    triggers each). The Settings table shows 40 actions (51 minus the 11 hidden web
    actions).
