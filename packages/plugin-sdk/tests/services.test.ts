import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createKelpiAPI } from '../index.js';
import { createStore } from '../../daemon/src/store/store.js';
import { seededState } from '../../daemon/src/store/testing.js';
import { createGitService } from '../../daemon/src/git/service.js';
import { createPluginGitService } from '../../daemon/src/plugins/git-service.js';
import { createContentRenderService } from '../../daemon/src/content/render-service.js';
import { createProcessService } from '../../daemon/src/plugins/process-service.js';
import { PluginService } from '../../daemon/src/plugins/service.js';
import { contentServiceFixture, gitServiceFixtures, processServiceFixture } from './service-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('public native service contracts', () => {
    it('keeps every typed Git method and service DTO aligned with the real native validators', () => {
        const git = createPluginGitService(createGitService(), () => undefined).service;
        expect(Object.keys(git.methods).sort()).toEqual(Object.keys(gitServiceFixtures).sort());
        for (const [method, fixture] of Object.entries(gitServiceFixtures)) {
            expect(() => git.methods[method]!.validateArgs(fixture.args), method).not.toThrow();
            expect(() => git.methods[method]!.validateResult(fixture.result), method).not.toThrow();
        }
        const content = createContentRenderService().methods['render']!;
        expect(() => content.validateArgs(contentServiceFixture.args)).not.toThrow();
        expect(() => content.validateResult(contentServiceFixture.result)).not.toThrow();
        const process = createProcessService({ homeDirectory: () => '/tmp', cliEnvironment: () => ({}) }).methods['exec']!;
        expect(() => process.validateArgs(processServiceFixture.args)).not.toThrow();
        expect(() => process.validateResult(processServiceFixture.result)).not.toThrow();
    });

    it('runs Service Lab in a real backend, delegates services and bounds its call history', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-service-lab-sdk-'));
        const service = new PluginService({
            directory: path.join(root, 'plugins'), store: createStore(seededState()),
            cliEnvironment: () => ({ KELPI_SOCKET: path.join(root, 'private.sock') }),
            command: async () => ({ ok: true }), broadcast: () => {},
        });
        cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
        const git = createPluginGitService(createGitService({ run: async () => 'feature\n' }), () => service);
        service.registerBuiltinService(git.service);
        service.registerBuiltinService(createContentRenderService());
        const source = fileURLToPath(new URL('../../../examples/plugins/service-lab', import.meta.url));
        await service.install(source, true);
        const api = createKelpiAPI((method, args) => service.api('example.service-lab', method, args, { daemonID: service.daemonID }));
        await api.services.select('kelpi.git', 1, 'example.service-lab.git');
        await api.services.select('kelpi.content.render', 1, 'example.service-lab.renderer');
        await api.services.select('kelpi.process', 1, 'example.service-lab.process');
        expect(await api.services.call('kelpi.git', 1, 'getCurrentBranch', { repoPath: '/repo' })).toBe('feature');
        // The native caller uses the same selected provider as SDK calls.
        expect(await git.git.getCurrentBranch('/native')).toBe('feature');
        const bundled = await api.services.call('kelpi.content.render', 1, 'render', contentServiceFixture.args, { provider: 'bundled' });
        const rendered = await api.services.call('kelpi.content.render', 1, 'render', contentServiceFixture.args);
        expect(rendered.html).toContain('id="service-lab-banner"');
        expect(rendered.html.replace(/<div id="service-lab-banner"[^>]*>Service Lab<\/div>/, '')).toBe(bundled.html);
        const execution = await api.commands.execute('example.service-lab.exec', {
            file: process.execPath, args: ['-e', 'process.stdout.write(process.env.KELPI_SOCKET)'], cwd: root,
        });
        expect(execution).toEqual({ stdout: path.join(root, 'private.sock'), stderr: '' });
        const history = await api.commands.execute<Array<{ service: string; method: string; repoPath: string | null }>>('example.service-lab.history');
        expect(history).toEqual(expect.arrayContaining([
            expect.objectContaining({ service: 'kelpi.git', method: 'getCurrentBranch', repoPath: '/native' }),
            expect.objectContaining({ service: 'kelpi.content.render', method: 'render' }),
            expect.objectContaining({ service: 'kelpi.process', method: 'exec' }),
        ]));
        for (let index = 0; index < 101; index++) await api.services.call('kelpi.git', 1, 'getCurrentBranch', { repoPath: `/repo/${index}` });
        const bounded = await api.commands.execute<Array<{ repoPath: string }>>('example.service-lab.history');
        expect(bounded).toHaveLength(100);
        expect(bounded[0]?.repoPath).toBe('/repo/1');
        expect(bounded.at(-1)?.repoPath).toBe('/repo/100');
    });
});
