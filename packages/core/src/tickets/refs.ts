/**
 * Ticket references and GitHub remotes (docs/integrations.md "References").
 *
 * Two parsers that decide what Kelpi will fetch and where it will push, so both are strict about
 * the characters they let through and lenient about the spellings people actually paste:
 *
 *   - `parseTicketRef` reads what a user hands the picker or `kelpi workspace create --from`: an
 *     issue or pull request page (`https://github.com/o/r/pull/418`, with or without the scheme,
 *     with `/files`, `/commits` or `/checks` after it, a `#issuecomment-…` fragment, a query, a
 *     trailing slash) or the short form `o/r#418`. The short form cannot say whether 418 is an
 *     issue or a pull request (GitHub numbers both from one sequence), so its `kind` is null and the
 *     API answers it.
 *   - `parseGitHubRemote` reads a registered repository's remote URL, so a ticket can be matched to
 *     the checkout it belongs to: scp-like `git@github.com:o/r.git`, `ssh://`, `https://` (with or
 *     without a user, and with a token in it, which is never returned), and SSH host aliases
 *     `github.com-<anything>` (`git@github.com-work:o/r.git`, the usual way to keep two accounts
 *     apart in `~/.ssh/config`).
 *
 * Owner and repository names are checked against GitHub's own character sets before anything is
 * returned (`isGitHubOwner`, `isGitHubRepoName`): they end up in fetch URLs, refspecs, branch names
 * and folder names, and a name that starts with `-` or holds a `/` or `..` must never get there.
 */

import { TICKET_REF_MAX_LENGTH, type TicketKind, type TicketProvider } from '@kelpi/protocol';

/**
 * A GitHub login: letters, digits, `-` and `_` (Enterprise Managed Users' `name_shortcode`), not
 * starting with `-` or `_`, at most 39 characters.
 */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

/** A repository name: letters, digits, `.`, `_`, `-`, at most 100, not `.`/`..`, not starting with `-`. */
const REPO_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

/** The largest issue number GitHub hands out (a signed 32-bit integer). */
const MAX_TICKET_NUMBER = 2_147_483_647;

export function isGitHubOwner(value: string): boolean {
    return OWNER_PATTERN.test(value);
}

export function isGitHubRepoName(value: string): boolean {
    return REPO_NAME_PATTERN.test(value) && value !== '.' && value !== '..';
}

function ticketNumber(text: string): number | null {
    if (!/^[1-9][0-9]{0,9}$/.test(text)) return null;
    const value = Number(text);
    return value <= MAX_TICKET_NUMBER ? value : null;
}

export interface GitHubTicketRef {
    readonly provider: 'github';
    readonly owner: string;
    /** The repository's name alone. */
    readonly name: string;
    /** `owner/name`, the spelling every wire field uses. */
    readonly repo: string;
    readonly number: number;
    /** From a `/pull/` or `/issues/` URL; null for `owner/name#n`, which only the API can answer. */
    readonly kind: TicketKind | null;
}

function gitHubRef(owner: string, name: string, number: number, kind: TicketKind | null): GitHubTicketRef | null {
    if (!isGitHubOwner(owner) || !isGitHubRepoName(name)) return null;
    return { provider: 'github', owner, name, repo: `${owner}/${name}`, number, kind };
}

/** What may follow `/pull/<n>/` on a pull request page (and anything after it). */
const PULL_REQUEST_TABS: ReadonlySet<string> = new Set(['files', 'commits', 'checks', 'changes']);

/**
 * A GitHub issue or pull request reference, or null (module note). Surrounding whitespace is
 * ignored; the scheme may be `https`, `http` or missing; the host is `github.com` or
 * `www.github.com`; a URL with credentials or a port is refused.
 */
