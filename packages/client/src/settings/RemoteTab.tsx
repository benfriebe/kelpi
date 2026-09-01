/**
 * Settings ▸ Remote — the `kelpid pair` / `kelpid devices` / `kelpid url --tailnet` flow,
 * in-app (daemon `ws/remote.ts`; owner-only, so a paired device opening Settings sees the
 * daemon refuse and this tab says so instead of half-working).
 *
 * Three cards:
 *   1. **Tailnet** — is tailscale up, who this machine is (`MagicDNS` name), and whether
 *      `tailscale serve` currently fronts the daemon. A dashboard, never a mutation.
 *   2. **Pair a device** — name + Pair. The reply's URL carries the device's own token
 *      exactly ONCE (the registry stores only the hash), so it is shown in a copyable field
 *      with that warning attached, and never rendered again after the card is dismissed.
 *      Over the tailnet the daemon may CONFIGURE `tailscale serve` (same one-command
 *      behaviour the CLI has); its notes are surfaced verbatim.
 *   3. **Paired devices** — the registry, live entries first, with per-row Revoke. A revoke
 *      cuts the device's open sessions within a debounce (the daemon watches the registry),
 *      so the row flipping to "revoked" is the whole story.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { SettingsButton, SettingsDetail, SettingsRow, SettingsSection } from './ui';
import { tokens } from '../chrome/tokens';

/** The verbs this tab pushes — App wires them to `commands.remote*`. */
export interface RemoteTabActions {
    status(): Promise<Record<string, unknown>>;
    pair(name: string, tailnet: boolean): Promise<Record<string, unknown>>;
    revoke(target: string): Promise<Record<string, unknown>>;
}

/** One §1.7 `remote-daemon` registry entry, as the settings snapshot carries it. */
export interface RemoteDaemonRow {
    readonly name: string;
    readonly url: string;
}

interface DeviceRow {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
}

interface TailnetStatus {
    readonly available: boolean;
    readonly dnsName: string | null;
    readonly serving: boolean;
    readonly reason: string | null;
}

interface MintedPairing {
    readonly url: string;
    readonly deviceName: string;
    readonly notes: readonly string[];
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseDevices(raw: unknown): DeviceRow[] {
    if (!Array.isArray(raw)) return [];
    const rows: DeviceRow[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const id = text(record['id']);
        const name = text(record['name']);
        if (id === null || name === null) continue;
        rows.push({
            id,
            name,
            createdAt: text(record['created_at']) ?? '',
            revokedAt: text(record['revoked_at'])
        });
    }
    return rows;
}

function parseTailnet(raw: unknown): TailnetStatus {
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
        available: record['available'] === true,
        dnsName: text(record['dns_name']),
        serving: record['serving'] === true,
        reason: text(record['reason'])
    };
}

/** `2026-09-01T03:12:44.000Z` → the date a management list wants. */
function shortDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

export interface RemoteTabProps {
    readonly actions: RemoteTabActions;
    /** §1.7: the configured `remote-daemon` registry — the "Daemons" card's rows. */
    readonly daemons?: readonly RemoteDaemonRow[] | undefined;
    /** Full-replacement save (`set-remote-daemons`); absent renders the card read-only. */
    readonly onSaveDaemons?: ((daemons: readonly RemoteDaemonRow[]) => void) | undefined;
}

