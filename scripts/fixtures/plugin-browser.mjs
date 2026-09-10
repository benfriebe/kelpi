/** Owned loopback content for browser renderer scenarios. No network content or user profile. */
import http from 'node:http';

function documentFor(url) {
    const page = url.pathname.split('/').pop() || 'one';
    const label = page === 'two' ? 'Second page' : page === 'slow' ? 'Slow page' : 'Browser fixture';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${label} · Kelpi</title>
<style>
:root{color-scheme:dark;font:15px/1.6 system-ui,sans-serif;background:#10252c;color:#d8edf0}
*{box-sizing:border-box}body{max-width:900px;margin:0 auto;padding:28px 36px}small{color:#73cfbe;letter-spacing:.14em;text-transform:uppercase;font-size:11px}h1{font-size:32px;line-height:1.2;margin:10px 0 14px;letter-spacing:-.025em}p{max-width:650px;color:#a8c4cc}a{color:#80ead4}nav{display:flex;gap:18px;margin:24px 0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px}.card{padding:18px;background:#17343e;border:1px solid #2b4e58;border-radius:12px}button,textarea{font:inherit;color:inherit;border:1px solid #426673;border-radius:6px;background:#102830}button{padding:6px 12px;cursor:pointer}button:hover{background:#234c55}textarea{display:block;width:100%;min-height:82px;padding:9px;resize:vertical}label{display:block;margin-bottom:8px;font-size:12px;color:#9cbcc6}output{display:block;margin-top:10px;color:#80ead4;font:12px ui-monospace,monospace;overflow-wrap:anywhere}.search{margin:30px 0;border-top:1px solid #33525b;padding-top:18px}footer{font-size:11px;color:#6a929f;margin-top:28px}@media(max-width:500px){body{padding:18px}h1{font-size:25px}}
</style></head><body>
<small>Owned local page</small><h1>${label}</h1>
<p>This native page stays alive while Kelpi's browser controls are replaced. Type a note, increment the counter, or switch tabs to verify that its live state remains intact.</p>
<nav><a id="one" href="/page/one${url.search}">First page</a><a id="two" href="/page/two${url.search}">Second page</a><a id="slow" href="/page/slow${url.search}">Slow page</a></nav>
<div class="cards"><section class="card"><label for="note">Unsaved page state</label><textarea id="note" placeholder="A note held only in this page"></textarea><output id="typed">0 characters</output></section>
<section class="card"><label>In-memory counter</label><button id="increment" type="button">Increment</button><output id="count">0 clicks</output><button id="cookie" type="button">Save fixture cookie</button><output id="cookie-state"></output></section></div>
<section class="search"><h2>Find this content</h2><p>kelpi-browser-needle appears here. The second kelpi-browser-needle gives Find a second result. Unicode remains native: café, 東京, 🐚.</p></section>
<footer id="identity"></footer>
<script>
(() => {
 const instance = crypto.randomUUID(); let clicks = 0;
 const events = []; const input = document.getElementById('note');
 const cookies = () => { document.getElementById('cookie-state').textContent = document.cookie || 'No cookies in this session'; };
 const state = () => ({instance, page: location.pathname, url: location.href, clicks, note: input.value, cookies: document.cookie, storage: localStorage.getItem('kelpi-browser-fixture'), innerWidth, innerHeight, dpr: devicePixelRatio, events: events.slice(-32)});
 globalThis.browserFixture = {instance, state};
 document.getElementById('identity').textContent = 'Live page ' + instance;
 document.getElementById('increment').onclick = () => { clicks++; document.getElementById('count').textContent = clicks + ' clicks'; };
 input.oninput = () => { document.getElementById('typed').textContent = input.value.length + ' characters'; };
 document.getElementById('cookie').onclick = () => { document.cookie = 'kelpi_browser_fixture=saved; path=/; SameSite=Lax'; localStorage.setItem('kelpi-browser-fixture', 'persistent fixture value'); cookies(); };
 document.addEventListener('keydown', event => { events.push({key:event.key,code:event.code,meta:event.metaKey,ctrl:event.ctrlKey,alt:event.altKey,shift:event.shiftKey}); });
 cookies();
})();
</script></body></html>`;
}

export async function startBrowserFixture() {
    const requests = [];
    const timers = new Set();
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        requests.push({ path: url.pathname, query: url.search, cookie: request.headers.cookie ?? '', at: Date.now() });
        if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
        if (url.pathname === '/redirect') {
            response.writeHead(302, { location: `/page/two${url.search}`, 'cache-control': 'no-store' }); response.end(); return;
        }
        const send = () => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            response.end(documentFor(url));
        };
        if (url.pathname === '/page/slow') {
            const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) send(); }, 1200); timers.add(timer);
        } else send();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        async close() {
            for (const timer of timers) clearTimeout(timer);
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    };
}
