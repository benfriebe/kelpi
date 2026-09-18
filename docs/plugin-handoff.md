# Plugin extensibility: agent handoff

Current as of **2026-09-18**, reviewed against merged main **`24eab65`**. Start here when
resuming this project in another session. The [roadmap](plugin-roadmap.md) is the overall plan;
the [API guide](plugins.md) describes shipped contracts; the
[validation record](plugin-validation.md) separates tested revisions and evidence.

## Current state

Everything the roadmap's [completed table](plugin-roadmap.md#completed-and-merged) lists through
full Settings presentation is merged into `main` at **`24eab65`**, and that build is packaged,
promoted and running. Terminal SDK geometry parity, the selectable palette and prompt presenters
and full Settings presentation landed on 2026-09-12 and 2026-09-13, and
[#211](https://github.com/benfriebe/kelpi/pull/211) closed the New Workspace and scenario-lane
defects behind them. Daemon disconnect coverage
([#213](https://github.com/benfriebe/kelpi/pull/213)) and the selectable notification presenter
([#214](https://github.com/benfriebe/kelpi/pull/214)) merged after it, and no plugin branch is open
now. Plugin API version remains **1**; wire protocol generation remains **2**. The four placements
added by those phases, `interaction.palette`, `interaction.prompts`, `interaction.notifications`
and `settings.window`, are additive.

The broader replacement goal is still **not complete**: the remaining UI composition surfaces, a
public registry and distribution, and untrusted execution are open scopes in the roadmap's
[later work](plugin-roadmap.md#later-work-and-open-decisions).

| Item | State at this handoff |
| --- | --- |
| Product baseline | `origin/main` at `24eab65`, through PR #240. |
| Promoted build | The installed Kelpi under the root checkout was promoted from this baseline on 2026-09-18. `~/Library/Application Support/kelpid/last-promote.json` reads `"phase": "promoted"` at 2026-09-18T02:23:22Z on port 53358. |
| Open feature branches | None. #213, #214, #218 and #240 have all merged, and nothing plugin-side is running on a branch. |
| Documentation branch | `docs/roadmap-after-lane-hygiene`, at `main`, carrying this refresh. The earlier documentation PRs [#164](https://github.com/benfriebe/kelpi/pull/164) and [#210](https://github.com/benfriebe/kelpi/pull/210) are merged. |
| Running application | The promoted instance is the user's own. Do not package into it, restart it or take its socket without being asked. |

Worktrees under `/Users/ben/kelpi/worktrees/kelpi/`:

| Worktree | Branch | Disposition |
| --- | --- | --- |
| `plugin-settings-contracts` | `docs/roadmap-after-lane-hygiene`, at `main` | The only one left. It packaged the promoted build from `main` and now carries this documentation refresh. |

`plugin-terminal-geometry`, `plugin-interaction-contracts` and `fix-cli-module-type` were removed
once their PRs merged and their local branches were deleted, and the three
`Kelpi-darwin-arm64.pre-promote-*` bundle backups under
`/Users/ben/code/kelpi/packages/shell/out` are deleted. One cleanup is still the user's to run,
because the auto-mode classifier refuses that command: the merged remote branches for the finished
phases. The remaining worktree holds a built vendor bundle and `node_modules`, so a new task is
faster bootstrapped fresh than reused from it.

In the current local environment the repository root is `/Users/ben/code/kelpi`. Its main
checkout carries unrelated site work: modified `README.md`, `package.json` and `pnpm-lock.yaml`,
plus untracked `.pnpm-store/`, `packages/site/` and `examples/plugins/geo-map-trainer/`.
Preserve them. Do not reset the root, carry its changes into a feature branch, or clean up the
many older worktrees under `/Users/ben/code/kelpi/.claude/worktrees/` and
`/Users/ben/code/kelpi/out/worktrees/`, which belong to other tasks.

The user's established workflow is isolated worktrees/branches, private instances beside
their installed Kelpi, validation before commits, logical commits and reviewable PR phases.
Draft PR publication is authorized; merging remains the user's step. Check `origin/main` for a
parallel fix before dispatching an issue: sibling sessions work this same repository, and the #235
fix landed twice, once as [#238](https://github.com/benfriebe/kelpi/pull/238) on main and once as
the same diagnosis reached independently in the lane work. Delegate bounded audits
or implementation tasks where useful. Update the roadmap, API/example guides and dated
validation together as each phase lands.

## Merged plugin work on main

The previous handoff's baseline was `ab9be92`. These sixteen PRs merged on top of it and are the
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
| [#213](https://github.com/benfriebe/kelpi/pull/213) | The runner hands every scenario `t.daemon`, a restartable primary daemon over the sandbox's own run dir, ports, database and token, and both presenter scenarios press a real disconnect: bundled presenters while the connection is down with nothing latched and both selections retained, both presenters re-attaching, a queued prompt leaving no pending request behind, no pre-restart input replayed into the new shell, and a half-typed Settings draft intact with neither config file changed ([#199](https://github.com/benfriebe/kelpi/issues/199)). |
| [#214](https://github.com/benfriebe/kelpi/pull/214) | `interaction.notifications` is its own Settings-only placement. The presenter declares its box height and the host clamps it to the smaller of 45% of the window and 200 px per visible notice, paints no frame at all while the stack is empty, keeps the corner rect as an overlay rather than a modal, keeps the 10 second expiry and result validation, and bounds the frame to the 256 KiB feed with the rest counted in `queued`; native toasts stay bundled ([#194](https://github.com/benfriebe/kelpi/issues/194)). |
| [#218](https://github.com/benfriebe/kelpi/pull/218) | The daemon's WebSocket server closes its remaining connections at stop, `closeIdleConnections()` the moment the listener closes and, after a 250 ms grace, `closeAllConnections()` plus a destroy of every accepted socket, so a shutdown never waits out the SIGTERM window and `persistence.close()`, the run-file cleanup and the final `kelpid stopped` line always run. The WebSocket goodbye path is unchanged ([#212](https://github.com/benfriebe/kelpi/issues/212)). |
| [#238](https://github.com/benfriebe/kelpi/pull/238) | A plugin terminal notifies the pane registry when its presentation changes rather than on every render, so the phone shell's size-control read no longer re-enters the pane through its own announcement until React cuts the cycle off at fifty nested updates and blanks the window; a renderer exception is reported as its own named scenario failure ([#235](https://github.com/benfriebe/kelpi/issues/235)). |
| [#240](https://github.com/benfriebe/kelpi/pull/240) | Every phone scenario's cleanup returns the phone to its landing page first, through one shared `phoneToLanding` that waits, taps and re-checks for bounded rounds under a 12 s cap and notes when more than one tap was needed, so a remembered place cannot leak into the next scenario ([#205](https://github.com/benfriebe/kelpi/issues/205) and [#198](https://github.com/benfriebe/kelpi/issues/198), with #211). |

Main fixes before that baseline that still matter are recorded in the roadmap: the vendored
engine wrap-linkage fix [#167](https://github.com/benfriebe/kelpi/pull/167), bundled replay
geometry [#168](https://github.com/benfriebe/kelpi/pull/168), and
[#179](https://github.com/benfriebe/kelpi/pull/179) through
[#185](https://github.com/benfriebe/kelpi/pull/185) (first pane in a selected repository, the
actual bound pairing port, the requested Settings tab on reopen, focus-armed awaiting-input
dwell, caret reclaim from chrome text fields, sidebar drag thresholds, and the deferred
heartbeat verdict).

## Open branches

None. The four PRs this project had in flight since the last refresh are all merged into the
baseline above and recorded in the table before it: [#213](https://github.com/benfriebe/kelpi/pull/213)
and [#214](https://github.com/benfriebe/kelpi/pull/214) on 2026-09-14,
[#218](https://github.com/benfriebe/kelpi/pull/218) the same day, and
[#240](https://github.com/benfriebe/kelpi/pull/240) on 2026-09-18. Each carried its own full
battery, listed in the roadmap's [validation status](plugin-roadmap.md#validation-status). From
2026-09-18 a merge is a squash merge only (`gh pr merge --squash`), which is how #240 landed, so a
finished branch is one commit on `main`. Publication of a draft PR stays authorized; merging
remains the user's step.

## Next tasks

None of these is running on a branch, and nothing plugin-side is waiting on a review. Each names
the code that owns it.

| Task | Owned by |
| --- | --- |
| [#193](https://github.com/benfriebe/kelpi/issues/193) a remote-hosted plugin view is refused this window's navigation (`ui.getNavigation`, `ui.selectWorkspace`). Decide the product rule first: which window such a view navigates, or whether the refusal becomes an explicit contract. | [host UI](../packages/client/src/plugins/host-ui.ts), [PluginView](../packages/client/src/plugins/PluginView.tsx), [public UI types](../packages/plugin-sdk/ui.d.ts) |
| The three leak warnings a full lane still prints, all of them inert: `plugin-terminal-features` and `plugin-terminal-geometry` on the `terminal` slot, `plugin-document-features` on `document.markdown`, each naming a lab view left in the store of a second daemon the scenario has already stopped and deleted. Silencing one means re-selecting the remote host and driving Settings a second time inside a cleanup path, which is why [#240 left them reported](plugin-validation.md#the-remaining-workbench-slot-warnings-are-left-as-they-are). | [the slot helper](../scripts/ui-audit/lib/workbench.mjs), [the post-condition](../scripts/scenario.mjs) |
| An Appearance presenter for the native remainder parts (theme gallery, importer and share codes, colour maps, terminal theme picker, band fill, stat toggles, sparkline colour, highlight preview, Resets). Only if a real plugin needs them. | [sections](../packages/client/src/settings/sections.ts), [presenter host](../packages/client/src/settings/presenter.ts), [public settings types](../packages/plugin-sdk/settings.d.ts) |
| Physical-device checks. Every phone result on record is Electron emulation; real hardware coverage must be reported separately. | the audit's phone steps and `phone-settings-sheet` in [`scripts/ui-audit/audit.mjs`](../scripts/ui-audit/audit.mjs), the phone sections of the plugin scenarios |
| The roadmap's later items: remaining UI composition surfaces, a public registry and distribution, untrusted execution. | [later work](plugin-roadmap.md#later-work-and-open-decisions) |

The open triage issues from the two batteries are down to two, both audit-side or lane defects
rather than plugin contract gaps: [#206](https://github.com/benfriebe/kelpi/issues/206), a
web-batch-pickup click that made no pick, and
[#207](https://github.com/benfriebe/kelpi/issues/207), a paste chord missed once.

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
physical-device coverage must be reported separately. The batteries covering the merged work are
summarised in the roadmap's [validation status](plugin-roadmap.md#validation-status). The two that
carry the presenter phases stay as history: the later of them, at `c4001f3`, is **7,904 root tests
passed, 1 skipped**, shell **868 passed**, the full UI audit at **132 steps, 1,653 assertions, 6
failed, 4 step errors, 113 need eyes** with the failures tracked as issues, and a packaged smoke of
**61 checks**; neither was rerun after its own revision. The four batteries since ran on the
branches that merged into this baseline: `59cbba2` (#213) in 24.0 minutes, `4377290` (#214) in 24.4
minutes, `ec8a928` (#218) in 24.0 minutes with `2a82f8c` before its amendments in 24.9 minutes, and
`165230b` then `2b46ba0` (#240) in 25.1 and 24.8 minutes. None of them retried a component, the
whole scenario lane was green without the battery's retry, the full audit completed with no failed
step, and the packaged smoke was **69 checks**.

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
> Settings presentation, the notification presenter and daemon disconnect coverage is merged at
> `24eab65` and that build is promoted and running, so preserve the dirty root checkout and the
> installed Kelpi and do not promote anything. Recheck `main` and the open issues before you
> start, and check `origin/main` for a parallel fix before you dispatch one, because other
> sessions work this same repository. No plugin branch is open. Pick up from the handoff's Next
> tasks in a fresh isolated worktree, bootstrapping the vendor bundle from source rather than
> reusing another worktree's. Use logical commits and reviewable PR phases, update the roadmap,
> guides and dated validation together, and leave merging to me.
