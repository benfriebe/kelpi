/**
 * Settings ▸ Integrations: linking a GitHub account to the daemon, so a workspace can start from
 * an issue or a pull request (docs/integrations.md; the protocol is `@kelpi/protocol`'s
 * `ws/integrations.ts`).
 *
 * The daemon owns the credential. Nothing here ever holds one except the token field, for the
 * moment between a paste and Connect, and the one secret-adjacent value that does reach this tab
 * is GitHub's device-flow `user_code`, which only the session that started the flow is sent. So
 * the tab is a status board plus three verbs:
 *
 *   1. **GitHub**: who the daemon is linked as and how (an OAuth sign-in or a personal access
 *      token, with the token's scopes), or why it cannot be used (`revoked`, `unreadable`,
 *      `endpoint-mismatch`).
 *      Connect starts GitHub's device flow: the code is shown large with a Copy button, a
 *      SEPARATE Open GitHub button opens the verification page (a user gesture, which Safari
 *      requires, and only after `isGitHubWebURL` says it is github.com), a countdown runs to the
 *      code's expiry, and Cancel abandons that flow by its id. The DAEMON polls GitHub, so the
 *      outcome arrives as an `integrations-changed` frame (the store's `IntegrationsSlice`), not
 *      as a reply. Disconnect forgets the credential, and says where to revoke GitHub's own grant,
 *      which Kelpi cannot do (that takes the OAuth App's client secret).
 *   2. **Other ways to connect**: a personal access token, masked, verified by the daemon with
 *      GitHub before it is stored. A build with no OAuth client ID (`available: false`) offers
 *      only this path, and says why.
 *   3. **Searchable repositories**: the registered repositories with a GitHub remote, read from
 *      the registry's `remote_url`, because a ticket can only start a workspace in a repository
 *      Kelpi knows, and typed searches are scoped to their owners.
 *
 * Which device code is still worth showing is decided by the flow id (plan P10): the code stays
 * while the status names no flow yet (the reply can beat the frame) or names OURS as pending; a
 * different pending flow means another window replaced ours (a second Connect anywhere does), a
 * failed one with our id carries the reason, a link ends it, and a new session (`sessionKey`, the
 * welcome's client id) means the daemon was restarted or handed off, which drops every flow.
 *
 * A paired device's session (`manageable: false`) sees the status and nothing it could change:
 * the daemon refuses the four management verbs from it anyway (`forbidden`), and a button that
 * exists to be refused is worse than none. Everyone is told that paired devices search and open
 * the owner's private issues through this link, because they do.
 */

import { parseGitHubRemote } from '@kelpi/core/tickets';
import {
    isGitHubWebURL,
    parseIntegrationFailure,
    parseIntegrationLinkStartReply,
    type IntegrationProvider,
    type WsIntegrationStatus
} from '@kelpi/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { GITHUB_AUTHORIZED_APPS_URL, openGitHubURL, tokens, type ChromeRepo } from '../chrome';
import type { IntegrationsSlice } from '../state';
import { SettingsButton, SettingsDetail, SettingsRow, SettingsSection } from './ui';

/** The verbs this tab pushes. App wires them to `commands.integration*` and applies reply echoes to the store. */
export interface IntegrationsTabActions {
    linkStart(provider: IntegrationProvider): Promise<Record<string, unknown>>;
    linkCancel(provider: IntegrationProvider, flowID: string | null): Promise<Record<string, unknown>>;
    linkToken(provider: IntegrationProvider, token: string): Promise<Record<string, unknown>>;
    unlink(provider: IntegrationProvider): Promise<Record<string, unknown>>;
}

export interface IntegrationsTabProps {
    readonly integrations: IntegrationsSlice;
    readonly actions: IntegrationsTabActions;
    /** The registry, with each repo's `remoteURL`, for the searchable-repositories list. */
    readonly repos: readonly ChromeRepo[];
    /** Changes on every (re)connection (the welcome's clientID); a shown device code is dropped when it does. */
    readonly sessionKey: string | null;
    /** Opens a GitHub page; only ever called with an `isGitHubWebURL` URL. Default: `openGitHubURL`'s window. */
    readonly onOpenURL?: ((url: string) => void) | undefined;
}

