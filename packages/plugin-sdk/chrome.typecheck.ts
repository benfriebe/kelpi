import type { ChromeKeymap, ChromeKeymapCommand, ChromeSnapshot, WindowChromeAPI } from './chrome.js';

declare const ui: WindowChromeAPI;

/** The keymap is what Help draws: native sections, then each plugin's commands under its name. */
function describeShortcut(command: ChromeKeymapCommand): string {
    if (command.shortcut !== null && command.currently !== null) {
        return `${command.title} ${command.shortcut}, currently ${command.currently.by} (${command.currently.plugin})`;
    }
    if (command.shortcut !== null) return `${command.title} ${command.shortcut}`;
    if (command.shadowed === null) return command.title;
    const owner = command.shadowed.plugin === null ? command.shadowed.by : `${command.shadowed.by} (${command.shadowed.plugin})`;
    return `${command.title}: ${command.shadowed.shortcut} runs ${owner}`;
}

async function readKeymap(): Promise<void> {
    const snapshot: ChromeSnapshot = await ui.getChrome();
    const keymap: ChromeKeymap = snapshot.keymap;
    for (const section of keymap.sections) for (const action of section.actions) void [section.category, action.action, action.shortcut];
    for (const plugin of keymap.plugins) for (const command of plugin.commands) void describeShortcut(command);
    void keymap.withheld;
    // Read-only: nothing on the snapshot rebinds a key.
    // @ts-expect-error keymap is readonly
    snapshot.keymap = keymap;
    // @ts-expect-error a row is readonly
    keymap.plugins[0]!.commands[0]!.shortcut = '⌘K';
}
void readKeymap;
