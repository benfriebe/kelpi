# Plugin implementation validation

Validation record for 2026-09-08 and 2026-09-09 in the isolated
`plugin-extensibility` worktree, based on `084a2bb`. The original implementation was
validated before it was organized into commits; the native-service follow-up builds on
`de3fc89` and was also validated before being committed in logical phases. The review stack
is `feature/plugin-extensibility` → `feature/plugin-native-runtime` →
`feature/plugin-native-integration` → `feature/plugin-native-sdk`. Environment: macOS arm64, Node 24.15.0,
pnpm 10.28.1. Tests used private daemons, databases, sockets, ports, home directories, and
Electron profiles.

The [plugin guide](plugins.md) describes the implemented API and upgrade requirements.
The [original audit](plugin-extensibility-audit.md) distinguishes the longer-term design
from this implementation. This version supports explicitly trusted local plugins; it does
not implement a marketplace or an untrusted execution runtime.

## Native service replacement (2026-09-09)

The daemon now registers native adapters for Git, content rendering, managed processes, and
the existing files contract. Git selection reaches repository discovery, Inspector/footer
status, worktree operations, graft, branch/HEAD watchers, and native diff sources. Rendering
selection updates existing Markdown/diff previews inside their original sandboxed frames.
Managed SDK processes use the same selected-service dispatch. The SDK includes typed native
contracts and the build-free [Service Lab](../examples/plugins/service-lab) example.

The implementation retains bundled fast paths when no available external provider is selected.
Provider transitions invalidate cached data and cancel obsolete preview generations. Failed
mutations are not retried. Regression tests cover malformed/oversized results, cancellation
during activation, delayed Markdown reads against dirty/saved/closed/replaced buffers, and
concurrent status refreshes. A real daemon shutdown test verifies that the selected Git
provider restores an active graft before deactivation, preserving tracked/untracked edits,
the original branch/HEAD, and an unrelated pre-existing stash.

| Gate | Result | Evidence |
| --- | --- | --- |
| Typechecks and automated tests | All workspace typechecks pass; 6,661 root tests and 868 shell tests pass. One existing optional real-Swift-database test remains skipped. | [Verification log](../out/plugin-native-full-verification.log) |
| Live native-service scenario | 22/22 checks pass onscreen and in two separate concurrent background instances. Includes actual CLI worktree creation, Inspector-opened diffs, graft/restore/removal, native previews, process execution, reload/fallback, and saved text. | [Onscreen](../out/plugin-native-services-live/results.json), [Background](../out/plugin-native-services-hidden/results.json), [Background repeat](../out/plugin-native-services-hidden-repeat/results.json) |
| Full scenario lane | All 264 checks across 20 scenarios pass on the first attempt against the final source. | [Results](audit/verify-latest/battery/scenarios/results.json) |
| Full verification battery | All components completed in 21.6 minutes, without component retries. The full audit findings are recorded below; its exit status does not mean every assertion passed. | [Battery report](audit/verify-latest/verify-report.json) |
| Packaged application smoke | 67/67 checks pass against the rebuilt application. | [Verification log](../out/plugin-native-full-verification.log) |
| Packaged plugin runtime | 12/12 checks pass with the remote daemon and plugin children using the rebuilt application's bundled payload and Node. Includes files/processes, CLI routing, restart, and browser/phone clients. | [Results](../out/plugin-native-packaged-validation/results.json) |
| Audit follow-up | All 9 steps / 146 assertions pass, with zero step errors or renderer warnings. Covers every failing/errored step from the full audit, plus its web-pane prerequisite and console check. | [Report](../out/plugin-native-audit-followup/index.md) |
| Shutdown ownership | The real-daemon regression confirms provider restoration completes before backend deactivation. | [Focused log](../out/plugin-native-shutdown-tests.log) |
| Concurrent status completion | The original failure was reproduced deterministically; 76 focused Git/watcher/WS repository tests pass after the fix. | [Reproduction](../out/plugin-status-refresh-red.log), [Tests](../out/plugin-status-refresh-tests.log) |
| Source and diff hygiene | The validated product, SDK, example, and test sources match the SHA-256 manifest captured before the final battery. Only this validation record changed afterward. `git diff --check` passes. | [Source verification](../out/plugin-native-source-verification.json) |

