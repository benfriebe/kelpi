# Plugin roadmap and progress

Last reviewed: **2026-09-12**, against merged main `ab9be92`. This is the current plan for
Kelpi extensibility. The [architecture audit](plugin-extensibility-audit.md) preserves the
original design; the [plugin guide](plugins.md) defines the implemented API; the
[validation record](plugin-validation.md) records what was checked at each revision.
The [agent handoff](plugin-handoff.md) records the current branch/PR, setup requirements,
source entrypoints and recommended next task.

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
| Contributions and shared UI | Conditional commands/menus, live status/header items, editable shortcuts, grouped settings, quick picks, inputs, dialogs and notifications. Prompt presentation is still bundled. | [#134](https://github.com/benfriebe/kelpi/pull/134), [#135](https://github.com/benfriebe/kelpi/pull/135), [#136](https://github.com/benfriebe/kelpi/pull/136) | [UI contracts](plugin-ui.md), [integrated validation](plugin-validation.md#pr-publication-validation-2026-09-10) |
| Toolbar and status | Replaceable desktop bars, shared window models/commands and rendering of other plugins' contributions. | [#140](https://github.com/benfriebe/kelpi/pull/140), [#141](https://github.com/benfriebe/kelpi/pull/141), [#142](https://github.com/benfriebe/kelpi/pull/142) | [Chrome](plugin-chrome.md), [validation and review fixes](plugin-validation.md#window-chrome-features-2026-09-10) |
| Document renderers | Replaceable Markdown, Scratchpad and Diff views over native buffers, guarded writes, staged drafts and recovery. | [#145](https://github.com/benfriebe/kelpi/pull/145), [#146](https://github.com/benfriebe/kelpi/pull/146), [#147](https://github.com/benfriebe/kelpi/pull/147) | [Documents](plugin-documents.md), [validation](audit/plugin-documents/README.md) |
| Terminal renderers | Replaceable shell/external-editor presentation, acknowledged replay/live streams, input, search, selection and geometry ownership while retaining the PTY. | [#149](https://github.com/benfriebe/kelpi/pull/149), [#150](https://github.com/benfriebe/kelpi/pull/150), [#151](https://github.com/benfriebe/kelpi/pull/151) | [Terminals](plugin-terminals.md), [validation and review fixes](plugin-validation.md#terminal-renderer-replacement-2026-09-10) |
| Browser renderers | Replaceable browser chrome and shared browser operations over Kelpi-owned tabs/pages; local native surfaces and explicit remote/host availability. | [#154](https://github.com/benfriebe/kelpi/pull/154), [#155](https://github.com/benfriebe/kelpi/pull/155), [#156](https://github.com/benfriebe/kelpi/pull/156) | [Browser](plugin-browser.md), [validation and review fixes](plugin-validation.md#browser-pane-replacement-2026-09-10) |
| Packages and authoring | Offline validation, deterministic `.kelpi-plugin` archives, SDK npm artifact verification, retained revision history/rollback, failed-update recovery, templates, `plugin dev` and Settings version selection. | [#160](https://github.com/benfriebe/kelpi/pull/160), [#161](https://github.com/benfriebe/kelpi/pull/161), [#162](https://github.com/benfriebe/kelpi/pull/162) | [Development](plugin-development.md), [latest review validation](plugin-validation.md#package-and-recovery-review-fixes-2026-09-11) |

Related terminal fixes [#132](https://github.com/benfriebe/kelpi/pull/132) and
[#153](https://github.com/benfriebe/kelpi/pull/153) establish one WASM instance per terminal
and release disposed engines. They are merged runtime fixes, not additional plugin APIs.

Since the authoring phase, [#167](https://github.com/benfriebe/kelpi/pull/167) fixes terminal
wrap linkage in the vendored WASM engine, and [#168](https://github.com/benfriebe/kelpi/pull/168)
adds replay geometry and owner-grid mirroring to the bundled renderer. The latter exposed a
remaining SDK parity gap described below. Subsequent main fixes through
[#185](https://github.com/benfriebe/kelpi/pull/185) are recorded in the handoff.

## Current task: terminal SDK geometry parity

**Status: implemented on `feature/plugin-terminal-geometry`, [PR #187](https://github.com/benfriebe/kelpi/pull/187) (draft, stacked on PR #164), awaiting review and merge.** The
native PTY subscription carries
the grid on which a replay was serialized, and the bundled terminal mirrors the size owner's
grid. The plugin bridge now states that grid on every SDK replay frame (`grid`, `null` when the
daemon states none) and size ownership on every presentation frame (`ownsSize`), and issues the
one forced PTY report each ownership hand-off needs. Terminal Lab mirrors from those two fields
alone, and `plugin-terminal-geometry` proves it live, including the embedded remote case. See
[replay geometry and size ownership](plugin-terminals.md#replay-geometry-and-size-ownership)
and the [validation record](plugin-validation.md#terminal-sdk-geometry-parity-2026-09-12).

The bounded follow-up, in order:

1. Define public replay geometry and size-ownership presentation, preserving compatibility
   with daemons that supply no grid. Keep measured pane geometry separate from the grid being
   rendered, and preserve the actual owning runtime for embedded remote panes.
2. Carry those values through the acknowledged plugin bridge and SDK, then update Terminal Lab
   to mirror a non-owner grid and recover on ownership changes. Preserve output credit,
   replay ordering, parser replies, hidden-view rules and existing PTY ownership.
3. Test differing window/font sizes, resize, take-control, reconnect, hidden/revealed panes,
   remote ownership and renderer swaps. Assert native process identity and input coordinates.
   The existing `terminal-mirrors-owner-grid` scenario is bundled coverage; add explicit plugin
   acceptance and inspect onscreen output.

All three steps are implemented and tested on the branch; the phase is marked merged only
once its PRs merge. See the [handoff implementation pointers](plugin-handoff.md#first-implementation-task).
The SDK gained two additive fields; plugin API version and wire protocol generation are unchanged.

## Following phase: replaceable palette and shared prompts

**Status: all three steps implemented on stacked branches (`feature/plugin-interaction-contracts`, `feature/plugin-interaction-presenters`, `feature/plugin-interaction-lab`), awaiting review and merge.** The palette session and shared
prompts are owned by one window interaction surface
([contracts](../packages/client/src/interaction/contract.ts), [host](../packages/client/src/interaction/InteractionHost.tsx)),
with the native palette commands supplied by a
[feature source](../packages/client/src/features/palette-source.ts). A plugin view declaring
`interaction.palette` or `interaction.prompts` can now be selected as that placement's presenter
in Settings → Plugins → Workbench views, reading a per-placement projection through
[public types](../packages/plugin-sdk/interaction.d.ts) and a
[presenter host](../packages/client/src/interaction/presenter.ts); the bundled presenters are the
recovery floor and cannot be selected away. See
[selectable interaction presenters](plugin-ui.md#selectable-interaction-presenters).

The review sequence is:

1. **Shared window interaction contracts.** Extract palette query/items/selection and
   quick-pick/input/dialog/notification presentation from their bundled components. Route
   supported built-in and plugin callers through those contracts. Define request ownership,
   result validation, cancellation, queueing and window/daemon targeting before exposing them.
2. **Selectable presenters.** Register bundled implementations and support explicit plugin
   replacement selection. Preserve modal coordination, keyboard/IME behavior, focus handoff,
   native browser parking and a reachable bundled recovery path when a presenter fails.
3. **Interaction Lab and validation.** Add an external example that replaces the palette and
   shared prompts, including requests from a second plugin. Exercise selection, caller and
   presenter reload/disable, disconnect, cancellation and fallback in real instances.

All three steps are implemented and tested on stacked branches; the phase is marked merged only
once its PRs merge. Selectable notification presentation is not part of this phase: the
notification stack stays bundled, recorded as remaining scope below. The two presenter
placements are additive, so plugin API version and wire
protocol generation are unchanged. Selection is Settings-only: both placements are discoverable
in `ui.getWorkbench().slots` and refused by `ui.selectView`. Password inputs and the notification
stack stay with the bundled presenter whatever is selected; a selected prompts presenter draws
modal quick picks, inputs and dialogs only.

Acceptance requires retained terminal/browser sessions and no duplicated command execution,
stale prompt answers or stranded focus. Cover desktop, browser/phone layout and remote-owner
boundaries, inspect visible screenshots, and run the relevant full checks and packaged smoke.
Phone emulation and physical-device checks must be identified separately in the evidence.

## Later work and open decisions

| Work | Current state | Intended next result |
| --- | --- | --- |
| Selectable notification presentation | Plugin notifications and native toasts render in two bundled stacks; a prompts presenter receives an always-empty `notifications` field. | A presenter-declared box size and overlay rect for a corner stack, or a merged notification model, before a plugin can draw notifications. |
| Full Settings presentation | Plugins have schema-driven settings and a `settings` view slot inside Plugins; the application Settings shell remains native. | A shared settings model and selectable presentation, preserving validation, routing, drafts and access to plugin recovery. |
| Remaining UI composition | Native feature replacements, named containers and menu/item contributions exist. Arbitrary root layout, pane chrome, search/help and phone shell replacement are not a blanket supported API. | Audit each remaining surface against a concrete replacement example and introduce explicit contracts where needed. |
| Public SDK and remote distribution | The SDK can be packed and consumed externally; plugin archives can be shared and installed locally on the daemon. Neither a registry release nor automatic downloads/updates is implemented. | Define release/version compatibility, publishing ownership, source metadata and explicit update/trust behavior before adding remote install/update flows. |
| Untrusted third-party execution | All installed plugins have full trust, including UI-only plugins through their APIs. Frame isolation and backend processes are not an OS permission sandbox. | A separate runtime and permission model, only if untrusted execution becomes a product requirement; validate restrictions at the actual execution boundary. |
| Additional domain access | Typed services and command/event access cover the implemented domains; backend-only, primary-window and native-host requirements are explicit. | Add missing operations with documented ownership, cancellation and failure semantics when real plugins need them. |

These are follow-up scopes, not currently running branches or promised release dates. The
terminal parity task and then presenter phase above are the recommended order; later work
can be reprioritized without marking unimplemented contracts complete.

Progress is tracked by delivered capabilities and explicit remaining scopes. There is no
calibrated percentage of remaining engineering effort: full UI composition, public distribution
and untrusted execution have different boundaries and should not be counted as equally sized tasks.

## Validation status

The latest merged authoring review at `0fe093d` records **8,369 passing tests**, all workspace
typechecks, one existing optional database skip and **70/70 hidden live checks**. The earlier authoring
baseline records 66 hidden and 66 onscreen checks plus inspected screenshots. Its committed
JSON and screenshots describe that baseline, not the later reviewed source. These counts also
predate the native fixes now on `ab9be92`; no combined product run at that revision is claimed here.

The [validation record](plugin-validation.md) distinguishes these revisions, earlier full
UI-audit findings, packaged smoke coverage and physical-device limits. This documentation
refresh does not constitute a fresh full product test run. Some old logs existed only under an
implementation worktree's `out/` directory; the record labels those paths as local artifacts
instead of presenting them as downloadable evidence.

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
