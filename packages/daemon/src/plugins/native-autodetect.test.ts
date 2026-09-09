import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginService } from './service.js';
import { createPluginGitService } from './git-service.js';
import { createRepoAutoDetect } from '../git/autodetect.js';
import { stubGitService } from '../git/testing.js';
import type { GitService } from '../git/service.js';
import { harness, seededState, id, NOW, W1 } from '../store/testing.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const PLUGIN = 'test.autodetect';
const PROVIDER = `${PLUGIN}.git`;

it('rediscovers an unchanged cwd through the new Git provider and drops a late previous result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-provider-auto-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const paneID = id('dddddddd', 1);
    const store = harness(seededState(W1, paneID));
    store.dispatch({ type: 'pane-directory-changed', paneID, directory: '/work/wt/src', now: NOW });
    let oldResolve!: (value: { worktreeRoot: string; parentRepoRoot: string }) => void;
    const oldResult = new Promise<{ worktreeRoot: string; parentRepoRoot: string }>(resolve => { oldResolve = resolve; });
    const resolveRepoRoot = vi.fn<GitService['resolveRepoRoot']>()
        .mockReturnValueOnce(oldResult)
        .mockResolvedValue({ worktreeRoot: '/work/wt', parentRepoRoot: '/current-parent' });
    const native = stubGitService({ resolveRepoRoot });
    let host: PluginService | undefined;
    const { git, service } = createPluginGitService(native, () => host);
    host = new PluginService({ directory: path.join(dir, 'installed'), store: store.store, command: async () => ({ ok: true }), broadcast: () => {} });
    cleanups.push(() => host!.dispose());
    host.registerBuiltinService(service);
    const source = path.join(dir, 'provider');
    fs.mkdirSync(source);
    const methods = Object.keys(service.methods);
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({
        id: PLUGIN, name: 'Auto-detection Git provider', version: '1.0.0', apiVersion: 1,
        trust: 'full', activation: 'on-demand', backend: 'backend.mjs',
        contributes: { providers: [{ id: PROVIDER, title: 'Auto-detection Git provider', service: 'kelpi.git', version: 1, methods }] }
    }));
    fs.writeFileSync(path.join(source, 'backend.mjs'), `
        export function activate(api) {
            return api.providers.register(${JSON.stringify(PROVIDER)}, Object.fromEntries(
                ${JSON.stringify(methods)}.map(method => [method, args =>
                    api.services.call('kelpi.git', 1, method, args, { provider: 'bundled' })])
            ));
        }
    `);
    await host.install(source, true);
    await host.request('service-select', { service: 'kelpi.git', version: 1, providerID: PROVIDER });

    let nextID = 10;
    const detect = createRepoAutoDetect({ store: store.store, git, enabled: () => true, uuid: () => id('eeeeeeee', ++nextID), linkDebounceMs: 0, unlinkDebounceMs: 0 });
    cleanups.push(() => detect.stop());
    const off = host.onServicesChanged(changed => {
        if (changed.includes('kelpi.git@1')) detect.invalidate();
    });
    cleanups.push(off);
    detect.start();
    await vi.waitFor(() => expect(resolveRepoRoot).toHaveBeenCalledTimes(1));

    await host.request('service-select', { service: 'kelpi.git', version: 1, providerID: 'kelpi.git.bundled' });
    await vi.waitFor(() => expect(store.state().repos.map(repo => repo.path)).toEqual(['/current-parent']));
    // The previous provider is still installed and its delegated native read cannot be
    // cancelled. Its eventual reply must not add a repository after selection changed.
    oldResolve({ worktreeRoot: '/work', parentRepoRoot: '/old-provider-parent' });
    await detect.idle();
    expect(store.state().repos.map(repo => repo.path)).toEqual(['/current-parent']);
    expect(resolveRepoRoot).toHaveBeenCalledTimes(2);
    expect(store.state().workspaces[0]?.repoAssociations).toHaveLength(1);
});
