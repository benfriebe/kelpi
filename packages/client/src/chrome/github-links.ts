/**
 * Opening a GitHub page the daemon named (docs/integrations.md): the device flow's verification
 * page, an SSO authorization or OAuth App settings page, a ticket's own page.
 *
 * Every one of those URLs arrives from the daemon, so each is checked with the protocol's
 * `isGitHubWebURL` (`https://github.com/...` and nothing else: no other scheme, host, port or
 * credentials) before anything is opened, here, at the one place that opens them. A URL that
 * fails the check opens nothing and says so by returning false; the caller shows no link for it
 * in the first place, so this is the second line, not the first.
 *
 * The window opens in the system browser: the Electron shell hands a new-window request to
 * `shell.openExternal` (`shell/main.ts`' window-open handler) and a browser opens a tab, while a
 * same-window navigation would replace the app itself. It must be called from the click handler
 * itself (a user gesture), or Safari blocks the window.
 */

import { isGitHubWebURL } from '@kelpi/protocol';

/** Where a page is opened; tests pass their own. */
export type GitHubLinkOpener = (url: string) => void;

const defaultOpener: GitHubLinkOpener = (url) => {
    globalThis.open?.(url, '_blank', 'noopener,noreferrer');
};

/** Open `url` when it is a GitHub page; false (and nothing opened) otherwise. */
export function openGitHubURL(url: string, open?: GitHubLinkOpener | undefined): boolean {
    if (!isGitHubWebURL(url)) return false;
    (open ?? defaultOpener)(url);
    return true;
}

/**
 * Where a user revokes Kelpi's OAuth grant: the daemon cannot (that takes the OAuth App's client
 * secret, which a desktop app does not hold), so Disconnect forgets the credential and points here.
 */
export const GITHUB_AUTHORIZED_APPS_URL = 'https://github.com/settings/applications';