The full UI audit ran **131 steps / 1,636 assertions**, with **4 failed assertions and
4 step errors**. Every finding matches the preserved pre-native-service baseline, including
error messages after normalizing ephemeral pane IDs. There are no new failed assertions or
error steps. The [comparison](../out/plugin-native-baseline-comparison.json) records the exact
findings; the full audit is not reported as globally green.

All seven affected steps pass in the fresh-instance **146-assertion follow-up**, without
application or audit-fixture changes after the full battery. Both reports are retained so the
isolated results do not hide the long-run findings.

The final [onscreen provider preview](../out/plugin-native-services-live/plugin-native-services-01-native-inspector-markdown-and-diff-providers.png)
was visually inspected. It shows the custom renderer in native Markdown and Diff panes and
provider-supplied status in Inspector/footer, with the native Workspaces filter unchanged.
The [service guide](plugin-services.md) records supported contracts and the remaining native
lifecycle boundaries. This does not replace editor save ownership, terminal streams,
authentication, or persistence formats.

## Extensibility follow-up (2026-09-09)

This follow-up adds nested row/column/tab containers with named slots, native renderer
adapters, programmatic workbench selection, retained hidden tabs, editable plugin shortcuts,
and pane-header commands. The daemon adds before/after operation hooks, versioned services,
explicit provider selection with fallback, and dependency activation/recovery. Browser views
and daemon backends share typed SDK helpers, caller-context defaults, and standalone public
types. The CLI can scaffold a build-free plugin and inspect/call/select services.

The new Workbench Lab example exercises the native pane grid inside a contributed layout,
custom tools and panes, typed workspace commands, guarded operations, and a delegating file
provider. The implementation boundaries and failure semantics are in the current plugin guide.

| Gate | Result | Evidence |
| --- | --- | --- |
| Typechecks and automated tests | All workspace typechecks pass; 6,583 root tests and 868 shell tests pass. The existing optional real-Swift-database test remains skipped. | [Full verification log](../out/plugin-extension-full-verification.log) |
| Full scenario lane | 242 checks across 19 scenarios pass after the corrected extension scenario is retried in isolation. | [Initial lane](../out/plugin-before-native-verification/battery/scenarios/results.json), [Corrected retry](../out/plugin-before-native-verification/battery/scenario-retry-plugin-extensions/results.json) |
| Extension scenario | 23/23 checks pass in both onscreen and hidden modes. | [Onscreen](../out/plugin-extension-final-live/results.json), [Hidden](../out/plugin-extension-final-hidden/results.json) |
| Full verification battery | All components completed in 21.7 minutes. The UI audit findings are recorded below; its exit status does not mean every assertion passed. | [Battery report](../out/plugin-before-native-verification/verify-report.json) |
| Packaged application smoke | 67/67 checks pass against the rebuilt application. | [Full verification log](../out/plugin-extension-full-verification.log) |
| Packaged plugin runtime | 12/12 checks pass with the remote daemon and plugin children running from the new application's bundled payload and Node. | [Results](../out/plugin-extension-packaged-validation/results.json) |
| Audit follow-up | All 9 steps / 146 assertions pass, with zero step errors or renderer warnings. Covers every step that failed in the full audit, plus its web-pane prerequisite and console check. | [Report](../out/plugin-extension-audit-followup/index.md) |
| Diff hygiene | `git diff --check` passed before committing. The commit series preserves the validated implementation; this record's commit-status wording was updated afterward. | Git history |

The shortcut scenario initially appended its replacement text because its macOS CDP key event
did not perform Select All. The fixture now supplies Chromium's `selectAll` edit command,
clicks the actual Save button, and checks the stored override, normalized input, and validation
state before exercising the new shortcut. No application change was needed for this fixture
correction. Both modes pass with the corrected input sequence.

The [onscreen composition](../out/plugin-extension-final-live/plugin-extensions-01-nested-workbench-and-plugin-pane.png)
was visually inspected: the native terminal grid and custom pane render beside the contributed
tab container, and Workspaces retains its full-width filter. The preceding live run also
passed all 22 workbench checks and all 11 native sidebar-swap checks with this same product
build; the full scenario lane confirms those results.

That full UI audit ran **131 steps / 1,636 assertions**, with **4 failed assertions and
4 step errors**. Every failed assertion and error matches the recorded baseline; there are
no new assertion failures, error steps, or changed error messages (ignoring ephemeral pane
IDs). The baseline had 5 failed assertions and the same 4 errors. The earlier `sidebar-spring`
and `phone-settings-sheet` fixture corrections pass in this full run.
The [comparison](../out/plugin-extension-baseline-comparison.json) preserves the exact findings;
the full audit is not reported as globally green.

