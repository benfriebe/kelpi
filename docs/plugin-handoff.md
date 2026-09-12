# Plugin extensibility: agent handoff

Current as of **2026-09-12**, reviewed against merged main **`ab9be92`**. Start here when
resuming this project in another session. The [roadmap](plugin-roadmap.md) is the overall plan;
the [API guide](plugins.md) describes shipped contracts; the
[validation record](plugin-validation.md) separates tested revisions and evidence.

## Current state

The trusted local plugin platform is merged through packages, revision recovery and external
authoring. Custom panes, both swappable sidebars, toolbar/status, document, terminal and browser
renderers, shared UI requests and selected native services are implemented. The roadmap links
each completed phase and its merged PRs, from #125 through #162.

The broader replacement goal is **not complete**. Terminal SDK geometry parity (replay grid and
size ownership for plugin renderers) is implemented and validated on
`feature/plugin-terminal-geometry` as [PR #187](https://github.com/benfriebe/kelpi/pull/187), a draft stacked on PR #164, pending review and merge. After that, implement
selectable command-palette and shared-prompt presenters, then the full Settings presenter and
remaining composition surfaces. Public registry/distribution and untrusted execution are
separate future scopes. Plugin API version remains **1**; wire protocol generation remains **2**.

| Item | State at this handoff |
| --- | --- |
| Product baseline | `origin/main` at `ab9be92`, including PR #185. |
| Documentation review | [PR #164](https://github.com/benfriebe/kelpi/pull/164), open draft against `main`; this handoff belongs to that PR and is not yet merged. Recheck its state before continuing. |
| Documentation branch/worktree | `docs/plugin-roadmap` in `out/worktrees/plugin-docs`, rebased onto the product baseline above. |
| Feature branch | `feature/plugin-terminal-geometry`, stacked on `docs/plugin-roadmap`, in the worktree Kelpi created for the "Plugin roadmap" workspace; published as draft [PR #187](https://github.com/benfriebe/kelpi/pull/187). Rebase onto `main` once PR #164 merges. The following presenter phase is being implemented on `feature/plugin-interaction-contracts`, based on this branch. |
| Running application | No application or daemon was launched for this handoff. Existing user instances and other worktrees remain owned by their current tasks. |

In the current local environment, the repository root is `/Users/ben/code/kelpi`. Its main
checkout has unrelated changes to `README.md`, `package.json` and `pnpm-lock.yaml`, plus
untracked `.pnpm-store/`, `packages/site/` and `examples/plugins/geo-map-trainer/`. Preserve
them. Work on this documentation is confined to the docs worktree; do not reset the root,
carry its changes into a feature branch, or clean up other worktrees.

The user's established workflow is isolated worktrees/branches, private instances beside
their installed Kelpi, validation before commits, logical commits and reviewable PR phases.
Draft PR publication is authorized; merging remains the user's step. Delegate bounded audits
or implementation tasks where useful. Update the roadmap, API/example guides and dated
validation together as each phase lands.

## Changes on main since the last plugin phase

The previous plugin validation baseline was `0fe093d`. These subsequently merged changes
matter when continuing work:

| PR | Behavior to preserve |
| --- | --- |
| [#167](https://github.com/benfriebe/kelpi/pull/167) | Vendored engine `0.4.0-nex.13` fixes wrap linkage during reflow. It includes a changed WASM binary, so rebuild the JavaScript that embeds it. |
| [#168](https://github.com/benfriebe/kelpi/pull/168) | Native replays carry serialization geometry; the bundled non-owner terminal mirrors the size owner's grid. Settled-resize resync survives backpressure. The plugin bridge has not gained that geometry. |
| [#179](https://github.com/benfriebe/kelpi/pull/179) | A new workspace with one selected repository starts its first pane there. |
| [#180](https://github.com/benfriebe/kelpi/pull/180) | Remote pairing uses the actual bound HTTP port, including when the requested port was zero. |
| [#181](https://github.com/benfriebe/kelpi/pull/181) | Reopening Settings focuses the requested tab. |
| [#182](https://github.com/benfriebe/kelpi/pull/182) | Awaiting-input dwell begins on focus/activation, rather than a status change. |
| [#183](https://github.com/benfriebe/kelpi/pull/183) | Clicking a mouse-reporting terminal reclaims its caret from chrome text fields. |
| [#184](https://github.com/benfriebe/kelpi/pull/184) | Sidebar multiselect collapses drag companions only after the drag threshold and clears stale drag state on press. |
| [#185](https://github.com/benfriebe/kelpi/pull/185) | A delayed heartbeat tick defers the timeout verdict once, allowing queued replies to drain. |

## First implementation task

Close the terminal SDK geometry gap. The native connection supplies `onReplay(data, grid)`;
the plugin bridge now states that grid on each SDK replay frame and size ownership on each
presentation frame ([contract](plugin-terminals.md#replay-geometry-and-size-ownership)).
Before this branch, replay frames contained only bytes and Terminal Lab fitted its own box
even when another window owned process sizing. Terminal Lab now mirrors from the public fields,
and `scripts/scenarios/plugin-terminal-geometry.mjs` is the live plugin acceptance; the
[validation record](plugin-validation.md#terminal-sdk-geometry-parity-2026-09-12) has the counts.

| Concern | Source entrypoints |
| --- | --- |
| Native replay grid and renderer ownership | [PTY connection](../packages/client/src/connection/pty.ts), [TerminalFeaturePane](../packages/client/src/features/TerminalFeaturePane.tsx), [TerminalPane](../packages/client/src/terminal/TerminalPane.tsx) |
| Renderer bridge and presentation mapping | [Terminal host](../packages/client/src/plugins/terminal.ts), [pane adapter](../packages/client/src/plugins/terminal-pane.ts), [PluginView](../packages/client/src/plugins/PluginView.tsx) |
| Public contract and runtime | [Terminal types](../packages/plugin-sdk/terminal.d.ts), [SDK runtime](../packages/plugin-sdk/browser.js), [SDK tests](../packages/plugin-sdk/tests) |
| Real replacement | [Terminal Lab renderer](../examples/plugins/terminal-lab/ui/renderer.js), [helpers](../examples/plugins/terminal-lab/ui/helpers.js), [xterm adapter](../examples/plugins/terminal-lab/ui/xterm-adapter.js) |
| Existing behavior and live acceptance | [Native terminal specification](terminal-surface.md), [plugin terminal scenario](../scripts/scenarios/plugin-terminal-features.mjs), [bundled mirror scenario](../scripts/scenarios/terminal-mirrors-owner-grid.mjs) |

Agree the public field names and compatibility behavior in the implementation; this document
does not introduce an API. Carry authoritative replay geometry and size ownership through
the host and SDK, distinguish a pane's measured size from the rendered owner grid, and update
Terminal Lab. Keep each pane bound to its actual local or remote runtime.

Native `replayGrid` is additive wire type `0x07` immediately before its replay. It is metadata,
not terminal output, and consumes no output credit. Older daemons can omit it: represent
missing geometry explicitly rather than guessing. Preserve byte acknowledgements, resync
generations, parser-response routing and hidden-view rules. Do not expose foreign client IDs
or credentials to solve ownership presentation. A forced resize on an ownership transition
is deliberate recovery, not a polling mechanism.

Acceptance must cover owner/non-owner windows with different viewport and font sizes,
letterboxing/clipping, resize, taking control, owner disconnect/reconnect, hidden/revealed
panes, embedded remote ownership and renderer switches. Assert that the original PTY survives,
mouse/input coordinates still correspond to rendered cells, and stale handles cannot resize
or acknowledge a replacement. Add explicit plugin coverage: `terminal-mirrors-owner-grid`
currently exercises the bundled Electron renderer and a raw second client, not Terminal Lab
or a physical phone.

Use logical review phases if the change is large: contract/bridge first, replacement example
and live acceptance next. Every intermediate phase must remain buildable and preserve existing
renderers. Follow with the presenter work below once this parity gap is validated.

## Following phase: palette and shared prompts

The [roadmap phase](plugin-roadmap.md#following-phase-replaceable-palette-and-shared-prompts)
is implemented on three stacked branches (`feature/plugin-interaction-contracts`,
`feature/plugin-interaction-presenters`, `feature/plugin-interaction-lab`): the window
interaction surface owns the palette session and shared prompts, and a plugin view declaring
`interaction.palette` or `interaction.prompts` can be selected as that placement's presenter in
Settings → Plugins → Workbench views. Request authority, cancellation and result validation stay
in Kelpi; the bundled presenters are the recovery floor and cannot be selected away. Selection is
Settings-only, and neither password inputs nor notifications are handed to a plugin presenter: a
prompts presenter draws modal requests only, and selectable notification presentation is later
scope. See
[selectable interaction presenters](plugin-ui.md#selectable-interaction-presenters).

| Concern | Source entrypoints |
| --- | --- |
| Window interaction surface | [contracts](../packages/client/src/interaction/contract.ts), [surface](../packages/client/src/interaction/surface.ts), [host](../packages/client/src/interaction/InteractionHost.tsx), [bundled prompts](../packages/client/src/interaction/BundledPrompts.tsx), [palette adapter](../packages/client/src/interaction/PaletteHost.tsx) |
| Palette mount, shortcuts and window targeting | [App](../packages/client/src/App.tsx), [palette source](../packages/client/src/features/palette-source.ts), [CommandPalette](../packages/client/src/chrome/CommandPalette.tsx), [palette model](../packages/client/src/chrome/palette.ts) |
| Plugin-facing prompt adapter and public types | [UI service adapter](../packages/client/src/plugins/ui-services.ts), [public UI types](../packages/plugin-sdk/ui.d.ts) |
| View/request lifetime and host boundary | [PluginView](../packages/client/src/plugins/PluginView.tsx), [host UI](../packages/client/src/plugins/host-ui.ts) |
| Registration and fallback precedents | [Registry](../packages/client/src/plugins/registry.ts), [Workbench](../packages/client/src/plugins/Workbench.tsx), [feature definitions](../packages/client/src/features/definitions.ts) |
| Presenter selection, projection and watchdogs | [presenter host](../packages/client/src/interaction/presenter.ts), [presenter slot](../packages/client/src/interaction/presenter-slot.tsx), [public interaction types](../packages/plugin-sdk/interaction.d.ts), [SDK runtime](../packages/plugin-sdk/browser.js) |
| Focus/modal coordination and Settings | [Modal presence](../packages/client/src/chrome/modal-presence.ts), [Settings overlay](../packages/client/src/settings/SettingsOverlay.tsx) |

The Interaction Lab example and its live acceptance are implemented on
`feature/plugin-interaction-lab`; see the validation record for the tested revision. Preserve
keyboard/IME behavior, cancellation on caller/presenter disposal, window/daemon ownership,
native browser parking, modal queueing and focus restoration. Retain a reachable way to open
plugin recovery when a replacement fails.

Existing regression scenarios include `plugin-ui-services`, `plugin-preview-shortcuts`,
`confirm-dialog-keys`, `plugin-workbench`, `plugin-remote`, `plugin-authoring`,
`plugin-browser-features` and `plugin-terminal-features`. They cover existing behavior;
`plugin-interaction-presenters` proves the presenter contracts with Interaction Lab, including
a second plugin's prompt, presenter crash and watchdog fallback with the live request intact,
reload, disable, and the phone form factor keeping the bundled presenters. Selectable
notification presentation remains open scope; the notification stack stays bundled.

## Setup and validation for the next agent

1. Check `git status`, fetch main, and inspect the current head and PR #164 state. Read any
   repository instructions in the worktree you will actually edit.
2. Follow [checkout preparation](plugin-development.md#prepare-a-source-checkout).
   Build the ignored Ghostty bundle from that checkout's tracked source and patched WASM,
   install its dependencies and run the embedded-WASM check. Do not reuse an unverified
   bundle or another worktree's `node_modules`.
3. Start [a private instance](plugin-development.md#start-a-private-instance) and use its
   printed socket with the checkout CLI and `KELPI_REQUIRE_SOCKET=1`. Terminal Lab additionally
   needs `node scripts/build-terminal-lab.mjs` before manual installation or packing; its
   scenario builds the example automatically.
4. Validate each implementation phase before committing. Record the exact source revision,
   command, pass/fail/skip counts, build/fixture hashes and retained evidence. Update the
   roadmap and relevant API/example guides in the same review sequence.

For the terminal follow-up, the current entry commands are:

~~~sh
pnpm check
pnpm --filter @kelpi/plugin-sdk test:package
node scripts/scenario.mjs plugin-terminal-features terminal-mirrors-owner-grid --window hidden
node scripts/scenario.mjs plugin-terminal-features terminal-mirrors-owner-grid --window onscreen --no-build
~~~

Extend those scenarios or add a dedicated one for the new behavior. Use `--no-build` only
when source and generated bundles are unchanged since the preceding run. Inspect visible
screenshots; hidden-window screenshots do not establish visual correctness.

Before declaring the broader phase fully validated, run the
[verification battery](../scripts/verify.mjs) (`node scripts/verify.mjs --full`), review its
actual audit assertions and record packaged-app results. The full audit can complete while
individual assertions fail. See the [scenario rules](../scripts/ui-audit/README.md#the-rule)
and [evidence policy](plugin-validation.md#reading-the-evidence). Phone emulation and
physical-device coverage must be reported separately.

The latest merged plugin authoring review recorded **8,369 tests** and **70/70 hidden live
checks** at the older `0fe093d` baseline. Its earlier onscreen evidence belongs to the
pre-review authoring revision. Neither count is a fresh whole-product result for `ab9be92`.
The [current documentation checks](plugin-validation.md#documentation-and-handoff-refresh-2026-09-12)
are recorded separately; they do not establish full product, packaged or device validation.

## Starter message for a new session

> Read `docs/plugin-handoff.md` and `docs/plugin-roadmap.md` from documentation PR #164.
> Recheck main and that PR's state, and preserve the dirty root checkout and installed Kelpi.
> Continue in an isolated worktree with the terminal SDK replay-geometry and ownership parity
> task, validating Terminal Lab as well as the bundled renderer. Use logical commits and PR
> phases, update the docs and validation evidence, and leave merging to me. The subsequent
> broader phase is selectable palette and shared-prompt presentation.
