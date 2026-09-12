import type { SettingsFieldSnapshot, SettingsPlacement, SettingsPresenterSnapshot, SettingsSectionSummary, WindowSettingsAPI } from './settings.js';

declare const ui: WindowSettingsAPI;
declare const snapshot: SettingsPresenterSnapshot;

const placement: SettingsPlacement = snapshot.placement;
const section: SettingsSectionSummary = { id: 'general', title: 'General', icon: 'gearshape', native: false };
const field: SettingsFieldSnapshot = { id: 'general.confirmQuit', sectionID: 'general', groupID: 'general.window', kind: 'toggle', label: 'Confirm before quitting', detail: 'Ask before closing the last window.', value: true };
void [placement, section, field];

async function present(): Promise<void> {
    const current: SettingsPresenterSnapshot = await ui.getSettingsPresentation();
    const stop = ui.onSettingsPresentation(value => { void value.dirty; }, error => { void error.message; });
    await ui.reportPresenterReady();
    for (const entry of current.sections) if (!entry.native) await ui.setSettingsSection(entry.id);
    // A native section, or a native remainder, is drawn by the bundled panel; present the rail only.
    if (!current.native) {
        for (const group of current.groups) void group.title;
        for (const row of current.fields) {
            if (row.kind === 'text') await ui.setSettingsDraft(row.id, row.value.slice(0, row.maxLength));
            if (row.kind === 'number' || row.kind === 'slider') await ui.setSettingsDraft(row.id, String(Math.min(row.max, row.value + 1)));
            if (row.kind === 'select' || row.kind === 'segmented') await ui.setSettingsDraft(row.id, row.choices[0]?.value ?? row.value);
            if (row.kind === 'toggle') await ui.setSettingsDraft(row.id, String(!row.value));
            if (row.draft !== undefined && row.error === undefined && row.disabled !== true) await ui.commitSettingsField(row.id);
            else if (row.error !== undefined) await ui.resetSettingsField(row.id);
            void row.busy;
        }
    }
    await ui.closeSettings();
    stop();
}
void present;

// @ts-expect-error A field carries no write target: the presenter sends an id, the host owns the key.
const keyed: SettingsFieldSnapshot = { ...field, configKey: 'confirm-quit' };
// @ts-expect-error Audit selectors stay host-side; a projection carries no testID.
void snapshot.fields[0]?.testID;
// @ts-expect-error A section is a rail entry, never the plugin behind a contributed one.
void snapshot.sections[0]?.pluginID;
// @ts-expect-error A draft is text; a parsed value never crosses back.
void ui.setSettingsDraft('general.tcpPort', 19_400);
// @ts-expect-error Commit names a field; it carries no value and no verb.
void ui.commitSettingsField('general.tcpPort', '19400');
// @ts-expect-error Routing takes a section id, not the summary the frame published.
void ui.setSettingsSection(section);
// @ts-expect-error Opening Settings stays a window gesture; a presenter may only close it.
void ui.openSettings('plugins');
// @ts-expect-error Destructive actions are native buttons; a presenter cannot invoke one.
void ui.resetKeybindings();
void keyed;
