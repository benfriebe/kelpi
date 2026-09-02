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
 *      Beside the field, for a tailnet pairing only, the same URL as a QR code, because the
 *      device being paired is usually a phone and nobody types an 80-character URL with a
 *      token in it. The QR is drawn from the URL held in this component's state, so it lives
 *      and dies with the card exactly as the field does; there is nothing extra to forget.
 *      Over the tailnet the daemon may CONFIGURE `tailscale serve` (same one-command
 *      behaviour the CLI has); its notes are surfaced verbatim. A failure the daemon can hand
 *      back STEPS for renders as those steps rather than as a red paragraph: the commonest one
 *      (`tailscale serve` was never enabled for the tailnet) is a setup task nobody has done
 *      yet, not a fault, and the admin-console link it names is a real anchor: a link you
 *      cannot click is not a repair.
 *   3. **Paired devices** — the registry, live entries first, with per-row Revoke. A revoke
 *      cuts the device's open sessions within a debounce (the daemon watches the registry),
 *      so the row flipping to "revoked" is the whole story.
 */

import { encodeQr, qrSvg } from '@kelpi/core/qr';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';

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

/**
 * A pairing that did not happen, as the card renders it.
 *
 * `steps` is the daemon's own ordered repair (`lifecycle/tailnet.ts`); when it sent none, the
 * one-line `repair` is the whole guidance and the card says "failed" rather than "next steps".
 */
interface PairFailure {
    readonly message: string;
    readonly repair: string | null;
    readonly steps: readonly string[];
}

interface MintedPairing {
    readonly url: string;
    readonly deviceName: string;
    readonly notes: readonly string[];
    /** What the toggle said when this URL was minted, not what it says now. See {@link pairingQr}. */
    readonly overTailnet: boolean;
}

/**
 * The pairing QR: how big, what colour, and when there is one at all.
 *
 * There is no Swift precedent for any of this - the shipped app has no phone UI at all - so
 * every rule below is an owner-directed divergence, recorded here once for the whole feature.
 *
 * SIZE. `QR_MODULE_PX` is the only number: `qrSvg` puts the viewBox in module units and the px
 * size on the root, so the plate is `(size + 2 * quiet zone) * QR_MODULE_PX` square and grows
 * with the symbol rather than squashing it. Measured with the encoder on realistic replies: a
 * 79-character tailnet URL (`https://werk.taila.ts.net/?token=kd_` + a 43-character token, the
 * shape `daemon/src/lifecycle/devices.ts` mints) is version 5, 37 modules, 45 with the quiet
 * zone, so 225 CSS px at 5; a 25-character MagicDNS name is version 6 and 245 px; the longest
 * hostname worth planning for (121 characters) is version 7 and 265 px. That brackets the
 * 200-to-240 px a Mac screen needs for an arm's-length scan, and being over the top of it only
 * makes the modules bigger. 5 is an INTEGER on purpose: `qrSvg` sets `shape-rendering:
 * crispEdges`, and at a fractional module size neighbouring modules land a device pixel apart,
 * which is the very contrast a camera is trying to threshold.
 *
 * COLOUR. Black on white, not `tokens.textPrimary` on `tokens.surfaceBackground`. A QR scanner
 * thresholds the image and expects dark modules inside a LIGHT quiet zone; the dark preset's
 * card is `#101013`, so the theme's own colours would draw a symbol no camera reads (the light
 * preset's `#FFFFFF` surface would have been fine, which is exactly why this cannot follow the
 * theme). `qrSvg`'s background rect covers the quiet zone as well as the light modules, so the
 * white plate IS the quiet zone; the only token here is the plate's border, which keeps the
 * edge reading as part of the card in both presets.
 *
 * WHEN. A tailnet pairing only. A loopback URL (`http://127.0.0.1:<port>/?token=...`, what the
 * daemon returns when the toggle is off) is openable on this Mac and nowhere else, so a QR of
 * it would be an invitation a phone cannot accept; there is no QR and nothing is said about
 * one. Both halves are checked: the toggle as it stood when this URL was minted, AND the host
 * the daemon actually answered with, because the toggle can be flipped while the card is up
 * and a future daemon could fall back to loopback.
 */
