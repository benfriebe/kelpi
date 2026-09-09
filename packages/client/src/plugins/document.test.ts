import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { pluginDocument } from './document';

const ROOT = 'http://localhost:123/plugin-assets/lease/';
const BASE = `${ROOT}ui/`;
const documentFor = (html: string) => new DOMParser().parseFromString(pluginDocument(html, ROOT, 'ui/index.html', { nonce: 'view-nonce' }), 'text/html');

function expectHostHead(document: Document): void {
    const first = [...document.head.children].slice(0, 3);
    expect(first.map(element => element.tagName)).toEqual(['META', 'BASE', 'SCRIPT']);
    expect(first[0]?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    const policy = first[0]?.getAttribute('content');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(`script-src 'unsafe-inline' ${ROOT}`);
    expect(policy).toContain(`connect-src ${ROOT}`);
    expect(policy).toContain("frame-src 'none'; object-src 'none'; form-action 'none'");
    expect(policy).toContain(`base-uri ${BASE}`);
    expect(first[1]?.getAttribute('href')).toBe(BASE);
    expect(first[2]?.textContent).toContain('kelpi-plugin-ready');
    expect(document.querySelectorAll('script').item(0)).toBe(first[2]);
}

describe('plugin document assembly', () => {
    it('keeps a full document stylesheet in its head when the authored script replaces the body', () => {
        const document = documentFor(`<!doctype html><html lang="en" data-theme="plugin"><head>
            <title>Plugin page</title><link id="theme" rel="stylesheet" href="./theme.css">
            <style id="inline">main { color: red }</style>
            </head><body class="plugin-body"><main>Loading</main>
            <script id="render">document.body.innerHTML = '<main id="ready">Ready</main>';</script>
            </body></html>`);
        expectHostHead(document);
        expect(document.title).toBe('Plugin page');
        expect(document.documentElement.lang).toBe('en');
        expect(document.documentElement.dataset['theme']).toBe('plugin');
        expect(document.body.className).toBe('plugin-body');
        const stylesheet = document.querySelector<HTMLLinkElement>('#theme');
        expect(stylesheet?.parentElement).toBe(document.head);
        expect(stylesheet?.href).toBe(`${BASE}theme.css`);
        const context = createContext({ document });
        runInContext(document.querySelector('#render')!.textContent!, context);
        expect(document.body.textContent).toBe('Ready');
        expect(document.querySelector('#theme')).toBe(stylesheet);
        expect(document.querySelector('#inline')?.parentElement).toBe(document.head);
    });

    it.each(['', '\n  <!-- document banner -->\n', '\uFEFF<!-- UTF-8 file -->\n'])('handles a full document with prefix %j', prefix => {
        const document = documentFor(`${prefix}<!DOCTYPE HTML><HTML><HEAD><link id="theme" rel="stylesheet" href="theme.css"></HEAD><BODY><p>Plugin body</p></BODY></HTML>`);
        expectHostHead(document);
        expect(document.compatMode).toBe('CSS1Compat');
        expect(document.querySelector('#theme')?.parentElement).toBe(document.head);
        expect(document.body.textContent).toBe('Plugin body');
        expect(document.querySelectorAll('html')).toHaveLength(1);
        expect(document.querySelectorAll('head')).toHaveLength(1);
        expect(document.querySelectorAll('body')).toHaveLength(1);
    });

    it.each([
        'Leading text <strong>fragment</strong><script id="authored">globalThis.rendered = true;</script>',
        '<!-- fragment --><link id="theme" rel="stylesheet" href="theme.css"><main>fragment</main><script id="authored">globalThis.rendered = true;</script>',
        '<body class="fragment"><main>fragment</main><script id="authored">globalThis.rendered = true;</script></body>'
    ])('supports fragment body content without duplicating injected metadata', html => {
        const document = documentFor(html);
        expectHostHead(document);
        expect(document.body.textContent).toContain('fragment');
        expect(document.querySelector('#authored')?.parentElement).toBe(document.body);
        expect(document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(1);
        expect(document.querySelectorAll('base')).toHaveLength(1);
        expect(document.querySelectorAll('script')).toHaveLength(2);
    });

    it('keeps host policy, base and SDK ahead of authored scripts and additional restrictive policies', () => {
        const document = documentFor(`<html><head>
            <meta http-equiv="Content-Security-Policy" content="connect-src 'none'">
            <base href="https://unrelated.invalid/">
            <script id="head-script">globalThis.headRan = true;</script>
            </head><body><script id="body-script">globalThis.bodyRan = true;</script></body></html>`);
        expectHostHead(document);
        expect(document.baseURI).toBe(BASE);
        // Additional authored CSP can narrow the host's policy; it cannot replace it.
        const policies = [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')];
        expect(policies).toHaveLength(2);
        expect(policies[1]?.getAttribute('content')).toBe("connect-src 'none'");
        expect([...document.scripts].slice(1).map(script => script.id)).toEqual(['head-script', 'body-script']);
        expect(document.querySelector('#head-script')?.parentElement).toBe(document.head);
    });

    it('keeps malicious closing tags and configuration strings inside the SDK script and restores exact data', () => {
        const state = { html: '</ScRiPt><script id="injected">globalThis.injected = true</script><body>',
            quoted: '\"; globalThis.injected = true; //', comment: '<!-- </head><base href="https://unrelated.invalid/"> -->',
            unicode: 'line\u2028paragraph\u2029end', entity: '&lt;/script&gt;' };
        const nonce = '</script><script>bad()</script>';
        const document = new DOMParser().parseFromString(pluginDocument('<script id="authored">const base = 42; globalThis.authored = Boolean(kelpi) && base;</script>', ROOT, 'ui/index.html', { nonce, state }), 'text/html');
        expectHostHead(document);
        expect(document.querySelectorAll('script')).toHaveLength(2);
        expect(document.querySelector('#injected')).toBeNull();
        const postMessage = vi.fn();
        const scope = { document, parent: { postMessage }, addEventListener: vi.fn(), removeEventListener: vi.fn(),
            kelpi: undefined as undefined | { state: unknown }, injected: undefined, authored: undefined, __KELPI_VIEW__: undefined };
        const context = createContext(scope);
        for (const script of document.scripts) runInContext(script.textContent!, context);
        expect(scope.kelpi?.state).toEqual(state);
        expect(postMessage).toHaveBeenCalledWith({ type: 'kelpi-plugin-ready', nonce }, '*');
        expect(scope.authored).toBe(42);
        expect(scope.injected).toBeUndefined();
        expect(scope.__KELPI_VIEW__).toBeUndefined();
    });

    it('escapes metadata attributes without interpreting URL characters as authored markup', () => {
        const root = 'http://localhost:123/plugin-assets/lease/" onload="bad()"><script id="injected">bad()</script>?a=1&b=2';
        const document = new DOMParser().parseFromString(pluginDocument('<p>Safe structure</p>', root, 'ui/index.html', {}), 'text/html');
        expect(document.querySelector('#injected')).toBeNull();
        expect(document.querySelector('[onload]')).toBeNull();
        expect(document.querySelectorAll('script')).toHaveLength(1);
        expect(document.querySelectorAll('base')).toHaveLength(1);
        expect(document.querySelector('meta')?.getAttribute('content')).toContain(root);
        expect(document.body.textContent).toBe('Safe structure');
    });
});
