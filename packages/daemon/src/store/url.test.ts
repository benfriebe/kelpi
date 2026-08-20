import { describe, expect, it } from 'vitest';
import { isLocalOrInternalHost, isPrivateIPv4, normalizeURLInput } from './reducers/url.js';

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

    it('treats RFC 1918 and link-local IPv4 as internal (WEB-023)', () => {
        expect(normalizeURLInput('192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
        expect(normalizeURLInput('10.0.0.2/health')).toBe('http://10.0.0.2/health');
        expect(normalizeURLInput('172.16.0.1')).toBe('http://172.16.0.1');
        expect(normalizeURLInput('172.31.255.254')).toBe('http://172.31.255.254');
        expect(normalizeURLInput('169.254.1.1')).toBe('http://169.254.1.1');
        // …and a PUBLIC address in the same neighbourhood still gets https.
        expect(normalizeURLInput('172.32.0.1')).toBe('https://172.32.0.1');
        expect(normalizeURLInput('11.0.0.1')).toBe('https://11.0.0.1');
    });

    it('only accepts a well-formed dotted quad as a private address', () => {
        expect(isPrivateIPv4('10.0.0.1')).toBe(true);
        expect(isPrivateIPv4('192.168.0.256')).toBe(false);
        expect(isPrivateIPv4('010.0.0.1')).toBe(false);
        expect(isPrivateIPv4('10.0.0')).toBe(false);
        expect(isPrivateIPv4('10.0.0.1.2')).toBe(false);
        expect(isPrivateIPv4('192.168.example.com')).toBe(false);
    });
});
