# Plugin roadmap and progress

Last reviewed: **2026-09-13**, against merged main `fd2a216`. This is the current plan for
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

The last three phases added the placements `interaction.palette`, `interaction.prompts` and
`settings.window`, and two additive terminal SDK fields. All are additive: plugin API version
remains **1** and wire protocol generation remains **2**.

## Later work and open decisions

| Work | Current state | Intended next result |
| --- | --- | --- |
| Selectable notification presentation ([#194](https://github.com/benfriebe/kelpi/issues/194)) | Plugin notifications and native toasts render in two bundled stacks; a prompts presenter receives an always-empty `notifications` field. The corner geometry has no page parking and no definite height, so it was deliberately held back. | A presenter-declared box size and overlay rect for a corner stack, or a merged notification model, before a plugin can draw notifications. |
| Remote-hosted views and window navigation ([#193](https://github.com/benfriebe/kelpi/issues/193)) | A plugin view hosted by a remote daemon is refused this window's navigation (`ui.getNavigation`, `ui.selectWorkspace`). | A product rule for which window a remote-hosted view navigates, then a contract that states it, rather than a silent refusal. |
| Daemon disconnect in presenter scenarios ([#199](https://github.com/benfriebe/kelpi/issues/199)) | The presenter scenarios do not press primary-daemon disconnect and reconnect: the scenario runner exposes no primary-daemon handle. Unit tests cover the call budget only. | A runner handle for the primary daemon, then disconnect and reconnect coverage in `plugin-interaction-presenters` and `plugin-settings-presenter`. |
| Appearance presenter remainder | Appearance's plain rows are projected, but its theme gallery, importer and share codes, chrome and agent-status colour maps, terminal theme picker, band fill, stat toggles, sparkline colour, highlight preview and every Reset stay a host-drawn `part: 'native'` remainder. | Describe those parts as projectable descriptors, if and when a real plugin needs to draw them. Not started on speculation. |
| Remaining UI composition | Native feature replacements, named containers and menu/item contributions exist. Arbitrary root layout, pane chrome, search/help and phone shell replacement are not a blanket supported API. | Audit each remaining surface against a concrete replacement example and introduce explicit contracts where needed. |
| Public SDK and remote distribution | The SDK can be packed and consumed externally; plugin archives can be shared and installed locally on the daemon. Neither a registry release nor automatic downloads/updates is implemented. | Define release/version compatibility, publishing ownership, source metadata and explicit update/trust behavior before adding remote install/update flows. |
| Untrusted third-party execution | All installed plugins have full trust, including UI-only plugins through their APIs. Frame isolation and backend processes are not an OS permission sandbox. | A separate runtime and permission model, only if untrusted execution becomes a product requirement; validate restrictions at the actual execution boundary. |
| Additional domain access | Typed services and command/event access cover the implemented domains; backend-only, primary-window and native-host requirements are explicit. | Add missing operations with documented ownership, cancellation and failure semantics when real plugins need them. |
| Physical devices | Every phone result on record is Electron emulation: the audit's phone steps, `phone-settings-sheet` and the scenarios' phone sections. | Run the phone-shell and presenter paths on real hardware and record that coverage separately from emulation. |

In progress on `fix/new-workspace-and-lane-leaks`:
[#201](https://github.com/benfriebe/kelpi/issues/201), File > New Workspace and Cmd+N doing
nothing while a plugin view replaces the Workspaces sidebar, and the scenario lane leaks
[#205](https://github.com/benfriebe/kelpi/issues/205) and
[#198](https://github.com/benfriebe/kelpi/issues/198). The other open triage issues from the
two batteries are [#192](https://github.com/benfriebe/kelpi/issues/192),
[#202](https://github.com/benfriebe/kelpi/issues/202),
[#203](https://github.com/benfriebe/kelpi/issues/203),
[#204](https://github.com/benfriebe/kelpi/issues/204),
[#206](https://github.com/benfriebe/kelpi/issues/206) and
[#207](https://github.com/benfriebe/kelpi/issues/207); they are audit-step and lane defects, not
plugin contract gaps.

These are follow-up scopes, not currently running branches or promised release dates. Later work
can be reprioritized without marking unimplemented contracts complete.

Progress is tracked by delivered capabilities and explicit remaining scopes. There is no
calibrated percentage of remaining engineering effort: full UI composition, public distribution
and untrusted execution have different boundaries and should not be counted as equally sized tasks.

## Validation status

Each merged phase has its own dated record with the exact tested revision, commands and counts:
[terminal SDK geometry parity](plugin-validation.md#terminal-sdk-geometry-parity-2026-09-12),
[shared interaction contracts](plugin-validation.md#shared-interaction-contracts-2026-09-12),
[selectable interaction presenters](plugin-validation.md#selectable-interaction-presenters-2026-09-12),
[Interaction Lab](plugin-validation.md#interaction-lab-and-live-acceptance-2026-09-12),
[shared settings contracts](plugin-validation.md#shared-settings-contracts-2026-09-12),
[selectable Settings presenter](plugin-validation.md#selectable-settings-presenter-2026-09-12)
and [Settings Lab](plugin-validation.md#settings-lab-and-live-acceptance-2026-09-12).

Two full verification batteries cover the merged work. Neither was rerun at `fd2a216`.

| Battery | Tested revision | Result |
| --- | --- | --- |
| [Interaction Lab branch](plugin-validation.md#full-verification-battery-at-54ef523), carrying the contracts and presenters steps | `54ef523` | Passed in 25.7 minutes. Typecheck, root tests, shell tests and bundle build passed. The scenario lane passed on the battery's isolated retry. The full UI audit completed with **132 steps, 1,653 assertions, 5 failed, 4 step errors, 113 need eyes**. The packaged smoke repackaged and passed **61 checks**. |
| [Settings Lab branch](plugin-validation.md#full-verification-battery-at-c4001f3), carrying the settings contracts and presenter phases | `c4001f3` | Passed in 27.1 minutes. Typecheck, root tests, shell tests and bundle build passed; root vitest **7,904 passed, 1 skipped** (the existing optional database skip) and shell **868 passed**. The scenario lane passed on the battery's isolated retry. The full UI audit completed with **132 steps, 1,653 assertions, 6 failed, 4 step errors, 113 need eyes**, every `settings-*` and `phone-settings-sheet` step green. The packaged smoke repackaged and passed **61 checks**. |

The audit failures and step errors in both runs are the same pre-existing `web-batch-pickup`,
`appearance-system-stats`, `agent-start`, `agent-lifecycle`, `footer-git-stats`,
`sidebar-remaining` and `workspace-edges` findings, now tracked as issues
[#192](https://github.com/benfriebe/kelpi/issues/192),
[#202](https://github.com/benfriebe/kelpi/issues/202),
[#203](https://github.com/benfriebe/kelpi/issues/203),
[#204](https://github.com/benfriebe/kelpi/issues/204) and
[#206](https://github.com/benfriebe/kelpi/issues/206). The scenarios that go red under a battery
lane and green alone are tracked as [#198](https://github.com/benfriebe/kelpi/issues/198),
[#205](https://github.com/benfriebe/kelpi/issues/205) and
[#207](https://github.com/benfriebe/kelpi/issues/207); they are leaked sandbox state, not load.

Not established anywhere in this record: physical devices, and daemon disconnect and reconnect
inside the presenter scenarios. Phone coverage is Electron emulation. The
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
