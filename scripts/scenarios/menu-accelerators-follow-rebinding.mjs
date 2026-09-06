/**
 * #47: the application menu's accelerators follow the user's keybindings, live.
 *
 * config-keybindings.md §7.1, shell-ui.md §13. The menu is native, so CDP cannot see it and
 * cannot press its accelerators; both go through the shell's harness channel. The rebind is
 * made the way a user makes it: `keybind = ...` lines in the daemon's config file, which the
 * daemon watches (§1.4) and broadcasts, and which the shell turns into a menu rebuild.
 *
 * Two things the first live run taught this file: Electron spells a chord modifiers-first
 * (`Shift+CommandOrControl+S`), so chords are compared as sets, never as strings; and a
 * `keybind` line ADDS a trigger (§1.3), so the default stays bound until an explicit `unbind`,
 * which is why the negative assertion below unbinds it first.
 */
import fs from 'node:fs';

const TOGGLE = /^toggle sidebar$/i;
const sidebarShown = (page) => page.eval(`document.querySelector('[data-testid="sidebar"]') !== null`);

/** An Electron accelerator as a comparable shape: { mods: Set, key }. Order and spelling-insensitive. */
function chord(accelerator) {
    const parts = String(accelerator ?? '').split('+').map((p) => p.trim()).filter(Boolean);
    const key = (parts.pop() ?? '').toUpperCase();
    const norm = (m) => ({ commandorcontrol: 'cmd', cmdorctrl: 'cmd', command: 'cmd', super: 'cmd', meta: 'cmd', control: 'ctrl', option: 'alt' })[m.toLowerCase()] ?? m.toLowerCase();
    return { mods: new Set(parts.map(norm)), key };
}
const isChord = (accelerator, mods, key) => {
    const c = chord(accelerator);
    return c.key === key && c.mods.size === mods.length && mods.every((m) => c.mods.has(m));
};

export default async function ({ page, harness, sandbox, rec, d, sleep }) {
    const menuBefore = await harness.menu();
    const before = d.findMenuItem(menuBefore.items, TOGGLE);
    rec.check('the View menu has a Toggle Sidebar item', before !== null, JSON.stringify(menuBefore.items.map((i) => i.label)));
    if (before === null) return;
    rec.note(`before: ${String(before.accelerator)}`);
    rec.check('its accelerator is the default, Cmd+Shift+S', isChord(before.accelerator, ['cmd', 'shift'], 'S'), before.accelerator);

    // Rebind the way a user would: unbind the default trigger, bind a new one (§1.3: keybind
    // lines accumulate, so without the unbind the default would stay live alongside).
    fs.appendFileSync(sandbox.configPath, `\nkeybind = super+shift+s=unbind\nkeybind = super+alt+s=toggle_sidebar\n`);
    const changed = await d.settle(async () => {
        const item = d.findMenuItem((await harness.menu()).items, TOGGLE);
        return item !== null && isChord(item.accelerator, ['cmd', 'alt'], 'S');
    }, { ceilingMs: 15_000, intervalMs: 250 });
    const after = d.findMenuItem((await harness.menu()).items, TOGGLE);
    rec.note(`after: ${String(after?.accelerator)}`);
    rec.check('the menu accelerator followed the rebind to Cmd+Alt+S within 15 s', changed, String(after?.accelerator));

    // The new chord, landed the way a native accelerator lands (the menu item fires).
    const shownBefore = await sidebarShown(page);
    await harness.press(String(after?.accelerator ?? 'Alt+CommandOrControl+S'));
    rec.check('pressing the new accelerator toggles the sidebar', await d.settle(async () => (await sidebarShown(page)) !== shownBefore, { ceilingMs: 3_000 }));
    await rec.shot(page, 'after-new-chord');
    await harness.press(String(after?.accelerator ?? 'Alt+CommandOrControl+S'));
    rec.check('pressing it again toggles it back', await d.settle(async () => (await sidebarShown(page)) === shownBefore, { ceilingMs: 3_000 }));

    // The old chord is unbound at both layers now: a negative assertion, so it needs a dwell.
    const shownNow = await sidebarShown(page);
    await page.key('KeyS', { modifiers: d.MOD.meta | d.MOD.shift });
    await sleep(700);
    rec.check('the unbound default chord no longer toggles the sidebar', (await sidebarShown(page)) === shownNow);
}
