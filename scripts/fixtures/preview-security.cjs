const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const url = process.argv[2];
app.setPath('userData', path.join(process.argv[3], 'profile'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Preview security smoke timed out'); app.exit(1); }, 20_000);
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
        await window.loadURL(url);
        await window.webContents.executeJavaScript(String.raw`
            window.messages = [];
            localStorage.setItem('kelpi.token', 'smoke-only-token');
            const frame = document.createElement('iframe');
            frame.id = 'preview'; frame.sandbox = 'allow-scripts';
            window.addEventListener('message', event => {
                if (event.source === frame.contentWindow || event.data?.attack) messages.push(event.data);
            });
            const hostile = '<script>parent.postMessage({attack:"script"},"*")<\/script>' +
                '<meta http-equiv="refresh" content="0;url=https://example.invalid">' +
                '<div id="content"><p>searchable note</p><img src="missing" onerror="parent.postMessage({attack:1},\'*\')">' +
                '<svg onload="parent.postMessage({attack:2},\'*\')"></svg>' +
                '<iframe srcdoc="<script>parent.parent.postMessage({attack:3},\'*\')<\/script>"></iframe>' +
                '<img id="sibling" src="asset.svg"><div class="code-block"><pre><code>copy me</code></pre><button class="code-copy-btn">Copy</button></div></div>';
            window.hostileFixture = hostile;
            frame.srcdoc = PreviewBridge.prepareContentDocument(hostile, { paneID: 'p', assetBase: '${url}/pane-assets/c/smoke/p/', claimedChords: ['8/KeyD'] });
            document.body.append(frame);
        `);
        for (let i = 0; i < 50; i++) {
            if (await window.webContents.executeJavaScript('messages.some(m => m.kind === "ready")')) break;
            await delay(50);
        }
        await delay(200);
        let messages = await window.webContents.executeJavaScript('messages');
        assert(messages.some(m => m.kind === 'ready'), 'trusted bridge did not execute');
        assert(!messages.some(m => m.attack), 'untrusted script executed');
        const frame = window.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc');
        assert(frame, 'preview frame missing');
        const image = await frame.executeJavaScript('({ complete: document.getElementById("sibling").complete, width: document.getElementById("sibling").naturalWidth })');
        assert(image.complete && image.width === 12, 'credentialed sibling image did not load');
        // Exercise only the trusted bridge's UI behavior; injected test JS is not used to
        // judge CSP enforcement (the hostile HTML above is what must stay inert).
        await frame.executeJavaScript(`document.querySelector('.code-copy-btn').click(); window.dispatchEvent(new KeyboardEvent('keydown', {code:'KeyD', key:'d', metaKey:true, bubbles:true, cancelable:true}));`);
        await window.webContents.executeJavaScript(`document.getElementById('preview').contentWindow.postMessage({source:'kelpi-host', kind:'find', op:'search', needle:'searchable'}, '*')`);
        await delay(100);
        messages = await window.webContents.executeJavaScript('messages');
        assert(messages.some(m => m.kind === 'copy' && m.text === 'copy me'), 'copy bridge stopped working');
        assert(messages.some(m => m.kind === 'key' && m.code === 'KeyD'), 'shortcut bridge stopped working');
        assert(messages.some(m => m.kind === 'find-result' && m.total === 1), 'find bridge stopped working: ' + JSON.stringify(messages));
        assert(!messages.some(m => m.attack), 'untrusted handler executed');
        // A positive control proves all four attack payloads execute without our policy.
        await window.webContents.executeJavaScript(`
            const controlDocument = new DOMParser().parseFromString(hostileFixture, 'text/html');
            controlDocument.querySelector('meta').remove();
            const control = document.createElement('iframe');
            control.sandbox = 'allow-scripts';
            control.srcdoc = controlDocument.documentElement.outerHTML;
            document.body.append(control);
        `);
        for (let i = 0; i < 50; i++) {
            messages = await window.webContents.executeJavaScript('messages');
            if (['script', 1, 2, 3].every(attack => messages.some(m => m.attack === attack))) break;
            await delay(50);
        }
        for (const attack of ['script', 1, 2, 3]) {
            assert(messages.some(m => m.attack === attack), `positive control failed: ${attack}`);
        }
        await window.loadURL(`${url}/pane-assets/c/smoke/p/asset.html`);
        assert.equal(window.webContents.getTitle(), 'Asset');
        assert.equal(window.webContents.mainFrame.origin, 'null', 'asset must have an opaque origin');
        await assert.rejects(window.webContents.executeJavaScript("localStorage.getItem('kelpi.token')"), 'asset must disallow scripts');
        await window.loadURL(`${url}/pane-assets/c/smoke/p/asset.svg`);
        window.webContents.debugger.attach();
        const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument');
        const svg = root.children.find(node => node.nodeName === 'svg');
        assert(svg && !svg.attributes.includes('data-attacked'), 'SVG script executed');
        window.webContents.debugger.detach();
        assert.equal(window.webContents.mainFrame.origin, 'null', 'asset must have an opaque origin');
        await assert.rejects(window.webContents.executeJavaScript("localStorage.getItem('kelpi.token')"), 'asset must disallow scripts');
        console.log('PASS: Chromium blocks preview scripts, handlers and scripts in nested frames; copy, keys, find and sibling images work; HTML/SVG assets cannot access app storage.');
        clearTimeout(deadline);
        window.destroy(); app.exit(0);
    } catch (error) {
        console.error(error); clearTimeout(deadline); window.destroy(); app.exit(1);
    }
}).catch(error => { console.error(error); app.exit(1); });