export function RemoteTab(props: RemoteTabProps): ReactElement {
    const { actions } = props;
    const configuredDaemons = props.daemons ?? [];
    const [daemonName, setDaemonName] = useState('');
    const [daemonURL, setDaemonURL] = useState('');
    const addDaemon = (): void => {
        const name = daemonName.trim();
        const url = daemonURL.trim();
        if (name === '' || url === '' || name.includes(':') || props.onSaveDaemons === undefined) return;
        props.onSaveDaemons([
            ...configuredDaemons.filter((daemon) => daemon.name !== name),
            { name, url }
        ]);
        setDaemonName('');
        setDaemonURL('');
    };
    const [devices, setDevices] = useState<DeviceRow[]>([]);
    const [tailnet, setTailnet] = useState<TailnetStatus | null>(null);
    const [statusError, setStatusError] = useState<string | null>(null);
    const [pairName, setPairName] = useState('');
    const [viaTailnet, setViaTailnet] = useState(true);
    const [pairBusy, setPairBusy] = useState(false);
    const [pairError, setPairError] = useState<{ message: string; repair: string | null } | null>(null);
    const [minted, setMinted] = useState<MintedPairing | null>(null);
    const [copied, setCopied] = useState(false);
    // A reply landing after the tab unmounted must not set state into the void.
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const refresh = useCallback((): void => {
        actions.status().then(
            (reply) => {
                if (!alive.current) return;
                if (reply['ok'] !== true) {
                    setStatusError(text(reply['error']) ?? 'remote status failed');
                    return;
                }
                setStatusError(null);
                setDevices(parseDevices(reply['devices']));
                const parsed = parseTailnet(reply['tailnet']);
                setTailnet(parsed);
                // The toggle DEFAULTS to what can work; a user choice made after load sticks
                // because this only runs on refresh and pairing does not refresh the toggle.
                setViaTailnet((current) => (parsed.available ? current : false));
            },
            (error: unknown) => {
                if (alive.current) setStatusError(error instanceof Error ? error.message : String(error));
            }
        );
    }, [actions]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const pair = (): void => {
        const name = pairName.trim();
        if (name.length === 0 || pairBusy) return;
        setPairBusy(true);
        setPairError(null);
        setMinted(null);
        setCopied(false);
        actions.pair(name, viaTailnet).then(
            (reply) => {
                if (!alive.current) return;
                setPairBusy(false);
                if (reply['ok'] !== true) {
                    setPairError({
                        message: text(reply['error']) ?? 'pairing failed',
                        repair: text(reply['repair'])
                    });
                    return;
                }
                const url = text(reply['url']);
                if (url === null) {
                    setPairError({ message: 'the daemon answered without a URL', repair: null });
                    return;
                }
                const notes = Array.isArray(reply['notes'])
                    ? reply['notes'].filter((note): note is string => typeof note === 'string')
                    : [];
                setMinted({ url, deviceName: name, notes });
                setPairName('');
                refresh();
            },
            (error: unknown) => {
                if (!alive.current) return;
                setPairBusy(false);
                setPairError({ message: error instanceof Error ? error.message : String(error), repair: null });
            }
        );
    };

    const revoke = (id: string): void => {
        actions.revoke(id).then(
            () => {
                if (alive.current) refresh();
            },
            () => {
                if (alive.current) refresh();
            }
        );
    };

    const copyURL = (): void => {
        if (minted === null) return;
        navigator.clipboard?.writeText(minted.url).then(
            () => {
                if (!alive.current) return;
                setCopied(true);
                setTimeout(() => {
                    if (alive.current) setCopied(false);
                }, 2000);
            },
            () => {
                // The field below is selectable; a refused clipboard still leaves a path.
            }
        );
    };

    const live = devices.filter((device) => device.revokedAt === null);
    const revoked = devices.filter((device) => device.revokedAt !== null);

    return (
        <div className="flex flex-col gap-5" data-testid="settings-tab-remote">
            <SettingsSection
                title="Tailnet"
                testID="remote-tailnet"
                hint="The blessed remote path: tailscale serve fronts the daemon with automatic HTTPS, and the listener itself stays on loopback."
            >
                <SettingsRow label="Status" testID="remote-tailnet-status">
                    <span style={{ color: tokens.textSecondary }} data-testid="remote-tailnet-line">
                        {statusError !== null
                            ? statusError
                            : tailnet === null
                              ? 'checking…'
                              : tailnet.available
                                ? `${tailnet.dnsName ?? 'on the tailnet'} - ${tailnet.serving ? 'serve is fronting the daemon' : 'serve not configured yet (pairing sets it up)'}`
                                : (tailnet.reason ?? 'unavailable')}
                    </span>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection
                title="Pair a device"
                testID="remote-pair"
                hint="Mints a per-device token and builds its connect URL. The URL is shown once - the daemon keeps only a hash."
            >
                <SettingsRow label="Device name" testID="remote-pair-name">
                    <input
                        data-testid="remote-pair-name-input"
                        className="w-56 rounded border px-2 py-1 text-[12px]"
                        style={{
                            background: tokens.surfaceBackground,
                            borderColor: tokens.divider,
                            color: tokens.textPrimary
                        }}
                        placeholder="alice-laptop"
                        value={pairName}
                        onChange={(event) => setPairName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') pair();
                        }}
                    />
                </SettingsRow>
                <SettingsRow
                    label="Over the tailnet"
                    detail={
                        tailnet?.available === true
                            ? 'The URL works from any of your tailnet devices. Off: a loopback URL for this machine only.'
                            : 'Unavailable until tailscale is running - the URL will be loopback-only.'
                    }
                    testID="remote-pair-tailnet"
                >
                    <input
                        data-testid="remote-pair-tailnet-toggle"
                        type="checkbox"
                        checked={viaTailnet}
                        disabled={tailnet?.available !== true}
                        onChange={(event) => setViaTailnet(event.target.checked)}
                    />
                </SettingsRow>
                <SettingsRow label="" testID="remote-pair-go">
                    <SettingsButton
                        testID="remote-pair-button"
                        tone="accent"
                        disabled={pairName.trim().length === 0 || pairBusy}
                        onClick={pair}
                    >
                        {pairBusy ? 'Pairing…' : 'Pair device'}
                    </SettingsButton>
                </SettingsRow>
                {pairError !== null ? (
                    <SettingsDetail>
                        <span data-testid="remote-pair-error" style={{ color: '#E0655C' }}>
                            {pairError.message}
                            {pairError.repair !== null ? ` - ${pairError.repair}` : ''}
                        </span>
                    </SettingsDetail>
                ) : null}
                {minted !== null ? (
                    <div
                        data-testid="remote-pair-minted"
                        className="flex flex-col gap-2 rounded border p-3"
                        style={{ borderColor: tokens.divider, background: tokens.surfaceBackground }}
                    >
                        <span style={{ color: tokens.textPrimary }} className="text-[12px] font-semibold">
                            “{minted.deviceName}” is paired - send this URL to that device, and no one else.
                        </span>
                        <span style={{ color: tokens.textTertiary }} className="text-[11px]">
                            It carries the device’s own token and is shown exactly once. Closing this card
                            forgets it; revoke and re-pair to mint another.
                        </span>
                        <div className="flex items-center gap-2">
                            <input
                                data-testid="remote-pair-url"
                                readOnly
                                className="w-full rounded border px-2 py-1 text-[11px]"
                                style={{
                                    background: tokens.surfaceBackground,
                                    borderColor: tokens.divider,
                                    color: tokens.textSecondary
                                }}
                                value={minted.url}
                                onFocus={(event) => event.target.select()}
                            />
                            <SettingsButton testID="remote-pair-copy" onClick={copyURL}>
                                {copied ? 'Copied' : 'Copy'}
                            </SettingsButton>
                        </div>
                        {minted.notes.map((note) => (
                            <span key={note} style={{ color: tokens.textTertiary }} className="text-[11px]">
                                {note}
                            </span>
                        ))}
                    </div>
                ) : null}
            </SettingsSection>

            <SettingsSection
                title="Paired devices"
                testID="remote-devices"
                hint="Revoking cuts the device everywhere: new hellos at once, open sessions within moments."
            >
                {live.length === 0 && revoked.length === 0 ? (
                    <SettingsDetail>
                        <span data-testid="remote-devices-empty">No devices paired yet.</span>
                    </SettingsDetail>
                ) : null}
                {live.map((device) => (
                    <SettingsRow
                        key={device.id}
                        label={device.name}
                        detail={`paired ${shortDate(device.createdAt)} · id ${device.id}`}
                        testID={`remote-device-${device.id}`}
                    >
                        <SettingsButton
                            testID={`remote-revoke-${device.id}`}
                            tone="danger"
                            onClick={() => revoke(device.id)}
                        >
                            Revoke
                        </SettingsButton>
                    </SettingsRow>
                ))}
                {revoked.map((device) => (
                    <SettingsRow
                        key={device.id}
                        label={device.name}
                        detail={`revoked ${shortDate(device.revokedAt ?? '')} · id ${device.id}`}
                        testID={`remote-device-${device.id}`}
                    >
                        <span style={{ color: tokens.textTertiary }} className="text-[11px]">
                            revoked
                        </span>
                    </SettingsRow>
                ))}
            </SettingsSection>

            <SettingsSection
                title="Daemons"
                testID="remote-daemons-registry"
                hint="Other kelpi daemons this window can attach to. Paste a pairing URL from that machine's own Remote tab; its workspaces then appear as a section in the sidebar, and new groups can be created on it."
            >
                {configuredDaemons.length === 0 ? (
                    <SettingsDetail>
                        <span data-testid="remote-daemons-empty">No remote daemons configured.</span>
                    </SettingsDetail>
                ) : null}
                {configuredDaemons.map((daemon) => (
                    <SettingsRow
                        key={daemon.name}
                        label={daemon.name}
                        detail={daemon.url.replace(/([?&]token=)[^&]+/, '$1…')}
                        testID={`remote-daemon-row-${daemon.name}`}
                    >
                        <SettingsButton
                            testID={`remote-daemon-remove-${daemon.name}`}
                            tone="danger"
                            disabled={props.onSaveDaemons === undefined}
                            onClick={() => {
                                props.onSaveDaemons?.(
                                    configuredDaemons.filter((entry) => entry.name !== daemon.name)
                                );
                            }}
                        >
                            Remove
                        </SettingsButton>
                    </SettingsRow>
                ))}
                <SettingsRow label="Add a daemon" testID="remote-daemon-add">
                    <span className="flex items-center gap-2">
                        <input
                            data-testid="remote-daemon-add-name"
                            className="w-28 rounded border px-2 py-1 text-[12px]"
                            style={{
                                background: tokens.surfaceBackground,
                                borderColor: tokens.divider,
                                color: tokens.textPrimary
                            }}
                            placeholder="name"
                            value={daemonName}
                            onChange={(event) => setDaemonName(event.target.value)}
                        />
                        <input
                            data-testid="remote-daemon-add-url"
                            className="w-64 rounded border px-2 py-1 text-[12px]"
                            style={{
                                background: tokens.surfaceBackground,
                                borderColor: tokens.divider,
                                color: tokens.textPrimary
                            }}
                            placeholder="https://host.tailnet.ts.net/?token=kd_…"
                            value={daemonURL}
                            onChange={(event) => setDaemonURL(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') addDaemon();
                            }}
                        />
                        <SettingsButton
                            testID="remote-daemon-add-button"
                            tone="accent"
                            disabled={
                                daemonName.trim() === '' ||
                                daemonURL.trim() === '' ||
                                daemonName.includes(':') ||
                                props.onSaveDaemons === undefined
                            }
                            onClick={addDaemon}
                        >
                            Add
                        </SettingsButton>
                    </span>
                </SettingsRow>
            </SettingsSection>
        </div>
    );
}