const QR_MODULE_PX = 5;
const QR_DARK = '#000000';
const QR_LIGHT = '#FFFFFF';
/**
 * The accessible name. Deliberately a constant with no device name and no URL in it: it is the
 * one caller-supplied string that reaches the SVG markup, and keeping it fixed is what makes
 * the `dangerouslySetInnerHTML` below trivially safe to argue about.
 */
const QR_LABEL = 'Pairing QR code. Scan it with the device you are pairing.';

/**
 * Is this URL openable only from this machine?
 *
 * Hostname only, and lowercased: `new URL` already normalises the case and strips the brackets
 * from an IPv6 literal, so `::1` arrives bare. Loopback is the whole 127.0.0.0/8 block, not
 * just `127.0.0.1`. An unparseable URL counts as loopback: a URL this code cannot read is one
 * it cannot promise a phone can reach, and no QR is the safe answer.
 */
function isLoopbackURL(raw: string): boolean {
    let host: string;
    try {
        host = new URL(raw).hostname.toLowerCase();
    } catch {
        return true;
    }
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '0.0.0.0') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The minted URL as an SVG string, or `null` when this pairing must not show one. */
function pairingQr(minted: MintedPairing | null): string | null {
    if (minted === null || !minted.overTailnet || isLoopbackURL(minted.url)) return null;
    return qrSvg(encodeQr(minted.url), {
        moduleSize: QR_MODULE_PX,
        foreground: QR_DARK,
        background: QR_LIGHT,
        ariaLabel: QR_LABEL
    });
}

/** The app's destructive/failure red (`chrome/QuitConfirmDialog.tsx`'s DESTRUCTIVE_COLOR). */
const PAIR_FAILURE_TONE = '#E0655C';

const LINK_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/g;

/**
 * A daemon message with its URLs as real links.
 *
 * The repair steps NAME the page that fixes them - the tailnet's own "enable serve" link,
 * which carries a node id nobody is going to retype off a screenshot. As text it is a dead
 * end; as an anchor it is the whole fix, one click away.
 *
 * `target="_blank"` rather than a plumbed callback: the shell hands a new-window request to
 * the system browser (`shell/main.ts` setWindowOpenHandler) and denies the window, and a
 * remote browser opens a tab - while a same-window navigation would replace the app itself.
 * Trailing sentence punctuation stays with the sentence: "visit https://x/y." links `y`.
 */
