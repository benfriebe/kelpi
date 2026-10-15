# Auto-approve

For unattended runs: while it is on, Claude's Bash commands run without stopping at a permission
prompt, in every Claude pane, until the time runs out. Claude Code's `PermissionRequest` hook runs
`kelpi event permission-request`, the daemon asks the selected `kelpi.agent.permissions` provider,
and this plugin is that provider ([Agent permission decisions](../../../docs/plugin-services.md#agent-permission-decisions)).
It sees the real command Claude is about to run, as Claude sent it; nothing is read from the
screen and no key is pressed. A Bash command that passes the never-auto-approve list is allowed.
Everything else abstains, which leaves Claude's own prompt in place. It never denies. A backend
with no build: `backend.mjs` holds the state, the provider, the CLI verb and the status bar item,
and `policy.mjs` the never-list.

## Install and select

```sh
kelpi plugin install ./examples/plugins/auto-approve --trust
kelpi plugin service-select kelpi.agent.permissions example.auto-approve.permissions
```

Installing a provider does not select it, so nothing is approved until you select it, with the
command above or Settings > Plugins > Service providers (`default` goes back to the bundled
provider, which always abstains). Claude's `PermissionRequest` hook must be wired:
`kelpi install-hooks` adds it, and `kelpi doctor` warns while it is missing. The plugin activates
at startup, so it answers the first request after the daemon starts. For development, follow the
[private development setup](../../../docs/plugin-development.md#start-a-private-instance) and use
`kelpi_test` in place of `kelpi`.

## Commands

```
kelpi auto-approve on [minutes] [--json]
kelpi auto-approve off [--json]
kelpi auto-approve status [--json]
```

- `on` turns it on for `minutes` (default 10, at most 10080, a week) and restarts the counts.
  `on` again while on starts the window over from now.
- `off` stops it now. `status` changes nothing.
- Each prints the state after it, then one line per command left for you (the latest 100):

```
$ kelpi auto-approve on 10
Auto-approve is on until 09:03. 0 approved, 0 left for you.
$ kelpi auto-approve status
Auto-approve is on until 09:03. 1 approved, 1 left for you.
  1658DD1A-9867-4863-B58B-2AE119D4DE71: never auto-approved: rm -r: rm -rf sub
```

- When this plugin is not the selected provider, `on` and `status` also say so on standard error,
  with the `service-select` command, and the exit status stays 0.
- `--json` prints `{ on, endsAt, remainingSeconds, approved, leftCount, left, selected,
  selectedProviderID, activeProviderID }`. Each `left` entry is `{ paneID, workspaceID, reason,
  command, at }`, the command cut to 200 characters.
- A bad minutes value, a missing or unknown action, or an extra argument prints the error and the
  usage on standard error and exits 2. `--help` prints the usage.

## Status bar and palette

The status bar shows `Auto-approve off` while off and `Auto-approve 7m` (the time left, `<1m` in
the last minute) while on, refreshed every minute. Clicking it runs **Toggle auto-approve**, which
is also in the command palette: off turns on for 10 minutes, on turns off, and a notification says
which. Turning on while the plugin is not the selected provider says so in that notification. The
CLI verb's own command is kept out of the palette by a palette rule that never matches.

## Scope

Global, as #385 was: every Claude session on this daemon whose `PermissionRequest` hook reaches
it, in every pane and every workspace. The service asks one provider for every pane, and
`kelpi auto-approve on` may run from a plain terminal with no pane, so a narrower scope would have
nothing natural to attach to. That includes sessions that cannot show a prompt (background
subagents, `claude -p`), which deny a call no hook decided; while on, a command that passes the
list runs there too. A prompt already open when you turn it on is not answered: its hook has
already asked.

## What is never approved

Only Claude's Bash tool is ever allowed: MCP tools, Fetch, file edits and every other tool wait for
you, and so does another agent's shell. A Bash command is left for you, with the reason in
`status`, when it spans lines (any `\r` or `\n`, so nothing can ride in after a line that only
looks harmless) or matches the never-auto-approve list, whatever its quoting: `rm -r`, `git push`,
`sudo`, a download or anything else piped or heredoc'd into a shell or interpreter, inline code
(`bash -c`, `python -c`, `node -e`), any command that mentions `auto-approve` (so it cannot extend
itself), `mkfs`, `dd of=`, `find -delete`, `git clean -f`, `git reset --hard`, `git checkout -- .`,
`git branch -D` and its kin, `git -c` and other git config overrides, `chmod -R`, `chown -R`,
`rsync --delete`, `gh pr merge`, `gh api` with `DELETE`, `npm publish`, `kubectl`, `terraform`,
`helm` and `aws` writes, a variable as the command word, `alias` and `eval`, and any word with a
brace or glob character. The whole command is judged, never a prefix. The provider never answers
deny: anything it does not allow falls through to Claude's own prompt, exactly as if the plugin
were not there.

## Limits

The never-list is best effort, not a sandbox. An agent set on getting past it can (base64, `\u`
escapes, a `git config` write or `GIT_SSH_COMMAND` that a later git command runs). Turn it on only
for work you would approve anyway.

Nothing is persisted: a daemon restart, or a plugin reload, disable or upgrade, turns it off and
clears the counts. The window is timed on a monotonic clock, so setting the system clock back
cannot extend it, and it also ends at the wall-clock time `on` showed, so a Mac that slept through
the end wakes up with it off.

Run `pnpm vitest run packages/plugin-sdk/tests/auto-approve.test.ts packages/plugin-sdk/tests/auto-approve-policy.test.ts`
for the provider and never-list tests.
