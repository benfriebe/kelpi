/**
 * Running the audit's 118 steps in more than one process, without changing a single assertion.
 *
 * The run is ~19 minutes of inherent step time on an idle machine and three to four times that on
 * a loaded one, and every second of it is serial because the harness has exactly one sandbox, one
 * daemon, one shell and one CDP session. Nothing about the *assertions* requires that. What
 * requires it is state — and the honest headline of this file is **how much of the suite that
 * turns out to be**.
 *
 * The partition here is drawn along that dependency and nowhere else. It was drawn three times,
 * each time against a real `--shards 2` run diffed with `compare-runs.mjs`, and each time the
 * suite refused it — see `FREE_LANE_ENABLED` below for the three attempts, their numbers and the
 * reason they do not converge. **The free lane is currently off and `--shards N` is exactly the
 * serial run.** Everything else here is live, proven, and is the vehicle for the wave that breaks
 * the coupling: read the manifest as a costed list of what would have to become self-provisioning.
 *
 * ## The lanes
 *
 * **spine** — anything the accumulated timeline reaches. It runs **serially in shard 0, in the
 * full canonical order**, exactly as it does today. Three independent things put a step here, and
 * every entry below names which one:
 *
 *   1. **Shared state.** `buildFlows` keeps one mutable object across flows (`state.firstPane`,
 *      `state.mdPane`, `state.webPane`, `state.agentPane`, `state.openedByDialog`); a reader is
 *      bound to the last writer before it, and the closure of that relation is in the spine.
 *   2. **The roster.** A step that changes the pane set or the active workspace changes the world
 *      every later spine step inherits. Read off run-AH2's own `state-timeline.jsonl` — the
 *      roster immediately before a step against the roster immediately after it — rather than
 *      guessed. This criterion was added because the first sharded run put fourteen roster-moving
 *      steps in the free lane and `settings-live-apply` then ran against `Default` with 3 panes
 *      instead of `Renamed One` with 6, and its §N25 width floor went red. That is the audit
 *      working correctly: the harness had shown it a different app.
 *   3. **Measured context.** A step that provisions its own panes can still *read* something the
 *      accumulated run left behind — a rebound key in the config, an agent parked in "waiting", a
 *      fourth label, a translucent window. `verify-manifest.mjs` runs each candidate alone from a
 *      cold boot and diffs it against the baseline; a real `--shards N` run diffed with
 *      `compare-runs.mjs` decides the rest. Both are re-runnable, and the entries below quote what
 *      they measured.
 *
 * **phone** - the third lane, added with the phone program (docs/MOBILE-PLAN.md E2). It is the
 * free lane's contract plus one clause: a phone step drives the renderer through CDP device
 * emulation (`audit.mjs` ▸ `emulatePhone`), so it must CLEAR that emulation before it returns.
 * The reason it is a lane of its own rather than a free step with a helper call is the roster
 * criterion above, read the other way round: a 390x844 window with a coarse pointer is a
 * different app, and any spine step that inherited one would be measuring a layout no desktop
 * user has. Keeping the phone steps named lets a sharded run put them in one process, and keeps
 * the "did you clear it?" question answerable by reading one list. A phone step that needs to
 * mutate the roster does not belong here; it belongs in the spine, like any other.
 *
 * **free** — what is left: a step that provisions everything it touches, changes nothing the
 * timeline carries, and reproduces its baseline result without the accumulated run behind it.
 * Many flows were made self-provisioning deliberately (the graft flows say so in a comment: "they
 * exist so the four flows below can each run alone under `--only`"), and that prose was the
 * starting point, not the evidence.
 *
 * Note that "alone" is stricter than "in the free lane": the free lane still runs its own members
 * in canonical order, so `settings-tab-*` — which fails alone, because nothing has opened Settings
 * — is perfectly safe in a shard that also holds `settings-open`. The solo run produces the
 * shortlist; the sharded run produces the verdict.
 *
 * ## The default is the spine
 *
 * `planShards` puts any step id it does not find in this manifest into the spine and says so.
 * A new flow therefore joins the serial lane and stays correct until somebody deliberately
 * declares it free — steps cannot drift between shards by being renamed or reordered, which is
 * the whole point of writing the partition down instead of computing it.
 *
 * ## The floor
 *
 * Shard 0 is the spine and the spine cannot be subdivided, so its own wall clock is the hard floor
 * for every `--shards N`. Even the most optimistic partition that survived a run put 930 s of a
 * ~1140 s suite in it, which is why `--shards 3` was never going to beat `--shards 2`: both reach
 * the floor and the third shard only halves an already-short free lane.
 *
 * Two things move that floor, and neither is this wave's to move:
 *
 *   - **the sleeps.** The spine's wall clock is mostly the 821 literal `sleep()` calls in the step
 *     bodies, not work — ~10.5 min of a ~19 min run. Shrinking those (the settle lane) shrinks
 *     the floor directly, and this partition scales with it unchanged.
 *   - **the chains.** The `chain` field records WHICH accumulated value binds each spine step
 *     (`firstPane`, `webPane`, `mdPane`, `agentPane`, `openedByDialog`), and those chains never
 *     touch each other's variables — so a wave allowed to change step bodies could give each chain
 *     its own shard, and every `reason` below is a specific, measured brief for that work. This
 *     wave is not allowed to: the instruction is that the spine stays in shard 0, and a harness
 *     that quietly re-parented stateful steps would be exactly the class of change the
 *     "assertion-identical" law exists to prevent.
 *
 * `cost` is the per-step wall clock measured in run-AH2, used only to balance the free lane's
 * blocks. A wrong cost makes a run slower, never wrong.
 */

