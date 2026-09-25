/**
 * Layout Lab's shipped script, evaluated unchanged against a scripted chrome feed, as
 * `chrome-lab.test.ts` does for Chrome Lab. The live half (heights honoured, bands hidden, the
 * view kept mounted) is `scripts/scenarios/plugin-root-layout.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest } from '@kelpi/protocol';
import type { ChromeCommand, ChromeSnapshot } from '../../../plugin-sdk/chrome';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples/plugins/layout-lab');
const app = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
const cleanups: Array<() => void> = [];
async function settle(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }

const command = (id: string, title: string, extra: Partial<ChromeCommand> = {}): ChromeCommand => ({ id, title, enabled: true, group: 'window', ...extra });
function chrome(zen: boolean, bottomPanel = true): ChromeSnapshot {
    return {
        connection: 'connected', ready: true, remoteWorkspaceSelected: false, workspace: null, focusedPane: null,
        sidebars: { left: { viewID: 'kelpi.workspaces', title: 'Workspaces', visible: !zen }, right: { viewID: 'kelpi.inspector', title: 'Inspector', visible: false } },
        sizeControl: 'this-window', layouts: [], agents: { running: 0, waiting: 0, muted: 0, inactive: 0 }, agentPanes: [], git: null, systemStats: null, items: [],
        keymap: { sections: [], plugins: [], withheld: 0 },
        commands: [
            command('kelpi.sidebar.left', 'Hide Workspaces'),
            command('kelpi.zenMode.toggle', zen ? 'Exit Zen Mode' : 'Enter Zen Mode', { checked: zen }),
            command('kelpi.toolbar.toggle', zen ? 'Show Toolbar' : 'Hide Toolbar', { checked: !zen }),
            command('kelpi.statusbar.toggle', zen ? 'Show Status Bar' : 'Hide Status Bar', { checked: !zen }),
            command('kelpi.panel.bottom.toggle', 'Hide Bottom Panel', { checked: !zen, enabled: bottomPanel }),
            command('kelpi.window.resetArrangement', 'Reset Window Arrangement')
        ]
    };
}

async function mount(view: 'toolbar' | 'status' | 'panel', initial: ChromeSnapshot) {
    const html = fs.readFileSync(path.join(root, `ui/${view}.html`), 'utf8');
    document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
    document.body.dataset.view = view;
    let publish!: (value: ChromeSnapshot) => void;
    let context!: (value: { visible: boolean }) => void;
    const execute = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('kelpi', {
        ready: Promise.resolve(), visible: true,
        onContext(listener: (value: { visible: boolean }) => void) { context = listener; return () => {}; },
        ui: { onChrome(listener: (value: ChromeSnapshot) => void) { publish = listener; listener(initial); return () => {}; }, executeChromeCommand: execute }
    });
    const events = vi.spyOn(globalThis, 'addEventListener'), registered: typeof events.mock.calls = [];
    try { await new Function(`return (async () => { ${app}\n})();`)(); }
    finally { registered.push(...events.mock.calls); events.mockRestore(); }
    cleanups.push(() => {
        window.dispatchEvent(new Event('pagehide'));
        for (const [name, listener, options] of registered) globalThis.removeEventListener(name, listener, options);
    });
    const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('#commands button')];
    return { execute, buttons, publish: (value: ChromeSnapshot) => publish(value), context: (visible: boolean) => context({ visible }) };
}

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Layout Lab', () => {
    it('declares a height for each band inside the host’s ranges', () => {
        const manifest = decodePluginManifest(JSON.parse(fs.readFileSync(path.join(root, 'kelpi.plugin.json'), 'utf8')));
        expect(manifest.contributes.views.map(view => [view.placements, view.bandHeights])).toEqual([
            [['topbar'], { topbar: 36 }],
            [['statusbar'], { statusbar: 22 }],
            [['panel.bottom'], { 'panel.bottom': 180 }]
        ]);
    });

    it('renders the arrangement commands from the snapshot, titles and pressed state included, and runs them', async () => {
        const h = await mount('toolbar', chrome(false));
        expect(h.buttons().map(button => button.textContent)).toEqual(['Enter Zen Mode', 'Hide Toolbar', 'Hide Status Bar', 'Hide Bottom Panel', 'Reset Window Arrangement']);
        expect(h.buttons()[0]!.getAttribute('aria-pressed')).toBe('false');
        h.buttons()[0]!.click(); await settle();
        expect(h.execute).toHaveBeenCalledWith('kelpi.zenMode.toggle', {});
        h.publish(chrome(true, false));
        expect(h.buttons().map(button => button.textContent)).toEqual(['Exit Zen Mode', 'Show Toolbar', 'Show Status Bar', 'Hide Bottom Panel', 'Reset Window Arrangement']);
        expect(h.buttons()[0]!.getAttribute('aria-pressed')).toBe('true');
        expect(h.buttons()[3]!.disabled).toBe(true);
        expect(document.body.dataset.ready).toBe('true');
    });

    it('keeps the thin status bar to the three commands that matter when bands are missing', async () => {
        const h = await mount('status', chrome(false));
        expect(h.buttons().map(button => button.dataset.command)).toEqual(['kelpi.zenMode.toggle', 'kelpi.toolbar.toggle', 'kelpi.window.resetArrangement']);
    });

    it('reports the host’s visibility and counts the hides it survived without a reload', async () => {
        const h = await mount('panel', chrome(false));
        expect(document.body.dataset.visible).toBe('true');
        h.context(false);
        expect(document.body.dataset.visible).toBe('false');
        h.context(true);
        h.context(false);
        expect(document.body.dataset.hiddenCount).toBe('2');
        expect(document.getElementById('visibility')!.textContent).toContain('hidden 2 times without reloading');
    });

    it('shows a refused command in its own error line', async () => {
        const h = await mount('toolbar', chrome(false));
        h.execute.mockRejectedValueOnce(new Error('Chrome command is unavailable or disabled.'));
        h.buttons()[1]!.click(); await settle();
        expect(document.getElementById('error')!.hidden).toBe(false);
        expect(document.getElementById('error')!.textContent).toBe('Chrome command is unavailable or disabled.');
    });
});
