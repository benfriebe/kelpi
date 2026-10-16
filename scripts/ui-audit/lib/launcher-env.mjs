/**
 * What a dev daemon keeps from the environment of the terminal that launched it (#410).
 *
 * `dev-instance.mjs` and `dev-hmr.mjs` start their daemon with a deliberately clean env, and a
 * pane's shell inherits the daemon's env (`daemon/src/pty/manager.ts` ▸ `buildEnv`), so any
 * variable not listed by name never reaches a pane. The real app gets these from launchd; a dev
 * daemon got none of them, and a pane came up with `USER` empty and `LOGNAME=root`. Claude Code
 * looks its login up in the keychain by `$USER`, so `claude` in a dev pane said "Not logged in".
 *
 *  - `USER` and `LOGNAME`, always, isolated HOME or not. The daemon and its panes run as the
 *    developer's uid, so the keychain is theirs whatever `$USER` says; the variable only names
 *    the account to look in. An isolated HOME isolates files, not the login, and an empty
 *    `USER` with `LOGNAME=root` is wrong for every program that reads them.
 *  - `TMPDIR` and `SSH_AUTH_SOCK`, only with the real HOME (the mode whose point is "your shell,
 *    your rc files"): the per-user temp dir launchd hands the real app, and the ssh agent `git`
 *    needs. The agent then reaches this instance's plugin backends too, as it does in the real
 *    app. With `TMPDIR` the dev daemon shares the per-user temp dir with the live app; what it
 *    puts there is uniquely named (`mkdtemp`'d plugin dirs, clipboard images, graft index files
 *    swept only after a day), and its sockets, database and run dir are all set by `KELPID_*`.
 *
 * Locale is left out on purpose: launchd gives the real app none, and the daemon supplies
 * `LC_CTYPE=UTF-8` when nothing is set, so passing the terminal's locale would make dev panes
 * differ from the real app's. Each key is passed only when the launcher has it.
 */
const IDENTITY_KEYS = ['USER', 'LOGNAME'];
const REAL_HOME_KEYS = ['TMPDIR', 'SSH_AUTH_SOCK'];

/**
 * @param {NodeJS.ProcessEnv} env  the launcher's own environment, usually `process.env`.
 * @param {{ realHome: boolean }} options  whether the daemon gets the developer's real HOME.
 * @returns {Record<string, string>}
 */
export function launcherEnv(env, { realHome }) {
    const out = {};
    for (const key of realHome ? [...IDENTITY_KEYS, ...REAL_HOME_KEYS] : IDENTITY_KEYS) {
        const value = env[key];
        if (typeof value === 'string' && value !== '') out[key] = value;
    }
    return out;
}
