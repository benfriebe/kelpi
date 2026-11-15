/**
 * Parsers for the probes' raw output (`ps`, `lsof -F`, the Docker Engine API) and the small
 * command-line helpers attribution needs. Pure: every function here is exercised against
 * captured output in `parse.test.ts`.
 */

import type { ContainerPort, ContainerRow, ListenSocket, ProcessRow } from './types.js';

/**
 * The `ps -o` columns the scanner asks for, in order. `args` is last because it is the only one
 * that can contain spaces; `lstart` is always five tokens under `LC_ALL=C`.
 */
export const PS_COLUMNS = 'pid=,ppid=,pgid=,tpgid=,rss=,time=,lstart=,args=';

const MONTHS: Readonly<Record<string, number>> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

// `time` is one token and read leniently: a value it cannot read is 0 CPU seconds, never a dropped
// row, since a stop rechecks every pid against this table.
const PS_LINE =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})(?:\s(.*))?$/;

/**
 * `ps`'s `time`, cumulative CPU (user and system) in seconds. macOS prints `MMM:SS.ss` (minutes
 * past 59); Linux procps `[[DD-]HH:]MM:SS`, whole seconds only. Anything else is 0.
 */
export function parseCpuTime(value: string): number {
    const match = /^(?:(\d+)-)?(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?(?::(\d+(?:\.\d+)?))?$/.exec(value);
    if (match === null) return 0;
    const days = Number(match[1] ?? 0);
    const parts = [match[2], match[3], match[4]].filter((part): part is string => part !== undefined).map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    // One part: seconds; two: minutes and seconds; three: hours, minutes and seconds.
    const seconds =
        parts.length === 3
            ? (parts[0] as number) * 3600 + (parts[1] as number) * 60 + (parts[2] as number)
            : parts.length === 2
              ? (parts[0] as number) * 60 + (parts[1] as number)
              : (parts[0] as number);
    return days * 86_400 + seconds;
}

/**
 * `ps -A -o ${PS_COLUMNS}` output → rows. Lines that do not parse (a header, a race) are skipped.
 * The probe runs `ps` under `TZ=UTC`, so `lstart` is read as UTC: no daylight-saving hour is
 * ambiguous, and a time-zone change while the daemon runs cannot shift a process's identity.
 */
export function parsePsTable(text: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const line of text.split('\n')) {
        const match = PS_LINE.exec(line);
        if (match === null) continue;
        const month = MONTHS[match[7] as string];
        if (month === undefined) continue;
        const started = Date.UTC(
            Number(match[12]),
            month,
            Number(match[8]),
            Number(match[9]),
            Number(match[10]),
            Number(match[11])
        );
        rows.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            tpgid: Math.max(0, Number(match[4])),
            rssBytes: Number(match[5]) * 1024,
            cpuSeconds: parseCpuTime(match[6] as string),
            startedAt: Math.floor(started / 1000),
            args: (match[13] ?? '').trim()
        });
    }
    return rows;
}

const LSOF_ESCAPES: Readonly<Record<string, number>> = { b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, '\\': 0x5c };

/**
 * `lsof` prints a byte it will not show as `\xNN` (every non-ASCII byte under `LC_ALL=C`), and
 * `\n`, `\t`, `\\` … for the usual escapes: put the bytes back and read them as UTF-8, so
 * `/w/\xc3\xa9t\xc3\xa9` is the folder `/w/été` again.
 */
