# Running services: dev servers, ports and containers per workspace

This document specifies **running services**: the dev servers, listening processes and Docker
containers on the daemon's machine, each attributed to the workspace whose pane started it, with
the memory it uses and, in later phases, a way to stop it.

Phase 1 is a scanner in the daemon, the `running-list` verb and `kelpi ps`. Phase 2 is the app:
a scan loop that broadcasts the list (§4) and the surfaces that show it (§7). Stopping and
resource sampling are designed here and built in later phases (§8).

Implementation index:

- `packages/daemon/src/running/probes.ts`: `ps`, `lsof` and the Docker Engine API
- `packages/daemon/src/running/parse.ts`: parsers for the probes' output, command-line helpers
- `packages/daemon/src/running/attribute.ts`: stacks, owners and categories (pure)
- `packages/daemon/src/running/scanner.ts`: one scan; shared, briefly cached
- `packages/daemon/src/running/context.ts`: pane shells and workspace folders from the store
- `packages/daemon/src/running/handlers.ts`: the `running-list` verb
- `packages/cli/src/commands/ps.ts`: `kelpi ps`
- `packages/daemon/tests/compat/running.test.ts`: a server in a pane, found by a real daemon
- `packages/daemon/src/running/monitor.ts`: the scan loop and the `running-services` broadcast
- `packages/protocol/src/ws/messages.ts`: `WsRunningServicesMessage`
- `packages/client/src/chrome/running.ts`: the grouping every surface shares (pure)
- `packages/client/src/chrome/RunningServicesGlyph.tsx`, `InspectorServices.tsx`,
  `RunningServicesChip.tsx`: the sidebar mark, the Inspector section, the status bar chip

Naming (D1): the UI says **Services**, the user's word. Code, the wire and the CLI say
`running` (`running-list`, `kelpi ps`, later `kelpi kill`), because "services" already names
plugin service providers (`api.services`, `services.changed`, `kelpi plugin services`).

## 1. Why

A scan of one developer's Mac on 15 November 2026 found 14 dev servers in 9 process stacks
(3.9 GB) and 63 containers in 11 compose projects (3.2 GB). 12 of the 14 servers had been started
by a Claude agent as a background task, with no terminal attached: the pane looked idle, the
conversation had moved on, and nothing in Kelpi showed the stack. Two compose stacks were still
running 9 and 28 days after their worktrees were deleted, because deleting a workspace hangs up
only each pane's shell. One agent had changed into another worktree and started a stack there,
so where a stack was started and where it runs can differ.

## 2. What counts as a service

| Kind | Definition | Listed |
| --- | --- | --- |
| Process stack | The command that was started and every process under it, when one of them listens on a TCP port. One `turbo` run with five servers is one stack with five members. | yes |
| Compose project | Containers sharing `com.docker.compose.project` (Supabase CLI containers carry it too). | yes |
| Lone container | A running container with no project. | yes |
| Agent's own port | Claude Code or Codex listening on a local port of its own. | `--all` |
| Started outside Kelpi | No pane in its ancestry and no Kelpi folder: desktop apps, launchd services, another terminal app's server. | `--all` |
| Kelpi itself | The daemon and its children (plugin backends). | never |

Version 1 lists listening processes and containers only (D6). A watcher or worker that never
listens appears only as a member of a stack that has a port. An agent's background tasks can be
added once its hook payload carries their commands (today it carries a count).

## 3. Attribution

### 3.1 Signals, strongest first

1. **The process tree reaches a pane shell.** The daemon holds every pane's shell pid
   (`KelpiPtyManager.pid`), and it survives a handoff. A listener's parent chain is walked up to
   one of those shells: that pane, and its workspace, own the stack. On the 15 November scan this
   placed 13 of 14 dev servers.
2. **The working directory is inside a workspace's folder.** A workspace's folders are its repo
   associations' worktree paths, with symlinks resolved. The longest folder wins. This places a
   process whose parents are gone (adopted by launchd).
3. **A compose project's folder.** `com.docker.compose.project.working_dir`, else Supabase's
   `com.supabase.cli.workdir`, matched like a working directory. Any container's folder can place
   the project.
4. **A folder where a workspace's own pane started a stack.** A compose project in a folder no
   workspace owns, where a pane-started stack runs, belongs to that stack's workspace (an agent
   ran a whole dev stack, containers included, in another worktree). Only a stack folder inside
   a worktree or repo folder counts: a pane's `ssh -L` in `~` must not claim every leftover
   compose project under it.

