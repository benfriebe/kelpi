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
    // Prepending a head also covers fragments; the HTML parser merges a later head's contents.
    return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
}
