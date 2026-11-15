/**
 * Attribution (docs/running-services.md §3): which workspace a listening process or a container
 * belongs to, and how the processes group into the stacks a person started.
 *
 * Pure. Two passes, because the second needs working directories the first decides to look up:
 *
 *   1. `planProcessStacks` walks each listener's parent chain up to a pane shell the daemon owns,
 *      finds the stack's root (the command that was started) and groups listeners by root.
 *   2. `buildServices` adds directories, owners and categories, and folds containers into compose
 *      projects.
 *
 * Signals, strongest first: the parent chain reaching a pane shell; the working directory inside
 * a workspace's folder; a compose project's working-directory label.
 */

import {
    agentOf,
    appBundleName,
    displayCommand,
    isExposedAddress,
    isInteractiveShell,
    isSessionManager,
    isShellCommandWrapper,
    programName
} from './parse.js';
import type {
    ContainerRow,
    ListenSocket,
    PaneShellRef,
    ProcessRow,
    RunningService,
    RunningServiceCategory,
    ServiceMember,
    ServicePort,
    WorkspaceFolders
} from './types.js';

/** Deepest parent chain walked; a real one is a dozen links. Guards a corrupt table's cycle. */
const MAX_CHAIN = 64;

export interface StackPlan {
    readonly rootPid: number;
    readonly listenerPids: readonly number[];
    /** The pane shell the chain reached, or null for a process started outside Kelpi's panes. */
    readonly paneShellPid: number | null;
    readonly agent: 'claude' | 'codex' | null;
    /** The listener is the agent itself (Claude Code's own local port). */
    readonly agentInternal: boolean;
    readonly foreground: boolean;
}

export interface PlanInput {
    readonly processes: readonly ProcessRow[];
    readonly listeners: ReadonlyMap<number, readonly ListenSocket[]>;
    readonly paneShells: ReadonlyMap<number, PaneShellRef>;
    /** Kelpi's own processes; they and their descendants are never services. */
    readonly selfPids: ReadonlySet<number>;
    /** Ports a container publishes: the Docker VM's forwarder listens on them, the container owns them. */
    readonly containerPorts: ReadonlySet<number>;
}

function childrenOf(processes: readonly ProcessRow[]): Map<number, number[]> {
    const children = new Map<number, number[]>();
    for (const row of processes) {
        if (row.ppid === row.pid) continue;
        const list = children.get(row.ppid) ?? [];
        list.push(row.pid);
        children.set(row.ppid, list);
    }
    return children;
}

function descendants(
    root: number,
    children: ReadonlyMap<number, readonly number[]>,
    stopAt: ReadonlySet<number> = new Set()
): number[] {
    const seen = new Set<number>([root]);
    const stack = [root];
    while (stack.length > 0) {
        const pid = stack.pop() as number;
        for (const child of children.get(pid) ?? []) {
            if (seen.has(child) || stopAt.has(child)) continue;
            seen.add(child);
            stack.push(child);
        }
    }
    return [...seen];
}