`KELPI_PANE_ID` in a process's environment is not used: macOS hides the environment of `/bin`
binaries and of Node processes that rewrite their title (`next-server`), so it fails for the
cases where it would be needed.

### 3.2 The stack root

The root is the command a person (or agent) started, found on the chain from the listener up:

- an agent (`claude`, `codex`, Claude's version-named native binary) in the chain: the process
  below it, and below its `zsh -c` wrapper when the agent ran the command through one;
- otherwise, the child of the nearest interactive shell (`-zsh`, `zsh -l`; not a shell running
  a script or a `-c` command): the pane's shell, a shell nested in it, or, for a server started
  outside Kelpi, the shell in iTerm, tmux, VS Code or an ssh session, so the terminal app is
  never the stack and the server is still placed by its folder;
- with no shell in the chain, the topmost process below the one that adopted it (launchd or
  init, or Linux's `systemd --user` subreaper), skipping the `zsh -c` wrapper an exited agent
  left behind.

The walk counts the pane's own process: a pane can run an agent directly.

Listeners with the same root are one stack. A stack's memory is the resident set size summed over
the root and its descendants, never into a pane shell or Kelpi's own processes (a Kelpi dev
instance started in a pane runs its own panes); an agent's own port counts the agent alone. A stack is identified as `process:<root pid>:<root start>`, so a
reused pid never inherits another stack's identity.

### 3.3 Categories

| Category | Rule |
| --- | --- |
| `workspace` | An owner was found by any signal in §3.1. |
| `unattached` | No owner, and its folder is gone, or inside a known repo or that repo's worktree folder (the worktree base template resolved for the repo, the way `workspace create --worktree` resolves it: `~/kelpi/worktrees/<repo>` → `~/kelpi/worktrees/shop`). |
| `outside` | Anything else; and any macOS app not started from a pane, wherever it was launched (OrbStack's VM helper can sit in a deleted worktree). An app is an executable inside an `.app` bundle under `/Applications`, `~/Applications`, `/Library` or `/System`, not inside a framework (Homebrew's and python.org's `Python.app` are a runtime, not an app). |
| `agent` | The listener is the agent itself. |

Ports Docker publishes are the containers'. The process that forwards them (Docker Desktop's
backend, OrbStack's helper) does not own them, and a process holding only such ports is not
listed.

### 3.4 Names

A stack is named, in order of preference: by its member's app folder when it has one member in a
subfolder of the stack's folder (`apps/admin-web` → `admin-web`); by its own folder
when that is strictly inside a workspace's folder (generic names keep their parent:
`modules/dashboard/app` → `dashboard/app`); otherwise by its command as typed
(`/bin/sh …/pnpm run dev:prebuilt` → `pnpm run dev:prebuilt`). Apps are named by bundle
(`OrbStack Helper`), agents' own ports `Claude Code` or `Codex`, compose projects by project.

## 4. The scan

| Probe | Command | Measured (1,600 processes) |
| --- | --- | --- |
| Process table | `ps -A -o pid=,ppid=,pgid=,tpgid=,rss=,lstart=,args=` under `LC_ALL=C TZ=UTC` (start times read as UTC, so no daylight-saving hour is ambiguous) | 66 ms |
| Listening sockets | `lsof -nP -iTCP -sTCP:LISTEN -F pcn` | 85 ms |
| Working directories | `lsof -a -d cwd -F pn -p <pids>` (Linux: `/proc/<pid>/cwd`), for stack roots and listeners only, cached per pid and start time; lsof's `\xNN` escapes are decoded, so a folder named `été` matches | 70 ms |
| Containers | `GET /containers/json` on the Docker engine's unix socket | 20 ms |

No native helper (D4): the stack allows one native dependency, node-pty (`stats/host.ts`).

The Docker socket is found the way the `docker` CLI finds it: `DOCKER_HOST` (unix sockets only),
then the current context (`~/.docker/config.json` and
`contexts/meta/<sha256(name)>/meta.json`), then `/var/run/docker.sock`,
`~/.docker/run/docker.sock`, `~/.orbstack/run/docker.sock`, `~/.colima/default/docker.sock` and
`~/.rd/docker.sock`. No socket, or one that refuses, is Docker not running: no warning.

Every probe has a 3-second cap (killed with SIGKILL) and a deadline 2 seconds past it, so a probe
that never answers cannot hold the shared scan open. A probe that cannot run or did not finish
(no `lsof`, Windows, Docker timing out, a truncated table) becomes a `warnings` entry; the scan
reports what the others found and never fails for it. `ps` failing is never read as "no
processes".

**Cadence, phase 1:** on demand. Concurrent callers share the scan in flight, and an answer is
reused for 1.5 s, so an agent polling `kelpi ps` costs one set of probes. A full scan took 390 to
590 ms on the machine above; a reused one is free.

**Cadence, phase 2:** every 10 s while a window is visible, every 60 s when clients are attached
but none is visible, off with no clients; plus one scan 1 s after a trigger. About 1.3% of one
core while visible. The trigger built so far is an agent event (a hook fired, a turn ended); a
pane's command finishing and a stop completing are to come with phase 3. The loop looks at who is
attached once a second and scans only when one is due, and never runs two scans at once. A
trigger's scan must begin after the trigger, so it never gets the reused answer or a scan already
in flight from before the change.

The list goes to clients as its own WebSocket message, never through the domain store (every
store dispatch rewrites SQLite):

```json
{ "type": "running-services", "services": [ /* running-list entries, §5 */ ],
  "scannedAt": "2026-11-15T03:00:00.000Z", "warnings": [] }
```

It is sent when the list changes and replayed after the snapshot on every attach, like
`old-terminal-hosts`; before the first scan the replay is an empty list with `scannedAt: null`.
Memory counts as a change only past a whole MiB, so a server whose resident size wobbles by a few
pages does not resend the list every 10 s. CPU and memory samples (`running-stats`, phase 4) are
to be sent only while a client shows them.

## 5. `running-list` and `kelpi ps`

`running-list` is request/response and works without a pane (wire-protocol.md §6.11,
socket-handlers.md). Fields: `workspace` (name or id), `scope: "current"` with `pane_id`, `all`.
The default lists `workspace` and `unattached` services; `all` adds `outside` and `agent`; a
workspace filter lists that workspace's services, its agent's own port included. Each entry's
fields are `RunningServiceEntry` in `packages/protocol/src/replies/types.ts`.

An example (names changed):

```
$ kelpi ps
WORKSPACE       SERVICE                PORTS                     UP   MEM   STARTED BY         NOTE
checkout        shop-200               6579 9524 54521 54522 +3  10d  -     compose            runs in ~/kelpi/worktrees/shop/feature-flags/packages; reachable on network
checkout        pnpm run dev:prebuilt  3200 3201 3202 3204 +1    10d  1.4G  claude             runs in ~/kelpi/worktrees/shop/feature-flags; reachable on network
search-filters  auth-mock              61636                     12h  172M  claude
search-filters  admin-web              10300                     12h  111M  claude             reachable on network
search-filters  api-server             58345                     40m  759M  -
notes           pnpm start             4400                      1h   319M  pane (foreground)  reachable on network
(no workspace)  shop-400               54721 54722 54723         9d   -     compose            in ~/kelpi/worktrees/shop/old-branch/packages (deleted); reachable on network
```

`STARTED BY` is `-` for a process whose parents are gone (placed by its folder).

Agents use `kelpi ps --current --json` to find the port of the dev server their own pane started,
and reuse it instead of starting a second copy on the next free port.

## 6. Stopping (phase 3, designed)

| Selected | Action | Confirm |
| --- | --- | --- |
| A pane's foreground job | Ctrl-C to that pane, as `pane send-key ctrl-c` does | none; labelled "Stop (Ctrl-C)" |
| A detached process stack | recheck each pid's start time, SIGTERM every process in the stack, offer Force stop (SIGKILL) after 5 s | inline, Cancel default |
| One member of a stack | the same for its subtree; a supervisor such as turbo may restart it | inline |
| A compose project or container | `POST /containers/{id}/stop` per container, never `down` | inline |
| Started outside Kelpi | the same as a stack, behind a dialog that names the process (D2) | dialog |
| Kelpi, the terminal host, pane shells, pid 1, other users' processes | refused | |

The only process-group kill in the repo today is the git runner's (`git/exec.ts`), the pattern to
follow. Workspace delete gains "Also stop N services", ticked only when every service was started
from that workspace's panes (D3); `kelpi workspace delete --stop-services` is the CLI's form.
Paired devices are refused host-wide stops (the owner-only class of `restart-old-terminals`).

## 7. Surfaces (phase 2)

Built in, the way pull-request status is (plugins have no slot on a sidebar row or in the
Inspector). Every surface reads one grouping (`chrome/running.ts`): a workspace's services are the
scan's `workspace` category with that owner; an agent's own port is never counted.

Built:

- **Sidebar row:** a plug icon (ChromeIcon 12×12 at stroke 1.2: `M4.6 1.6v2.2M7.4 1.6v2.2`,
  `M3 3.8h6v2.1a2.4 2.4 0 0 1-2.4 2.4H5.4A2.4 2.4 0 0 1 3 5.9z`, `M6 8.3v2.1`), drawn like the
  PR glyph, with a 10px mono count past one; the tooltip lists the count, memory and first ports.
  A collapsed group shows its workspaces' total, nested ones included.
- **Row menu:** Services ▸ with Open localhost:PORT · name for each port (the first eight), and
  Show in Inspector, which switches to the workspace and opens the Inspector.
- **Inspector:** a Services section after Repositories: "N running · P ports · memory" when there
  is more than one, then two lines per stack: its name and memory, then who started it, its
  uptime and its first three ports as links. A row warns when its folder was deleted or belongs
  to another workspace, and expands to its members (marking one that listens on every
  interface), its process count and folder, and "Show the pane that started it".
- **Pane header:** a `:3200 ↗` chip (`+N` for more ports) on the pane that started a listener; it
  opens the first port in a web pane. It is the first badge the width ladder drops, before the
  branch, since the Inspector and the status bar list the same ports. The remote workspace view
  has no chip: its servers run on the remote machine, outside this daemon's scan.
- **Status bar:** "N services · K leftover" (leftovers in amber). N counts the workspaces'
  services; neither counts what was started outside Kelpi, and nothing is drawn when both are
  zero.

Opening a port puts a web pane beside the pane that started the service when that pane still
exists, otherwise beside the focused pane of the service's own workspace, otherwise beside the
focused pane. Uptimes keep counting between broadcasts: the client measures them against the
daemon's clock (the scan's time plus what has passed since it arrived).

