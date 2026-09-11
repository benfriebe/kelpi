import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPluginPackage } from '@kelpi/core/plugin-package';
import { decodePluginManifest } from '@kelpi/protocol';
import { pluginScaffoldTemplates, scaffoldPlugin, type PluginScaffoldTemplate } from './plugin-scaffold.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-plugin-scaffold-')); roots.push(value); return value; }

class ViewElement {
    value = ''; textContent = ''; checked = false; disabled = false;
    style: Record<string, string> = {};
    children: ViewElement[] = [];
    onclick?: () => unknown;
    onchange?: () => unknown;
    onfocus?: () => unknown;
    onsubmit?: (event: { preventDefault(): void }) => unknown;
    focus = vi.fn(() => this.onfocus?.()); select = vi.fn();
    addEventListener = vi.fn();
    replaceChildren(...children: ViewElement[]) { this.children = children; }
}

/** Execute the generated plain JS against public SDK callbacks; no host internals are available. */
function view(template: PluginScaffoldTemplate, methods: Record<string, unknown>, state = {}) {
    const result = scaffoldPlugin(path.join(root(), 'view'), `example.${template}`, 'View', template);
    const markup = fs.readFileSync(path.join(result.path, 'ui/index.html'), 'utf8');
    const nodes = new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1]!, new ViewElement()]));
    const node = (id: string): ViewElement => { const value = nodes.get(id); if (!value) throw new Error(`missing markup element ${id}`); return value; };
    const events = new Map<string, (event: { data: { subscription: string } }) => unknown>();
    const windowEvents = new Map<string, () => void>();
    const setState = vi.fn().mockResolvedValue(undefined);
    const api = {
        ready: Promise.resolve(), state, setState, ...methods,
        events: { on: (name: string, listener: (event: { data: { subscription: string } }) => unknown) => {
            events.set(name, listener); return () => events.delete(name);
        } },
    };
    new vm.Script(fs.readFileSync(path.join(result.path, 'ui/app.js'), 'utf8')).runInNewContext({
        kelpi: api, document: { getElementById: node, createElement: () => new ViewElement() },
        addEventListener: (name: string, listener: () => void) => windowEvents.set(name, listener),
    });
    return { node, events, setState, close: () => windowEvents.get('pagehide')?.() };
}

