/**
 * The New Workspace sheet's ticket picker (shell-ui.md §10.1, docs/integrations.md): find a
 * GitHub issue or pull request to start a workspace from.
 *
 * A SUB-SHEET over the New Workspace sheet, hung exactly where the repo picker hangs (its own
 * dimming layer, the sheet's top edge and width), and closed the same way: Escape and a click on
 * its layer close the picker only, innermost first. The sheet owns that layer and the Escape;
 * this component is the panel inside it.
 *
 * The rules that are contracts rather than styling:
 *
 *   - **An empty query is the three `@me` lists** (`ticket-search` with `query: ''`): your open
 *     pull requests, the ones waiting for your review, the issues assigned to you. They load the
 *     moment the picker opens.
 *   - **Typed text searches after a pause.** 300 ms after the last keystroke
 *     (`TICKET_SEARCH_DEBOUNCE_MS`), and only from two characters (`TICKET_SEARCH_MIN_CHARS`):
 *     GitHub's search API allows 30 requests a minute, and one per keystroke would spend that in
 *     a sentence.
 *   - **A late answer never overwrites a newer one.** Every search carries a sequence number and a
 *     reply for an older one is dropped, so a slow `ret` cannot land over a fast `retry`. The
 *     resolve that follows a pick is sequenced the same way.
 *   - **A pasted link resolves at once.** A paste that leaves the field holding a GitHub issue or
 *     pull request URL, or `owner/name#n` (`parseTicketRef`), skips the search and looks the
 *     ticket up straight away; the same text TYPED offers one "Open owner/name#n" row instead,
 *     because typing passes through `acme/api#4` on its way to `acme/api#41`.
 *   - **A ticket whose repository is not registered is listed, dimmed, and cannot be picked**: a
 *     workspace from it would have no checkout to open. The row says what to do ("Add owner/name
 *     in Settings ▸ Repositories") rather than the list hiding it and leaving the user to wonder.
 *   - **Every way it can fail says how to get past it** (`TicketProblem`, shared with the sheet,
 *     which shows the same states for a create the daemon refused with a `ticket_error`): not
 *     connected (open Settings ▸ Integrations), rate limited (when to retry), SAML SSO required
 *     (Authorize, which opens GitHub's own page), the organization restricts OAuth Apps (request
 *     access on GitHub, or connect with a personal access token instead). Every page it opens
 *     passes `isGitHubWebURL` first (`openGitHubURL`).
 *   - **Keyboard**: the field keeps the caret; ↑/↓ move the highlight over the rows that can be
 *     picked (a dimmed row is skipped), Return picks, Tab cycles the picker's own controls.
 *
 * Picking a row (or the typed reference) resolves it (`ticket-resolve`) while the picker stays up
 * saying so; the sheet gets the resolve reply and prefills itself from it, and a resolve that
 * fails stays in the picker with its way out.
 */

import {
    isGitHubWebURL,
    parseIntegrationFailure,
    parseTicketResolveReply,
    parseTicketSearchReply,
    type IntegrationFailureInfo,
    type TicketResolveReply,
    type TicketSearchReply,
    type TicketSearchSectionID,
    type TicketSummary,
    type WsIntegrationStatus
} from '@kelpi/protocol';
import { parseTicketRef } from '@kelpi/core/tickets';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';

import { openGitHubURL } from './github-links';
import { withAlpha } from './theme';
import { tokens } from './tokens';

/** How long the picker waits after the last keystroke before it searches. */
export const TICKET_SEARCH_DEBOUNCE_MS = 300;
/** Typed text shorter than this (trimmed) does not search: too broad to be worth a request. */
export const TICKET_SEARCH_MIN_CHARS = 2;

/** A search, as the picker reads it: the reply, or the failure with its way out. */
export type TicketSearchOutcome =
    | { readonly ok: true; readonly reply: TicketSearchReply }
    | { readonly ok: false; readonly failure: IntegrationFailureInfo };

/** A resolve, the same way. */
export type TicketResolveOutcome =
    | { readonly ok: true; readonly reply: TicketResolveReply }
    | { readonly ok: false; readonly failure: IntegrationFailureInfo };

/**
 * Everything the sheet and the picker need from the host to work with tickets. Assembly builds it
 * over `CommandClient` and the store; absent (the phone shell, the group sheet, a daemon that
 * predates integrations) means the sheet offers no From ticket at all.
 */
