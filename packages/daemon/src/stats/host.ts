/**
 * Host counter readers — the platform half of the system-stat sampler.
 *
 * Ground truth is `Nex/Services/SystemStatsService.swift`, which calls Mach (`host_statistics`,
 * `host_statistics64`), BSD (`getloadavg`, `getifaddrs`) and IOKit (`IOBlockStorageDriver`)
 * directly. **Node has none of those**, and adding a native addon for a footer gauge would put
 * a second compiled dependency next to node-pty — the one native dep the stack doc allows. So
 * the counters come from the same numbers by the cheapest route each platform already offers:
 *
 *   | metric      | darwin                                | linux                  | other |
 *   |-------------|---------------------------------------|------------------------|-------|
 *   | cpu ticks   | `os.cpus()` (user+nice+sys vs idle)    | same                   | same  |
 *   | load        | `os.loadavg()[0]`                     | same                   | same  |
 *   | memory used | `vm_stat` (active+wired+compressed)    | `/proc/meminfo`        | os.*  |
 *   | network     | `netstat -ibn` link rows, non-`lo`    | `/proc/net/dev`        | 0     |
 *   | disk I/O    | `ioreg -c IOBlockStorageDriver`       | `/proc/diskstats`      | 0     |
 *   | disk space  | `fs.statfs(home)`                     | same                   | same  |
 *
 * `os.cpus()` sums the same four tick buckets the Swift `host_cpu_load_info` path does, so the
 * CPU number is not an approximation — it is the same quantity read through libuv. `vm_stat`'s
 * `active + wired + compressed` is likewise the Swift formula verbatim, which matters: the
 * obvious Node shortcut (`totalmem - freemem`) counts inactive and cached pages too and reads
 * ~95 % on an idle Mac, i.e. it would be a *wrong* gauge rather than a coarse one.
 *
 * **The three darwin readers share ONE `sh -c` spawn per sample** (`darwinProbe`). Three spawns
 * every two seconds is process churn a long-lived daemon should not create; one costs ~25 ms of
 * wall time off the event loop's critical path and is skipped entirely when the sampler is
 * gated off (no clients attached, or `show-system-stats = false`).
 *
 * Every reader is failure-tolerant by construction: a missing tool, a refused read or an
 * unparseable line yields `null`, and `../stats/sampler.ts` carries the previous value forward
 * rather than reporting a zero that would look like real data.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export interface CpuTicks {
    readonly busy: number;
    readonly total: number;
}

/** `host_cpu_load_info`'s four buckets, summed across cores. */
export function readCpuTicks(): CpuTicks {
    let busy = 0;
    let idle = 0;
    for (const cpu of os.cpus()) {
        busy += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
        idle += cpu.times.idle;
    }
    return { busy, total: busy + idle };
}

/** `getloadavg()[0]`. */
export function readLoadAverage(): number {
    const [one] = os.loadavg();
    return Number.isFinite(one) ? (one as number) : 0;
}

export interface DiskSpace {
    readonly used: number;
    readonly total: number;
}

/**
 * The HOME volume's capacity, matching `sampleDiskSpace`'s
 * `URL(fileURLWithPath: NSHomeDirectory())`. `bavail` (not `bfree`) is the Swift
 * `volumeAvailableCapacity` equivalent: space this user can actually claim.
 */
export function readDiskSpace(home: string = os.homedir()): DiskSpace {
    try {
        const stat = fs.statfsSync(home);
        const total = Number(stat.blocks) * Number(stat.bsize);
        const available = Number(stat.bavail) * Number(stat.bsize);
        if (!Number.isFinite(total) || total <= 0) return { used: 0, total: 0 };
        return { used: Math.max(0, total - Math.max(0, available)), total };
    } catch {
        return { used: 0, total: 0 };
    }
}

export interface NetCounters {
    readonly down: number;
    readonly up: number;
}

export interface IoCounters {
    readonly read: number;
    readonly write: number;
}

/** What one probe of the platform's non-`os` counters produced. `null` = unavailable. */
export interface HostProbe {
    readonly memUsedBytes: number | null;
    readonly memTotalBytes: number;
    readonly net: NetCounters | null;
    readonly io: IoCounters | null;
}

// ── darwin ──────────────────────────────────────────────────────────────────────────

const DARWIN_SECTION = 'kelpi';