All seven failing/errored steps pass in the **146-assertion isolated follow-up**, without
application or audit-fixture changes after the full run. This provides a fresh-instance
check of each finding while retaining the long-run report and its baseline comparison.
The final product build passed all checks above; subsequent changes only added example and
validation documentation.

## Initial implementation (2026-09-08)

| Gate | Result | Evidence |
| --- | --- | --- |
| Plugin implementation `pnpm check` | Typechecks pass; 6,483 root tests + 868 shell tests pass. One existing optional real-Swift-database test is skipped. | [Log](../out/plugin-final-check.log) |
| Plugin workbench scenario | 15/15 checks: installation, real iframe, host DOM isolation, commands, fresh bridges on reload, state, shortcuts, sidebar replacement, view-error recovery, disable/enable. | [Results](../out/plugin-final-scenarios/results.json) |
| Plugin remote scenario | 12/12 checks: two real daemons, files/processes/CLI routing, local-state isolation, daemon process restart, state/identity, browser client, phone single-pane view. | [Results](../out/plugin-final-scenarios/results.json) |
| Packaged plugin scenario | 12/12 checks with the remote daemon and plugin children running from the packaged application's payload and bundled Node. | [Results](../out/plugin-packaged-validation/results.json) |
| Packaged application smoke | 67/67 checks, including real PTYs, daemon persistence after app quit, and served client assets. | [Full battery log](../out/plugin-full-validation.log) |
| Full verification battery | Completed all components in 21.3 minutes; all original scenario checks passed. The audit report has the caveats below. | [Preserved battery report](../out/plugin-extension-previous-audit/verify-report.json) |
| Audit follow-up | 11 steps, 195 assertions, zero failed assertions or step errors. Covers every step that failed or errored in the full run. | [Report](../out/plugin-audit-followup/index.md) |
| Diff hygiene | `git diff --check` passes. | Git working tree |
| Sidebar picker follow-up | Client typecheck passes; 216 focused client tests and 22/22 live workbench checks pass. | [Tests](../out/plugin-sidebar-tests.log), [Scenario](../out/plugin-sidebar-validation/results.json) |
| Native sidebar placement follow-up | Client typecheck and all 3,221 client tests pass. 45/45 onscreen checks; 33/33 background checks. | [Tests](../out/plugin-sidebar-swap-tests.log), [Onscreen](../out/plugin-sidebar-swap-validation/results.json), [Background](../out/plugin-sidebar-swap-hidden/results.json) |
| Workspaces filter cleanup | Client typecheck, 219 focused client tests, and 33/33 onscreen checks pass. | [Tests](../out/plugin-filter-cleanup-tests.log), [Scenarios](../out/plugin-filter-cleanup-validation/results.json) |

The final CLI subprocess-routing fix was made during the long audit. Afterward, the complete
`pnpm check` suite and both plugin scenarios were rerun against the final daemon build.
The packaged smoke subsequently rebuilt the application, and the packaged plugin scenario
verified that payload directly. The final audit-only fixture corrections were checked in
the focused follow-up; the entire 21-minute battery was not repeated for those corrections.

## Sidebar picker follow-up

The initial picker implementation added a picker beside the Workspaces filter and in the
Inspector title. A plugin sidebar retains a host-owned picker and close button. Both menus
offer bundled views, compatible installed plugins, and a shortcut to plugin management.
They use the existing menu component, including keyboard navigation and Escape dismissal.

The follow-up checks cover independent left/right changes, restoring either bundled view,
preferences after a window reload, and disable/re-enable recovery. The real-app scenario uses
pointer input to select menu entries and keyboard input for Escape, and its screenshot was
visually inspected. Its opening wait measures the Inspector's actual bounds because the
`open` phase starts before the slide animation finishes. Inspector visibility retains its
existing behavior of starting closed on reload; the selected view is restored when reopened.

Focused tests cover plugin hosting/registry, Sidebar, Inspector, ContextMenu, and App assembly.
Only the client build changed for this follow-up; the full battery and packaging checks above
describe the earlier plugin implementation and were not rerun for these sidebar controls.

## Native sidebar placement follow-up

