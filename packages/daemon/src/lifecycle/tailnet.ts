/**
 * `kelpid url --tailnet` — the remote half of the URL command (stack.md §6).
 *
 * The blessed remote path is `tailscale serve`: it fronts the daemon's loopback HTTP port
 * with automatic HTTPS at `https://<machine>.<tailnet>.ts.net`, which is what makes a remote
 * browser a *secure context* (clipboard, notifications) and keeps the listener itself bound
 * to loopback. This module turns that recipe into one command: verify tailscaled is up,
 * make sure serve fronts the daemon's current port, and hand back the finished URL.
 *
 * Three rules, all borrowed from the CLI-install playbook:
 *
 *  1. **Foreign config is never touched.** `tailscale serve --bg <port>` overwrites the
 *     tailnet's :443 handler. If serve is already fronting some OTHER local port — another
 *     service or a stale target — this module probes it, refuses and prints the exact
 *     command to run by hand. A refused connection does not establish ownership.
 *  2. **Nothing is silent.** Configuring serve is reported (on stderr, via `notes`) so the
 *     one-command path still says what it changed.
 *  3. **stdout stays pure.** This module never prints; it returns a result the caller
 *     renders, so `open "$(kelpid url --tailnet)"` keeps working.
 *
 * `tailscale funnel` (public internet) is deliberately absent: the trust model is
 * "authenticated by being on the tailnet" (ws/http.ts), and funnel would break it.
 */

import { execFile } from 'node:child_process';

import {
    probeForwardTarget,
    readForwardingRecord,
    writeForwardingRecord,
    type ForwardTargetProbe,
    type LoopbackHost
} from './tailnet-forwarding.js';

/** One candidate binary's answer to one invocation. */
export interface TailscaleAttempt {
    /** What was tried: a bare name (resolved through PATH) or an absolute path. */
    readonly binary: string;
    /** Its exit code, or `-1` for a binary that was not there at all. */
    readonly code: number;
    /** The FIRST line of its stderr, trimmed - what a one-line status card has room for. */
    readonly stderr: string;
}

/** What one `tailscale <args>` invocation answered, plus the search that produced it. */
export interface TailscaleResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    /** The candidate this output came from. Absent from injected runners, which are one binary. */
    readonly binary?: string | undefined;
    /**
     * Every candidate tried, in order. A failed probe is only diagnosable if the search behind
     * it can be read back (#169), so the runner carries the whole search and not just the
     * answer it settled on.
     */
    readonly attempts?: readonly TailscaleAttempt[] | undefined;
}

/** One `tailscale <args>` invocation. Injected for tests; production shells out. */
export interface TailscaleRunner {
    (args: readonly string[], options?: { /** Absolute deadline shared across invocations. */ readonly deadline?: number }): Promise<TailscaleResult>;
}

/** The Mac App Store Tailscale ships its CLI inside the bundle and puts NOTHING on PATH. */
const MAC_APP_BUNDLE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * One deadline for the WHOLE candidate search, not one per candidate.
 *
 * This number is the client's `DEFAULT_COMMAND_TIMEOUT_MS`
 * (`packages/client/src/connection/commands.ts`), which is the budget `remote-status` is given.
 * A search that outlives it produces a diagnosis nobody ever sees, because the client replaces
 * the whole reply with "command 'remote-status' timed out" - and an unresponsive tailscaled is
 * precisely the failure this diagnosis exists for. So widening the candidate list must not
 * multiply wall clock. Remote status additionally passes one earlier deadline across both
 * invocations, reserving time for its reply to reach the client.
 */
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * Where to look for the `tailscale` CLI, in order.
 *
 * An explicit `KELPID_TAILSCALE` wins ALONE - a configured path that is wrong should fail
 * loudly, not silently fall back to some other install. Without it, on macOS: PATH, then
 * `/usr/local/bin`, then `/opt/homebrew/bin`, then the App Store bundle's own binary.
 *
 * Those three absolute paths are three different things, and the order is the point:
 *
 *  - `/usr/local/bin/tailscale` is what the OFFICIAL standalone installer drops (a small shell
 *    shim that execs the binary inside the app bundle), so it comes first: it is the install
 *    the vendor put there.
 *  - `/opt/homebrew/bin` is Homebrew's own prefix on Apple Silicon, and it is user-writable by
 *    design. That is not a new trust decision: it is already first on the owner's interactive
 *    PATH, so a terminal-started daemon execs whatever is there today, and the daemon runs as
 *    that same user either way.
 *  - the App Store bundle CLI stays LAST because it is the candidate least likely to be able to
 *    answer: it is sandboxed, and it is where the search used to end up by default.
 *
 * None of the three is redundant with PATH, because the daemon's PATH is not the owner's. A
 * daemon started by the Electron shell inherits the app's environment, and an app launched from
 * Finder or a LaunchAgent gets the LaunchServices PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which
 * has neither directory on it. Without them the search fell straight past a perfectly good CLI
 * to the sandboxed bundle binary, and remote pairing reported "tailscaled is not running
 * (state: unknown)" on a machine whose tailnet was healthy and whose own shell could prove it
 * (#169).
 */
export function tailscaleBinaryCandidates(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): readonly string[] {
    const override = env['KELPID_TAILSCALE']?.trim();
    if (override !== undefined && override.length > 0) return [override];
    return platform === 'darwin'
        ? ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', MAC_APP_BUNDLE_CLI]
        : ['tailscale'];
}

/** The first non-empty line of a stream, trimmed. A refusal's first line is the one that names it. */
export function firstLine(text: string): string {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0) return trimmed;
    }
    return '';
}

