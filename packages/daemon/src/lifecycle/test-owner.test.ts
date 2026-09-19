import { expect, it } from 'vitest';
import { connectTestOwner } from './test-owner.js';

it('leaves ordinary daemon launches alone', async () => {
    const env = { HOME: '/private-home' };
    const before = process.listenerCount('SIGTERM');
    await connectTestOwner(env);
    expect(env).toEqual({ HOME: '/private-home' });
    expect(process.listenerCount('SIGTERM')).toBe(before);
});

it.each([
    { KELPI_TEST_OWNER_PORT: '19733' },
    { KELPI_TEST_OWNER_TOKEN: 'a'.repeat(64) },
    { KELPI_TEST_OWNER_PORT: '-1', KELPI_TEST_OWNER_TOKEN: 'a'.repeat(64) },
    { KELPI_TEST_OWNER_PORT: '12345', KELPI_TEST_OWNER_TOKEN: 'not-a-capability' }
])('refuses malformed ownership before boot and consumes its private environment', async env => {
    await expect(connectTestOwner(env)).rejects.toThrow('invalid private test owner channel');
    expect(env).toEqual({});
});
