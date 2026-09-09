import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChromeCommand, ChromeSnapshot } from '../../../plugin-sdk/chrome';
import { createUIServices, type UIServiceModal } from './ui-services';

type AgentPane = ChromeSnapshot['agentPanes'][number];
type QuickPick = Extract<UIServiceModal, { kind: 'quickPick' }>;
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples/plugins/chrome-lab/ui');
const app = fs.readFileSync(path.join(assets, 'app.js'), 'utf8');
const cleanups: Array<() => void> = [];
async function settle(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function chrome(overrides: Partial<ChromeSnapshot> = {}): ChromeSnapshot {
    return {
        connection: 'connected', ready: true, remoteWorkspaceSelected: false,
        workspace: { id: 'original-workspace', name: 'Workspace', color: 'blue', paneCount: 1, layout: 'tiled', syncInputActive: false, syncedPaneCount: 1 },
        focusedPane: null, sidebars: { left: { viewID: 'kelpi.workspaces', title: 'Workspaces', visible: true }, right: { viewID: 'kelpi.inspector', title: 'Inspector', visible: false } },
        sizeControl: 'this-window', layouts: [], commands: [], agents: { running: 0, waiting: 0, inactive: 0 }, agentPanes: [], git: null, systemStats: null, items: [], ...overrides
    };
}
const focus: ChromeCommand = { id: 'kelpi.pane.focus', title: 'Focus Pane', enabled: true, group: 'window' };
const menu = (id: string, title = 'Plugin command', enabled = true): ChromeCommand => ({ id, title, enabled, group: 'menu' });
function pane(index = 0, bucket: AgentPane['bucket'] = 'running'): AgentPane {
    return { workspaceID: `workspace-${index}`, workspaceName: `Workspace ${index}`, paneID: `pane-${index}`, title: `Agent ${index}`, bucket, agentStartedAt: null };
}
function withPanes(panes: AgentPane[]): ChromeSnapshot {
    return chrome({ commands: [focus], agentPanes: panes, agents: {
        running: panes.filter(item => item.bucket === 'running').length,
        waiting: panes.filter(item => item.bucket === 'waiting').length,
        inactive: panes.filter(item => item.bucket === 'inactive').length
    } });
}
async function mount(view: 'toolbar' | 'status', initial: ChromeSnapshot) {
    const html = fs.readFileSync(path.join(assets, `${view}.html`), 'utf8');
    document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
    const service = createUIServices();
    const scope = service.createScope({ id: 'chrome-lab', pluginID: 'example.chrome-lab', pluginName: 'Chrome Lab' });
    let publish!: (value: ChromeSnapshot) => void;
    const stop = vi.fn(), execute = vi.fn().mockResolvedValue(undefined);
    const showQuickPick = vi.fn((options: unknown) => scope.request('ui.showQuickPick', JSON.parse(JSON.stringify(options))));
    vi.stubGlobal('kelpi', { ready: Promise.resolve(), ui: {
        onChrome(listener: (value: ChromeSnapshot) => void) { publish = listener; listener(initial); return stop; },
        executeChromeCommand: execute, showQuickPick
    } });
    // Evaluate the shipped module unchanged; the real UI service validates the same
    // JSON options a view sends across its message port.
    const events = vi.spyOn(globalThis, 'addEventListener'), registered: typeof events.mock.calls = [];
    try { await new Function(`return (async () => { ${app}\n})();`)(); }
    finally { registered.push(...events.mock.calls); events.mockRestore(); }
    let hidden = false;
    const hide = (): void => { if (!hidden) { hidden = true; window.dispatchEvent(new Event('pagehide')); scope.dispose(); } };
    cleanups.push(() => {
        hide(); service.dispose();
        for (const [name, listener, options] of registered) globalThis.removeEventListener(name, listener, options);
    });
    const error = (): HTMLElement => document.getElementById('error')!;
    const active = (): QuickPick => {
        expect(error().hidden, error().textContent ?? '').toBe(true);
        const request = service.getSnapshot().active;
        expect(request?.kind).toBe('quickPick');
        if (request?.kind !== 'quickPick') throw new Error('Expected an active picker.');
        return request;
    };
    const answer = async (label: string | null): Promise<void> => {
        const request = active();
        const row = label === null ? null : request.options.items.find(item => item.label === label);
        if (label !== null) expect(row, `Missing picker row: ${label}`).toBeDefined();
        service.answer(request.id, row?.id ?? null); await settle();
    };
    const click = async (id: string): Promise<void> => {
        const button = document.getElementById(id) as HTMLButtonElement;
        expect(button.disabled).toBe(false); button.click(); await settle();
    };
    return { active, answer, click, execute, hide, publish: (value: ChromeSnapshot) => publish(value), service, showQuickPick, stop };
}
type Harness = Awaited<ReturnType<typeof mount>>;
const controls = new Set(['Previous page', 'Next page']);
async function pages(h: Harness, direction: 'Next page' | 'Previous page') {
    const seen = new Map<string, boolean>();
    for (let count = 0; ; count++) {
        expect(count, 'Pagination must reach an end').toBeLessThan(10);
        const rows = h.active().options.items;
        for (const row of rows) if (!controls.has(row.label)) seen.set(row.label, row.disabled ?? false);
        if (!rows.some(row => row.label === direction)) return seen;
        await h.answer(direction);
    }
}
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await settle(); vi.unstubAllGlobals(); document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('Chrome Lab picks through the window UI contract', () => {
    it('preserves a valid long contribution ID and the workspace selected when the menu opened', async () => {
        const originalID = `menu:example.plugin.${'x'.repeat(145)}`;
        expect(originalID.length - 'menu:'.length).toBe(160);
        const h = await mount('toolbar', chrome({ commands: [menu(originalID)] }));
        await h.click('more');
        expect(h.active().options.items[0]?.id.length).toBeLessThanOrEqual(128);
        h.publish(chrome({ workspace: { ...chrome().workspace!, id: 'replacement-workspace' }, commands: [menu('menu:replacement.command')] }));
        await h.answer('Plugin command');
        expect(h.execute).toHaveBeenCalledExactlyOnceWith(originalID, { workspaceID: 'original-workspace' });
    });

    it.each([['long', 'Agent '.repeat(50)], ['blank', '   ']])('keeps a pane with a %s title selectable', async (_case, title) => {
        const original = { ...pane(), title, workspaceName: 'Workspace '.repeat(150) };
        const h = await mount('status', withPanes([original]));
        await h.click('running');
        const row = h.active().options.items[0]!;
        expect(row.label.trim().length).toBeGreaterThan(0);
        expect(row.label.length).toBeLessThanOrEqual(200);
        expect(row.description?.length).toBeLessThanOrEqual(1024);
        await h.answer(row.label);
        expect(h.execute).toHaveBeenCalledExactlyOnceWith('kelpi.pane.focus', { workspaceID: original.workspaceID, paneID: original.paneID });
    });

    it('keeps a menu command with a long title selectable', async () => {
        const original = menu('menu:example.long-title', 'Long command title '.repeat(20));
        const h = await mount('toolbar', chrome({ commands: [original] }));
        await h.click('more');
        const row = h.active().options.items[0]!;
        expect(row.label.length).toBeLessThanOrEqual(200);
        await h.answer(row.label);
        expect(h.execute).toHaveBeenCalledExactlyOnceWith(original.id, { workspaceID: 'original-workspace' });
    });

    it('makes every large menu entry reachable in both directions and preserves disabled choices', async () => {
        const commands = Array.from({ length: 405 }, (_, index) => menu(`menu:example.command-${index}`, `Command ${index}`, index % 57 !== 0));
        const h = await mount('toolbar', chrome({ commands }));
        await h.click('more');
        const disabled = h.active().options.items.find(row => row.label === 'Command 0')!;
        expect(disabled.disabled).toBe(true);
        expect(() => h.service.answer(h.active().id, disabled.id)).toThrow('enabled item');
        const expected = new Map(commands.map(command => [command.title, !command.enabled]));
        expect(await pages(h, 'Next page')).toEqual(expected);
        expect(await pages(h, 'Previous page')).toEqual(expected);
        expect(h.execute).not.toHaveBeenCalled();
        await pages(h, 'Next page');
        await h.answer('Command 404');
        expect(h.execute).toHaveBeenCalledExactlyOnceWith(commands[404]!.id, { workspaceID: 'original-workspace' });
    });

    it.each(['running', 'waiting', 'inactive'] as const)('makes every pane in a large %s bucket reachable without retargeting an open picker', async bucket => {
        const panes = Array.from({ length: 405 }, (_, index) => pane(index, bucket));
        const h = await mount('status', withPanes(panes));
        await h.click(bucket);
        const expected = new Map(panes.map(item => [item.title, false]));
        expect(await pages(h, 'Next page')).toEqual(expected);
        expect(await pages(h, 'Previous page')).toEqual(expected);
        h.publish(withPanes([pane(999, bucket)]));
        await pages(h, 'Next page');
        await h.answer('Agent 404');
        expect(h.execute).toHaveBeenCalledExactlyOnceWith('kelpi.pane.focus', { workspaceID: panes[404]!.workspaceID, paneID: panes[404]!.paneID });
    });

    it('allows cancellation on later pages, prevents duplicate pickers, and can reopen', async () => {
        const h = await mount('toolbar', chrome({ commands: Array.from({ length: 205 }, (_, index) => menu(`menu:example.command-${index}`, `Command ${index}`)) }));
        await h.click('more'); await h.click('more');
        expect(h.showQuickPick).toHaveBeenCalledOnce();
        await h.answer('Next page'); await h.answer(null);
        expect(h.execute).not.toHaveBeenCalled();
        expect(h.service.getSnapshot().active).toBeNull();
        await h.click('more');
        await h.answer('Command 0');
        expect(h.execute).toHaveBeenCalledExactlyOnceWith('menu:example.command-0', { workspaceID: 'original-workspace' });
    });

    it('discards a queued choice when the view is disposed', async () => {
        const h = await mount('status', withPanes([pane()]));
        await h.click('running');
        const request = h.active();
        h.service.answer(request.id, request.options.items[0]!.id);
        h.hide(); await settle();
        expect(h.execute).not.toHaveBeenCalled();
        expect(h.stop).toHaveBeenCalledOnce();
        expect(h.service.getSnapshot().active).toBeNull();
        await h.click('running');
        expect(h.showQuickPick).toHaveBeenCalledOnce();
    });
});