Workspaces and Inspector can now occupy either side. Selecting Inspector on the left or
Workspaces on the right exchanges the built-in views in one action. Their existing hosts move
with their state, widths, command refs, and visibility controls. The resize handle moves to the
inside edge and reverses its drag direction on the right. Toolbar buttons follow their physical
edge; the Inspector and Workspaces commands continue to target their respective views.

The registry prevents duplicate native hosts, including when a missing plugin needs a fallback,
and only transfers a plugin to the opposite side when its manifest supports that placement.
The picker menu is clamped inside the viewport so the right Workspaces picker stays reachable.

Validation covers all 3,221 client tests, the 22-check plugin workbench scenario, a new 11-check
native sidebar scenario, and 12 resize-recovery checks. The native scenario verifies filtering,
resizing, close/reopen, New Workspace, persisted placement/width after reload, and swapping back
from either picker. Its [onscreen screenshot](../out/plugin-sidebar-swap-validation/sidebar-swap-01-inspector-left-workspaces-right.png)
was visually inspected. Both sidebar scenarios also pass in the background mode used by the
verification runner; screenshots from that mode are not used as visual evidence.

The scenario waits for menus to paint before clicking above plugin frames: Chromium updates
the iframe hit-test regions after the menu reaches the DOM. Text-field input uses the harness's
`insertText` method; its terminal typing method sends two text events per character to HTML
inputs. These are test synchronization/input corrections, without replacing pointer-driven
menu selections with scripted state changes. The full application battery and packaging were
not repeated for this client-only follow-up.

## Workspaces filter cleanup

The Workspaces picker beside the filter has been removed, restoring the filter's full width
on either side. Placement controls remain in Settings → Plugins → Workbench views and in
Inspector/plugin headers. The existing scenarios now use the Settings selects to replace
Workspaces; they dispatch native select change events and still use pointer input for header
menus. Both scenarios pass, including saved placement, native swaps, filtering, resizing,
and plugin recovery. The [updated screenshot](../out/plugin-filter-cleanup-validation/sidebar-swap-01-inspector-left-workspaces-right.png)
was visually inspected with Inspector on the left and the full-width Workspaces filter on the
right. Client typechecking and 219 focused tests pass. The full battery was not repeated for
this control removal.

## Initial full-audit findings

`verify.mjs` treats the audit's process exit status as completion; its JSON report is the
source of truth for individual assertions. A successful verification command alone does
not mean the full UI audit has no failed assertions.

The full run executed **131 steps / 1,636 assertions**, reporting **7 failed assertions and
4 step errors**. The existing baseline report, produced from the same `084a2bb` commit at
07:48 UTC, already had **5 failed assertions and the same 4 step errors**. The matching
baseline cases are `web-batch-pickup`, `appearance-system-stats`, `agent-start`,
`agent-notification`, `footer-git-stats`, `sidebar-remaining`, and `workspace-edges`.

The two additional findings were:

- `phone-settings-sheet` expected the old nine-tab catalog. Its expected catalog now includes
  Plugins; the row-height, navigation, and desktop-restoration checks are unchanged.
- `sidebar-spring` aimed at a group header inside the sidebar's 40-pixel auto-scroll edge.
  The recorded drop target was `none`, so the gesture had not returned to the group when
  the test inspected its styling. The fixture now centers the header before aiming and
  retains the original assertion. The original isolated check also passed before this fix.

All those cases passed in the **195-assertion follow-up**, with no application changes to
the existing sidebar, agent, or workspace behavior. The full audit is therefore not recorded
as globally green: its baseline failures remain visible, alongside the successful follow-up
and the two fixture corrections. The [baseline comparison](../out/plugin-baseline-comparison.json)
preserves the exact assertion names and step errors for review.

## Reproduce

```sh
pnpm check
node scripts/verify.mjs --full
node scripts/scenario.mjs plugin-extensions --window onscreen
node scripts/scenario.mjs plugin-remote plugin-workbench
node scripts/scenario.mjs plugin-workbench sidebar-swap stuck-drag-teardown --window onscreen
KELPI_PLUGIN_PACKAGED=1 node scripts/scenario.mjs plugin-remote --no-build
```

The last command requires an existing packaged app. The fresh worktree initially lacked
the vendored Ghostty engine's ignored `dist/`; validation built it from the checked-in
vendor source and refreshed the local file dependency. No tracked vendor runtime source
was changed. Report artifacts under `out/` and `docs/audit/` are local and ignored by Git.