/** A candidate that is not installed at all, as opposed to one that ran and refused. */
function missing(result: { readonly code: number; readonly stderr: string }): boolean {
    return result.code === -1 && result.stderr === 'ENOENT';
}

function execTailscale(
    binary: string,
    args: readonly string[],
    timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
    // execFile treats zero as unlimited, so an exhausted budget must never reach it.
    if (timeoutMs <= 0) return Promise.resolve({ code: -1, stdout: '', stderr: 'Tailscale probe deadline exceeded' });
    return new Promise((resolve) => {
        execFile(binary, [...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
            if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                resolve({ code: -1, stdout: '', stderr: 'ENOENT' });
                return;
            }
            // A candidate killed for taking too long exits on a signal with nothing on stderr,
            // which is how a hung CLI used to arrive as a bare "state: unknown". It reads as
            // "could not be run", like a missing binary, because that is what it amounts to.
            if (error !== null && (error as { killed?: unknown }).killed === true) {
                const waited =
                    timeoutMs >= 1000 ? `${String(Math.round(timeoutMs / 1000))}s` : `${String(timeoutMs)}ms`;
                resolve({ code: -1, stdout, stderr: firstLine(stderr) || `timed out after ${waited}` });
                return;
            }
            const code = error === null ? 0 : ((error as { code?: unknown }).code as number | undefined) ?? 1;
            resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
        });
    });
}

/**
 * Tries every candidate in order, hands back the first that ANSWERS, and then PINS it.
 *
 * Two rules, and they are not the same rule:
 *
 *  1. **The search advances past any failure.** The old rule - advance only on ENOENT - meant a
 *     binary that was present but could not reach the backend (the sandboxed App Store CLI above
 *     all) ended the search for every other install on the machine (#169). The whole search
 *     rides back on `attempts`, so a caller can say which binaries were tried and what the
 *     failing one said.
 *  2. **Only the search advances.** Once a candidate has answered it is pinned for the life of
 *     this runner and every later invocation goes to it alone. `resolveTailnetURL` reads status,
 *     reads serve config and then MUTATES serve config; re-searching per invocation could read
 *     one install's backend and configure another's, and would re-issue a mutating
 *     `serve --bg` against up to three more binaries on a refusal. A refusal from the pinned
 *     binary is an answer, not a reason to go looking for a binary that says yes.
 *
 * The pin is dropped when the binary cannot run (including a timeout). ENOENT restarts the
 * search within the remaining budget; other failures leave re-searching to the next call.
 *
 * `budgetMs` is ONE deadline for the whole search rather than one per candidate: see
 * `SEARCH_TIMEOUT_MS`. Candidates the budget does not reach are not tried and are not listed.
 *
 * When nothing answers, the failure reported is the first candidate that actually RAN: a binary
 * that refused says why, a binary that was never there says nothing worth printing. All of them
 * missing still reports the ENOENT sentinel, which is the "tailscale is not installed" case.
 */
