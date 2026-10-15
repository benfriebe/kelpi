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
const box = (typed: string) => ['⏺ Run this to check your login:', '', RULE, `❯\u00a0${typed}`, RULE, '  ? for shortcuts'].join('\n');
// What Claude Code 2.1.300 shows after a bare send of `! cmd` into its empty box: bash mode's glyph `!`
// for `❯`, U+00A0, the rest as typed with its leading space, and one footer row.
const typedBox = (typed: string) => ['⏺ Run this to check your login:', '', RULE, typed.replace(/^!/, '!\u00a0'), RULE, '  ! for shell mode'].join('\n');
const READY = box('');
const BUSY = ['⏺ Running…', '', RULE, '> fix the tests', RULE].join('\n');
const PERMISSION = ['⏺ Bash(rm -rf build)', '', RULE, ' Bash command', '', '   rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ''].join('\n');

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

// Claude keeps the cursor at the end of what its box holds, after the glyph and its space when empty.
function cursorOf(text: string) {
    const rows = text.split('\n');
    const row = rows.findLastIndex(line => /^[❯>!]/.test(line));
    return row < 0 ? { row: 0, col: 0 } : { row, col: rows[row]!.length };
}

// `screens` are the reads' texts in turn; past them a read shows `screen`, or the box holding what a bare
// send typed. `cursor`, when given, is the cursor of every read before that send, and `typedCursor` of every
// read after it; by default a read's cursor is at the end of the box. `splitSendError` and `splitReadError`
// fail only a send to, or a read of, the new split.
async function setup(options: { panes?: PaneInfo[]; screen?: string; screens?: string[]; cursor?: { row: number; col: number }; typedCursor?: { row: number; col: number }; answer?: string | null; sendError?: unknown; keyError?: unknown; splitSendError?: unknown; splitReadError?: unknown } = {}) {
    const { activate } = await import(path.join(source, 'backend.mjs')) as { activate(api: BackendAPI): () => void };
    const handlers = new Map<string, (args: Data, context: Context) => Promise<unknown>>();
    let listener: ((event: AgentHookEvent) => void) | undefined;
    let revision = 10;
    let reads = 0;
    let typed: string | undefined;
    const calls: string[] = [];
    const read = vi.fn(async (paneID: string) => {
        calls.push(`read ${paneID}`);
        if (paneID === 'pane-new' && options.splitReadError) throw options.splitReadError;
        const text = options.screens?.[reads++] ?? (typed === undefined ? options.screen ?? READY : typedBox(typed));
        return { text, revision: ++revision, cursor: (typed === undefined ? options.cursor : options.typedCursor) ?? cursorOf(text), altScreen: true };
    });
    const send = vi.fn(async (paneID: string, text: string, sendOptions?: { bare?: boolean; ifRevision?: number }) => {
        calls.push(`send ${paneID}`);
        if (options.sendError) throw options.sendError;
        if (paneID === 'pane-new' && options.splitSendError) throw options.splitSendError;
        if (sendOptions?.bare) typed = text;
        return {};
    });
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
const TYPED_NOT_RUN = "the screen changed before Enter; the command is typed in Claude's box, not run";
const MISMATCH = "Enter was not pressed, Claude's box did not show the command as typed; it sits typed, not run";
const NO_LONGER = 'Run suggested: Claude is no longer waiting at its prompt, nothing was sent';
const SPLIT_CHANGED = 'the new split changed before the command was sent, nothing was sent';
const event = (type: AgentHookEvent['type'], extra: Partial<AgentHookEvent> = {}): AgentHookEvent =>
    ({ type, paneID: 'pane-a', workspaceID: 'ws-1', agent: 'claude', sessionID: 'session-1', status: 'waitingForInput', ...extra });
const readResults = async (read: { mock: { results: { value: unknown }[] } }) =>
    Promise.all(read.mock.results.map(result => result.value as Promise<{ revision: number }>));

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

    it('forgets a pane when a new Claude session starts in it', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', '! make test'));
        expect(await plugin.cli(['--print'])).toMatchObject({ text: 'make test' });
        plugin.emit(event('session-start', { sessionID: 'session-2', status: 'idle' }));
        expect(await plugin.cli(['--print'])).toMatchObject({ stderr: 'kelpi run-suggested: Claude has not suggested a command in this pane', exitCode: 1 });
    });

    it('keeps the suggestion through a Stop that carries no reply text', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', '! gh auth status'));
        // An older CLI's hook, a manual `kelpi event stop`, or the second of two hook sets on the pane.
        plugin.emit(event('stop', { status: 'idle' }));
        expect(await plugin.cli(['--print'])).toEqual({ text: 'gh auth status', json: { command: 'gh auth status', kind: 'bang' } });
        expect(plugin.update.mock.calls.map(([patch]) => patch)).toEqual([{ context: { hasSuggestion: true } }]);
    });

    it('offers nothing from a reply cut at the hook\'s cap, and forgets the one before it', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', '! echo old'));
        plugin.emit({ ...stop('pane-a', '! echo stale-first\n\nlots of text'), lastAssistantMessageTruncated: true });
        expect(await plugin.cli(['--print'])).toMatchObject({ stderr: 'kelpi run-suggested: Claude has not suggested a command in this pane', exitCode: 1 });
    });

    it('marks hasSuggestion published only once an update lands, and retries a failed one', async () => {
        const plugin = await setup();
        plugin.update.mockRejectedValueOnce(new Error('daemon busy'));
        plugin.emit(stop('pane-a', '! make test'));
        await plugin.cli(['--print']);
        expect(plugin.update.mock.calls.map(([patch]) => patch)).toEqual([{ context: { hasSuggestion: true } }, { context: { hasSuggestion: true } }]);
        await plugin.cli(['--print']);
        expect(plugin.update).toHaveBeenCalledTimes(2);
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
        const reads = await readResults(plugin.read);
        expect(plugin.send).toHaveBeenCalledWith('pane-a', '! gh auth status', { bare: true, ifRevision: reads[1]!.revision });
        expect(plugin.sendKey).toHaveBeenCalledWith('pane-a', 'enter', { ifRevision: reads[2]!.revision });
        expect(plugin.split).not.toHaveBeenCalled();
        expect(plugin.showNotification).not.toHaveBeenCalled();
    });

    it('types into the session when Claude\'s ghost text in the empty box is the suggestion, the cursor before it', async () => {
        // Claude Code 2.1.300 draws its prompt suggestion, here the reply's own line, as dim text the read cannot tell from typed.
        const plugin = await setup({ screen: box('! gh auth status'), cursor: { row: 3, col: 2 } });
        plugin.emit(stop('pane-a', '! gh auth status'));
        expect(await plugin.window()).toBe('session');
        expect(plugin.showDialog.mock.calls[0]![0].actions.map(action => action.id)).toEqual(['cancel', 'split', 'session']);
        expect(plugin.calls).toEqual(['read pane-a', 'read pane-a', 'send pane-a', 'read pane-a', 'key pane-a']);
        expect(plugin.send).toHaveBeenCalledWith('pane-a', '! gh auth status', expect.objectContaining({ bare: true }));
        expect(plugin.read).toHaveBeenCalledWith('pane-a', { scrollback: false });
        expect(plugin.showNotification).not.toHaveBeenCalled();

        // The same text with the cursor at its end is a draft.
        const draft = await setup({ screen: box('! gh auth status'), cursor: { row: 3, col: 18 }, answer: 'cancel' });
        draft.emit(stop('pane-a', '! gh auth status'));
        await draft.window();
        expect(draft.showDialog.mock.calls[0]![0].actions.map(action => action.id)).toEqual(['cancel', 'split']);
    });

    it('offers only a new split for a code block or a busy pane, and runs it in the pane\'s directory', async () => {
        const fenced = await setup({ answer: 'split' });
        fenced.emit(stop('pane-a', 'Try:\n\n```bash\nnpm ci\nnpm test\n```\n'));
        expect(await fenced.window()).toBe('split');
        const dialog = fenced.showDialog.mock.calls[0]![0];
        expect(dialog.detail).toBe('Runs in a new shell split: a code block runs in a new split.');
        expect(dialog.actions).toEqual([{ id: 'cancel', label: 'Cancel' }, { id: 'split', label: 'Run in new split', kind: 'primary' }]);
        expect(fenced.split).toHaveBeenCalledWith('pane-a', { direction: 'horizontal', path: '/work/app', focus: true });
        expect(fenced.send).toHaveBeenCalledWith('pane-new', 'npm ci\nnpm test', { ifRevision: expect.any(Number) });
        expect(fenced.sendKey).not.toHaveBeenCalled();

        const busy = await setup({ panes: [pane({ status: 'running' })], answer: 'cancel' });
        busy.emit(stop('pane-a', '! gh auth status'));
        expect(await busy.window()).toBe('cancel');
        expect(busy.showDialog.mock.calls[0]![0].actions.map(action => action.id)).toEqual(['cancel', 'split']);
        expect(busy.split).not.toHaveBeenCalled();
        expect(busy.send).not.toHaveBeenCalled();
    });

    it('sends to the new split only while its screen is the one its settled read saw', async () => {
        const plugin = await setup({ answer: 'split' });
        plugin.emit(stop('pane-a', '! gh auth status'));
        expect(await plugin.window()).toBe('split');
        // Read before the dialog, then the settled read of the new split, then the guarded send.
        expect(plugin.calls).toEqual(['read pane-a', 'read pane-new', 'send pane-new']);
        expect(plugin.read).toHaveBeenLastCalledWith('pane-new', { scrollback: false, settleMs: 500 });
        const reads = await readResults(plugin.read);
        expect(plugin.send).toHaveBeenCalledWith('pane-new', 'gh auth status', { ifRevision: reads[1]!.revision });
        expect(plugin.showNotification).not.toHaveBeenCalled();
    });

    it('sends nothing to a new split that changed, or could not be read, after it opened, and leaves it open', async () => {
        for (const failure of [{ splitSendError: screenChanged() }, { splitReadError: new Error('pane closed during capture') }]) {
            const plugin = await setup({ answer: 'split', ...failure });
            plugin.emit(stop('pane-a', '! gh auth status'));
            expect(await plugin.window()).toBe('split');
            expect(plugin.showNotification).toHaveBeenCalledWith({ message: `Run suggested: ${SPLIT_CHANGED}`, detail: 'The new split stays open.', tone: 'warning' });

            const cli = await setup({ screen: BUSY, ...failure });
            cli.emit(stop('pane-a', '! gh auth status'));
            expect(await cli.cli(['--yes'])).toEqual({ stderr: `kelpi run-suggested: ${SPLIT_CHANGED}`, exitCode: 1 });

            for (const run of [plugin, cli]) {
                expect(run.split).toHaveBeenCalledTimes(1);
                // A failed read leaves send unreached; a changed screen gets the one guarded attempt.
                expect(run.send).toHaveBeenCalledTimes('splitSendError' in failure ? 1 : 0);
                expect(run.send.mock.calls.every(([, , sendOptions]) => sendOptions?.ifRevision !== undefined)).toBe(true);
                expect(run.sendKey).not.toHaveBeenCalled();
            }
        }
    });

    it('notifies instead of asking when the command is too long for the dialog, and sends nothing', async () => {
        const command = 'echo ' + 'a'.repeat(2048);
        const plugin = await setup();
        plugin.emit(stop('pane-a', `! ${command}`));
        expect(await plugin.window()).toBeNull();
        expect(plugin.showDialog).not.toHaveBeenCalled();
        expect(plugin.showNotification).toHaveBeenCalledWith({
            message: `Run suggested: the command is too long to confirm in a dialog (${command.length} characters); run \`kelpi run-suggested --print\` or \`--yes\` in the pane instead`,
            tone: 'warning',
        });
        expect(plugin.send).not.toHaveBeenCalled();
        expect(plugin.split).not.toHaveBeenCalled();
        // At the cap it still asks; the CLI has no dialog and prints it either way.
        const atCap = await setup({ answer: 'cancel' });
        atCap.emit(stop('pane-a', `! ${'a'.repeat(2048)}`));
        await atCap.window();
        expect(atCap.showDialog).toHaveBeenCalledTimes(1);
        expect(await plugin.cli(['--print'])).toMatchObject({ text: command });
    });

    it('sends nothing when the screen changed before typing, and says the command is typed when it changed before Enter', async () => {
        const before = await setup({ sendError: screenChanged() });
        before.emit(stop('pane-a', '! gh auth status'));
        await before.window();
        expect(before.send).toHaveBeenCalledTimes(1);
        expect(before.sendKey).not.toHaveBeenCalled();
        expect(before.showNotification).toHaveBeenCalledWith({ message: 'Run suggested: the screen changed, nothing was sent', detail: 'It changed before the command was typed.', tone: 'warning' });

        const after = await setup({ keyError: screenChanged() });
        after.emit(stop('pane-a', '! gh auth status'));
        await after.window();
        expect(after.send).toHaveBeenCalledTimes(1);
        expect(after.sendKey).toHaveBeenCalledTimes(1);
        expect(after.showNotification).toHaveBeenCalledWith({ message: `Run suggested: ${TYPED_NOT_RUN}`, tone: 'warning' });
    });

    it('never presses Enter when the typed screen shows a menu instead of the command in the box', async () => {
        const plugin = await setup({ screens: [READY, READY, PERMISSION] });
        plugin.emit(stop('pane-a', '! gh auth status'));
        expect(await plugin.window()).toBe('session');
        expect(plugin.calls).toEqual(['read pane-a', 'read pane-a', 'send pane-a', 'read pane-a']);
        expect(plugin.send).toHaveBeenCalledTimes(1);
        expect(plugin.sendKey).not.toHaveBeenCalled();
        expect(plugin.showNotification).toHaveBeenCalledWith({ message: `Run suggested: ${MISMATCH}`, tone: 'warning' });

        const cli = await setup({ screens: [READY, PERMISSION] });
        cli.emit(stop('pane-a', '! gh auth status'));
        expect(await cli.cli(['--yes'])).toEqual({ stderr: `kelpi run-suggested: ${MISMATCH}`, exitCode: 1 });
        expect(cli.sendKey).not.toHaveBeenCalled();
    });

    it("never presses Enter when the typed text did not switch Claude's box to bash mode", async () => {
        // The box shows the text after the plain glyph: Enter would send it to Claude as a prompt.
        const notBash = box('! gh auth status');
        const plugin = await setup({ screens: [READY, READY, notBash] });
        plugin.emit(stop('pane-a', '! gh auth status'));
        expect(await plugin.window()).toBe('session');
        expect(plugin.send).toHaveBeenCalledTimes(1);
        expect(plugin.sendKey).not.toHaveBeenCalled();
        expect(plugin.showNotification).toHaveBeenCalledWith({ message: `Run suggested: ${MISMATCH}`, tone: 'warning' });

        const cli = await setup({ screens: [READY, notBash] });
        cli.emit(stop('pane-a', '! gh auth status'));
        expect(await cli.cli(['--yes'])).toEqual({ stderr: `kelpi run-suggested: ${MISMATCH}`, exitCode: 1 });
        expect(cli.sendKey).not.toHaveBeenCalled();
    });

    it('never presses Enter when the cursor after typing sits right after the glyph, in front of ghost text', async () => {
        const plugin = await setup({ typedCursor: { row: 3, col: 2 } });
        plugin.emit(stop('pane-a', '! gh auth status'));
        expect(await plugin.cli(['--yes'])).toEqual({ stderr: `kelpi run-suggested: ${MISMATCH}`, exitCode: 1 });
        expect(plugin.send).toHaveBeenCalledTimes(1);
        expect(plugin.sendKey).not.toHaveBeenCalled();
    });

    it('offers only a new split after a permission prompt notification or an abstained request, until the next turn', async () => {
        const plugin = await setup({ panes: [pane({ status: 'waitingForInput' })], answer: 'cancel' });
        const actions = (call: number) => plugin.showDialog.mock.calls[call]![0].actions.map(action => action.id);
        plugin.emit(stop('pane-a', '! gh auth status'));
        plugin.emit(event('notification', { notificationType: 'permission_prompt' }));
        await plugin.window();
        expect(actions(0)).toEqual(['cancel', 'split']);
        expect(plugin.showDialog.mock.calls[0]![0].detail).toBe('Runs in a new shell split: Claude was last seen at a permission prompt.');
        plugin.emit(event('start', { status: 'running' }));
        plugin.emit(stop('pane-a', '! gh auth status'));
        await plugin.window();
        expect(actions(1)).toEqual(['cancel', 'split', 'session']);

        plugin.emit(event('permission-request', { behavior: 'abstain', toolName: 'Bash' }));
        await plugin.window();
        expect(actions(2)).toEqual(['cancel', 'split']);
        expect(plugin.send).not.toHaveBeenCalled();
    });

    it('keeps a permission prompt notification through a later notification of another type', async () => {
        const plugin = await setup({ panes: [pane({ status: 'waitingForInput' })], answer: 'cancel' });
        const actions = (call: number) => plugin.showDialog.mock.calls[call]![0].actions.map(action => action.id);
        plugin.emit(stop('pane-a', '! gh auth status'));
        plugin.emit(event('notification', { notificationType: 'permission_prompt' }));
        plugin.emit(event('notification', { notificationType: 'idle_prompt' }));
        await plugin.window();
        expect(actions(0)).toEqual(['cancel', 'split']);
        plugin.emit(event('stop', { status: 'idle' }));
        plugin.emit(event('notification', { notificationType: 'elicitation_dialog' }));
        plugin.emit(event('notification', { notificationType: 'idle_prompt' }));
        await plugin.window();
        expect(actions(1)).toEqual(['cancel', 'split']);
        plugin.emit(event('start', { status: 'running' }));
        plugin.emit(stop('pane-a', '! gh auth status'));
        plugin.emit(event('notification', { notificationType: 'idle_prompt' }));
        await plugin.window();
        expect(actions(2)).toEqual(['cancel', 'split', 'session']);
    });

    it('refuses a command with a control character on both paths and sends nothing', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', '! echo \u001b[31m'));
        expect(await plugin.window()).toBeNull();
        expect(plugin.showNotification).toHaveBeenCalledWith({ message: 'Run suggested: not running it: the command contains a control character', tone: 'warning' });
        expect(plugin.showDialog).not.toHaveBeenCalled();
        expect(await plugin.cli(['--yes'])).toEqual({ stderr: 'kelpi run-suggested: not running it: the command contains a control character', exitCode: 1 });
        expect(await plugin.cli(['--print'])).toMatchObject({ exitCode: 1 });
        expect(plugin.send).not.toHaveBeenCalled();
        expect(plugin.sendKey).not.toHaveBeenCalled();
    });

    it('sends nothing when Claude stops waiting at its prompt while the dialog is open', async () => {
        const noLonger = NO_LONGER;
        const working = await setup();
        working.list.mockResolvedValueOnce([pane()]).mockResolvedValueOnce([pane({ status: 'running' })]);
        working.emit(stop('pane-a', '! gh auth status'));
        expect(await working.window()).toBe('session');
        expect(working.showNotification).toHaveBeenCalledWith({ message: noLonger, detail: 'Claude is still working', tone: 'warning' });

        const asking = await setup({ screens: [READY, PERMISSION] });
        asking.emit(stop('pane-a', '! gh auth status'));
        expect(await asking.window()).toBe('session');
        expect(asking.showNotification).toHaveBeenCalledWith({ message: noLonger, detail: "Claude's input box is not empty", tone: 'warning' });

        for (const plugin of [working, asking]) {
            expect(plugin.send).not.toHaveBeenCalled();
            expect(plugin.sendKey).not.toHaveBeenCalled();
            expect(plugin.split).not.toHaveBeenCalled();
        }
    });

    it('runs nothing when Claude replies with another suggestion while the dialog is open', async () => {
        for (const answer of ['session', 'split']) {
            const plugin = await setup();
            plugin.emit(stop('pane-a', '! gh auth status'));
            plugin.showDialog.mockImplementationOnce(async () => { plugin.emit(stop('pane-a', '! rm -rf build')); return answer; });
            expect(await plugin.window()).toBe(answer);
            expect(plugin.showNotification).toHaveBeenCalledWith({ message: NO_LONGER, detail: 'Claude replied again', tone: 'warning' });
            expect(plugin.send).not.toHaveBeenCalled();
            expect(plugin.sendKey).not.toHaveBeenCalled();
            expect(plugin.split).not.toHaveBeenCalled();
        }
    });

    it('runs nothing when a new Claude session starts in the pane while the dialog is open', async () => {
        for (const answer of ['session', 'split']) {
            const plugin = await setup();
            plugin.emit(stop('pane-a', '! gh auth status'));
            plugin.list.mockResolvedValueOnce([pane()]).mockResolvedValue([pane({ agentSessionID: 'session-2' })]);
            // Even when the new session's first reply suggests the same line, it is not what the user confirmed.
            plugin.showDialog.mockImplementationOnce(async () => {
                plugin.emit(event('session-start', { sessionID: 'session-2', status: 'idle' }));
                plugin.emit({ ...stop('pane-a', '! gh auth status'), sessionID: 'session-2' });
                return answer;
            });
            expect(await plugin.window()).toBe(answer);
            expect(plugin.showNotification).toHaveBeenCalledWith({ message: NO_LONGER, detail: 'a new Claude session started', tone: 'warning' });
            expect(plugin.send).not.toHaveBeenCalled();
            expect(plugin.split).not.toHaveBeenCalled();
        }
    });

    it('still runs when Claude repeats the same suggestion while the dialog is open', async () => {
        const plugin = await setup();
        plugin.emit(stop('pane-a', '! gh auth status'));
        plugin.showDialog.mockImplementationOnce(async () => { plugin.emit(stop('pane-a', 'Once more:\n\n! gh auth status')); return 'session'; });
        expect(await plugin.window()).toBe('session');
        expect(plugin.calls).toEqual(['read pane-a', 'read pane-a', 'send pane-a', 'read pane-a', 'key pane-a']);
        expect(plugin.showNotification).not.toHaveBeenCalled();

        const split = await setup({ answer: 'split' });
        split.emit(stop('pane-a', '! gh auth status'));
        split.showDialog.mockImplementationOnce(async () => { split.emit(stop('pane-a', '! gh auth status')); return 'split'; });
        expect(await split.window()).toBe('split');
        expect(split.send).toHaveBeenCalledWith('pane-new', 'gh auth status', { ifRevision: expect.any(Number) });
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
        expect(await plugin.cli([])).toEqual({
            text: 'gh auth status', json: { command: 'gh auth status', kind: 'bang' },
            stderr: "Pass --yes to run it, or press the Run Claude's suggested command shortcut (Ctrl+Alt+R by default) in the pane to choose where it runs.",
        });
        expect(plugin.send).not.toHaveBeenCalled();
        expect(await plugin.cli(['--yes'])).toEqual({ text: 'ran in the Claude session', json: { command: 'gh auth status', kind: 'bang', ran: 'session', paneID: 'pane-a' } });
        // One read before typing, one of what was typed.
        expect(plugin.calls).toEqual(['read pane-a', 'send pane-a', 'read pane-a', 'key pane-a']);
        const reads = await readResults(plugin.read);
        expect(plugin.send).toHaveBeenCalledWith('pane-a', '! gh auth status', { bare: true, ifRevision: reads[0]!.revision });
        expect(plugin.sendKey).toHaveBeenCalledWith('pane-a', 'enter', { ifRevision: reads[1]!.revision });
        expect(plugin.showDialog).not.toHaveBeenCalled();
        expect(plugin.showNotification).not.toHaveBeenCalled();
    });

    it('runs --yes in a new split when the pane is busy, and reports a changed screen', async () => {
        const busy = await setup({ screen: BUSY });
        busy.emit(stop('pane-a', '! gh auth status'));
        expect(await busy.cli(['--yes'])).toMatchObject({ text: "ran in a new split: Claude's input box is not empty" });
        expect(busy.split).toHaveBeenCalledWith('pane-a', expect.objectContaining({ path: '/work/app' }));
        expect(busy.send).toHaveBeenCalledWith('pane-new', 'gh auth status', { ifRevision: expect.any(Number) });

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
        // `--target` as the last word, or an option where its pane should be, is a missing value.
        for (const argv of [['--target'], ['--target', '--yes'], ['--yes', '--target', '--print']]) {
            expect(await plugin.cli(argv)).toEqual({ stderr: expect.stringMatching(/^kelpi run-suggested: --target needs a pane\n\nUsage: kelpi run-suggested/), exitCode: 2 });
        }
        expect(plugin.list).not.toHaveBeenCalled();
        expect(await plugin.cli(['--help'])).toEqual({ text: expect.stringContaining('Usage: kelpi run-suggested') });
    });
});
