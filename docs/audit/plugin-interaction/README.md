# Interaction presenter validation, 2026-09-12

Retained onscreen evidence for the palette and shared-prompt phase (shared interaction
contracts, selectable presenters, Interaction Lab). The dated
[validation record](../../plugin-validation.md#interaction-lab-and-live-acceptance-2026-09-12)
carries the tested revision, commands and counts. The scenario is
`scripts/scenarios/plugin-interaction-presenters.mjs`; these four screenshots come from its
final onscreen run and were inspected.

![Interaction Lab selected for interaction.palette: the plugin palette lists workspaces, panes and commands with glyph icons, inside the content row with the title bar, panes and status footer visible around it](plugin-palette-open.png)

![Interaction Lab selected for interaction.prompts: a UI Lab quick pick rendered by the plugin presenter with the owner's display name badge, the queue count, a disabled item, and the window visible behind a translucent backdrop](plugin-prompt-dialog.png)

![After the prompts presenter crashed on purpose: the bundled dialog re-presents the same UI Lab input beside the failure toast, with UI Lab still waiting for the answer](bundled-dialog-after-failure.png)

![Settings, Plugins, Workbench views: both interaction placements selected to Interaction Lab, the prompts presenter reported as failed with its error, and the Retry presenter control](settings-presenter-status.png)

Recorded limits: daemon disconnect and reconnect is not pressed by the scenario; phone checks
use emulation; physical devices are not covered. Selectable notification presentation is not
part of this phase.
