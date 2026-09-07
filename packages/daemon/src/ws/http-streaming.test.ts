import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp, createPaneAssetsRoute } from './http.js';
const dirs: string[] = [];
const version = { version: 'test', build: 'test', protocol: 1 };
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-http-stream-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<p>app</p>');
    return dir;
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it('streams bytes without synchronous reads and serves HEAD/304 without opening the file', async () => {
    const dir = fixture();
    const payload = Buffer.alloc(2 * 1024 * 1024, 42);
    fs.writeFileSync(path.join(dir, 'large.bin'), payload);
    const app = createHttpApp({ version, distDir: dir });
    const syncRead = vi.spyOn(fs, 'readFileSync');
    const open = vi.spyOn(fs.promises, 'open');
    const response = await app.request('/large.bin');
    expect(Buffer.from(await response.arrayBuffer()).equals(payload)).toBe(true);
    expect(syncRead).not.toHaveBeenCalled();
    open.mockClear();
    const head = await app.request('/large.bin', { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(payload.length));
    expect(await head.text()).toBe('');
    const cached = await app.request('/large.bin', { headers: { 'If-None-Match': response.headers.get('etag')! } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    const dated = await app.request('/large.bin', { headers: { 'If-Modified-Since': response.headers.get('last-modified')! } });
    expect(dated.status).toBe(304);
    expect(open).not.toHaveBeenCalled();
    // If-None-Match takes precedence even when the date would otherwise match.
    const changed = await app.request('/large.bin', { headers: { 'If-None-Match': '"old"', 'If-Modified-Since': response.headers.get('last-modified')! } });
    expect(changed.status).toBe(200);
    await changed.body?.cancel();
});
it('sandboxes authenticated HTML/SVG assets, including cached and HEAD responses', async () => {
    const dir = fixture();
    for (const ext of ['html', 'svg']) {
        const file = path.join(dir, `asset.${ext}`);
        fs.writeFileSync(file, '<script>localStorage.getItem("kelpi.token")</script>');
        const app = createHttpApp({ version, routes: createPaneAssetsRoute(() => file, { validateCredential: c => c === 'allowed' }) });
        const url = `/pane-assets/c/allowed/p/asset.${ext}`;
        const response = await app.request(url);
        await response.text();
        for (const res of [response, await app.request(url, { method: 'HEAD' }), await app.request(url, { headers: { 'If-None-Match': '*' } })]) {
            expect(res.headers.get('content-security-policy')).toContain('sandbox;');
            expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin');
            expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        }
        expect((await app.request(url.replace('/allowed/', '/revoked/'), { headers: { 'If-None-Match': '*' } })).status).toBe(404);
    }
});

it('bounds file read-ahead for a stalled consumer and closes its handle on cancellation', async () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'large.bin'), Buffer.alloc(2 * 1024 * 1024));
    const originalOpen = fs.promises.open.bind(fs.promises);
    let stream: fs.ReadStream | undefined;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        const createReadStream = handle.createReadStream.bind(handle);
        vi.spyOn(handle, 'createReadStream').mockImplementation(options => {
            stream = createReadStream(options);
            return stream;
        });
        return handle;
    });
    const response = await createHttpApp({ version, distDir: dir }).request('/large.bin');
    try {
        await vi.waitFor(() => expect(stream?.bytesRead).toBeGreaterThan(0));
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(stream!.bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
    } finally {
        await response.body?.cancel();
    }
    await vi.waitFor(() => expect(stream?.closed).toBe(true));
});