import fs from 'node:fs';
import path from 'node:path';

import { summarize, writeReport } from './report.mjs';

/**
 * The step that is not a flow: `main()` appends it after the loop, in every process. Each shard
 * therefore produces its own console tally over its own renderer, and the aggregate folds them
 * into the one entry a serial run would have written.
 */
export const CONSOLE_STEP_ID = 'renderer-console';

/**
 * Is the free lane switched on?
 *
 * **No — measured, three times, and this is the result of the wave rather than an unfinished
 * corner of it.**
 *
 * Each attempt narrowed the free lane using a stricter criterion, ran a real `--shards 2`, and
 * diffed the aggregate against `docs/audit/run-AH2/results.json`:
 *
 *   | free lane | criterion added                                 | shard 0 wall | steps that stopped reproducing |
 *   | --------- | ----------------------------------------------- | ------------ | ------------------------------ |
 *   | 67        | no shared-state dependency (`state.firstPane`, …) | 567 s        | 5                              |
 *   | 47        | + roster-neutral, + reproduces alone             | 722 s        | 9                              |
 *   | 28        | + everything the previous run disproved          | 930 s        | 22                             |
 *   | 0 (off)   | —                                                | 1170 s       | 1 (a load-induced git timeout, green on re-run) |
 *
 * The failures did not converge, and they came from BOTH directions at once. Pull a step into the
 * free lane and it loses the world the accumulated run had built for it (`bulk-workspace-ops`
 * selecting one workspace where the baseline had two). Push a step into the spine and the free
 * lane loses ITS side effects (`sidebar-row-submenus` hunting a row called "Dragged One" that
 * nothing had created; the seven `settings-tab-*` steps erroring out because `settings-open` was
 * no longer in front of them). Narrowing the lane made the second class worse as fast as it fixed
 * the first.
 *
 * That is not a bug in the partition. It is what this suite is: 118 steps of one continuous
 * session, written deliberately so that step 99 asserts against the app step 1 through 98 built.
 * Roughly 85 % of it is bound to that timeline. There is no cut.
 *
 * So the switch is off and `--shards N` degrades to exactly today's serial run — safe by
 * construction, and honest about what was found. Everything else in this file stays live and
 * earns its keep the moment the coupling is broken:
 *
 *   - every `reason` below is a costed, measured brief for making one step self-provisioning;
 *   - the fan-out, the byte-compatible aggregate and the per-shard window placement are all
 *     proven (the aggregate was round-tripped against run-AH2 itself: same 118 steps, same
 *     indices, slugs, screenshot names and key order);
 *   - `verify-manifest.mjs` re-checks any candidate in ~5 s, and `compare-runs.mjs` decides.
 *
 * Flip this to `true` after a wave that makes the step bodies provision what they assert on — and
 * prove it the same way: `--shards 2`, then `compare-runs.mjs` against the baseline.
 */
export const FREE_LANE_ENABLED = false;

