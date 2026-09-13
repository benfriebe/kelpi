# Plugin extensibility: agent handoff

Current as of **2026-09-13**, reviewed against merged main **`2f5e728`**. Start here when
resuming this project in another session. The [roadmap](plugin-roadmap.md) is the overall plan;
the [API guide](plugins.md) describes shipped contracts; the
[validation record](plugin-validation.md) separates tested revisions and evidence.

## Current state

Everything the roadmap's [completed table](plugin-roadmap.md#completed-and-merged) lists through
full Settings presentation is merged into `main` at **`2f5e728`**, and that build is packaged,
promoted and running. Terminal SDK geometry parity, the selectable palette and prompt presenters
and full Settings presentation landed on 2026-09-12 and 2026-09-13, and
[#211](https://github.com/benfriebe/kelpi/pull/211) closed the New Workspace and scenario-lane
defects behind them. Two draft PRs are stacked on that baseline and described below. Plugin API
version remains **1**; wire protocol generation remains **2**. The four placements added by those
phases, `interaction.palette`, `interaction.prompts`, `interaction.notifications` and
`settings.window`, are additive; the notifications placement arrives with
[#214](https://github.com/benfriebe/kelpi/pull/214).

The broader replacement goal is still **not complete**: the remaining UI composition surfaces, a
public registry and distribution, and untrusted execution are open scopes in the roadmap's
[later work](plugin-roadmap.md#later-work-and-open-decisions).

| Item | State at this handoff |
| --- | --- |
| Product baseline | `origin/main` at `2f5e728`, through PR #211. |
| Promoted build | The installed Kelpi under the root checkout was promoted from this baseline. `~/Library/Application Support/kelpid/last-promote.json` reads `"phase": "promoted"` at 2026-09-13T01:41:24Z on port 53358. |
| Open feature branches | Two, both from this session and stacked: `fix/runner-daemon-handle` (PR #213) and `feature/plugin-notification-presenter` (PR #214), in the worktrees below. Merge #213 first. |
| Documentation branch | None of its own; this refresh rides #214's branch. The earlier documentation PRs [#164](https://github.com/benfriebe/kelpi/pull/164) and [#210](https://github.com/benfriebe/kelpi/pull/210) are merged. |
| Running application | The promoted instance is the user's own. Do not package into it, restart it or take its socket without being asked. |

Worktrees under `/Users/ben/kelpi/worktrees/kelpi/`:

| Worktree | Branch | Disposition |
| --- | --- | --- |
| `plugin-terminal-geometry` | `fix/runner-daemon-handle` | PR #213; merges first. Leave it alone. |
| `plugin-settings-contracts` | `feature/plugin-notification-presenter` | PR #214, stacked on #213. In use by this refresh. |

`plugin-interaction-contracts` and `fix-cli-module-type` were removed once their PRs merged and
their local branches deleted. Two cleanups are still the user's to run, because the auto-mode
classifier refuses those commands: the merged remote branches for the finished phases, and the
three `Kelpi-darwin-arm64.pre-promote-*` bundle backups under
`/Users/ben/code/kelpi/packages/shell/out`. Each worktree holds a built vendor bundle and
`node_modules`, so a new task is faster bootstrapped fresh than reused from one of them.

In the current local environment the repository root is `/Users/ben/code/kelpi`. Its main
checkout carries unrelated site work: modified `README.md`, `package.json` and `pnpm-lock.yaml`,
plus untracked `.pnpm-store/`, `packages/site/` and `examples/plugins/geo-map-trainer/`.
Preserve them. Do not reset the root, carry its changes into a feature branch, or clean up the
many older worktrees under `/Users/ben/code/kelpi/.claude/worktrees/` and
`/Users/ben/code/kelpi/out/worktrees/`, which belong to other tasks.

The user's established workflow is isolated worktrees/branches, private instances beside
their installed Kelpi, validation before commits, logical commits and reviewable PR phases.
Draft PR publication is authorized; merging remains the user's step. Delegate bounded audits
or implementation tasks where useful. Update the roadmap, API/example guides and dated
validation together as each phase lands.

## Merged plugin work on main

The previous handoff's baseline was `ab9be92`. These eleven PRs merged on top of it and are the
behaviour a later change must preserve.

| PR | Behavior to preserve |
| --- | --- |
| [#164](https://github.com/benfriebe/kelpi/pull/164) | The roadmap, this handoff and the dated validation record are the documentation contract; each phase updates all three. |
| [#187](https://github.com/benfriebe/kelpi/pull/187) | SDK replay frames carry `grid` (`null` when the daemon states none) and presentation frames carry `ownsSize`; one forced PTY report per ownership hand-off. A pane's measured size stays distinct from the grid being rendered, and an embedded remote pane mirrors its own daemon's owner. |
| [#188](https://github.com/benfriebe/kelpi/pull/188) | The palette session and the shared quick pick, input, dialog and notification requests are one window interaction surface. Request ownership, result validation, cancellation, queueing and window/daemon targeting live there, not in the components. |
| [#189](https://github.com/benfriebe/kelpi/pull/189) | `interaction.palette` and `interaction.prompts` are selectable in Settings only: listed in `ui.getWorkbench().slots`, refused by `ui.selectView`. The bundled presenters cannot be selected away. Password inputs and the notification stack stay bundled whatever is selected; an undeliverable frame fails the presenter rather than arming a watchdog. |
| [#190](https://github.com/benfriebe/kelpi/pull/190) | Interaction Lab and `scripts/scenarios/plugin-interaction-presenters.mjs` are the live acceptance: second-plugin requests, presenter crash and watchdog fallback with the live request intact, reload, disable, and the phone form factor keeping the bundled presenters. Its cleanup restores both placements, the phone's landing page, emulation and the starting workspace. |
| [#191](https://github.com/benfriebe/kelpi/pull/191) | Settings sections and fields are closure-free descriptors with host-owned validation, drafts and routing. Tabs commit through the surface only; the TCP caption is composed from a structured status so no OS error text is projected. |
| [#208](https://github.com/benfriebe/kelpi/pull/208) | `settings.window` is a placement containers are refused, selectable in Settings only. General, Workspaces and Appearance are projected with a host-drawn `part: 'native'` remainder each; Plugins, Remote, Profiles, Keybindings, Labels, Repositories, Web, both key recorders and every destructive confirmation stay native. Projected text fields refuse newline injection into the config file in both client funnels and in the daemon. |
| [#209](https://github.com/benfriebe/kelpi/pull/209) | Settings Lab and `scripts/scenarios/plugin-settings-presenter.mjs` are the live acceptance. The surface owns the requested section and the host refreshes on a routed change; the native remainder sizes to its content rather than splitting the dialog. |
| [#200](https://github.com/benfriebe/kelpi/pull/200) | The packaged CLI and daemon bundles ship an ESM `package.json` beside them, so Node stops warning about the module type. |
| [#210](https://github.com/benfriebe/kelpi/pull/210) | The roadmap and this handoff state one current baseline, one set of open branches and one next-task list. A later refresh replaces those statements rather than appending to them. |
| [#211](https://github.com/benfriebe/kelpi/pull/211) | File > New Workspace, Cmd+N, the palette row and the empty-state button post one request, and the sheet is hosted at window level whenever the bundled Workspaces sidebar is not mounted, so a plugin view holding the sidebar no longer swallows them and the bundled path still renders exactly one sheet ([#201](https://github.com/benfriebe/kelpi/issues/201)). Every scenario restores what it changed, and the runner checks a post-condition after each one and prints a named leak warning attributed to the scenario that added it ([#205](https://github.com/benfriebe/kelpi/issues/205), [#198](https://github.com/benfriebe/kelpi/issues/198)). A scenario can declare a minimum [`windowPlacement`](../scripts/ui-audit/README.md#a-scenario-can-declare-the-placement-it-needs-windowplacement); `plugin-browser-features` and `dock-bounce-stop-only` run offscreen on their own instance because the zero-opacity hidden window drops native input when another window overlaps it ([#206](https://github.com/benfriebe/kelpi/issues/206)). |

Main fixes before that baseline that still matter are recorded in the roadmap: the vendored
engine wrap-linkage fix [#167](https://github.com/benfriebe/kelpi/pull/167), bundled replay
geometry [#168](https://github.com/benfriebe/kelpi/pull/168), and
[#179](https://github.com/benfriebe/kelpi/pull/179) through
[#185](https://github.com/benfriebe/kelpi/pull/185) (first pane in a selected repository, the
actual bound pairing port, the requested Settings tab on reopen, focus-armed awaiting-input
dwell, caret reclaim from chrome text fields, sidebar drag thresholds, and the deferred
heartbeat verdict).

## Open draft PRs

Both are from this session and stack in this order: merge #213, then #214. Publication is
authorized; merging remains the user's step.

| PR | Branch | Behavior it adds |
| --- | --- | --- |
| [#213](https://github.com/benfriebe/kelpi/pull/213) | `fix/runner-daemon-handle`, on `main` | Closes [#199](https://github.com/benfriebe/kelpi/issues/199). The runner hands every scenario `t.daemon`, a restartable primary daemon with `start()`, `stop()` and `restart()` over the sandbox's own run dir, ports, database and token, so the daemon that comes back is the same identity at the same address and the window's reconnect is the behaviour under test. Both presenter scenarios press a real disconnect and reconnect: bundled presenters while the connection is down with nothing latched and both selections retained, both presenters re-attaching, a queued prompt leaving no pending request behind, a fresh prompt settling with its action afterwards, no pre-restart input replayed into the new shell, and a half-typed Settings draft intact with neither config file changed. No product code changes. Full battery passed at `59cbba2` ([the daemon handle](../scripts/ui-audit/README.md#the-daemon-handle-stopping-the-primary-daemon), [validation](plugin-validation.md#daemon-disconnect-coverage-2026-09-13)). |
| [#214](https://github.com/benfriebe/kelpi/pull/214) | `feature/plugin-notification-presenter`, on `fix/runner-daemon-handle` | Closes [#194](https://github.com/benfriebe/kelpi/issues/194). The notification stack becomes its own Settings-only placement, `interaction.notifications`. The presenter declares its box height and the host clamps it to the smaller of 45% of the window and 200 px per visible notice; the frame is not painted at all while the stack is empty; the host keeps the corner rect, registers an overlay rect rather than a modal, and keeps the expiry and result validation; the frame is bounded to the 256 KiB feed with the rest counted in `queued`; native toasts stay bundled. Interaction Lab gains a third view and `plugin-interaction-presenters` grows to 51 checks. Full battery passed at `4377290` ([the notification box](plugin-ui.md#the-notification-box), [validation](plugin-validation.md#selectable-notification-presenter-2026-09-13)). |

## Next tasks

None of these is running on a branch; the two draft PRs above cover the tasks that were. Each
names the code that owns it.

| Task | Owned by |
| --- | --- |
| [#193](https://github.com/benfriebe/kelpi/issues/193) a remote-hosted plugin view is refused this window's navigation (`ui.getNavigation`, `ui.selectWorkspace`). Decide the product rule first: which window such a view navigates, or whether the refusal becomes an explicit contract. | [host UI](../packages/client/src/plugins/host-ui.ts), [PluginView](../packages/client/src/plugins/PluginView.tsx), [public UI types](../packages/plugin-sdk/ui.d.ts) |
| [#212](https://github.com/benfriebe/kelpi/issues/212) the daemon's WebSocket server closes its listener with `server.close()` and no `closeIdleConnections()`, so the renderer's idle keep-alive HTTP sockets hold the shutdown open until the 8 s SIGTERM window ends in SIGKILL, and the kill skips `persistence.close()`, the run-file cleanup and the final `kelpid stopped` line. Found by #213's restart arm, which changed no daemon code; which socket population holds the listener open is still unpinned. | [ws server](../packages/daemon/src/ws/server.ts), [boot compose](../packages/daemon/src/boot/compose.ts), [the daemon handle](../scripts/ui-audit/lib/stack.mjs) |
| The one full-battery leak warning that is not yet inert: `plugin-document-features` leaves the phone's remembered place set (`host configured:DocumentRemote`), printed by every full battery on record. The two terminal warnings beside it name a second daemon those scenarios have already stopped. | [the scenario](../scripts/scenarios/plugin-document-features.mjs), [the post-condition](../scripts/scenario.mjs) |
| An Appearance presenter for the native remainder parts (theme gallery, importer and share codes, colour maps, terminal theme picker, band fill, stat toggles, sparkline colour, highlight preview, Resets). Only if a real plugin needs them. | [sections](../packages/client/src/settings/sections.ts), [presenter host](../packages/client/src/settings/presenter.ts), [public settings types](../packages/plugin-sdk/settings.d.ts) |
| Physical-device checks. Every phone result on record is Electron emulation; real hardware coverage must be reported separately. | the audit's phone steps and `phone-settings-sheet` in [`scripts/ui-audit/audit.mjs`](../scripts/ui-audit/audit.mjs), the phone sections of the plugin scenarios |
| The roadmap's later items: remaining UI composition surfaces, a public registry and distribution, untrusted execution. | [later work](plugin-roadmap.md#later-work-and-open-decisions) |

The remaining open triage issues from the two batteries are audit-step and lane defects rather
than plugin contract gaps: [#192](https://github.com/benfriebe/kelpi/issues/192),
[#202](https://github.com/benfriebe/kelpi/issues/202),
[#203](https://github.com/benfriebe/kelpi/issues/203),
[#204](https://github.com/benfriebe/kelpi/issues/204),
[#206](https://github.com/benfriebe/kelpi/issues/206) and
[#207](https://github.com/benfriebe/kelpi/issues/207).

Source entrypoints for the surfaces those tasks touch:

| Concern | Source entrypoints |
| --- | --- |
| Window interaction surface | [contracts](../packages/client/src/interaction/contract.ts), [surface](../packages/client/src/interaction/surface.ts), [host](../packages/client/src/interaction/InteractionHost.tsx), [bundled prompts](../packages/client/src/interaction/BundledPrompts.tsx), [palette adapter](../packages/client/src/interaction/PaletteHost.tsx), [palette source](../packages/client/src/features/palette-source.ts) |
| Interaction presenter selection and projection | [presenter host](../packages/client/src/interaction/presenter.ts), [presenter slot](../packages/client/src/interaction/presenter-slot.tsx), [public interaction types](../packages/plugin-sdk/interaction.d.ts) |
| Settings model and authority | [contract](../packages/client/src/settings/contract.ts), [sections](../packages/client/src/settings/sections.ts), [surface](../packages/client/src/settings/surface.ts), [field renderer](../packages/client/src/settings/FieldRenderer.tsx) |
| Settings presenter, slot and dialog | [presenter host](../packages/client/src/settings/presenter.ts), [presenter slot](../packages/client/src/settings/presenter-slot.tsx), [Settings overlay](../packages/client/src/settings/SettingsOverlay.tsx) |
| Placements, selection and recovery rows | [protocol placements](../packages/protocol/src/plugins.ts), [registry](../packages/client/src/plugins/registry.ts), [Workbench](../packages/client/src/plugins/Workbench.tsx), [feature definitions](../packages/client/src/features/definitions.ts) |
| Terminal replay geometry and ownership | [PTY connection](../packages/client/src/connection/pty.ts), [terminal host](../packages/client/src/plugins/terminal.ts), [pane adapter](../packages/client/src/plugins/terminal-pane.ts), [terminal types](../packages/plugin-sdk/terminal.d.ts) |
| Public bridge and SDK runtime | [PluginView](../packages/client/src/plugins/PluginView.tsx), [host UI](../packages/client/src/plugins/host-ui.ts), [UI service adapter](../packages/client/src/plugins/ui-services.ts), [SDK runtime](../packages/plugin-sdk/browser.js), [SDK tests](../packages/plugin-sdk/tests) |
| Shipped replacement examples | [Interaction Lab](../examples/plugins/interaction-lab), [Settings Lab](../examples/plugins/settings-lab), [Terminal Lab](../examples/plugins/terminal-lab) |

## Setup and validation for the next agent

1. Check `git status`, fetch `main` and inspect the current head. Read any repository
   instructions in the worktree you will actually edit. Do not work in the root checkout.
2. Follow [checkout preparation](plugin-development.md#prepare-a-source-checkout).
   Build the ignored Ghostty bundle from that checkout's tracked source and patched WASM,
   install its dependencies and run the embedded-WASM check (`vendor-engine.test.ts`). Do not
   reuse an unverified bundle or another worktree's `node_modules`. A fresh worktree has no
   `dist`, so client suites report "no tests" until it is built.
3. Start [a private instance](plugin-development.md#start-a-private-instance) and use its
   printed socket with the checkout CLI and `KELPI_REQUIRE_SOCKET=1`. Terminal Lab additionally
   needs `node scripts/build-terminal-lab.mjs` before manual installation or packing; its
   scenario builds the example automatically. Interaction Lab and Settings Lab are build-free,
   UI-only views.
4. Validate each implementation phase before committing. Record the exact source revision,
   command, pass/fail/skip counts, build/fixture hashes and retained evidence. Update the
   roadmap and relevant API/example guides in the same review sequence.

The current entry commands, covering the merged presenter surfaces:

~~~sh
pnpm check
pnpm --filter @kelpi/plugin-sdk test:package
node scripts/verify-plugin-sdk.mjs
node scripts/scenario.mjs plugin-interaction-presenters plugin-settings-presenter --window hidden
node scripts/scenario.mjs plugin-interaction-presenters plugin-remote plugin-settings-presenter --window hidden
node scripts/scenario.mjs plugin-interaction-presenters plugin-settings-presenter --window onscreen --no-build
node scripts/scenario.mjs plugin-terminal-geometry plugin-terminal-features terminal-mirrors-owner-grid --window hidden
node scripts/scenario.mjs plugin-ui-services plugin-workbench plugin-remote --window hidden --no-build
~~~

The run with `plugin-remote` between the two presenter scenarios is the leak probe: it is what
proves they leave no residual sandbox state, and since PR #211 the runner names any scenario that
does leave some behind.

A Settings change also has to clear the Settings audit steps, which the presenter phases kept
green throughout:

~~~sh
node scripts/ui-audit/audit.mjs --window hidden --only settings-open,settings-tab-general,settings-tab-appearance,settings-tab-labels,settings-tab-profiles,settings-tab-keybindings,settings-tab-web,settings-tab-workspaces,keybinding-record,settings-close,settings-tcp-state,settings-repositories,settings-live-apply,phone-settings-sheet
~~~

That set is **15 steps, 98 assertions** and was `0 failed, 0 step errors` on each settings
branch. Repeat the visible ones onscreen and inspect the General, Appearance and Workspaces
screenshots; hidden-window screenshots do not establish visual correctness. Use `--no-build`
only when source and generated bundles are unchanged since the preceding run. Some steps
cannot run under `--only` because they expect an earlier step's state.

Before declaring a phase fully validated, run the
[verification battery](../scripts/verify.mjs) (`node scripts/verify.mjs --full`), review its
actual audit assertions and record packaged-app results. The full audit can complete while
individual assertions fail. See the [scenario rules](../scripts/ui-audit/README.md#the-rule)
and [evidence policy](plugin-validation.md#reading-the-evidence). Phone emulation and
physical-device coverage must be reported separately. The two batteries covering the merged work
are summarised in the roadmap's [validation status](plugin-roadmap.md#validation-status); the
later of them, at `c4001f3`, is **7,904 root tests passed, 1 skipped**, shell **868 passed**, the
full UI audit at **132 steps, 1,653 assertions, 6 failed, 4 step errors, 113 need eyes** with the
failures tracked as issues, and a packaged smoke of **61 checks**. Neither was rerun at
`2f5e728`. The two draft branches each ran their own: `59cbba2` (#213) in 24.0 minutes and
`4377290` (#214) in 24.4 minutes, both with no component retried, the whole scenario lane green
without the battery's retry, and a packaged smoke of **69 checks**.

### Promoting a build

Only when the user asks. The promote flow that produced the running build was:

1. Package from a clean worktree at `main`, with the battery already green on that tree.
2. Place the bundle at the installed path under the root checkout,
   `/Users/ben/code/kelpi/packages/shell/out/Kelpi-darwin-arm64/Kelpi.app`. The promote script
   keeps the previous bundle beside it as `Kelpi-darwin-arm64.pre-promote-<stamp>`.
3. Run it detached, skipping the repackage and the battery it has already passed:

~~~sh
node scripts/self-upgrade.mjs --detach --no-package --skip-verify \
  --app /Users/ben/code/kelpi/packages/shell/out/Kelpi-darwin-arm64/Kelpi.app
~~~

   `--detach` is what makes this survivable from inside a Kelpi pane: the promote re-execs
   itself outside the pane, the app and daemon it is about to kill, and the pane's session
   resumes on the other side.
4. Read the verdict from `~/Library/Application Support/kelpid/last-promote.json`. `"phase":
   "promoted"` with a fresh `updatedAt` is the success case; the same file names the promote
   and restarter logs to read when it is not. The packaged daemon's stdio goes to `/dev/null`,
   so those logs and `kelpid.js status` are the only account of what it did.

## Starter message for a new session

> Read `docs/plugin-handoff.md` and `docs/plugin-roadmap.md` on `main`. Everything through full
> Settings presentation is merged at `2f5e728` and that build is promoted and running, so
> preserve the dirty root checkout and the installed Kelpi and do not promote anything.
> Recheck `main` and the open issues before you start. Two draft PRs are stacked and waiting on
> me, #213 (`fix/runner-daemon-handle`) and then #214
> (`feature/plugin-notification-presenter`), so leave those branches and their worktrees alone.
> Pick up from the handoff's Next tasks in a fresh isolated worktree, bootstrapping the vendor
> bundle from source rather than reusing another worktree's. Use logical commits and reviewable
> PR phases, update the roadmap, guides and dated validation together, and leave merging to me.