export function planProcessStacks(input: PlanInput): StackPlan[] {
    const byPid = new Map(input.processes.map((row) => [row.pid, row]));
    const children = childrenOf(input.processes);
    // Kelpi's own processes, down to but not into the pane shells: a daemon that started the
    // terminal host (or runs shells itself) is an ancestor of every pane's processes.
    const shells = new Set(input.paneShells.keys());
    const self = new Set<number>();
    for (const pid of input.selfPids) for (const member of descendants(pid, children, shells)) self.add(member);

    const plans = new Map<number, { plan: Omit<StackPlan, 'listenerPids'>; listeners: number[] }>();
    for (const [pid, sockets] of input.listeners) {
        if (!byPid.has(pid) || self.has(pid)) continue;
        if (!sockets.some((socket) => !input.containerPorts.has(socket.port))) continue;

        const chain: ProcessRow[] = [];
        let current = byPid.get(pid);
        while (current !== undefined && chain.length < MAX_CHAIN && !chain.includes(current)) {
            chain.push(current);
            if (input.paneShells.has(current.pid) || current.ppid <= 1) break;
            const parent = byPid.get(current.ppid);
            // Orphans are adopted by a session manager (launchd, or Linux's `systemd --user`
            // subreaper): the walk stops below it, so it never roots a stack of its own.
            if (parent === undefined || isSessionManager(parent.args)) break;
            current = parent;
        }
        const last = chain[chain.length - 1] as ProcessRow;
        const paneIndex = input.paneShells.has(last.pid) ? chain.length - 1 : -1;
        // The pane's own process counts: a pane can run an agent directly (`zsh -c claude`, exec'd).
        const agentIndex = chain.findIndex((row) => agentOf(row.args) !== null);
        // The nearest shell a person types into: the pane's, a nested one, or (for a server started
        // outside Kelpi) iTerm's, tmux's, VS Code's or an ssh session's. Never the listener itself.
        const shellIndex = chain.findIndex(
            (row, index) => index > 0 && (input.paneShells.has(row.pid) || isInteractiveShell(row.args))
        );

        let root: ProcessRow;
        if (agentIndex === 0) {
            root = chain[0] as ProcessRow;
        } else if (agentIndex > 0 && (shellIndex === -1 || agentIndex <= shellIndex)) {
            // (Equal when the pane's own process is the agent.)
            // An agent runs each command in its own `zsh -c` (or `bash -lc`) wrapper; the stack
            // starts below it.
            const top = agentIndex - 1;
            root = (top >= 1 && isShellCommandWrapper((chain[top] as ProcessRow).args) ? chain[top - 1] : chain[top]) as ProcessRow;
        } else if (shellIndex > 0) {
            // What was typed at that shell; the terminal app, tmux or sshd above it is never the stack.
            root = chain[shellIndex - 1] as ProcessRow;
        } else if (paneIndex === 0) {
            root = chain[0] as ProcessRow;
        } else if (chain.length >= 2 && isShellCommandWrapper(last.args)) {
            // The wrapper of an agent that has exited, adopted with its command: the command is the stack.
            root = chain[chain.length - 2] as ProcessRow;
        } else {
            root = last;
        }

        const agentRow = agentIndex >= 0 ? (chain[agentIndex] as ProcessRow) : null;
        const existing = plans.get(root.pid);
        if (existing !== undefined) {
            existing.listeners.push(pid);
            continue;
        }
        plans.set(root.pid, {
            plan: {
                rootPid: root.pid,
                paneShellPid: paneIndex === -1 ? null : last.pid,
                agent: agentRow === null ? null : agentOf(agentRow.args),
                agentInternal: agentIndex === 0,
                // The pane's foreground job owns the terminal's foreground process group.
                foreground: paneIndex > 0 && agentIndex === -1 && root.tpgid > 0 && root.pgid === root.tpgid
            },
            listeners: [pid]
        });
    }
    return [...plans.values()].map(({ plan, listeners }) => ({ ...plan, listenerPids: listeners.sort((a, b) => a - b) }));
}

