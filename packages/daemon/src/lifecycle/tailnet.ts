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

/** One `tailscale <args>` invocation. Injected for tests; production shells out. */
export interface TailscaleRunner {
    (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The Mac App Store Tailscale ships its CLI inside the bundle and puts NOTHING on PATH. */
const MAC_APP_BUNDLE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * Where to look for the `tailscale` CLI, in order.
 *
 * An explicit `KELPID_TAILSCALE` wins ALONE — a configured path that is wrong should fail
 * loudly, not silently fall back to some other install. Without it: PATH first (standalone
 * installs and Linux), then — on macOS — the App Store bundle's own binary, which is where
 * the CLI lives on a machine whose owner installed Tailscale the normal Mac way and never
 * symlinked it (measured on this repo's own dev machine, 2026-09-01).
 */
export function tailscaleBinaryCandidates(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): readonly string[] {
    const override = env['KELPID_TAILSCALE']?.trim();
    if (override !== undefined && override.length > 0) return [override];
    return platform === 'darwin' ? ['tailscale', MAC_APP_BUNDLE_CLI] : ['tailscale'];
}

function execTailscale(
    binary: string,
    args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        execFile(binary, [...args], { encoding: 'utf8', timeout: 15_000 }, (error, stdout, stderr) => {
            if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                resolve({ code: -1, stdout: '', stderr: 'ENOENT' });
                return;
            }
            const code = error === null ? 0 : ((error as { code?: unknown }).code as number | undefined) ?? 1;
            resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
        });
    });
}

/** Tries each candidate in order; only a missing binary (ENOENT) moves to the next. */
export function defaultTailscaleRunner(candidates: readonly string[] = tailscaleBinaryCandidates()): TailscaleRunner {
    return async (args) => {
        let last = { code: -1, stdout: '', stderr: 'ENOENT' };
        for (const binary of candidates) {
            last = await execTailscale(binary, args);
            if (!(last.code === -1 && last.stderr === 'ENOENT')) return last;
        }
        return last;
    };
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
    /** The daemon's HTTP port (the run dir's port file — stable across restarts). */
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
    const run = options.run ?? defaultTailscaleRunner();
    const notes: string[] = [];

    const status = await run(['status', '--json']);
    if (status.code === -1 && status.stderr === 'ENOENT') {
        return {
            kind: 'error',
            message:
                'tailscale is not installed (no `tailscale` on PATH, and no Mac App Store bundle CLI).',
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
            message: `tailscaled is not running (state: ${identity.backend ?? 'unknown'}).`,
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
