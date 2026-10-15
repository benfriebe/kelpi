import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { decodePluginManifest } from '../../protocol/src/plugins.js';
import { KelpiError, type AgentHookEvent, type BackendAPI, type Context, type Data, type PaneInfo, type UIDialogOptions } from '../index.js';

// #384 as a plugin: Run Suggested Command remembers the last `! cmd` or shell block Claude's Stop
// hook reported per pane, and runs it in the session or in a new split. The example is plain ESM.
const source = fileURLToPath(new URL('../../../examples/plugins/run-suggested/', import.meta.url));
const RULE = '─'.repeat(40);
const READY = ['⏺ Run this to check your login:', '', RULE, '> ', RULE, '  ? for shortcuts'].join('\n');
const BUSY = ['⏺ Running…', '', RULE, '> fix the tests', RULE].join('\n');

function pane(overrides: Partial<PaneInfo> = {}): PaneInfo {
    return {
        id: 'pane-a', type: 'shell', workspaceID: 'ws-1', workspaceName: 'main', workingDirectory: '/work/app',
        status: 'idle', isFocused: true, isActiveWorkspace: true, createdAt: '', lastActivityAt: '',
        agent: 'claude', agentSessionID: 'session-1', label: 'agent', ...overrides,
    };
}

function stop(paneID: string, lastAssistantMessage: string): AgentHookEvent {
    return { type: 'stop', paneID, workspaceID: 'ws-1', agent: 'claude', sessionID: 'session-1', status: 'idle', lastAssistantMessage };
}

async function setup(options: { panes?: PaneInfo[]; screen?: string; answer?: string | null; sendError?: unknown; keyError?: unknown } = {}) {
    const { activate } = await import(path.join(source, 'backend.mjs')) as { activate(api: BackendAPI): () => void };
    const handlers = new Map<string, (args: Data, context: Context) => Promise<unknown>>();
    let listener: ((event: AgentHookEvent) => void) | undefined;
    let revision = 10;
    const calls: string[] = [];
    const read = vi.fn(async (paneID: string) => { calls.push(`read ${paneID}`); return { text: options.screen ?? READY, revision: ++revision, cursor: { row: 0, col: 0 }, altScreen: true }; });
    const send = vi.fn(async (paneID: string) => { calls.push(`send ${paneID}`); if (options.sendError) throw options.sendError; return {}; });
    const sendKey = vi.fn(async (paneID: string) => { calls.push(`key ${paneID}`); if (options.keyError) throw options.keyError; return {}; });
    const split = vi.fn(async () => ({ paneID: 'pane-new', workspaceID: 'ws-1', workspaceName: 'main' }));
    const list = vi.fn(async () => options.panes ?? [pane()]);
    const showDialog = vi.fn(async (_options: UIDialogOptions) => options.answer === undefined ? 'session' : options.answer);
    const showNotification = vi.fn(async () => null);
    const update = vi.fn(async () => ({ context: {}, items: {} }));
    const unsubscribe = vi.fn();
    const dispose = activate({
        commands: { register: (id: string, handler: (args: Data, context: Context) => Promise<unknown>) => { handlers.set(id, handler); return () => handlers.delete(id); } },
        agents: { onEvent: (next: (event: AgentHookEvent) => void) => { listener = next; return unsubscribe; } },
        panes: { list, split },
        terminal: { read, send, sendKey },
        ui: { showDialog, showNotification },
        contributions: { update },
    } as unknown as BackendAPI);
    const context = { daemonID: 'd', windowID: 'w', workspaceID: 'ws-1', paneID: 'pane-a' };
    return {
        emit: (event: AgentHookEvent) => listener?.(event),
        window: (ctx: Partial<Context> = context) => handlers.get('example.run-suggested.run')!({}, { daemonID: 'd', ...ctx }),
        cli: (argv: string[], ctx: Partial<Context> = context, json = false) => handlers.get('example.run-suggested.cli')!({ argv, cwd: '/work', isTTY: true, json }, { daemonID: 'd', ...ctx }) as Promise<Data>,
        dispose, handlers, unsubscribe, calls, read, send, sendKey, split, list, showDialog, showNotification, update,
    };
}

const screenChanged = () => new KelpiError('the screen changed', { code: 'SCREEN_CHANGED', details: { revision: 99 } });

