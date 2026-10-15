# Run Suggested Command

A build-free backend that runs the command Claude Code last suggested in a pane, so you don't
copy it by hand across Claude's line wraps. It has no views. It listens to Kelpi's agent hook
events (`api.agents.onEvent`), asks with a backend dialog (`api.ui.showDialog`), types with the
screen-revision guard (`api.terminal.read` and `ifRevision`), and adds a `kelpi run-suggested`
verb (`contributes.cli`).

## What it does

When Claude finishes a reply, its Stop hook hands Kelpi the reply's exact text. The plugin keeps,
per pane, the last suggestion in that reply:

- a line that starts with `! ` and a command (`! gh auth status`), which is how Claude asks you to
  run something in its own session, alone on its line or as one inline code span
  (`` `! gh auth status` ``), or
- a code block, fenced with backticks or tildes, labelled `bash`, `sh`, `shell` or `zsh`, whose
  lines are the command.

Whichever comes last in the reply wins. A reply with no suggestion clears the pane's entry, and so
does the start or end of a Claude session in the pane. Running a suggestion does not clear it;
Claude's next reply replaces it.

Press **Ctrl+Alt+R** in the pane, or click **Run suggested** in its header, and a dialog shows the
command exactly as it will run, with where it will run:

- **Run in this Claude session** types `! <command>` into Claude's input box and presses Enter, so
  Claude runs it and sees the output. It is offered only for a one-line `!` suggestion, when the
  pane is a Claude session that has finished its reply, is not asking for a permission or an
  answer, and shows its input box empty with no menu below it.
  Claude's prompt suggestion often draws its guess at your next prompt as dim ghost text in the
  empty box, and right after a `!` reply the guess is usually that same line. The screen text
  has no styling, so the plugin goes by the cursor: Claude keeps it right after the prompt glyph
  in an empty box, at the start of any ghost text, and at the end of a draft. With the cursor
  there, a box that is blank or shows exactly `! <command>` counts as empty. A draft with its
  cursor moved back to the start looks the same; the typed check below then catches it, nothing
  runs, and the command sits typed in the box.
- **Run in new split** opens a shell split beside the pane, in the pane's working directory, and
  runs the command there. A code block, a multi-line command, a busy Claude or a Claude waiting at
  a permission prompt only gets this choice, with the reason in the dialog.

Typing into the session is guarded. Once you choose, the plugin reads the screen again and checks
that Claude still waits at an empty prompt. It types `! <command>` only if the screen is still the
one it just read. It then reads again and presses Enter only if Claude's input box shows exactly
what it typed, with no menu below it, and the screen has not moved since that read. Ghost text
drawn after the typed command counts as a difference, so Enter is not pressed. When a check
fails before typing, it sends nothing and says so in a notification ("the screen changed, nothing
was sent"). When one fails after typing, the command sits in Claude's input box, unrun, and the
notification says so ("the screen changed before Enter; the command is typed in Claude's box, not
run"). It never retries.

## Install

Kelpi's Claude hooks must be installed (`kelpi install-hooks`): the suggestion comes from the Stop
hook, so without them the plugin never hears a reply. The hooks must also run a Kelpi CLI that
forwards the reply's text (Claude's `last_assistant_message`), such as one built from this
checkout. The 0.2.16 release's CLI does not, and with it the plugin never sees a suggestion. A
Stop without the text changes nothing, so a pane whose hooks run two CLIs, which gets two Stop
events per reply, goes by the one that carries it. Then, from the checkout root:

```sh
kelpi plugin validate ./examples/plugins/run-suggested
kelpi plugin install ./examples/plugins/run-suggested --trust
```

To try it away from your installed Kelpi, follow the
[private development setup](../../../docs/plugin-development.md#start-a-private-instance) and use
its `kelpi_test` helper in place of `kelpi`. The backend activates at startup, so it hears every
Stop from then on; a reply that arrived before the plugin started is not remembered.

## Shortcut and header item

**Run Claude's suggested command** (`example.run-suggested.run`) is bound to ⌃⌥R
(`ctrl+alt+r`) and listed in the palette; change or disable the binding in Settings → Plugins. It
acts on the focused pane. The header item acts on its own pane.

The **Run suggested** header item shows on a pane with an agent while the plugin remembers a
suggestion for any pane. Item conditions have no per-pane plugin facts, so `hasSuggestion` is
plugin-wide: the chip can show on a Claude pane that has no suggestion of its own. Clicking it
there says "Claude has not suggested a command in this pane" and does nothing else. The plugin
notices a closed pane only when the command or the verb next runs, so after the suggesting pane
closes the chip can stay lit until then.

## The CLI verb

```text
kelpi run-suggested [--target <pane>] [--print | --yes] [--json]
```

- `--target <pane>` is a pane id, or a pane label in the workspace you run it from (outside a
  Kelpi pane, a label must be unique across every workspace). Without it, the verb acts on the
  pane it runs in.
- With no flag it prints the command and a hint on standard error, and runs nothing.
- `--print` prints the command and stops. `--json` prints `{ "command", "kind" }`.
- `--yes` runs it without a dialog: in the Claude session when the dialog would offer that, else
  in a new split. It prints `ran in the Claude session` or `ran in a new split: <reason>`.
- `--help` prints the usage.

Exit codes: 0 when it printed or ran the command; 1 when there is no target pane, Claude has not
suggested a command in that pane (`{ "found": false }` with `--json`), the command holds a
character it will not type, the screen changed, or the run failed; 2 for a usage error, including
`--print` with `--yes`.

## Limits

- Only `bash`, `sh`, `shell` and `zsh` code blocks count. An unlabelled block is as
  often a file or some output as a command, so it is never offered.
- Only a one-line `!` suggestion runs in the session. A multi-line command, or one ending in `\`,
  runs in a new split, since Enter in Claude's box would start a new line.
- A `!` inside a sentence ("run ! gh auth status first") is never offered: only a line that
  starts with `! ` is a suggestion.
- A command holding a control character, a tab, an invisible format character, a combining mark
  or any space other than a plain one is refused rather than typed.
- The hook caps a reply at 64 KiB, cutting its end, so a reply over 64 KiB offers nothing.
- A `!` command still running in the session, or Claude's reply to its output, is not seen as
  busy: neither reports a start, and Claude shows its empty box meanwhile. Claude queues the
  typed command and runs it afterwards.
- The empty-box check relies on Claude Code keeping the terminal cursor in its input box, as
  2.1.x does. A version that parks it elsewhere only gets **Run in new split**.
- A CLI run cannot show the dialog, so it only prints unless you pass `--yes`.
- The screen guard refuses instead of retrying: press the shortcut again once the pane is quiet.

The parser and the routing rules are in `suggested.mjs`. Unit coverage:
`pnpm vitest run packages/plugin-sdk/tests/run-suggested.test.ts packages/plugin-sdk/tests/run-suggested-backend.test.ts`.
See [agent events](../../../docs/plugins.md#state-events-focus-and-appearance),
[prompts from a backend](../../../docs/plugin-ui.md#prompts-from-a-backend) and
[CLI verbs](../../../docs/plugins.md#cli-verbs).
