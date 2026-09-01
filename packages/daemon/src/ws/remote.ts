/**
 * Remote-access verbs for the Settings UI — the `kelpid pair` / `kelpid devices` /
 * `kelpid url --tailnet` flow, in-app.
 *
 * Three WS-only commands (`remote-status`, `remote-pair`, `remote-revoke`), routed like the
 * content family (matched before the wire decode; the CLI keeps its own spellings and this
 * grows no `WIRE_COMMANDS` surface). All three are **owner-only**: a session that
 * authenticated with a paired-device token (`kd_…`) is refused — a guest must not read the
 * registry, mint peers, or revoke the hand that paired it. `ws/sync.ts` enforces that at the
 * routing step, where the session's credential is known.
 *
 * The channel itself is a thin composition over the modules the CLI already uses
 * (`lifecycle/devices.ts`, `lifecycle/tailnet.ts`), so the UI and the CLI cannot drift:
 *
 *   - `status()` never mutates: it reads the registry and probes `tailscale status` /
 *     `serve status` read-only, reporting identity + whether serve fronts the daemon's port.
 *   - `pair(name, tailnet)` mints a device and builds its URL. The tailnet path may
 *     CONFIGURE `tailscale serve` (the same one-command behaviour `kelpid pair --tailnet`
 *     has, notes returned for the UI to show); a tailnet failure rolls the mint back —
 *     the token never left this process, so there is nothing to keep a record of.
 *   - `revoke(target)` marks the device revoked; the daemon's registry watcher then cuts
 *     any open session (`boot/compose.ts` → `revalidateSessions`) with no work here.
 *
 * The minted token rides the reply exactly once, inside the pairing URL — the registry
 * stores only its hash, so a re-ask is impossible by design and the UI says so.
 */

import {
    loadDevices,
    mintDevice,
    removeDevice,
    resolveDevicesPath,
    revokeDevice,
    type PairedDevice
} from '../lifecycle/devices.js';
import {
    defaultTailscaleRunner,
    parseServeProxies,
    parseTailscaleStatus,
    resolveTailnetURL,
    type TailscaleRunner
} from '../lifecycle/tailnet.js';

/** The UI's command family. Owner-only; see the module note. */
export const REMOTE_COMMANDS = ['remote-status', 'remote-pair', 'remote-revoke'] as const;
export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];

export function isRemoteCommand(command: string): command is RemoteCommand {
    return (REMOTE_COMMANDS as readonly string[]).includes(command);
}

/** A registry entry as the UI sees it — everything except the hash. */
export interface WireDevice {
    readonly id: string;
    readonly name: string;
    readonly created_at: string;
    readonly revoked_at?: string;
}

function wireDevice(device: PairedDevice): WireDevice {
    return {
        id: device.id,
        name: device.name,
        created_at: device.createdAt,
        ...(device.revokedAt !== undefined ? { revoked_at: device.revokedAt } : {})
    };
}

export interface RemoteStatusReply {
    readonly ok: true;
    readonly devices: readonly WireDevice[];
    readonly tailnet: {
        /** tailscaled answered and is Running with a MagicDNS name — pairing over it can work. */
        readonly available: boolean;
        readonly backend?: string;
        readonly dns_name?: string;
        /** `tailscale serve` currently fronts the daemon's port. */
        readonly serving: boolean;
        /** Why `available` is false, when it is — words for the status card. */
        readonly reason?: string;
    };
}

export type RemoteReply =
    | RemoteStatusReply
    | { readonly ok: true; readonly url: string; readonly device: WireDevice; readonly notes: readonly string[] }
    | { readonly ok: true; readonly device: WireDevice }
    | {
          readonly ok: false;
          readonly error: string;
          readonly repair?: string;
          /**
           * The repair as ordered actions (`lifecycle/tailnet.ts`). The UI has room the CLI's
           * one `Repair:` line does not, so a setup step nobody has done yet - serve not
           * enabled for the tailnet - can be rendered as a checklist with live links instead
           * of a red paragraph.
           */
          readonly steps?: readonly string[];
      };

export interface RemoteChannelOptions {
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** The daemon's bound HTTP port — what serve fronts and what a pairing URL needs. */
    readonly port: () => number | undefined;
    /** Injected for tests; production shells out to the tailscale CLI. */
    readonly tailscale?: TailscaleRunner | undefined;
    readonly now?: (() => Date) | undefined;
}

