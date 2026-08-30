/**
 * The pure half of the bridge: what gets injected into a pane document, and what the host will
 * accept back from it. The DOM-level wiring is covered in `ContentFrame.test.tsx`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    CONTENT_BRIDGE_SOURCE,
    contentBridgeScript,
    frameBaseStyle,
    openExternalLink,
    parseBridgeMessage,
    prepareContentDocument,
    writeClipboardText
} from './bridge';
import { createScrollStore } from './scroll';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

describe('prepareContentDocument', () => {
    it('puts the script inside the document, at the very end of the body', () => {
        const html = '<!DOCTYPE html>\n<html><head></head><body><p>hi</p></body></html>\n';
        const prepared = prepareContentDocument(html, { paneID: PANE });

        expect(prepared.indexOf('<p>hi</p>')).toBeLessThan(prepared.indexOf('<script>'));
        expect(prepared.indexOf('<script>')).toBeLessThan(prepared.lastIndexOf('</body>'));
    });

    it('is not fooled by a literal </body> inside the content', () => {
        const html = '<html><head></head><body><pre><code>&lt;/body&gt;</code></pre></body></html>';
        const prepared = prepareContentDocument(html, { paneID: PANE });

        expect(prepared.split('</body>')).toHaveLength(2);
        expect(prepared.indexOf('__kelpiContentBridge')).toBeLessThan(prepared.lastIndexOf('</body>'));
    });

    it('still injects into a fragment the daemon did not wrap', () => {
        const prepared = prepareContentDocument('<h1>bare</h1>', { paneID: PANE, assetBase: '/pane-assets/x/' });

        expect(prepared).toContain('<base href="/pane-assets/x/">');
        expect(prepared).toContain('__kelpiContentBridge');
    });

    it('escapes an asset base rather than letting it close the tag', () => {
        const prepared = prepareContentDocument('<html><head></head><body></body></html>', {
            paneID: PANE,
            assetBase: '/pane-assets/"><script>alert(1)</script>/'
        });

        expect(prepared).not.toContain('"><script>alert(1)');
        expect(prepared).toContain('&quot;&gt;&lt;script&gt;');
    });

    /**
     * run-B L1. The daemon emits `body { background-color: transparent }` because §3.8 has the
     * PANE CONTAINER paint the ghostty fill behind the document — which is a WKWebView contract.
     * This client shows the document in an `allow-scripts` sandbox, i.e. an opaque origin, i.e.
     * an out-of-process frame that composites over Chromium's WHITE base and cannot inherit the
     * embedder's transparency. So the client paints the frame itself.
     */
    it('paints the frame opaque without touching the daemon body rule', () => {
        const html =
            '<!DOCTYPE html>\n<html class="dark">\n<head>\n<style>\nbody { background-color: transparent; }\n</style>\n</head>\n<body><p>hi</p></body>\n</html>\n';
        const prepared = prepareContentDocument(html, { paneID: PANE, background: '#0A0A0C' });

        // The daemon's contract is untouched — another embedder may still want it transparent.
        expect(prepared).toContain('body { background-color: transparent; }');
        // Ours lands on `html`, so the canvas takes it however short the body is…
        expect(prepared).toContain('html{background-color:#0A0A0C;color-scheme:dark;}');
        // …and AFTER the daemon's stylesheet, so a same-specificity rule cannot outrank it.
        expect(prepared.indexOf('body { background-color: transparent; }')).toBeLessThan(
            prepared.indexOf('data-kelpi-frame-base')
        );
        expect(prepared.indexOf('data-kelpi-frame-base')).toBeLessThan(prepared.indexOf('</head>'));
    });

    it('takes the light color scheme when the document is light, and injects nothing without a color', () => {
        const html = '<html><head></head><body></body></html>';
        expect(prepareContentDocument(html, { paneID: PANE, background: '#FFFFFF', colorScheme: 'light' })).toContain(
            'html{background-color:#FFFFFF;color-scheme:light;}'
        );
        // No background = the caller CAN composite (a non-sandboxed embedder, a test fixture).
        expect(prepareContentDocument(html, { paneID: PANE })).not.toContain('data-kelpi-frame-base');
    });

    it('prepends the base style when the daemon sent a bare fragment with no head', () => {
        const prepared = prepareContentDocument('<h1>bare</h1>', { paneID: PANE, background: '#101013' });
        expect(prepared.indexOf('data-kelpi-frame-base')).toBeLessThan(prepared.indexOf('<h1>bare</h1>'));
        expect(frameBaseStyle('#101013', 'dark')).toContain('background-color:#101013');
    });

    it('carries the pane id into the script so a message names its sender', () => {
        expect(contentBridgeScript(PANE)).toContain(JSON.stringify(PANE));
    });

    it('keeps the §3.10 copy-button contract', () => {
        const script = contentBridgeScript(PANE);

        expect(script).toContain(".closest('.code-copy-btn')");
        expect(script).toContain(":scope > pre > code");
        expect(script).toContain("classList.contains('copied')"); // re-entry guard
        expect(script).toContain("setAttribute('aria-label', 'Copied')");
        expect(script).toContain('1500');
    });
});