/**
 * The one command all three darwin readers ride. Sections are separated by a control-character
 * marker rather than a word, so no tool's own output can be mistaken for a boundary.
 */
const DARWIN_SCRIPT = [
    'vm_stat',
    `echo '${DARWIN_SECTION}'`,
    'netstat -ibn',
    `echo '${DARWIN_SECTION}'`,
    'ioreg -c IOBlockStorageDriver -r -d1 -w0'
].join('; ');

/**
 * `vm_stat` → used bytes, as `(active + wired + compressed) * pageSize`.
 *
 * The page size is read from the header line ("page size of 16384 bytes") rather than assumed:
 * Apple silicon uses 16 KiB where Intel used 4 KiB, and hard-coding either makes the gauge
 * wrong by 4× on the other.
 */
export function parseVmStat(output: string): number | null {
    const pageMatch = /page size of (\d+) bytes/.exec(output);
    const pageSize = pageMatch === null ? 4096 : Number.parseInt(pageMatch[1] as string, 10);
    const pages = (label: string): number | null => {
        const match = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm').exec(output);
        return match === null ? null : Number.parseInt(match[1] as string, 10);
    };
    const active = pages('Pages active');
    const wired = pages('Pages wired down');
    // Absent on very old releases; treated as 0 rather than failing the whole read.
    const compressed = pages('Pages occupied by compressor') ?? 0;
    if (active === null || wired === null) return null;
    return (active + wired + compressed) * pageSize;
}

/**
 * `netstat -ibn` → summed non-loopback interface byte counters (`sampleNetwork`).
 *
 * Two rules make this robust across netstat variants:
 *
 *   - only `<Link#N>` rows are counted, and only ONCE per interface name. The address-family
 *     rows repeat the same counters, so summing every row would multiply throughput by the
 *     number of addresses an interface happens to have;
 *   - the `Ibytes`/`Obytes` column offsets are derived from the HEADER, counted from the right.
 *     A link row with no MAC has one field fewer than one with a MAC, so a fixed left-hand
 *     index reads the wrong column on half the interfaces.
 */
export function parseNetstat(output: string): NetCounters | null {
    const lines = output.split('\n');
    const header = lines.find((line) => line.trim().startsWith('Name'));
    if (header === undefined) return null;
    const columns = header.trim().split(/\s+/);
    const inFromEnd = columns.length - columns.indexOf('Ibytes');
    const outFromEnd = columns.length - columns.indexOf('Obytes');
    if (!columns.includes('Ibytes') || !columns.includes('Obytes')) return null;

    let down = 0;
    let up = 0;
    const seen = new Set<string>();
    for (const line of lines) {
        if (!line.includes('<Link#')) continue;
        const fields = line.trim().split(/\s+/);
        const name = fields[0];
        if (name === undefined || name.startsWith('lo')) continue;
        if (seen.has(name)) continue;
        const inBytes = Number.parseInt(fields[fields.length - inFromEnd] ?? '', 10);
        const outBytes = Number.parseInt(fields[fields.length - outFromEnd] ?? '', 10);
        if (!Number.isFinite(inBytes) || !Number.isFinite(outBytes)) continue;
        seen.add(name);
        down += inBytes;
        up += outBytes;
    }
    return seen.size === 0 ? null : { down, up };
}

/** `ioreg` → summed `Bytes (Read)` / `Bytes (Write)` across every block storage driver. */
export function parseIoreg(output: string): IoCounters | null {
    let read = 0;
    let write = 0;
    let matched = false;
    const pattern = /"Bytes \((Read|Write)\)"\s*=\s*(\d+)/g;
    let match = pattern.exec(output);
    while (match !== null) {
        const value = Number.parseInt(match[2] as string, 10);
        if (Number.isFinite(value)) {
            matched = true;
            if (match[1] === 'Read') read += value;
            else write += value;
        }
        match = pattern.exec(output);
    }
    return matched ? { read, write } : null;
}

// ── linux ───────────────────────────────────────────────────────────────────────────

/** `/proc/meminfo` → used = MemTotal - MemAvailable (the closest analogue to the Mach sum). */
export function parseMemInfo(contents: string): number | null {
    const field = (label: string): number | null => {
        const match = new RegExp(`^${label}:\\s+(\\d+) kB$`, 'm').exec(contents);
        return match === null ? null : Number.parseInt(match[1] as string, 10) * 1024;
    };
    const total = field('MemTotal');
    const available = field('MemAvailable');
    if (total === null || available === null) return null;
    return Math.max(0, total - available);
}

