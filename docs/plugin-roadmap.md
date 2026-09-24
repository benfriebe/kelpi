# Plugin roadmap and progress

Last reviewed: **2026-09-24**, against merged main `225ef73`. This is the current plan for
Kelpi extensibility. The [architecture audit](plugin-extensibility-audit.md) preserves the
original design; the [plugin guide](plugins.md) defines the implemented API; the
[validation record](plugin-validation.md) records what was checked at each revision.
The [agent handoff](plugin-handoff.md) records the current baseline, setup requirements,
source entrypoints and the next tasks.

## Goal and boundaries

People should be able to create custom panes and UIs, replace the workspaces sidebar and
Inspector, and compose the workbench without rebuilding Kelpi. Bundled features and installed
plugins should use explicit contribution contracts. Plugins should reach daemon, CLI and UI
operations through commands, events and typed services, with clear ownership of each daemon,
workspace, pane and viewing window.

Kelpi retains session ownership, persistence, authentication, transport, focus coordination
and recovery. A replacement changes presentation or a declared service implementation; it
does not take over the underlying PTY, native browser page or document save authority.
Private implementation functions are not a stable extension API.

The implemented runtime supports **explicitly trusted local plugins**, plugin API version 1
and protocol generation 2. Local package sharing and recovery are implemented. A public
registry, automatic remote distribution and an untrusted execution runtime are not.

## Completed and merged

These rows describe delivered capabilities, not completion of every part of the long-term
goal. Linked PRs include their review fixes; dated validation records retain their original
scope and any follow-up results.

