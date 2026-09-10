import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('ships a standalone SDK artifact for browser and Node-only authors', async () => {
    const script = fileURLToPath(new URL('../../../scripts/verify-plugin-sdk.mjs', import.meta.url));
    const result = await promisify(execFile)(process.execPath, [script], { timeout: 60_000 });
    expect(result.stdout).toContain('SDK artifact verified:');
}, 60_000);
