# Incident regression fixtures

These fixtures run unchanged against two clean product checkouts. They build and launch private local runtimes, retain named assertions and source/build observations, and report cleanup. `acceptance-regression.mjs` freezes the test bytes, runs both commits, and requires the selected assertions to fail on the original and pass on the candidate.

They provide **bounded incident evidence**, not a complete PR acceptance verdict. The commit verifier also requires its selected tests, scenarios, audit, smoke checks, environment evidence and visual reviews. A local Electron/CDP run does not establish physical-phone, Safari, native IME, installed Tailscale pairing or a real remote Codex session.

| Fixture | Behavior exercised |
| --- | --- |
| `issue173.mjs` | Settings search and focus/caret behavior |
| `issue178.mjs` | Mirrored terminal panning while retaining the owner's grid |
| `issue193.mjs` | Per-host plugin navigation trust, real cross-host selection, subscriptions, revocation and persistence |
| `issue237.mjs` | Remote top-level/group reorder, cancellation controls, a second observer, restart/reload persistence and local reorder isolation |
| `issue239.mjs` | Renderer errors observed before the first client document loads |
| `issue241.mjs` | Mixed and inactive-only agent deletion guards through CLI, Sidebar and last-pane Command-W, plus confirmation/cancellation and no-agent controls |

For example, from this harness checkout:

```sh
node scripts/acceptance-regression.mjs \
  --baseline /absolute/path/to/original-checkout \
  --candidate /absolute/path/to/fixed-checkout \
  --test scripts/incident-regressions/issue241.mjs \
  --assertions 'inactive-only CLI: unforced deletion refuses visible and parked inactive sessions,inactive-only Sidebar: warning counts visible and parked sessions before deletion,keyboard: confirmed gate performs actual last-pane workspace deletion' \
  --out /private/tmp/kelpi-issue241-evidence
```

Both checkouts need their own installed workspace dependencies. Run desktop work under the same exclusive desktop reservation as the scenario and audit runners. Choose a fresh output directory and retain every attempt, including setup failures. The fixtures receive `KELPI_REGRESSION_ROOT` and `KELPI_REGRESSION_REPORT` from the runner; their complete assertion reports and source identities remain in that output.

These historical comparisons intentionally load each target's own driver/helper bytes and record them with the product source. Inspect those bindings when comparing revisions. Comprehensive current-commit acceptance uses the separately pinned reviewed harness; an incident fixture is not a fallback to older helpers for that gate. Renderer observation in most fixtures begins after boot; only the dedicated startup fixture claims first-document coverage.

Workspace disappearance proves the deletion route's observable result. End-of-run cleanup proves the recorded private process/path cleanup; it does not independently prove that every parked PTY was reclaimed at the instant of workspace deletion. Reorder cancellation controls prove daemon-order stability; additional visual claims require the relevant screenshots or DOM observations.