export interface RemoteChannel {
    status(): Promise<RemoteReply>;
    pair(name: string, tailnet: boolean): Promise<RemoteReply>;
    revoke(target: string): Promise<RemoteReply>;
}

export function createRemoteChannel(options: RemoteChannelOptions): RemoteChannel {
    const env = options.env ?? process.env;
    const run = options.tailscale ?? defaultTailscaleRunner();
    const devicesFile = (): string => resolveDevicesPath(env);

    const devices = (): WireDevice[] =>
        loadDevices(devicesFile())
            .map(wireDevice)
            // Live first, then newest first — the order the management list wants.
            .sort((a, b) =>
                (a.revoked_at === undefined) === (b.revoked_at === undefined)
                    ? b.created_at.localeCompare(a.created_at)
                    : a.revoked_at === undefined
                      ? -1
                      : 1
            );

    return {
        async status(): Promise<RemoteReply> {
            let list: WireDevice[];
            try {
                list = devices();
            } catch (failure) {
                return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
            }
            const port = options.port();
            const probe = await run(['status', '--json']);
            if (probe.code === -1 && probe.stderr === 'ENOENT') {
                return {
                    ok: true,
                    devices: list,
                    tailnet: { available: false, serving: false, reason: 'tailscale is not installed' }
                };
            }
            const identity = parseTailscaleStatus(probe.stdout);
            if (probe.code !== 0 || identity.backend !== 'Running') {
                return {
                    ok: true,
                    devices: list,
                    tailnet: {
                        available: false,
                        serving: false,
                        ...(identity.backend !== undefined ? { backend: identity.backend } : {}),
                        reason: `tailscaled is not running (state: ${identity.backend ?? 'unknown'})`
                    }
                };
            }
            if (identity.dnsName === undefined) {
                return {
                    ok: true,
                    devices: list,
                    tailnet: {
                        available: false,
                        serving: false,
                        backend: identity.backend,
                        reason: 'no MagicDNS name - enable MagicDNS for the tailnet'
                    }
                };
            }
            // Read-only serve probe: an unreadable config reads as "not serving", never as an
            // error — status is a dashboard, and pair() fails closed on its own.
            let serving = false;
            if (port !== undefined) {
                const serveStatus = await run(['serve', 'status', '--json']);
                serving =
                    serveStatus.code === 0 &&
                    parseServeProxies(serveStatus.stdout).some((proxy) => proxy.targetPort === port);
            }
            return {
                ok: true,
                devices: list,
                tailnet: {
                    available: true,
                    backend: identity.backend,
                    dns_name: identity.dnsName,
                    serving
                }
            };
        },

        async pair(name: string, tailnet: boolean): Promise<RemoteReply> {
            const port = options.port();
            if (port === undefined) {
                return { ok: false, error: 'the daemon has no HTTP port to build a URL from' };
            }
            let minted: ReturnType<typeof mintDevice>;
            try {
                minted = mintDevice(devicesFile(), name, options.now);
            } catch (failure) {
                return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
            }
            if (!tailnet) {
                // The same URL `kelpid pair` (no --tailnet) prints: this machine only.
                return {
                    ok: true,
                    url: `http://127.0.0.1:${String(port)}/?token=${encodeURIComponent(minted.token)}`,
                    device: wireDevice(minted.device),
                    notes: ['This URL is loopback-only - it works in a browser on this machine.']
                };
            }
            const result = await resolveTailnetURL({ port, token: minted.token, run });
            if (result.kind === 'error') {
                // Delete, not revoke: the token never left this process (`kelpid pair`'s rule).
                let rolledBack = `the "${minted.device.name}" device was rolled back - nothing was paired`;
                try {
                    removeDevice(devicesFile(), minted.device.id);
                } catch (rollbackFailure) {
                    rolledBack =
                        `could not roll back the just-minted "${minted.device.name}" entry - revoke it ` +
                        `yourself (${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)})`;
                }
                return {
                    ok: false,
                    error: `${result.message} (${rolledBack})`,
                    ...(result.repair !== undefined ? { repair: result.repair } : {}),
                    ...(result.steps !== undefined ? { steps: result.steps } : {})
                };
            }
            return { ok: true, url: result.url, device: wireDevice(minted.device), notes: result.notes };
        },

        async revoke(target: string): Promise<RemoteReply> {
            try {
                const revoked = revokeDevice(devicesFile(), target, options.now);
                if (revoked === null) return { ok: false, error: `no device matches "${target}"` };
                return { ok: true, device: wireDevice(revoked) };
            } catch (failure) {
                return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
            }
        }
    };
}