export function defaultTailscaleRunner(
    candidates: readonly string[] = tailscaleBinaryCandidates(),
    budgetMs: number = SEARCH_TIMEOUT_MS
): TailscaleRunner {
    /** The candidate that answered, with the search that found it. */
    let pinned: { binary: string; attempts: readonly TailscaleAttempt[] } | undefined;
    return async (args, options) => {
        const deadline = Math.min(Date.now() + budgetMs, options?.deadline ?? Infinity);
        const remaining = (): number => Math.max(0, deadline - Date.now());
        if (remaining() <= 0) return { code: -1, stdout: '', stderr: 'Tailscale probe deadline exceeded', attempts: [] };
        if (pinned !== undefined) {
            const binary = pinned.binary;
            const result = await execTailscale(binary, args, remaining());
            // The search is the pinning one, with THIS invocation's outcome standing in for the
            // pinned binary's entry. Handing back the frozen search records the binary that just
            // failed at code 0, which drops the stderr naming the cause and puts the card back to
            // a bare "state: unknown" - the ticket's own symptom, reintroduced by its fix (#169).
            const attempts =
                result.code === 0
                    ? pinned.attempts
                    : pinned.attempts.map((attempt) =>
                          attempt.binary === binary
                              ? { binary, code: result.code, stderr: firstLine(result.stderr) }
                              : attempt
                      );
            // `-1` is absent OR could not be run, a timeout included: either way this binary has
            // stopped being an answer, so the pin goes and the NEXT invocation searches afresh.
            // Not this one: a hung binary has already spent its budget. ENOENT alone can
            // restart the search immediately, still within the original deadline.
            if (result.code === -1) pinned = undefined;
            if (!missing(result)) return { ...result, binary, attempts };
        }
        const attempts: TailscaleAttempt[] = [];
        let failure: { code: number; stdout: string; stderr: string; binary: string } | undefined;
        for (const binary of candidates) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const result = await execTailscale(binary, args, remaining);
            attempts.push({ binary, code: result.code, stderr: firstLine(result.stderr) });
            if (result.code === 0) {
                pinned = { binary, attempts };
                return { ...result, binary, attempts };
            }
            if (failure === undefined || (missing(failure) && !missing(result))) failure = { ...result, binary };
        }
        if (failure === undefined) return { code: -1, stdout: '', stderr: 'Tailscale probe deadline exceeded', attempts };
        return { ...failure, attempts };
    };
}

/** What a probe can tell a human about the search that produced it. */
export interface TailscaleProbeDiagnostics {
    /** Every candidate tried, in order. Empty when the runner reported no search. */
    readonly tried: readonly string[];
    /** The candidate that answered, when one did. */
    readonly used: string | undefined;
    /**
     * `<binary> exited 1: <first stderr line>`: why this probe did not work.
     *
     * The binary that produced THIS result when it is one that ran and refused, otherwise the
     * first candidate in the search that did. The distinction matters once a binary is pinned:
     * an earlier candidate's refusal, from the search that pinned it, is a stale answer to a
     * question nobody asked.
     */
    readonly failure: string | undefined;
}

/**
 * Reads a probe's search back out. Every surface that renders a failed probe goes through this,
 * so the Remote tab, `kelpid url --tailnet` and the log all name the same binaries (#169).
 */
export function tailscaleProbeDiagnostics(result: TailscaleResult): TailscaleProbeDiagnostics {
    const attempts = result.attempts ?? [];
    const ran = (attempt: TailscaleAttempt): boolean => attempt.code !== 0 && !missing(attempt);
    const refused = attempts.find((attempt) => attempt.binary === result.binary && ran(attempt)) ?? attempts.find(ran);
    return {
        tried: attempts.map((attempt) => attempt.binary),
        used: result.code === 0 ? result.binary : undefined,
        failure: refused === undefined ? undefined : describeAttempt(refused)
    };
}

function describeAttempt(attempt: TailscaleAttempt): string {
    const said = attempt.stderr.trim();
    const exit = attempt.code === -1 ? 'could not be run' : `exited ${String(attempt.code)}`;
    return said.length === 0 ? `${attempt.binary} ${exit}` : `${attempt.binary} ${exit}: ${said}`;
}

/**
 * The search as ONE fact.
 *
 * When a candidate answered after an earlier one refused, those are two halves of one story and
 * reading them as two unrelated ones invites the wrong conclusion - on a machine with two
 * installs the binary that answered and the binary that complained can be talking to different
 * backends, and "after" is what says so.
 */
export function describeTailscaleSearch(search: TailscaleProbeDiagnostics): string | undefined {
    if (search.used === undefined) return search.failure;
    return search.failure === undefined
        ? `answered by ${search.used}`
        : `answered by ${search.used}, after ${search.failure}`;
}

