/**
 * Undo what a scenario changed about the WINDOW: its workbench placements and the phone's place.
 *
 * WHY THIS EXISTS (#205, #201). Both facts are the window's, not the plugin's or the daemon's, and
 * both live in `localStorage`, so `kelpi plugin remove` and `workspace delete` leave them exactly
 * where a scenario put them. In a battery, where every scenario shares one sandbox and one window,
 * that is the next scenario's starting state: `plugin-extensions` found a plugin still drawing the
 * sidebar `plugin-workbench` had selected (#201), and `plugin-document-features` opened the phone on
 * a remote host `plugin-browser-features` had already shut down (#205).
 *
 * ## One window, one store per daemon
 *
 * The workbench key is `kelpi.workbench.v1:<daemonID>` (`client/src/plugins/Workbench.tsx`), so a
 * window that has looked at a remote host holds SEVERAL of them, in the same origin: its own
 * daemon's, and one for every remote daemon whose workspace it selected. Only the first is the
 * window's own. The second is written when a scenario picks a plugin renderer for a REMOTE pane,
 * and it outlives the daemon it names - that sandbox is stopped and deleted on the way out, so
 * nothing can ever read the selection again.
 *
 * That is why the read-back below is SCOPED to one daemon's store. Scanning every key meant a
 * scenario with a remote could never pass its own read-back: three attempts, five seconds of settle
 * each, and a "was not restored" note about a store that was already correct. Other daemons' stores
 * are reported separately, as what they are.
 *
 * ## Two things are done rather than assumed
 *
 * Both were measured failing in a real window:
 *
 *  1. **⌘, is pressed until Settings answers.** The chord needs the window's key dispatcher to be
 *     listening, and a cleanup runs it straight after a `Page.navigate`, where the document is
 *     connected a frame before the dispatcher is. A chord that lands on nothing leaves nothing to
 *     wait for, which is the abort `click: no element matches settings-tab-button-plugins` recorded
 *     in three batteries.
 *  2. **The STORED selection is read back.** Setting a `<select>` and dispatching `change` is a
 *     React state update whose write lands a tick later, and a cleanup that closed Settings and
 *     moved on had no way of knowing whether it did. The check is the store, which is the thing the
 *     next window reads.
 *
 * The route is Settings ▸ Plugins, not the sidebar's or the pane's own picker: those are drawn only
 * while the plugin in question is the one drawing that surface, and by cleanup time it may not be.
 */

import fs from 'node:fs';

const PREFIX = 'kelpi.workbench.v1:';

/**
 * The daemon id this sandbox's window stores its workbench selections under.
 *
 * Read from the daemon's own identity file rather than asked over a wire: the plugin service writes
 * `<db path>.plugins/identity` at boot and reuses it for the process's life
 * (`daemon/src/plugins/service.ts`), and `KELPID_DB_PATH` is in the sandbox's env. Null when it
 * cannot be read, which the callers treat as "check every store", i.e. the old behaviour.
 */
export function daemonIDFromSandbox(sandbox) {
    try {
        const identity = fs.readFileSync(`${String(sandbox?.env?.KELPID_DB_PATH)}.plugins/identity`, 'utf8').trim();
        return /^[a-f0-9-]{36}$/.test(identity) ? identity : null;
    } catch {
        return null;
    }
}