/** `/proc/net/dev` → summed non-`lo` receive/transmit bytes. */
export function parseProcNetDev(contents: string): NetCounters | null {
    let down = 0;
    let up = 0;
    let matched = false;
    for (const line of contents.split('\n')) {
        const separator = line.indexOf(':');
        if (separator < 0) continue;
        const name = line.slice(0, separator).trim();
        if (name === '' || name.startsWith('lo')) continue;
        const fields = line.slice(separator + 1).trim().split(/\s+/);
        const received = Number.parseInt(fields[0] ?? '', 10);
        const transmitted = Number.parseInt(fields[8] ?? '', 10);
        if (!Number.isFinite(received) || !Number.isFinite(transmitted)) continue;
        matched = true;
        down += received;
        up += transmitted;
    }
    return matched ? { down, up } : null;
}

/**
 * `/proc/diskstats` → summed sectors read/written × 512.
 *
 * Partitions are skipped (a `sdaN` under `sda` would double-count its parent's traffic); the
 * heuristic is the standard one — a device whose name ends in a digit AND whose stem is also
 * listed is a partition.
 */
export function parseDiskStats(contents: string): IoCounters | null {
    const rows: { name: string; read: number; write: number }[] = [];
    for (const line of contents.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10) continue;
        const name = fields[2] as string;
        const read = Number.parseInt(fields[5] ?? '', 10);
        const write = Number.parseInt(fields[9] ?? '', 10);
        if (!Number.isFinite(read) || !Number.isFinite(write)) continue;
        rows.push({ name, read, write });
    }
    if (rows.length === 0) return null;
    const names = new Set(rows.map((row) => row.name));
    let read = 0;
    let write = 0;
    for (const row of rows) {
        const stem = row.name.replace(/\d+$/, '');
        if (stem !== row.name && names.has(stem)) continue;
        read += row.read * 512;
        write += row.write * 512;
    }
    return { read: read, write };
}

// ── the probe ───────────────────────────────────────────────────────────────────────

function readFileOrNull(target: string): string | null {
    try {
        return fs.readFileSync(target, 'utf8');
    } catch {
        return null;
    }
}

async function darwinProbe(timeoutMs: number): Promise<HostProbe> {
    const output = await new Promise<string>((resolve) => {
        execFile(
            '/bin/sh',
            ['-c', DARWIN_SCRIPT],
            { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
            (error, stdout) => {
                // A timeout still yields whatever was written; a total failure yields ''.
                resolve(error !== null && stdout === '' ? '' : stdout);
            }
        );
    });
    const [vm = '', net = '', io = ''] = output.split(DARWIN_SECTION);
    return {
        memUsedBytes: parseVmStat(vm),
        memTotalBytes: os.totalmem(),
        net: parseNetstat(net),
        io: parseIoreg(io)
    };
}

function linuxProbe(): HostProbe {
    const meminfo = readFileOrNull('/proc/meminfo');
    const netdev = readFileOrNull('/proc/net/dev');
    const diskstats = readFileOrNull('/proc/diskstats');
    return {
        memUsedBytes: meminfo === null ? null : parseMemInfo(meminfo),
        memTotalBytes: os.totalmem(),
        net: netdev === null ? null : parseProcNetDev(netdev),
        io: diskstats === null ? null : parseDiskStats(diskstats)
    };
}

/**
 * One platform probe. Anything unavailable comes back `null`; the caller decides whether that
 * means "carry the previous value" (memory) or "this metric reads 0" (rates).
 *
 * `platform` is injectable so a test can exercise every branch on one machine.
 */
export async function probeHost(
    options: { readonly platform?: string; readonly timeoutMs?: number } = {}
): Promise<HostProbe> {
    const platform = options.platform ?? process.platform;
    const timeoutMs = options.timeoutMs ?? 1500;
    if (platform === 'darwin') return darwinProbe(timeoutMs);
    if (platform === 'linux') return linuxProbe();
    // Everything else: the `os`-only subset. Memory falls back to the coarse figure, which is
    // documented as coarse rather than silently presented as the Mach sum.
    return {
        memUsedBytes: Math.max(0, os.totalmem() - os.freemem()),
        memTotalBytes: os.totalmem(),
        net: null,
        io: null
    };
}