/**
 * A message with the probe's own search appended, for a surface with room for one long line -
 * `kelpid url --tailnet` writes this to a terminal.
 *
 * The Remote tab does NOT use this: its status row is a right-hand column that does not wrap, so
 * it renders the structured `probe` on a detail row of its own instead. Without either, every
 * failure collapsed into "state: unknown" with the stderr that named the cause discarded (#169).
 * A probe that reported no search (an injected runner, which is one binary by construction) is
 * left exactly as it was.
 */
export function explainTailscaleProbe(message: string, result: TailscaleResult): string {
    const search = tailscaleProbeDiagnostics(result);
    if (search.tried.length === 0) return message;
    const head = message.replace(/\.$/, '');
    const found = describeTailscaleSearch(search);
    const tried = `tried ${search.tried.join(', ')}`;
    return found === undefined ? `${head} - ${tried}` : `${head} - ${tried}; ${found}`;
}

// ── parsing ─────────────────────────────────────────────────────────────────────────

export interface TailnetIdentity {
    /** `BackendState`: "Running" is the only state serve can work from. */
    readonly backend: string | undefined;
    /** The machine's MagicDNS name, trailing dot stripped (`werk.taila5f942.ts.net`). */
    readonly dnsName: string | undefined;
}

/** `tailscale status --json` → who this machine is on the tailnet. Defensive: bad JSON = unknown. */
export function parseTailscaleStatus(json: string): TailnetIdentity {
    try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null) return { backend: undefined, dnsName: undefined };
        const record = parsed as Record<string, unknown>;
        const backend = typeof record['BackendState'] === 'string' ? record['BackendState'] : undefined;
        const self = record['Self'];
        const rawName =
            typeof self === 'object' && self !== null && typeof (self as Record<string, unknown>)['DNSName'] === 'string'
                ? ((self as Record<string, unknown>)['DNSName'] as string)
                : undefined;
        const dnsName = rawName === undefined ? undefined : rawName.replace(/\.$/, '').trim();
        return { backend, dnsName: dnsName === undefined || dnsName.length === 0 ? undefined : dnsName };
    } catch {
        return { backend: undefined, dnsName: undefined };
    }
}

export interface ServeProxy {
    /** The tailnet-side HTTPS listener (`Web` key `host:port`); undefined when unplaced. */
    readonly listenPort: number | undefined;
    /** Preserve the address family when probing a different target. */
    readonly targetHost: LoopbackHost;
    /** The loopback port being fronted. */
    readonly targetPort: number;
}

/**
 * Every loopback target the serve config fronts, with its tailnet listener when the config's
 * `Web.<host:port>` structure names one.
 *
 * Matching is deliberately BROAD on the target side — any scheme (tailscale writes
 * `https+insecure://…` for TLS-skipping proxies) and bare `host:port` forwards — because rule
 * 1 (never clobber foreign config) means over-detecting an occupied :443 is safe and
 * under-detecting it takes someone's service down. These targets are diagnostics only;
 * inspectServeConfig independently proves absence or a usable root route before any action.
 */
export function parseServeProxies(json: string): ServeProxy[] {
    const proxies: ServeProxy[] = [];
    const seen = new Set<string>();
    const add = (listenPort: number | undefined, targetHost: LoopbackHost, targetPort: number): void => {
        const key = `${String(listenPort)}:${targetHost}:${String(targetPort)}`;
        if (seen.has(key)) return;
        seen.add(key);
        proxies.push({ listenPort, targetHost, targetPort });
    };
    const target = (value: unknown): { host: LoopbackHost; port: number } | undefined => {
        if (typeof value !== 'string') return undefined;
        try {
            const raw = value.trim();
            const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined;
            const port = url.port !== '' ? Number(url.port)
                : url.protocol === 'http:' ? 80
                : url.protocol === 'https:' || url.protocol === 'https+insecure:' ? 443 : undefined;
            if (port === undefined) return undefined;
            return { host: (url.hostname === '[::1]' ? '::1' : url.hostname) as LoopbackHost, port };
        } catch {
            return undefined;
        }
    };
    const sweep = (value: unknown, listenPort: number | undefined): void => {
        const address = target(value);
        if (address !== undefined) {
            add(listenPort, address.host, address.port);
            return;
        }
        if (Array.isArray(value)) {
            for (const entry of value) sweep(entry, listenPort);
            return;
        }
        if (typeof value === 'object' && value !== null) {
            for (const entry of Object.values(value)) sweep(entry, listenPort);
        }
    };
    try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null) return proxies;
        const web = (parsed as Record<string, unknown>)['Web'];
        if (typeof web === 'object' && web !== null && !Array.isArray(web)) {
            for (const [hostPort, handlers] of Object.entries(web)) {
                const match = /:(\d{1,5})$/.exec(hostPort);
                sweep(handlers, match === null ? undefined : Number(match[1]));
            }
        }
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (key !== 'Web') sweep(value, undefined);
        }
    } catch {
        // Unparseable output yields no proxies; the caller decides what that means.
    }
    return proxies;
}