/** Open Settings on its Plugins tab. True when the placements panel is on screen. */
export async function openPlacementSettings(page, d) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await page.eval(`!!document.querySelector('[data-testid="settings-tab-button-plugins"]')`)) break;
        await page.key('Comma', { modifiers: 4, key: ',' });
        if (await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`, { ceilingMs: 6_000 })) break;
    }
    if (!await page.eval(`!!document.querySelector('[data-testid="settings-tab-button-plugins"]')`)) return false;
    await page.click('[data-testid="settings-tab-button-plugins"]');
    return await d.settleDom(page, `document.querySelector('[data-testid="plugin-placements"]')`, { ceilingMs: 8_000 });
}

/** Whether the named slots hold a bundled view (or nothing) in one store, or in every store. */
const storedIsBundled = (slots, daemonID) => `(() => {
    const names = ${JSON.stringify(Object.keys(slots))};
    const only = ${JSON.stringify(daemonID === null || daemonID === undefined ? null : PREFIX + daemonID)};
    const keys = only === null ? Object.keys(localStorage).filter(key => key.startsWith(${JSON.stringify(PREFIX)})) : [only];
    for (const key of keys) {
        let saved;
        try { saved = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch { return false; }
        for (const name of names) {
            const view = saved[name];
            if (typeof view === 'string' && view.length > 0 && !view.startsWith('kelpi.')) return false;
        }
    }
    return true;
})()`;

/** Every store, so a failure — or a leftover in another daemon's — can be read rather than guessed. */
const storedSelections = () => `(() => {
    const all = {};
    for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(${JSON.stringify(PREFIX)})) continue;
        const id = key.slice(${PREFIX.length});
        try { all[id] = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { all[id] = 'unreadable'; }
    }
    return JSON.stringify(all);
})()`;

/**
 * Select `slots` (a `{ 'sidebar.primary': 'kelpi.workspaces', … }` map) in Settings ▸ Plugins and
 * leave the overlay closed.
 *
 * `daemonID` scopes the read-back to one store, and should be the daemon whose workspace the window
 * is looking at: its own (`daemonIDFromSandbox`) normally, a remote's when the window has a remote
 * workspace selected. Returns `{ ok, detail, others }`: `ok` means that store now holds no plugin
 * view in any of those slots, and `others` names any OTHER daemon's store that still does, which is
 * a separate fact and never a failure here. Never throws — a cleanup step that takes a run down
 * with it is worse than the leak it was tidying.
 */
export async function restoreBundledSlots(page, d, slots, { daemonID = null, attempts = 3 } = {}) {
    let detail = 'Settings never opened on its Plugins tab';
    let ok = false;
    for (let attempt = 0; attempt < attempts && !ok; attempt += 1) {
        try {
            if (!await openPlacementSettings(page, d)) continue;
            for (const [slot, view] of Object.entries(slots)) {
                await page.eval(`(() => {
                    const select = document.querySelector(${JSON.stringify(`select[aria-label="${slot}"]`)});
                    if (select === null) return;
                    select.value = ${JSON.stringify(view)};
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                })()`);
            }
            ok = await d.settleDom(page, storedIsBundled(slots, daemonID), { ceilingMs: 5_000 });
            if (await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`)) await page.click('[data-testid="settings-close"]');
            if (!ok) detail = `the placements were selected but the window never stored them: ${String(await page.eval(storedSelections()))}`;
        } catch (error) {
            detail = error instanceof Error ? error.message : String(error);
        }
    }
    // Reported, never failed: a store keyed by a daemon this sandbox has already stopped cannot be
    // read by anything again, and there is no window left that could be asked to change it.
    let others = null;
    if (ok && daemonID !== null) {
        try {
            const all = JSON.parse(String(await page.eval(storedSelections())));
            const stale = Object.entries(all)
                .filter(([id]) => id !== daemonID)
                .flatMap(([id, saved]) => Object.entries(saved ?? {})
                    .filter(([slot, view]) => slot in slots && typeof view === 'string' && view.length > 0 && !view.startsWith('kelpi.'))
                    .map(([slot, view]) => `${slot}=${String(view)} in the store for daemon ${id}`));
            if (stale.length > 0) others = stale.join('; ');
        } catch {
            /* the store is the caller's convenience here, never its verdict */
        }
    }
    return { ok, detail: ok ? null : detail, others };
}

/**
 * Put the phone shell back on its landing page, while it is still mounted.
 *
 * `phone/place.ts` remembers `{host, workspaceID}` in `localStorage` for whatever workspace the
 * phone last had on screen, and a remembered place means the NEXT phone window opens THERE instead
 * of on the host picker every phone scenario starts from — frequently on a remote host the scenario
 * that left it has since shut down. Going back to the landing page is what clears it
 * (`phone/view.ts`), so this is the product's own undo rather than a poke at storage. A no-op on a
 * desktop window and on the landing page, where the button is deliberately not drawn.
 *
 * Call it BEFORE the device metrics are cleared: once the window is wide again the phone shell is
 * unmounted, nothing is listening, and the remembered place stays where it was.
 */
export async function phoneToLanding(page, d) {
    if (!await page.eval(`!!document.querySelector('[data-testid="phone-shell"]')`)) return true;
    if (await page.eval(`!!document.querySelector('[data-testid="phone-landing"]')`)) return true;
    if (!await d.settleDom(page, `document.querySelector('[data-testid="phone-open-landing"]')`, { ceilingMs: 5_000 })) return false;
    await page.click('[data-testid="phone-open-landing"]');
    return await d.settleDom(page, `document.querySelector('[data-testid="phone-landing"]')`, { ceilingMs: 5_000 });
}
