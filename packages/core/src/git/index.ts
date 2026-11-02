/**
 * Git naming rules shared by the daemon and every client (docs/app-state-core.md §4.2.1,
 * docs/graft-git.md §8.1).
 *
 * One implementation on purpose: the daemon sanitizes a worktree or branch name before any git
 * work, and a client previews (and, in the New Workspace sheet, autofills) the name the user is
 * about to get. The two used to be a transcription and its original, pinned together by a copied
 * test corpus; now they are the same function, so what the user reads is what git gets.
 *
 * Pure string work with no Node imports, so a browser bundle can take it.
 */

/**
 * `sanitizedGitName(name)`: safe as BOTH a path component and a git ref. Preserves case,
 * `/`, `.`, `_`, `-`; any other run (spaces, punctuation, non-ASCII, emoji) becomes one `-`;
 * repeated separators collapse; leading and trailing separators are trimmed. There is no length
 * limit. An already-valid name is a fixed point; nothing surviving → null.
 */
export function sanitizedGitName(name: string): string | null {
    let slug = name.replace(/[^A-Za-z0-9/._-]+/g, '-');
    slug = slug.replace(/-{2,}/g, '-');
    slug = slug.replace(/\/{2,}/g, '/');
    slug = slug.replace(/\.{2,}/g, '.');
    slug = slug.replace(/^[-/._ ]+/, '').replace(/[-/._ ]+$/, '');
    return slug === '' ? null : slug;
}

/**
 * `remoteURLWithoutSecrets(url)`: a remote URL fit for the repository registry, which every client
 * receives (`repo.remoteURL`). A credential can ride in a URL's userinfo
 * (`https://<token>@github.com/o/r`, `https://user:<token>@…`), so a URL with a scheme loses its
 * userinfo, except that an SSH URL keeps its user name (`ssh://git@github.com/…` names an account,
 * not a secret) and loses only a password. An scp-like `git@host:o/r` or a path has nowhere to
 * hold a password and is returned unchanged.
 */
export function remoteURLWithoutSecrets(url: string): string {
    // Greedy up to the last `@` before the path: a raw `@` in a password stays inside the userinfo.
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)@/.exec(url);
    if (match === null) return url;
    const scheme = match[1] as string;
    const user = /(^|\+)ssh(\+|$)/i.test(scheme) ? ((match[2] as string).split(':')[0] ?? '') : '';
    return `${scheme}://${user === '' ? '' : `${user}@`}${url.slice(match[0].length)}`;
}

export * from './pull-requests.js';