## Bundled sidebar features and window navigation (2026-09-09)

This phase was implemented in `out/worktrees/plugin-ui-features` on
`feature/plugin-bundled-features`, based on merged main `8f234ed`. Workspaces and Inspector
now bind their models, actions and lifecycles through registered feature modules. The public
browser SDK adds window navigation, and Sidebar Lab supplies independent replacements for
both sidebars. The [feature guide](plugin-features.md) documents ownership and lifetime rules.

| Gate | Result | Evidence |
| --- | --- | --- |
| Full typechecks and tests | `pnpm check` passes: 6,781 root tests and 868 shell tests, 7,649 total. One existing optional real-Swift-database test is skipped. | [Check log](../out/sidebar-feature-validation/check.log) |
| Development builds | Daemon, client, CLI and shell builds pass in the isolated worktree. | [Build log](../out/sidebar-feature-validation/build.log) |
| Replacement Sidebar Lab | 30/30 live checks pass with real pointer clicks, text entry and Enter submission. Covers repository errors/status/refresh/diff, terminal create/split/send/capture, workspace create/rename/select, persisted preferences, both placements, reload, disable/fallback/re-enable, remote navigation and separate owner storage. Computed styles and overflow are checked. | [Results](../out/sidebar-feature-validation/sidebar-lab/results.json) |
| Native sidebar regression | 11/11 checks pass for swapped views, filter, resizing, picker controls and restoration. | [Results](../out/sidebar-feature-swap/results.json) |
| Existing plugin workbench | 22/22 checks pass against the final build. | [Results](../out/sidebar-feature-regression/plugin-workbench/results.json) |
| Existing remote plugins | 12/12 checks pass against the final build. | [Results](../out/sidebar-feature-regression/plugin-remote/results.json) |
| Source consistency | Built client/SDK source remained unchanged through final scenarios. The example script matches the final live run after its pointer interaction fix. Whitespace and JavaScript syntax checks pass. | [Verification](../out/sidebar-feature-validation/source-verification.json), [Hashes](../out/sidebar-feature-validation/source-hashes.json) |

The final [onscreen screenshot](../out/sidebar-feature-validation/sidebar-lab/plugin-sidebar-features-01-sidebar-lab-inspector-left-workspaces-right.png)
was visually inspected: Inspector is on the left, Workspaces on the right, with styled controls
and repository/terminal content in the native pane grid. The other three scenarios use hidden
private instances; their screenshots are not used as visual evidence. All scenario instances
were stopped without changing the installed Kelpi application's state.

Validation found and fixed three behavior issues: replacing a selected remote URL could
silently display a different runtime; the iframe document wrapper placed authored head assets
in the body, where rendering could remove stylesheets; and live example updates could replace
a pressed button before its click arrived. Regression coverage now exercises these paths.
Example forms use explicit actions and Enter handling under the existing form sandbox policy.

This phase's validation consists of the full automated suite, development builds and the four
focused live scenarios above. Earlier full UI-audit and packaged-installer records describe the
previous merged phases.

## Reactive contributions and shared window UI (2026-09-09)

This follow-up continues `feature/plugin-bundled-features` from `c9d260e` in the same isolated
worktree. Plugins now declare conditional menus, status/header items and grouped settings;
backends and views publish bounded, atomic contribution state. The CLI can inspect that
state. The browser SDK adds shared quick picks, inputs, dialogs and actionable notifications.
The [UI guide](plugin-ui.md) documents conditions, validation, runtime scope and lifetime.

| Gate | Result | Evidence |
| --- | --- | --- |
| Full typechecks and tests | `pnpm check` passes: 6,915 root tests and 868 shell tests, **7,783 total**. One existing optional real-Swift-database test is skipped. | [Final check](../out/plugin-ui-validation/check-complete.log) |
| Development builds | Daemon, client, CLI and shell builds pass against the final source. | [Build log](../out/plugin-ui-validation/build.log) |
| UI Lab live scenario | 30/30 checks pass onscreen. Covers real item clicks and caller context, live badges/visibility/enablement, iframe shortcuts, disabled palette rows, grouped settings/ranges, every shared prompt, native shortcut protection, Settings queueing, reload cancellation, reset and recovery. | [Final live results](../out/plugin-ui-validation/verified-live/results.json) |
| Preview shortcuts | 6/6 checks pass onscreen against the final build: Markdown/diff iframe focus, exactly one invocation and correct pane/workspace context. | [Final live results](../out/plugin-ui-validation/verified-live/results.json) |
| Existing UI regressions | Workbench 22/22, remote plugins 12/12, swapped sidebars 11/11 and native confirmation dialogs 10/10 pass in a private background instance. | [Regression results](../out/plugin-ui-validation/regression/results.json) |
| Actual example backend | 6/6 checks pass through a real PluginService child: activation, concurrent increments, settings, context/item updates, settings events without a mounted view, and reload/persistence. | [Backend results](../out/ui-lab-backend-validation.json) |
| Source consistency | The committed product, SDK, examples and validation sources match the final hash manifest. Whitespace checks pass. | [Verification](../out/plugin-ui-validation/source-verification.json), [Hashes](../out/plugin-ui-validation/source-hashes.json) |