const PROVIDER: IntegrationProvider = 'github';

/** The app's failure red (`RemoteTab`'s PAIR_FAILURE_TONE). */
const FAILURE_TONE = '#E0655C';

/** A device code this tab is showing, with its expiry by THIS machine's clock. */
interface DeviceCode {
    readonly flowID: string;
    readonly userCode: string;
    readonly verificationURI: string;
    readonly expiresAt: number;
}

interface Notice {
    readonly tone: 'info' | 'error';
    readonly text: string;
}

/** `14:32` until the code expires; never negative. */
export function formatCountdown(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
}

function failureText(reply: Record<string, unknown>, fallback: string): string {
    return parseIntegrationFailure(reply)?.error ?? fallback;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The status line: linked as whom, or why not. */
function statusLine(status: WsIntegrationStatus): string {
    if (status.connected) return status.login === undefined ? 'Connected' : `Connected as @${status.login}`;
    if (status.problem === 'revoked') return 'Not connected: GitHub no longer accepts the saved credential';
    if (status.problem === 'unreadable') return 'Not connected: the saved credential could not be read';
    if (status.problem === 'endpoint-mismatch') return 'Not connected: the saved credential is for another GitHub address';
    return 'Not connected';
}

/** The status row's caption: how it was linked, and what a problem or a flow elsewhere means. */
function statusDetail(status: WsIntegrationStatus, showingCode: boolean): string | null {
    const lines: string[] = [];
    if (status.connected) {
        if (status.how === 'oauth') lines.push('Signed in with GitHub.');
        else if (status.how === 'token') lines.push('A personal access token.');
        if (status.scopes === undefined) {
            if (status.how === 'token') {
                lines.push('A fine-grained token: GitHub does not report its scopes or which repositories it can see.');
            }
        } else {
            lines.push(status.scopes.length === 0 ? 'Scopes: none.' : `Scopes: ${status.scopes.join(', ')}.`);
        }
    }
    if (status.problem === 'revoked') {
        lines.push('The token was revoked or has expired. Connect again to replace it.');
    } else if (status.problem === 'unreadable') {
        lines.push('Kelpi could not read integrations.json, so it refuses to guess. Connect again to replace it.');
    } else if (status.problem === 'endpoint-mismatch') {
        lines.push(
            'It was linked against other GitHub addresses than this daemon now uses (KELPI_GITHUB_API_URL or KELPI_GITHUB_WEB_URL), so Kelpi will not send it there. Connect again to link an account here, or start the daemon without that setting.'
        );
    }
    if (!showingCode && status.linking?.state === 'pending') {
        lines.push('A sign-in is waiting for GitHub (started in another window).');
    }
    if (!showingCode && status.linking?.state === 'failed' && !status.connected) {
        lines.push(`The last sign-in did not finish: ${status.linking.message || status.linking.reason}.`);
    }
    return lines.length === 0 ? null : lines.join(' ');
}

/** One GitHub repository the registry points at, with the registry rows that do. */
interface SearchableRepo {
    readonly repo: string;
    readonly names: readonly string[];
}

function searchableRepos(repos: readonly ChromeRepo[]): { readonly github: SearchableRepo[]; readonly other: string[] } {
    const byRepo = new Map<string, { repo: string; names: string[] }>();
    const other: string[] = [];
    for (const entry of repos) {
        const remote = entry.remoteURL === undefined || entry.remoteURL === null ? null : parseGitHubRemote(entry.remoteURL);
        if (remote === null) {
            other.push(entry.name);
            continue;
        }
        const key = remote.repo.toLowerCase();
        const held = byRepo.get(key);
        if (held === undefined) byRepo.set(key, { repo: remote.repo, names: [entry.name] });
        else if (!held.names.includes(entry.name)) held.names.push(entry.name);
    }
    const github = [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
    return { github, other };
}

export function IntegrationsTab(props: IntegrationsTabProps): ReactElement {
    const { actions, integrations } = props;
    const status = integrations.providers.find((entry) => entry.provider === PROVIDER) ?? null;
    const manageable = integrations.manageable;

    const [code, setCode] = useState<DeviceCode | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [starting, setStarting] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [copied, setCopied] = useState(false);
    const [unlinking, setUnlinking] = useState(false);
    const [token, setToken] = useState('');
    const [tokenBusy, setTokenBusy] = useState(false);
    const [tokenError, setTokenError] = useState<string | null>(null);
    const [tokenWarnings, setTokenWarnings] = useState<readonly string[]>([]);
    /** Our flow has been seen pending in a status: its later absence means it ended. */
    const seenPending = useRef(false);

    // A reply landing after the tab unmounted must not set state into the void.
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const dropCode = useCallback((next: Notice | null): void => {
        seenPending.current = false;
        setCode(null);
        setCopied(false);
        setNotice(next);
    }, []);

    /*
     * A new session means the daemon restarted or was handed off, and either drops every pending
     * flow (docs/integrations.md): the code on screen no longer works.
     */
    const lastSession = useRef(props.sessionKey);
    useEffect(() => {
        if (lastSession.current === props.sessionKey) return;
        lastSession.current = props.sessionKey;
        if (code === null) return;
        dropCode({
            tone: 'info',
            text: 'The connection to the daemon was reset, which ends a pending sign-in. Connect again for a new code.'
        });
    }, [props.sessionKey, code, dropCode]);

    // The countdown: once a second while a code is shown, and the code goes when it expires.
    useEffect(() => {
        if (code === null) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [code]);
    useEffect(() => {
        if (code === null || now < code.expiresAt) return;
        dropCode({ tone: 'error', text: 'The code expired before GitHub confirmed it. Connect again for a new one.' });
    }, [code, now, dropCode]);

    // What the daemon's status says about OUR flow (plan P10).
    useEffect(() => {
        if (code === null || status === null) return;
        if (status.connected) {
            dropCode({ tone: 'info', text: status.login === undefined ? 'Connected.' : `Connected as @${status.login}.` });
            return;
        }
        const linking = status.linking;
        if (linking === undefined) {
            if (seenPending.current) dropCode({ tone: 'info', text: 'The sign-in ended before GitHub confirmed it.' });
            return;
        }
        if (linking.flowID !== code.flowID) {
            if (linking.state === 'pending') {
                dropCode({
                    tone: 'info',
                    text: 'Another window started a new sign-in, so this code no longer works. Use the code shown there, or connect again here.'
                });
            }
            return;
        }
        if (linking.state === 'pending') {
            seenPending.current = true;
            return;
        }
        dropCode({ tone: 'error', text: linking.message || `The sign-in ended: ${linking.reason}.` });
    }, [code, status, dropCode]);

    const connect = (): void => {
        if (starting || code !== null) return;
        setStarting(true);
        setNotice(null);
        actions.linkStart(PROVIDER).then(
            (reply) => {
                if (!alive.current) return;
                setStarting(false);
                const started = parseIntegrationLinkStartReply(reply);
                if (started === null) {
                    if (reply['ok'] === true) {
                        // A flow did start, but on a page this client will not open: abandon it.
                        const flowID = typeof reply['flow_id'] === 'string' ? reply['flow_id'] : null;
                        void actions.linkCancel(PROVIDER, flowID).catch(() => {});
                        setNotice({
                            tone: 'error',
                            text: 'The daemon answered with a sign-in page that is not on github.com, so Kelpi did not open it and cancelled the sign-in.'
                        });
                        return;
                    }
                    const failure = parseIntegrationFailure(reply);
                    // `unavailable` covers more than "no device flow": the daemon stopping, a
                    // cancelled request, a credential it could not write. So the daemon's words
                    // lead, and the token path is offered as a way round, not as the diagnosis.
                    setNotice({
                        tone: 'error',
                        text:
                            failure?.code === 'unavailable'
                                ? `${failure.error} If browser sign-in stays unavailable, a personal access token below is the other way to connect.`
                                : (failure?.error ?? 'The sign-in could not be started.')
                    });
                    return;
                }
                const startedAt = Date.now();
                seenPending.current = false;
                setNow(startedAt);
                setCopied(false);
                setCode({
                    flowID: started.flow_id,
                    userCode: started.user_code,
                    verificationURI: started.verification_uri,
                    expiresAt: startedAt + started.expires_in * 1000
                });
            },
            (error: unknown) => {
                if (!alive.current) return;
                setStarting(false);
                setNotice({ tone: 'error', text: errorText(error) });
            }
        );
    };

    const copyCode = (): void => {
        if (code === null) return;
        const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
        if (clipboard?.writeText === undefined) return;
        clipboard.writeText(code.userCode).then(
            () => {
                if (!alive.current) return;
                setCopied(true);
                setTimeout(() => {
                    if (alive.current) setCopied(false);
                }, 2000);
            },
            () => {
                // The code is on screen and selectable; a refused clipboard still leaves a path.
            }
        );
    };

    const openVerification = (): void => {
        if (code === null || !isGitHubWebURL(code.verificationURI)) return;
        openGitHubURL(code.verificationURI, props.onOpenURL);
    };

    const cancel = (): void => {
        if (code === null) return;
        const flowID = code.flowID;
        dropCode({ tone: 'info', text: 'Sign-in cancelled.' });
        actions.linkCancel(PROVIDER, flowID).then(
            (reply) => {
                if (!alive.current || reply['ok'] === true) return;
                setNotice({ tone: 'error', text: failureText(reply, 'The sign-in could not be cancelled.') });
            },
            (error: unknown) => {
                if (alive.current) setNotice({ tone: 'error', text: errorText(error) });
            }
        );
    };

    const disconnect = (): void => {
        if (unlinking) return;
        setUnlinking(true);
        setNotice(null);
        actions.unlink(PROVIDER).then(
            (reply) => {
                if (!alive.current) return;
                setUnlinking(false);
                if (reply['ok'] !== true) setNotice({ tone: 'error', text: failureText(reply, 'GitHub could not be disconnected.') });
            },
            (error: unknown) => {
                if (!alive.current) return;
                setUnlinking(false);
                setNotice({ tone: 'error', text: errorText(error) });
            }
        );
    };

    const submitToken = (): void => {
        const value = token.trim();
        if (value === '' || tokenBusy) return;
        setTokenBusy(true);
        setTokenError(null);
        setTokenWarnings([]);
        actions.linkToken(PROVIDER, value).then(
            (reply) => {
                if (!alive.current) return;
                setTokenBusy(false);
                if (reply['ok'] !== true) {
                    setTokenError(failureText(reply, 'The token was not accepted.'));
                    return;
                }
                // The daemon has it now; this field must not keep it a moment longer.
                setToken('');
                setTokenWarnings(stringList(reply['warnings']));
            },
            (error: unknown) => {
                if (!alive.current) return;
                setTokenBusy(false);
                setTokenError(errorText(error));
            }
        );
    };

    const searchable = useMemo(() => searchableRepos(props.repos), [props.repos]);

    if (!integrations.supported) {
        return (
            <div className="flex flex-col gap-5" data-testid="settings-tab-integrations">
                <p data-testid="integrations-unsupported" className="text-[12px]" style={{ color: tokens.textSecondary }}>
                    This daemon cannot link GitHub: it predates integrations. Update Kelpi on the machine the daemon runs
                    on to create workspaces from GitHub issues and pull requests.
                </p>
            </div>
        );
    }
    if (status === null) {
        return (
            <div className="flex flex-col gap-5" data-testid="settings-tab-integrations">
                <p data-testid="integrations-github-unavailable" className="text-[12px]" style={{ color: tokens.textSecondary }}>
                    GitHub is not available on this daemon.
                </p>
            </div>
        );
    }

    const hasCredential = status.connected || status.problem !== undefined || status.login !== undefined;
    const detail = statusDetail(status, code !== null);
    const remaining = code === null ? 0 : code.expiresAt - now;

    return (
        <div className="flex flex-col gap-5" data-testid="settings-tab-integrations">
            <SettingsSection
                title="GitHub"
                testID="integrations-github"
                hint="Paired devices use this connection too: anyone with a paired device can search and open your private issues and pull requests through this daemon."
            >
                <SettingsRow label="Status" testID="integrations-github-status" {...(detail === null ? {} : { detail })}>
                    <span data-testid="integrations-github-status-line" style={{ color: tokens.textSecondary }}>
                        {statusLine(status)}
                    </span>
                </SettingsRow>

                {manageable && status.available && !status.connected ? (
                    <SettingsRow
                        label="Sign in with GitHub"
                        testID="integrations-github-connect"
                        detail="GitHub shows a page in your browser where you enter a one-time code. The daemon waits for GitHub's answer itself, so Settings can close in the meantime."
                    >
                        <SettingsButton
                            testID="integrations-github-connect-button"
                            tone="accent"
                            disabled={starting || code !== null}
                            onClick={connect}
                        >
                            {starting ? 'Starting…' : 'Connect…'}
                        </SettingsButton>
                    </SettingsRow>
                ) : null}

                {manageable && code !== null ? (
                    <div data-testid="integrations-github-code" className="flex flex-col gap-2">
                        <span className="text-[12px]" style={{ color: tokens.textPrimary }}>
                            Enter this code at GitHub:
                        </span>
                        <div className="flex items-center gap-2">
                            <span
                                data-testid="integrations-github-user-code"
                                className="select-text font-mono text-[20px] font-semibold tracking-[0.12em]"
                                style={{ color: tokens.textPrimary, userSelect: 'text' }}
                            >
                                {code.userCode}
                            </span>
                            <SettingsButton testID="integrations-github-copy" onClick={copyCode}>
                                {copied ? 'Copied' : 'Copy'}
                            </SettingsButton>
                        </div>
                        <div className="flex items-center gap-2">
                            <SettingsButton testID="integrations-github-open" tone="accent" onClick={openVerification}>
                                Open GitHub
                            </SettingsButton>
                            <SettingsButton testID="integrations-github-cancel" onClick={cancel}>
                                Cancel
                            </SettingsButton>
                            <span
                                data-testid="integrations-github-countdown"
                                className="ml-auto text-[11px] tabular-nums"
                                style={{ color: tokens.textTertiary }}
                            >
                                Waiting for GitHub. The code expires in {formatCountdown(remaining)}.
                            </span>
                        </div>
                    </div>
                ) : null}

                {manageable && !status.available ? (
                    <SettingsDetail>
                        <span data-testid="integrations-github-no-oauth">
                            This build of Kelpi has no GitHub OAuth app, so signing in through the browser is not
                            available. Connect with a personal access token below.
                        </span>
                    </SettingsDetail>
                ) : null}

                {manageable && hasCredential ? (
                    <SettingsRow
                        label="Disconnect"
                        testID="integrations-github-disconnect"
                        detail={
                            <span>
                                Kelpi forgets the saved credential. It cannot revoke the authorization on GitHub itself;
                                do that in{' '}
                                <button
                                    type="button"
                                    data-testid="integrations-github-grants"
                                    className="underline"
                                    style={{ color: tokens.accent }}
                                    onClick={() => {
                                        openGitHubURL(GITHUB_AUTHORIZED_APPS_URL, props.onOpenURL);
                                    }}
                                >
                                    your GitHub application settings
                                </button>
                                .
                            </span>
                        }
                    >
                        <SettingsButton
                            testID="integrations-github-disconnect-button"
                            tone="danger"
                            disabled={unlinking}
                            onClick={disconnect}
                        >
                            {unlinking ? 'Disconnecting…' : 'Disconnect'}
                        </SettingsButton>
                    </SettingsRow>
                ) : null}

                {manageable ? null : (
                    <SettingsDetail>
                        <span data-testid="integrations-github-readonly">
                            Only the owner of this daemon can connect or disconnect GitHub. This session is a paired
                            device, so it shows the status but cannot change it.
                        </span>
                    </SettingsDetail>
                )}

                {notice === null ? null : (
                    <span
                        data-testid="integrations-github-notice"
                        role="status"
                        className="text-[11px]"
                        style={{ color: notice.tone === 'error' ? FAILURE_TONE : tokens.textSecondary }}
                    >
                        {notice.text}
                    </span>
                )}
            </SettingsSection>

            {manageable ? (
                <SettingsSection
                    title="Other ways to connect"
                    testID="integrations-github-token"
                    hint="A classic token needs the repo scope. A fine-grained token works for the repositories you grant it. The daemon checks the token with GitHub before it keeps it, and replaces any credential already saved."
                >
                    <SettingsRow label="Personal access token" testID="integrations-github-token-row">
                        <input
                            data-testid="integrations-github-token-input"
                            aria-label="GitHub personal access token"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            className="w-56 rounded border px-2 py-1 text-[12px]"
                            style={{
                                background: tokens.surfaceBackground,
                                borderColor: tokens.divider,
                                color: tokens.textPrimary
                            }}
                            placeholder="ghp_… or github_pat_…"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') submitToken();
                            }}
                        />
                        <SettingsButton
                            testID="integrations-github-token-button"
                            disabled={token.trim() === '' || tokenBusy}
                            onClick={submitToken}
                        >
                            {tokenBusy ? 'Checking…' : 'Connect with token'}
                        </SettingsButton>
                    </SettingsRow>
                    {tokenError === null && tokenWarnings.length === 0 ? null : (
                        <div className="flex flex-col gap-1">
                            {tokenError === null ? null : (
                                <span data-testid="integrations-github-token-error" className="text-[11px]" style={{ color: FAILURE_TONE }}>
                                    {tokenError}
                                </span>
                            )}
                            {tokenWarnings.map((warning, index) => (
                                <span
                                    key={`${String(index)}:${warning}`}
                                    data-testid={`integrations-github-token-warning-${String(index)}`}
                                    className="text-[11px]"
                                    style={{ color: tokens.textSecondary }}
                                >
                                    {warning}
                                </span>
                            ))}
                        </div>
                    )}
                </SettingsSection>
            ) : null}

            <SettingsSection
                title="Searchable repositories"
                testID="integrations-repos"
                hint="A ticket can start a workspace only in a repository registered in Settings ▸ Repositories. Typed searches look in the GitHub accounts and organizations that own these; your own pull requests, review requests and assigned issues are listed from anywhere on GitHub."
            >
                {searchable.github.length === 0 ? (
                    <SettingsDetail>
                        <span data-testid="integrations-repos-empty">
                            No registered repository has a GitHub remote yet. Add one in Settings ▸ Repositories.
                        </span>
                    </SettingsDetail>
                ) : null}
                {searchable.github.map((entry) => (
                    <SettingsRow
                        key={entry.repo}
                        label={entry.repo}
                        detail={entry.names.join(', ')}
                        testID={`integrations-repo-${entry.repo}`}
                    />
                ))}
                {searchable.other.length === 0 ? null : (
                    <SettingsDetail>
                        <span data-testid="integrations-repos-other">
                            Not searched (no GitHub remote): {searchable.other.join(', ')}.
                        </span>
                    </SettingsDetail>
                )}
            </SettingsSection>
        </div>
    );
}
