# Plugin implementation validation

Phase-by-phase record for **2026-09-08 through 2026-09-11**, including merged main `0fe093d`.
Documentation and current-state reconciliation were updated on **2026-09-12** against
`ab9be92`; that review is not a new full product test run.
The [roadmap](plugin-roadmap.md) tracks overall status and PRs; the
[plugin guide](plugins.md) defines the supported API. Work used isolated implementation
checkouts and private daemons, databases, sockets, ports and Electron profiles on macOS
arm64 with Node 24.15.0 and pnpm 10.28.1.

## Reading the evidence

Each section records its own tested revision and scope. The latest
[authoring review](#package-and-recovery-review-fixes-2026-09-11) reports all typechecks,
**8,369 passing tests** and **70/70 hidden live checks**. The preceding authoring table and
committed screenshots/JSON are the pre-review baseline. Older results are not new validation
of the latest merged tree. The documentation refresh's focused setup checks are recorded
separately below; it did not repeat full product validation.

Durable evidence is checked into [document](audit/plugin-documents/README.md),
[terminal](audit/plugin-terminals/README.md), [browser](audit/plugin-browser/README.md) and
[authoring](audit/plugin-authoring/README.md) audit directories. Their READMEs identify which
reports and images were retained. Other logs and reports were generated only in the named
implementation worktree; references shown as `out/...` or unlinked `docs/audit/...` paths
are historical local artifact locations and may no longer exist. A recorded result without
a committed report remains a narrative record, not a downloadable report.

The sections below preserve failed full-audit assertions, successful focused repeats and
gates that were not rerun. A completed verification process does not itself establish that
every UI-audit assertion passed. Phone emulation is distinct from physical-device testing.

## Phase index

- [Terminal SDK geometry parity](#terminal-sdk-geometry-parity-2026-09-12).
- [Documentation baseline and handoff checks](#documentation-and-handoff-refresh-2026-09-12).
- [Packages, recovery and authoring](#plugin-packages-recovery-and-authoring-2026-09-10), including [merged review fixes](#package-and-recovery-review-fixes-2026-09-11).
- [Browser replacement](#browser-pane-replacement-2026-09-10).
- [Terminal replacement](#terminal-renderer-replacement-2026-09-10).
- [Toolbar and status](#window-chrome-features-2026-09-10).
- [Native service providers](#native-service-replacement-2026-09-09).
- [Foundation](#initial-implementation-2026-09-08) and [extended contracts](#extensibility-follow-up-2026-09-09).
- [Bundled sidebars](#bundled-sidebar-features-and-window-navigation-2026-09-09), [shared UI](#reactive-contributions-and-shared-window-ui-2026-09-09) and [their integrated PR checks](#pr-publication-validation-2026-09-10).
- [Reproduction commands](#reproduce).

## Terminal SDK geometry parity (2026-09-12)

Implemented on `feature/plugin-terminal-geometry`, stacked on `docs/plugin-roadmap` (`03192d1`,
which is main `ab9be92` plus the documentation review). Tested revision: **`fe671ed`**
(`888b116` contract and bridge, `fe671ed` Terminal Lab and live acceptance). The worktree was
bootstrapped fresh: the vendored engine bundle rebuilt from tracked source and the tracked WASM
(SHA-256 `7de61fbc80d6e2a2ea74c241e22f41eca77ca2fd5a7885acd1e2789b4e49233f`), frozen-lockfile
install, and `vendor-engine.test.ts` **20/20** before any change. Node 24.15.0, pnpm 10.28.1,
macOS arm64. Private sandboxes only; the installed Kelpi was not touched.

| Check | Result at `fe671ed` |
| --- | --- |
| `pnpm check` | All typechecks pass. Root vitest **7,601 passed, 1 skipped** (the existing optional database skip); shell **868 passed**. |
| Focused suites | `packages/client/src/plugins`, `packages/plugin-sdk/tests`, `packages/client/src/features`: 548 tests pass, including the new bridge transition, SDK validation, per-runtime ownership and Terminal Lab mirror tests. |
| SDK artifact | `pnpm --filter @kelpi/plugin-sdk test:package` and `node scripts/verify-plugin-sdk.mjs` pass; the external fixture type-checks `TerminalGrid`, replay `grid`, presentation `ownsSize`, and rejects `grid` on an output frame. |
| `plugin-terminal-geometry`, hidden, built | **30/30** in 5.4 s (`docs/audit/scenarios/2026-09-12T02-03-24-527Z`, local artifact). |
| `plugin-terminal-geometry`, onscreen | **30/30** in 6.7 s (`2026-09-12T02-04-01-214Z`). All five screenshots inspected; three retained in [the terminal evidence directory](audit/plugin-terminals/README.md#replay-geometry-and-size-ownership-2026-09-12) with the owner-width capture. |
| `terminal-mirrors-owner-grid`, hidden | **15/15**: the bundled renderer's behaviour is unchanged. |
| `plugin-terminal-features`, hidden | **58/58** in 17.3 s run alone (`2026-09-12T02-04-44-478Z`). A first run concurrent with the full `pnpm check` scored 56/58: the two platform Copy and paste chord checks, which need window focus, failed while the shell tests were launching Electron beside it. Nothing in this branch touches those paths. |
| Independent review | Two Opus reviews (contract/bridge; Terminal Lab/scenario) found no behavioural defects. Their test-gap, vacuous-check, `covers`, `overflow: clip` and wording findings were applied before `fe671ed`. |

The geometry scenario proves, through the public contract only: an owning renderer fits its
measured box; a 40x12 owner letterboxes the emulator top-left with the long line wrapped at
the owner's 40th column on three rows and equal to `kelpi pane capture`; a mirroring renderer
keeps reporting its measurement while the PTY stays at the owner's grid; a 120x30 owner in a
900px window is clipped with `overflow: clip` on both axes and no re-wrap; a click inside the
letterbox reports the mirrored grid's cell (`ESC[<0;5;3M`) to the process; hidden/revealed and
bundled/SDK renderer swaps keep the same process and re-establish the mirror; taking size
control clears the mirror and the PTY follows the window's measurement; owner disconnect hands
sizing to the window without the chip and a fresh owner mirrors again; a disposed session
refuses to resize or write; and an embedded remote workspace mirrors its own daemon's owner
while the local pane does not. The PTY proof reads the fixture's `stdout.columns` rather than
`tput cols`, and the remote and local halves are asserted in sequence; the scenario header
records both.

### Full verification battery at `fe671ed`

`node scripts/verify.mjs --full` ran for 25.7 minutes. Its per-component results:

| Component | Result |
| --- | --- |
| Typecheck, root tests, shell tests, bundle build | Passed. |
| Scenarios (all, hidden) | The lane failed twice by the battery's own rule. Five scenarios failed under the battery and were retried alone: `plugin-document-features`, `plugin-remote`, `plugin-terminal-features` and `workspace-switch-keeps-the-caret` passed on that retry; `plugin-chrome-features` failed once more (a Settings tab button not found in time) and then passed **34/34** when rerun alone afterwards. The battery ran while two implementation agents executed test suites in a sibling worktree, which is the load these focus- and timing-sensitive checks are known to fail under. No failed check is on the terminal renderer or plugin bridge surface. |
| Full UI audit (hidden) | Completed: **132 steps, 1,653 assertions, 6 failed, 4 step errors, 113 need eyes**. The failures sit in `web-batch-pickup`, `appearance-system-stats`, `agent-start`, `agent-lifecycle`, `footer-git-stats`, `sidebar-remaining` and `workspace-edges`, the same pane-header, agent-status and sidebar steps the [initial full-audit findings](#initial-full-audit-findings) already record as full-run failures that pass in isolation. |
| Packaged smoke | Repackaged and passed **61 checks**. |

An isolated repeat of those seven audit steps (`--only`, hidden: 8 steps, 130 assertions)
left two failures, both repeated onscreen: `web-batch-pickup` "a web pane exists", which is
a `--only` provisioning artifact (the step expects an earlier step's web pane) rather than the
full run's assertion; and `agent-lifecycle` "with the app active, the 600 ms dwell clears the
focused pane", which fails because [PR #182](https://github.com/benfriebe/kelpi/pull/182) moved
the dwell to arm on focus rather than on a status change and did not update this step, which
raises a status on an already focused pane. That mismatch is on `main` and is unrelated to this
branch; it needs either an audit-step update or a product decision. Hidden-window screenshots
were not used as visual evidence.

Not established here: physical devices, and phone emulation beyond the existing
`plugin-terminal-features` phone section and the audit's phone steps.

## Documentation and handoff refresh (2026-09-12)

The documentation branch `docs/plugin-roadmap` was rebased onto merged main `ab9be92`
for [PR #164](https://github.com/benfriebe/kelpi/pull/164). The [handoff](plugin-handoff.md)
records the current worktree/PR, newer native fixes, source entrypoints, setup and acceptance
for the next agent. Source review found that native replay geometry still stops at the plugin
bridge; the terminal guides now describe this limitation and the roadmap prioritizes it.
Palette/prompt presentation remains proposed and unimplemented.

Focused validation on the rebased worktree used Node 24.15.0 and pnpm 10.28.1:

| Check | Result and scope |
| --- | --- |
| Fresh worktree bootstrap | Rebuilt the ignored Ghostty bundle from tracked source and WASM in a unique temporary directory, then installed the checkout with the frozen lockfile. No other worktree's generated bundle or `node_modules` was reused. |
| Embedded engine identity | Both vendor bundles and the installed client's embedded WASM match the tracked 423,289-byte binary, SHA-256 `7de61fbc80d6e2a2ea74c241e22f41eca77ca2fd5a7885acd1e2789b4e49233f`. |
| Vendor regression checks | `pnpm exec vitest run packages/client/src/terminal/vendor-engine.test.ts`: **20/20 pass**. |
| Application builds | Daemon, CLI, client and shell builds pass from that worktree. No app was launched or installed over the user's current Kelpi. |
| SDK artifact | `pnpm --filter @kelpi/plugin-sdk test:package` passes: packed public files, external browser and Node-only type consumers, and runtime imports. No registry publication. |
| Documentation | **437 local links**, **20 repository links/anchors** mapped to the checkout, and **79 Markdown tables** checked across **41 documents**. Setup shell syntax passes; the built CLI's global help includes all plugin command groups. |

The vendor build emitted the four previously documented Bun/`fs/promises` declaration
diagnostics and completed successfully; that is not a clean upstream typecheck claim.
Initial installation warned about daemon CLI links before its bundle existed, and the client
build reported chunk-size warnings. Subsequent app builds and the focused vendor checks passed.

Logs remain local in the docs worktree: `out/handoff-vendor-bootstrap.log`,
`out/handoff-vendor-hash-check.log`, `out/handoff-vendor-tests.log`,
`out/handoff-{daemon,cli,client,shell}-build.log`, `out/handoff-sdk-package.log` and
`out/documentation-link-check.json`. These are not committed evidence artifacts.

The previously reported **8,369 tests** and **70 hidden checks** belong to the authoring review
through `0fe093d`. The newer main changes through PR #185 have their own PR histories; no
aggregate full-suite, live-scenario, packaged-app or physical-device result for `ab9be92`
is established by this documentation update. Existing evidence files retain their revisions.

## Plugin packages, recovery and authoring (2026-09-10)

Implemented in `out/worktrees/plugin-packaging` from main `7ba942a`, with packaging,
revision recovery and authoring workflow as three dependent PR layers. The table below
records the pre-review baseline at `fbfe204`. The
[development guide](plugin-development.md) covers external projects, templates, private
instances, live editing and Settings version selection.

| Gate | Result | Evidence |
| --- | --- | --- |
| Complete checks | All typechecks; **8,357 tests** pass (7,489 root + 868 shell). One existing optional database test skipped. | [Summary](audit/plugin-authoring/summary.json) |
| Independent packaging layer | All typechecks and **828** tests pass at `cafd51d`. Includes packing/installing the actual SDK into an external browser/Node-only consumer. | [Layer checks](audit/plugin-authoring/lower-layer-validation.json) |
| Independent recovery layer | All typechecks and **933** tests pass at `ed8d56c`, including identity-bound dev installs, cancellation, activation/storage recovery, interrupted commits and saved-state guards. | [Layer checks](audit/plugin-authoring/lower-layer-validation.json) |
| Final live scenarios | **66/66 hidden and 66/66 onscreen**: external authoring 21, extensions 23, workbench 22 per run. | [Hidden](audit/plugin-authoring/hidden/results.json), [Onscreen](audit/plugin-authoring/onscreen/results.json) |
| Build and visual review | All **13** recorded hashes matched both baseline runs and their build outputs. Pane, version picker and blocked rollback screenshots inspected. | [Hashes](audit/plugin-authoring/onscreen/build-manifest.json), [Visual review](audit/plugin-authoring/README.md) |

The authoring project is created outside the repository. Updates, failed edits and rollback
preserve plugin notes, native renderer preferences, the original shell PID/variable and the
same native browser page with unsaved DOM state. Lower layers resolve workspace modules
only within their own clean exports. The [evidence](audit/plugin-authoring/README.md) records
the checked behaviors and limits; full UI audit, packaged smoke and physical-device checks
were not repeated in this phase.

### Package and recovery review fixes (2026-09-11)

PR #160 now bounds complete package paths to 512 UTF-8 bytes during directory and archive
validation, so multibyte paths cannot pass validation and then fail macOS extraction.
PR #161 checks retained native renderer state against stable pane types and declared
placements. Closing a document's external editor no longer blocks compatible updates,
reinstalls or rollback; removal of its supported placement and older state versions remain
rejected. Live renderer attachment still requires the appropriate current pane mode.

Twelve new automated regression cases cover path boundaries, rejection before extraction,
active and parked document panes, retained state, and incompatible revisions. The combined
`pnpm check` passes all workspace typechecks and **8,369 tests** (7,501 root + 868 shell),
with one existing optional database test skipped. The Settings compatibility test now
controls the response and distinguishes loading from a completed compatibility rejection.

`node scripts/scenario.mjs plugin-authoring plugin-extensions plugin-workbench --window hidden`
rebuilt the daemon, CLI, client and shell and passed **70/70 live checks**: authoring 25,
extensions 23 and workbench 22. The added checks save terminal renderer state inside a real
external editor, close it before development updates and Settings rollback, and reopen it
with the saved state intact. The original shell PID and native browser page survive these
transitions. All **14** recorded build and fixture hashes match the tested files.

Validation used private daemon state and Electron profiles. This run verifies behavior;
hidden-window screenshots are not visual evidence. The earlier screenshot record remains
the explicitly labeled pre-review baseline.

## Browser pane replacement (2026-09-10)

Implemented in `out/worktrees/plugin-browser` from merged main `24b19c9`. The review layers
are `feature/plugin-browser-contract` → `feature/plugin-browser-features` →
`feature/plugin-browser-lab`. Browser chrome is replaceable while the daemon and its native
host retain tabs, live pages and storage sessions. The [browser guide](plugin-browser.md)
documents shared operations, local surface attachment, ownership and private installation;
[Browser Lab](../examples/plugins/browser-lab) is a build-free SDK-only example.

| Gate | Result | Evidence |
| --- | --- | --- |
| Complete workspace checks | All typechecks pass; 7,357 root tests and 868 shell tests pass (**8,225 total**). One existing optional database test is skipped. | Check log (local artifact: `out/plugin-browser-validation/check.log`) |
| Contract PR in isolation | All typechecks and **491 tests** pass in an export containing only the 27 foundational files. | Typechecks (local artifact: `out/plugin-browser-validation/contract-typecheck.log`), Tests (local artifact: `out/plugin-browser-validation/contract-tests.log`) |
| UI PR in isolation | All typechecks and **663 tests** pass in a second export without Browser Lab. The 19 UI files match the export byte-for-byte. | Typechecks (local artifact: `out/plugin-browser-validation/features-typecheck.log`), Tests (local artifact: `out/plugin-browser-validation/features-tests.log`) |
| Production outputs | Daemon, CLI, client and shell builds pass. All **18 artifact hashes** match across both final live runs and current outputs. | [Build hashes](audit/plugin-browser/live-hidden/build-manifest.json) |
| Browser Lab hidden | **59/59** pass against owned loopback pages, including native page identity, navigation, shortcuts, private mode, inspection/batch watches, remote controls and host loss. | [Results](audit/plugin-browser/live-hidden/results.json) |
| Browser Lab onscreen | **59/59** pass on the same build. Desktop, Tools, Settings coverage and the 390px phone UI were visually inspected. | [Results](audit/plugin-browser/live-onscreen/results.json), [Visual review](audit/plugin-browser/README.md) |
| Existing native regressions | **20/20** pass: hide/restore 7/7 and crash recovery 13/13. | [Results](audit/plugin-browser/native-regressions/results.json) |

The final live runs total **138 assertions**. Native CDP target IDs and in-page JavaScript,
unsaved text, cookies and local storage establish that renderer swaps retain the actual
page. Bounds are compared with the plugin's measured slot and native focus gutter.
Inspection watches cover actual native picks, queue clears and same-count batch comment
edits. Private/session and host changes invalidate obsolete picker arms. The control API
also passes canonical operation-hook veto, delayed-target and released-view tests.

Review found and fixed deferred focus stealing, stale actions after hide/focus loss, old
renderer teardown parking a newly mounted page, and native workspace moves recreating
pages. Native UI state reads remain independent of plugin JSON size limits. The full suite
then required six legacy App checks to answer the new ownership query from their fake
daemon; their existing geometry/reconnect/poster assertions remain intact. These final
fixture changes do not alter the product artifacts used by the live runs.

The ignored Ghostty bundle was rebuilt from this checkout's exact vendored source; no
source or lockfile changed. All validation used private state, sockets and Electron
profiles; the installed Kelpi was preserved and the live harness shut down cleanly.
Versioned screenshots, result summaries and hashes are in the
[review record](audit/plugin-browser/README.md); raw logs and target/placement diagnostics
remain under `out/plugin-browser-validation`.

Phone coverage uses Chromium emulation. Physical-device software keyboards/IME, packaged
release validation and the full UI audit were not repeated. Native page streaming and
multiple simultaneous browser hosts per daemon remain outside this contract; remote and
phone clients control the owning daemon's page and show its availability accurately.
Browser Lab demonstrates the replacement boundary without reproducing every bundled tool.

### Browser PR review fixes (2026-09-10)

PRs #154–#156 now preserve pending Find queries when next/previous overlaps their reply,
populate remote bundled pickup sessions and destinations, and preserve Browser Lab's
private-mode confirmation intent, reopened Find query and capture result ownership.

Thirty new automated regressions cover reply ordering and cancellation, session/host changes,
remote reconnects and owner changes, shared private-mode updates, and obsolete captures.
The combined `pnpm check` passes all workspace typechecks, **7,387 root tests and 868 shell
tests (8,255 total)**; the existing optional database test remains skipped.

`node scripts/scenario.mjs plugin-browser-features --window hidden` rebuilt all four app
bundles and passed **66/66 live assertions** in private daemons and Electron profiles.
The added live checks verify native Find marks after reopening, an Enable confirmation
after another client enables private mode, and remote pickup start, native picks and Cancel.
This run validates behavior; hidden-window screenshots are not visual evidence.

## Terminal renderer replacement (2026-09-10)

Implemented in `out/worktrees/plugin-terminals` from merged main `021e193`. The review
layers are `feature/plugin-terminal-contract` → `feature/plugin-terminal-features` →
`feature/plugin-terminal-lab`. Terminal views attach to the owning window's existing PTY
connection; switching renderers preserves native pane/process ownership. Primary, embedded
remote, phone and external-editor bodies share the replacement host. The
[terminal guide](plugin-terminals.md) documents the public contract and private-instance
installation; [Terminal Lab](../examples/plugins/terminal-lab) is an SDK-only xterm example.
The [review record and screenshots](audit/plugin-terminals/README.md) are versioned;
raw logs, JSON results and hash manifests below are local validation artifacts.

The transport regressions cover acknowledged consumption, stale sessions and credits,
bounded output, hidden geometry, and parser replies during visual resync. The daemon sends
the flow-control reset notice before its replacement screen, preventing a late notice from
invalidating the replay and stalling the stream. Clipboard shortcuts capture the exact
owning pane/runtime, and the phone bar clears modifiers when its renderer changes.

| Gate | Result | Evidence |
| --- | --- | --- |
| Complete workspace checks | All typechecks pass; 7,198 root tests and 868 shell tests pass (**8,066 total**). One existing optional database test is skipped. | Check log (local artifact: `out/plugin-terminals-validation/check.log`) |
| First PR in isolation | All typechecks and 247 focused contract tests pass in an export containing only the foundational layer. | Typechecks (local artifact: `out/plugin-terminals-validation/contract-typecheck.log`), Tests (local artifact: `out/plugin-terminals-validation/contract-tests.log`) |
| Second PR in isolation | All typechecks and 35 focused integration tests pass without Terminal Lab. Its 20 UI files match the validated export byte-for-byte. | Typechecks (local artifact: `out/plugin-terminals-validation/features-typecheck.log`), Tests (local artifact: `out/plugin-terminals-validation/features-tests.log`) |
| Production outputs | Daemon, CLI, client and shell builds pass; cached outputs are checked against their source hashes. The example builds from pinned local dependencies. | Coherent build/run log (local artifact: `out/plugin-terminals-validation/final-coherent-build.log`), Artifact hashes (local artifact: `docs/audit/plugin-terminals/live-hidden/build-manifest.json`) |
| Terminal Lab in a hidden instance | 49/49 checks pass, including three four-MiB bursts, resync, renderer handoff/fallback, live search, external-editor save/return, remote clipboard ownership, retained hidden sessions, phone modifiers, direct mouse input and PTY size ownership. | Results (local artifact: `docs/audit/plugin-terminals/live-hidden/results.json`), Resync evidence (local artifact: `docs/audit/plugin-terminals/live-hidden/recovered-resync-diagnostics.json`) |
| Terminal Lab in an onscreen instance | 49/49 checks pass against the same 14 artifact hashes. Desktop, external-editor and phone screenshots were inspected; terminal backgrounds and the complete phone key bar fit their hosts. | Results (local artifact: `docs/audit/plugin-terminals/live-onscreen/results.json`), Run log (local artifact: `out/plugin-terminals-validation/live-onscreen.log`), [Visual record](audit/plugin-terminals/README.md) |
| Existing native regressions | All 48 checks pass: workspace focus 14/14, platform shortcuts 20/20, Copy/Paste 14/14. | Focus/shortcuts (local artifact: `out/plugin-terminals-validation/native-regressions/results.json`), Clipboard (local artifact: `out/plugin-terminals-validation/native-clipboard/results.json`) |

Local workspace/zoom eviction and remote phone mode changes retain their native detach/reattach
behavior; the same pane/process is replayed on return. Remote desktop zoom retains an actual
hidden iframe and is the live retention/input/geometry test. A second protocol client owns
geometry during the live size-control check, then the real window reclaims it through the
native **Take Size Control** action. Raw input/PID diagnostics and artifact hashes accompany
the results. Hidden-window screenshots are not used as visual evidence.
The two Terminal Lab runs and existing native scenarios total 146 live assertions.

Phone checks use browser emulation. Physical keyboards/IME candidate windows, actual mobile
software keyboards and simultaneous native-window ownership remain device/manual checks;
the automated transport and daemon suites cover window size policy. Terminal Lab retains
Kitty mode metadata but does not implement the bundled renderer's custom Kitty encoder.
Packaged-release validation and the complete UI audit were not repeated for this phase.

### Terminal PR review fixes (2026-09-10)

The follow-up fixes queued device-query loss during replay, Windows/Linux empty-selection
Ctrl+C interruption, attachment focus stealing, empty-message fallback, and phone modifier
character encoding. SDK dispatch support stays in #149; pane integration stays in #150;
the example and expanded live scenario stay in #151. Work was isolated from the existing
checkouts, and the retained-query change also received an independent review.

| Gate | Result | Evidence |
| --- | --- | --- |
| Complete workspace checks | All typechecks pass; 7,233 root tests and 868 shell tests pass (**8,101 total**). One existing optional database test is skipped. | Check log (local artifact: `out/plugin-terminal-review-validation/check.log`) |
| Terminal Lab live regressions | **58/58** checks pass in a private background instance. New checks exercise queued queries across resize, delayed attachment caret ownership, empty error recovery, four phone modifier combinations, and exactly one Ctrl+C byte through a browser emulating Linux. | Results (local artifact: `out/plugin-terminal-review-validation/live-terminal-final/results.json`), Build hashes (local artifact: `out/plugin-terminal-review-validation/live-terminal-final/build-manifest.json`) |
| Existing native regressions | **41/41** checks pass: deferred pane focus 7/7, Copy/Paste 14/14, and platform shortcuts 20/20. | Combined results (local artifact: `out/plugin-terminal-review-validation/live/results.json`) |

The first live run passed every new regression but exposed a timing assumption in the old
slow-parser test: it waited for the renderer's resync callback before removing its parser
delay, although that callback now follows retained live data. The scenario now observes the
daemon's resync notice first, restores parser speed, and then requires the renderer notice
and exact screen convergence. The final Terminal Lab run passes all checks. Initial results
remain in the combined-run artifact above. Across the final Terminal Lab and native runs,
**99 distinct live checks** pass against the same product changes.

The ignored Ghostty build was copied from the existing terminal worktree only after all
32 tracked vendor files matched the isolated checkout. Phone and Linux coverage uses browser
emulation; physical-device, packaged-release, and full UI-audit checks were not repeated.

## Window chrome features (2026-09-10)

This phase was implemented and validated in `out/worktrees/plugin-chrome`, based on
`9248790`. Toolbar and Status now have registered native feature bindings, a shared live
chrome model and command declarations, and a public browser SDK bridge. The build-free
[Chrome Lab](../examples/plugins/chrome-lab) replaces both bars and retains other plugins'
menu and item contributions. The [chrome guide](plugin-chrome.md) documents targeting,
bounded subscriptions, primary/remote ownership, desktop-only availability and recovery.

| Gate | Result | Evidence |
| --- | --- | --- |
| Final typechecks and automated tests | All workspace typechecks pass; 6,967 root tests and 868 shell tests pass. One existing optional real-Swift-database test remains skipped. | Final log (local artifact: `out/plugin-chrome-validation/final-check.log`) |
| Production builds | Daemon, client, CLI and shell build successfully. The isolated Electron runs below use those outputs. | Final client build (local artifact: `out/plugin-chrome-validation/build-client.log`) |
| Chrome Lab live scenario | 33/33 checks pass onscreen and 33/33 in a separate background instance. | Onscreen (local artifact: `out/plugin-chrome-validation/chrome-live/results.json`), Background (local artifact: `out/plugin-chrome-validation/chrome-hidden/results.json`) |
| Existing UI regressions | 79 checks pass across UI services, sidebar swaps, confirmation keys, preview shortcuts and workbench replacement. Nested extensions pass all 23 checks in a fresh instance; the combined-run limitation is recorded below. | Combined run (local artifact: `out/plugin-chrome-validation/regression/results.json`), Isolated extensions (local artifact: `out/plugin-chrome-validation/extensions-isolated/results.json`) |
| Contract and feature checks | 50 focused contract tests and 1,619 feature/plugin/App/chrome tests pass. These are also covered by the final full test suite. | Contracts (local artifact: `out/plugin-chrome-validation/contracts-tests.log`), Features (local artifact: `out/plugin-chrome-validation/features-tests.log`) |
| Diff hygiene | `git diff --check` passes before committing the validated implementation in logical phases. | Git history |

The live scenario exercises real sidebar swaps, layout/input commands, stale target rejection,
cross-workspace agent navigation, Git changes, daemon metric samples, live contribution
conditions, shared menus, two clients competing for size control, secondary-daemon isolation,
direct browser attachment, phone panes, view/window reload, Restart UI and native fallback.
The onscreen result (local artifact: `out/plugin-chrome-validation/chrome-live/plugin-chrome-features-01-chrome-lab-ready.png`)
was visually inspected: replacement bars fit their hosts, preserve the native window controls,
and show other plugins' contributions. Hidden screenshots are not used as visual evidence.

The combined regression run stopped during the nested extension scenario because its expected
New Workspace field was absent. That scenario then passed in a fresh instance without source
or fixture changes. Both results are retained; the combined run is not reported as globally
green. Chrome Lab's initial fixture iterations corrected iframe navigation lifetime, canonical
temporary paths, Git/metric setup and touch emulation before both final 33-check runs passed.

All testing used private daemons, state, sockets and Electron profiles. The installed Kelpi
was not replaced. This phase did not rerun the full UI audit or packaged application smoke;
the records below describe those gates for the preceding phases. Native document-pane
extraction and local plugin packaging/recovery were implemented in later phases; see the
[current roadmap](plugin-roadmap.md).

### PR #142 review follow-up

Chrome Lab now bounds quick-pick labels and descriptions, maps short picker IDs back to
the original commands, and paginates lists above 200 entries. Disabled entries, captured
workspace/pane targets, cancellation and view disposal retain their existing behavior.

The 10 new integration tests pass against the fixed example; the same tests fail in nine
cases against the original PR assets. They exercise the real window UI validator and
check that every paginated entry remains reachable. See the fixed results (local artifact: `out/plugin-chrome-review-validation/kelpi-pr142-chrome-lab-fixed.log`)
and original results (local artifact: `out/plugin-chrome-review-validation/kelpi-pr142-chrome-lab-baseline.log`).

The complete workspace check (local artifact: `out/plugin-chrome-review-validation/check.log`) passes all
typechecks and 7,845 tests (6,977 root and 868 shell); one existing optional test is skipped.
All four production builds (local artifact: `out/plugin-chrome-review-validation/build.log`) pass. The updated
Chrome Lab scenario (local artifact: `out/plugin-chrome-review-validation/live/results.json`) passes 34/34
checks in a private hidden instance, including a long agent label and exact pane selection.

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
| Typechecks and automated tests | All workspace typechecks pass; 6,661 root tests and 868 shell tests pass. One existing optional real-Swift-database test remains skipped. | Verification log (local artifact: `out/plugin-native-full-verification.log`) |
| Live native-service scenario | 22/22 checks pass onscreen and in two separate concurrent background instances. Includes actual CLI worktree creation, Inspector-opened diffs, graft/restore/removal, native previews, process execution, reload/fallback, and saved text. | Onscreen (local artifact: `out/plugin-native-services-live/results.json`), Background (local artifact: `out/plugin-native-services-hidden/results.json`), Background repeat (local artifact: `out/plugin-native-services-hidden-repeat/results.json`) |
| Full scenario lane | All 264 checks across 20 scenarios pass on the first attempt against the final source. | Results (local artifact: `docs/audit/verify-latest/battery/scenarios/results.json`) |
| Full verification battery | All components completed in 21.6 minutes, without component retries. The full audit findings are recorded below; its exit status does not mean every assertion passed. | Battery report (local artifact: `docs/audit/verify-latest/verify-report.json`) |
| Packaged application smoke | 67/67 checks pass against the rebuilt application. | Verification log (local artifact: `out/plugin-native-full-verification.log`) |
| Packaged plugin runtime | 12/12 checks pass with the remote daemon and plugin children using the rebuilt application's bundled payload and Node. Includes files/processes, CLI routing, restart, and browser/phone clients. | Results (local artifact: `out/plugin-native-packaged-validation/results.json`) |
| Audit follow-up | All 9 steps / 146 assertions pass, with zero step errors or renderer warnings. Covers every failing/errored step from the full audit, plus its web-pane prerequisite and console check. | Report (local artifact: `out/plugin-native-audit-followup/index.md`) |
| Shutdown ownership | The real-daemon regression confirms provider restoration completes before backend deactivation. | Focused log (local artifact: `out/plugin-native-shutdown-tests.log`) |
| Concurrent status completion | The original failure was reproduced deterministically; 76 focused Git/watcher/WS repository tests pass after the fix. | Reproduction (local artifact: `out/plugin-status-refresh-red.log`), Tests (local artifact: `out/plugin-status-refresh-tests.log`) |
| Source and diff hygiene | The validated product, SDK, example, and test sources match the SHA-256 manifest captured before the final battery. Only this validation record changed afterward. `git diff --check` passes. | Source verification (local artifact: `out/plugin-native-source-verification.json`) |

The full UI audit ran **131 steps / 1,636 assertions**, with **4 failed assertions and
4 step errors**. Every finding matches the preserved pre-native-service baseline, including
error messages after normalizing ephemeral pane IDs. There are no new failed assertions or
error steps. The comparison (local artifact: `out/plugin-native-baseline-comparison.json`) records the exact
findings; the full audit is not reported as globally green.

All seven affected steps pass in the fresh-instance **146-assertion follow-up**, without
application or audit-fixture changes after the full battery. Both reports are retained so the
isolated results do not hide the long-run findings.

The final onscreen provider preview (local artifact: `out/plugin-native-services-live/plugin-native-services-01-native-inspector-markdown-and-diff-providers.png`)
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
| Typechecks and automated tests | All workspace typechecks pass; 6,583 root tests and 868 shell tests pass. The existing optional real-Swift-database test remains skipped. | Full verification log (local artifact: `out/plugin-extension-full-verification.log`) |
| Full scenario lane | 242 checks across 19 scenarios pass after the corrected extension scenario is retried in isolation. | Initial lane (local artifact: `out/plugin-before-native-verification/battery/scenarios/results.json`), Corrected retry (local artifact: `out/plugin-before-native-verification/battery/scenario-retry-plugin-extensions/results.json`) |
| Extension scenario | 23/23 checks pass in both onscreen and hidden modes. | Onscreen (local artifact: `out/plugin-extension-final-live/results.json`), Hidden (local artifact: `out/plugin-extension-final-hidden/results.json`) |
| Full verification battery | All components completed in 21.7 minutes. The UI audit findings are recorded below; its exit status does not mean every assertion passed. | Battery report (local artifact: `out/plugin-before-native-verification/verify-report.json`) |
| Packaged application smoke | 67/67 checks pass against the rebuilt application. | Full verification log (local artifact: `out/plugin-extension-full-verification.log`) |
| Packaged plugin runtime | 12/12 checks pass with the remote daemon and plugin children running from the new application's bundled payload and Node. | Results (local artifact: `out/plugin-extension-packaged-validation/results.json`) |
| Audit follow-up | All 9 steps / 146 assertions pass, with zero step errors or renderer warnings. Covers every step that failed in the full audit, plus its web-pane prerequisite and console check. | Report (local artifact: `out/plugin-extension-audit-followup/index.md`) |
| Diff hygiene | `git diff --check` passed before committing. The commit series preserves the validated implementation; this record's commit-status wording was updated afterward. | Git history |

The shortcut scenario initially appended its replacement text because its macOS CDP key event
did not perform Select All. The fixture now supplies Chromium's `selectAll` edit command,
clicks the actual Save button, and checks the stored override, normalized input, and validation
state before exercising the new shortcut. No application change was needed for this fixture
correction. Both modes pass with the corrected input sequence.

The onscreen composition (local artifact: `out/plugin-extension-final-live/plugin-extensions-01-nested-workbench-and-plugin-pane.png`)
was visually inspected: the native terminal grid and custom pane render beside the contributed
tab container, and Workspaces retains its full-width filter. The preceding live run also
passed all 22 workbench checks and all 11 native sidebar-swap checks with this same product
build; the full scenario lane confirms those results.

That full UI audit ran **131 steps / 1,636 assertions**, with **4 failed assertions and
4 step errors**. Every failed assertion and error matches the recorded baseline; there are
no new assertion failures, error steps, or changed error messages (ignoring ephemeral pane
IDs). The baseline had 5 failed assertions and the same 4 errors. The earlier `sidebar-spring`
and `phone-settings-sheet` fixture corrections pass in this full run.
The comparison (local artifact: `out/plugin-extension-baseline-comparison.json`) preserves the exact findings;
the full audit is not reported as globally green.

All seven failing/errored steps pass in the **146-assertion isolated follow-up**, without
application or audit-fixture changes after the full run. This provides a fresh-instance
check of each finding while retaining the long-run report and its baseline comparison.
The final product build passed all checks above; subsequent changes only added example and
validation documentation.

## Initial implementation (2026-09-08)

| Gate | Result | Evidence |
| --- | --- | --- |
| Plugin implementation `pnpm check` | Typechecks pass; 6,483 root tests + 868 shell tests pass. One existing optional real-Swift-database test is skipped. | Log (local artifact: `out/plugin-final-check.log`) |
| Plugin workbench scenario | 15/15 checks: installation, real iframe, host DOM isolation, commands, fresh bridges on reload, state, shortcuts, sidebar replacement, view-error recovery, disable/enable. | Results (local artifact: `out/plugin-final-scenarios/results.json`) |
| Plugin remote scenario | 12/12 checks: two real daemons, files/processes/CLI routing, local-state isolation, daemon process restart, state/identity, browser client, phone single-pane view. | Results (local artifact: `out/plugin-final-scenarios/results.json`) |
| Packaged plugin scenario | 12/12 checks with the remote daemon and plugin children running from the packaged application's payload and bundled Node. | Results (local artifact: `out/plugin-packaged-validation/results.json`) |
| Packaged application smoke | 67/67 checks, including real PTYs, daemon persistence after app quit, and served client assets. | Full battery log (local artifact: `out/plugin-full-validation.log`) |
| Full verification battery | Completed all components in 21.3 minutes; all original scenario checks passed. The audit report has the caveats below. | Preserved battery report (local artifact: `out/plugin-extension-previous-audit/verify-report.json`) |
| Audit follow-up | 11 steps, 195 assertions, zero failed assertions or step errors. Covers every step that failed or errored in the full run. | Report (local artifact: `out/plugin-audit-followup/index.md`) |
| Diff hygiene | `git diff --check` passes. | Git working tree |
| Sidebar picker follow-up | Client typecheck passes; 216 focused client tests and 22/22 live workbench checks pass. | Tests (local artifact: `out/plugin-sidebar-tests.log`), Scenario (local artifact: `out/plugin-sidebar-validation/results.json`) |
| Native sidebar placement follow-up | Client typecheck and all 3,221 client tests pass. 45/45 onscreen checks; 33/33 background checks. | Tests (local artifact: `out/plugin-sidebar-swap-tests.log`), Onscreen (local artifact: `out/plugin-sidebar-swap-validation/results.json`), Background (local artifact: `out/plugin-sidebar-swap-hidden/results.json`) |
| Workspaces filter cleanup | Client typecheck, 219 focused client tests, and 33/33 onscreen checks pass. | Tests (local artifact: `out/plugin-filter-cleanup-tests.log`), Scenarios (local artifact: `out/plugin-filter-cleanup-validation/results.json`) |

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
from either picker. Its onscreen screenshot (local artifact: `out/plugin-sidebar-swap-validation/sidebar-swap-01-inspector-left-workspaces-right.png`)
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
and plugin recovery. The updated screenshot (local artifact: `out/plugin-filter-cleanup-validation/sidebar-swap-01-inspector-left-workspaces-right.png`)
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
and the two fixture corrections. The baseline comparison (local artifact: `out/plugin-baseline-comparison.json`)
preserves the exact assertion names and step errors for review.

## Reproduce

First [prepare the checkout](plugin-development.md#prepare-a-source-checkout), including
the vendored engine and installed-copy hash verification.

```sh
pnpm check
node scripts/verify.mjs --full
node scripts/scenario.mjs plugin-extensions --window onscreen
node scripts/scenario.mjs plugin-remote plugin-workbench
node scripts/scenario.mjs plugin-workbench sidebar-swap stuck-drag-teardown --window onscreen
KELPI_PLUGIN_PACKAGED=1 node scripts/scenario.mjs plugin-remote --no-build
```

The last command requires a packaged app built from the revision being tested. The original
implementation worktree initially lacked
the vendored Ghostty engine's ignored `dist/`; validation built it from the checked-in
vendor source and refreshed the local file dependency. No tracked vendor runtime source
was changed. `out/` is local output. `docs/audit/` is ignored by default, but selected evidence
has been explicitly committed; see [Reading the evidence](#reading-the-evidence).

## Bundled sidebar features and window navigation (2026-09-09)

This phase was implemented in `out/worktrees/plugin-ui-features` on
`feature/plugin-bundled-features`, based on merged main `8f234ed`. Workspaces and Inspector
now bind their models, actions and lifecycles through registered feature modules. The public
browser SDK adds window navigation, and Sidebar Lab supplies independent replacements for
both sidebars. The [feature guide](plugin-features.md) documents ownership and lifetime rules.

| Gate | Result | Evidence |
| --- | --- | --- |
| Full typechecks and tests | `pnpm check` passes: 6,781 root tests and 868 shell tests, 7,649 total. One existing optional real-Swift-database test is skipped. | Check log (local artifact: `out/sidebar-feature-validation/check.log`) |
| Development builds | Daemon, client, CLI and shell builds pass in the isolated worktree. | Build log (local artifact: `out/sidebar-feature-validation/build.log`) |
| Replacement Sidebar Lab | 30/30 live checks pass with real pointer clicks, text entry and Enter submission. Covers repository errors/status/refresh/diff, terminal create/split/send/capture, workspace create/rename/select, persisted preferences, both placements, reload, disable/fallback/re-enable, remote navigation and separate owner storage. Computed styles and overflow are checked. | Results (local artifact: `out/sidebar-feature-validation/sidebar-lab/results.json`) |
| Native sidebar regression | 11/11 checks pass for swapped views, filter, resizing, picker controls and restoration. | Results (local artifact: `out/sidebar-feature-swap/results.json`) |
| Existing plugin workbench | 22/22 checks pass against the final build. | Results (local artifact: `out/sidebar-feature-regression/plugin-workbench/results.json`) |
| Existing remote plugins | 12/12 checks pass against the final build. | Results (local artifact: `out/sidebar-feature-regression/plugin-remote/results.json`) |
| Source consistency | Built client/SDK source remained unchanged through final scenarios. The example script matches the final live run after its pointer interaction fix. Whitespace and JavaScript syntax checks pass. | Verification (local artifact: `out/sidebar-feature-validation/source-verification.json`), Hashes (local artifact: `out/sidebar-feature-validation/source-hashes.json`) |

The final onscreen screenshot (local artifact: `out/sidebar-feature-validation/sidebar-lab/plugin-sidebar-features-01-sidebar-lab-inspector-left-workspaces-right.png`)
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
| Full typechecks and tests | `pnpm check` passes: 6,915 root tests and 868 shell tests, **7,783 total**. One existing optional real-Swift-database test is skipped. | Final check (local artifact: `out/plugin-ui-validation/check-complete.log`) |
| Development builds | Daemon, client, CLI and shell builds pass against the final source. | Build log (local artifact: `out/plugin-ui-validation/build.log`) |
| UI Lab live scenario | 30/30 checks pass onscreen. Covers real item clicks and caller context, live badges/visibility/enablement, iframe shortcuts, disabled palette rows, grouped settings/ranges, every shared prompt, native shortcut protection, Settings queueing, reload cancellation, reset and recovery. | Final live results (local artifact: `out/plugin-ui-validation/verified-live/results.json`) |
| Preview shortcuts | 6/6 checks pass onscreen against the final build: Markdown/diff iframe focus, exactly one invocation and correct pane/workspace context. | Final live results (local artifact: `out/plugin-ui-validation/verified-live/results.json`) |
| Existing UI regressions | Workbench 22/22, remote plugins 12/12, swapped sidebars 11/11 and native confirmation dialogs 10/10 pass in a private background instance. | Regression results (local artifact: `out/plugin-ui-validation/regression/results.json`) |
| Actual example backend | 6/6 checks pass through a real PluginService child: activation, concurrent increments, settings, context/item updates, settings events without a mounted view, and reload/persistence. | Backend results (local artifact: `out/ui-lab-backend-validation.json`) |
| Source consistency | The committed product, SDK, examples and validation sources match the final hash manifest. Whitespace checks pass. | Verification (local artifact: `out/plugin-ui-validation/source-verification.json`), Hashes (local artifact: `out/plugin-ui-validation/source-hashes.json`) |

The final dialog screenshot (local artifact: `out/plugin-ui-validation/verified-live/plugin-ui-services-01-shared-dialog-and-native-contributions.png`)
and restored UI Lab (local artifact: `out/plugin-ui-validation/verified-live/plugin-ui-services-02-ui-lab-ready.png`)
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
30/30 run. The original run (local artifact: `out/plugin-ui-validation/live/results.json`) is retained.

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
| Full typechecks and tests | `pnpm check` passes: 6,916 root tests and 868 shell tests, **7,784 total**. One existing optional database test is skipped. | Check log (local artifact: `out/plugin-pr-validation/check.log`) |
| Development builds | Daemon, client, CLI and shell builds pass. | Build log (local artifact: `out/plugin-pr-validation/build.log`) |
| Onscreen scenarios | UI Lab 30/30, replacement Sidebar Lab 30/30, Markdown/diff preview shortcuts 6/6. | Live results (local artifact: `out/plugin-pr-validation/live/results.json`) |
| Background regressions | Plugin workbench 22/22, remote plugins 12/12, swapped sidebars 11/11, native confirmation dialogs 10/10. | Regression results (local artifact: `out/plugin-pr-validation/regression/results.json`) |
| User smoke test | The user ran the isolated development instance and reported the features working. | Session feedback |

All **121 live checks** passed on the first post-rebase run. This validates the integrated
stack; the earlier sections preserve the original per-phase results and investigation history.
The validation-record update is documentation only. No installed Kelpi state was migrated.
