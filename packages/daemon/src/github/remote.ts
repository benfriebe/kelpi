/**
 * `origin` URL → the GitHub repository it names (workspace-feature.md §11.1).
 *
 * Pure string work. Remote URLs can carry credentials (`https://<token>@github.com/...`), so the
 * parsed result keeps only the host, owner and name, and nothing here logs.
 */

export interface GitHubRepoRef {
    /** Lowercased; `github.com` for every spelling of github.com itself. */
    readonly host: string;
    readonly owner: string;
    readonly name: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Spellings that are github.com itself (`ssh.github.com` is its port-443 SSH endpoint). */
const GITHUB_ALIASES = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

function canonicalHost(host: string): string {
    const lowered = host.toLowerCase();
    return GITHUB_ALIASES.has(lowered) ? 'github.com' : lowered;
}

function fromPath(host: string, rawPath: string): GitHubRepoRef | null {
    const trimmed = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    const parts = trimmed.split('/');
    if (parts.length !== 2) return null;
    const [owner, name] = parts as [string, string];
    if (!SEGMENT.test(owner) || !SEGMENT.test(name) || name === '.' || name === '..') return null;
    if (host === '' || !/^[A-Za-z0-9.-]+$/.test(host)) return null;
    return { host: canonicalHost(host), owner, name };
}

/**
 * https/http, `ssh://` and `git://` URLs, and scp-like `[user@]host:owner/name`. Userinfo and a
 * port are dropped, a trailing `.git` or `/` is ignored. Anything else (a local path, a URL with
 * more than owner/name in its path) is null.
 */
export function parseGitHubRemote(remoteURL: string | null | undefined): GitHubRepoRef | null {
    if (remoteURL === null || remoteURL === undefined) return null;
    const raw = remoteURL.trim();
    if (raw === '') return null;
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
    if (scheme !== null) {
        const protocol = (scheme[1] as string).toLowerCase();
        if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(protocol)) return null;
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            return null;
        }
        return fromPath(url.hostname, decodeURIComponent(url.pathname));
    }
    // scp-like: `[user@]host:path`, where host has no slash and path does not start with `/`
    // (git reads `host:/abs` as an absolute path on that host, never a GitHub repo).
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(raw);
    if (scp === null) return null;
    return fromPath(scp[1] as string, scp[2] as string);
}
