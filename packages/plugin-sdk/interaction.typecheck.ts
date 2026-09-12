import type { InteractionPaletteItem, InteractionOwnerRef, InteractionPlacement, InteractionSnapshot, WindowInteractionAPI } from './interaction.js';

declare const ui: WindowInteractionAPI;
declare const snapshot: InteractionSnapshot;

const placement: InteractionPlacement = snapshot.placement;
const row: InteractionPaletteItem = { id: 'kelpi.window.openSettings', kind: 'command', icon: 'gear', title: 'Settings', subtitle: 'Window', workspaceID: null, workspaceName: 'Work', paneID: null, workspaceColor: null, disabled: false, shortcut: 'Cmd+,' };
const owner: InteractionOwnerRef = { ref: 'owner-1', displayName: 'Prompt Plugin' };
void [placement, row, owner];

async function present(): Promise<void> {
    const current: InteractionSnapshot = await ui.getInteraction();
    const stop = ui.onInteraction(value => { void value.paletteOpen; }, error => { void error.message; });
    await ui.reportPresenterReady();
    if (current.palette !== null) {
        const items: readonly InteractionPaletteItem[] = current.palette.items;
        await ui.setPaletteQuery(current.palette.sessionID, 'settings');
        await ui.setPaletteSelection(current.palette.sessionID, items[0]?.id ?? null);
        await ui.activatePaletteItem(current.palette.sessionID, 'kelpi.window.openSettings');
        await ui.dismissPalette(current.palette.sessionID);
    }
    if (current.prompt?.kind === 'quickPick') await ui.respondInteraction(current.prompt.requestID, current.prompt.options.items[0]!.id);
    if (current.prompt?.kind === 'input') await ui.respondInteraction(current.prompt.requestID, current.prompt.options.value ?? '');
    if (current.prompt?.kind === 'dialog') await ui.respondInteraction(current.prompt.requestID, null);
    // Reserved and always empty in this release: the bundled stack draws notifications.
    for (const notice of current.notifications) void notice.owner.displayName;
    stop();
}
void present;

// @ts-expect-error A palette row carries no activation closure; activation goes back through the host.
const closure: InteractionPaletteItem = { ...row, run: () => {} };
// @ts-expect-error An owner is a display name and an opaque ref, never a plugin identity.
const identified: InteractionOwnerRef = { ref: 'owner-2', displayName: 'Prompt Plugin', pluginID: 'sample.prompts' };
// @ts-expect-error A presenter reads the owner it may render, not the plugin behind it.
void snapshot.prompt?.owner.pluginID;
// @ts-expect-error A request is settled with an item, action or input string, or null.
void ui.respondInteraction('request', { id: 'yes' });
// @ts-expect-error Every palette call is checked against the session that is open.
void ui.setPaletteQuery('settings');
// @ts-expect-error Opening the palette stays a window gesture; a presenter may only dismiss it.
void ui.openPalette('all');
void [closure, identified];
