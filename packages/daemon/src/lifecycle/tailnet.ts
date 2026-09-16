/**
 * `kelpid url --tailnet` — the remote half of the URL command (stack.md §6).
 *
 * The blessed remote path is `tailscale serve`: it fronts the daemon's loopback HTTP port
 * with automatic HTTPS at `https://<machine>.<tailnet>.ts.net`, which is what makes a remote
 * browser a *secure context* (clipboard, notifications) and keeps the listener itself bound
 * to 127.0.0.1. This module turns that recipe into one command: verify tailscaled is up,
 * make sure serve fronts the daemon's current port, and hand back the finished URL.
 *
 * Three rules, all borrowed from the CLI-install playbook:
 *
 *  1. **Foreign config is never touched.** `tailscale serve --bg <port>` overwrites the
 *     tailnet's :443 handler. If serve is already fronting some OTHER local port — another
 *     service the owner put there on purpose — this module refuses and prints the exact
 *     command to run by hand, because clobbering it silently would take that service down.
 *  2. **Nothing is silent.** Configuring serve is reported (on stderr, via `notes`) so the
 *     one-command path still says what it changed.
 *  3. **stdout stays pure.** This module never prints; it returns a result the caller
 *     renders, so `open "$(kelpid url --tailnet)"` keeps working.
 *
 * `tailscale funnel` (public internet) is deliberately absent: the trust model is
 * "authenticated by being on the tailnet" (ws/http.ts), and funnel would break it.
 */

import { execFile } from 'node:child_process';

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
    (args: readonly string[]): Promise<TailscaleResult>;
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
 * multiply wall clock, and these two numbers move together or not at all.
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
 * The pin is dropped only when the pinned binary reports the ENOENT sentinel (uninstalled, or
 * upgraded out from under us), which starts a fresh search.
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
    return async (args) => {
        if (pinned !== undefined) {
            const result = await execTailscale(pinned.binary, args, budgetMs);
            // Its own answer, right or wrong - but the search is still the pinning one, because
            // that is the question "how was the CLI found?" and it has not been asked again.
            if (!missing(result)) return { ...result, binary: pinned.binary, attempts: pinned.attempts };
            pinned = undefined;
        }
        const deadline = Date.now() + budgetMs;
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
        if (failure === undefined) return { code: -1, stdout: '', stderr: 'ENOENT', attempts };
        return { ...failure, attempts };
    };
}

/** What a probe can tell a human about the search that produced it. */
export interface TailscaleProbeDiagnostics {
    /** Every candidate tried, in order. Empty when the runner reported no search. */
    readonly tried: readonly string[];
    /** The candidate that answered, when one did. */
    readonly used: string | undefined;
    /** `<binary> exited 1: <first stderr line>`, for the first candidate that ran and refused. */
    readonly failure: string | undefined;
}

/**
 * Reads a probe's search back out. Every surface that renders a failed probe goes through this,
 * so the Remote tab, `kelpid url --tailnet` and the log all name the same binaries (#169).
 */
export function tailscaleProbeDiagnostics(result: TailscaleResult): TailscaleProbeDiagnostics {
    const attempts = result.attempts ?? [];
    const refused = attempts.find((attempt) => attempt.code !== 0 && !missing(attempt));
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
 * under-detecting it takes someone's service down. The structured pass is what pins listener
 * ports; a generic whole-document sweep backstops shapes this code has not met.
 */
export function parseServeProxies(json: string): ServeProxy[] {
    const proxies: ServeProxy[] = [];
    const seen = new Set<string>();
    const add = (listenPort: number | undefined, targetPort: number): void => {
        const key = `${String(listenPort)}:${String(targetPort)}`;
        if (seen.has(key)) return;
        seen.add(key);
        proxies.push({ listenPort, targetPort });
    };
    const targetPort = (value: unknown): number | undefined => {
        if (typeof value !== 'string') return undefined;
        const trimmed = value.trim();
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i.exec(trimmed);
        if (withScheme !== null) return Number(withScheme[1]);
        const bare = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(trimmed);
        return bare === null ? undefined : Number(bare[1]);
    };
    const sweep = (value: unknown, listenPort: number | undefined): void => {
        const port = targetPort(value);
        if (port !== undefined) {
            add(listenPort, port);
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
    /**
     * The daemon's BOUND HTTP port (the run dir's port file — stable across restarts). Anything
     * that is not a real port, `0` above all, is refused before tailscale is asked anything.
     */
    readonly port: number;
    /** The run dir's token; rides the URL exactly as `kelpid url` prints it. */
    readonly token: string;
    readonly run?: TailscaleRunner | undefined;
}

/**
 * status → identity checks → serve status → (configure when unfronted) → the URL.
 *
 * Refuses rather than repairs in exactly one case: serve already fronts a *different* local
 * port. That config is someone's working service; see the module note.
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
                `run \`tailscale serve --bg ${String(options.port)}\` and re-run \`kelpid url --tailnet\`.`,
            steps: [
                'Run `tailscale serve status` to see what this tailnet already serves.',
                `If nothing (or only kelpi) is there, run \`tailscale serve --bg ${String(options.port)}\` yourself.`
            ]
        };
    }
    const proxies = parseServeProxies(serveStatus.stdout);
    const ours = proxies.filter((proxy) => proxy.targetPort === options.port);
    const foreign = proxies.filter((proxy) => proxy.targetPort !== options.port);
    let listenPort = 443;
    if (ours.length === 0) {
        if (foreign.length > 0) {
            const fronted = [...new Set(foreign.map((proxy) => proxy.targetPort))];
            return {
                kind: 'error',
                message:
                    `tailscale serve already fronts 127.0.0.1:${fronted.join(', 127.0.0.1:')} - another service, ` +
                    'left untouched.',
                repair:
                    `Move it aside yourself if the daemon should own :443: \`tailscale serve --bg ${String(options.port)}\` ` +
                    '(this REPLACES the current serve config), then re-run `kelpid url --tailnet`.',
                steps: [
                    `Something else already answers on :443 (127.0.0.1:${fronted.join(', 127.0.0.1:')}), and kelpi will not take it over.`,
                    `To hand kelpi :443 anyway, run \`tailscale serve --bg ${String(options.port)}\` yourself - it REPLACES the current serve config.`
                ]
            };
        }
        const serve = await run(['serve', '--bg', String(options.port)]);
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
                message: `\`tailscale serve --bg ${String(options.port)}\` failed: ${said}`,
                repair:
                    link !== undefined
                        ? `Open ${link} (serve + HTTPS must be enabled for the tailnet), then re-run.`
                        : `Enable serve and HTTPS certificates for the tailnet (${TAILNET_DNS_ADMIN}), then re-run.`,
                steps: [
                    `Open ${link ?? TAILNET_DNS_ADMIN} and check that serve and HTTPS certificates are enabled for this tailnet.`,
                    `If it still refuses, run \`tailscale serve --bg ${String(options.port)}\` yourself to see tailscale's own answer.`
                ]
            };
        }
        notes.push(`tailscale serve --bg ${String(options.port)}: configured (was not serving anything)`);
    } else {
        // Honour the listener the config actually names — a `--https=8443` serve would make
        // a bare :443 URL a connection refused reported as success.
        listenPort = ours.find((proxy) => proxy.listenPort !== undefined)?.listenPort ?? 443;
        notes.push(
            `tailscale serve: already fronting 127.0.0.1:${String(options.port)} on :${String(listenPort)}`
        );
    }

    return { kind: 'ok', url: tailnetClientURL(identity.dnsName, options.token, listenPort), notes };
}