/** The loopback ports fronted, whatever their listeners (compat surface for callers/tests). */
export function parseServeProxyPorts(json: string): number[] {
    return [...new Set(parseServeProxies(json).map((proxy) => proxy.targetPort))].sort((a, b) => a - b);
}

export type ServeInspection =
    | { readonly kind: 'empty' | 'unverified' }
    | { readonly kind: 'serving'; readonly listenPort: number };

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyMap(value: unknown): boolean {
    return value === undefined || value === null || (object(value) && Object.keys(value).length === 0);
}

/** Only endpoints guaranteed by the kernel-reported bind, without DNS or liveness guesses. */
function loopbackEndpoint(host: string | undefined, port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    const loopback: '127.0.0.1' | '::1' | undefined = host === '127.0.0.1' || host === '0.0.0.0' ? '127.0.0.1'
        : host === '::1' || host === '::' ? '::1' : undefined;
    if (loopback === undefined) return undefined;
    const address = `${loopback === '::1' ? '[::1]' : loopback}:${port}`;
    const proxy = `http://${address}`;
    // A numeric serve target means IPv4. IPv6 must always name its endpoint explicitly.
    return { host: loopback, address, proxy, argument: loopback === '::1' ? proxy : String(port) };
}

/**
 * The mutation/URL safety decision, shared by pairing and the status dashboard. No diagnostic
 * target sweep can establish absence or ownership. Accept only Tailscale's known empty shape
 * (including its null config) or an explicit HTTPS listener for this DNS name whose sole root
 * handler proxies HTTP to Kelpi's actual loopback endpoint. Other paths can intercept assets or /ws;
 * localhost can resolve to a different IPv6 service; neither is equivalent to that route.
 * Unknown configuration and foreground/service indirection require manual inspection.
 */
export function inspectServeConfig(json: string, dnsName: string, port: number, host: string | undefined): ServeInspection {
    const endpoint = loopbackEndpoint(host, port);
    if (endpoint === undefined) return { kind: 'unverified' };
    let config: unknown;
    try { config = JSON.parse(json); }
    catch { return { kind: 'unverified' }; }
    if (config === null) return { kind: 'empty' };
    if (!object(config)) return { kind: 'unverified' };
    const fields = ['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services'];
    if (Object.keys(config).some((key) => !fields.includes(key))) return { kind: 'unverified' };
    if (Object.values(config).every(emptyMap)) return { kind: 'empty' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: 'unverified' };
    if (!emptyMap(config['Foreground']) || !emptyMap(config['Services'])) return { kind: 'unverified' };
    const web = config['Web'];
    const tcp = config['TCP'];
    const funnel = config['AllowFunnel'];
    if (!object(web) || !object(tcp) || (!emptyMap(funnel) && !object(funnel))) return { kind: 'unverified' };
    let found: number | undefined;
    for (const [hostPort, server] of Object.entries(web)) {
        const listenPort = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
        if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535 || hostPort !== `${dnsName}:${listenPort}`) continue;
        const listener = tcp[String(listenPort)];
        if (!object(listener) || listener['HTTPS'] !== true ||
            (listener['HTTP'] !== undefined && listener['HTTP'] !== false) ||
            Object.keys(listener).some((key) => key !== 'HTTPS' && key !== 'HTTP')) continue;
        if (object(funnel) && funnel[hostPort] !== undefined && funnel[hostPort] !== false) continue;
        if (!object(server) || Object.keys(server).length !== 1) continue;
        const handlers = server['Handlers'];
        if (!object(handlers) || Object.keys(handlers).length !== 1) continue;
        const root = handlers['/'];
        if (!object(root) || Object.keys(root).length !== 1) continue;
        // Match the stored HTTP root form exactly. URL normalization would also accept e.g.
        // /app/.., whose upstream path need not be treated the same way by the proxy backend.
        const expected = endpoint.proxy;
        if (root['Proxy'] !== expected && root['Proxy'] !== `${expected}/`) continue;
        if (listenPort === 443) return { kind: 'serving', listenPort };
        found ??= listenPort;
    }
    return found === undefined ? { kind: 'unverified' } : { kind: 'serving', listenPort: found };
}