export function parseTicketRef(raw: string): GitHubTicketRef | null {
    const text = raw.trim();
    if (text === '' || text.length > TICKET_REF_MAX_LENGTH) return null;

    const short = /^([^/\s#]+)\/([^/\s#]+)#([0-9]+)$/.exec(text);
    if (short !== null) {
        const number = ticketNumber(short[3] as string);
        return number === null ? null : gitHubRef(short[1] as string, short[2] as string, number, null);
    }

    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
    if (url.username !== '' || url.password !== '' || url.port !== '') return null;

    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const [owner, name, type, numberText, tab] = segments;
    if (owner === undefined || name === undefined || numberText === undefined) return null;
    const number = ticketNumber(numberText);
    if (number === null) return null;
    if (type === 'issues') {
        return segments.length === 4 ? gitHubRef(owner, name, number, 'issue') : null;
    }
    if (type === 'pull') {
        if (tab !== undefined && !PULL_REQUEST_TABS.has(tab)) return null;
        return gitHubRef(owner, name, number, 'pr');
    }
    return null;
}

export interface GitHubRemote {
    readonly owner: string;
    readonly name: string;
    /** `owner/name`. */
    readonly repo: string;
    /** The host as written: `github.com`, `ssh.github.com`, or an alias such as `github.com-work`. */
    readonly host: string;
    readonly protocol: 'ssh' | 'https';
}

/** `[user@]host:[/]owner/name[.git][/]`, scp-like, which is what `git clone git@…` writes. */
const SCP_REMOTE = /^((?:[^@/\s]+@)?([^/:\s]+):\/?)([^/\s]+)\/([^/\s]+?)((?:\.git)?\/?)$/;

/** `scheme://[user[:pass]@]host[:port]/owner/name[.git][/]`. */
const URL_REMOTE = /^(((?:git\+)?ssh|https?):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::[0-9]+)?\/)([^/\s]+)\/([^/\s]+?)((?:\.git)?\/?)$/;

/** An SSH host GitHub answers: itself, its port-443 SSH host, or a `~/.ssh/config` alias of it. */
function isGitHubSSHHost(host: string): boolean {
    const lower = host.toLowerCase();
    return lower === 'github.com' || lower === 'ssh.github.com' || /^github\.com-[A-Za-z0-9_.-]+$/.test(lower);
}

function isGitHubHTTPSHost(host: string): boolean {
    const lower = host.toLowerCase();
    return lower === 'github.com' || lower === 'www.github.com';
}

interface RemoteParts {
    /** Everything before the owner, verbatim. */
    readonly prefix: string;
    readonly owner: string;
    readonly name: string;
    /** `.git`, `/`, `.git/` or nothing, verbatim. */
    readonly suffix: string;
    readonly remote: GitHubRemote;
}

function remoteParts(url: string): RemoteParts | null {
    const text = url.trim();
    if (text === '' || text.length > TICKET_REF_MAX_LENGTH) return null;
    let prefix: string;
    let host: string;
    let owner: string;
    let name: string;
    let suffix: string;
    let protocol: 'ssh' | 'https';
    const asURL = URL_REMOTE.exec(text);
    if (asURL !== null) {
        prefix = asURL[1] as string;
        const scheme = (asURL[2] as string).toLowerCase();
        host = asURL[3] as string;
        owner = asURL[4] as string;
        name = asURL[5] as string;
        suffix = asURL[6] as string;
        protocol = scheme === 'http' || scheme === 'https' ? 'https' : 'ssh';
        if (protocol === 'https' ? !isGitHubHTTPSHost(host) : !isGitHubSSHHost(host)) return null;
    } else {
        const scp = SCP_REMOTE.exec(text);
        if (scp === null) return null;
        prefix = scp[1] as string;
        host = scp[2] as string;
        owner = scp[3] as string;
        name = scp[4] as string;
        suffix = scp[5] as string;
        protocol = 'ssh';
        if (!isGitHubSSHHost(host)) return null;
    }
    if (!isGitHubOwner(owner) || !isGitHubRepoName(name)) return null;
    return { prefix, owner, name, suffix, remote: { owner, name, repo: `${owner}/${name}`, host, protocol } };
}

/** The GitHub repository a remote URL points at, or null for anything else (module note). */
export function parseGitHubRemote(url: string): GitHubRemote | null {
    return remoteParts(url)?.remote ?? null;
}

/**
 * The URL the repository registry keeps for a remote (`repo.remoteURL`): the one git uses
 * (`git remote get-url`, `url.<base>.insteadOf` applied), unless only the one as written in the
 * config names a GitHub repository (a GitHub URL that `insteadOf` rewrites onto a mirror or a local
 * path), then that one. The same either-spelling rule the daemon matches tickets by
 * (`remoteFetchesFrom`), so every reader of the registry (the Integrations tab's searchable
 * repositories) agrees with the daemon about which repository is on GitHub.
 */
export function registryRemoteURL(asUsed: string, asWritten: string | null): string {
    if (parseGitHubRemote(asUsed) !== null || asWritten === null) return asUsed;
    return parseGitHubRemote(asWritten) !== null ? asWritten : asUsed;
}

/**
 * The same remote URL pointed at another repository: only `owner/name` changes, so the scheme, the
 * user, an SSH host alias and a `.git` suffix all carry over (a fork's push URL is built this way
 * from the base remote's, so it authenticates exactly as the base remote does). Null when `url`
 * is not a GitHub remote or the new names are not valid.
 */
export function replaceGitHubRemoteRepo(url: string, owner: string, name: string): string | null {
    const parts = remoteParts(url);
    if (parts === null || !isGitHubOwner(owner) || !isGitHubRepoName(name)) return null;
    return `${parts.prefix}${owner}/${name}${parts.suffix}`;
}

/** `owner/name` as GitHub compares it: case-insensitively. */
export function gitHubRepoKey(repo: string): string {
    return repo.toLowerCase();
}

/** Whether two `owner/name` spellings are the same repository. */
export function sameGitHubRepo(a: string, b: string): boolean {
    return gitHubRepoKey(a) === gitHubRepoKey(b);
}

/** `#418`: what a GitHub ticket is called in a workspace name, a prompt and the CLI's output. */
export function gitHubTicketKey(number: number): string {
    return `#${number}`;
}

/** The ticket's page: `https://github.com/<owner>/<name>/(pull|issues)/<n>`. */
export function gitHubTicketURL(repo: string, kind: TicketKind, number: number): string {
    return `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`;
}

export interface TicketIdentityInput {
    readonly provider: TicketProvider;
    /** `owner/name` (GitHub). */
    readonly repo: string;
    readonly number: number | null;
    /** `#418`, `ENG-123`. */
    readonly key: string;
}

/**
 * One string per ticket, for "is this ticket already open somewhere" and for the resolve cache:
 * `github:acme/api#418` (the repository lowercased, as GitHub compares it). A provider whose
 * tickets have no number is keyed by its uppercased key (`linear:ENG-123`).
 */
export function ticketIdentity(ticket: TicketIdentityInput): string {
    if (ticket.provider === 'github' && ticket.number !== null) return `github:${gitHubRepoKey(ticket.repo)}#${ticket.number}`;
    return `${ticket.provider}:${ticket.key.toUpperCase()}`;
}

/**
 * The distinct GitHub owners (lowercased logins, first-seen order) of a set of remote URLs: the
 * registered repositories' `remoteURL`s, which scope a typed ticket search to the accounts and
 * organizations the user actually works in (`buildTicketSearchQueries`).
 */
export function gitHubOwnersFromRemotes(remoteURLs: readonly (string | null | undefined)[]): string[] {
    const owners: string[] = [];
    const seen = new Set<string>();
    for (const url of remoteURLs) {
        if (url === null || url === undefined) continue;
        const remote = parseGitHubRemote(url);
        if (remote === null) continue;
        const owner = remote.owner.toLowerCase();
        if (seen.has(owner)) continue;
        seen.add(owner);
        owners.push(owner);
    }
    return owners;
}
