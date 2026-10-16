import { describe, expect, it } from 'vitest';

import { launcherEnv } from './launcher-env.mjs';

const terminal = {
    USER: 'dev',
    LOGNAME: 'dev',
    TMPDIR: '/var/folders/xy/T/',
    SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.abc/Listeners',
    LANG: 'en_AU.UTF-8',
    CLAUDE_CONFIG_DIR: '/Users/dev/.claude',
    PATH: '/usr/bin'
};

describe('launcherEnv (#410)', () => {
    // Exact matches, so the locale, CLAUDE_CONFIG_DIR and PATH in `terminal` are proven dropped.
    it('keeps the user, the temp dir and the ssh agent when panes get the real HOME', () => {
        expect(launcherEnv(terminal, { realHome: true })).toEqual({
            USER: 'dev',
            LOGNAME: 'dev',
            TMPDIR: '/var/folders/xy/T/',
            SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.abc/Listeners'
        });
    });

    it('keeps only the user with an isolated HOME', () => {
        expect(launcherEnv(terminal, { realHome: false })).toEqual({ USER: 'dev', LOGNAME: 'dev' });
    });

    it('never invents a value the launcher does not have, or passes an empty one', () => {
        expect(launcherEnv({ USER: 'dev', LOGNAME: '' }, { realHome: true })).toEqual({ USER: 'dev' });
        expect(launcherEnv({}, { realHome: true })).toEqual({});
    });
});
