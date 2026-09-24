/** Verify the actual npm artifact from consumers outside the monorepo, without publishing. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = path.join(repo, 'packages/plugin-sdk');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-sdk-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tsc = path.join(repo, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const run = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });

try {
    const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--offline', '--cache', path.join(temporary, 'cache'), '--pack-destination', temporary], sdk));
    const manifest = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8'));
    assert.deepEqual(packed.files.map(file => file.path).sort(), ['package.json', ...manifest.files].sort(), 'SDK artifact must contain exactly its public files');
    const consumer = path.join(temporary, 'consumer'); fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'external-plugin', private: true, type: 'module', dependencies: { '@kelpi/plugin-sdk': `file:${path.join(temporary, packed.filename)}` } }));
    run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--cache', path.join(temporary, 'cache')], consumer);
    const fixtures = {
        backend: `import type { BackendAPI, BrowserSnapshot, BuiltinProviderMethods } from '@kelpi/plugin-sdk';
export function activate(api: BackendAPI) {
    api.commands.register('example.external.list', async () => ({ count: (await api.workspaces.list()).length }));
    const provider: BuiltinProviderMethods<'kelpi.files'> = { read: () => 'text', write: () => null };
    api.providers.register<'kelpi.files'>('example.external.files', provider);
    const state: Promise<{ subscription: string; state: BrowserSnapshot }> = api.browser.watch('pane');
    // @ts-expect-error Native view attachment belongs to a view, not the backend.
    api.browser.attach({});
    return () => { void state; };
}`,
        view: `import { getKelpi, type ViewAPI, type BrowserSurface, type InteractionSnapshot, type PaneChromeSnapshot, type PaneSearchSnapshot, type SettingsPresenterSnapshot, type TerminalGrid, type TerminalSession } from '@kelpi/plugin-sdk';
const api: ViewAPI = getKelpi();
let mirror: TerminalGrid | null = null;
async function mount(element: HTMLElement) {
    await api.ready;
    const browser: BrowserSurface = await api.browser.attach({ element, onPresentation() {} });
    // Replay geometry and size ownership are part of the published surface: only a replay
    // states a grid, and every presentation states ownership.
    const terminal: TerminalSession = await api.terminal.attach({ cols: 80, rows: 24, onFrame(frame) {
        if (frame.type === 'replay') mirror = frame.grid;
        else if (frame.type === 'presentation' && frame.value.ownsSize) mirror = null;
        // @ts-expect-error Only a replay frame states the grid it was serialised at.
        else if (frame.type === 'output') void frame.grid;
        // A mirror sizes the EMULATOR; resize() still reports the measured box, never the mirror.
        if (mirror !== null) void mirror.cols;
        terminal.resize(80, 24);
    } });
    await api.ui.showNotification({ message: 'External plugin ready' });
    // A selected presenter reads one placement's projection and answers a visible request.
    const interaction: InteractionSnapshot = await api.ui.getInteraction();
    await api.ui.reportPresenterReady();
    if (interaction.palette !== null) await api.ui.setPaletteQuery(interaction.palette.sessionID, 'settings');
    if (interaction.prompt?.kind === 'quickPick') await api.ui.respondInteraction(interaction.prompt.requestID, interaction.prompt.options.items[0]!.id);
    // The notifications placement: a corner stack whose height the presenter declares.
    for (const notice of interaction.notifications) await api.ui.respondInteraction(notice.requestID, null);
    await api.ui.setNotificationBoxHeight(interaction.notifications.length * 96);
    // @ts-expect-error An owner is a display name and an opaque ref, never a plugin identity.
    void interaction.prompt?.owner.pluginID;
    // A Settings presenter routes the host's dialog and edits only the fields it was given.
    const settings: SettingsPresenterSnapshot = await api.ui.getSettingsPresentation();
    await api.ui.setSettingsSection(settings.sections[0]!.id);
    if (!settings.native) for (const row of settings.fields) {
        if (row.kind !== 'text') continue;
        await api.ui.setSettingsDraft(row.id, row.value.slice(0, row.maxLength));
        await api.ui.commitSettingsField(row.id);
    }
    await api.ui.closeSettings();
    // @ts-expect-error A field carries no write target: the presenter sends an id, the host owns the key.
    void settings.fields[0]?.configKey;
    // A pane chrome presenter reads one frame for every visible pane, presses a control by its
    // opaque ref and declares the band it needs. Nothing it holds names a verb, an owner or a path.
    const chrome: PaneChromeSnapshot = await api.ui.getPaneChrome();
    if (chrome.visible) for (const pane of chrome.panes) {
        if (pane.rect !== null) await api.ui.setPaneChromeHeight(pane.paneID, Math.min(48, pane.rect.width));
        for (const entry of pane.controls) if (entry.enabled && !entry.pinned) await api.ui.activatePaneControl(pane.paneID, entry.ref);
        for (const other of pane.items) if (other.enabled) await api.ui.runPaneHeaderItem(pane.paneID, other.ref);
        if (!pane.renaming) await api.ui.renamePane(pane.paneID);
        await api.ui.focusChromePane(pane.paneID);
        // The band's own title area, offered to the host as a drag region.
        if (pane.rect !== null) await api.ui.setPaneDragRegions(pane.paneID, [{ x: 8, y: 0, width: Math.max(0, pane.rect.width - 80), height: pane.rect.height }]);
    }
    const stopChrome = api.ui.onPaneChrome(frame => { void frame.withheld; });
    stopChrome();
    // @ts-expect-error A control is addressed by an opaque ref, never by its host-side key.
    void chrome.panes[0]?.controls[0]?.key;
    // @ts-expect-error The rename field is the host's: a presenter asks for it, it does not send a name.
    void api.ui.renamePane('pane-1', 'api');
    // A pane search presenter reads one frame about ONE pane, drives the daemon's own needle and
    // declares the box it drew. It never receives the buffer it is searching and cannot open a search.
    const search: PaneSearchSnapshot = await api.ui.getPaneSearch();
    if (search.visible && search.paneID !== null && search.box !== null) {
        await api.ui.setSearchNeedle(search.paneID, search.needle);
        await api.ui.setSearchCaseSensitive(search.paneID, !search.caseSensitive);
        await api.ui.searchNext(search.paneID);
        await api.ui.searchPrevious(search.paneID);
        await api.ui.setSearchBoxSize(search.paneID, { width: search.box.width, height: search.box.height });
        await api.ui.setSearchBoxSize(search.paneID, null);
        await api.ui.closeSearch(search.paneID);
    }
    const stopSearch = api.ui.onPaneSearch(frame => { void frame.needleTruncated; });
    stopSearch();
    // @ts-expect-error A find bar never receives the buffer it is searching; capture does that.
    void search.scrollback;
    // @ts-expect-error Opening a search is a host gesture, not a presenter call.
    void api.ui.openSearch('pane-1');
    browser.dispose(); terminal.dispose();
}
void mount;
`,
    };
    for (const [name, contents] of Object.entries(fixtures)) {
        fs.writeFileSync(path.join(consumer, `${name}.ts`), contents);
        fs.writeFileSync(path.join(consumer, `tsconfig.${name}.json`), JSON.stringify({ compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
            types: [], lib: name === 'backend' ? ['ES2022'] : ['ES2022', 'DOM'],
        }, files: [`${name}.ts`] }));
        run(tsc, ['-p', `tsconfig.${name}.json`], consumer);
    }
    fs.writeFileSync(path.join(consumer, 'runtime.mjs'), `import assert from 'node:assert/strict';
import { createKelpiAPI, getKelpi, KelpiError } from '@kelpi/plugin-sdk';
const calls = [];
const api = createKelpiAPI(async (method, args) => { calls.push({ method, args }); return null; });
await api.storage.get('key');
assert.deepEqual(calls, [{ method: 'storage.get', args: { key: 'key' } }]);
assert.throws(() => getKelpi(), /Kelpi plugin view/);
globalThis.kelpi = api; assert.equal(getKelpi(), api);
assert.equal(typeof KelpiError, 'function');
`);
    run(process.execPath, ['runtime.mjs'], consumer);
    process.stdout.write(`SDK artifact verified: ${packed.filename}; browser types, Node-only backend types, runtime imports.\n`);
} catch (error) {
    if (error.stdout) process.stderr.write(String(error.stdout));
    if (error.stderr) process.stderr.write(String(error.stderr));
    throw error;
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