| Phase | Delivered behavior | Merged PRs | Guide and validation |
| --- | --- | --- | --- |
| Plugin foundation and workbench | Local installation, supervised backends, isolated HTML views, custom pane persistence, commands/events, typed domain access, containers, hooks, dependencies and recovery. Either sidebar can host Workspaces or Inspector. | [#125](https://github.com/benfriebe/kelpi/pull/125) | [Plugin API](plugins.md), [foundation](plugin-validation.md#initial-implementation-2026-09-08), [extended contracts](plugin-validation.md#extensibility-follow-up-2026-09-09) |
| Native services | Selected providers for Git, preview rendering, managed SDK processes and file operations, with bundled fallback and typed contracts. | [#126](https://github.com/benfriebe/kelpi/pull/126), [#127](https://github.com/benfriebe/kelpi/pull/127), [#128](https://github.com/benfriebe/kelpi/pull/128) | [Services](plugin-services.md), [validation](plugin-validation.md#native-service-replacement-2026-09-09) |
| Bundled sidebars | Workspaces and Inspector feature modules; replacement sidebars use public navigation and domain APIs, including connected-host navigation. | [#133](https://github.com/benfriebe/kelpi/pull/133) | [Sidebars](plugin-features.md), [validation](plugin-validation.md#bundled-sidebar-features-and-window-navigation-2026-09-09) |
| Contributions and shared UI | Conditional commands/menus, live status/header items, editable shortcuts, grouped settings, quick picks, inputs, dialogs and notifications. Their presentation became selectable in the palette and prompts phase below; notifications stay bundled. | [#134](https://github.com/benfriebe/kelpi/pull/134), [#135](https://github.com/benfriebe/kelpi/pull/135), [#136](https://github.com/benfriebe/kelpi/pull/136) | [UI contracts](plugin-ui.md), [integrated validation](plugin-validation.md#pr-publication-validation-2026-09-10) |
| Toolbar and status | Replaceable desktop bars, shared window models/commands and rendering of other plugins' contributions. | [#140](https://github.com/benfriebe/kelpi/pull/140), [#141](https://github.com/benfriebe/kelpi/pull/141), [#142](https://github.com/benfriebe/kelpi/pull/142) | [Chrome](plugin-chrome.md), [validation and review fixes](plugin-validation.md#window-chrome-features-2026-09-10) |
| Document renderers | Replaceable Markdown, Scratchpad and Diff views over native buffers, guarded writes, staged drafts and recovery. | [#145](https://github.com/benfriebe/kelpi/pull/145), [#146](https://github.com/benfriebe/kelpi/pull/146), [#147](https://github.com/benfriebe/kelpi/pull/147) | [Documents](plugin-documents.md), [validation](audit/plugin-documents/README.md) |
| Terminal renderers | Replaceable shell/external-editor presentation, acknowledged replay/live streams, input, search, selection and geometry ownership while retaining the PTY. | [#149](https://github.com/benfriebe/kelpi/pull/149), [#150](https://github.com/benfriebe/kelpi/pull/150), [#151](https://github.com/benfriebe/kelpi/pull/151) | [Terminals](plugin-terminals.md), [validation and review fixes](plugin-validation.md#terminal-renderer-replacement-2026-09-10) |
| Browser renderers | Replaceable browser chrome and shared browser operations over Kelpi-owned tabs/pages; local native surfaces and explicit remote/host availability. | [#154](https://github.com/benfriebe/kelpi/pull/154), [#155](https://github.com/benfriebe/kelpi/pull/155), [#156](https://github.com/benfriebe/kelpi/pull/156) | [Browser](plugin-browser.md), [validation and review fixes](plugin-validation.md#browser-pane-replacement-2026-09-10) |
| Packages and authoring | Offline validation, deterministic `.kelpi-plugin` archives, SDK npm artifact verification, retained revision history/rollback, failed-update recovery, templates, `plugin dev` and Settings version selection. | [#160](https://github.com/benfriebe/kelpi/pull/160), [#161](https://github.com/benfriebe/kelpi/pull/161), [#162](https://github.com/benfriebe/kelpi/pull/162) | [Development](plugin-development.md), [latest review validation](plugin-validation.md#package-and-recovery-review-fixes-2026-09-11) |
| Terminal SDK geometry parity | Replay frames state the grid they were serialized on and presentation frames state size ownership, so a replacement renderer mirrors the size owner's grid and recovers on each hand-off, embedded remote panes included, while the PTY stays with Kelpi. | [#187](https://github.com/benfriebe/kelpi/pull/187) | [Replay geometry and size ownership](plugin-terminals.md#replay-geometry-and-size-ownership), [validation](plugin-validation.md#terminal-sdk-geometry-parity-2026-09-12) |
| Palette and shared prompts | One window interaction surface owns the palette session and the shared quick pick, input and dialog requests. A plugin view declaring `interaction.palette` or `interaction.prompts` can be selected as that placement's presenter in Settings; request authority, cancellation and result validation stay in Kelpi and the bundled presenters are the recovery floor. | [#188](https://github.com/benfriebe/kelpi/pull/188), [#189](https://github.com/benfriebe/kelpi/pull/189), [#190](https://github.com/benfriebe/kelpi/pull/190) | [Selectable interaction presenters](plugin-ui.md#selectable-interaction-presenters), [contracts](plugin-validation.md#shared-interaction-contracts-2026-09-12), [presenters](plugin-validation.md#selectable-interaction-presenters-2026-09-12), [Interaction Lab](plugin-validation.md#interaction-lab-and-live-acceptance-2026-09-12) |
| Full Settings presentation | Settings sections and fields are one shared descriptor model with host-owned validation, drafts and routing. A plugin view declaring `settings.window` can be selected as the Settings presenter, with the bundled panel as the recovery floor; General, Workspaces and Appearance's plain rows are projected and their native remainders stay host-drawn. | [#191](https://github.com/benfriebe/kelpi/pull/191), [#208](https://github.com/benfriebe/kelpi/pull/208), [#209](https://github.com/benfriebe/kelpi/pull/209) | [Selectable Settings presenter](plugin-ui.md#selectable-settings-presenter), [contracts](plugin-validation.md#shared-settings-contracts-2026-09-12), [presenter](plugin-validation.md#selectable-settings-presenter-2026-09-12), [Settings Lab](plugin-validation.md#settings-lab-and-live-acceptance-2026-09-12) |
| Daemon disconnect in presenter scenarios ([#199](https://github.com/benfriebe/kelpi/issues/199)) | The scenario runner hands every scenario a restartable primary daemon (`stop`, `start`, `restart` over the sandbox's own run dir, ports, database and token), and both presenter scenarios press a real disconnect and reconnect: bundled fallback while the connection is down with no latched failure and the selections retained, both presenters re-attaching, a prompt queued behind a live palette session leaving no pending request on the surface, a fresh prompt afterwards settling with its action, nothing activated by the gap and no pre-restart command replayed into the new shell, and a half-typed Settings draft intact across the restart with neither config file changed. | [#213](https://github.com/benfriebe/kelpi/pull/213) | [The daemon handle](../scripts/ui-audit/README.md#the-daemon-handle-stopping-the-primary-daemon), [validation](plugin-validation.md#daemon-disconnect-coverage-2026-09-13) |
| Selectable notification presentation ([#194](https://github.com/benfriebe/kelpi/issues/194)) | The notification stack is a placement of its own, `interaction.notifications`, selected in Settings beside the other two. A selected view receives the visible plugin notices and settles them; the host keeps the corner box, the overlay rect it registers, the 10 second expiry and result validation, clamps the height the presenter declares, and paints nothing at all while the stack is empty. Native toasts stay host chrome. | [#214](https://github.com/benfriebe/kelpi/pull/214) | [Selectable interaction presenters](plugin-ui.md#selectable-interaction-presenters), [validation](plugin-validation.md#selectable-notification-presenter-2026-09-13) |
| Pane chrome, phase A | The pane header becomes one shared closure-free descriptor per pane with a single write path for every action it performs, and the bundled header draws from it with its DOM, classes and test ids unchanged. The chrome band becomes per-pane and host-clamped (the smaller of 96 px and a quarter of the pane, the native 24 px until something declares), so the body rect, a terminal's cols and rows and a web pane's native bounds all follow one number; a taller band over a web pane enrols in the overlay registry and parks the page. The `pane.chrome` placement and the SDK types are declared (containers refused, as for the other presented placements), and the bounded 256 KiB frame is built and tested: it carries a prefix of the workspace and counts the rest, and every control and item in it is an opaque per-frame ref rather than the owning plugin's contribution id. A band is withdrawn when its pane's chrome unmounts and every band goes back when the grid changes workspace. No presenter is mounted. | [#243](https://github.com/benfriebe/kelpi/pull/243) | [Pane chrome](plugin-ui.md#pane-chrome), [validation](plugin-validation.md#pane-chrome-shared-model-2026-09-18) |
| Pane chrome, phase B | A plugin view declaring `pane.chrome` can be selected as the header presenter in Settings → Plugins → Workbench views, with the bundled header named "(bundled)" as the recovery floor and `ui.selectView` refusing the placement. ONE frame is mounted over the pane grid and clipped by the host to the bands it granted, so a single view instance, a single lease and a single acknowledgement stream draw every pane's header while a click below a band still reaches the terminal under it; each pane's band rectangle travels in the frame, inset by the focus ring's 2 px. The band, its fill, its hairline, the focus ring, the pane menu, the inline rename field, the dividers, the resize badge, the clip wash and the find bar all stay the host's. Readiness and acknowledgement watchdogs at 5 s and a 240-call rolling budget fail the placement, and a failure is all-or-nothing: every pane is back on its bundled header in the same commit with every declared band dropped, a failure toast, a `pane.chrome` status row and **Retry presenter**. `WindowPaneChromeAPI` is on `ViewAPI.ui` through `browser.js`, the frame's `changes` is filled from the status footer's own git stats, presenter-declared drag regions with a reserved 12 px grip as their floor keep the pane-move gesture working, and [Pane Lab](../examples/plugins/pane-lab) is the build-free example. | [#244](https://github.com/benfriebe/kelpi/pull/244) | [Pane chrome](plugin-ui.md#pane-chrome), [validation](plugin-validation.md#selectable-pane-chrome-presenter-2026-09-19) |
| Remote-hosted views and window navigation ([#193](https://github.com/benfriebe/kelpi/issues/193)) | A plugin view hosted by a remote daemon reaches this window's navigation (`ui.getNavigation`, `ui.onNavigation`, `ui.selectWorkspace`) only when its saved host is trusted for it in Settings ▸ Remote ▸ Daemons. The grant is per saved host, bound to its exact name and pairing URL, revoked when the record is replaced or removed, and grants navigation and workspace selection only; every other API stays denied. | [#253](https://github.com/benfriebe/kelpi/pull/253) | [Remote-host navigation trust](plugin-ui.md#remote-host-navigation-trust) |
| Pane search | The find bar ⌘F opens over a SHELL pane becomes the sixth presented surface, `pane.search`, selected in Settings → Plugins → Workbench views with the native bar named "(bundled)" as the recovery floor and `ui.selectView` refusing the placement. One frame carries the one pane the daemon is searching - the needle, the case flag, the total, the selected match and the rectangle the bar may occupy - and one view over the grid is clipped to that rectangle at the pane's top-trailing corner, above a presented pane chrome band. The total and the selection stay workspace state on the delta stream, and the needle a bar is handed is the daemon's or, while it is still on its way there, the one the user typed last, so a bar taking over mid-word loses nothing; a presenter asks through six calls and holds none of it. Scrollback, other panes' state, paths and plugin ids are withheld; the counts are stated as a per-needle read of the searched buffer. A presenter declares its box and the host clamps it to the smaller of 480 px and the pane's inner width and the smaller of 96 px and a quarter of the pane. Four chords are relayed (Escape, the toggle-search chord, ⌘G, ⇧⌘G, with the Ctrl forms where Ctrl is primary), ⌘G steps only while the frame or the searched pane holds the caret, and everything else stays in the frame; the caret goes back to the pane when the SESSION ends and not when the presenter stands down. Markdown and diff previews, web panes and the phone keep their native bars. On failure the native bar returns with the needle intact and its field focused and the case flag back off, with a toast, a `pane.search` status row and **Retry presenter**. [Search Lab](../examples/plugins/search-lab) is the build-free example. | (this PR) | [Pane search](plugin-ui.md#pane-search), [validation](plugin-validation.md#selectable-search-presenter-2026-09-20) |

Fourteen PRs merged into this baseline after #244, and only one of them is a plugin contract: #253,
which has its row above. The rest are product and audit work with no row here and no dated section
in the validation record, named so the baseline `225ef73` is accounted for:
[#246](https://github.com/benfriebe/kelpi/pull/246) steps the daemon-wide terminal text size with
⌘+, ⌘- and ⌘0; [#247](https://github.com/benfriebe/kelpi/pull/247),
[#254](https://github.com/benfriebe/kelpi/pull/254) and
[#260](https://github.com/benfriebe/kelpi/pull/260) keep the terminal's selection through trimming,
pan a mirrored canvas without resizing its owner and keep Unicode output through resizes;
[#249](https://github.com/benfriebe/kelpi/pull/249) makes Settings searchable with direct control
navigation, which a Settings presenter sees only as the host's routing;
[#250](https://github.com/benfriebe/kelpi/pull/250), [#251](https://github.com/benfriebe/kelpi/pull/251)
and [#252](https://github.com/benfriebe/kelpi/pull/252) are remote-workspace ordering, Tailscale
forwarding and an agent-session delete warning; and [#248](https://github.com/benfriebe/kelpi/pull/248),
[#255](https://github.com/benfriebe/kelpi/pull/255), [#256](https://github.com/benfriebe/kelpi/pull/256),
[#258](https://github.com/benfriebe/kelpi/pull/258) and [#259](https://github.com/benfriebe/kelpi/pull/259)
harden the audit and the desktop test lane.

Related terminal fixes [#132](https://github.com/benfriebe/kelpi/pull/132) and
[#153](https://github.com/benfriebe/kelpi/pull/153) establish one WASM instance per terminal
and release disposed engines. They are merged runtime fixes, not additional plugin APIs.

Since the authoring phase, [#167](https://github.com/benfriebe/kelpi/pull/167) fixed terminal
wrap linkage in the vendored WASM engine and [#168](https://github.com/benfriebe/kelpi/pull/168)
added replay geometry and owner-grid mirroring to the bundled renderer. The SDK parity gap it exposed is
the terminal geometry row above. Main fixes through
[#185](https://github.com/benfriebe/kelpi/pull/185), the documentation review
[#164](https://github.com/benfriebe/kelpi/pull/164) that framed the three phases above, and
[#200](https://github.com/benfriebe/kelpi/pull/200), which stages an ESM `package.json` beside
the packaged CLI and daemon bundles, are recorded in the handoff.

The last seven phases added the placements `interaction.palette`, `interaction.prompts`,
`interaction.notifications`, `settings.window`, `pane.chrome` and `pane.search`, nineteen presenter
calls (`ui.setNotificationBoxHeight`, the eleven pane chrome methods and the seven pane search ones;
`ui.reportPresenterReady` pre-existed and is shared by all six presented surfaces), two further
container refusals, and two additive terminal SDK fields. All are additive: plugin API version
remains **1** and wire protocol generation remains **2**. Every declared placement now has a host
behind it.

## Later work and open decisions

| Work | Current state | Intended next result |
| --- | --- | --- |
| Appearance presenter remainder | Appearance's plain rows are projected, but its theme gallery, importer and share codes, chrome and agent-status colour maps, terminal theme picker, band fill, stat toggles, sparkline colour, highlight preview and every Reset stay a host-drawn `part: 'native'` remainder. | Describe those parts as projectable descriptors, if and when a real plugin needs to draw them. Not started on speculation. |
| Remaining UI composition, phased | Audited against a concrete replacement example per surface (the audit memo behind pane chrome phase A). **Pane chrome is done**: phase A ([#243](https://github.com/benfriebe/kelpi/pull/243)) shipped the shared model, height authority, parking, projection and SDK types, and phase B ([#244](https://github.com/benfriebe/kelpi/pull/244)) shipped the selectable presenter, one frame over the grid clipped per pane, the two watchdogs and the 240-call budget, the all-or-nothing fallback with its toast and Retry, and the Pane Lab example. **Search is done in this PR** (the completed table's `pane.search` row), reusing pane chrome's frame-over-the-grid plumbing rather than a second copy of it. **Root layout is in progress** on `feature/plugin-root-layout`, and **Help's plugin commands and shortcuts** on `feature/help-plugin-shortcuts`; neither is merged. | **Root layout**: a bounded extension of the slot model - an optional hidden state per root slot with a host-drawn restore affordance, declared band heights under a host ceiling, and the arrangement persisted in the existing workbench store. **Help**: plugin commands and plugin shortcuts are missing from the Help overlay (`chrome/HelpOverlay.tsx`, `plugins/shortcuts.ts`), and the fix is to expose the keybinding map, plugin shortcuts included, read-only in the chrome snapshot and to draw it in the native overlay - not a placement. Two surfaces are decided against and are **not APIs**: the **phone shell** stays bundled until physical-device coverage exists, because the keyboard inset and the visible-pane report are correctness rather than presentation; and the **Help overlay's frame** stays host-drawn, because replacing it buys a plugin nothing it cannot already draw in a pane. |
| Public SDK and remote distribution | The SDK can be packed and consumed externally; plugin archives can be shared and installed locally on the daemon. Neither a registry release nor automatic downloads/updates is implemented. | Define release/version compatibility, publishing ownership, source metadata and explicit update/trust behavior before adding remote install/update flows. |
| Untrusted third-party execution | All installed plugins have full trust, including UI-only plugins through their APIs. Frame isolation and backend processes are not an OS permission sandbox. | A separate runtime and permission model, only if untrusted execution becomes a product requirement; validate restrictions at the actual execution boundary. |
| Additional domain access | Typed services and command/event access cover the implemented domains; backend-only, primary-window and native-host requirements are explicit. | Add missing operations with documented ownership, cancellation and failure semantics when real plugins need them. |
| Physical devices | Every phone result on record is Electron emulation: the audit's phone steps, `phone-settings-sheet` and the scenarios' phone sections. | Run the phone-shell and presenter paths on real hardware and record that coverage separately from emulation. |

The only triage issues still open from the two batteries are
[#206](https://github.com/benfriebe/kelpi/issues/206), a web-batch-pickup click that made no pick,
and [#207](https://github.com/benfriebe/kelpi/issues/207), a paste chord missed once; both are
audit-side or lane flakes rather than plugin contract gaps.

These are follow-up scopes, not currently running branches or promised release dates. Later work
can be reprioritized without marking unimplemented contracts complete.

Progress is tracked by delivered capabilities and explicit remaining scopes. There is no
calibrated percentage of remaining engineering effort: full UI composition, public distribution
and untrusted execution have different boundaries and should not be counted as equally sized tasks.

## Validation status

Each merged phase has its own dated record with the exact tested revision, commands and counts:
[selectable search presenter](plugin-validation.md#selectable-search-presenter-2026-09-20),
[selectable pane chrome presenter](plugin-validation.md#selectable-pane-chrome-presenter-2026-09-19),
[pane chrome shared model](plugin-validation.md#pane-chrome-shared-model-2026-09-18),
[lane hygiene](plugin-validation.md#lane-hygiene-phone-remote-workspace-flake-and-the-remembered-place-leak-2026-09-18),
[daemon disconnect coverage](plugin-validation.md#daemon-disconnect-coverage-2026-09-13),
[selectable notification presenter](plugin-validation.md#selectable-notification-presenter-2026-09-13),
[terminal SDK geometry parity](plugin-validation.md#terminal-sdk-geometry-parity-2026-09-12),
[shared interaction contracts](plugin-validation.md#shared-interaction-contracts-2026-09-12),
[selectable interaction presenters](plugin-validation.md#selectable-interaction-presenters-2026-09-12),
[Interaction Lab](plugin-validation.md#interaction-lab-and-live-acceptance-2026-09-12),
[shared settings contracts](plugin-validation.md#shared-settings-contracts-2026-09-12),
[selectable Settings presenter](plugin-validation.md#selectable-settings-presenter-2026-09-12)
and [Settings Lab](plugin-validation.md#settings-lab-and-live-acceptance-2026-09-12).

Eight full verification batteries are on record. The first two carry the presenter phases and stay
as history: neither was rerun, and the audit-step and lane defects they found have since been
fixed. The six below them ran on the branches that merged into this baseline. The pane search
branch's battery passed unretried in 26.4 minutes at `a209603`, whose code is its tested revision
`68c2b0d` after the second review: root tests **8,766 passed, 1 skipped**, all scenarios hidden in
7.0 min, the full audit with **0 failed** of 1,716 assertions, and a packaged smoke of **69/69**. An
earlier battery at its rebase and first review (`12c12b9`) also passed unretried and is superseded;
the [search record](plugin-validation.md#selectable-search-presenter-2026-09-20) has both.

| Battery | Tested revision | Result |
| --- | --- | --- |
| [Interaction Lab branch](plugin-validation.md#full-verification-battery-at-54ef523), carrying the contracts and presenters steps | `54ef523` | Passed in 25.7 minutes. Typecheck, root tests, shell tests and bundle build passed. The scenario lane passed on the battery's isolated retry. The full UI audit completed with **132 steps, 1,653 assertions, 5 failed, 4 step errors, 113 need eyes**. The packaged smoke repackaged and passed **61 checks**. |
| [Settings Lab branch](plugin-validation.md#full-verification-battery-at-c4001f3), carrying the settings contracts and presenter phases | `c4001f3` | Passed in 27.1 minutes. Typecheck, root tests, shell tests and bundle build passed; root vitest **7,904 passed, 1 skipped** (the existing optional database skip) and shell **868 passed**. The scenario lane passed on the battery's isolated retry. The full UI audit completed with **132 steps, 1,653 assertions, 6 failed, 4 step errors, 113 need eyes**, every `settings-*` and `phone-settings-sheet` step green. The packaged smoke repackaged and passed **61 checks**. |
| [Daemon disconnect coverage](plugin-validation.md#daemon-disconnect-coverage-2026-09-13), carrying [#213](https://github.com/benfriebe/kelpi/pull/213)'s restart arms | `59cbba2` | Passed in 24.0 minutes with no component retried: typecheck, root tests, shell tests, bundle build, all scenarios (hidden, 5.2 min), the full audit (18.0 min) with no failed step, and a packaged smoke of **69 checks**. |
| [Selectable notification presenter](plugin-validation.md#selectable-notification-presenter-2026-09-13), carrying [#214](https://github.com/benfriebe/kelpi/pull/214) | `4377290` | Passed in 24.4 minutes with no component retried: the scenario lane hidden in 5.6 min, the full audit in 18.0 min with no failed step, and a packaged smoke of **69 checks**. Three non-fatal leak warnings, identical to #213's. |
| [Daemon shutdown bound](plugin-validation.md#the-shutdown-stall-this-exposed-212), carrying [#218](https://github.com/benfriebe/kelpi/pull/218) | `ec8a928` | Passed in 24.0 minutes with no component retried: scenarios hidden in 5.3 min, the full audit in 17.8 min and a packaged smoke of **69 checks**; the lane's two daemon restarts stopped in 14 and 10 ms. The same battery at `2a82f8c`, before the amendments, passed in 24.9 minutes, also unretried. |
| [Lane hygiene](plugin-validation.md#lane-hygiene-phone-remote-workspace-flake-and-the-remembered-place-leak-2026-09-18), carrying [#240](https://github.com/benfriebe/kelpi/pull/240) | `165230b` and `2b46ba0` | Passed in 25.1 and 24.8 minutes, neither retried: scenarios hidden in 5.4 min, the full audit in 18.7 min and a packaged smoke of **69 checks**. No remembered-place warning in either run; the only leak warnings left are the three inert workbench-slot ones. |
| [Pane chrome shared model](plugin-validation.md#pane-chrome-shared-model-2026-09-18), carrying [#243](https://github.com/benfriebe/kelpi/pull/243) | `e56ce6d` and `74efce9` | Passed, neither run retried. Phase A mounts no presenter, so what these batteries establish is the absence of a change: the bundled header, the body rect and every PTY are byte for byte what they were, with the grid suites unmodified. |
| [Selectable pane chrome presenter](plugin-validation.md#selectable-pane-chrome-presenter-2026-09-19), carrying [#244](https://github.com/benfriebe/kelpi/pull/244) | `1a5fe5d` | Passed **unretried in 25.3 minutes** in a quiet window with nothing else running on the machine: root tests **8,228 passed, 1 skipped**, all scenarios hidden in 5.8 min, the full audit in 18.7 min, a packaged smoke of **69 checks**, and only the three inert workbench-slot leak warnings. The earlier run at `6d70e6e` **failed its scenario lane** while the owner was actively testing a second Kelpi window on the same machine: `dock-bounce-stop-only` and `plugin-browser-features` went red twice, with `plugin-pane-chrome` green in both lanes, and both passed alone minutes later. That attribution is stated in the validation record as an inference rather than a measurement. |

The audit failures and step errors in those first two runs are the same pre-existing
`web-batch-pickup`, `appearance-system-stats`, `agent-start`, `agent-lifecycle`,
`footer-git-stats`, `sidebar-remaining` and `workspace-edges` findings, tracked at the time as
issues [#192](https://github.com/benfriebe/kelpi/issues/192),
[#202](https://github.com/benfriebe/kelpi/issues/202),
[#203](https://github.com/benfriebe/kelpi/issues/203),
[#204](https://github.com/benfriebe/kelpi/issues/204) and
[#206](https://github.com/benfriebe/kelpi/issues/206). All but #206 have since been fixed in the
audit steps themselves: [#219](https://github.com/benfriebe/kelpi/pull/219) settled the
agent-lifecycle dwell, [#227](https://github.com/benfriebe/kelpi/pull/227) cleaned poster-swap's
workspace up and aimed the sidebar right-click,
[#223](https://github.com/benfriebe/kelpi/pull/223) matched the batch header through readline's
redraw and [#224](https://github.com/benfriebe/kelpi/pull/224) opened every context menu from a
measured height (closing #204 on 2026-09-16). That is why the four later batteries complete the
full audit with no failed step, and why the counts of 5 and 6 failed steps above describe the two
historical batteries only. The scenarios that went red under a battery lane and green alone were
tracked as [#198](https://github.com/benfriebe/kelpi/issues/198),
[#205](https://github.com/benfriebe/kelpi/issues/205) and
[#207](https://github.com/benfriebe/kelpi/issues/207); they were leaked sandbox state, not load.
#198 and #205 are closed by [#211](https://github.com/benfriebe/kelpi/pull/211) and
[#240](https://github.com/benfriebe/kelpi/pull/240), and #207 is still open.

Since #211 the runner checks a post-condition after every scenario and prints a named leak warning
attributed to the scenario that left the state behind. The #213, #214 and #218 batteries each
printed three, one of them the phone's remembered place left by `plugin-document-features`; #240
removed that one, and the three that remain are all the same inert workbench-slot warning, a lab
view still named in the store of a second daemon the scenario has already stopped and deleted.
Since [#230](https://github.com/benfriebe/kelpi/pull/230) a full lane also appends its per-scenario
outcomes to a retry history, so a scenario its isolated retry rescues in consecutive lanes is named
as ordering-dependent rather than passed off as load-sensitive.

Not established anywhere in this record: physical devices. Daemon disconnect and reconnect inside
the presenter scenarios, the other gap this section used to name, is established since #213. Phone
coverage is Electron emulation. The
[validation record](plugin-validation.md) distinguishes revisions, earlier full UI-audit
findings, packaged smoke coverage and physical-device limits; some older logs existed only under
an implementation worktree's `out/` directory and are labelled there as local artifacts rather
than downloadable evidence.

## Documentation map and maintenance

| Need | Start here |
| --- | --- |
| Overall goal, delivered phases and next work | This roadmap |
| Resume implementation in another session | [Agent handoff](plugin-handoff.md) |
| Installation, API, trust, packages and recovery | [Plugin guide](plugins.md) |
| Create a project and test beside an installed Kelpi | [Development guide](plugin-development.md) |
| Standalone types and SDK consumption | [SDK guide](../packages/plugin-sdk/README.md) |
| Commands and transport | [CLI](cli.md), [wire protocol](wire-protocol.md) |
| Per-surface contracts | Guides linked in the completed-phase table |
| Test results, screenshots and limitations | [Validation record](plugin-validation.md) |
| Original reasoning and proposed architecture | [Historical audit](plugin-extensibility-audit.md) |

For each implementation phase, update this roadmap's status and reviewed revision, the
affected API/example guides, and the validation record in the same review sequence. Add PR
links when published and mark a phase merged only after its PRs merge. Record exact tested
revisions and limits; keep historical results intact and do not silently assign old evidence
to newer code. New proposal APIs belong in the plan until implemented, not in the API reference.