Changed from the design: the status bar chip opens a popover, not the bottom panel. The bottom
panel band (`panel.bottom`) is visible by default, so a bundled view in it would appear for every
user whether or not they run anything. The popover (440 px) holds what the panel would have:

- One line per service: the workspace's avatar and name (the sidebar's, so they match at a
  glance; clicking switches to it), the service with "detached", "Claude" or "Codex" where that
  says something, its ports as links (two, then `+N`) and its memory. A workspace's later services
  leave its column blank, so there is no heading per workspace. Uptime is in the name's tooltip.
  The header carries the total memory.
- Below a rule, the leftovers, grouped by the worktree they ran in (the scan's `worktree`), so the
  stacks of one deleted worktree list together under its name with "2 stacks · 28 days". The
  heading is "Left running after their worktree was deleted" when every group's folder is gone,
  else "Not in a workspace" with "deleted" on the groups that are.
- Last, collapsed, "Started outside Kelpi" (D2).

To come:

- **Amber idle marking** on the sidebar mark (D7: up over 3 days and its agent idle that long, or
  its folder has no workspace), with phase 4's idle data.
- **Stop:** Services ▸ Stop all, the Inspector row's stop button (phase 3, §6).
- **Corner card:** stacks with no workspace at all, with Review and Stop all (phase 4).
- **Phone:** a Services sheet; Stop for the owner; Open is desktop-only (D5), since a phone cannot
  reach the Mac's `localhost` without a daemon proxy (phase 5).
- **Pane chrome presenters** (plugin-ui.md) see the ports badge's fit in `size.badges.ports` but
  not the ports themselves, so a presenter cannot draw the chip yet.

## 8. Build order

1. **Scanner and `kelpi ps`, read-only.** Done.
2. **See them:** the surfaces in §7 and the `running-services` broadcast. Done, bar amber idle
   marking (phase 4).
3. **Stop them:** §6, `kelpi kill`, the palette command, the workspace-delete checkbox.
4. **Cost and leftovers:** CPU from CPU-time deltas, container stats, idle marking, the corner card.
5. **Beyond the desktop:** the phone sheet; services a repo declares with start and stop commands.