/** The URL a remote browser opens — carrying the listener when it is not the default :443. */
export function tailnetClientURL(dnsName: string, token: string, listenPort = 443): string {
    const origin = listenPort === 443 ? `https://${dnsName}` : `https://${dnsName}:${String(listenPort)}`;
    return `${origin}/?token=${encodeURIComponent(token)}`;
}

/**
 * The first http(s) URL in a blob of tailscale's own output.
 *
 * Tailscale's refusals name the exact page that fixes them ("Serve is not enabled on your
 * tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=..."), and that link IS
 * the repair - so it is lifted out and handed on by itself, rather than left buried in a
 * sentence a UI renders as one red paragraph. Trailing sentence punctuation is trimmed: a
 * message ending "visit https://x/y." must not yield a link ending in a period.
 */
export function firstLink(text: string): string | undefined {
    const match = /https?:\/\/[^\s<>"'`)\]]+/i.exec(text);
    if (match === null) return undefined;
    const trimmed = match[0].replace(/[.,;:!?]+$/, '');
    return trimmed.length === 0 ? undefined : trimmed;
}

/** Where a tailnet's HTTPS certificates (and MagicDNS) are switched on. */
const TAILNET_DNS_ADMIN = 'https://login.tailscale.com/admin/dns';

// ── the resolve ─────────────────────────────────────────────────────────────────────

export type TailnetUrlResult =
    | {
          readonly kind: 'ok';
          readonly url: string;
          /** Diagnostics for stderr — what was checked or changed. Never part of stdout. */
          readonly notes: readonly string[];
      }
    | {
          readonly kind: 'error';
          readonly message: string;
          /** The command (or step) that fixes it - always safe to print, never executed. */
          readonly repair?: string | undefined;
          /**
           * The same repair as the ORDERED actions a person takes, so a surface with room can
           * render a checklist where the CLI prints one `Repair:` line. Two rules make a step
           * renderable anywhere: it stands alone ("follow the link above" is useless in a UI
           * that shows no "above"), and any URL is left bare so the renderer can turn it into a
           * real link. The last step - "then try again" - belongs to the caller, because only
           * it knows whether that is a re-run or a second click on a button.
           */
          readonly steps?: readonly string[] | undefined;
      };

export interface ResolveTailnetOptions {
    /** Kernel-reported bind address, from the live daemon, never the invoking CLI's env. */
    readonly host: string | undefined;
    /**
     * The daemon's live BOUND HTTP port, reported together with its host. Anything
     * that is not a real port, `0` above all, is refused before tailscale is asked anything.
     */
    readonly port: number;
    /** The run dir's token; rides the URL exactly as `kelpid url` prints it. */
    readonly token: string;
    readonly run?: TailscaleRunner | undefined;
    /** Persistent diagnostic history; callers supply their own run directory. */
    readonly forwardingFile?: string | undefined;
    /** Read-only TCP liveness check; never an ownership test. */
    readonly probeTarget?: ForwardTargetProbe | undefined;
}

/**
 * status → identity checks → serve status → (configure when unfronted) → the URL.
 *
 * Different local targets are probed before refusing: a dead target may be stale, but
 * neither liveness nor our historical port record proves who owns its configuration.
 */
export async function resolveTailnetURL(options: ResolveTailnetOptions): Promise<TailnetUrlResult> {
    // `0` asks the kernel for ANY port. As a serve target it is a proxy to nothing that
    // tailscale accepts and keeps, so every request 502s from then on (#130): no bound port,
    // no URL, and serve is left exactly as it was.
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        return {
            kind: 'error',
            message: `the daemon has no bound HTTP port to front (got ${String(options.port)}), so tailscale serve was left untouched.`,
            repair: 'Restart the daemon (`kelpid stop` then `kelpid start`) so it records the port it bound, then try again.',
            steps: ['Restart the daemon (`kelpid stop`, then `kelpid start`) so it records the port it actually bound.']
        };
    }
    const endpoint = loopbackEndpoint(options.host, options.port);
    if (endpoint === undefined) {
        return {
            kind: 'error',
            message: `the daemon's HTTP bind endpoint could not be verified as loopback (bind: ${options.host ?? 'unknown'}). Forwarding was left untouched.`,
            repair: options.host === undefined
                ? 'Restart the daemon with this version so it reports its actual HTTP bind endpoint, then try again.'
                : 'Bind the daemon to 127.0.0.1, ::1, or a wildcard address before using tailnet forwarding.'
        };
    }
    // Displayed IPv6 URLs need shell quotes: zsh treats their brackets as a filename pattern.
    // The subprocess still receives endpoint.argument directly, without these display quotes.
    const serveCommand = `tailscale serve --bg ${endpoint.host === '::1' ? `'${endpoint.argument}'` : endpoint.argument}`;
    const run = options.run ?? defaultTailscaleRunner();
    const notes: string[] = [];

    const status = await run(['status', '--json']);
    if (status.code === -1 && status.stderr === 'ENOENT') {
        return {
            kind: 'error',
            message: explainTailscaleProbe(
                'tailscale is not installed (no `tailscale` CLI on PATH or in the usual install locations).',
                status
            ),
            repair:
                'Install it from https://tailscale.com/download, or point KELPID_TAILSCALE at the CLI binary, then re-run `kelpid url --tailnet`.',
            steps: [
                'Install Tailscale from https://tailscale.com/download',
                'Sign in to your tailnet so this machine joins it.',
                'Already installed somewhere unusual? Point KELPID_TAILSCALE at its CLI binary instead.'
            ]
        };
    }
    const identity = parseTailscaleStatus(status.stdout);
    if (status.code !== 0 || identity.backend !== 'Running') {
        return {
            kind: 'error',
            // Not "unknown" on its own: which binaries were tried and what the one that ran
            // said is the whole diagnosis, and it used to be thrown away (#169).
            message: explainTailscaleProbe(
                `tailscaled is not running (state: ${identity.backend ?? 'unknown'}).`,
                status
            ),
            repair: 'Run `tailscale up`, then re-run `kelpid url --tailnet`.',
            steps: ['Start Tailscale on this machine and sign in - `tailscale up` does both.']
        };
    }
    if (identity.dnsName === undefined) {
        return {
            kind: 'error',
            message: 'this machine has no MagicDNS name, so there is no stable https address to print.',
            repair: `Enable MagicDNS for the tailnet (${TAILNET_DNS_ADMIN}), then re-run.`,
            steps: [
                `Open ${TAILNET_DNS_ADMIN} and turn MagicDNS on for this tailnet.`,
                'Enable HTTPS certificates on that same page - serve needs them to answer on https.'
            ]
        };
    }

    const serveStatus = await run(['serve', 'status', '--json']);
    if (serveStatus.code !== 0) {
        // Fail closed: a config we cannot READ is not a config that is absent, and running
        // `serve --bg` over it would replace whatever is there (rule 1).
        return {
            kind: 'error',
            message: `\`tailscale serve status --json\` failed, so the current serve config cannot be inspected: ${serveStatus.stderr.trim() || serveStatus.stdout.trim() || `exit ${String(serveStatus.code)}`}`,
            repair:
                'Check `tailscale serve status` yourself; if nothing (or only the daemon) is being served, ' +
                `run \`${serveCommand}\` and re-run \`kelpid url --tailnet\`.`,
            steps: [
                'Run `tailscale serve status` to see what this tailnet already serves.',
                `If nothing (or only kelpi) is there, run \`${serveCommand}\` yourself.`
            ]
        };
    }
    const inspection = inspectServeConfig(serveStatus.stdout, identity.dnsName, options.port, options.host);
    let listenPort = 443;
    if (inspection.kind !== 'serving') {
        if (inspection.kind !== 'empty') {
            const proxies = parseServeProxies(serveStatus.stdout);
            const unique = [...new Map(proxies.map((proxy) => [`${proxy.targetHost}:${proxy.targetPort}`, proxy])).values()];
            const probe = options.probeTarget ?? probeForwardTarget;
            // Bound socket count as well as wall time; unusually large configs still fail closed.
            const details = await Promise.all(unique.slice(0, 16).map(async (proxy) => {
                const host = proxy.targetHost === '::1' ? '[::1]' : proxy.targetHost;
                const address = `${host}:${String(proxy.targetPort)}`;
                let state: Awaited<ReturnType<ForwardTargetProbe>>;
                try { state = await probe(proxy.targetHost, proxy.targetPort); }
                catch { state = 'unknown'; }
                if (state === 'listening') return `${address} accepts TCP connections (service identity unknown)`;
                if (state === 'refused') return `${address} refused TCP connections (possibly stale forwarding)`;
                return `${address} could not be checked (liveness unknown)`;
            }));
            if (unique.length > 16) details.push(`${String(unique.length - 16)} additional targets were not probed`);
            const history = options.forwardingFile === undefined ? undefined : readForwardingRecord(options.forwardingFile);
            if (history !== undefined) {
                details.push(`Kelpi last configured tailscale serve for ${history.dnsName} at ${history.host === '::1' ? '[::1]' : '127.0.0.1'}:${String(history.port)} on ${history.configuredAt}; this history does not establish current ownership`);
            }
            return {
                kind: 'error',
                message: `tailscale serve could not be verified as an HTTPS root route to Kelpi's current ${endpoint.address}. ` +
                    (details.length > 0 ? `${details.join('; ')}. ` : 'The existing configuration is occupied or unrecognized. ') +
                    'Forwarding was left untouched.',
                repair:
                    `Inspect \`tailscale serve status\`; if Kelpi should own :443, run \`${serveCommand}\` ` +
                    '(this replaces the :443 root handler), then try again.',
                steps: [
                    ...details,
                    'Run `tailscale serve status` and confirm which service should own :443. A refused connection alone does not identify the owner.',
                    `To forward :443 to Kelpi's current endpoint, run \`${serveCommand}\` yourself - it replaces the :443 root handler.`
                ]
            };
        }
        const serve = await run(['serve', '--bg', endpoint.argument]);
        if (serve.code !== 0) {
            const said = serve.stderr.trim() || serve.stdout.trim() || `exit ${String(serve.code)}`;
            // tailscale's own message usually names the fix (an admin-console enable link);
            // only fall back to the certificates page when it did not.
            const link = firstLink(said);
            // "Serve is not enabled on your tailnet" is not a FAILURE, it is the setup step
            // nobody has done yet: a tailnet admin has to switch the feature on, and tailscale
            // hands back the exact page that does it. Repeated as an error it reads like a bug
            // in kelpi; said plainly, with the link on its own, it reads like the install step
            // it is. Every other serve failure keeps tailscale's own words, which name it.
            if (/serve is not enabled/i.test(said)) {
                return {
                    kind: 'error',
                    message:
                        'tailscale serve is not enabled for this tailnet yet, so there is no https address to give a device.',
                    repair: `Enable serve for the tailnet at ${link ?? TAILNET_DNS_ADMIN}, then try again.`,
                    steps: [
                        `Open ${link ?? TAILNET_DNS_ADMIN} and enable serve for this tailnet.`,
                        `Enable HTTPS certificates too, if they are not on yet: ${TAILNET_DNS_ADMIN}`
                    ]
                };
            }
            return {
                kind: 'error',
                message: `\`${serveCommand}\` failed: ${said}`,
                repair:
                    link !== undefined
                        ? `Open ${link} (serve + HTTPS must be enabled for the tailnet), then re-run.`
                        : `Enable serve and HTTPS certificates for the tailnet (${TAILNET_DNS_ADMIN}), then re-run.`,
                steps: [
                    `Open ${link ?? TAILNET_DNS_ADMIN} and check that serve and HTTPS certificates are enabled for this tailnet.`,
                    `If it still refuses, run \`${serveCommand}\` yourself to see tailscale's own answer.`
                ]
            };
        }
        notes.push(`${serveCommand}: configured (was not serving anything)`);
        if (options.forwardingFile !== undefined) {
            try {
                writeForwardingRecord(options.forwardingFile, {
                    version: 1, dnsName: identity.dnsName, port: options.port, host: endpoint.host,
                    configuredAt: new Date().toISOString(), binary: serve.binary
                });
            } catch (error) {
                // The forwarding succeeded. A diagnostic write failure must not revoke a usable pair.
                notes.push(`Could not record the last tailscale serve port: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    } else {
        // Honour the listener the config actually names — a `--https=8443` serve would make
        // a bare :443 URL a connection refused reported as success.
        listenPort = inspection.listenPort;
        notes.push(
            `tailscale serve: already fronting ${endpoint.address} on :${String(listenPort)}`
        );
    }

    return { kind: 'ok', url: tailnetClientURL(identity.dnsName, options.token, listenPort), notes };
}
