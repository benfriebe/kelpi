# Plugin extensibility: agent handoff

Current as of **2026-09-24**, reviewed against merged main **`058c8f4`**. Start here when
resuming this project in another session. The [roadmap](plugin-roadmap.md) is the overall plan;
the [API guide](plugins.md) describes shipped contracts; the
[validation record](plugin-validation.md) separates tested revisions and evidence.

## Current state

Everything the roadmap's [completed table](plugin-roadmap.md#completed-and-merged) lists is merged
into `main`: pane search as [#262](https://github.com/benfriebe/kelpi/pull/262) (`39e6f5b`), plugin
commands in Help as [#261](https://github.com/benfriebe/kelpi/pull/261) (`37703e6`), and root layout
composition as [#263](https://github.com/benfriebe/kelpi/pull/263) (`058c8f4`), squash-merged in that
order on 2026-09-24 over **`225ef73`**. Pane chrome landed in two PRs on 2026-09-18 and
2026-09-19 - [#243](https://github.com/benfriebe/kelpi/pull/243) (the shared model, the height
authority, parking and the projection) and [#244](https://github.com/benfriebe/kelpi/pull/244) (the
selectable presenter, Pane Lab and its live acceptance) - and fourteen PRs merged on top of them
through [#260](https://github.com/benfriebe/kelpi/pull/260). One of those is a plugin contract:
[#253](https://github.com/benfriebe/kelpi/pull/253) lets a remote-hosted view use window navigation
when its saved host is trusted for it, which closes [#193](https://github.com/benfriebe/kelpi/issues/193).
The rest are product and audit work, listed in the roadmap so the baseline is accounted for.

No plugin branch is open. The three that ran in parallel, each in its own worktree, merged one
after another: `feature/plugin-pane-search` (#262), `feature/help-plugin-shortcuts` (#261) and
`feature/plugin-root-layout` (#263). Each merge commit's tree is identical to the head its evidence
was taken on, and `058c8f4`'s code is the combined build the owner tested by hand before the merges
(see the
[merge and promote record](plugin-validation.md#merge-and-promote-of-262-261-and-263-2026-09-24)).

Plugin API version remains **1**; wire protocol generation remains **2**. The six placements added
by the presenter phases - `interaction.palette`, `interaction.prompts`, `interaction.notifications`,
`settings.window`, `pane.chrome` and `pane.search` - are all additive.

The broader replacement goal is still **not complete**: the remaining UI composition surfaces, a
public registry and distribution, and untrusted execution are open scopes in the roadmap's
[later work](plugin-roadmap.md#later-work-and-open-decisions).

| Item | State at this handoff |
| --- | --- |
| Product baseline | `origin/main` at `058c8f4` (#263, over #261's `37703e6` and #262's `39e6f5b`). |
| Promoted build | `058c8f4`, promoted 2026-09-24 at 11:31 UTC at the owner's request **without the integration battery**: it was started on `058c8f4` and stopped mid-run when the owner asked to skip it, so it has no result. The evidence behind the promote is in the [merge and promote record](plugin-validation.md#merge-and-promote-of-262-261-and-263-2026-09-24). The promote before it was `225ef73` on 2026-09-23, after an integration battery. `~/Library/Application Support/kelpid/last-promote.json` holds the phase and the timestamp; read it rather than trusting this row after a later promote. |
| Open feature branches | None. #262 (search), #261 (Help) and #263 (root layout) are merged; #243, #244 and #246 through #260 merged before them. |
| Documentation branch | `docs/ui-composition-after-merge`, this refresh after the three merges. The earlier documentation PRs [#164](https://github.com/benfriebe/kelpi/pull/164), [#210](https://github.com/benfriebe/kelpi/pull/210) and [#242](https://github.com/benfriebe/kelpi/pull/242) are merged. |
| Merge gate | The repository ruleset "Kelpi PR readiness", which required a hand-posted `kelpi/pr-readiness` status on `main`, was **disabled by the owner on 2026-09-24**; a PR now needs only GitHub's own mergeability. The auto-mode classifier refuses to let an agent post commit statuses or change rulesets, and it refused `gh pr merge` until the owner approved each one, so merging stays the owner's step. |
| Running application | The promoted instance is the user's own. Do not package into it, restart it or take its socket without being asked. |

Worktrees under `/Users/ben/kelpi/worktrees/kelpi/`:

| Worktree | Branch | Disposition |
| --- | --- | --- |
| `plugin-settings-contracts` | `feature/plugin-pane-search` | Carried pane chrome and the search presenter, merged as #262. |
| `plugin-root-layout` | `feature/plugin-root-layout` | Root layout composition, merged as #263. |
| `help-plugin-shortcuts` | `feature/help-plugin-shortcuts` | Plugin commands and shortcuts in the Help overlay, merged as #261. |
| `ui-composition-integration` | `integration/ui-composition-20260924` (local only, never pushed) | The three branches merged together for the owner's single manual test, with the one cross-branch fix (Layout Lab's chrome fixture needed Help's `keymap` field) that #263's rebase then carried. Nothing in it is needed any more. |
| `main-058c8f4` | `docs/ui-composition-after-merge` | Packaged the promoted build at `058c8f4` and carries this refresh. |

All five are finished and can be removed once this refresh merges; their remote branches were
deleted on merge. Four `Kelpi-darwin-arm64.pre-promote-*` bundle backups sit under
`/Users/ben/code/kelpi/packages/shell/out` (three from 2026-09-19 and
`pre-promote-20260924T213102`, the bundle this promote replaced, which is `225ef73`); removing them
is the owner's call. A new task is faster bootstrapped in a fresh worktree than reused from one of
these.

In the current local environment the repository root is `/Users/ben/code/kelpi`. Its main
checkout carries another session's uncommitted edit to `docs/plugin-roadmap.md`. It was written
against `225ef73` before #262, #261 and #263 merged, so it is superseded (committing it would put
"no `pane.search` placement yet" back into the roadmap); it is still not this project's to discard,
so leave it for the owner. Do not reset the root, carry its changes into a feature branch, or clean up the
many older worktrees under `/Users/ben/code/kelpi/.claude/worktrees/` and
`/Users/ben/code/kelpi/out/worktrees/`, which belong to other tasks.

The user's established workflow is isolated worktrees/branches, private instances beside
their installed Kelpi, validation before commits, logical commits and reviewable PR phases.
Draft PR publication is authorized; merging remains the user's step. Delegate bounded audits or
implementation tasks where useful. Update the roadmap, API/example guides and dated validation
together as each phase lands.

Six workflow lessons, each of which has already cost a round:

1. **Reinstall an example plugin in a private instance after every change to it.** An installed
   example is a COPY, and a running instance keeps using the copy it installed. Editing the files in
   `examples/plugins/…` changes nothing in a window that is already up; reinstall the path, or
   `kelpi plugin reload <id>`.
2. **Never run the battery while the owner is testing a second Kelpi window.** The #244 run at
   `6d70e6e` went red twice on `dock-bounce-stop-only` and `plugin-browser-features` under exactly
   those conditions and green alone minutes later. The lane competes for window focus and native
   input; a quiet machine is part of the measurement.
3. **A drag or a focus transfer that starts inside an iframe needs a MANUAL test.** CDP hit-tests
   every synthesized event and keeps no per-frame pointer capture or focus model, so a scripted
   gesture teleports between documents where a real one cannot. #244's first drag check passed
   against a design a real mouse could not drive; pane search asserts the caret through its
   consequence and names the manual steps in the validation record.
4. **Squash merges only** (`gh pr merge --squash`), so a finished branch is one commit on `main`.
5. **Check `origin/main` for a parallel fix before dispatching an issue.** Sibling sessions work
   this same repository: the #235 fix landed twice, once as
   [#238](https://github.com/benfriebe/kelpi/pull/238) and once as the same diagnosis reached
   independently in the lane work.
6. **Keep a private instance's `--state` path short.** The daemon's Unix socket lives at
   `<state>/run/daemon-v2.sock` and macOS caps a socket path at 104 bytes, so a state directory deep
   under a worktree (`.../out/ui-composition-playground`) fails with `listen EINVAL` and the launcher
   only reports a health-check timeout. Use something like `~/tmp/kelpi-<task>`.

## Merged plugin work on main

The previous handoff's baseline was `ab9be92`. These twenty-three PRs merged on top of it and are the
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
| [#243](https://github.com/benfriebe/kelpi/pull/243) | A pane's header is ONE closure-free descriptor with one write path, and the bundled header draws from it with its DOM, classes and test ids unchanged. The band is per-pane and host-clamped to the smaller of 96 px and a quarter of the pane, with the native 24 px until something declares, so the body rect, a terminal's cols and rows and a web pane's native bounds all follow one number; a taller band over a web pane parks the page. The `pane.chrome` frame is a PREFIX of the workspace with the rest counted, and every control and item in it is an opaque per-frame ref rather than a contribution id. |
| [#244](https://github.com/benfriebe/kelpi/pull/244) | `pane.chrome` is Settings-only with a "(bundled)" recovery entry. ONE frame is mounted over the pane grid and clipped by the host to the bands it granted, so a click below a band still reaches the terminal under it. The band, its fill, the focus ring, the pane menu, the rename field, the dividers, the resize badge, the clip wash and the find bar stay the host's. Failure is all-or-nothing and drops every declared band in the same commit. A declaration is withdrawn from an UNMOUNT cleanup, never a render branch; the native header stays until the presenter has painted; a ref is per key rather than per row position; and the pane-move drag is host surfaces over presenter-declared regions, because a press inside an iframe never leaves it. |
| [#246](https://github.com/benfriebe/kelpi/pull/246) | ⌘+, ⌘- and ⌘0 step the daemon-wide terminal text size. Product work on the terminal rather than a plugin contract: it has no roadmap row and no dated validation section. It and the thirteen PRs after it through #260, all but #253 product or audit work, are named in the roadmap so the baseline is accounted for. |
| [#253](https://github.com/benfriebe/kelpi/pull/253) | A remote-hosted plugin view reaches this window's navigation (`ui.getNavigation`, `ui.onNavigation`, `ui.selectWorkspace`) only while its saved host is trusted for it in Settings ▸ Remote ▸ Daemons. The grant is per saved host, bound to its exact name and pairing URL, saved with the primary daemon's remote-host registry, revoked when that record is replaced or removed, and rechecked at delivery as well as at attachment; every other API stays denied to those views ([#193](https://github.com/benfriebe/kelpi/issues/193)). |
| [#262](https://github.com/benfriebe/kelpi/pull/262) | `pane.search` is Settings-only with a "(bundled)" recovery entry and covers SHELL panes only. The daemon's search state stays the authority: the frame's `needle` is the daemon's or the one this window typed that is still in transit, and a presenter holds none of it. The host owns the box (min(480 px, pane width) by min(96 px, 25 %)), relays Escape, the toggle chord, ⌘G and ⇧⌘G (⌘G only while the frame or the searched pane holds the caret), and returns the caret when the SESSION ends. A failure brings back the native bar with the needle intact, focused and case-insensitive; the caret reclaim that follows is bounded and stops on a press, a key elsewhere or a plugin frame taking the pointer. The daemon drops a terminal-search recount that a newer needle, case flag, open or close has superseded. Both presenter slots read their painted latch unconditionally (no conditional hook). |
| [#261](https://github.com/benfriebe/kelpi/pull/261) | Help stays host-drawn and lists plugin commands with the chord the window actually honours, from ONE keymap model that the chrome snapshot also publishes read-only as `keymap`, bounded to 64 KiB. The plugin half is the dispatcher's own resolution (`resolvePluginChords`) and the reserved set comes from `nativeChordOwners`, so Help cannot name a chord that would not fire. The keymap is copied, frozen and serialized once per identity, not on every chrome publish. |
| [#263](https://github.com/benfriebe/kelpi/pull/263) | topbar, statusbar and panel.bottom have a hidden flag separate from the selection, the two sidebars join the persisted arrangement (`kelpi.workbench.layout.v1:<id>`, per window, not live-synced), and Zen Mode snapshots and restores all five. The 8 px restore strip is host-drawn and can never be hidden. Band heights are manifest-declared (`bandHeights`) and range-checked at install, not declared at runtime. Traffic lights follow the toolbar through the window-scoped `window-chrome` report and come back on navigation or disconnect. A trigger naming both `ctrl` and `super` is unbound off macOS, in the client map, the shell menu and the web host's claim. |

Main fixes before that baseline that still matter are recorded in the roadmap: the vendored
engine wrap-linkage fix [#167](https://github.com/benfriebe/kelpi/pull/167), bundled replay
geometry [#168](https://github.com/benfriebe/kelpi/pull/168), and
[#179](https://github.com/benfriebe/kelpi/pull/179) through
[#185](https://github.com/benfriebe/kelpi/pull/185) (first pane in a selected repository, the
actual bound pairing port, the requested Settings tab on reopen, focus-armed awaiting-input
dwell, caret reclaim from chrome text fields, sidebar drag thresholds, and the deferred
heartbeat verdict).

## Open branches

None. Three were worked in parallel in their own worktrees and merged one after another:

- `feature/plugin-pane-search`, merged as [#262](https://github.com/benfriebe/kelpi/pull/262): the
  pane chrome latch fix, the selectable search presenter, Search Lab and its live acceptance, the
  daemon recount fix, the review fixes and the surface docs, through two independent reviews. Its
  tested revision is `68c2b0d`, and its full battery passed unretried at `a209603` (the same code)
  in 26.4 minutes.
- `feature/help-plugin-shortcuts`, merged as [#261](https://github.com/benfriebe/kelpi/pull/261):
  plugin commands and shortcuts in the Help overlay, with the keybinding map read-only in the chrome
  snapshot. Its full battery passed unretried at `6fde921` in 25.6 minutes (one audit assertion
  attributed to load, green 3/3 alone); its rebase onto `39e6f5b` changed docs only.
- `feature/plugin-root-layout`, merged as [#263](https://github.com/benfriebe/kelpi/pull/263):
  hideable root bands, Zen Mode, declared band heights and the persisted arrangement, Layout Lab and
  its live acceptance, one independent review. Its full battery passed unretried at `e7d9de1` in
  25.9 minutes, before the rebase; the first, at `819da74`, failed on a scenario's synchronization,
  which the [validation record](plugin-validation.md#root-layout-hidden-bands-zen-mode-and-band-heights-2026-09-24)
  traces. Its rebase over #262 and #261 resolved the additive `App.tsx`, `Workbench.tsx` and
  test-fixture conflicts exactly as the owner-tested combined build had, including the Layout Lab
  fixture's new `keymap` field.

The roadmap and this handoff are edited by every branch, so each keeps its refresh as its own last
commit and a later branch rebases over an earlier merge by replacing that one commit. Everything
else this project had in flight is merged into the baseline above and recorded in the table before
it. Each carried its own full battery, listed in the roadmap's
[validation status](plugin-roadmap.md#validation-status). From 2026-09-18 a merge is a squash merge
only (`gh pr merge --squash`), which is how #240, #243 and #244 landed, so a finished branch is one
commit on `main`. Publication of a draft PR stays authorized; merging remains the user's step.

## Next tasks

None of these is running on a branch. Each names the code that owns it.

| Task | Owned by |
| --- | --- |
| A full battery on `main` at or after `058c8f4`. No battery has run on the three branches merged together: each passed its own, and the combined tree passed typecheck, the root and shell suites and the seven scenarios the three branches touch, but the integration battery was stopped at the owner's request. Run it in a quiet window before the next promote and record it. | [`scripts/verify.mjs`](../scripts/verify.mjs) |
| [#245](https://github.com/benfriebe/kelpi/issues/245) layout-aware chords. Named here because pane chrome and pane search both sharpened it: a presenter's frame consumes what it is not granted, so which chords a surface relays is now a per-placement decision rather than one rule. | [pane search slot](../packages/client/src/pane-search/presenter-slot.tsx), [interaction slot](../packages/client/src/interaction/presenter-slot.tsx), [key dispatcher](../packages/client/src/chrome/keys.ts) |
| The three leak warnings a full lane still prints, all of them inert: `plugin-terminal-features` and `plugin-terminal-geometry` on the `terminal` slot, `plugin-document-features` on `document.markdown`, each naming a lab view left in the store of a second daemon the scenario has already stopped and deleted. Silencing one means re-selecting the remote host and driving Settings a second time inside a cleanup path, which is why [#240 left them reported](plugin-validation.md#the-remaining-workbench-slot-warnings-are-left-as-they-are). | [the slot helper](../scripts/ui-audit/lib/workbench.mjs), [the post-condition](../scripts/scenario.mjs) |
| An Appearance presenter for the native remainder parts (theme gallery, importer and share codes, colour maps, terminal theme picker, band fill, stat toggles, sparkline colour, highlight preview, Resets). Only if a real plugin needs them. | [sections](../packages/client/src/settings/sections.ts), [presenter host](../packages/client/src/settings/presenter.ts), [public settings types](../packages/plugin-sdk/settings.d.ts) |
| Physical-device checks. Every phone result on record is Electron emulation; real hardware coverage must be reported separately. | the audit's phone steps and `phone-settings-sheet` in [`scripts/ui-audit/audit.mjs`](../scripts/ui-audit/audit.mjs), the phone sections of the plugin scenarios |
| The roadmap's later items: a public registry and distribution, and untrusted execution. The remaining UI composition surfaces are done (#262, #261, #263), the phone shell and the Help overlay's frame decided against. | [later work](plugin-roadmap.md#later-work-and-open-decisions) |

The open issues this project touches at this baseline are
[#245](https://github.com/benfriebe/kelpi/issues/245) (layout-aware chords),
[#206](https://github.com/benfriebe/kelpi/issues/206) (a web-batch-pickup click that made no pick)
and [#207](https://github.com/benfriebe/kelpi/issues/207) (a paste chord missed once). #206 and #207
are audit-side or lane defects rather than plugin contract gaps. #193 was closed by #253.

Source entrypoints for the surfaces those tasks touch:

| Concern | Source entrypoints |
| --- | --- |
| Window interaction surface | [contracts](../packages/client/src/interaction/contract.ts), [surface](../packages/client/src/interaction/surface.ts), [host](../packages/client/src/interaction/InteractionHost.tsx), [bundled prompts](../packages/client/src/interaction/BundledPrompts.tsx), [palette adapter](../packages/client/src/interaction/PaletteHost.tsx), [palette source](../packages/client/src/features/palette-source.ts) |
| Interaction presenter selection and projection | [presenter host](../packages/client/src/interaction/presenter.ts), [presenter slot](../packages/client/src/interaction/presenter-slot.tsx), [public interaction types](../packages/plugin-sdk/interaction.d.ts) |
| Pane chrome model, band and presenter | [contract](../packages/client/src/pane-chrome/contract.ts), [model](../packages/client/src/pane-chrome/model.ts), [band store](../packages/client/src/pane-chrome/height.ts), [presenter host](../packages/client/src/pane-chrome/presenter.ts), [presenter slot](../packages/client/src/pane-chrome/presenter-slot.tsx), [public types](../packages/plugin-sdk/pane-chrome.d.ts) |
| Pane search contract, box and presenter | [contract](../packages/client/src/pane-search/contract.ts), [box store](../packages/client/src/pane-search/box.ts), [projection](../packages/client/src/pane-search/projection.ts), [presenter host](../packages/client/src/pane-search/presenter.ts), [presenter slot](../packages/client/src/pane-search/presenter-slot.tsx), [the native bar](../packages/client/src/grid/PaneSearchOverlay.tsx), [the daemon's search channel](../packages/daemon/src/ws/search.ts), [public types](../packages/plugin-sdk/pane-search.d.ts) |
| Settings model and authority | [contract](../packages/client/src/settings/contract.ts), [sections](../packages/client/src/settings/sections.ts), [surface](../packages/client/src/settings/surface.ts), [field renderer](../packages/client/src/settings/FieldRenderer.tsx) |
| Settings presenter, slot and dialog | [presenter host](../packages/client/src/settings/presenter.ts), [presenter slot](../packages/client/src/settings/presenter-slot.tsx), [Settings overlay](../packages/client/src/settings/SettingsOverlay.tsx) |
| Placements, selection and recovery rows | [protocol placements](../packages/protocol/src/plugins.ts), [registry](../packages/client/src/plugins/registry.ts), [Workbench](../packages/client/src/plugins/Workbench.tsx), [feature definitions](../packages/client/src/features/definitions.ts) |
| Root arrangement (hidden bands, Zen Mode, band heights) | [model and store](../packages/client/src/plugins/arrangement.ts), [Workbench](../packages/client/src/plugins/Workbench.tsx), [restore strip](../packages/client/src/chrome/RestoreStrip.tsx), [window actions](../packages/core/src/config/actions.ts), [traffic lights](../packages/shell/src/titlebar.ts), [plugin guide](plugins.md#hiding-bands-and-zen-mode) |
| Terminal replay geometry and ownership | [PTY connection](../packages/client/src/connection/pty.ts), [terminal host](../packages/client/src/plugins/terminal.ts), [pane adapter](../packages/client/src/plugins/terminal-pane.ts), [terminal types](../packages/plugin-sdk/terminal.d.ts) |
| Public bridge and SDK runtime | [PluginView](../packages/client/src/plugins/PluginView.tsx), [host UI](../packages/client/src/plugins/host-ui.ts), [UI service adapter](../packages/client/src/plugins/ui-services.ts), [SDK runtime](../packages/plugin-sdk/browser.js), [SDK tests](../packages/plugin-sdk/tests) |
| Shipped replacement examples | [Interaction Lab](../examples/plugins/interaction-lab), [Settings Lab](../examples/plugins/settings-lab), [Terminal Lab](../examples/plugins/terminal-lab), [Pane Lab](../examples/plugins/pane-lab), [Search Lab](../examples/plugins/search-lab), [Layout Lab](../examples/plugins/layout-lab) |

## Setup and validation for the next agent

1. Check `git status`, fetch `main` and inspect the current head. Read any repository
   instructions in the worktree you will actually edit. Do not work in the root checkout.
2. Follow [checkout preparation](plugin-development.md#prepare-a-source-checkout): one
   `pnpm install --frozen-lockfile` (or `--offline`). The vendored Ghostty bundle
   (`vendor/ghostty-web-patched/dist`) is committed, so a fresh worktree already has it; rebuild it
   with `pnpm vendor:build` only after changing `vendor/ghostty-web-patched/source/` or its WASM,
   and run the embedded-WASM check (`vendor-engine.test.ts`) when you do. Do not reuse another
   worktree's `node_modules`.
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
node scripts/scenario.mjs plugin-pane-chrome plugin-pane-search --window hidden
node scripts/scenario.mjs plugin-pane-search plugin-remote --window hidden --no-build
node scripts/scenario.mjs plugin-terminal-geometry plugin-terminal-features terminal-mirrors-owner-grid --window hidden
node scripts/scenario.mjs plugin-ui-services plugin-workbench plugin-remote --window hidden --no-build
node scripts/scenario.mjs plugin-root-layout plugin-chrome-features plugin-workbench sidebar-swap --window hidden
~~~

`plugin-root-layout` declares an offscreen placement and boots an instance of its own when the lane
is hidden; `plugin-chrome-features` carries Help's keymap checks.

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
step, and the packaged smoke was **69 checks**. The three composition branches followed the same
way: `a209603` (#262) in 26.4 minutes, `6fde921` (#261) in 25.6 minutes with one audit assertion
attributed to load, and `e7d9de1` (#263) in 25.9 minutes after `819da74` failed on a scenario's
synchronization. The last battery on `main` itself is the `225ef73` integration run of
2026-09-23; see the Next tasks for `058c8f4`.

### Promoting a build

Only when the user asks. The promote flow that produced the running build was:

1. Package from a clean worktree at `main`, with the battery already green on that tree (the
   2026-09-24 promote of `058c8f4` skipped this at the owner's request). Packaging is the daemon,
   client, CLI and shell builds, then `pnpm run package` in `packages/shell`.
2. Move the installed bundle aside by hand, then copy the new one into its place. The promote script
   does not keep a backup itself:

~~~sh
OUT=/Users/ben/code/kelpi/packages/shell/out
mv "$OUT/Kelpi-darwin-arm64" "$OUT/Kelpi-darwin-arm64.pre-promote-$(date +%Y%m%dT%H%M%S)"
ditto <worktree>/packages/shell/out/Kelpi-darwin-arm64 "$OUT/Kelpi-darwin-arm64"
codesign --verify --strict "$OUT/Kelpi-darwin-arm64/Kelpi.app"
~~~

   Copy the `Kelpi-darwin-arm64` directory itself, not its parent; `ditto` keeps the signature.
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

> Read `docs/plugin-handoff.md` and `docs/plugin-roadmap.md` on `main`. Everything through pane
> search (#262), plugin commands in Help (#261) and root layout with Zen Mode (#263) is merged at
> `058c8f4`, which is also the promoted build, promoted without an integration battery; preserve
> the dirty root checkout and the installed Kelpi and do not promote anything. Recheck `main` and
> the open issues before you start, and check `origin/main` for a parallel fix before you dispatch
> one, because other sessions work this same repository. No plugin branch is open. Pick up from the
> handoff's Next tasks, the battery on `main` first, in a fresh isolated worktree with one
> `pnpm install` and a short `--state` path for any private instance; the vendored engine bundle is
> committed. Reinstall any example
> plugin you edit before you test it, never run the battery while I am using a second Kelpi window,
> and plan a manual test for anything that drags or moves focus inside an iframe. Use logical
> commits and reviewable PR phases, squash merges only, update the roadmap, guides and dated
> validation together with the roadmap and handoff refresh as each branch's last commit, and leave
> merging to me.