export const STEP_MANIFEST = [
    { id: 'fresh-boot', lane: 'free', chain: 'firstPane', cost: 0.5, reason: 'the cold-boot shape of a brand-new window; it writes state.firstPane, but the next writer (terminal-ls) supersedes it before any reader runs, so nothing downstream is bound to it' },
    { id: 'terminal-ls', lane: 'spine', chain: 'firstPane', cost: 4.3, reason: 'writes state.firstPane, which terminal-long-line reads' },
    { id: 'terminal-long-line', lane: 'spine', chain: 'firstPane', cost: 2.9, reason: 'reads state.firstPane' },
    { id: 'terminal-full-width', lane: 'spine', chain: 'firstPane', cost: 4.2, reason: 'reads state.firstPane' },
    { id: 'terminal-glyphs', lane: 'spine', chain: 'firstPane', cost: 4.2, reason: 'reads state.firstPane' },
    { id: 'terminal-nerdfont-prompt', lane: 'spine', chain: 'firstPane', cost: 5.1, reason: 'reads state.firstPane' },
    { id: 'terminal-size-matrix', lane: 'spine', chain: 'firstPane', cost: 19.3, reason: 'reads state.firstPane' },
    { id: 'terminal-resize-storm', lane: 'spine', chain: 'firstPane', cost: 64.1, reason: 'reads state.firstPane' },
    { id: 'split-keybinding', lane: 'spine', chain: 'firstPane', cost: 6.8, reason: 'writes state.firstPane, which split-cli reads' },
    { id: 'split-cli', lane: 'spine', chain: 'firstPane', cost: 2.5, reason: 'reads state.firstPane' },
    { id: 'keybinding-blast-radius', lane: 'spine', chain: 'firstPane', cost: 12.3, reason: 'reads state.firstPane' },
    { id: 'divider-drag', lane: 'spine', chain: null, cost: 3.7, reason: 'splits its own pane pair and drags their divider; touches no shared state; measured alone (verify-manifest.mjs): with no earlier step to split a pane it finds no divider at all — 7 assertions become 1, and the free lane has nothing before it that makes one' },
    { id: 'layout-nested-divider', lane: 'free', chain: null, cost: 6.8, reason: 'builds its own nested split tree and tears it down' },
    { id: 'close-pane', lane: 'spine', chain: 'firstPane', cost: 2.0, reason: 'reads state.firstPane' },
    { id: 'workspace-create-ui', lane: 'spine', chain: 'secondWorkspace', cost: 3.5, reason: 'writes state.secondWorkspace, which no later step ever reads; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'workspace-create-cli', lane: 'free', chain: null, cost: 4.4, reason: 'creates and deletes its own workspace' },
    { id: 'workspace-rename-context', lane: 'spine', chain: null, cost: 3.4, reason: 'renames a workspace it addresses by row, and puts the name back; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'workspace-switch', lane: 'spine', chain: null, cost: 4.5, reason: 'switches between rows it looks up at run time; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'tidy-grid', lane: 'spine', chain: 'firstPane', cost: 2.3, reason: 'writes state.firstPane, which appearance-system-stats reads' },
    { id: 'markdown-pane', lane: 'spine', chain: 'mdPane', cost: 2.6, reason: 'writes state.mdPane, which markdown-edit-toggle reads' },
    { id: 'markdown-edit-toggle', lane: 'spine', chain: 'mdPane', cost: 3.5, reason: 'reads state.mdPane' },
    { id: 'content-gutter-window', lane: 'spine', chain: 'mdPane', cost: 7.9, reason: 'reads state.mdPane' },
    { id: 'markdown-copy-header', lane: 'spine', chain: 'mdPane', cost: 1.1, reason: 'reads state.mdPane' },
    { id: 'diff-pane', lane: 'spine', chain: 'diffPane', cost: 2.6, reason: 'opens its own diff pane; writes state.diffPane, which no later step ever reads; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'content-pane-keybindings', lane: 'spine', chain: 'mdPane', cost: 5.3, reason: 'writes state.mdPane, which external-editor reads' },
    { id: 'web-pane', lane: 'spine', chain: 'webPane', cost: 12.2, reason: 'writes state.webPane, which web-find reads' },
    { id: 'web-find', lane: 'spine', chain: 'webPane', cost: 6.2, reason: 'reads state.webPane' },
    { id: 'web-url-bar-shortcut', lane: 'spine', chain: 'webPane', cost: 1.9, reason: 'reads state.webPane' },
    { id: 'web-batch-pickup', lane: 'spine', chain: 'webPane', cost: 9.4, reason: 'reads state.webPane' },
    { id: 'web-batch-internals', lane: 'spine', chain: 'webPane', cost: 9.0, reason: 'reads state.webPane' },
    { id: 'web-tab-strip', lane: 'spine', chain: 'webPane', cost: 22.1, reason: 'reads state.webPane' },
    { id: 'web-loading-strip', lane: 'spine', chain: 'webPane', cost: 6.1, reason: 'reads state.webPane' },
    { id: 'web-focus-handoff', lane: 'spine', chain: 'webPane', cost: 11.1, reason: 'reads state.webPane' },
    { id: 'web-page-click-focus', lane: 'spine', chain: 'webPane', cost: 8.4, reason: 'reads state.webPane' },
    { id: 'web-favourite', lane: 'spine', chain: 'webPane', cost: 16.6, reason: 'reads state.webPane' },
    { id: 'web-cookie-panel', lane: 'spine', chain: 'webPane', cost: 9.6, reason: 'reads state.webPane' },
    { id: 'web-console-frames', lane: 'free', chain: null, cost: 11.7, reason: 'opens its own web pane and closes it' },
    { id: 'web-popup-layering', lane: 'spine', chain: null, cost: 52.3, reason: 'provisions its own workspace, panes and popups, and tears them down; not roster-neutral in aggregate and never reproduced in a sharded run; held in the spine until it is' },
    { id: 'poster-swap', lane: 'spine', chain: null, cost: 18.0, reason: 'issue #12’s timing net: provisions its own workspace and web pane, samples per rAF against the shell’s own placement lines, and tears them down; roster-neutral only if it completes, so it sits beside `web-popup-layering` in the spine' },
    { id: 'settings-open', lane: 'free', chain: null, cost: 2.3, reason: 'opens Settings from the menu; reads nothing accumulated' },
    { id: 'settings-tab-general', lane: 'spine', chain: null, cost: 1.2, reason: 'clicks a Settings tab and reads its own panel; needs Settings open; safe beside settings-open in a shard, but held with the rest of the settings walk so the seven tabs cannot be split from it' },
    { id: 'settings-tab-appearance', lane: 'spine', chain: null, cost: 1.2, reason: 'clicks a Settings tab and reads its own panel; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'settings-tab-labels', lane: 'spine', chain: null, cost: 1.2, reason: 'clicks a Settings tab and reads its own panel; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'settings-tab-profiles', lane: 'spine', chain: null, cost: 1.2, reason: 'clicks a Settings tab and reads its own panel; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'settings-tab-keybindings', lane: 'spine', chain: null, cost: 1.2, reason: 'clicks a Settings tab and reads its own panel; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'settings-tab-web', lane: 'spine', chain: null, cost: 1.2, reason: 'clicks a Settings tab and reads its own panel; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'settings-tab-workspaces', lane: 'spine', chain: null, cost: 1.2, reason: 'clicks a Settings tab and reads its own panel; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'keybinding-record', lane: 'spine', chain: null, cost: 3.9, reason: 'records a binding into the sandbox config and reads it back; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'appearance-preset-theme', lane: 'free', chain: null, cost: 4.4, reason: 'drives the appearance controls and reads the resulting tokens' },
    { id: 'appearance-ghostty-write', lane: 'free', chain: null, cost: 7.5, reason: 'writes and re-reads the sandbox ghostty config' },
    { id: 'appearance-system-stats', lane: 'spine', chain: 'firstPane', cost: 13.1, reason: 'reads state.firstPane' },
    { id: 'appearance-sidebar-tint', lane: 'free', chain: null, cost: 5.4, reason: 'drives the tint control and reads the resulting tokens' },
    { id: 'global-hotkey-record', lane: 'free', chain: null, cost: 6.7, reason: 'records a hotkey into the sandbox settings and reads it back' },
    { id: 'settings-close', lane: 'free', chain: null, cost: 1.0, reason: 'closes Settings; opens it first if it is not open' },
    { id: 'agent-start', lane: 'spine', chain: 'agentPane', cost: 3.3, reason: 'writes state.agentPane, which agent-notification reads' },
    { id: 'agent-notification', lane: 'spine', chain: 'agentPane', cost: 2.5, reason: 'reads state.agentPane' },
    { id: 'agent-stop', lane: 'spine', chain: 'agentPane', cost: 3.8, reason: 'reads state.agentPane' },
    { id: 'agent-lifecycle', lane: 'spine', chain: null, cost: 11.6, reason: 'provisions its own pane and drives a whole hook lifecycle through it; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'agent-hook-routing', lane: 'free', chain: null, cost: 15.0, reason: 'provisions its own pane and fires hooks from inside it' },
    { id: 'agent-coexistence', lane: 'free', chain: null, cost: 2.1, reason: 'provisions the two panes it compares' },
    { id: 'status-popover', lane: 'free', chain: null, cost: 10.3, reason: 'provisions its own workspace and agents before reading the tray' },
    { id: 'repo-registry', lane: 'free', chain: null, cost: 12.3, reason: 'provisions its own repo fixture and association (shared `autoDetectRepo` helper)' },
    { id: 'inspector-open', lane: 'free', chain: null, cost: 1.2, reason: 'opens the inspector through `ensureInspector`, which provisions and settles it' },
    { id: 'inspector-repo-status', lane: 'spine', chain: null, cost: 5.2, reason: 'provisions its own association through `ensureInspector` + the repo helpers; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'footer-git-stats', lane: 'spine', chain: null, cost: 14.8, reason: 'provisions its own repo state and restores the working tree; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'inspector-worktree-create', lane: 'spine', chain: null, cost: 3.2, reason: 'creates its own worktree from its own association; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'workspace-create-worktree', lane: 'spine', chain: null, cost: 7.7, reason: 'creates its own worktree-backed workspace; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'sidebar-resize', lane: 'free', chain: null, cost: 3.6, reason: 'drags the sidebar edge and puts it back' },
    { id: 'bulk-workspace-ops', lane: 'spine', chain: null, cost: 8.0, reason: 'creates the workspaces it operates on (documented as runnable alone); but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'pane-context-menu', lane: 'spine', chain: 'firstPane', cost: 7.7, reason: 'writes state.firstPane, which terminal-input-matrix reads' },
    { id: 'terminal-input-matrix', lane: 'spine', chain: 'firstPane', cost: 24.3, reason: 'reads state.firstPane' },
    { id: 'terminal-ime', lane: 'spine', chain: 'firstPane', cost: 30.3, reason: 'reads state.firstPane' },
    { id: 'terminal-cursor-focus', lane: 'spine', chain: null, cost: 18.6, reason: 'splits its own pane pair to move focus between, and closes it; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'terminal-osc52', lane: 'spine', chain: 'firstPane', cost: 25.1, reason: 'reads state.firstPane' },
    { id: 'terminal-host-edges', lane: 'spine', chain: null, cost: 47.1, reason: 'provisions its own workspace and panes for each edge case; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'terminal-kitty', lane: 'spine', chain: 'firstPane', cost: 22.8, reason: 'reads state.firstPane' },
    { id: 'pane-title-osc', lane: 'spine', chain: 'firstPane', cost: 6.1, reason: 'reads state.firstPane' },
    { id: 'pane-header-details', lane: 'spine', chain: 'firstPane', cost: 14.6, reason: 'reads state.firstPane' },
    { id: 'terminal-search', lane: 'spine', chain: 'firstPane', cost: 8.7, reason: 'reads state.firstPane' },
    { id: 'reopen-closed-pane', lane: 'spine', chain: 'firstPane', cost: 8.3, reason: 'reads state.firstPane' },
    { id: 'scratchpad-create', lane: 'spine', chain: 'firstPane', cost: 10.2, reason: 'reads state.firstPane' },
    { id: 'last-pane-close-deletes-workspace', lane: 'free', chain: null, cost: 7.7, reason: 'creates the workspace it then closes the last pane of' },
    { id: 'capture-parity', lane: 'spine', chain: 'firstPane', cost: 9.3, reason: 'reads state.firstPane' },
    { id: 'open-file-dialog', lane: 'spine', chain: 'openedByDialog', cost: 4.6, reason: 'writes state.openedByDialog, which external-editor reads' },
    { id: 'external-editor', lane: 'spine', chain: 'openedByDialog+mdPane', cost: 13.3, reason: 'reads state.openedByDialog and state.mdPane' },
    { id: 'cmd-click-path', lane: 'spine', chain: 'firstPane', cost: 7.4, reason: 'writes state.firstPane, which repo-autodetect reads' },
    { id: 'drop-markdown', lane: 'free', chain: null, cost: 5.0, reason: 'drops a fixture file it wrote itself and closes the pane' },
    { id: 'terminal-drop-and-paste', lane: 'free', chain: null, cost: 8.0, reason: 'drops onto a pane it looks up at run time' },
    { id: 'help-overlay', lane: 'spine', chain: null, cost: 1.6, reason: 'opens and closes the overlay; held in the spine: it did not reproduce its baseline result once the accumulated run was taken away (verify-manifest.mjs and/or a --shards 2 run diffed with compare-runs.mjs)' },
    { id: 'titlebar-menu', lane: 'free', chain: null, cost: 3.2, reason: 'opens the ••• menu and reads it' },
    { id: 'graft-toggle', lane: 'free', chain: null, cost: 5.5, reason: 'documented self-provisioning: "they exist so the four flows below can each run alone under --only"' },
    { id: 'graft-swap-prompt', lane: 'free', chain: null, cost: 5.2, reason: 'documented self-provisioning (graft helper block)' },
    { id: 'graft-orphan-banner', lane: 'free', chain: null, cost: 9.3, reason: 'documented self-provisioning (graft helper block)' },
    { id: 'repo-autodetect', lane: 'spine', chain: 'firstPane', cost: 8.2, reason: 'reads state.firstPane' },
    { id: 'pane-branch-chain', lane: 'spine', chain: null, cost: 17.3, reason: 'builds its own `branchRepo` fixture and the panes that read it; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'tray-agent-rows', lane: 'spine', chain: null, cost: 4.1, reason: 'provisions the agents whose tray rows it reads; measured alone it sees zero waiting panes — the row it renders is the pane agent-stop (spine) left waiting' },
    { id: 'settings-tcp-state', lane: 'free', chain: null, cost: 2.3, reason: 'reads the sandbox daemon’s own TCP state' },
    { id: 'open-relative-path', lane: 'spine', chain: null, cost: 7.6, reason: 'opens a path it writes itself, from a pane it provisions; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'settings-repositories', lane: 'free', chain: null, cost: 8.5, reason: 'provisions its own registry entries (documented as runnable alone)' },
    { id: 'settings-live-apply', lane: 'spine', chain: 'firstPane', cost: 22.0, reason: 'reads state.firstPane' },
    { id: 'workspace-create-full', lane: 'spine', chain: null, cost: 12.7, reason: 'provisions everything the create sheet needs (documented as runnable alone); but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'sidebar-ring-clearance', lane: 'spine', chain: null, cost: 3.7, reason: 'creates the rows it measures; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'sidebar-drag-nest-preview', lane: 'spine', chain: null, cost: 5.6, reason: 'creates the rows it drags; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'sidebar-row-submenus', lane: 'spine', chain: null, cost: 13.2, reason: 'opens the row menus on rows it provisions; measured in a 2-shard run: it looks for the row named "Dragged One", which sidebar-drag-affordances (spine) leaves behind' },
    { id: 'sidebar-drag-affordances', lane: 'spine', chain: null, cost: 19.3, reason: 'creates its own rows (documented as runnable alone); its local `state` object is the drag model, not the run’s; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'sidebar-spring', lane: 'spine', chain: null, cost: 14.3, reason: 'creates its own rows (documented as runnable alone); measured alone: two of the baseline run three known reds are HERE, and alone they pass — the spring only misses its dwell against the accumulated row set, so moving it would silently repaint a known defect green' },
    { id: 'panel-slide-flash', lane: 'free', chain: null, cost: 4.7, reason: 'drives the panel slide from whatever the sidebar currently is; its local `state` object is the slide sample, not the run’s' },
    { id: 'sidebar-escape-clears-selection', lane: 'spine', chain: null, cost: 5.8, reason: 'selects the rows it then clears; measured alone, its "there are rows to select" check finds 1 row; the multi-selection it is about needs the workspaces the spine accumulates' },
    { id: 'repo-picker-multiselect', lane: 'spine', chain: null, cost: 11.3, reason: 'provisions its own repo fixtures before opening the picker; measured in a 2-shard run: the picker shows the repos it associates as already Added, because the free lane no longer had the registry state the baseline accumulated' },
    { id: 'labels-design', lane: 'spine', chain: null, cost: 20.1, reason: 'creates its own labels (documented as runnable alone); its local `state` object is the label model, not the run’s; measured alone, its reorder assertions read 0 to 1 of 3 against the baseline 1 to 2 of 4 — the fourth label comes from workspace-create-full / bulk-workspace-ops, both spine' },
    { id: 'search-colors', lane: 'spine', chain: null, cost: 9.0, reason: 'opens its own markdown pane; writes state.mdPane, which no later step reads; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' },
    { id: 'keybinding-conflict', lane: 'free', chain: null, cost: 5.5, reason: 'records the conflicting binding it then inspects' },
    { id: 'window-transparency', lane: 'spine', chain: null, cost: 7.5, reason: 'reads the window’s own compositing state (documented as runnable alone); measured alone: it reports an OPAQUE pane fill where the baseline has the translucent one — the ghostty opacity is applied live by settings-live-apply, which is spine' },
    { id: 'sidebar-remaining', lane: 'spine', chain: 'firstPane', cost: 28.6, reason: 'reads state.firstPane' },
    { id: 'debug-menu', lane: 'free', chain: null, cost: 6.3, reason: 'opens the debug menu and closes it' },
    { id: 'workspace-edges', lane: 'spine', chain: null, cost: 30.5, reason: 'creates the edge-case workspaces it drives, and deletes them; measured alone and in a 2-shard run: one of the three known reds is HERE (a header reveal that fails only against the accumulated sidebar) and it goes green without that context' },
    { id: 'reattach-after-relaunch', lane: 'spine', chain: 'firstPane', cost: 24.4, reason: 'reads state.firstPane, and relaunches the shell the rest of shard 0 is attached to' },
    { id: 'phone-form-factor', lane: 'phone', chain: null, cost: 6.0, reason: 'the phone lane\'s smoke: it emulates a 390x844 phone, reads `data-form-factor` off <html>, fires the three touch helpers into a capture-phase `preventDefault`, and clears the emulation in a `finally`. It provisions nothing, reads nothing the timeline carries, and moves no pane, workspace, focus or setting - measured in a three-step run (`--only fresh-boot,terminal-ls,phone-form-factor`), the `state-timeline.jsonl` rows either side of it are identical. Placed immediately before `mac-chrome` (which must stay last) so the phone lane sits at the tail of the canonical order' },
    { id: 'mac-chrome', lane: 'spine', chain: null, cost: 21.5, reason: 'reads the window chrome and the menus it opens itself; but it MUTATES the accumulated roster (run-AH2 state timeline: the pane set or the active workspace differs across it) and shard 0 inherits that roster — measured: with these in the free lane, settings-live-apply ran against Default/3 panes instead of Renamed One/6 and its §N25 width floor went red' }
];

const BY_ID = new Map(STEP_MANIFEST.map((entry) => [entry.id, entry]));

/** The canonical step order — the order `buildFlows` returns and `results.json` must preserve. */
export const CANONICAL_ORDER = STEP_MANIFEST.map((entry) => entry.id);

export function manifestEntry(id) {
    return BY_ID.get(id);
}

/**
 * Split a contiguous list into `count` blocks minimising the largest block's cost.
 *
 * Contiguous rather than round-robin, and that is deliberate: a free step is independent, but
 * "independent" was established by running it alone, and keeping neighbours together keeps a
 * shard's step sequence as close to the canonical one as the split allows. Binary search on the
 * cost bound with a greedy feasibility check gives the exact optimum for a contiguous partition.
 */
export function balanceBlocks(items, count) {
    if (count <= 1) return [items.slice()];
    if (items.length <= count) return items.map((item) => [item]).concat(Array.from({ length: count - items.length }, () => []));
    const costs = items.map((item) => Math.max(item.cost ?? 1, 0.1));
    const fits = (bound) => {
        let blocks = 1;
        let current = 0;
        for (const cost of costs) {
            if (cost > bound) return false;
            if (current + cost > bound) {
                blocks += 1;
                current = cost;
            } else current += cost;
        }
        return blocks <= count;
    };
    let low = Math.max(...costs);
    let high = costs.reduce((sum, cost) => sum + cost, 0);
    // A fixed epsilon, not `low < high`: halving a real interval never closes it, so the naive
    // form spins forever once every probe is feasible. A hundredth of a second of imbalance is
    // far below the noise floor of the thing being balanced.
    while (high - low > 0.01) {
        const mid = (low + high) / 2;
        if (fits(mid)) high = mid;
        else low = mid + 0.01;
    }
    low = high;
    const blocks = [[]];
    let current = 0;
    for (let i = 0; i < items.length; i++) {
        if (current + costs[i] > low && blocks.length < count) {
            blocks.push([]);
            current = 0;
        }
        blocks[blocks.length - 1].push(items[i]);
        current += costs[i];
    }
    while (blocks.length < count) blocks.push([]);
    return blocks;
}

/**
 * Plan the partition for a concrete run.
 *
 * `stepIDs` is what the harness actually built, in build order — passing it in (rather than
 * trusting the manifest) is what makes manifest drift loud: an id the manifest has never heard of
 * lands in the spine and is reported, and an id the manifest names that no longer exists is an
 * error, because a partition computed against a stale list is a partition that silently drops
 * steps.
 */
/**
 * The per-class fidelity escape hatch.
 *
 * A step listed here is measurably worse with the window off the work area — the compositor is
 * skipping frames its instrument counts — so it must run in a window that is actually on screen.
 * Placement is a property of the *process* (Electron fixes it when the window is built), so the
 * planner gives these steps a shard of their own and the parent launches that one shard with
 * `--window onscreen`; the other shards keep the screen free.
 *
 * The list is empty because the placement that would have needed it is not in use.
 *
 * `window-fidelity.mjs` did find a genuine per-class degradation — `panel-slide-flash` offscreen
 * classified **32 mid-slide frames of 76** where a visible window gave **52 of 120**, exactly
 * tracking the 74.9 Hz vs 120 Hz frame clock the same tool measured — so this mechanism has a real
 * first customer waiting. But the offscreen placement is disqualified for a broader reason (a 1×
 * backing store, which moves every sub-pixel measurement in the suite at once, not one class), so
 * the harness runs `default` and there is nothing to pin. See
 * `packages/shell/src/audit-window.ts` for the table.
 *
 * Add an id here and it gets a shard of its own launched with `--window onscreen`; nothing else
 * about the run changes.
 */
export const ONSCREEN_STEPS = new Set([]);

export function planShards(stepIDs, shardCount) {
    const known = new Set(stepIDs);
    const missing = CANONICAL_ORDER.filter((id) => !known.has(id));
    if (missing.length > 0) {
        throw new Error(
            `the shard manifest names ${String(missing.length)} step(s) the harness no longer builds: ${missing.join(', ')}.\n` +
                'Update scripts/ui-audit/lib/shards.mjs — a partition computed against a stale manifest drops steps.'
        );
    }
    const undeclared = stepIDs.filter((id) => !BY_ID.has(id));
    const entries = stepIDs.map((id) => BY_ID.get(id) ?? { id, lane: 'spine', chain: null, cost: 10, reason: 'not declared in the shard manifest — a new step joins the serial spine until it is measured and declared free' });

    if (shardCount <= 1) {
        return {
            shardCount: 1,
            groups: [entries.map((entry) => entry.id)],
            placements: [null],
            entries,
            undeclared,
            spine: entries.map((e) => e.id),
            free: [],
            phone: [],
            onscreen: entries.filter((entry) => ONSCREEN_STEPS.has(entry.id)).map((entry) => entry.id)
        };
    }
    /*
     * The fidelity class first: it is pinned to a placement, so it cannot share a process with
     * anything else. It comes out of the free lane (a spine step that needed an onscreen window
     * would pin the whole spine, and that is a decision for whoever adds one, not for this code
     * to make silently — hence the check below).
     */
    const pinned = FREE_LANE_ENABLED ? entries.filter((entry) => ONSCREEN_STEPS.has(entry.id)) : [];
    const pinnedSpine = pinned.filter((entry) => entry.lane === 'spine');
    if (pinnedSpine.length > 0) {
        throw new Error(
            `these steps are both spine and onscreen-pinned, which cannot both be honoured: ${pinnedSpine.map((e) => e.id).join(', ')}.\n` +
                'Either run the whole audit with --window onscreen, or take them out of ONSCREEN_STEPS.'
        );
    }
    // The free lane is disabled (see `FREE_LANE_ENABLED`): every step is spine, shard 0 is the
    // whole canonical order, and the other shards are empty — so `--shards N` is exactly today's
    // serial run rather than a differently-broken one. The phone lane rides the same switch: with
    // it off, a phone step is a spine step that happens to emulate and restore a viewport, which
    // is exactly what it does in the serial run today.
    const spine = entries.filter((entry) => FREE_LANE_ENABLED ? entry.lane === 'spine' : true);
    const free = FREE_LANE_ENABLED
        ? entries.filter((entry) => entry.lane === 'free' && !ONSCREEN_STEPS.has(entry.id))
        : [];
    /*
     * The phone lane gets a group of its own, not a block of the free lane. Its steps emulate a
     * phone viewport and restore it, and grouping them keeps that window of altered geometry
     * inside one process - a free step sharing a renderer with one mid-emulation would be
     * measuring the wrong app. No window placement is pinned: the emulation is a renderer
     * override applied per step, which is the whole reason `--window phone` does not exist
     * (`audit.mjs` ▸ the phone viewport block).
     */
    const phone = FREE_LANE_ENABLED ? entries.filter((entry) => entry.lane === 'phone') : [];
    const extraGroups = (pinned.length > 0 ? 1 : 0) + (phone.length > 0 ? 1 : 0);
    const freeShards = Math.max(1, shardCount - 1 - extraGroups);
    const blocks = balanceBlocks(free, freeShards);
    const groups = [spine.map((entry) => entry.id), ...blocks.map((block) => block.map((entry) => entry.id))];
    const placements = [null, ...blocks.map(() => null)];
    if (phone.length > 0) {
        groups.push(phone.map((entry) => entry.id));
        placements.push(null);
    }
    if (pinned.length > 0) {
        groups.push(pinned.map((entry) => entry.id));
        placements.push('onscreen');
    }
    return {
        shardCount: groups.length,
        groups,
        /** Per-shard window placement override, or null for "whatever the run was asked for". */
        placements,
        entries,
        undeclared,
        spine: spine.map((entry) => entry.id),
        free: free.map((entry) => entry.id),
        phone: phone.map((entry) => entry.id),
        onscreen: pinned.map((entry) => entry.id)
    };
}

/** A human-readable partition table, printed before a sharded run starts. */
export function describePartition(plan) {
    const lines = [];
    const cost = (ids) => ids.reduce((sum, id) => sum + (BY_ID.get(id)?.cost ?? 10), 0);
    const phoneSet = new Set(plan.phone ?? []);
    for (let i = 0; i < plan.groups.length; i++) {
        const ids = plan.groups[i];
        const placement = plan.placements?.[i] ?? null;
        const isPhone = i > 0 && ids.length > 0 && ids.every((id) => phoneSet.has(id));
        const lane =
            plan.groups.length === 1
                ? 'serial (all steps)'
                : placement !== null
                  ? `fidelity class (window ${placement})`
                  : i === 0
                    ? 'spine (serial, canonical order)'
                    : isPhone
                      ? 'phone (device emulation, cleared per step)'
                      : 'free';
        lines.push(`  shard ${String(i)} — ${lane}: ${String(ids.length)} steps, ~${cost(ids).toFixed(0)}s of measured step time`);
    }
    if (!FREE_LANE_ENABLED) {
        lines.push('  (the free lane is off — see FREE_LANE_ENABLED in lib/shards.mjs; this run is the serial run)');
    }
    if (plan.undeclared.length > 0) {
        lines.push(`  ⚠ ${String(plan.undeclared.length)} undeclared step(s) placed in the spine: ${plan.undeclared.join(', ')}`);
        lines.push('    Declare them in scripts/ui-audit/lib/shards.mjs once they have been measured alone.');
    }
    return lines.join('\n');
}

// ── aggregation ─────────────────────────────────────────────────────────────────────

function renameArtefact(shardDir, outDir, name, fromSlug, toSlug) {
    if (!name.startsWith(fromSlug)) return name;
    const renamed = `${toSlug}${name.slice(fromSlug.length)}`;
    try {
        fs.copyFileSync(path.join(shardDir, name), path.join(outDir, renamed));
    } catch {
        // A missing artefact is recorded as-is rather than crashing the aggregate: the step's
        // own entry already says what happened.
    }
    return renamed;
}

/**
 * Fold every shard's run directory into one that is indistinguishable from a serial run's.
 *
 * Byte-compatibility with the serial `results.json` is the contract — the campaign's
 * reconciliation tooling reads it — so this does not invent a shard-shaped schema. It re-orders
 * the steps into the canonical order, renumbers `index`/`slug` as a single-process run would,
 * copies every PNG and text artefact across under its canonical name, and rewrites the `shots`
 * list and the `artifact: …` notes to match. `meta` gains one extra key (`shards`) and keeps
 * every key it had.
 */
export function aggregateShards({ outDir, shardDirs, canonicalOrder, meta }) {
    const collected = new Map();
    const consoleEntries = [];
    const shardMeta = [];
    for (let i = 0; i < shardDirs.length; i++) {
        const dir = shardDirs[i];
        const file = path.join(dir, 'results.json');
        if (!fs.existsSync(file)) {
            shardMeta.push({ shard: i, dir, ok: false, error: 'no results.json' });
            continue;
        }
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        shardMeta.push({ shard: i, dir: path.basename(dir), ok: true, steps: parsed.steps.length, summary: parsed.summary });
        for (const step of parsed.steps) {
            if (step.id === CONSOLE_STEP_ID) {
                consoleEntries.push({ step, dir });
                continue;
            }
            if (collected.has(step.id)) {
                throw new Error(`step "${step.id}" was produced by two shards — the partition is not a partition`);
            }
            collected.set(step.id, { step, dir });
        }
        // The per-run logs are namespaced rather than merged: "which process saw this" is the
        // question they exist to answer.
        for (const log of ['daemon.log', 'shell.log', 'cli-invocations.jsonl', 'state-timeline.jsonl']) {
            const from = path.join(dir, log);
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, `shard-${String(i)}-${log}`));
        }
    }

    const steps = [];
    let counter = 0;
    const emit = (entry, dir) => {
        counter += 1;
        const index = String(counter).padStart(2, '0');
        const slug = `${index}-${entry.id}`;
        const fromSlug = entry.slug;
        const shots = entry.shots.map((name) => renameArtefact(dir, outDir, name, fromSlug, slug));
        const notes = entry.notes.map((note) =>
            note.startsWith('artifact: ')
                ? `artifact: ${renameArtefact(dir, outDir, note.slice('artifact: '.length), fromSlug, slug)}`
                : note
        );
        steps.push({ ...entry, index, slug, shots, notes });
    };

    for (const id of canonicalOrder) {
        const found = collected.get(id);
        if (found === undefined) continue;
        emit(found.step, found.dir);
        collected.delete(id);
    }
    // Anything the canonical order does not name (a step added since the manifest was written)
    // still lands in the report, after the known ones, rather than vanishing.
    for (const [, found] of collected) emit(found.step, found.dir);

    if (consoleEntries.length > 0) {
        /*
         * One console tally, as a serial run writes: each shard watched its own renderer, so the
         * merged verdict is the conjunction and the merged detail is the sum. The assertion NAME
         * and count are preserved exactly — this step is one assertion in a serial run and stays
         * one here.
         */
        const template = consoleEntries[0].step;
        const total = consoleEntries.reduce((sum, { step }) => {
            const detail = step.assertions[0]?.detail ?? '0 distinct';
            return sum + (Number.parseInt(detail, 10) || 0);
        }, 0);
        const ok = consoleEntries.every(({ step }) => step.assertions.every((assertion) => assertion.ok));
        const blocks = consoleEntries.flatMap(({ step }) => step.blocks);
        counter += 1;
        const index = String(counter).padStart(2, '0');
        steps.push({
            ...template,
            index,
            slug: `${index}-${CONSOLE_STEP_ID}`,
            assertions: [{ name: template.assertions[0]?.name ?? 'no renderer console errors/warnings', ok, detail: `${String(total)} distinct` }],
            blocks,
            notes: template.notes,
            shots: [],
            error: consoleEntries.find(({ step }) => step.error !== null)?.step.error ?? null
        });
    }

    const summary = summarize(steps);
    return writeReport(outDir, { meta: { ...meta, shards: shardMeta }, summary, steps });
}
