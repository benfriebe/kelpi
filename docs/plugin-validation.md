# Plugin implementation validation

Validation record for 2026-09-08 and 2026-09-09 in the isolated
`feature/plugin-extensibility` worktree, based on `084a2bb`. Validation completed before
the changes were organized into commits. Environment: macOS arm64, Node 24.15.0,
pnpm 10.28.1. Tests used private daemons, databases, sockets, ports, home directories, and
Electron profiles.

The [plugin guide](plugins.md) describes the implemented API and upgrade requirements.
The [original audit](plugin-extensibility-audit.md) distinguishes the longer-term design
from this implementation. This version supports explicitly trusted local plugins; it does
not implement a marketplace or an untrusted execution runtime.

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
| Full scenario lane | 242 checks across 19 scenarios pass after the corrected extension scenario is retried in isolation. | [Initial lane](audit/verify-latest/battery/scenarios/results.json), [Corrected retry](audit/verify-latest/battery/scenario-retry-plugin-extensions/results.json) |
| Extension scenario | 23/23 checks pass in both onscreen and hidden modes. | [Onscreen](../out/plugin-extension-final-live/results.json), [Hidden](../out/plugin-extension-final-hidden/results.json) |
| Full verification battery | All components completed in 21.7 minutes. The UI audit findings are recorded below; its exit status does not mean every assertion passed. | [Battery report](audit/verify-latest/verify-report.json) |
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

The latest full UI audit ran **131 steps / 1,636 assertions**, with **4 failed assertions and
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
