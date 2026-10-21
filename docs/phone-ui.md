# Phone UI

The client's phone shell: what is on each screen, the rules behind the parts that are easy to get
wrong, and where the code lives. Everything here is gated on `chrome/form-factor.ts`; a desktop
window never mounts any of it. The code is `packages/client/src/phone/`, assembled by
`PhoneShell.tsx`.

## Screens

| Screen | What it shows | Code |
| --- | --- | --- |
| Home | Needs you (or All clear, or "Can't reach any host"), a pager with a card per host, and the workspaces of the host the pager is on as tiles | `PhoneHome.tsx` |
| Pane | The pane's header (name, status, view toggle, actions), the pane itself, the key bar for a terminal, the strip (pane pager, reply chips, attention pill) and the location bar | `PhoneShell.tsx`, `PhonePaneChrome.tsx` |
| Location bar | `host › workspace › pane` at the bottom; each segment opens the picker at its level. On Home: the host and Jump to… | `PhoneLocationBar.tsx` |
| Picker | One card above the bar with three levels: Hosts (with Scan code, Paste URL, Settings), Workspaces (groups fold as the daemon has them; New workspace), Panes (New pane: Terminal, Claude, Codex, Web, Scratch, Diff, and any plugin pane views) | `PhonePicker.tsx` |
| Needs you | Every waiting agent, grouped by host, filterable by host, with Running folded at the foot | `PhoneNeedsYouSheet.tsx` |
| Jump to… | Find a workspace or pane on any host by name | `PhoneJumpSheet.tsx` |
| Pane actions | New terminal, Rename, Sync input, Take size control, Command palette, Settings, Close pane | `PhoneMenuSheet.tsx` |
| Add host | Paste a pairing URL or scan the Mac's pairing code | `PhoneHostSheet.tsx`, `PhoneQrScanSheet.tsx` |

Home is the shell's `landing` screen (`view.ts`): where the phone starts when nothing is
remembered, and nothing of any host streams while it is up. The header's ‹ goes Home in one tap;
picking a host in the bar goes Home on that host. Which host Home's pager is on is remembered
(`place.ts`, `kelpi.phone.home-host`).

## Attention

`attention.ts` derives what needs the person from every host at once (`fleet.ts` reads every host's
store as one value):

- a pane is **waiting** when its status is `waitingForInput`, its workspace is not muted, and its
  host is connected (a disconnected host's mirror is the last thing it said);
- a pane is **running** when its status is `running`.

Home's row, the host card badges and pager dots, the outlined tiles, the bar's workspace dot, the
picker badges, the Needs-you sheet and the pill all read that one derivation. The pill counts what
waits elsewhere: the pane on screen is left out.

How long something has waited is measured by the phone (the daemon keeps no "waiting since"), from
the moment this page first saw it. One shared ticker (`useWaitClock`) moves those labels every 30 s
while any is on screen and the page is visible.

## Quick replies

A waiting agent's question lives only on its screen, so the phone reads it with `pane-capture`.
"Waiting" is also an agent that simply finished its turn, so most screens read are the agent's last
reply, full of numbered lists, bullets and quoted input. `prompts.ts` therefore offers buttons only
for an unmistakable live prompt:

- a **numbered menu** (Claude Code's and Codex's approval prompts): consecutive `1.` … `n.` lines,
  at most nine, with exactly one marked selected by `❯` or `›`, a question with a `?` above it, and
  nothing below it but blank lines, the box's bottom edge and key hints. A choice is answered with
  its hotkey: the letter in a trailing `(y)` when every choice prints a different one, else its
  number;
- a **`[y/N]` question** as the last line: `y` or `n`, then Enter.

Anything else shows the last lines of the screen with Open only. The question shown runs up to the
box's top edge, so a card asking "Do you want to proceed?" also shows the command that would
proceed. A card too small for the whole menu (Home's) shows its first and last answers, never the
far-reaching ones between ("Yes, and don't ask again").

An answer is a KEYPRESS (`pane-send-key` with one printable character, not `pane-send`, which would
wrap it in a bracketed-paste envelope) sent with the revision the capture read (`if_revision`,
#390). If any byte has reached the screen since, the daemon refuses it with `SCREEN_CHANGED`, the
phone reads the screen again and says the prompt changed. A host that reports no revision gets
Open only, and a send that gets no answer at all (a timeout, a dropped link) is never offered again
from the card, because the key may have been typed. Each prompt is read once per wait
(`prompt-capture.ts`) and shared by every surface that shows it; the buttons stand down while an
answer is on its way and while the prompt is being read again.

## New agent panes

There is no daemon verb that starts an agent, so New pane → Claude or Codex opens a terminal and
types the command. It waits first: a new pane's PTY is spawned only when a client attaches at its
real size (`pty/spawn-gate.ts`), and both `pane-send` and `pane-capture` force that spawn. The phone
gives itself time to attach the pane (it is the focused pane, so it is the one on screen), then
waits for the shell's first output, then types (`new-pane.ts`).

## The keyboard

The strip and the bar sit below the content row. A software keyboard reaches the page in one of two
ways:

- **as an inset** (iOS, Chrome's default): the keyboard rises over an unchanged window and covers
  the strip and the bar first. `PhoneKeyBar` pads the content row only by the part of the keyboard
  above them (`belowPx`, measured by the shell), so the key bar sits on the keyboard and nothing
  steps aside mid-animation;
- **as a shorter window** (`interactive-widget=resizes-content`, Chrome on Android): the browser is
  resizing the layout anyway, so the shell takes the strip and the bar away for as long as the
  window is short (`keyboard.ts`), unless a sheet is open.

## Theming

Colours are mixes of the chrome tokens (`style.ts`), so the shell follows the light and dark presets.
The few things that need a different rule per bucket (the accent fill and the text on it, raised
cards, shadows, the scrim) are CSS variables the shell writes on its root (`phoneThemeVars`).
Workspace avatar letters pick dark or white text by the swatch's luminance.

## Testing

- jsdom: `App.phone-shell.test.tsx` drives the shell through `phone/testing.ts`'s fake phone window;
  the units have their own files beside them.
- Real browser: the UI audit's phone lane (`phone-shell`, `phone-landing`, `phone-keyboard-inset`,
  `phone-key-bar*`) and the phone halves of the plugin scenarios. `phoneToLanding` and
  `phoneRevealWorkspace` in `scripts/ui-audit/lib/workbench.mjs` take a scenario Home and page Home
  to the host that holds a workspace.
- By hand: `node scripts/dev-hmr.mjs --state /tmp/kelpi-hmr` and open the printed URL with
  `&form=phone`. Use a short state path: the daemon's Unix socket lives under it, and macOS caps
  socket paths at 104 bytes.