function Linked(props: { readonly text: string }): ReactElement {
    const parts: ReactNode[] = [];
    let cursor = 0;
    LINK_PATTERN.lastIndex = 0;
    for (let match = LINK_PATTERN.exec(props.text); match !== null; match = LINK_PATTERN.exec(props.text)) {
        const href = match[0].replace(/[.,;:!?]+$/, '');
        if (href.length === 0) continue;
        if (match.index > cursor) parts.push(props.text.slice(cursor, match.index));
        parts.push(
            <a
                key={`${String(match.index)}:${href}`}
                data-testid="remote-pair-link"
                href={href}
                target="_blank"
                rel="noreferrer"
                style={{ color: tokens.accent, textDecoration: 'underline' }}
            >
                {href}
            </a>
        );
        cursor = match.index + href.length;
    }
    if (cursor < props.text.length) parts.push(props.text.slice(cursor));
    return <>{parts}</>;
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

/** The daemon's repair steps, defensively: anything that is not a non-empty string is dropped. */
function parseSteps(raw: unknown): readonly string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((step): step is string => typeof step === 'string' && step.trim().length > 0);
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
    const [pairError, setPairError] = useState<PairFailure | null>(null);
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
                        repair: text(reply['repair']),
                        steps: parseSteps(reply['steps'])
                    });
                    return;
                }
                const url = text(reply['url']);
                if (url === null) {
                    setPairError({ message: 'the daemon answered without a URL', repair: null, steps: [] });
                    return;
                }
                const notes = Array.isArray(reply['notes'])
                    ? reply['notes'].filter((note): note is string => typeof note === 'string')
                    : [];
                setMinted({ url, deviceName: name, notes, overTailnet: viaTailnet });
                setPairName('');
                refresh();
            },
            (error: unknown) => {
                if (!alive.current) return;
                setPairBusy(false);
                setPairError({
                    message: error instanceof Error ? error.message : String(error),
                    repair: null,
                    steps: []
                });
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
    // Encoding a version 7 symbol is about a millisecond, but the card re-renders on every
    // Copy click (the "Copied" flag) and the picture never changes while the URL does not.
    const qr = useMemo(() => pairingQr(minted), [minted]);

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
                    <div
                        data-testid="remote-pair-error"
                        className="flex flex-col gap-2 rounded border p-3"
                        style={{
                            // A setup step wears the attention colour the app already uses for
                            // "this wants you"; only a real failure gets the destructive red.
                            borderColor: pairError.steps.length > 0 ? tokens.activeAgent : PAIR_FAILURE_TONE,
                            background: tokens.surfaceBackground
                        }}
                    >
                        <span
                            data-testid="remote-pair-error-title"
                            className="text-[12px] font-semibold"
                            style={{
                                color: pairError.steps.length > 0 ? tokens.activeAgent : PAIR_FAILURE_TONE
                            }}
                        >
                            {pairError.steps.length > 0 ? 'Pairing needs a setup step' : 'Pairing failed'}
                        </span>
                        <span className="text-[11px]" style={{ color: tokens.textSecondary }}>
                            <Linked text={pairError.message} />
                        </span>
                        {pairError.steps.length > 0 ? (
                            <ol className="m-0 flex list-none flex-col gap-1 p-0">
                                {pairError.steps.map((step, index) => (
                                    <li
                                        key={`${String(index)}:${step}`}
                                        data-testid={`remote-pair-step-${String(index + 1)}`}
                                        className="flex gap-2 text-[11px]"
                                        style={{ color: tokens.textPrimary }}
                                    >
                                        <span style={{ color: tokens.textTertiary }}>{index + 1}.</span>
                                        <span>
                                            <Linked text={step} />
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        ) : pairError.repair !== null ? (
                            <span
                                data-testid="remote-pair-repair"
                                className="text-[11px]"
                                style={{ color: tokens.textPrimary }}
                            >
                                <Linked text={pairError.repair} />
                            </span>
                        ) : null}
                        {pairError.steps.length > 0 ? (
                            <span
                                data-testid="remote-pair-retry"
                                className="text-[11px]"
                                style={{ color: tokens.textTertiary }}
                            >
                                Then pair this device again.
                            </span>
                        ) : null}
                    </div>
                ) : null}
                {minted !== null ? (
                    <div
                        data-testid="remote-pair-minted"
                        className="flex items-start gap-3 rounded border p-3"
                        style={{ borderColor: tokens.divider, background: tokens.surfaceBackground }}
                    >
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
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
                        {qr !== null ? (
                            <div className="flex shrink-0 flex-col items-center gap-1">
                                {/*
                                 * `dangerouslySetInnerHTML` because `qrSvg` returns markup, not a React
                                 * tree, and parsing 800-odd path commands into elements to hand them
                                 * straight back to the DOM would buy nothing. It is safe to inline: the
                                 * string is the encoder's own output and it is a closed shape - one
                                 * `<svg>`, one `<rect>`, one `<path>`, every attribute either a number
                                 * this file computed or one of the two colour literals above. The pairing
                                 * URL never reaches the markup; it is in the module bits. The one string
                                 * a caller supplies is `ariaLabel`, `qrSvg` XML-escapes it, and ours is a
                                 * constant with no interpolation in it.
                                 */}
                                <div
                                    data-testid="remote-pair-qr"
                                    className="rounded border"
                                    style={{ borderColor: tokens.divider, lineHeight: 0 }}
                                    dangerouslySetInnerHTML={{ __html: qr }}
                                />
                                <span style={{ color: tokens.textTertiary }} className="text-[11px]">
                                    Or scan this
                                </span>
                            </div>
                        ) : null}
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