The final [dialog screenshot](../out/plugin-ui-validation/verified-live/plugin-ui-services-01-shared-dialog-and-native-contributions.png)
and [restored UI Lab](../out/plugin-ui-validation/verified-live/plugin-ui-services-02-ui-lab-ready.png)
were visually inspected. Native header/footer items fit beside the existing controls, and the
shared dialog remains legible over the themed example. Hidden-instance screenshots are not
used as visual evidence. All instances use private state and were stopped afterward.

Review found and fixed invocation-time manifest staleness, an overly short prompt-owner ID
limit, and missing modal coordination with native Settings/shortcuts/menu commands. Remote
pane headers now resolve and invoke contributions on their own daemon. Focused tests cover
these boundaries, shared-state sequencing/reset, disposed iframe channels, input drafts,
settings races, cancellation, queue limits and notification timers.

The initial UI Lab run passed 23/26 checks. Its three failures were scenario assumptions:
numeric drafts use a text input, and broad button selectors clicked the dialog/notification
dismiss control. Corrected selectors and four additional modal checks produce the final
30/30 run. The original [run](../out/plugin-ui-validation/live/results.json) is retained.

The first full check caught an incomplete phone test runtime fixture and unnecessary enabled
palette-row markup. Both were corrected. A later full check exposed an existing terminal
test race: its wait accepted echoed input before the output line arrived. The test now waits
for the actual shell output; the final full suite passes. The initial mixed regression run
passed 60/61 checks because its first Markdown click did not retain iframe focus; command
delivery still passed. A fresh onscreen repeat and the final combined live run both pass
all six preview checks without changing that scenario or the preview implementation.

This phase validates the complete automated suite, development builds and 91 distinct live
scenario checks. Packaged-release and full UI-audit results above apply to the earlier phases;
those larger batteries were not repeated for this follow-up.

## PR publication validation (2026-09-10)

The six implementation commits were rebased onto current main `92de0aa`, including its
terminal WASM-instance fix. `git range-diff` confirms every implementation patch is unchanged.
The four review layers are `feature/plugin-sidebar-modules` → `feature/plugin-ui-contracts`
→ `feature/plugin-ui-host` → `feature/plugin-bundled-features`. The previously tested tip is
retained locally as `backup/plugin-ui-before-pr-20260910`.

The worktree's local Ghostty package was refreshed to `0.4.0-nex.10` after checking all 32
tracked vendor files against the existing build's source. The installed bundle matches that
artifact, and the terminal vendor guard passes in the complete suite.

| Gate | Result | Evidence |
| --- | --- | --- |
| Full typechecks and tests | `pnpm check` passes: 6,916 root tests and 868 shell tests, **7,784 total**. One existing optional database test is skipped. | [Check log](../out/plugin-pr-validation/check.log) |
| Development builds | Daemon, client, CLI and shell builds pass. | [Build log](../out/plugin-pr-validation/build.log) |
| Onscreen scenarios | UI Lab 30/30, replacement Sidebar Lab 30/30, Markdown/diff preview shortcuts 6/6. | [Live results](../out/plugin-pr-validation/live/results.json) |
| Background regressions | Plugin workbench 22/22, remote plugins 12/12, swapped sidebars 11/11, native confirmation dialogs 10/10. | [Regression results](../out/plugin-pr-validation/regression/results.json) |
| User smoke test | The user ran the isolated development instance and reported the features working. | Session feedback |

All **121 live checks** passed on the first post-rebase run. This validates the integrated
stack; the earlier sections preserve the original per-phase results and investigation history.
The validation-record update is documentation only. No installed Kelpi state was migrated.
