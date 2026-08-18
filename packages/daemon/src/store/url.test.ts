import { describe, expect, it } from 'vitest';
import { isLocalOrInternalHost, normalizeURLInput } from './reducers/url.js';

describe('normalizeURLInput', () => {
    it('passes through anything carrying a scheme', () => {
        expect(normalizeURLInput('https://example.com')).toBe('https://example.com');
        expect(normalizeURLInput('  http://example.com/x  ')).toBe('http://example.com/x');
        expect(normalizeURLInput('file:///tmp/a.html')).toBe('file:///tmp/a.html');
    });

    it('keeps opaque schemes without "//" intact', () => {
        expect(normalizeURLInput('mailto:a@b.com')).toBe('mailto:a@b.com');
        expect(normalizeURLInput('about:blank')).toBe('about:blank');
        expect(normalizeURLInput('data:text/plain,hello')).toBe('data:text/plain,hello');
    });

    it('treats a digit after the colon as host:port, not a scheme', () => {
        expect(normalizeURLInput('localhost:3000')).toBe('http://localhost:3000');
        expect(normalizeURLInput('example.com:8080/x')).toBe('https://example.com:8080/x');
    });

    it('uses http for local and internal hosts, https otherwise', () => {
        expect(normalizeURLInput('localhost')).toBe('http://localhost');
        expect(normalizeURLInput('127.0.0.1/health')).toBe('http://127.0.0.1/health');
        expect(normalizeURLInput('dev.local')).toBe('http://dev.local');
        expect(normalizeURLInput('intranet')).toBe('http://intranet');
        expect(normalizeURLInput('example.com')).toBe('https://example.com');
    });

    it('leaves an empty input empty', () => {
        expect(normalizeURLInput('   ')).toBe('');
    });

    it('classifies hosts', () => {
        expect(isLocalOrInternalHost('::1')).toBe(true);
        expect(isLocalOrInternalHost('app.localhost')).toBe(true);
        expect(isLocalOrInternalHost('example.com')).toBe(false);
    });
});
