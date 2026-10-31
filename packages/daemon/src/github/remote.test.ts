import { describe, expect, it } from 'vitest';

import { parseGitHubRemote } from './remote.js';

const widgets = { host: 'github.com', owner: 'acme', name: 'widgets' };

describe('parseGitHubRemote', () => {
    it('reads https, with or without .git and a trailing slash', () => {
        expect(parseGitHubRemote('https://github.com/acme/widgets')).toEqual(widgets);
        expect(parseGitHubRemote('https://github.com/acme/widgets.git')).toEqual(widgets);
        expect(parseGitHubRemote('https://github.com/acme/widgets/')).toEqual(widgets);
        expect(parseGitHubRemote('  http://GitHub.com/acme/widgets.git\n')).toEqual(widgets);
    });

    it('drops userinfo, so a token in the URL never survives the parse', () => {
        const parsed = parseGitHubRemote('https://ghp_secret123@github.com/acme/widgets.git');
        expect(parsed).toEqual(widgets);
        expect(JSON.stringify(parsed)).not.toContain('secret');
        expect(parseGitHubRemote('https://user:pass@github.com/acme/widgets')).toEqual(widgets);
    });

    it('reads ssh:// and git:// URLs, ignoring a port', () => {
        expect(parseGitHubRemote('ssh://git@github.com/acme/widgets.git')).toEqual(widgets);
        expect(parseGitHubRemote('ssh://git@ssh.github.com:443/acme/widgets.git')).toEqual(widgets);
        expect(parseGitHubRemote('git://github.com/acme/widgets.git')).toEqual(widgets);
    });

    it('reads the scp-like form', () => {
        expect(parseGitHubRemote('git@github.com:acme/widgets.git')).toEqual(widgets);
        expect(parseGitHubRemote('github.com:acme/widgets')).toEqual(widgets);
    });

    it('keeps another host as itself (GitHub Enterprise), lowercased', () => {
        expect(parseGitHubRemote('https://GHE.example.com/team/app.git')).toEqual({ host: 'ghe.example.com', owner: 'team', name: 'app' });
        expect(parseGitHubRemote('git@ghe.example.com:team/app.git')).toEqual({ host: 'ghe.example.com', owner: 'team', name: 'app' });
    });

    it('keeps an SSH alias host as written, for the caller to skip', () => {
        expect(parseGitHubRemote('git@github-work:acme/widgets.git')).toEqual({ host: 'github-work', owner: 'acme', name: 'widgets' });
    });

    it('is null for anything that is not one owner/name on a host', () => {
        expect(parseGitHubRemote(null)).toBeNull();
        expect(parseGitHubRemote(undefined)).toBeNull();
        expect(parseGitHubRemote('')).toBeNull();
        expect(parseGitHubRemote('/Users/me/origin.git')).toBeNull();
        expect(parseGitHubRemote('../origin.git')).toBeNull();
        expect(parseGitHubRemote('file:///tmp/origin.git')).toBeNull();
        expect(parseGitHubRemote('https://github.com/acme')).toBeNull();
        expect(parseGitHubRemote('https://gitlab.com/group/sub/app.git')).toBeNull();
        expect(parseGitHubRemote('git@github.com:/abs/path.git')).toBeNull();
        expect(parseGitHubRemote('https://github.com/acme/wid gets')).toBeNull();
        expect(parseGitHubRemote('https://github.com/acme/..')).toBeNull();
    });
});
