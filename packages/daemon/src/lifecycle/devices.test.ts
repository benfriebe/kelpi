import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    DEVICE_TOKEN_PREFIX,
    DEVICES_PATH_ENV,
    createAssetCredentialGate,
    createAssetCredentialValidator,
    createDeviceValidator,
    hashDeviceToken,
    loadDevices,
    mintDevice,
    removeDevice,
    resolveDevicesPath,
    revokeDevice
} from './devices.js';

let root: string;
let file: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-devices-'));
    file = path.join(root, 'devices.json');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveDevicesPath', () => {
    it('honours the env override, resolved absolute', () => {
        expect(resolveDevicesPath({ [DEVICES_PATH_ENV]: file })).toBe(file);
    });

    it('defaults to devices.json in the data dir', () => {
        expect(resolveDevicesPath({})).toMatch(/devices\.json$/);
    });
});

describe('mintDevice', () => {
    it('mints a prefixed token, stores only its hash, and creates the file 0600', () => {
        const minted = mintDevice(file, "alice's laptop");
        expect(minted.token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
        expect(minted.device.tokenHash).toBe(hashDeviceToken(minted.token));

        const raw = fs.readFileSync(file, 'utf8');
        expect(raw).not.toContain(minted.token);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);

        const devices = loadDevices(file);
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({ id: minted.device.id, name: "alice's laptop" });
    });

    it('refuses a name a live device already holds, but frees it on revoke', () => {
        const first = mintDevice(file, 'phone');
        expect(() => mintDevice(file, 'phone')).toThrow(/already named "phone"/);
        revokeDevice(file, first.device.id);
        expect(mintDevice(file, 'phone').device.id).not.toBe(first.device.id);
    });

    it('refuses an empty name', () => {
        expect(() => mintDevice(file, '   ')).toThrow(/needs a name/);
    });

    it('mints hex ids, so no id can ever look like a flag to the CLI parser', () => {
        for (let i = 0; i < 32; i += 1) {
            const minted = mintDevice(file, `d${String(i)}`);
            expect(minted.device.id).toMatch(/^[0-9a-f]{8}$/);
        }
    });
});

describe('removeDevice', () => {
    it('deletes an entry outright (the pair rollback), leaving others alone', () => {
        const alice = mintDevice(file, 'alice');
        const bob = mintDevice(file, 'bob');
        removeDevice(file, bob.device.id);
        expect(loadDevices(file).map((device) => device.name)).toEqual(['alice']);
        removeDevice(file, 'never-existed');
        expect(loadDevices(file).map((device) => device.id)).toEqual([alice.device.id]);
    });
});

describe('revokeDevice', () => {
    it('revokes by id and by live name, and revoking twice is a reported no-op', () => {
        const alice = mintDevice(file, 'alice');
        const bob = mintDevice(file, 'bob');

        const byName = revokeDevice(file, 'bob');
        expect(byName?.id).toBe(bob.device.id);
        expect(byName?.revokedAt).toBeDefined();

        const again = revokeDevice(file, bob.device.id);
        expect(again?.revokedAt).toBe(byName?.revokedAt);

        const byId = revokeDevice(file, alice.device.id);
        expect(byId?.name).toBe('alice');
        expect(loadDevices(file).every((device) => device.revokedAt !== undefined)).toBe(true);
    });

    it('returns null for an unknown target', () => {
        mintDevice(file, 'alice');
        expect(revokeDevice(file, 'nobody')).toBeNull();
    });
});

describe('createDeviceValidator', () => {
    it('accepts a live device token and nothing else', () => {
        const minted = mintDevice(file, 'alice');
        const validate = createDeviceValidator(file);
        expect(validate(minted.token)).toBe(true);
        expect(validate(`${DEVICE_TOKEN_PREFIX}wrong`)).toBe(false);
        expect(validate('the-owner-token')).toBe(false);
        expect(validate('')).toBe(false);
    });

    it('sees a revoke without being recreated (mtime reload)', () => {
        const minted = mintDevice(file, 'alice');
        const validate = createDeviceValidator(file);
        expect(validate(minted.token)).toBe(true);
        revokeDevice(file, minted.device.id);
        expect(validate(minted.token)).toBe(false);
    });

    it('sees a NEW pairing after it already cached the file', () => {
        mintDevice(file, 'alice');
        const validate = createDeviceValidator(file);
        expect(validate(`${DEVICE_TOKEN_PREFIX}nope`)).toBe(false);
        const second = mintDevice(file, 'bob');
        expect(validate(second.token)).toBe(true);
    });

    it('accepts the stored hash as an asset credential, and the gate adds the owner', () => {
        const minted = mintDevice(file, 'alice');
        const credential = hashDeviceToken(minted.token);
        const assets = createAssetCredentialValidator(file);
        expect(assets(credential)).toBe(true);
        expect(assets(minted.token)).toBe(false); // the raw token is NOT an asset credential
        expect(assets('')).toBe(false);

        const gate = createAssetCredentialGate(file, 'owner-token');
        expect(gate(hashDeviceToken('owner-token'))).toBe(true);
        expect(gate(credential)).toBe(true);
        revokeDevice(file, minted.device.id);
        expect(gate(credential)).toBe(false);
        expect(gate(hashDeviceToken('owner-token'))).toBe(true);
    });

    it('fails closed on a missing or corrupt registry', () => {
        const validate = createDeviceValidator(file);
        expect(validate(`${DEVICE_TOKEN_PREFIX}anything`)).toBe(false);
        fs.writeFileSync(file, 'not json');
        expect(validate(`${DEVICE_TOKEN_PREFIX}anything`)).toBe(false);
        // ...and recovers once the file is sane again.
        fs.rmSync(file);
        const minted = mintDevice(file, 'alice');
        expect(validate(minted.token)).toBe(true);
    });
});
