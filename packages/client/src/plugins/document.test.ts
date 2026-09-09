import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginDocument } from './document';

const ROOT = 'http://localhost:123/plugin-assets/lease/';
const BASE = `${ROOT}ui/`;
const documentFor = (html: string) => new DOMParser().parseFromString(pluginDocument(html, ROOT, 'ui/index.html', { nonce: 'view-nonce' }), 'text/html');

const frames = new Set<HTMLIFrameElement>();
afterEach(() => {
    for (const frame of frames) frame.remove();
    frames.clear();
    vi.restoreAllMocks();
});

async function executeDocument(html: string) {
    const frame = document.createElement('iframe');
    frames.add(frame);
    document.body.append(frame);
    const target = frame.contentWindow!;
    const errors: string[] = [];
    const messages: unknown[] = [];
    target.document.open();
    target.addEventListener('error', event => { errors.push(event.message); event.preventDefault(); });
    // Parse into an empty frame with scripts enabled. Running scripts after DOMParser
    // finishes would miss a synchronous script executing before the body is created.
    target.document.write(pluginDocument(html, ROOT, 'ui/index.html', { nonce: 'view-nonce', state: { text: 'Ready' } }));
    target.document.close();
    const port = { start: vi.fn(), postMessage(message: unknown) { messages.push(message); } };
    target.dispatchEvent(new MessageEvent('message', {
        source: target.parent, data: { type: 'kelpi-plugin-connect', nonce: 'view-nonce' }, ports: [port as unknown as MessagePort],
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(port.start).toHaveBeenCalledOnce();
    return { document: target.document, errors, messages };
}

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
    it('keeps a full document stylesheet in its head when the parser executes the authored body render', async () => {
        const { document, errors, messages } = await executeDocument(`<!doctype html><html lang="en" data-theme="plugin"><head>
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
        expect(document.body.textContent?.trim()).toBe('Ready');
        expect(document.querySelector('#inline')?.parentElement).toBe(document.head);
        expect(errors).toEqual([]);
        expect(messages).toEqual([]);
    });

    it('relays synchronous parser-time script errors through the connected SDK', async () => {
        const { errors, messages } = await executeDocument('<script>throw new Error("Authored startup failure");</script>');
        expect(errors).toEqual(['Authored startup failure']);
        expect(messages).toEqual([{ type: 'view-error', message: 'Authored startup failure' }]);
    });

    it.each([
        ['script-only', '<script>document.body.innerHTML = "<main id=ready>" + kelpi.state.text + "</main>";</script>'],
        ['style and script', '<style>main { color: red }</style><script>document.body.append(document.createElement("main")); document.body.lastChild.id = "ready"; document.body.lastChild.textContent = kelpi.state.text;</script>'],
        ['comment and script', '\uFEFF\n<!-- <html><head> is only a comment -->\n<script>document.body.innerHTML = "<main id=ready>" + kelpi.state.text + "</main>";</script>'],
        ['many comments and script', `${'<!-- banner -->\n'.repeat(100)}<script>document.body.innerHTML = "<main id=ready>" + kelpi.state.text + "</main>";</script>`],
    ])('provides a body and SDK when a %s fragment executes during parsing', async (_name, html) => {
        const { document, errors, messages } = await executeDocument(html);
        expectHostHead(document);
        expect(document.querySelector('#ready')?.textContent).toBe('Ready');
        expect(errors).toEqual([]);
        expect(messages).toEqual([]);
    });

    it.each([
        '<!DOCTYPE HTML><HTML><HEAD>',
        '<html lang="en"><head>',
        '<head>',
        '\uFEFF\n<!-- banner -->\n<!-- metadata -->\n<!doctype html><html><head>',
    ])('preserves parser-time head/body ordering for a document beginning %j', async prefix => {
        const { document, errors, messages } = await executeDocument(`${prefix}
            <style id="theme">main { color: red }</style>
            <script>
                if (document.body !== null) throw new Error('Premature body');
                if (document.baseURI !== ${JSON.stringify(BASE)}) throw new Error('Missing host base');
                if (kelpi.state.text !== 'Ready') throw new Error('Missing SDK');
                document.documentElement.dataset.headRan = 'true';
            </script></head><body>
            <script>document.body.innerHTML = '<main id="ready">' + kelpi.state.text + '</main>';</script>
            </body></html>`);
        expectHostHead(document);
        expect(document.documentElement.dataset['headRan']).toBe('true');
        expect(document.querySelector('#theme')?.parentElement).toBe(document.head);
        expect(document.querySelector('#ready')?.textContent).toBe('Ready');
        expect(errors).toEqual([]);
        expect(messages).toEqual([]);
    });

    it('assembles authored resources without parsing them in the host', () => {
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        const createDocument = vi.spyOn(document.implementation, 'createHTMLDocument');
        const createElement = vi.spyOn(document, 'createElement');
        const markup = '<html><head><link rel="stylesheet" href="theme.css"><script src="view.js"></script></head><body><img src="image.png"></body></html>';
        expect(pluginDocument(markup, ROOT, 'ui/index.html', {})).toContain(markup);
        expect(parse).not.toHaveBeenCalled();
        expect(createDocument).not.toHaveBeenCalled();
        expect(createElement).not.toHaveBeenCalled();
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