export function decodeLsofName(value: string): string {
    if (!value.includes('\\')) return value;
    const bytes: number[] = [];
    // Code points, so a character lsof printed as itself (an emoji under a UTF-8 locale) stays whole.
    const chars = Array.from(value);
    for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index] as string;
        if (char === '\\') {
            const next = chars[index + 1];
            const hex = (chars[index + 2] ?? '') + (chars[index + 3] ?? '');
            if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(hex)) {
                bytes.push(parseInt(hex, 16));
                index += 3;
                continue;
            }
            const escaped = next === undefined ? undefined : LSOF_ESCAPES[next];
            if (escaped !== undefined) {
                bytes.push(escaped);
                index += 1;
                continue;
            }
        }
        bytes.push(...Buffer.from(char, 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
}

/** Split `host:port` from an `lsof` name, unbracketing IPv6. Null when there is no numeric port. */
export function splitHostPort(name: string): ListenSocket | null {
    const colon = name.lastIndexOf(':');
    if (colon <= 0) return null;
    const port = Number(name.slice(colon + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    let address = name.slice(0, colon);
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    return { address, port };
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcn` → listening sockets per pid. IPv4 and IPv6 sockets on
 * the same port are both kept here; `mergePorts` folds them.
 */
export function parseLsofListen(text: string): Map<number, ListenSocket[]> {
    const byPid = new Map<number, ListenSocket[]>();
    let pid: number | null = null;
    for (const line of text.split('\n')) {
        const tag = line[0];
        const value = line.slice(1);
        if (tag === 'p') {
            const parsed = Number(value);
            pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
        } else if (tag === 'n' && pid !== null) {
            // A listening socket's name has no `->` (that is a connection).
            if (value.includes('->')) continue;
            const socket = splitHostPort(value);
            if (socket === null) continue;
            const list = byPid.get(pid) ?? [];
            if (!list.some((entry) => entry.port === socket.port && entry.address === socket.address)) list.push(socket);
            byPid.set(pid, list);
        }
    }
    return byPid;
}

/** `lsof -a -d cwd -F pn -p <pids>` → each process's working directory. */
export function parseLsofCwd(text: string): Map<number, string> {
    const byPid = new Map<number, string>();
    let pid: number | null = null;
    for (const line of text.split('\n')) {
        const tag = line[0];
        const value = line.slice(1);
        if (tag === 'p') {
            const parsed = Number(value);
            pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
        } else if (tag === 'n' && pid !== null && value.startsWith('/')) {
            byPid.set(pid, decodeLsofName(value));
        }
    }
    return byPid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringLabel(labels: Record<string, unknown>, key: string): string | null {
    const value = labels[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The Engine API's `GET /containers/json` body → running containers. Malformed entries are skipped. */
export function parseDockerContainers(body: unknown): ContainerRow[] {
    if (!Array.isArray(body)) return [];
    const rows: ContainerRow[] = [];
    for (const entry of body) {
        if (!isRecord(entry)) continue;
        const id = entry['Id'];
        if (typeof id !== 'string' || id === '') continue;
        const names = Array.isArray(entry['Names']) ? entry['Names'] : [];
        const first = names.find((name): name is string => typeof name === 'string');
        const labels = isRecord(entry['Labels']) ? entry['Labels'] : {};
        const ports: ContainerPort[] = [];
        for (const port of Array.isArray(entry['Ports']) ? entry['Ports'] : []) {
            if (!isRecord(port)) continue;
            const publicPort = port['PublicPort'];
            const privatePort = port['PrivatePort'];
            if (port['Type'] !== 'tcp' || typeof publicPort !== 'number' || typeof privatePort !== 'number') continue;
            const ip = typeof port['IP'] === 'string' && port['IP'] !== '' ? port['IP'] : '0.0.0.0';
            ports.push({ port: publicPort, address: ip, containerPort: privatePort });
        }
        rows.push({
            id,
            name: (first ?? id.slice(0, 12)).replace(/^\//, ''),
            image: typeof entry['Image'] === 'string' ? entry['Image'] : '',
            project: stringLabel(labels, 'com.docker.compose.project') ?? stringLabel(labels, 'com.supabase.cli.project'),
            service: stringLabel(labels, 'com.docker.compose.service'),
            directory:
                stringLabel(labels, 'com.docker.compose.project.working_dir') ?? stringLabel(labels, 'com.supabase.cli.workdir'),
            createdAt: typeof entry['Created'] === 'number' ? entry['Created'] : 0,
            ports
        });
    }
    return rows;
}

/** Bound to every interface (reachable from other machines). */
export function isExposedAddress(address: string): boolean {
    return address === '*' || address === '0.0.0.0' || address === '::' || address === '[::]';
}

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', '-sh', '-bash', '-zsh']);
const RUNTIMES: ReadonlySet<string> = new Set(['node', 'bun', 'deno']);

function basename(token: string): string {
    const slash = token.lastIndexOf('/');
    return slash === -1 ? token : token.slice(slash + 1);
}

function tokens(args: string): string[] {
    return args.split(/\s+/).filter((token) => token !== '');
}

/**
 * An interactive shell: `-zsh`, `zsh -l`, `/bin/bash --login`. Only flags after the shell's
 * name; a shell running a script (`sh …/pnpm run dev`) or a command (`zsh -c …`) is not one.
 * The commands a person types are its children, so a stack is rooted just below it.
 */
export function isInteractiveShell(args: string): boolean {
    const parts = tokens(args);
    const first = parts[0];
    if (first === undefined || !SHELLS.has(basename(first))) return false;
    return parts.slice(1).every((part) => part.startsWith('-') && !/^-[a-zA-Z]*c[a-zA-Z]*$/.test(part));
}

/**
 * A shell running one command line (`zsh -c …`), as an agent's Bash tool runs each command. The
 * stack it starts is rooted below it, so the wrapper never names the service.
 */
export function isShellCommandWrapper(args: string): boolean {
    const parts = tokens(args);
    // `-c`, and combined flags such as Codex's `bash -lc`.
    return parts.length > 1 && SHELLS.has(basename(parts[0] as string)) && parts.slice(1).some((part) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(part));
}

/**
 * The agent a process is, if any: Claude Code's binary reports `claude` as its command line, a
 * Node install runs `cli.js` from its package, and Codex is `codex` either way.
 */
export function agentOf(args: string): 'claude' | 'codex' | null {
    const parts = tokens(args);
    const first = parts[0];
    if (first === undefined) return null;
    const name = basename(first);
    if (name === 'claude') return 'claude';
    // The native installer keeps each release as `…/claude/versions/2.1.325`, and a process
    // started by that path reports the version as its name.
    if (first.includes('/claude/versions/') || VERSION_NAMED.test(name)) return 'claude';
    if (name === 'codex') return 'codex';
    if (RUNTIMES.has(name)) {
        const script = parts[1] ?? '';
        if (script.includes('/@anthropic-ai/claude-code/') || /(^|\/)claude(\.m?js)?$/.test(script)) return 'claude';
        if (script.includes('/@openai/codex/') || /(^|\/)codex(\.m?js)?$/.test(script)) return 'codex';
    }
    return null;
}

/** An executable named only by a release number: Claude Code's native binary. */
const VERSION_NAMED = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const APP_BUNDLE =
    /^(?:\/Applications|\/System|\/Library|\/Users\/[^/]+\/Applications)\/(?:[^/]+\/)*?([^/]+)\.app\/Contents\/MacOS\//;

/**
 * The desktop app whose executable this is (`/Applications/Google Drive.app/Contents/MacOS/
 * Google Drive` → `Google Drive`): the innermost bundle, so a helper app inside another app
 * names itself. Only the executable counts (the start of the command line, read before spaces
 * split it), and only in the places apps are installed. A language runtime that ships as a
 * bundle inside a framework (Homebrew's or python.org's `Python.app`) is not an app.
 */
export function appBundleName(args: string): string | null {
    const match = APP_BUNDLE.exec(args);
    if (match === null || match[0].includes('.framework/')) return null;
    return match[1] as string;
}

const SESSION_MANAGERS: ReadonlySet<string> = new Set(['launchd', 'systemd', 'init']);

/**
 * A process that adopts orphans: launchd and init as pid 1, and Linux's per-session
 * `systemd --user` subreaper. A walk up a process's parents stops below one.
 */
export function isSessionManager(args: string): boolean {
    return SESSION_MANAGERS.has(programName(args));
}

/** The program's own name: the first token's basename (`next-server` for `next-server (v15.5.28)`). */
export function programName(args: string): string {
    const first = tokens(args)[0];
    return first === undefined ? '' : basename(first);
}

const COMMAND_LIMIT = 80;

/**
 * A command line as a person would type it: a shell or package-manager wrapper's interpreter is
 * dropped (`/bin/sh …/pnpm run dev` → `pnpm run dev`) and absolute paths become their basenames.
 */
export function displayCommand(args: string): string {
    let parts = tokens(args);
    if (parts.length > 1 && SHELLS.has(basename(parts[0] as string)) && (parts[1] as string).includes('/')) {
        parts = parts.slice(1);
    }
    const shown = parts.map((part) => (part.startsWith('/') && part.length > 1 ? basename(part) : part)).join(' ');
    const chars = [...shown];
    return chars.length > COMMAND_LIMIT ? `${chars.slice(0, COMMAND_LIMIT - 1).join('')}…` : shown;
}
