import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newUUID } from '@kelpi/core/codec';
import { PluginEventBuffer, decodePluginManifest, pluginAssetPath, pluginDependencyOrder, pluginDependencyProblem, pluginJSON, pluginObject, pluginRecord, patchPluginContributionState, pluginSettingValue, type JsonObject, type JsonValue, type PluginContext, type PluginEvent, type PluginInfo, type PluginManifest, type PluginContributionState, type PluginContributionInfo } from '@kelpi/protocol';
import type { ReplyHandle, PtyManager, TerminalStateService } from '../seams.js';
import type { KelpiStore } from '../store/store.js';
import { serializeState, serializeDomainEvents } from '../ws/serialize.js';
import { inOperationScope, operationScope, type PluginOperationChannel, type PluginOperationScope, type PluginOperationSource } from './operations.js';
import type { BuiltinPluginService, BuiltinServiceHost } from './builtin-services.js';
import { createFilesService } from './files-service.js';
import { createProcessService } from './process-service.js';

interface Installation { manifest: PluginManifest; revision: string; enabled: boolean }
interface PendingCall { resolve(value: JsonValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; scope: PluginOperationScope }
interface Running {
    process: ChildProcess; ready: Promise<void>; pending: Map<string, PendingCall>;
    queue: PluginEventBuffer; sending: boolean; activated: boolean; stopping: boolean;
    fail(error: Error): void;
}
export interface PluginServiceOptions {
    readonly directory?: string;
    readonly pty?: PtyManager;
    readonly term?: TerminalStateService;
    readonly store: KelpiStore;
    readonly runner?: string;
    /** Current owning-daemon CLI route; read again for every managed process launch. */
    readonly cliEnvironment?: () => Readonly<Record<string, string>>;
    readonly command: (payload: JsonObject, context: PluginContext, signal: AbortSignal) => Promise<JsonObject>;
    readonly broadcast: (event: JsonObject) => void;
    readonly onError?: (error: Error) => void;
    readonly applicationSettings?: () => JsonObject;
}
export interface PluginChannel extends Partial<PluginOperationChannel> {
    run(action: string, input: JsonObject, reply: ReplyHandle, context?: Partial<PluginContext>): void;
    releaseClient?(clientID: string): void;
    observe?(event: JsonObject): void;
}

const contributionEventName = 'plugin.contributions.changed';
const failure = (error: unknown): string => error instanceof Error ? error.message : String(error);
function text(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value || value.length > 8192) throw new Error(`missing or invalid ${field}`);
    return value;
}

/** Per-daemon installation registry and supervisor. No plugin code runs on the daemon loop. */
export class PluginService implements PluginChannel, PluginOperationChannel, BuiltinServiceHost {
    readonly epoch = randomUUID();
    readonly daemonID: string;
    readonly directory: string;
    private readonly temporary: boolean;
    private readonly installations = new Map<string, Installation>();
    private readonly running = new Map<string, Running>();
    private readonly generations = new Map<string, number>();
    private readonly errors = new Map<string, string>();
    private readonly watchers = new Set<(event: PluginEvent) => void>();
    private readonly logs = new Map<string, string[]>();
    private readonly leases = new Map<string, { pluginID: string; revision: string; context: PluginContext; expires: number }>();
    private readonly operations = new Map<string, Set<AbortController>>();
    private readonly leaseOperations = new Map<string, Set<AbortController>>();
    private readonly terminalSubs = new Map<string, { pluginID: string; paneID: string; lease?: string }>();
    private readonly watcherReplies = new Set<ReplyHandle>();
    private readonly serviceSelections = new Map<string, string>();
    private readonly contributionStates = new Map<string, { readonly state: PluginContributionState; readonly sequence: number }>();
    private readonly builtinServices = new Map<string, BuiltinPluginService>();
    private readonly serviceListeners = new Set<(changed: readonly string[]) => void>();
    private serviceIdentities = new Map<string, string>();
    private readonly changing = new Set<string>();
    private readonly offPty: (() => void) | undefined;
    private registryError: string | null = null;
    private mutation: Promise<unknown> = Promise.resolve();
    private sequence = 0;
    private closed = false;
    private started = false;
    private readonly offStore: () => void;

    constructor(private readonly options: PluginServiceOptions) {
        this.temporary = options.directory === undefined;
        this.directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-plugins-'));
        this.daemonID = randomUUID();
        try {
            fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            const identityPath = path.join(this.directory, 'identity');
            try {
                const identity = fs.readFileSync(identityPath, 'utf8').trim();
                if (!/^[a-f0-9-]{36}$/.test(identity)) throw new Error('invalid plugin daemon identity');
                this.daemonID = identity;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                fs.writeFileSync(identityPath, this.daemonID, { flag: 'wx', mode: 0o600 });
            }
            const raw: unknown = JSON.parse(fs.readFileSync(path.join(this.directory, 'installed.json'), 'utf8'));
            if (!Array.isArray(raw) || raw.length > 100) throw new Error('invalid plugin installation registry');
            for (const record of raw) {
                if (!pluginRecord(record) || typeof record['revision'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['revision'])) throw new Error('invalid installed plugin');
                const manifest = decodePluginManifest(record['manifest']);
                this.installations.set(manifest.id, { manifest, revision: record['revision'], enabled: record['enabled'] === true });
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.installations.clear(); this.registryError = `Plugin registry: ${failure(error)}`; options.onError?.(new Error(this.registryError)); }
        }
        try {
            const selections = pluginObject(JSON.parse(fs.readFileSync(path.join(this.directory, 'services.json'), 'utf8')));
            for (const [key, provider] of Object.entries(selections)) {
                if (typeof provider !== 'string' || !/^[a-z][a-z0-9.-]*@[1-9]\d*$/.test(key)) throw new Error('invalid service provider selection');
                this.serviceSelections.set(key, provider);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.registryError = `Plugin services registry: ${failure(error)}`; options.onError?.(new Error(this.registryError)); }
        }
        this.offStore = options.store.subscribe(events => {
            if (this.closed) return;
            const sequence = ++this.sequence;
            // Reserve ordering synchronously, but do serialization and IPC outside dispatch.
            queueMicrotask(() => { if (!this.closed) this.publish({ epoch: this.epoch, sequence, name: 'state.changed', data: serializeDomainEvents(events) }); });
        });
        this.offPty = options.pty?.onData((paneID, data) => {
            for (const [subscription, sub] of this.terminalSubs) if (sub.paneID === paneID) {
                // Bound one output event independently of the PTY manager's read size.
                for (let offset = 0; offset < data.length; offset += 16_384) this.emit('terminal.output', { subscription, paneID, base64: Buffer.from(data.subarray(offset, offset + 16_384)).toString('base64') }, sub.pluginID);
            }
        });
        this.registerBuiltinService(createFilesService());
        this.registerBuiltinService(createProcessService({ homeDirectory: () => options.store.getState().homeDirectory, cliEnvironment: () => this.cliEnvironment() }));
    }