describe('Run Suggested Command example', () => {
    it('declares the command, its shortcut, the header item and the CLI verb in a valid manifest', () => {
        const manifest = decodePluginManifest(JSON.parse(fs.readFileSync(path.join(source, 'kelpi.plugin.json'), 'utf8')));
        expect(manifest).toMatchObject({ backend: 'backend.mjs', activation: 'startup' });
        expect(manifest.contributes.commands).toContainEqual({ id: 'example.run-suggested.run', title: "Run Claude's suggested command", shortcut: 'ctrl+alt+r' });
        expect(manifest.contributes.items).toEqual([expect.objectContaining({
            id: 'example.run-suggested.header', placement: 'pane.header', command: 'example.run-suggested.run',
            when: { 'pane.hasAgent': true, 'context.hasSuggestion': true },
        })]);
        expect(manifest.contributes.cli).toEqual([{ name: 'run-suggested', command: 'example.run-suggested.cli', summary: expect.any(String) }]);
        // The CLI's command stays out of the palette: its rule waits on a key the plugin never publishes.
        expect(manifest.contributes.menus).toEqual([expect.objectContaining({ command: 'example.run-suggested.cli', placement: 'palette', when: { 'context.showCliInPalette': true } })]);
    });

    it('remembers a Stop reply\'s suggestion per pane until a reply without one, and publishes hasSuggestion', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', 'Your token expired. Run:\n\n! gh auth status\n'));
        expect(await plugin.cli(['--print'])).toEqual({ text: 'gh auth status', json: { command: 'gh auth status', kind: 'bang' } });
        expect(await plugin.cli(['--print'], { paneID: 'pane-b', workspaceID: 'ws-1' })).toMatchObject({ exitCode: 1 });
        plugin.emit(stop('pane-a', 'All done, nothing to run.'));
        expect(await plugin.cli(['--print'])).toMatchObject({ stderr: 'kelpi run-suggested: Claude has not suggested a command in this pane', exitCode: 1 });
        expect(plugin.update.mock.calls.map(([patch]) => patch)).toEqual([{ context: { hasSuggestion: true } }, { context: { hasSuggestion: false } }]);
    });

    it('forgets a pane on session end, and disposes everything it registered', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', '! make test'));
        plugin.emit({ type: 'session-end', paneID: 'pane-a', workspaceID: 'ws-1', agent: 'claude', status: 'idle' });
        expect(await plugin.cli(['--print'])).toMatchObject({ exitCode: 1 });
        plugin.dispose();
        expect(plugin.unsubscribe).toHaveBeenCalled();
        expect(plugin.handlers.size).toBe(0);
    });

    it('types into an idle session guarded by the screen revision, then presses Enter guarded by the next', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', '! gh auth status'));
        expect(await plugin.window()).toBe('session');
        const dialog = plugin.showDialog.mock.calls[0]![0];
        expect(dialog).toMatchObject({ title: "Run Claude's suggested command?", message: 'gh auth status', detail: 'Runs in this Claude session, so Claude sees the output.', cancelID: 'cancel' });
        expect(dialog.actions.map(action => action.id)).toEqual(['cancel', 'split', 'session']);
        expect(dialog.actions[2]).toMatchObject({ kind: 'primary' });
        // Read before the dialog, read again after it, type, read what was typed, Enter.
        expect(plugin.calls).toEqual(['read pane-a', 'read pane-a', 'send pane-a', 'read pane-a', 'key pane-a']);
        const reads = await Promise.all(plugin.read.mock.results.map(result => result.value as Promise<{ revision: number }>));
        expect(plugin.send).toHaveBeenCalledWith('pane-a', '! gh auth status', { bare: true, ifRevision: reads[1]!.revision });
        expect(plugin.sendKey).toHaveBeenCalledWith('pane-a', 'enter', { ifRevision: reads[2]!.revision });
        expect(plugin.split).not.toHaveBeenCalled();
        expect(plugin.showNotification).not.toHaveBeenCalled();
    });

    it('offers only a new split for a code block or a busy pane, and runs it in the pane\'s directory', async () => {
        const fenced = await setup({ answer: 'split' });
        fenced.emit(stop('pane-a', 'Try:\n\n```bash\nnpm ci\nnpm test\n```\n'));
        expect(await fenced.window()).toBe('split');
        const dialog = fenced.showDialog.mock.calls[0]![0];
        expect(dialog.detail).toBe('Runs in a new shell split: a code block runs in a new split.');
        expect(dialog.actions).toEqual([{ id: 'cancel', label: 'Cancel' }, { id: 'split', label: 'Run in new split', kind: 'primary' }]);
        expect(fenced.split).toHaveBeenCalledWith('pane-a', { direction: 'horizontal', path: '/work/app', focus: true });
        expect(fenced.send).toHaveBeenCalledWith('pane-new', 'npm ci\nnpm test');
        expect(fenced.sendKey).not.toHaveBeenCalled();

        const busy = await setup({ panes: [pane({ status: 'running' })], answer: 'cancel' });
        busy.emit(stop('pane-a', '! gh auth status'));
        expect(await busy.window()).toBe('cancel');
        expect(busy.showDialog.mock.calls[0]![0].actions.map(action => action.id)).toEqual(['cancel', 'split']);
        expect(busy.split).not.toHaveBeenCalled();
        expect(busy.send).not.toHaveBeenCalled();
    });

    it('sends nothing when the screen changed before typing, and says the command is typed when it changed before Enter', async () => {
        const before = await setup({ sendError: screenChanged() });
        before.emit(stop('pane-a', '! gh auth status'));
        await before.window();
        expect(before.sendKey).not.toHaveBeenCalled();
        expect(before.showNotification).toHaveBeenCalledWith({ message: 'Run suggested: the screen changed, nothing was sent', detail: 'It changed before the command was typed.', tone: 'warning' });

        const after = await setup({ keyError: screenChanged() });
        after.emit(stop('pane-a', '! gh auth status'));
        await after.window();
        expect(after.showNotification).toHaveBeenCalledWith(expect.objectContaining({ message: 'Run suggested: the screen changed, nothing was sent', detail: expect.stringContaining('after the command was typed'), tone: 'warning' }));
    });

    it('tells the user when the pane has no suggestion or none is focused, without asking', async () => {
        const plugin = await setup();
        expect(await plugin.window()).toBeNull();
        expect(plugin.showNotification).toHaveBeenCalledWith({ message: 'Run suggested: Claude has not suggested a command in this pane', tone: 'info' });
        expect(await plugin.window({ windowID: 'w' })).toBeNull();
        expect(plugin.showNotification).toHaveBeenLastCalledWith({ message: 'Run suggested: no pane is focused', tone: 'warning' });
        expect(plugin.showDialog).not.toHaveBeenCalled();
    });

    it('prints from the CLI, hints without a flag, and runs with --yes', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', '! gh auth status'));
        expect(await plugin.cli([])).toEqual({ text: 'gh auth status', json: { command: 'gh auth status', kind: 'bang' }, stderr: 'Pass --yes to run it, or press Ctrl+Alt+R in the pane to choose where it runs.' });
        expect(plugin.send).not.toHaveBeenCalled();
        expect(await plugin.cli(['--yes'])).toEqual({ text: 'ran in the Claude session', json: { command: 'gh auth status', kind: 'bang', ran: 'session', paneID: 'pane-a' } });
        expect(plugin.send).toHaveBeenCalledWith('pane-a', '! gh auth status', expect.objectContaining({ bare: true }));
        expect(plugin.sendKey).toHaveBeenCalledWith('pane-a', 'enter', expect.any(Object));
        expect(plugin.showDialog).not.toHaveBeenCalled();
        expect(plugin.showNotification).not.toHaveBeenCalled();
    });

    it('runs --yes in a new split when the pane is busy, and reports a changed screen', async () => {
        const busy = await setup({ screen: BUSY });
        busy.emit(stop('pane-a', '! gh auth status'));
        expect(await busy.cli(['--yes'])).toMatchObject({ text: "ran in a new split: Claude's input box is not empty" });
        expect(busy.split).toHaveBeenCalledWith('pane-a', expect.objectContaining({ path: '/work/app' }));
        expect(busy.send).toHaveBeenCalledWith('pane-new', 'gh auth status');

        const changed = await setup({ sendError: screenChanged() });
        changed.emit(stop('pane-a', '! gh auth status'));
        expect(await changed.cli(['--yes'])).toEqual({ stderr: 'kelpi run-suggested: the screen changed, nothing was sent', exitCode: 1 });
    });

    it('targets a pane by id or by its label in the caller\'s workspace', async () => {
        const panes = [pane({ id: 'pane-a', label: 'agent' }), pane({ id: 'pane-b', label: 'shell', agent: undefined }), pane({ id: 'pane-c', label: 'agent', workspaceID: 'ws-2' })];
        const plugin = await setup({ panes });
        plugin.emit(stop('pane-a', '! gh auth status'));
        plugin.emit(stop('pane-c', '! make lint'));
        expect(await plugin.cli(['--target', 'agent', '--print'], { paneID: 'pane-b', workspaceID: 'ws-1' })).toMatchObject({ text: 'gh auth status' });
        expect(await plugin.cli(['--target', 'pane-c', '--print'], { paneID: 'pane-b', workspaceID: 'ws-1' })).toMatchObject({ text: 'make lint' });
        // Outside a pane a label must be unique across every workspace.
        expect(await plugin.cli(['--target', 'agent', '--print'], {})).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('more than one pane') });
        expect(await plugin.cli(['--print'], {})).toEqual({ stderr: 'kelpi run-suggested: no target pane (run it inside a Kelpi pane or pass --target)', exitCode: 1 });
        expect(await plugin.cli(['--print'], { paneID: 'pane-b', workspaceID: 'ws-1' }, true)).toEqual({ stderr: 'kelpi run-suggested: Claude has not suggested a command in this pane', exitCode: 1, json: { found: false } });
    });

    it('refuses bad usage with exit 2', async () => {
        const plugin = await setup();
        expect(await plugin.cli(['--print', '--yes'])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining('--print and --yes cannot be combined') });
        expect(await plugin.cli(['--frobnicate'])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining('Usage: kelpi run-suggested') });
        expect(await plugin.cli(['--target'])).toMatchObject({ exitCode: 2 });
        expect(await plugin.cli(['--help'])).toEqual({ text: expect.stringContaining('Usage: kelpi run-suggested') });
    });
});