describe('offline plugin scaffold', () => {
    it('creates a validated package and a working backend command without a build', async () => {
        const result = scaffoldPlugin(path.join(root(), 'my plugin'), 'example.board', 'Board <one>');
        const manifest = decodePluginManifest(JSON.parse(fs.readFileSync(path.join(result.path, 'kelpi.plugin.json'), 'utf8')));
        expect(manifest.contributes.views[0]).toMatchObject({ id: result.viewID, placements: ['pane', 'sidebar.primary', 'sidebar.secondary'] });
        expect(fs.readFileSync(path.join(result.path, 'ui/index.html'), 'utf8')).toContain('Board &lt;one>');
        expect(() => new vm.Script(fs.readFileSync(path.join(result.path, 'ui/app.js'), 'utf8'))).not.toThrow();
        const module = await import(pathToFileURL(path.join(result.path, 'backend.mjs')).href);
        const unregister = vi.fn(); let handler: (() => Promise<unknown>) | undefined;
        const register = vi.fn((_id, fn) => { handler = fn; return unregister; });
        const deactivate = module.activate({ commands: { register }, workspaces: { list: async () => [{ id: 'W', paneCount: 3 }] } });
        expect(register).toHaveBeenCalledWith('example.board.summary', expect.any(Function));
        expect(await handler?.()).toMatchObject({ workspaces: [{ id: 'W', paneCount: 3 }] });
        deactivate(); expect(unregister).toHaveBeenCalledOnce();
    });
    it('validates names before creating files and refuses to overwrite any existing directory', () => {
        const existing = root();
        fs.writeFileSync(path.join(existing, 'keep.txt'), 'user content');
        expect(() => scaffoldPlugin(existing, 'example.board', 'Board')).toThrow();
        expect(fs.readdirSync(existing)).toEqual(['keep.txt']);
        const invalid = path.join(existing, 'invalid');
        expect(() => scaffoldPlugin(invalid, 'kelpi.reserved', 'Invalid')).toThrow('reserved');
        expect(fs.existsSync(invalid)).toBe(false);
        expect(() => scaffoldPlugin(invalid, 'example.board', 'Board', 'unknown' as PluginScaffoldTemplate)).toThrow('unknown plugin template');
        expect(fs.existsSync(invalid)).toBe(false);
    });

    it.each(pluginScaffoldTemplates)('creates a portable %s template with matching view entry and usage instructions', async template => {
        const destination = path.join(root(), template);
        const result = scaffoldPlugin(destination, `example.${template}`, 'Custom <view>', template);
        const pkg = await readPluginPackage(result.path);
        expect(result).toEqual({ path: destination, pluginID: `example.${template}`, viewID: `example.${template}.home` });
        expect(pkg.manifest.contributes.views[0]?.placements).toEqual({
            pane: ['pane', 'sidebar.primary', 'sidebar.secondary'],
            sidebar: ['sidebar.primary', 'sidebar.secondary'],
            document: ['document.markdown', 'document.scratchpad', 'document.diff'],
            browser: ['browser'],
        }[template]);
        expect(pkg.files.map(file => file.relative)).toEqual(['README.md', 'backend.mjs', 'kelpi.plugin.json', 'ui/app.js', 'ui/index.html']);
        expect(() => new vm.Script(fs.readFileSync(path.join(result.path, 'ui/app.js'), 'utf8'))).not.toThrow();
        const readme = fs.readFileSync(path.join(result.path, 'README.md'), 'utf8');
        expect(readme).toContain('kelpi plugin dev . --trust');
        expect(readme).toContain(`kelpi plugin pack . --out ../example.${template}.kelpi-plugin`);
        if (template === 'pane') expect(readme).toContain(`kelpi plugin open ${result.pluginID} ${result.viewID}`);
        else expect(readme).not.toContain(`kelpi plugin open ${result.pluginID}`);
    });

    it('runs the native document starter against public watch/state APIs and releases its subscription', async () => {
        const initial = { text: '<script>document text</script>', path: '/a.md', kind: 'markdown', loaded: true, dirty: false, error: null };
        const documents = {
            watch: vi.fn().mockResolvedValue({ subscription: 'doc-watch', state: initial }),
            get: vi.fn().mockResolvedValue({ ...initial, text: 'Another client edited this', dirty: true }),
            unwatch: vi.fn().mockResolvedValue(undefined),
        };
        const h = view('document', { documents }, { wrap: false });
        await vi.waitFor(() => expect(h.node('source').textContent).toBe(initial.text));
        expect(h.node('source').style['whiteSpace']).toBe('pre');
        h.node('wrap').checked = true; h.node('wrap').onchange?.();
        expect(h.setState).toHaveBeenCalledWith({ wrap: true });
        await h.events.get('documents.changed')?.({ data: { subscription: 'doc-watch' } });
        expect(h.node('source').textContent).toBe('Another client edited this');
        expect(h.node('status').textContent).toContain('Unsaved changes');
        h.close(); h.close();
        expect(documents.unwatch).toHaveBeenCalledExactlyOnceWith('doc-watch');
        expect(h.events.size).toBe(0);
    });

    it('releases a document watch that completes after its view closes', async () => {
        let attached!: (value: unknown) => void;
        const documents = {
            watch: vi.fn(() => new Promise(resolve => { attached = resolve; })),
            unwatch: vi.fn().mockResolvedValue(undefined),
        };
        const h = view('document', { documents });
        await vi.waitFor(() => expect(documents.watch).toHaveBeenCalledOnce());
        h.close(); attached({ subscription: 'late-watch', state: {} });
        await vi.waitFor(() => expect(documents.unwatch).toHaveBeenCalledExactlyOnceWith('late-watch'));
        expect(h.node('source').textContent).toBe('');
    });

    it('runs the browser starter against the existing native page, preserving an address draft through invalidations', async () => {
        const state = { paneID: 'browser-pane', activeTabID: 'tab', tabs: [{ id: 'tab', title: 'Existing page', url: 'https://example.com/', canGoBack: true, canGoForward: false }] };
        const surface = { dispose: vi.fn(), focus: vi.fn() };
        const browser = {
            watch: vi.fn().mockResolvedValue({ subscription: 'browser-watch', state }),
            get: vi.fn().mockResolvedValue({ ...state, tabs: [{ ...state.tabs[0], url: 'https://example.com/updated' }] }),
            attach: vi.fn().mockResolvedValue(surface),
            navigate: vi.fn().mockResolvedValue({}),
            unwatch: vi.fn().mockResolvedValue(undefined),
        };
        const h = view('browser', { browser });
        await vi.waitFor(() => expect(browser.attach).toHaveBeenCalledOnce());
        expect(browser.attach).toHaveBeenCalledWith(expect.objectContaining({ element: h.node('page-slot') }));
        expect(h.node('address').value).toBe('https://example.com/');
        h.node('address').focus(); h.node('address').value = 'https://example.org/draft';
        await h.events.get('browser.changed')?.({ data: { subscription: 'browser-watch' } });
        expect(h.node('address').value).toBe('https://example.org/draft');
        const preventDefault = vi.fn(); h.node('navigation').onsubmit?.({ preventDefault });
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(browser.navigate).toHaveBeenCalledExactlyOnceWith('browser-pane', 'https://example.org/draft');
        h.close(); h.close();
        expect(surface.dispose).toHaveBeenCalledOnce();
        expect(browser.unwatch).toHaveBeenCalledExactlyOnceWith('browser-watch');
        expect(h.events.size).toBe(0);
    });

    it('disposes a browser surface that attaches after its view closes without closing native tabs', async () => {
        let attached!: (value: unknown) => void;
        const surface = { dispose: vi.fn() };
        const browser = {
            watch: vi.fn().mockResolvedValue({ subscription: 'late-browser', state: { tabs: [], activeTabID: null } }),
            attach: vi.fn(() => new Promise(resolve => { attached = resolve; })),
            unwatch: vi.fn().mockResolvedValue(undefined),
        };
        const h = view('browser', { browser });
        await vi.waitFor(() => expect(browser.attach).toHaveBeenCalledOnce());
        h.close(); attached(surface);
        await vi.waitFor(() => expect(surface.dispose).toHaveBeenCalledOnce());
        expect(browser.unwatch).toHaveBeenCalledExactlyOnceWith('late-browser');
    });
});
