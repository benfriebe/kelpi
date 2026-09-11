import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPluginPackage, type PluginPackage } from '@kelpi/core/plugin-package';

export type PluginDevSignal = 'SIGINT' | 'SIGTERM';
export type PluginDevEvent =
    | { type: 'watching'; path: string }
    | { type: 'applying' | 'applied'; pluginID: string; revision: string }
    | { type: 'invalid'; error: string }
    | { type: 'failed'; pluginID: string; revision: string; error: string }
    | { type: 'stopped'; signal: PluginDevSignal | null };

export interface PluginDevOptions {
    readonly trust: boolean;
    /** Install these captured bytes before resolving; the temporary directory is then removed. */
    readonly apply: (snapshot: { path: string; pluginID: string; revision: string }) => Promise<unknown>;
    readonly onEvent: (event: PluginDevEvent) => void;
    /** Internal/test tuning. CLI deliberately uses the default one-second interval. */
    readonly pollIntervalMs?: number;
}

export interface PluginDevController {
    readonly done: Promise<{ signal: PluginDevSignal | null }>;
    /** Stop polling and await any in-flight install without uninstalling the plugin. */
    stop(): Promise<void>;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Poll bounded package snapshots instead of recursively watching ignored dependency trees.
 * The first valid read installs immediately; later edits must match on consecutive polls.
 * Only one read/install is active at a time. A failed revision is retried after another edit.
 */
export async function startPluginDev(directory: string, options: PluginDevOptions): Promise<PluginDevController> {
    if (!options.trust) throw new Error('dev requires --trust because every valid edit can execute code');
    const source = await fs.realpath(directory);
    if (!(await fs.stat(source)).isDirectory()) throw new Error('dev requires a plugin directory');
    const interval = options.pollIntervalMs ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 10) throw new Error('invalid plugin dev polling interval');

    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    let stopped = false, first = true;
    let signal: PluginDevSignal | null = null;
    let pluginID: string | undefined, applied: string | undefined, attempted: string | undefined;
    let candidate: string | undefined, invalid: string | undefined;
    let resolveDone!: (value: { signal: PluginDevSignal | null }) => void;
    const done = new Promise<{ signal: PluginDevSignal | null }>(resolve => { resolveDone = resolve; });

    const apply = async (pkg: PluginPackage): Promise<void> => {
        attempted = pkg.revision;
        const identity = { pluginID: pkg.manifest.id, revision: pkg.revision };
        let temporary: string | undefined;
        try {
            temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kelpi-plugin-dev-'));
            for (const file of pkg.files) {
                if (stopped) return;
                const destination = path.join(temporary, file.relative);
                await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
                await fs.writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 });
            }
            if (stopped) return;
            options.onEvent({ type: 'applying', ...identity });
            await options.apply({ path: temporary, ...identity });
            applied = pkg.revision;
            options.onEvent({ type: 'applied', ...identity });
        } catch (error) {
            options.onEvent({ type: 'failed', ...identity, error: message(error) });
        } finally {
            if (temporary) await fs.rm(temporary, { recursive: true, force: true });
        }
    };

    const poll = async (): Promise<void> => {
        try {
            const pkg = await readPluginPackage(source);
            if (stopped) return;
            if (pluginID && pluginID !== pkg.manifest.id) throw new Error(`plugin id changed from ${pluginID} to ${pkg.manifest.id}; restart dev to use another plugin`);
            pluginID ??= pkg.manifest.id;
            invalid = undefined;
            if (pkg.revision === applied || pkg.revision === attempted) { candidate = undefined; return; }
            if (first || candidate === pkg.revision) {
                candidate = undefined;
                await apply(pkg);
            } else candidate = pkg.revision;
        } catch (error) {
            candidate = undefined;
            const detail = message(error);
            if (!stopped && invalid !== detail) options.onEvent({ type: 'invalid', error: detail });
            invalid = detail;
        } finally {
            first = false;
            if (!stopped) timer = setTimeout(() => { running = poll(); }, interval);
        }
    };

    const stop = async (received: PluginDevSignal | null = null): Promise<void> => {
        if (!stopped) {
            stopped = true;
            signal = received;
            clearTimeout(timer);
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
            await running;
            options.onEvent({ type: 'stopped', signal });
            resolveDone({ signal });
        } else await done;
    };
    const interrupt = (): void => { void stop('SIGINT'); };
    const terminate = (): void => { void stop('SIGTERM'); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    options.onEvent({ type: 'watching', path: source });
    running = poll();
    return { done, stop: () => stop() };
}