export interface TicketSource {
    /** GitHub's status on this daemon (`welcome.integrations`), or null when it reported none. */
    readonly status: WsIntegrationStatus | null;
    search(query: string): Promise<TicketSearchOutcome>;
    resolve(ref: string): Promise<TicketResolveOutcome>;
    /** Settings ▸ Integrations: the way out of "not connected", and the token path for org restrictions. */
    openIntegrationSettings(): void;
    /** A GitHub page (an SSO or OAuth App page). Called only with an `isGitHubWebURL` URL. Default: `openGitHubURL`. */
    readonly openURL?: ((url: string) => void) | undefined;
    /** A workspace's name for the sheet's "already open" banner, or null when the mirror lacks it. */
    workspaceName(workspaceID: string): string | null;
    /** The banner's Switch to it. */
    switchToWorkspace(workspaceID: string): void;
}

/** A thrown command (a timeout, a dropped connection) as a failure the states can show. */
export function ticketFailureFromError(error: unknown): IntegrationFailureInfo {
    return { error: error instanceof Error ? error.message : String(error), code: null };
}

/** The failure a reply that is neither a success nor a readable failure stands for. */
function unreadable(what: string): IntegrationFailureInfo {
    return { error: `the daemon's ${what} reply could not be read`, code: null };
}

/** A raw `ticket-search` reply → the outcome, with the protocol's own readers. */
export function readTicketSearch(raw: unknown): TicketSearchOutcome {
    const reply = parseTicketSearchReply(raw);
    if (reply !== null) return { ok: true, reply };
    return { ok: false, failure: parseIntegrationFailure(raw) ?? unreadable('search') };
}

/** A raw `ticket-resolve` reply → the outcome. */
export function readTicketResolve(raw: unknown): TicketResolveOutcome {
    const reply = parseTicketResolveReply(raw);
    if (reply !== null) return { ok: true, reply };
    return { ok: false, failure: parseIntegrationFailure(raw) ?? unreadable('ticket lookup') };
}

/** `42 s` under a minute, `3 min` after: when to try again after a rate limit. */
export function formatRetryAfter(seconds: number): string {
    const safe = Math.max(0, Math.ceil(seconds));
    if (safe < 60) return `${String(safe)} s`;
    return `${String(Math.ceil(safe / 60))} min`;
}

/** The headings over the picker's lists. */
export const TICKET_SECTION_TITLES: Readonly<Record<TicketSearchSectionID, string>> = {
    authored: 'Your open pull requests',
    'review-requested': 'Waiting for your review',
    assigned: 'Issues assigned to you',
    results: 'Results'
};

/** A failure for a GitHub status that cannot search at all, before anything is asked. */
export function statusProblem(status: WsIntegrationStatus | null): IntegrationFailureInfo | null {
    if (status === null) return { error: 'This daemon cannot link a GitHub account.', code: 'unavailable' };
    if (status.connected) return null;
    if (status.problem === 'revoked') {
        return { error: 'GitHub no longer accepts the credential Kelpi has (revoked or expired).', code: 'unauthorized' };
    }
    if (status.problem === 'unreadable') {
        return { error: 'Kelpi could not read its saved GitHub credential.', code: 'not-connected' };
    }
    return { error: 'No GitHub account is connected to this daemon.', code: 'not-connected' };
}

const FAILURE = '#E0655C';

export interface TicketProblemProps {
    readonly failure: IntegrationFailureInfo;
    /** Settings ▸ Integrations. The sheet closes itself first: Settings is its own modal. */
    readonly onOpenSettings: () => void;
    /** Opens a GitHub page; only ever handed an `isGitHubWebURL` URL. */
    readonly onOpenURL?: ((url: string) => void) | undefined;
    /** Try the same request again (a rate limit, a timeout). Absent = no Retry. */
    readonly onRetry?: (() => void) | undefined;
    /** `data-testid` prefix: `ticket-picker-problem` in the picker, `new-workspace-ticket-problem` in the sheet. */
    readonly testID: string;
    /** Each button as it mounts (`ticketProblemButtons`' ids), so a host's own Tab loop can reach it. */
    readonly buttonRef?: ((id: TicketProblemButtonID, element: HTMLButtonElement | null) => void) | undefined;
}

/** What a problem's buttons do: open Settings ▸ Integrations, retry, or open a GitHub page. */
export type TicketProblemButtonID = 'settings' | 'retry' | 'authorize' | 'request';

