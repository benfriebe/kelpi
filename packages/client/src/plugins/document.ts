import bridge from '../../../plugin-sdk/browser.js?raw';
import apiSource from '../../../plugin-sdk/api.js?raw';
import type { JsonObject } from '@kelpi/protocol';

const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export function pluginDocument(html: string, assetRoot: string, entry: string, configuration: JsonObject): string {
    const base = new URL(entry.slice(0, entry.lastIndexOf('/') + 1), assetRoot).href;
    const csp = `default-src 'none'; script-src 'unsafe-inline' ${assetRoot}; style-src 'unsafe-inline' ${assetRoot}; img-src data: blob: ${assetRoot}; font-src ${assetRoot}; connect-src ${assetRoot}; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri ${base}`;
    // The shared SDK has no imports. Keep its declarations in a private scope when used as
    // a classic script; the backend runner imports the exact same implementation as ESM.
    const sdk = apiSource.replace(/^export /gm, '');
    const injection = `<meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><base href="${escape(base)}"><script>(()=>{globalThis.__KELPI_VIEW__=${JSON.stringify(configuration).replaceAll('<', '\\u003c')};${sdk}\n${bridge}})();</script>`;
    // Keep the head open: a full document's own </head>/<body>, or a fragment's first
    // body content, closes it naturally. An early wrapper <body> would strand authored
    // stylesheets in the body, where a plugin's body.innerHTML render would remove them.
    // Leave parsing to the sandboxed frame so no authored resources load in the host.
    // A file's leading BOM is normally consumed before HTML parsing; our prefix would
    // turn it into body text and prematurely close the head without removing it here.
    return `<!doctype html><html><head>${injection}${html.replace(/^\uFEFF/, '')}</html>`;
}
