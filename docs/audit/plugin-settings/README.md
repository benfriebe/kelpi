# Settings presenter validation, 2026-09-12

Retained onscreen evidence for the full Settings presentation item (shared settings contracts,
selectable `settings.window` presenter, Settings Lab). The dated
[validation record](../../plugin-validation.md#settings-lab-and-live-acceptance-2026-09-12)
carries the tested revision, commands and counts. The scenario is
`scripts/scenarios/plugin-settings-presenter.mjs`; these four screenshots come from its final
onscreen run and were inspected.

![Settings Lab selected for settings.window, routed to General: the lab draws its own rail and the Worktrees, Repositories and Workspaces cards with Commit and Reset per row; below the frame the host draws General's native remainder, sized to its content](lab-settings-general.png)

![Settings Lab routed to Appearance: the projected Chrome and Sidebar rows inside the frame, with the host's native remainder (the preset theme gallery and Save and share) drawn below it](lab-settings-appearance.png)

![After the presenter crashed on purpose: the bundled Settings dialog takes over on the same section with the failure toast in the corner](bundled-after-failure.png)

![Settings, Plugins, Workbench views: settings.window selected to Settings Lab, the presenter reported as failed with its error and the Retry presenter control, and both interaction rows bundled](settings-presenter-status.png)

Recorded limits: daemon disconnect and reconnect is not pressed by the scenario; the call
budget breach is covered by unit tests only; phone checks use emulation; physical devices are
not covered.