describe('parseBridgeMessage', () => {
    const message = (extra: Record<string, unknown>): unknown => ({
        source: CONTENT_BRIDGE_SOURCE,
        paneID: PANE,
        ...extra
    });

    it('accepts the frame’s own messages', () => {
        expect(parseBridgeMessage(message({ kind: 'ready' }), PANE)).toEqual({ kind: 'ready' });
        expect(parseBridgeMessage(message({ kind: 'scroll', top: 12, fraction: 0.5 }), PANE)).toEqual({
            kind: 'scroll',
            top: 12,
            fraction: 0.5
        });
        expect(parseBridgeMessage(message({ kind: 'copy', text: 'x' }), PANE)).toEqual({
            kind: 'copy',
            text: 'x'
        });
    });

    it('rejects anything else', () => {
        expect(parseBridgeMessage(null, PANE)).toBeNull();
        expect(parseBridgeMessage('ready', PANE)).toBeNull();
        expect(parseBridgeMessage({ kind: 'ready' }, PANE)).toBeNull(); // no source marker
        expect(parseBridgeMessage(message({ kind: 'ready' }), 'other-pane')).toBeNull();
        expect(parseBridgeMessage(message({ kind: 'copy', text: '' }), PANE)).toBeNull();
        expect(parseBridgeMessage(message({ kind: 'exec' }), PANE)).toBeNull();
    });
});

describe('host effects', () => {
    it('opens only schemes a document may ask for', () => {
        const open = vi.fn();

        expect(openExternalLink('https://example.com/a', open)).toBe(true);
        expect(openExternalLink('mailto:someone@example.com', open)).toBe(true);
        expect(openExternalLink('javascript:alert(1)', open)).toBe(false);
        expect(openExternalLink('data:text/html,<script>x</script>', open)).toBe(false);
        expect(openExternalLink('file:///etc/passwd', open)).toBe(false);
        expect(open).toHaveBeenCalledTimes(2);
    });

    it('ignores an empty clipboard write and survives a rejecting one', () => {
        expect(writeClipboardText('', vi.fn())).toBe(false);
        expect(
            writeClipboardText('code', () => {
                throw new Error('denied');
            })
        ).toBe(false);
        expect(writeClipboardText('code', () => Promise.reject(new Error('denied')))).toBe(true);
    });
});

describe('scroll store', () => {
    it('clamps what a document reports and survives the view that reported it', () => {
        const store = createScrollStore();

        store.set('a', { top: -5, fraction: 2 });
        expect(store.get('a')).toEqual({ top: 0, fraction: 1 });

        store.set('a', { top: 120, fraction: 0.3 });
        expect(store.get('a')).toEqual({ top: 120, fraction: 0.3 });
        expect(store.get('b')).toBeNull();

        store.clear('a');
        expect(store.get('a')).toBeNull();
        expect(store.size).toBe(0);
    });
});