export interface TicketProblemView {
    readonly title: string;
    readonly body: string;
    readonly buttons: readonly { readonly id: TicketProblemButtonID; readonly label: string }[];
}

/**
 * A failure's words and ways out, without drawing them: the component below draws this, and a
 * host with its own Tab loop (the New Workspace sheet) reads the button ids from it.
 */
export function ticketProblemView(failure: IntegrationFailureInfo, options: { readonly retry: boolean }): TicketProblemView {
    const buttons: { id: TicketProblemButtonID; label: string }[] = [];
    const retry = (): void => {
        if (options.retry) buttons.push({ id: 'retry', label: 'Try again' });
    };
    switch (failure.code) {
        case 'not-connected':
        case 'unauthorized':
            buttons.push({ id: 'settings', label: 'Open Settings ▸ Integrations' });
            return {
                title: failure.code === 'unauthorized' ? 'GitHub refused Kelpi’s credential' : 'GitHub is not connected',
                body: 'Connect a GitHub account in Settings ▸ Integrations to search for issues and pull requests and start workspaces from them.',
                buttons
            };
        case 'rate-limited':
            retry();
            return {
                title: 'GitHub’s rate limit is used up',
                body:
                    failure.retry_after_s === undefined
                        ? 'GitHub is refusing more requests for now. Try again in a minute.'
                        : `GitHub is refusing more requests for now. Try again in ${formatRetryAfter(failure.retry_after_s)}.`,
                buttons
            };
        case 'sso-required':
            if (failure.sso_url !== undefined && isGitHubWebURL(failure.sso_url)) buttons.push({ id: 'authorize', label: 'Authorize on GitHub' });
            retry();
            return {
                title: 'This organization requires single sign-on',
                body: 'Its SAML SSO has not authorized Kelpi’s GitHub credential. Authorize it on GitHub, then try again.',
                buttons
            };
        case 'org-restricted':
            if (failure.settings_url !== undefined && isGitHubWebURL(failure.settings_url)) {
                buttons.push({ id: 'request', label: 'Request access on GitHub' });
            }
            buttons.push({ id: 'settings', label: 'Use a token instead' });
            return {
                title: 'This organization has not approved Kelpi',
                body: 'It restricts which OAuth Apps can read its repositories. Ask for access on GitHub, or connect with a personal access token in Settings ▸ Integrations instead.',
                buttons
            };
        case 'unavailable':
            return { title: 'GitHub is not available', body: failure.error, buttons };
        case 'not-found':
            return { title: 'Ticket not found', body: failure.error, buttons };
        case 'bad-ref':
            return { title: 'Not a ticket link', body: failure.error, buttons };
        default:
            retry();
            return { title: 'GitHub could not be reached', body: failure.error, buttons };
    }
}

/** The ids of the buttons a failure offers, in drawing order. */
export function ticketProblemButtons(failure: IntegrationFailureInfo, options: { readonly retry: boolean }): readonly TicketProblemButtonID[] {
    return ticketProblemView(failure, options).buttons.map((button) => button.id);
}

/**
 * A ticket request that failed, with its way out. One component for the picker and the sheet, so
 * "not connected" or "authorize SSO" reads the same wherever it surfaces.
 */
