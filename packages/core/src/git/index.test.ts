import { describe, expect, it } from 'vitest';

import { remoteURLWithoutSecrets, sanitizedGitName } from './index.js';

describe('sanitizedGitName', () => {
    it('is a fixed point for an already-valid name', () => {
        expect(sanitizedGitName('feature/foo.bar_baz-1')).toBe('feature/foo.bar_baz-1');
    });

    it('collapses unsafe runs to a single hyphen and preserves case', () => {
        expect(sanitizedGitName('My Feature!!')).toBe('My-Feature');
        expect(sanitizedGitName('a  b   c')).toBe('a-b-c');
    });

    it('collapses repeated separators', () => {
        expect(sanitizedGitName('a--b//c..d')).toBe('a-b/c.d');
    });

    it('trims leading and trailing separator characters (space included)', () => {
        expect(sanitizedGitName('  /.-_feature-_./  ')).toBe('feature');
    });

    it('returns null when nothing survives', () => {
        expect(sanitizedGitName('   ')).toBeNull();
        expect(sanitizedGitName('///')).toBeNull();
        expect(sanitizedGitName('!!!')).toBeNull();
        expect(sanitizedGitName('🚀✨')).toBeNull();
    });

    it('turns non-ASCII runs into a hyphen and keeps any length', () => {
        expect(sanitizedGitName('café crème')).toBe('caf-cr-me');
        expect(sanitizedGitName('x'.repeat(300))).toBe('x'.repeat(300));
    });
});

describe('remoteURLWithoutSecrets', () => {
    it('drops the whole userinfo of an https URL, where a token rides', () => {
        expect(remoteURLWithoutSecrets('https://ghp_SECRET@github.com/acme/api.git')).toBe('https://github.com/acme/api.git');
        expect(remoteURLWithoutSecrets('https://x-access-token:ghs_SECRET@github.com/acme/api')).toBe('https://github.com/acme/api');
        expect(remoteURLWithoutSecrets('HTTP://user:p@ss@host:8080/a/b?x#y')).toBe('HTTP://host:8080/a/b?x#y');
    });

    it("keeps an SSH URL's user name and drops only a password", () => {
        expect(remoteURLWithoutSecrets('ssh://git@github.com/acme/api.git')).toBe('ssh://git@github.com/acme/api.git');
        expect(remoteURLWithoutSecrets('git+ssh://git:hunter2@host/acme/api')).toBe('git+ssh://git@host/acme/api');
        expect(remoteURLWithoutSecrets('ssh://:hunter2@host/acme/api')).toBe('ssh://host/acme/api');
    });

    it('leaves a URL without userinfo, an scp-like remote and a path as they are', () => {
        for (const url of ['https://github.com/acme/api.git', 'git@github.com:acme/api.git', 'git@github.com-work:acme/api', '/srv/git/api.git', 'file:///srv/git/api.git']) {
            expect(remoteURLWithoutSecrets(url)).toBe(url);
        }
    });
});
