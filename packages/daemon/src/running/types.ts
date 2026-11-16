/**
 * Running services (docs/running-services.md): the dev servers, listening processes and Docker
 * containers on the daemon's host, each attributed to the workspace whose pane started it.
 *
 * These are the scanner's own shapes. The wire shape (snake_case) is `RunningServiceEntry` in
 * `@kelpi/protocol`, produced by `toWireService`.
 */

import type {
    RunningServiceAttribution,
    RunningServiceCategory,
    RunningServiceKind,
    RunningServiceStarter
} from '@kelpi/protocol';

export type { RunningServiceAttribution, RunningServiceCategory, RunningServiceKind, RunningServiceStarter };

/** One row of the host's process table. */
export interface ProcessRow {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    /** The foreground process group of the process's terminal; 0 when it has none. */
    readonly tpgid: number;
    readonly rssBytes: number;
    /** Process start, epoch seconds. With the pid it identifies the process across scans. */
    readonly startedAt: number;
    /** The full command line as `ps` reports it (a process can rewrite its own). */
    readonly args: string;
}

/** A TCP socket in LISTEN, as `lsof` reports it. */
export interface ListenSocket {
    /** `127.0.0.1`, `::1`, `*`, `0.0.0.0`, `::` … (IPv6 without brackets). */
    readonly address: string;
    readonly port: number;
}

export interface ContainerPort {
    /** The host port (Docker's `PublicPort`). */
    readonly port: number;
    readonly address: string;
    /** The port inside the container (`PrivatePort`). */
    readonly containerPort: number;
}

export interface ContainerRow {
    /** The full container id. */
    readonly id: string;
    readonly name: string;
    readonly image: string;
    /** `com.docker.compose.project`, or the Supabase CLI's own project label. */
    readonly project: string | null;
    /** `com.docker.compose.service`, when compose made it. */
    readonly service: string | null;
    /** `com.docker.compose.project.working_dir`, else `com.supabase.cli.workdir`. */
    readonly directory: string | null;
    /** Epoch seconds. */
    readonly createdAt: number;
    readonly ports: readonly ContainerPort[];
}

/** A pane whose shell the daemon owns, for walking a process's ancestry back to it. */
export interface PaneShellRef {
    readonly paneID: string;
    readonly workspaceID: string;
}

/** A workspace and the folders it owns (its repo associations' worktrees). */
export interface WorkspaceFolders {
    readonly id: string;
    readonly name: string;
    /** Real paths (symlinks resolved), so they compare with what `lsof` reports. */
    readonly folders: readonly string[];
}



export interface ServicePort {
    readonly port: number;
    readonly address: string;
    /** Bound to every interface, so other machines can reach it. */
    readonly exposed: boolean;
    /** The listening process; null for a container's published port. */
    readonly pid: number | null;
    /** For a container's published port, the port inside the container. */
    readonly containerPort: number | null;
}

export interface ServiceMember {
    readonly name: string;
    readonly pid: number | null;
    readonly containerID: string | null;
    readonly image: string | null;
    readonly ports: readonly ServicePort[];
    readonly rssBytes: number | null;
}

export interface RunningService {
    /**
     * Stable for the service's life: `process:<root pid>:<root start>`, `compose:<project>` or
     * `container:<12-char id>`. A reused pid never inherits another process's id.
     */
    readonly id: string;
    readonly kind: RunningServiceKind;
    readonly name: string;
    /** The command that started it, or what made a container. */
    readonly command: string;
    readonly category: RunningServiceCategory;
    readonly workspaceID: string | null;
    readonly workspaceName: string | null;
    readonly paneID: string | null;
    readonly attribution: RunningServiceAttribution;
    readonly startedBy: RunningServiceStarter;
    /** `claude` or `codex` when an agent sits between the pane's shell and the service. */
    readonly agent: string | null;
    /** The pane's foreground job: Ctrl-C in that pane stops it. */
    readonly foreground: boolean;
    readonly directory: string | null;
    /** The workspace whose folder holds `directory`; may differ from the owner. */
    readonly directoryWorkspaceID: string | null;
    readonly directoryWorkspaceName: string | null;
    readonly directoryMissing: boolean;
    /** Epoch seconds; null when unknown. */
    readonly startedAt: number | null;
    /** The stack's root process. */
    readonly pid: number | null;
    /** Processes in the stack, or containers in the project. */
    readonly processCount: number;
    /** Resident memory summed over the stack's processes; null for containers. */
    readonly rssBytes: number | null;
    readonly ports: readonly ServicePort[];
    readonly members: readonly ServiceMember[];
}

export interface RunningScan {
    readonly services: readonly RunningService[];
    /** Epoch milliseconds. */
    readonly scannedAt: number;
    /** Probes that could not run. Never fatal: the scan reports what the others found. */
    readonly warnings: readonly string[];
}