export function TicketProblem(props: TicketProblemProps): ReactElement {
    const { failure, testID } = props;
    const open = (url: string | undefined): void => {
        if (url === undefined || !isGitHubWebURL(url)) return;
        if (props.onOpenURL !== undefined) props.onOpenURL(url);
        else openGitHubURL(url);
    };
    const view = ticketProblemView(failure, { retry: props.onRetry !== undefined });
    const run = (id: TicketProblemButtonID): void => {
        switch (id) {
            case 'settings':
                props.onOpenSettings();
                return;
            case 'retry':
                props.onRetry?.();
                return;
            case 'authorize':
                open(failure.sso_url);
                return;
            case 'request':
                open(failure.settings_url);
        }
    };
    // The daemon's own words, when the title and body did not already say them.
    const detail = view.body === failure.error ? null : failure.error;
    return (
        <div
            data-testid={testID}
            data-code={failure.code ?? 'unknown'}
            role="alert"
            className="flex flex-col gap-1.5 rounded border p-2.5 text-[11px]"
            style={{ borderColor: withAlpha(FAILURE, 0.6), background: withAlpha(FAILURE, 0.06) }}
        >
            <span data-testid={`${testID}-title`} className="font-semibold" style={{ color: tokens.textPrimary }}>
                {view.title}
            </span>
            <span style={{ color: tokens.textSecondary }}>{view.body}</span>
            {detail === null ? null : (
                <span data-testid={`${testID}-detail`} className="text-[10px]" style={{ color: tokens.textTertiary }}>
                    {detail}
                </span>
            )}
            {view.buttons.length === 0 ? null : (
                <div className="flex flex-wrap gap-2 pt-0.5">
                    {view.buttons.map((button) => (
                        <button
                            key={button.id}
                            ref={(element) => {
                                props.buttonRef?.(button.id, element);
                            }}
                            type="button"
                            data-testid={`${testID}-${button.id}`}
                            className="rounded border px-2 py-0.5 text-[11px]"
                            style={{ borderColor: tokens.divider, color: tokens.accent }}
                            onClick={() => {
                                run(button.id);
                            }}
                        >
                            {button.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/** One thing Return can pick: the typed reference, or a listed ticket. */
type PickTarget =
    | { readonly kind: 'ref'; readonly ref: string; readonly label: string }
    | { readonly kind: 'ticket'; readonly ticket: TicketSummary };

type SearchState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'short' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'results'; readonly reply: TicketSearchReply }
    | { readonly kind: 'failed'; readonly failure: IntegrationFailureInfo };

export interface TicketPickerProps {
    readonly source: TicketSource;
    /** The ticket resolved: the sheet prefills from the reply and closes the picker. */
    readonly onResolved: (reply: TicketResolveReply) => void;
    readonly onCancel: () => void;
    /** Settings ▸ Integrations, the sheet closing itself first. */
    readonly onOpenSettings: () => void;
}

/** `#418` and the repository, the words a row and the "Looking up" line use. */
function ticketLabel(ticket: TicketSummary): string {
    return `${ticket.repo}${ticket.key}`;
}

export function TicketPicker(props: TicketPickerProps): ReactElement {
    const { source } = props;
    const connectedProblem = statusProblem(source.status);
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
    const [highlight, setHighlight] = useState(0);
    const [resolving, setResolving] = useState<string | null>(null);
    const [resolveFailure, setResolveFailure] = useState<IntegrationFailureInfo | null>(null);
    const searchSeq = useRef(0);
    const resolveSeq = useRef(0);
    const lastSearched = useRef<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pasted = useRef(false);
    const panel = useRef<HTMLDivElement | null>(null);
    const input = useRef<HTMLInputElement | null>(null);
    // A reply landing after the picker closed must not set state into the void.
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            if (timer.current !== null) clearTimeout(timer.current);
        };
    }, []);

    const runSearch = useCallback(
        (text: string): void => {
            searchSeq.current += 1;
            const seq = searchSeq.current;
            lastSearched.current = text;
            setSearch({ kind: 'loading' });
            source.search(text).then(
                (outcome) => {
                    if (!alive.current || seq !== searchSeq.current) return;
                    setSearch(outcome.ok ? { kind: 'results', reply: outcome.reply } : { kind: 'failed', failure: outcome.failure });
                    setHighlight(0);
                },
                (error: unknown) => {
                    if (!alive.current || seq !== searchSeq.current) return;
                    setSearch({ kind: 'failed', failure: ticketFailureFromError(error) });
                }
            );
        },
        [source]
    );

    const resolve = (ref: string, label: string): void => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        // Any search still out is now moot: its answer must not repaint the list under the lookup.
        searchSeq.current += 1;
        resolveSeq.current += 1;
        const seq = resolveSeq.current;
        setResolving(label);
        setResolveFailure(null);
        source.resolve(ref).then(
            (outcome) => {
                if (!alive.current || seq !== resolveSeq.current) return;
                setResolving(null);
                if (outcome.ok) props.onResolved(outcome.reply);
                else setResolveFailure(outcome.failure);
            },
            (error: unknown) => {
                if (!alive.current || seq !== resolveSeq.current) return;
                setResolving(null);
                setResolveFailure(ticketFailureFromError(error));
            }
        );
    };

    // The three default lists, as soon as there is a connected account to ask with (again if
    // the account connects while the picker is up).
    const connected = connectedProblem === null;
    useEffect(() => {
        if (!connected) return;
        if (lastSearched.current !== null) return;
        runSearch('');
    }, [connected, runSearch]);

    useEffect(() => {
        input.current?.focus();
    }, []);

    const typedRef = parseTicketRef(query.trim());
    const onChange = (next: string): void => {
        setQuery(next);
        setResolveFailure(null);
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        const wasPaste = pasted.current;
        pasted.current = false;
        if (!connected) return;
        const trimmed = next.trim();
        const ref = parseTicketRef(trimmed);
        if (ref !== null) {
            // A pasted link is a decision already made: look it up now. Typed, it is offered as
            // one row (it may still be on its way to a longer number).
            searchSeq.current += 1;
            setSearch({ kind: 'idle' });
            setHighlight(0);
            if (wasPaste) resolve(trimmed, `${ref.repo}#${String(ref.number)}`);
            return;
        }
        if (trimmed === '') {
            runSearch('');
            return;
        }
        if (trimmed.length < TICKET_SEARCH_MIN_CHARS) {
            searchSeq.current += 1;
            setSearch({ kind: 'short' });
            return;
        }
        timer.current = setTimeout(() => {
            timer.current = null;
            runSearch(trimmed);
        }, TICKET_SEARCH_DEBOUNCE_MS);
    };

    const sections = search.kind === 'results' ? search.reply.sections : [];
    const targets: PickTarget[] = useMemo(() => {
        if (typedRef !== null) {
            return [{ kind: 'ref', ref: query.trim(), label: `${typedRef.repo}#${String(typedRef.number)}` }];
        }
        return sections.flatMap((section) =>
            section.items.filter((item) => item.repo_id !== null).map((ticket): PickTarget => ({ kind: 'ticket', ticket }))
        );
        // `typedRef` is derived from `query`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, sections]);
    const activeIndex = Math.min(highlight, Math.max(0, targets.length - 1));
    const highlighted = targets[activeIndex];

    const pick = (target: PickTarget | undefined): void => {
        if (target === undefined || resolving !== null) return;
        if (target.kind === 'ref') resolve(target.ref, target.label);
        else resolve(target.ticket.url, ticketLabel(target.ticket));
    };

    const onKeyDown = (event: ReactKeyboardEvent): void => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (targets.length === 0) return;
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setHighlight((current) => (Math.min(current, targets.length - 1) + delta + targets.length) % targets.length);
            return;
        }
        if (event.key === 'Enter') {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            pick(highlighted);
            return;
        }
        if (event.key === 'Tab') {
            // The picker's own loop: its field and buttons, never the sheet dimmed behind it.
            const root = panel.current;
            if (root === null) return;
            const stops = [...root.querySelectorAll<HTMLElement>('input, button:not([disabled])')];
            const at = stops.indexOf(globalThis.document?.activeElement as HTMLElement);
            if (stops.length === 0) return;
            event.preventDefault();
            const next = stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
            next?.focus();
        }
    };

    const problem = connectedProblem ?? resolveFailure ?? (search.kind === 'failed' ? search.failure : null);
    const retry =
        resolveFailure !== null
            ? undefined
            : (): void => {
                  runSearch(lastSearched.current ?? '');
              };
    const warnings = search.kind === 'results' ? (search.reply.warnings ?? []) : [];
    let flatIndex = -1;

    return (
        <div ref={panel} data-testid="ticket-picker" className="flex flex-col gap-2" onKeyDown={onKeyDown}>
            <div className="text-[13px] font-semibold" style={{ color: tokens.textPrimary }}>
                Start from a ticket
            </div>
            <input
                ref={input}
                aria-label="Search issues and pull requests"
                data-testid="ticket-picker-search"
                placeholder="Search, or paste an issue or pull request link"
                className="w-full rounded border bg-transparent px-2 py-1.5 text-[12px] outline-none"
                style={{ borderColor: tokens.divider, color: tokens.textPrimary, userSelect: 'text' }}
                value={query}
                disabled={!connected}
                onPaste={() => {
                    pasted.current = true;
                }}
                onChange={(event) => {
                    onChange(event.target.value);
                }}
            />

            {resolving === null ? null : (
                <div data-testid="ticket-picker-resolving" className="text-[11px]" style={{ color: tokens.textSecondary }}>
                    Looking up {resolving}…
                </div>
            )}

            {problem === null ? null : (
                <TicketProblem
                    testID="ticket-picker-problem"
                    failure={problem}
                    onOpenSettings={props.onOpenSettings}
                    onOpenURL={source.openURL}
                    {...(connectedProblem === null && retry !== undefined ? { onRetry: retry } : {})}
                />
            )}

            {warnings.map((warning) => (
                <div key={warning} data-testid="ticket-picker-warning" className="text-[10px]" style={{ color: tokens.activeAgent }}>
                    {warning}
                </div>
            ))}

            <div
                data-testid="ticket-picker-list"
                role="listbox"
                aria-label="Issues and pull requests"
                className="flex max-h-[300px] min-h-[120px] flex-col gap-2 overflow-y-auto"
                style={resolving === null ? undefined : { opacity: 0.55 }}
            >
                {typedRef !== null && connected ? (
                    <button
                        type="button"
                        role="option"
                        aria-selected="true"
                        data-testid="ticket-picker-ref"
                        data-highlighted="true"
                        tabIndex={-1}
                        className="rounded px-2 py-1.5 text-left text-[12px]"
                        style={{ background: tokens.selectionFill, color: tokens.textPrimary }}
                        onClick={() => {
                            pick(targets[0]);
                        }}
                    >
                        Open {typedRef.repo}#{typedRef.number}
                    </button>
                ) : null}
                {search.kind === 'loading' ? (
                    <div data-testid="ticket-picker-loading" className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        Searching GitHub…
                    </div>
                ) : null}
                {search.kind === 'short' ? (
                    <div data-testid="ticket-picker-short" className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        Type at least {TICKET_SEARCH_MIN_CHARS} characters, or paste a link.
                    </div>
                ) : null}
                {sections.map((section) => (
                    <div key={section.id} data-testid={`ticket-picker-section-${section.id}`} className="flex flex-col gap-0.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: tokens.textTertiary }}>
                            {TICKET_SECTION_TITLES[section.id]}
                        </div>
                        {section.items.length === 0 ? (
                            <div className="px-2 text-[11px]" style={{ color: tokens.textTertiary }}>
                                {section.id === 'results' ? 'No open issue or pull request matches.' : 'None.'}
                            </div>
                        ) : null}
                        {section.items.map((ticket) => {
                            const pickable = ticket.repo_id !== null;
                            if (pickable) flatIndex += 1;
                            const index = flatIndex;
                            const lit = pickable && typedRef === null && index === activeIndex;
                            return (
                                <button
                                    key={`${section.id}:${ticket.repo}#${String(ticket.number)}`}
                                    type="button"
                                    role="option"
                                    aria-selected={lit}
                                    aria-disabled={!pickable}
                                    tabIndex={-1}
                                    data-testid={`ticket-picker-row-${ticket.repo}#${String(ticket.number)}`}
                                    data-pickable={pickable ? 'true' : 'false'}
                                    data-highlighted={lit ? 'true' : 'false'}
                                    className="flex flex-col rounded px-2 py-1 text-left"
                                    style={{
                                        background: lit ? tokens.selectionFill : 'transparent',
                                        opacity: pickable ? 1 : 0.5,
                                        cursor: pickable ? 'pointer' : 'default'
                                    }}
                                    onMouseEnter={() => {
                                        if (pickable) setHighlight(index);
                                    }}
                                    onClick={() => {
                                        if (pickable) pick({ kind: 'ticket', ticket });
                                    }}
                                >
                                    <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                                        <span
                                            className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase"
                                            style={{ background: withAlpha(tokens.textPrimary, 0.08), color: tokens.textSecondary }}
                                        >
                                            {ticket.kind === 'pr' ? (ticket.draft === true ? 'Draft PR' : 'PR') : 'Issue'}
                                        </span>
                                        <span className="shrink-0 tabular-nums" style={{ color: tokens.textSecondary }}>
                                            {ticket.key}
                                        </span>
                                        <span className="min-w-0 truncate" style={{ color: tokens.textPrimary }} title={ticket.title}>
                                            {ticket.title}
                                        </span>
                                    </span>
                                    <span className="truncate text-[10px]" style={{ color: tokens.textTertiary }}>
                                        {pickable
                                            ? `${ticket.repo}${ticket.author === null ? '' : ` · ${ticket.author}`}`
                                            : `Add ${ticket.repo} in Settings ▸ Repositories to start a workspace from it.`}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ))}
            </div>

            <div className="flex items-center">
                <button
                    type="button"
                    data-testid="ticket-picker-cancel"
                    className="rounded border px-2.5 py-1 text-[12px]"
                    style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                    onClick={props.onCancel}
                >
                    Cancel
                </button>
                <span className="ml-auto text-[10px]" style={{ color: tokens.textTertiary }}>
                    ↑↓ to choose, Return to open
                </span>
            </div>
        </div>
    );
}