    list(): PluginInfo[] {
        return [...this.installations.values()].map(item => {
            const error = this.errors.get(item.manifest.id) ?? this.dependencyProblem(item.manifest.id);
            return { ...item, instanceID: `${this.epoch}:${this.generations.get(item.manifest.id) ?? 0}`, status: !item.enabled ? 'disabled' : error ? 'failed' : this.running.has(item.manifest.id) ? (this.running.get(item.manifest.id)!.activated ? 'running' : 'starting') : 'inactive', error };
        });
    }
    private dependencyProblem(id: string): string | null {
        return pluginDependencyProblem(id, [...this.installations.values()].map(item => ({ ...item, enabled: item.enabled && !this.changing.has(item.manifest.id), ...(this.errors.has(item.manifest.id) ? { status: 'failed', error: this.errors.get(item.manifest.id)! } : {}) })));
    }
    private startEligible(): void {
        for (const item of this.installations.values()) if (item.enabled && item.manifest.activation === 'startup' && !this.dependencyProblem(item.manifest.id) && !this.errors.has(item.manifest.id)) void this.activate(item.manifest.id).catch(() => {});
    }
    private finishChange(id: string): void {
        this.changing.delete(id);
        // A transition-time attach can fail before the backend is ready. A fresh instance
        // identity makes every host retry once the completed lifecycle transaction publishes.
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
        this.changed();
        // Activation may publish before the transaction advances its final instance ID.
        // Re-publish that complete state against the now-current generation.
        this.publishContributions(id);
        if (!this.installations.has(id)) this.contributionStates.delete(id);
        this.startEligible();
    }
    start(): void {
        if (this.started || this.closed) return;
        this.started = true;
        this.startEligible();
    }
    private changed(): void {
        this.options.broadcast({ type: 'plugins-changed', plugins: this.list() as unknown as JsonValue, epoch: this.epoch, daemonID: this.daemonID });
        this.notifyServicesChanged();
    }
    private contributionInfo(id: string): PluginContributionInfo {
        const current = this.contributionStates.get(id);
        return { pluginID: id, instanceID: `${this.epoch}:${this.generations.get(id) ?? 0}`, sequence: current?.sequence ?? 0,
            state: current?.state ?? { context: {}, items: {} } };
    }
    private publishContributions(id: string, state: PluginContributionState = this.contributionStates.get(id)?.state ?? { context: {}, items: {} }): void {
        this.contributionStates.set(id, { state, sequence: this.sequence + 1 });
        this.emit(contributionEventName, pluginJSON(this.contributionInfo(id)), id);
    }
    /** Complete, ordered snapshots of available plugins; never persists author UI state. */
    contributions(): PluginContributionInfo[] {
        return this.list().filter(plugin => plugin.enabled && plugin.status !== 'failed' && !this.changing.has(plugin.manifest.id))
            .map(plugin => pluginJSON(this.contributionInfo(plugin.manifest.id)) as unknown as PluginContributionInfo);
    }
    private persist(): void { if (this.registryError) throw new Error(this.registryError); this.writeJSON(path.join(this.directory, 'installed.json'), [...this.installations.values()]); }
    private writeJSON(file: string, value: unknown): void {
        const temporary = `${file}.${randomUUID()}.tmp`;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file); }
        finally { fs.rmSync(temporary, { force: true }); }
    }
    private item(id: string): Installation {
        const item = this.installations.get(id);
        if (!item) throw new Error(`plugin not installed: ${id}`);
        return item;
    }
    packagePath(id: string, revision?: string): string {
        const item = this.item(id);
        if (revision !== undefined && revision !== item.revision) throw new Error('plugin version changed; reload this view');
        return path.join(this.directory, 'packages', id, item.revision);
    }
    asset(id: string, revision: string, relative: string): string {
        const item = this.item(id);
        if (!item.enabled) throw new Error('plugin is disabled');
        const root = fs.realpathSync(this.packagePath(id, revision));
        const result = fs.realpathSync(path.join(root, pluginAssetPath(relative)));
        if (!result.startsWith(root + path.sep) || !fs.statSync(result).isFile()) throw new Error('invalid plugin asset');
        return result;
    }
    private mutate<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutation.then(() => { if (this.closed) throw new Error('plugin service is stopped'); return operation(); });
        this.mutation = result.catch(() => {}); return result;
    }
    install(source: string, trusted: boolean): Promise<PluginInfo[]> { return this.mutate(() => this.installNow(source, trusted)); }
    private async installNow(source: string, trusted: boolean): Promise<PluginInfo[]> {
        if (!trusted) throw new Error('Installation executes code with your account access. Pass --trust to install this plugin.');
        const root = await fs.promises.realpath(source);
        if (this.registryError) throw new Error(this.registryError);
        const files: Array<{ relative: string; bytes: Buffer }> = [];
        let total = 0;
        const hash = createHash('sha256');
        const scan = async (relative: string): Promise<void> => {
            const entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (entry.name === '.git' || entry.name === 'node_modules') continue;
                const name = relative ? `${relative}/${entry.name}` : entry.name;
                pluginAssetPath(name);
                if (entry.isSymbolicLink()) throw new Error(`plugin packages cannot contain symlinks: ${name}`);
                if (entry.isDirectory()) { await scan(name); continue; }
                if (!entry.isFile()) throw new Error(`unsupported plugin file: ${name}`);
                if (files.length >= 2000) throw new Error('plugin package has too many files');
                const handle = await fs.promises.open(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                let bytes: Buffer;
                try {
                    const stat = await handle.stat();
                    if (!stat.isFile() || total + stat.size > 32 * 1024 * 1024) throw new Error('plugin package exceeds 32 MiB');
                    bytes = await handle.readFile();
                    total += bytes.length;
                    if (total > 32 * 1024 * 1024) throw new Error('plugin package exceeds 32 MiB');
                } finally { await handle.close(); }
                hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
                files.push({ relative: name, bytes });
            }
        };
        await scan('');
        const manifestFile = files.find(file => file.relative === 'kelpi.plugin.json');
        if (!manifestFile) throw new Error('missing kelpi.plugin.json');
        const manifest = decodePluginManifest(JSON.parse(manifestFile.bytes.toString('utf8')));
        if (!this.installations.has(manifest.id) && this.installations.size >= 100) throw new Error('at most 100 plugins can be installed');
        const claims = (manifest: PluginManifest): string[] => [manifest.id, ...manifest.contributes.views.map(entry => entry.id), ...manifest.contributes.commands.map(entry => entry.id),
            ...(manifest.contributes.containers ?? []).flatMap(entry => [entry.id, ...entry.slots.map(slot => slot.id)]),
            ...(manifest.contributes.hooks ?? []).map(entry => entry.id), ...(manifest.contributes.services ?? []).map(entry => entry.id), ...(manifest.contributes.providers ?? []).map(entry => entry.id),
            ...(manifest.contributes.menus ?? []).map(entry => entry.id), ...(manifest.contributes.items ?? []).map(entry => entry.id), ...(manifest.contributes.settingGroups ?? []).map(entry => entry.id)];
        const incoming = new Set(claims(manifest));
        for (const installed of this.installations.values()) if (installed.manifest.id !== manifest.id) {
            const collision = claims(installed.manifest).find(id => incoming.has(id));
            if (collision) throw new Error(`plugin contribution ${collision} is already owned by ${installed.manifest.id}`);
        }
        for (const entry of [...manifest.contributes.views.map(view => view.entry), ...(manifest.backend ? [manifest.backend] : [])]) if (!files.some(file => file.relative === entry)) throw new Error(`missing plugin entry: ${entry}`);
        const revision = hash.digest('hex');
        const target = path.join(this.directory, 'packages', manifest.id, revision);
        if (!fs.existsSync(target)) {
            const staging = `${target}.${randomUUID()}.tmp`;
            try {
                for (const file of files) { const destination = path.join(staging, file.relative); await fs.promises.mkdir(path.dirname(destination), { recursive: true }); await fs.promises.writeFile(destination, file.bytes); }
                await fs.promises.rename(staging, target);
            } finally { await fs.promises.rm(staging, { recursive: true, force: true }); }
        }
        this.changing.add(manifest.id);
        try {
            await this.stopPlugin(manifest.id);
            const previous = this.installations.get(manifest.id);
            this.installations.set(manifest.id, { manifest, revision, enabled: true });
            try { this.persist(); } catch (error) { if (previous) this.installations.set(manifest.id, previous); else this.installations.delete(manifest.id); throw error; }
            this.errors.delete(manifest.id); this.changed();
            if (manifest.activation === 'startup') await this.activate(manifest.id, true);
        } finally { this.finishChange(manifest.id); }
        return this.list();
    }
    private log(id: string, text: string): void {
        const rows = this.logs.get(id) ?? [];
        rows.push(text.slice(0, 4096)); while (rows.length > 200) rows.shift(); this.logs.set(id, rows);
    }
    private cliEnvironment(): Record<string, string> {
        // An absent route must fail closed, never send a plugin's CLI call to /tmp/kelpi.sock.
        return { KELPI_SOCKET: '', ...this.options.cliEnvironment?.(), KELPI_REQUIRE_SOCKET: '1' };
    }
    private async activate(id: string, allowChanging = false): Promise<void> {
        if (this.closed) throw new Error('plugin service is stopped');
        if (this.changing.has(id) && !allowChanging) throw new Error('plugin is changing; retry the operation');
        if (!this.item(id).enabled) throw new Error('plugin is disabled');
        if (this.errors.has(id)) throw new Error(`plugin failed; reload it: ${this.errors.get(id)}`);
        const problem = this.dependencyProblem(id);
        if (problem) throw new Error(problem);
        const order = pluginDependencyOrder([...this.installations.values()].filter(item => item.enabled && !this.errors.has(item.manifest.id)).map(item => item.manifest), [id]);
        for (const item of order) {
            const problem = this.dependencyProblem(item.id);
            if (problem) {
                if (item.id === id || this.dependencyProblem(id)) throw new Error(problem);
                continue; // An optional dependency became unavailable while activating.
            }
            try { await this.activateOne(item.id, allowChanging && item.id === id); }
            catch (error) { if (item.id === id || this.dependencyProblem(id)) throw error; }
        }
    }
    private async activateOne(id: string, allowChanging = false): Promise<void> {
        if (this.closed) throw new Error('plugin service is stopped');
        if (this.changing.has(id) && !allowChanging) throw new Error('plugin is changing; retry the operation');
        const item = this.item(id);
        if (!item.enabled) throw new Error('plugin is disabled');
        const error = this.errors.get(id); if (error) throw new Error(`plugin failed; reload it: ${error}`);
        const existing = this.running.get(id); if (existing) return existing.ready;
        if (!item.manifest.backend) return;
        const root = this.packagePath(id);
        // Resolve the entry again so a modified on-disk package cannot redirect through a link.
        this.asset(id, item.revision, item.manifest.backend);
        const runner = this.options.runner ?? fileURLToPath(new URL('./runner.mjs', import.meta.url));
        const child = fork(runner, [root, item.manifest.backend], { cwd: root, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env['PATH'] ?? '', LANG: process.env['LANG'] ?? 'en_US.UTF-8', ...this.cliEnvironment(), KELPI_PLUGIN_ID: id } });
        let resolveReady!: () => void; let rejectReady!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        // Attach immediately: a startup failure without an awaiting view must never be unhandled.
        void ready.catch(() => {});
        const runtime: Running = { process: child, ready, pending: new Map(), queue: new PluginEventBuffer(), sending: false, activated: false, stopping: false, fail: error => fail(error) };
        this.running.set(id, runtime);
        const timer = setTimeout(() => fail(new Error('plugin activation timed out')), 10_000);
        const fail = (error: Error): void => {
            clearTimeout(timer); rejectReady(error);
            for (const call of runtime.pending.values()) { clearTimeout(call.timer); call.reject(error); }
            runtime.pending.clear();
            if (this.running.get(id) !== runtime) return;
            this.running.delete(id);
            if (!runtime.stopping) { this.generations.set(id, (this.generations.get(id) ?? 0) + 1); this.errors.set(id, error.message); this.log(id, error.message); }
            this.publishContributions(id, { context: {}, items: {} });
            if (!runtime.stopping) void this.stopDependents(id);
            for (const operation of this.operations.get(id) ?? []) operation.abort();
            this.operations.delete(id);
            for (const [key, lease] of this.leases) if (lease.pluginID === id) this.release(key);
            for (const [key, sub] of this.terminalSubs) if (sub.pluginID === id) this.terminalSubs.delete(key);
            child.kill('SIGKILL'); this.changed();
        };
        child.stdout?.on('data', data => this.log(id, String(data)));
        child.stderr?.on('data', data => this.log(id, String(data)));
        child.on('error', fail);
        child.on('exit', (code, signal) => fail(new Error(`plugin exited (${signal ?? code ?? 'unknown'})`)));
        let budget = 512, budgetAt = Date.now();
        child.on('message', message => {
            if (Date.now() - budgetAt >= 1000) { budget = 512; budgetAt = Date.now(); }
            if (--budget < 0) { fail(new Error('plugin exceeded the IPC message rate limit')); return; }
            if (!pluginRecord(message) || this.running.get(id) !== runtime) return;
            if (message['type'] === 'ready') {
                for (const [kind, declared] of [
                    ['commands', item.manifest.contributes.commands.map(entry => entry.id)],
                    ['hooks', (item.manifest.contributes.hooks ?? []).map(entry => entry.id)],
                    ['providers', (item.manifest.contributes.providers ?? []).map(entry => entry.id)]
                ] as const) {
                    const registered = message[kind] ?? [];
                    if (!Array.isArray(registered) || declared.length !== registered.length || new Set(registered).size !== registered.length || registered.some(entry => !declared.includes(entry))) { fail(new Error(`backend ${kind} registrations do not match the manifest`)); return; }
                }
                const methods = message['providerMethods'];
                for (const provider of item.manifest.contributes.providers ?? []) {
                    const registered = pluginRecord(methods) ? methods[provider.id] : undefined;
                    if (!Array.isArray(registered) || provider.methods.length !== registered.length || registered.some(method => !provider.methods.includes(method))) { fail(new Error(`backend provider methods do not match the manifest: ${provider.id}`)); return; }
                }
                clearTimeout(timer); runtime.activated = true; resolveReady(); this.changed();
            } else if (message['type'] === 'failed') fail(new Error(String(message['error'])));
            else if (message['type'] === 'event-ack') { runtime.sending = false; this.drain(runtime); }
            else if (message['type'] === 'result') {
                const call = runtime.pending.get(String(message['id'])); if (!call) return;
                runtime.pending.delete(String(message['id'])); clearTimeout(call.timer);
                if (typeof message['error'] === 'string') { call.reject(new Error(message['error'] || 'plugin invocation failed')); return; }
                try { call.resolve(pluginJSON(message['result'] ?? null)); }
                catch (cause) {
                    const error = new Error(`invalid plugin result: ${failure(cause)}`);
                    call.reject(error); runtime.fail(error);
                }
            } else if (message['type'] === 'call') {
                const callID = String(message['id']);
                if (runtime.stopping) { if (child.connected) child.send({ type: 'reply', id: callID, error: 'plugin is stopping' }, () => {}); return; }
                const parentCallID = message['parentCallID'];
                const parentCall = typeof parentCallID === 'string' ? runtime.pending.get(parentCallID) : undefined;
                if (parentCallID !== undefined && !parentCall) { if (child.connected) child.send({ type: 'reply', id: callID, error: 'plugin invocation has expired' }, () => {}); return; }
                const scope = { ...(parentCall?.scope ?? { trace: [] }), source: 'plugin' as const, handled: false };
                void inOperationScope(scope, () => this.api(id, String(message['method']), message['args'], { ...this.context(message['context']), daemonID: this.daemonID })).then(result => {
                    if (child.connected) child.send({ type: 'reply', id: callID, result }, () => {});
                }, error => { if (child.connected) child.send({ type: 'reply', id: callID, error: failure(error) }, () => {}); });
            }
        });
        this.changed(); return ready;
    }
    private drain(runtime: Running): void {
        if (runtime.sending || runtime.stopping || !runtime.process.connected) return;
        const event = runtime.queue.shift(); if (!event) return;
        runtime.sending = true;
        runtime.process.send({ type: 'event', event }, error => { if (error) runtime.sending = false; });
    }
    private emit(name: string, data: JsonValue, pluginID?: string): PluginEvent {
        const event: PluginEvent = { epoch: this.epoch, sequence: ++this.sequence, name, data, ...(pluginID ? { pluginID } : {}) };
        // All sources share one ordered queue, including events emitted inside a command.
        queueMicrotask(() => { if (!this.closed) this.publish(event); });
        return event;
    }
    private publish(event: PluginEvent): void {
        for (const watcher of [...this.watchers]) { try { watcher(event); } catch { this.watchers.delete(watcher); } }
        this.options.broadcast({ type: 'plugin-event', event: event as unknown as JsonValue });
        for (const runtime of this.running.values()) {
            runtime.queue.push(event); this.drain(runtime);
        }
    }
    private context(raw: unknown): Partial<PluginContext> {
        if (!pluginRecord(raw)) return {};
        return Object.fromEntries(['clientID', 'windowID', 'workspaceID', 'paneID', 'viewID'].filter(key => typeof raw[key] === 'string' && (raw[key] as string).length < 200).map(key => [key, raw[key]]));
    }
    viewAsset(leaseID: string, relative: string): string {
        const lease = this.leases.get(leaseID);
        if (!lease || lease.expires < Date.now() || !relative.startsWith('ui/')) throw new Error('plugin view expired');
        return this.asset(lease.pluginID, lease.revision, relative);
    }
    private release(leaseID: string): void {
        this.leases.delete(leaseID);
        for (const operation of this.leaseOperations.get(leaseID) ?? []) operation.abort();
        this.leaseOperations.delete(leaseID);
        for (const [id, sub] of this.terminalSubs) if (sub.lease === leaseID) this.terminalSubs.delete(id);
    }
    private async operation<T>(id: string, lease: string | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const operations = this.operations.get(id) ?? new Set<AbortController>();
        if (operations.size >= 64) throw new Error('too many concurrent plugin operations');
        if (lease && !this.leases.has(lease)) throw new Error('plugin view access expired');
        const controller = new AbortController();
        const parent = operationScope().signal;
        const abort = (): void => controller.abort();
        if (parent?.aborted) controller.abort(); else parent?.addEventListener('abort', abort, { once: true });
        operations.add(controller); this.operations.set(id, operations);
        const owned = lease ? (this.leaseOperations.get(lease) ?? new Set<AbortController>()) : undefined;
        if (owned && lease) { owned.add(controller); this.leaseOperations.set(lease, owned); }
        try { return await run(controller.signal); }
        finally { operations.delete(controller); owned?.delete(controller); parent?.removeEventListener('abort', abort); }
    }
    private storage(id: string, kind: string): JsonObject {
        this.item(id);
        try { return pluginObject(JSON.parse(fs.readFileSync(path.join(this.directory, 'data', id, `${kind}.json`), 'utf8'))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    }
    /** Compose native adapters before start; plugin manifests cannot replace these contracts. */
    registerBuiltinService(service: BuiltinPluginService): void {
        if (this.started || this.closed) throw new Error('built-in services must be registered before start');
        const key = `${service.id}@${service.version}`;
        if (!/^kelpi\.[a-z][a-z0-9.-]*$/.test(service.id) || !Number.isSafeInteger(service.version) || service.version < 1 || !Object.keys(service.methods).length) throw new Error('invalid built-in service contract');
        if (this.builtinServices.has(key)) throw new Error(`built-in service is already registered: ${key}`);
        this.builtinServices.set(key, service);
        this.notifyServicesChanged(false, false);
    }
    /** Changes reflect the effective implementation, including reloads of the same provider. */
    onServicesChanged(listener: (changed: readonly string[]) => void): () => void {
        this.serviceListeners.add(listener);
        return () => { this.serviceListeners.delete(listener); };
    }
    private notifyServicesChanged(force = false, publish = true): void {
        if (this.closed) return;
        const services = this.services();
        const identities = new Map(services.map(service => {
            const provider = (service['providers'] as JsonObject[]).find(provider => provider['id'] === service['activeProviderID']);
            const pluginID = provider?.['pluginID'];
            const identity = typeof pluginID === 'string' ? [service['activeProviderID'], this.installations.get(pluginID)?.revision, this.generations.get(pluginID) ?? 0] : [service['activeProviderID']];
            return [`${service['id']}@${service['version']}`, JSON.stringify(identity)];
        }));
        const changed = [...new Set([...this.serviceIdentities.keys(), ...identities.keys()])].filter(key => this.serviceIdentities.get(key) !== identities.get(key));
        this.serviceIdentities = identities;
        if (!publish) return;
        if (changed.length || force) this.emit('services.changed', services);
        if (changed.length) this.emit('services.invalidated', changed);
        if (changed.length) for (const listener of this.serviceListeners) {
            try { listener(changed); } catch (error) { this.options.onError?.(new Error(`service change listener: ${failure(error)}`)); }
        }
    }
    hasSelectedProvider(id: string, version: number): boolean {
        if (this.closed) return false;
        const selected = this.serviceSelections.get(`${id}@${version}`);
        if (!selected || selected === `${id}.bundled`) return false;
        const service = this.services().find(service => service['id'] === id && service['version'] === version);
        return service?.['activeProviderID'] === selected;
    }
    private serviceDefinitions() {
        return [
            ...[...this.builtinServices.values()].map(service => ({ id: service.id, title: service.title, version: service.version, methods: Object.keys(service.methods), pluginID: undefined as string | undefined })),
            ...[...this.installations.values()].flatMap(item => (item.manifest.contributes.services ?? []).map(service => ({ ...service, pluginID: item.manifest.id })))
        ];
    }
    services(): JsonObject[] {
        return this.serviceDefinitions().map(service => {
            const bundled = this.builtinServices.has(`${service.id}@${service.version}`) ? `${service.id}.bundled` : null;
            const providers: JsonObject[] = bundled ? [{ id: bundled, title: `Bundled ${service.title.toLowerCase()}`, status: 'available' }] : [];
            for (const item of this.installations.values()) for (const provider of item.manifest.contributes.providers ?? []) {
                if (provider.service !== service.id || provider.version !== service.version) continue;
                const incomplete = service.methods.some(method => !provider.methods.includes(method));
                const serviceDisabled = service.pluginID && (!this.installations.get(service.pluginID)?.enabled || this.changing.has(service.pluginID));
                const error = incomplete ? 'provider does not implement every service method' : this.errors.get(item.manifest.id) ?? this.dependencyProblem(item.manifest.id) ?? (service.pluginID ? this.errors.get(service.pluginID) ?? this.dependencyProblem(service.pluginID) : null);
                providers.push({ id: provider.id, title: provider.title, pluginID: item.manifest.id, status: !item.enabled || this.changing.has(item.manifest.id) || serviceDisabled ? 'disabled' : error ? 'failed' : 'available', ...(error ? { error } : {}) });
            }
            providers.sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
            const selectedProviderID = this.serviceSelections.get(`${service.id}@${service.version}`) ?? null;
            const activeProviderID = selectedProviderID && providers.some(provider => provider['id'] === selectedProviderID && provider['status'] === 'available') ? selectedProviderID : bundled;
            return { id: service.id, title: service.title, version: service.version, methods: [...service.methods], selectedProviderID, activeProviderID, providers };
        });
    }
    private selectService(args: JsonObject): JsonValue {
        if (this.registryError) throw new Error(this.registryError);
        const service = this.resolveService(args);
        const providerID = args['providerID'] ?? args['provider'] ?? null;
        if (providerID !== null && (typeof providerID !== 'string' || !(service['providers'] as JsonObject[]).some(provider => provider['id'] === providerID && provider['status'] === 'available'))) throw new Error('service provider is unavailable');
        const key = `${service['id']}@${service['version']}`;
        const next = new Map(this.serviceSelections);
        if (providerID === null) next.delete(key); else next.set(key, providerID);
        this.writeJSON(path.join(this.directory, 'services.json'), Object.fromEntries(next));
        this.serviceSelections.clear(); for (const [key, value] of next) this.serviceSelections.set(key, value);
        this.notifyServicesChanged(true);
        return this.services();
    }
    private resolveService(args: JsonObject): JsonObject {
        const serviceID = text(args['service'], 'service');
        const version = args['version'];
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new Error('service version must be a positive integer');
        const service = this.services().find(service => service['id'] === serviceID && service['version'] === version);
        if (!service) throw new Error(`service is unavailable: ${serviceID}@${version}`);
        return service;
    }
    async callService(input: JsonObject, context: PluginContext = { daemonID: this.daemonID }, signal = operationScope().signal): Promise<JsonValue> {
        if (this.closed) throw new Error('plugin service is stopped');
        if (signal?.aborted) throw new Error('plugin service call cancelled');
        const service = this.resolveService(input);
        const method = text(input['method'], 'method');
        if (!(service['methods'] as string[]).includes(method)) throw new Error(`unknown service method: ${method}`);
        const args = pluginObject(input['args'] ?? {});
        const builtin = this.builtinServices.get(`${service['id']}@${service['version']}`);
        const adapter = builtin?.methods[method];
        adapter?.validateArgs(args);
        const explicit = input['provider'] === 'bundled' && builtin ? `${builtin.id}.bundled` : input['provider'];
        const providerID = explicit ?? service['activeProviderID'];
        if (typeof providerID !== 'string' || !(service['providers'] as JsonObject[]).some(provider => provider['id'] === providerID && provider['status'] === 'available')) throw new Error(`service provider is unavailable: ${providerID ?? service['id']}`);
        if (builtin && adapter && providerID === `${builtin.id}.bundled`) {
            const result = pluginJSON(await adapter.run(args, context, signal));
            if (signal?.aborted) throw new Error('plugin service call cancelled');
            adapter.validateResult(result);
            return result;
        }
        const item = [...this.installations.values()].find(item => item.manifest.contributes.providers?.some(provider => provider.id === providerID));
        const provider = item?.manifest.contributes.providers?.find(provider => provider.id === providerID);
        if (!item || !provider) throw new Error('service provider is unavailable');
        const owner = this.serviceDefinitions().find(definition => definition.id === service['id'] && definition.version === service['version'])?.pluginID;
        const ownerRevision = owner ? this.installations.get(owner)?.revision : undefined;
        const ownerGeneration = owner ? this.generations.get(owner) : undefined;
        const validate = (): void => {
            if (owner && (this.changing.has(owner) || this.installations.get(owner)?.revision !== ownerRevision || this.generations.get(owner) !== ownerGeneration)) throw new Error('service contract changed during invocation; retry the operation');
            const current = this.resolveService(input);
            if (!(current['providers'] as JsonObject[]).some(entry => entry['id'] === provider.id && entry['status'] === 'available')) throw new Error('service provider is no longer available');
        };
        const result = await this.invokeBackend(item.manifest.id, `provider:${provider.id}`, { type: 'service', provider: provider.id, method, args, context: { ...context } }, provider.timeoutMs ?? 5000, true, signal, validate);
        validate();
        try { adapter?.validateResult(result); }
        catch (cause) {
            const error = new Error(`invalid ${method} result from service provider ${provider.id}: ${failure(cause)}`);
            this.running.get(item.manifest.id)?.fail(error);
            throw error;
        }
        return result;
    }
    private operationHooks(command: string) {
        // Recovery and discovery must work even when a plugin has a broken policy hook.
        if (command === 'plugin' || command === 'ping') return [];
        const trace = operationScope().trace;
        return [...this.installations.values()].filter(item => item.enabled && !this.changing.has(item.manifest.id) && !this.errors.has(item.manifest.id) && !this.dependencyProblem(item.manifest.id))
            .flatMap(item => (item.manifest.contributes.hooks ?? []).filter(hook => hook.commands.includes(command) || hook.commands.includes('*')).map(hook => ({ pluginID: item.manifest.id, hook })))
            .filter(({ hook }) => !trace.includes(`hook:${hook.id}`))
            .sort((a, b) => (a.hook.priority ?? 0) - (b.hook.priority ?? 0) || a.pluginID.localeCompare(b.pluginID) || a.hook.id.localeCompare(b.hook.id));
    }
    hasOperationHooks(command: string): boolean {
        return !this.closed && !operationScope().handled && this.operationHooks(command).length > 0;
    }
    async interceptOperation(payload: JsonObject, context: Partial<PluginContext>, source: PluginOperationSource, run: () => Promise<JsonObject>): Promise<JsonObject> {
        const scope = operationScope();
        if (scope.handled) return run();
        const hooks = this.operationHooks(String(payload['command']));
        if (hooks.length === 0) return run();
        // Wire decoders represent omitted optional fields as undefined; JSON IPC omits them.
        const operation = pluginObject(JSON.parse(JSON.stringify({ id: randomUUID(), command: payload['command'], payload, context: { ...context, daemonID: this.daemonID }, source: scope.source ?? source })));
        const deadline = Date.now() + 5000;
        const complete = (result: JsonObject): void => {
            // Observers never delay or change the caller's completed result.
            void inOperationScope({ trace: scope.trace, ...(scope.source ? { source: scope.source } : {}) }, async () => {
                const afterDeadline = Date.now() + 5000;
                for (const { pluginID, hook } of hooks.filter(entry => entry.hook.phase === 'after')) {
                    if (!this.installations.get(pluginID)?.enabled || this.errors.has(pluginID)) continue;
                    try {
                        const remaining = afterDeadline - Date.now();
                        if (remaining <= 0) { this.log(pluginID, 'after hooks exceeded their 5000 ms budget'); break; }
                        await this.invokeBackend(pluginID, `hook:${hook.id}`, { type: 'hook', hook: hook.id, operation: { ...operation, phase: 'after', result } }, Math.min(hook.timeoutMs ?? 1000, remaining));
                    } catch (error) { this.log(pluginID, `after hook ${hook.id}: ${failure(error)}`); }
                }
            });
        };
        for (const { pluginID, hook } of hooks.filter(entry => entry.hook.phase === 'before')) {
            let decision: JsonValue;
            const generation = this.generations.get(pluginID);
            try {
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw new Error('before hooks exceeded their 5000 ms budget');
                decision = await this.invokeBackend(pluginID, `hook:${hook.id}`, { type: 'hook', hook: hook.id, operation: { ...operation, phase: 'before' } }, Math.min(hook.timeoutMs ?? 1000, remaining));
                if (!pluginRecord(decision) || typeof decision['allow'] !== 'boolean' || (decision['allow'] === false && (typeof decision['reason'] !== 'string' || !decision['reason'].trim()))) throw new Error('before hook must return { allow: true } or { allow: false, reason }');
            } catch (error) {
                if (scope.signal?.aborted) {
                    const result = { ok: false, error: 'plugin operation cancelled', code: 'PLUGIN_OPERATION_CANCELLED' };
                    complete(result); return result;
                }
                if (generation === this.generations.get(pluginID) && !this.changing.has(pluginID)) this.running.get(pluginID)?.fail(new Error(`hook ${hook.id} failed: ${failure(error)}`));
                const result = { ok: false, error: `plugin hook ${hook.id} failed: ${failure(error)}`, code: 'PLUGIN_HOOK_FAILED' };
                complete(result); return result;
            }
            if (pluginRecord(decision) && decision['allow'] === false) {
                const result = { ok: false, error: String(decision['reason']), code: 'PLUGIN_VETO', hookID: hook.id, pluginID };
                complete(result); return result;
            }
        }
        let result: JsonObject;
        try { result = await inOperationScope({ ...scope, handled: true, source: scope.source ?? source }, run); }
        catch (error) { result = { ok: false, error: failure(error) }; }
        complete(result); return result;
    }
    async api(id: string, method: string, raw: unknown, context: PluginContext, lease?: string): Promise<JsonValue> {
        const item = this.item(id);
        if (this.closed || !item.enabled) throw new Error('plugin is not enabled');
        const problem = this.dependencyProblem(id); if (problem) throw new Error(problem);
        const args = pluginObject(raw ?? {});
        if (method === 'contributions.get' || method === 'contributions.update') {
            if (this.errors.has(id)) throw new Error('plugin contributions are unavailable until reload');
            // Old activated backends cannot write during their replacement. A new backend
            // may seed state from activate() before its ready message completes the change.
            if (this.changing.has(id) && this.running.get(id)?.activated !== false) throw new Error('plugin is changing; retry the operation');
            if (operationScope().signal?.aborted) throw new Error('plugin invocation cancelled');
            if (lease) {
                const view = this.leases.get(lease);
                if (!view || view.pluginID !== id || view.revision !== item.revision || view.expires < Date.now()) throw new Error('plugin view access expired');
            }
            const current = this.contributionInfo(id).state;
            if (method === 'contributions.get') return pluginJSON(current);
            const next = patchPluginContributionState(item.manifest, current, args);
            if (JSON.stringify(current) !== JSON.stringify(next)) this.publishContributions(id, next);
            return pluginJSON(next);
        }
        if (method === 'state.snapshot') return { epoch: this.epoch, sequence: this.sequence, state: serializeState(this.options.store.getState()) };
        if (method === 'app.settings.get') {
            if (!this.options.applicationSettings) throw new Error('application settings are unavailable');
            return this.options.applicationSettings();
        }
        if (method === 'command') {
            const payload = pluginObject(args['payload']);
            if (payload['command'] === 'plugin') throw new Error('plugin administration cannot be invoked through the command API');
            if (payload['follow'] === true || payload['command'] === 'content-subscribe' || payload['command'] === 'web-console-subscribe') throw new Error('use events or terminal.watch for subscriptions');
            return this.operation(id, lease, signal => inOperationScope({ ...operationScope(), signal }, () => this.options.command(payload, { ...context, ...this.context(args['context']) }, signal)));
        }
        if (method === 'views.open') {
            const viewID = text(args['viewID'], 'viewID');
            const view = item.manifest.contributes.views.find(view => view.id === viewID && view.placements.includes('pane'));
            if (!view) throw new Error('plugin pane view is not registered');
            const state = this.options.store.getState();
            const workspaceID = text(args['workspaceID'] ?? context.workspaceID ?? state.lastActiveWorkspaceID, 'workspaceID');
            if (!state.workspaces.some(workspace => workspace.id === workspaceID)) throw new Error('workspace does not exist');
            const paneID = newUUID();
            this.options.store.dispatch({ type: 'create-plugin-pane', workspaceID, paneID, title: view.title, now: Date.now(), plugin: { pluginID: id, viewID, stateVersion: view.stateVersion, state: pluginObject(args['state'] ?? {}) } });
            this.options.broadcast({ type: 'reveal-pane', workspaceID, paneID, ...(context.windowID ? { windowID: context.windowID } : {}) });
            return { paneID, workspaceID };
        }
        if (method === 'views.setState') {
            const paneID = text(context.paneID ?? args['paneID'], 'paneID');
            const pane = this.options.store.getState().workspaces.flatMap(workspace => [...workspace.panes, ...workspace.parkedPanes]).find(pane => pane.id === paneID);
            if (pane?.plugin?.pluginID !== id) throw new Error('plugin does not own this pane');
            const version = item.manifest.contributes.views.find(view => view.id === pane.plugin!.viewID)?.stateVersion;
            if (!version) throw new Error('view is no longer registered');
            this.options.store.dispatch({ type: 'set-plugin-pane-state', paneID, plugin: { ...pane.plugin, stateVersion: version, state: pluginObject(args['state']) } });
            return { stateVersion: version };
        }
        if (method === 'storage.get') return this.storage(id, 'storage')[text(args['key'], 'key')] ?? null;
        if (method === 'storage.set') {
            const key = text(args['key'], 'key'); pluginObject({ [key]: args['value'] });
            const next = pluginObject({ ...this.storage(id, 'storage'), [key]: args['value'] });
            this.writeJSON(path.join(this.directory, 'data', id, 'storage.json'), next); return null;
        }
        if (method === 'settings.get') {
            const stored = this.storage(id, 'settings');
            return Object.fromEntries(Object.entries(item.manifest.contributes.settings).map(([key, setting]) => {
                // A new manifest can narrow choices/ranges. Retain the persisted file, but
                // expose its valid default until the user supplies a compatible value.
                try { return [key, pluginSettingValue(setting, stored[key])]; }
                catch { return [key, setting.default]; }
            })) as JsonObject;
        }
        if (method === 'settings.set') {
            const key = text(args['key'], 'key'); const setting = item.manifest.contributes.settings[key];
            if (!setting) throw new Error('invalid plugin setting');
            const value = pluginSettingValue(setting, args['value']);
            this.writeJSON(path.join(this.directory, 'data', id, 'settings.json'), pluginObject({ ...this.storage(id, 'settings'), [key]: value }));
            this.emit('settings.changed', { key, value }, id); return null;
        }
        if (method === 'events.emit') {
            const name = `${id}.${text(args['name'], 'event name')}`;
            // This host event also falls inside a valid plugin namespace.
            if (name === contributionEventName) throw new Error(`plugin event name is reserved: ${name}`);
            return this.emit(name, pluginJSON(args['data'] ?? null), id) as unknown as JsonValue;
        }
        if (method === 'commands.execute') return this.operation(id, lease, signal => inOperationScope({ ...operationScope(), signal }, () => this.invoke(text(args['command'], 'command'), pluginObject(args['args'] ?? {}), context)));
        if (method === 'services.list') return this.services();
        if (method === 'services.select') return this.selectService(args);
        if (method === 'services.call') return this.operation(id, lease, signal => this.callService(args, context, signal));
        if (method === 'files.read' || method === 'files.write') return this.operation(id, lease, signal => this.callService({ service: 'kelpi.files', version: 1, method: method.slice(6), args }, context, signal));
        if (method === 'ui.reveal') {
            const paneID = text(args['paneID'] ?? context.paneID, 'paneID');
            const workspace = this.options.store.getState().workspaces.find(workspace => workspace.panes.some(pane => pane.id === paneID));
            if (!workspace) throw new Error('pane does not exist');
            this.options.broadcast({ type: 'reveal-pane', workspaceID: workspace.id, paneID, ...(context.windowID ? { windowID: context.windowID } : {}) }); return null;
        }
        if (method === 'terminal.watch') {
            if (!this.options.pty || !this.options.term) throw new Error('terminal services unavailable');
            if (this.terminalSubs.size >= 128) throw new Error('too many terminal subscriptions');
            const paneID = text(args['paneID'] ?? context.paneID, 'paneID');
            if (!this.options.pty.has(paneID)) throw new Error('pane has no running terminal');
            const subscription = randomUUID();
            this.terminalSubs.set(subscription, { pluginID: id, paneID, ...(lease ? { lease } : {}) });
            const snapshot = this.options.term.snapshot(paneID);
            return { subscription, paneID, base64: Buffer.from(snapshot.data).toString('base64'), cols: snapshot.cols, rows: snapshot.rows };
        }
        if (method === 'terminal.unwatch') {
            const subscription = text(args['subscription'], 'subscription');
            if (this.terminalSubs.get(subscription)?.pluginID === id) this.terminalSubs.delete(subscription); return null;
        }
        if (method === 'process.exec') return this.operation(id, lease, signal => this.callService({ service: 'kelpi.process', version: 1, method: 'exec', args }, context, signal));
        throw new Error(`unknown plugin API method: ${method}`);
    }
    async invoke(command: string, args: JsonObject, context: PluginContext): Promise<JsonValue> {
        const item = [...this.installations.values()].find(item => item.manifest.contributes.commands.some(entry => entry.id === command));
        if (!item) throw new Error(`unknown plugin command: ${command}`);
        return this.invokeBackend(item.manifest.id, `command:${command}`, { type: 'invoke', command, args, context: { ...context } }, 30_000, false);
    }
    private async invokeBackend(pluginID: string, key: string, message: JsonObject, timeoutMs: number, failOnTimeout = true, signal = operationScope().signal, validate?: () => void): Promise<JsonValue> {
        if (signal?.aborted) throw new Error('plugin invocation cancelled');
        const envelope = pluginObject(message);
        const installation = this.item(pluginID);
        const generation = this.generations.get(pluginID);
        const parent = operationScope();
        if (parent.trace.includes(key)) throw new Error(`recursive plugin invocation: ${key}`);
        if (parent.trace.length >= 8) throw new Error('plugin invocation depth exceeds 8');
        const scope: PluginOperationScope = { trace: [...parent.trace, key], source: parent.source ?? 'plugin', ...(signal ? { signal } : {}) };
        const deadline = Date.now() + timeoutMs;
        let activationTimer: ReturnType<typeof setTimeout> | undefined;
        let cancelActivation: (() => void) | undefined;
        try {
            await Promise.race([
                this.activate(pluginID),
                new Promise<never>((_resolve, reject) => {
                    activationTimer = setTimeout(() => {
                        const error = new Error(`plugin activation exceeded ${timeoutMs} ms for ${key}`);
                        if (generation === this.generations.get(pluginID) && this.installations.get(pluginID)?.revision === installation.revision) this.running.get(pluginID)?.fail(error);
                        reject(error);
                    }, timeoutMs);
                }),
                ...(signal ? [new Promise<never>((_resolve, reject) => {
                    cancelActivation = () => reject(new Error('plugin invocation cancelled'));
                    if (signal.aborted) cancelActivation(); else signal.addEventListener('abort', cancelActivation, { once: true });
                })] : [])
            ]);
        } finally {
            clearTimeout(activationTimer);
            if (cancelActivation) signal?.removeEventListener('abort', cancelActivation);
        }
        if (signal?.aborted) throw new Error('plugin invocation cancelled');
        if (this.closed || !this.installations.get(pluginID)?.enabled || this.changing.has(pluginID) || generation !== this.generations.get(pluginID) || this.installations.get(pluginID)?.revision !== installation.revision) throw new Error('plugin changed during invocation; retry the operation');
        validate?.();
        const runtime = this.running.get(pluginID); if (!runtime || runtime.stopping) throw new Error('plugin backend is unavailable');
        if (runtime.pending.size >= 64) throw new Error('too many pending plugin calls');
        const id = randomUUID();
        return new Promise((resolveResult, rejectResult) => {
            const cleanup = (): void => { signal?.removeEventListener('abort', abort); };
            const resolve = (result: JsonValue): void => { cleanup(); resolveResult(result); };
            const reject = (error: Error): void => { cleanup(); rejectResult(error); };
            const abort = (): void => { clearTimeout(timer); runtime.pending.delete(id); reject(new Error('plugin invocation cancelled')); };
            const timer = setTimeout(() => {
                runtime.pending.delete(id);
                const error = new Error(`plugin invocation timed out: ${key}`);
                if (failOnTimeout) runtime.fail(error);
                reject(error);
            }, Math.max(1, deadline - Date.now()));
            runtime.pending.set(id, { resolve, reject, timer, scope });
            signal?.addEventListener('abort', abort, { once: true });
            runtime.process.send({ ...envelope, id }, error => { if (error) { clearTimeout(timer); runtime.pending.delete(id); reject(error); } });
        });
    }
    run(action: string, input: JsonObject, reply: ReplyHandle, caller: Partial<PluginContext> = {}): void {
        const context: PluginContext = { ...caller, daemonID: this.daemonID };
        if (action === 'watch') {
            const anchor = this.sequence;
            const watcher = (event: PluginEvent): void => { if (!reply.closed && event.sequence > anchor) reply.send({ ok: true, event }); };
            if (this.watchers.size >= 128) { reply.send({ ok: false, error: 'too many watchers' }); reply.close(); return; }
            this.watchers.add(watcher); this.watcherReplies.add(reply); reply.onDisconnect(() => { this.watchers.delete(watcher); this.watcherReplies.delete(reply); });
            reply.send({ ok: true, epoch: this.epoch, sequence: this.sequence, state: serializeState(this.options.store.getState()) }); return;
        }
        const controller = new AbortController();
        reply.onDisconnect(() => controller.abort());
        void inOperationScope({ ...operationScope(), signal: controller.signal }, () => this.request(action, input, context)).then(result => { if (reply.closed) { if (action === 'attach' && pluginRecord(result) && typeof result['lease'] === 'string') this.release(result['lease']); return; } reply.send({ ok: true, result }); reply.close(); }, error => { reply.send({ ok: false, error: failure(error) }); reply.close(); });
    }
    async request(action: string, input: JsonObject, context: PluginContext = { daemonID: this.daemonID }): Promise<JsonValue> {
        if (this.closed) throw new Error('plugin service is stopped');
        if (action === 'identity') return { daemonID: this.daemonID, epoch: this.epoch, apiVersion: 1 };
        if (action === 'list') { if (this.registryError) throw new Error(this.registryError); return this.list() as unknown as JsonValue; }
        if (action === 'contributions') return this.contributions() as unknown as JsonValue;
        if (action === 'services') return this.services();
        if (action === 'service-call') return this.callService(input, context);
        if (action === 'service-select') return this.selectService(input);
        if (action === 'install') return await this.install(text(input['path'], 'path'), input['trust'] === true) as unknown as JsonValue;
        if (action === 'run') return this.invoke(text(input['command'], 'command'), pluginObject(input['args'] ?? {}), { ...context, ...this.context(input) });
        if (action === 'api') {
            const lease = this.leases.get(text(input['lease'], 'lease'));
            if (!lease || lease.expires < Date.now() || this.item(lease.pluginID).revision !== lease.revision) throw new Error('plugin view access expired; reopen the view');
            if (lease.context.clientID && lease.context.clientID !== context.clientID) throw new Error('view belongs to another client');
            lease.expires = Date.now() + 24 * 60 * 60 * 1000;
            return this.api(lease.pluginID, text(input['method'], 'method'), input['args'], lease.context, input['lease'] as string);
        }
        if (action === 'release') { this.release(text(input['lease'], 'lease')); return null; }
        const id = text(input['pluginID'], 'pluginID'); const item = this.item(id);
        if (action === 'logs') return this.logs.get(id) ?? [];
        if (action === 'open') return this.api(id, 'views.open', input, context);
        if (action === 'settings') return this.api(id, input['key'] === undefined ? 'settings.get' : 'settings.set', input, context);
        if (action === 'attach') {
            if (!item.enabled) throw new Error('plugin is disabled');
            for (const [leaseID, lease] of this.leases) if (lease.expires < Date.now()) this.release(leaseID);
            if (this.leases.size >= 128) throw new Error('too many attached plugin views');
            const viewID = text(input['viewID'], 'viewID');
            if (!item.manifest.contributes.views.some(view => view.id === viewID)) throw new Error('plugin view is not registered');
            const paneID = typeof input['paneID'] === 'string' ? input['paneID'] : undefined;
            if (paneID) {
                const pane = this.options.store.getState().workspaces.flatMap(workspace => workspace.panes).find(pane => pane.id === paneID);
                if (pane?.plugin?.pluginID !== id || pane.plugin.viewID !== viewID) throw new Error('plugin view does not own this pane');
            }
            const generation = this.generations.get(id);
            await this.activate(id);
            if (this.closed || !this.item(id).enabled || this.item(id).revision !== item.revision || generation !== this.generations.get(id)) throw new Error('plugin changed while attaching; retry');
            if (this.leases.size >= 128) throw new Error('too many attached plugin views');
            const view = item.manifest.contributes.views.find(view => view.id === viewID)!;
            const htmlPath = this.asset(id, item.revision, view.entry);
            if (fs.statSync(htmlPath).size > 256 * 1024) throw new Error('view HTML exceeds 256 KiB');
            const html = fs.readFileSync(htmlPath, 'utf8');
            const lease = randomUUID();
            this.leases.set(lease, { pluginID: id, revision: item.revision, context: { daemonID: this.daemonID, ...(context.clientID ? { clientID: context.clientID } : {}), ...(context.windowID ? { windowID: context.windowID } : {}), viewID, ...(paneID ? { paneID } : {}), ...((input['workspaceID'] ?? context.workspaceID) ? { workspaceID: String(input['workspaceID'] ?? context.workspaceID) } : {}) }, expires: Date.now() + 24 * 60 * 60 * 1000 });
            const pane = paneID ? this.options.store.getState().workspaces.flatMap(workspace => workspace.panes).find(pane => pane.id === paneID) : undefined;
            return { lease, html, entry: view.entry, state: pane?.plugin?.state ?? {}, stateVersion: pane?.plugin?.stateVersion ?? view.stateVersion, context: this.leases.get(lease)!.context as unknown as JsonValue, revision: item.revision };
        }
        if (action === 'enable' || action === 'disable' || action === 'reload' || action === 'remove') return this.mutate(async () => {
            const item = this.item(id);
            this.changing.add(id);
            try {
                await this.stopPlugin(id); this.errors.delete(id);
                if (action === 'remove') this.installations.delete(id);
                else this.installations.set(id, { ...item, enabled: action !== 'disable' });
                try { this.persist(); } catch (error) { this.installations.set(id, item); this.changed(); throw error; }
                this.changed();
                if ((action === 'reload' || action === 'enable') && item.manifest.backend) await this.activate(id, true);
            } finally { this.finishChange(id); }
            return this.list() as unknown as JsonValue;
        });
        throw new Error(`unknown plugin action: ${action}`);
    }
    observe(event: JsonObject): void { if (event['type'] !== 'plugin-event' && event['type'] !== 'plugins-changed') this.emit(`daemon.${String(event['type'] ?? 'event')}`, event); }
    releaseClient(clientID: string): void { for (const [id, lease] of this.leases) if (lease.context.clientID === clientID) this.release(id); }
    private async stopDependents(id: string): Promise<void> {
        const dependents = new Set<string>();
        const order: string[] = [];
        const visit = (dependencyID: string): void => {
            for (const item of this.installations.values()) if (item.manifest.id !== id && !dependents.has(item.manifest.id) && item.manifest.dependencies?.some(dependency => dependency.pluginID === dependencyID && !dependency.optional)) {
                dependents.add(item.manifest.id); visit(item.manifest.id); order.push(item.manifest.id);
            }
        };
        visit(id);
        for (const dependent of order) await this.stopPlugin(dependent, false);
    }
    private async stopPlugin(id: string, cascade = true): Promise<void> {
        if (cascade) await this.stopDependents(id);
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
        this.publishContributions(id, { context: {}, items: {} });
        for (const [key, lease] of this.leases) if (lease.pluginID === id) this.release(key);
        for (const [key, sub] of this.terminalSubs) if (sub.pluginID === id) this.terminalSubs.delete(key);
        for (const operation of this.operations.get(id) ?? []) operation.abort(); this.operations.delete(id);
        const runtime = this.running.get(id); if (!runtime) return;
        runtime.stopping = true;
        for (const call of runtime.pending.values()) { clearTimeout(call.timer); call.reject(new Error('plugin stopped')); } runtime.pending.clear();
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => { runtime.process.kill('SIGKILL'); resolve(); }, 1000);
            runtime.process.once('exit', () => { clearTimeout(timer); resolve(); });
            if (runtime.process.connected) runtime.process.send({ type: 'stop' }, () => {}); else runtime.process.kill();
        });
        if (this.running.get(id) === runtime) this.running.delete(id);
    }
    async dispose(): Promise<void> {
        if (this.closed) return; this.closed = true; this.offStore(); this.offPty?.(); this.terminalSubs.clear(); for (const reply of this.watcherReplies) reply.close(); this.watcherReplies.clear(); this.watchers.clear(); this.serviceListeners.clear();
        for (const lease of this.leases.keys()) this.release(lease);
        for (const operations of this.operations.values()) for (const operation of operations) operation.abort();
        this.operations.clear();
        await this.mutation;
        await Promise.all([...this.running.keys()].map(id => this.stopPlugin(id)));
        this.contributionStates.clear();
        if (this.temporary) fs.rmSync(this.directory, { recursive: true, force: true });
    }
}
