import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { assetCredentialFor, credentialedAssetBase, setAssetCredentialToken, sha256 } from './asset-credential';

function hex(bytes: Uint8Array): string {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('sha256', () => {
    it('matches the FIPS 180-4 test vectors', () => {
        expect(hex(sha256(new TextEncoder().encode('')))).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        );
        expect(hex(sha256(new TextEncoder().encode('abc')))).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        );
        // A multi-block input (>64 bytes) exercises the chunk loop.
        expect(hex(sha256(new TextEncoder().encode('a'.repeat(1000))))).toBe(
            createHash('sha256').update('a'.repeat(1000)).digest('hex')
        );
    });

    it('agrees byte-for-byte with the daemon-side hashDeviceToken encoding', () => {
        const token = 'kd_2WqZ-vqXAmpleTokenValue_1234567890abcdefghijk';
        expect(assetCredentialFor(token)).toBe(createHash('sha256').update(token, 'utf8').digest('base64url'));
    });
});

describe('credentialedAssetBase', () => {
    it('rewrites the daemon base with the derived credential, and only that shape', () => {
        setAssetCredentialToken('tok-123');
        const cred = assetCredentialFor('tok-123');
        try {
            expect(credentialedAssetBase('/pane-assets/pane-9/')).toBe(`/pane-assets/c/${cred}/pane-9/`);
            expect(credentialedAssetBase(null)).toBeNull();
            expect(credentialedAssetBase('/somewhere-else/')).toBe('/somewhere-else/');
        } finally {
            setAssetCredentialToken(undefined);
        }
    });

    it('passes the base through untouched when there is no token (dev daemon)', () => {
        setAssetCredentialToken(undefined);
        expect(credentialedAssetBase('/pane-assets/pane-9/')).toBe('/pane-assets/pane-9/');
    });
});