/** IPv4 and IPv6 sockets on one port fold to one entry; it is exposed if either is. */
export function mergePorts(ports: readonly ServicePort[]): ServicePort[] {
    const byPort = new Map<number, ServicePort>();
    for (const port of ports) {
        const seen = byPort.get(port.port);
        if (seen === undefined) {
            byPort.set(port.port, port);
        } else if (port.exposed && !seen.exposed) {
            byPort.set(port.port, port);
        }
    }
    return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export function isPathInside(path: string, folder: string): boolean {
    if (path === folder) return true;
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    return path.startsWith(prefix);
}

/**
 * The workspace with the longest folder containing `path`.
 *
 * Workspaces share folders: two workspaces on one repo both own its root. On a tie `prefer` wins
 * (the service's owner), so a server in its own workspace's folder is not reported as running in
 * a sibling's.
 */
export function workspaceForPath(
    path: string | null,
    workspaces: readonly WorkspaceFolders[],
    prefer: WorkspaceFolders | null = null
): WorkspaceFolders | null {
    if (path === null) return null;
    let best: WorkspaceFolders | null = null;
    let bestLength = -1;
    for (const workspace of workspaces) {
        for (const folder of workspace.folders) {
            if (!isPathInside(path, folder)) continue;
            if (folder.length > bestLength || (folder.length === bestLength && workspace.id === prefer?.id)) {
                best = workspace;
                bestLength = folder.length;
            }
        }
    }
    return best;
}

export interface BuildInput extends PlanInput {
    readonly stacks: readonly StackPlan[];
    readonly cwds: ReadonlyMap<number, string>;
    readonly containers: readonly ContainerRow[];
    readonly workspaces: readonly WorkspaceFolders[];
    /** Worktree and repo folders: a service there with no workspace is listed as unattached. */
    readonly knownFolders: readonly string[];
    /** The folders each known repo's worktrees are created in. */
    readonly worktreeBases?: readonly string[] | undefined;
    readonly pathExists: (path: string) => boolean;
}

function parentOf(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
}

/**
 * The worktree a folder is in, so the leftovers of one worktree list together.
 *
 * A deleted folder is grouped by the topmost folder that is gone, which is the worktree that
 * `git worktree remove` took, whether or not this daemon knows its repo. An existing one by the
 * folder one level under a known repo's worktree base, else by the known repo holding it.
 */
export function worktreeOf(
    directory: string | null,
    missing: boolean,
    input: Pick<BuildInput, 'knownFolders' | 'worktreeBases' | 'pathExists'>
): string | null {
    if (directory === null) return null;
    if (missing) {
        let top = directory;
        let parent = parentOf(top);
        while (parent !== top && parent !== '/' && !input.pathExists(parent)) {
            top = parent;
            parent = parentOf(parent);
        }
        return top;
    }
    const longestFirst = (folders: readonly string[]): string[] => [...folders].sort((a, b) => b.length - a.length);
    for (const base of longestFirst(input.worktreeBases ?? [])) {
        if (directory === base || !isPathInside(directory, base)) continue;
        const prefix = base.endsWith('/') ? base : `${base}/`;
        return `${prefix}${directory.slice(prefix.length).split('/')[0] ?? ''}`;
    }
    return longestFirst(input.knownFolders).find((folder) => isPathInside(directory, folder)) ?? null;
}

function basenameOf(path: string): string {
    const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
    return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * A monorepo app's folder names its server better than the command does: two `pnpm run dev`
 * stacks in one worktree are `auth-mock` and `admin-web`. Only a folder strictly inside
 * a workspace's folder counts; at the worktree's root the command is the better name.
 */
function appFolderName(directory: string | null, workspaces: readonly (WorkspaceFolders | null)[]): string | null {
    if (directory === null) return null;
    for (const workspace of workspaces) {
        if (workspace === null) continue;
        if (workspace.folders.some((folder) => directory !== folder && isPathInside(directory, folder))) return folderLabel(directory);
    }
    return null;
}

/** A folder's name, with its parent when the name says nothing on its own (`dashboard/app`). */
function folderLabel(path: string): string {
    const name = basenameOf(path);
    if (!GENERIC_FOLDERS.has(name)) return name;
    return `${basenameOf(path.slice(0, path.length - name.length - 1))}/${name}`;
}

/** Folder names that say nothing on their own: `modules/dashboard/app` is `dashboard/app`. */
const GENERIC_FOLDERS: ReadonlySet<string> = new Set([
    'app', 'src', 'server', 'web', 'api', 'client', 'frontend', 'backend', 'service', 'site', 'dev'
]);

function categoryFor(
    owner: WorkspaceFolders | null,
    directory: string | null,
    missing: boolean,
    knownFolders: readonly string[]
): RunningServiceCategory {
    if (owner !== null) return 'workspace';
    if (missing) return 'unattached';
    if (directory !== null && knownFolders.some((folder) => isPathInside(directory, folder))) return 'unattached';
    return 'outside';
}

function processService(
    stack: StackPlan,
    input: BuildInput,
    byPid: ReadonlyMap<number, ProcessRow>,
    children: ReadonlyMap<number, readonly number[]>,
    stopAt: ReadonlySet<number>
): RunningService | null {
    const root = byPid.get(stack.rootPid);
    if (root === undefined) return null;
    // An agent's own port is the agent alone: everything under it is the stacks it started,
    // which are listed (and counted) as themselves.
    // Pane shells and Kelpi's own processes are never part of a stack, even under its root.
    const stackPids = stack.agentInternal ? [root.pid] : descendants(root.pid, children, stopAt).filter((pid) => byPid.has(pid));
    const rssBytes = stackPids.reduce((sum, pid) => sum + (byPid.get(pid)?.rssBytes ?? 0), 0);
    const directory = input.cwds.get(root.pid) ?? input.cwds.get(stack.listenerPids[0] as number) ?? null;

    const pane = stack.paneShellPid === null ? null : (input.paneShells.get(stack.paneShellPid) ?? null);
    // A desktop app (an `.app` bundle) not started from a pane is never a dev server, wherever
    // it happens to have been launched from: OrbStack's VM helper can sit in a deleted worktree.
    const appName = pane === null ? appBundleName(root.args) : null;
    const missing = appName === null && directory !== null && !input.pathExists(directory);
    const paneWorkspace = pane === null ? null : (input.workspaces.find((workspace) => workspace.id === pane.workspaceID) ?? null);
    const directoryWorkspace = appName === null ? workspaceForPath(directory, input.workspaces, paneWorkspace) : null;
    const owner = paneWorkspace ?? directoryWorkspace;

    const members: ServiceMember[] = [];
    let memberFromFolder = false;
    for (const pid of stack.listenerPids) {
        const row = byPid.get(pid);
        if (row === undefined) continue;
        const sockets = (input.listeners.get(pid) ?? []).filter((socket) => !input.containerPorts.has(socket.port));
        const cwd = input.cwds.get(pid) ?? null;
        // In a monorepo, `apps/admin-web` names a server better than `next-server` does.
        const fromFolder = cwd !== null && directory !== null && cwd !== directory && isPathInside(cwd, directory);
        if (fromFolder) memberFromFolder = true;
        members.push({
            name: fromFolder ? folderLabel(cwd) : programName(row.args),
            pid,
            containerID: null,
            image: null,
            ports: mergePorts(
                sockets.map((socket) => ({
                    port: socket.port,
                    address: socket.address,
                    exposed: isExposedAddress(socket.address),
                    pid,
                    containerPort: null
                }))
            ),
            rssBytes: row.rssBytes
        });
    }
    if (members.length === 0) return null;

    const name = stack.agentInternal
        ? stack.agent === 'codex'
            ? 'Codex'
            : 'Claude Code'
        : appName !== null
          ? appName
          : members.length === 1 && memberFromFolder
            ? (members[0] as ServiceMember).name
            : (appFolderName(directory, [paneWorkspace, directoryWorkspace]) ?? (displayCommand(root.args) || programName(root.args)));

    return {
        id: `process:${root.pid}:${root.startedAt}`,
        kind: 'process',
        name,
        command: root.args,
        category: stack.agentInternal
            ? 'agent'
            : appName !== null
              ? 'outside'
              : categoryFor(owner, directory, missing, input.knownFolders),
        workspaceID: owner?.id ?? null,
        workspaceName: owner?.name ?? null,
        paneID: pane?.paneID ?? null,
        attribution: paneWorkspace !== null ? 'process-tree' : directoryWorkspace !== null ? 'directory' : 'none',
        startedBy: stack.agentInternal ? (pane === null ? 'unknown' : 'pane') : stack.agent !== null ? 'agent' : pane !== null ? 'pane' : 'unknown',
        agent: stack.agent,
        foreground: stack.foreground,
        directory,
        directoryWorkspaceID: directoryWorkspace?.id ?? null,
        directoryWorkspaceName: directoryWorkspace?.name ?? null,
        directoryMissing: missing,
        worktree: worktreeOf(directory, missing, input),
        startedAt: root.startedAt,
        pid: root.pid,
        processCount: stackPids.length,
        rssBytes,
        ports: mergePorts(members.flatMap((member) => member.ports)),
        members
    };
}

function mostCommon(values: readonly string[]): string | null {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    let best: string | null = null;
    let bestCount = 0;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }
    return best;
}

function containerService(
    group: readonly ContainerRow[],
    project: string | null,
    input: BuildInput,
    stackFolders: readonly WorkspaceFolders[]
): RunningService {
    const sorted = [...group].sort((a, b) => a.name.localeCompare(b.name));
    const directories = sorted.map((row) => row.directory).filter((dir): dir is string => dir !== null);
    const directory = mostCommon(directories);
    // Any container's folder can place the project: Supabase's own containers label `packages/`
    // where the app's compose file labels `apps/api-server`, and both are the same worktree.
    let owner: WorkspaceFolders | null = null;
    let viaStack = false;
    for (const dir of [directory, ...directories]) {
        owner = workspaceForPath(dir, input.workspaces);
        if (owner !== null) break;
    }
    // A folder no workspace owns, where a workspace's own pane started a stack: the containers
    // came up with that stack (an agent ran the dev stack in another worktree).
    if (owner === null) {
        for (const dir of [directory, ...directories]) {
            owner = workspaceForPath(dir, stackFolders);
            if (owner !== null) {
                viaStack = true;
                break;
            }
        }
    }
    const missing = directory !== null && !input.pathExists(directory);
    const directoryWorkspace = workspaceForPath(directory, input.workspaces, owner);
    const members: ServiceMember[] = sorted.map((row) => ({
        name: row.service ?? row.name,
        pid: null,
        containerID: row.id.slice(0, 12),
        image: row.image,
        ports: mergePorts(
            row.ports.map((port) => ({
                port: port.port,
                address: port.address,
                exposed: isExposedAddress(port.address),
                pid: null,
                containerPort: port.containerPort
            }))
        ),
        rssBytes: null
    }));
    const first = sorted[0] as ContainerRow;
    const startedAt = Math.min(...sorted.map((row) => row.createdAt).filter((value) => value > 0));
    return {
        id: project === null ? `container:${first.id.slice(0, 12)}` : `compose:${project}`,
        kind: project === null ? 'container' : 'compose',
        name: project ?? first.name,
        command: project === null ? first.image : `docker compose -p ${project}`,
        category: categoryFor(owner, directory, missing, input.knownFolders),
        workspaceID: owner?.id ?? null,
        workspaceName: owner?.name ?? null,
        paneID: null,
        attribution: owner === null ? 'none' : viaStack ? 'directory' : 'compose-label',
        startedBy: project === null ? 'unknown' : 'compose',
        agent: null,
        foreground: false,
        directory,
        // The workspace holding `directory` itself, which can differ from an owner found through
        // another container's folder.
        directoryWorkspaceID: directoryWorkspace?.id ?? null,
        directoryWorkspaceName: directoryWorkspace?.name ?? null,
        directoryMissing: missing,
        worktree: worktreeOf(directory, missing, input),
        startedAt: Number.isFinite(startedAt) ? startedAt : null,
        pid: null,
        processCount: sorted.length,
        rssBytes: null,
        ports: mergePorts(members.flatMap((member) => member.ports)),
        members
    };
}

const CATEGORY_ORDER: Readonly<Record<RunningServiceCategory, number>> = { workspace: 0, unattached: 1, outside: 2, agent: 3 };

export function buildServices(input: BuildInput, workspaceOrder: readonly string[] = []): RunningService[] {
    const byPid = new Map(input.processes.map((row) => [row.pid, row]));
    const children = childrenOf(input.processes);
    const services: RunningService[] = [];
    const stopAt = new Set([...input.paneShells.keys(), ...input.selfPids]);
    for (const stack of input.stacks) {
        const service = processService(stack, input, byPid, children, stopAt);
        if (service !== null) services.push(service);
    }
    // The folders of stacks a pane started outside any workspace's own folders.
    const stackFolders: WorkspaceFolders[] = services
        .filter(
            (service) =>
                service.attribution === 'process-tree' &&
                service.category === 'workspace' &&
                service.directory !== null &&
                service.directoryWorkspaceID === null &&
                // Only a worktree or repo folder: a pane's server in `~` must not claim every
                // leftover compose project under it.
                input.knownFolders.some((folder) => service.directory !== folder && isPathInside(service.directory as string, folder))
        )
        .map((service) => ({
            id: service.workspaceID as string,
            name: service.workspaceName as string,
            folders: [service.directory as string]
        }));
    const projects = new Map<string, ContainerRow[]>();
    for (const container of input.containers) {
        if (container.project === null) {
            services.push(containerService([container], null, input, stackFolders));
            continue;
        }
        const list = projects.get(container.project) ?? [];
        list.push(container);
        projects.set(container.project, list);
    }
    for (const [project, group] of projects) services.push(containerService(group, project, input, stackFolders));

    const rank = new Map(workspaceOrder.map((id, index) => [id, index]));
    return services.sort(
        (a, b) =>
            CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
            (rank.get(a.workspaceID ?? '') ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.workspaceID ?? '') ?? Number.MAX_SAFE_INTEGER) ||
            (a.workspaceName ?? '').localeCompare(b.workspaceName ?? '') ||
            (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
            a.name.localeCompare(b.name)
    );
}
