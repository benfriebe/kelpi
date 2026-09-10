/** Browser Lab against real daemon, shell, native page targets and opaque plugin frames. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, listTargets } from '../ui-audit/lib/cdp.mjs';
import { PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';
import { startBrowserFixture } from '../fixtures/plugin-browser.mjs';

export const covers = ['examples/plugins/browser-lab/', 'packages/plugin-sdk/', 'packages/client/src/features/',
    'packages/client/src/plugins/', 'packages/client/src/webpane/', 'packages/client/src/App.tsx',
    'packages/client/src/app/RemoteWorkspaceView.tsx', 'packages/client/src/phone/PhoneRemoteWorkspace.tsx',
    'packages/daemon/src/plugins/', 'packages/daemon/src/webpane/', 'packages/shell/src/webhost/'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginID = 'example.browser-lab', viewID = `${pluginID}.browser`;
const packagePath = path.join(repoRoot, 'examples/plugins/browser-lab');
const frame = id => `[data-testid="plugin-view-${id}"] iframe`;
const PLACEMENT = /web pane ([0-9A-Fa-f-]{36}) view owner=(main|holder) bounds=(\S+ \S+|-) \(([^)]*)\)/;
function placementOf(shell, paneID) {
    let value = null;
    for (const line of shell?.lines ?? []) { const found = PLACEMENT.exec(line); if (found?.[1] === paneID) value = { owner: found[2], bounds: found[3], reason: found[4] }; }
    return value;
}

export default async function ({ page, cli, sandbox, rec, d, harness, shell, sleep }) {
    if (!shell) throw new Error('Browser native-placement validation needs a launched private shell, not --attach');
    await page.watchFrames();
    const fixture = await startBrowserFixture();
    const nativeTargets = [];
    const originalURL = await page.eval('location.href'), originalDPR = await page.eval('devicePixelRatio'), config = fs.readFileSync(sandbox.configPath, 'utf8');
    const json = async (args, target = cli) => JSON.parse(await target.ok(args));
    const initial = new Set((await json(['workspace', 'list', '--json'])).map(item => item.id));
    const inside = (id, expression) => page.evalInFrame(frame(id), expression);
    const check = (id, expression, ceilingMs = 15_000) => d.settle(async () => {
        try { return await inside(id, expression); } catch { return false; }
    }, { ceilingMs });
    const ready = id => check(id, `document.body.dataset.ready === 'true' && !document.body.dataset.error`);
    const choose = async (id, choice = viewID) => {
        const selector = `[data-browser-pane="${id}"] select[aria-label="Browser renderer"]`;
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(selector)})`)) throw new Error(`Missing browser renderer picker for ${id}`);
        await page.eval(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(choice)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    };
    const click = async (id, selector) => {
        if (!await check(id, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); return element && !element.disabled && !element.hidden && element.getBoundingClientRect().width > 0; })()`)) throw new Error(`Missing or disabled ${selector}`);
        // A newly-created OOPIF can publish its DOM before Chromium routes input to it.
        await inside(id, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); const observed = globalThis.__browserScenarioPointer = {}; const move = event => { observed.reached = event.isTrusted && element.contains(event.target); observed.x=event.clientX; observed.y=event.clientY; }; document.addEventListener('pointermove', move, true); observed.stop = () => document.removeEventListener('pointermove', move, true); })()`);
        try {
            let point;
            if (!await d.settle(async () => {
                const inner = await inside(id, `(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:box.x+box.width/2,y:box.y+box.height/2}; })()`);
                const outer = await page.box(frame(id)); point = {x:outer.x+inner.x,y:outer.y+inner.y};
                await page.mouse('mouseMoved', point.x, point.y, {button:'none',buttons:0});
                return inside(id, `__browserScenarioPointer.reached && Math.abs(__browserScenarioPointer.x-${inner.x}) < 1 && Math.abs(__browserScenarioPointer.y-${inner.y}) < 1`);
            }, {ceilingMs:5000})) throw new Error(`Pointer did not reach ${selector}`);
            await page.clickAt(point.x, point.y);
        } finally { await inside(id, '__browserScenarioPointer?.stop()').catch(() => {}); }
    };
    const fill = async (id, selector, value) => {
        await click(id, selector);
        await page.send('Input.dispatchKeyEvent', {type:'rawKeyDown',code:'KeyA',key:'a',windowsVirtualKeyCode:65,modifiers:4,commands:['selectAll']});
        await page.send('Input.dispatchKeyEvent', {type:'keyUp',code:'KeyA',key:'a',windowsVirtualKeyCode:65,modifiers:4});
        await page.insertText(value);
        if (!await check(id, `document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(value)}`)) throw new Error(`Typing did not reach ${selector}`);
    };
    const open = async (target, name, suffix) => {
        const workspace = await json(['workspace', 'create', '--name', name, '--json'], target);
        const terminal = (await json(['pane', 'list', '--workspace', workspace.workspace_id, '--json'], target))[0].id;
        const url = `${fixture.url}/page/one?owner=${suffix}`;
        const opened = await target.ok(['web', 'open', url], {paneID:terminal});
        const paneID = /open ok:\s*([0-9a-f-]{36})/i.exec(opened)?.[1];
        if (!paneID) throw new Error(`Web pane did not open: ${opened}`);
        await target.ok(['pane', 'close', '--target', terminal]);
        return {paneID,workspaceID:workspace.workspace_id,url};
    };
    const targetFor = async (port, url, excludeID) => {
        let found;
        if (!await d.settle(async () => { found = (await listTargets(port)).find(target => target.type === 'page' && target.url === url && target.id !== excludeID); return found; }, {ceilingMs:20_000})) throw new Error(`No native page target for ${url}`);
        const session = await connect(found.webSocketDebuggerUrl, {repoRoot});
        if (!await d.settle(async () => { try { return await session.eval('!!globalThis.browserFixture'); } catch { return false; } })) throw new Error('Native fixture did not initialize');
        nativeTargets.push({id:found.id,url,at:Date.now()});
        return {id:found.id,page:session};
    };
    const owner = (id, expected = 'main', process = shell) => d.settle(() => placementOf(process, id)?.owner === expected, {ceilingMs:15_000});
    const geometryMatches = id => d.settle(async () => {
        const actual = /^(\d+),(\d+) (\d+)×(\d+)$/.exec(placementOf(shell,id)?.bounds ?? '');
        if (!actual || placementOf(shell,id)?.owner !== 'main') return false;
        const inner = await inside(id,`(() => { const b=document.getElementById('page-slot').getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; })()`);
        const outer = await page.box(frame(id));
        const scale = await page.eval(`devicePixelRatio / ${originalDPR}`);
        // The host reserves its existing 2 CSS-pixel focus-ring gutter on the page's
        // left/right/bottom edges, then Electron rounds edge coordinates into native DIPs.
        const left = Math.round((outer.x+inner.x+2)*scale), top = Math.round((outer.y+inner.y)*scale);
        const right = Math.round((outer.x+inner.x+inner.w-2)*scale), bottom = Math.round((outer.y+inner.y+inner.h-2)*scale);
        return [left,top,right-left,bottom-top].every((value,index) => Math.abs(value-Number(actual[index+1])) <= 1);
    }, {ceilingMs:10_000});
    const snapshot = native => native.page.eval('browserFixture.state()');
    const sameState = async (native, before) => {
        try { const after = await snapshot(native); return ['instance','note','clicks','cookies','storage'].every(key => after[key] === before[key]); } catch { return false; }
    };
    const builtFiles = ['packages/daemon/dist/kelpid.js','packages/cli/dist/kelpi.js','packages/client/dist/index.html','packages/shell/dist/main.js','packages/plugin-sdk/browser.js','packages/plugin-sdk/api.js',
        'examples/plugins/browser-lab/kelpi.plugin.json','examples/plugins/browser-lab/ui/index.html','examples/plugins/browser-lab/ui/browser.js','examples/plugins/browser-lab/ui/style.css',
        'scripts/fixtures/plugin-browser.mjs','scripts/scenarios/plugin-browser-features.mjs',
        ...fs.readdirSync(path.join(repoRoot,'packages/client/dist/assets')).filter(file => /\.(js|css)$/.test(file)).map(file => `packages/client/dist/assets/${file}`)];
    fs.writeFileSync(path.join(rec.outDir,'build-manifest.json'), JSON.stringify(Object.fromEntries(builtFiles.sort().map(file => [file,createHash('sha256').update(fs.readFileSync(path.join(repoRoot,file))).digest('hex')])),null,2)+'\n');
    let local, native, remote, remoteNative;
    const diagnostics = async label => {
        const data = { requests:fixture.requests, nativeTargets, placements:shell.lines.filter(line => /web pane .* view owner=/.test(line)),
            local:local && {pane:local,placement:placementOf(shell,local.paneID),native:native && await snapshot(native).catch(error => ({error:String(error)})),
                plugin:await inside(local.paneID,'({state:browserLab.state,presentation:browserLab.presentation,actions:browserLab.actions,body:{...document.body.dataset}})').catch(() => null)},
            remote:remote && {placements:remote.shell.lines.filter(line => /web pane .* view owner=/.test(line)),native:remoteNative && await snapshot(remoteNative).catch(() => null)} };
        fs.writeFileSync(path.join(rec.outDir,`${label}-diagnostics.json`),JSON.stringify(data,null,2)+'\n');
    };
    const nativeShot = async (native, label) => rec.shot({screenshot:async file => {
        const shot = await native.page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});
        fs.writeFileSync(file,Buffer.from(shot.data,'base64')); return file;
    }},label);
    try {
        rec.note('Native page lifecycle and plugin browser controls');
        local = await open(cli,'Browser Lab','local');
        native = await targetFor(sandbox.debugPort,local.url);
        if (!await owner(local.paneID)) throw new Error('Native page did not enter the shell window');
        await native.page.click('#note'); await native.page.insertText('Unsaved native note — café 東京');
        await native.page.click('#increment'); await native.page.click('#cookie');
        const original = await snapshot(native);
        rec.check('fixture has actual page input, JS state, cookies and local storage', original.clicks === 1 && original.note.includes('東京') && original.cookies.includes('kelpi_browser_fixture=saved') && original.storage === 'persistent fixture value');
        await cli.ok(['plugin','install',packagePath,'--trust']);
        await choose(local.paneID); if (!await ready(local.paneID)) throw new Error('Browser Lab did not attach');
        rec.check('browser replacement is an isolated SDK-only view of the existing native pane', await inside(local.paneID,`(() => { try { parent.document.body; return false; } catch { return true; } })()`) && (await json(['plugin','list','--json'])).find(item => item.manifest.id === pluginID).manifest.backend === undefined && (await json(['pane','list','--workspace',local.workspaceID,'--json']))[0].type === 'web');
        rec.check('selecting Browser Lab retains the native target and unsaved page state', await owner(local.paneID) && await sameState(native,original) && (await listTargets(sandbox.debugPort)).some(target => target.id === native.id));
        rec.check('the public snapshot and presentation identify the actual shell host', await check(local.paneID,`browserLab.state.host.available && browserLab.presentation.available && browserLab.presentation.visible && browserLab.state.tabs[0].url === ${JSON.stringify(local.url)}`));
        rec.check('native page bounds match the plugin’s measured page slot and focus gutter', await geometryMatches(local.paneID), JSON.stringify(placementOf(shell,local.paneID)));

        await click(local.paneID,'#tools');
        rec.check('a plugin popup parks the native page before interaction', await owner(local.paneID,'holder') && await check(local.paneID,`!document.getElementById('tools-panel').hidden`) && await sameState(native,original));
        await click(local.paneID,'#capture');
        rec.check('typed SDK capture reads the hosted page behind the parked popup', await check(local.paneID,`document.getElementById('capture-result').textContent.includes('kelpi-browser-needle')`));
        await rec.shot(page,'browser-lab-covered-tools');
        await click(local.paneID,'#tools');
        rec.check('closing the plugin popup restores the same native page', await owner(local.paneID) && await sameState(native,original));

        await choose(local.paneID,'kelpi.web');
        rec.check('bundled renderer restoration retains the live page and cookies', await d.settleDom(page,`document.querySelector('[data-browser-pane="${local.paneID}"]').dataset.browserRenderer === 'kelpi.web'`) && await owner(local.paneID) && await sameState(native,original));
        await choose(local.paneID); if (!await ready(local.paneID)) throw new Error('Browser Lab reselection failed');
        await cli.ok(['plugin','reload',pluginID]);
        rec.check('plugin reload restores its surface without recreating WebContents', await ready(local.paneID) && await owner(local.paneID) && await sameState(native,original));
        await page.send('Page.reload');
        rec.check('client window reload preserves renderer selection and native page identity', await ready(local.paneID) && await owner(local.paneID) && await sameState(native,original));
        await inside(local.paneID,`setTimeout(() => { throw new Error('Owned browser renderer failure'); },0); true`);
        rec.check('a failed plugin releases geometry and falls back to the bundled browser', await d.settleDom(page,`document.querySelector('[data-browser-pane="${local.paneID}"]').dataset.browserRenderer === 'kelpi.web'`) && await owner(local.paneID) && await sameState(native,original));
        await cli.ok(['plugin','reload',pluginID]); if (!await ready(local.paneID)) throw new Error('Failed view did not recover after reload');
        await cli.ok(['plugin','disable',pluginID]);
        rec.check('disabling the plugin returns to native controls with the page intact', await d.settleDom(page,`document.querySelector('[data-browser-pane="${local.paneID}"]').dataset.browserRenderer === 'kelpi.web'`) && await owner(local.paneID) && await sameState(native,original));
        await cli.ok(['plugin','enable',pluginID]);
        rec.check('reenabling restores the saved replacement and the same page', await ready(local.paneID) && await owner(local.paneID) && await sameState(native,original));
        await cli.ok(['pane','split','--target',local.paneID,'--direction','horizontal']);
        const sibling = (await json(['pane','list','--workspace',local.workspaceID,'--json'])).find(pane => pane.id !== local.paneID).id;
        await page.click(`[data-testid="pane-header-${sibling}"]`,{clickCount:2});
        rec.check('zooming a sibling parks the hidden browser without replacing its page', await owner(local.paneID,'holder') && await sameState(native,original));
        await page.click(`[data-testid="pane-header-${sibling}"]`,{clickCount:2});
        rec.check('leaving sibling zoom restores the browser surface and live page', await ready(local.paneID) && await owner(local.paneID) && await sameState(native,original));
        await cli.ok(['pane','close','--target',sibling]);
        await cli.ok(['workspace','create','--name','Browser hide control','--json']);
        rec.check('switching workspaces parks the plugin’s native browser page', await owner(local.paneID,'holder') && await sameState(native,original));
        await page.click(`[data-testid="workspace-row"][data-workspace-id="${local.workspaceID}"]`);
        rec.check('returning to the workspace restores the same browser target and state', await ready(local.paneID) && await owner(local.paneID) && await sameState(native,original));

        await inside(local.paneID,'browserLab.surface.focus(); true');
        await native.page.key('KeyL',{key:'l',keyCode:76,modifiers:d.MOD.meta});
        rec.check('Cmd+L from the native page focuses the plugin address field', await check(local.paneID,`document.activeElement === document.getElementById('address') && browserLab.actions.includes('focusAddress')`));
        const draft = 'draft-address-kept-while-page-redirects';
        await fill(local.paneID,'#address',draft);
        await cli.ok(['web','navigate',`${fixture.url}/redirect?owner=local`,'--target',local.paneID]);
        rec.check('live navigation updates preserve an actively edited address draft', await check(local.paneID,`browserLab.state.tabs.find(tab => tab.id === browserLab.state.activeTabID)?.url.includes('/page/two') && document.getElementById('address').value === ${JSON.stringify(draft)}`));
        await fill(local.paneID,'#address',local.url); await click(local.paneID,'#navigate');
        rec.check('a typed address navigates the owning native tab and returns native focus', await d.settle(async () => { try { return (await snapshot(native)).url === local.url; } catch { return false; } }) && await check(local.paneID,`document.activeElement !== document.getElementById('address')`));
        await click(local.paneID,'#back');
        rec.check('replacement Back follows native history', await d.settle(async () => { try { return (await snapshot(native)).page === '/page/two'; } catch { return false; } }));
        await click(local.paneID,'#forward');
        rec.check('replacement Forward follows native history', await d.settle(async () => { try { return (await snapshot(native)).page === '/page/one'; } catch { return false; } }));
        await inside(local.paneID,'browserLab.surface.focus(); true');
        await native.page.key('KeyF',{key:'f',keyCode:70,modifiers:d.MOD.meta});
        rec.check('Cmd+F from the native page opens the custom find row', await check(local.paneID,`document.activeElement === document.getElementById('find-input') && browserLab.actions.includes('showFind')`));
        await fill(local.paneID,'#find-input','kelpi-browser-needle');
        rec.check('custom Find reports native match results', await check(local.paneID,`/2/.test(document.getElementById('matches').textContent)`));
        await click(local.paneID,'#find-next');
        rec.check('custom Find can advance to the second native match', await check(local.paneID,`document.getElementById('matches').textContent.startsWith('2 /')`));
        await click(local.paneID,'#find-close');
        rec.check('closing custom Find clears the native marks', await d.settle(() => native.page.eval("document.querySelectorAll('.kelpi-webfind-match').length === 0")));
        await click(local.paneID,'#find');
        rec.check('reopening custom Find restores the retained query and native marks', await check(local.paneID,`document.getElementById('find-input').value === 'kelpi-browser-needle' && document.getElementById('matches').textContent === '1 / 2'`) && await d.settle(() => native.page.eval("document.querySelectorAll('.kelpi-webfind-match').length === 2")));
        await click(local.paneID,'#find-next');
        rec.check('reopened custom Find advances through the restored matches', await check(local.paneID,`document.getElementById('matches').textContent === '2 / 2'`));
        await click(local.paneID,'#find-close');

        const firstTab = await inside(local.paneID,'browserLab.state.activeTabID');
        const firstState = await snapshot(native);
        await click(local.paneID,'#new-tab');
        rec.check('custom New tab creates a native tab and focuses the address', await check(local.paneID,`browserLab.state.tabs.length === 2 && document.activeElement === document.getElementById('address')`));
        await fill(local.paneID,'#address',`${fixture.url}/page/two?owner=local-new`); await page.enter();
        if (!await check(local.paneID,`browserLab.state.tabs.find(tab => tab.id === browserLab.state.activeTabID)?.title.includes('Second page')`)) throw new Error('New tab did not navigate');
        await click(local.paneID,`[data-tab="${firstTab}"]`);
        rec.check('switching native tabs retains the original tab’s in-memory state', await check(local.paneID,`browserLab.state.activeTabID === '${firstTab}'`) && await sameState(native,firstState));
        const extraTab = await inside(local.paneID,`browserLab.state.tabs.find(tab => tab.id !== '${firstTab}').id`);
        await click(local.paneID,`[data-close-tab="${extraTab}"]`);
        rec.check('closing a custom tab removes only that native tab', await check(local.paneID,`browserLab.state.tabs.length === 1 && browserLab.state.activeTabID === '${firstTab}'`) && await sameState(native,firstState));
        await click(local.paneID,'#favourite');
        rec.check('custom bookmarks update daemon-owned favourites', await check(local.paneID,`browserLab.state.favourites.some(item => item.url === ${JSON.stringify(local.url)}) && document.getElementById('favourite').getAttribute('aria-pressed') === 'true'`));
        await click(local.paneID,'#bookmarks');
        rec.check('bookmark popover participates in native occlusion', await owner(local.paneID,'holder') && await check(local.paneID,`document.querySelector('#bookmark-items .open').title === ${JSON.stringify(local.url)}`));
        await click(local.paneID,'#bookmarks');

        const geometryBefore = await snapshot(native);
        await click(local.paneID,'#tools'); await click(local.paneID,'#zoom-in'); await click(local.paneID,'#tools');
        rec.check('plugin zoom uses native page scaling', await owner(local.paneID) && await d.settle(async () => (await snapshot(native)).innerWidth < geometryBefore.innerWidth));
        await click(local.paneID,'#tools'); await click(local.paneID,'#zoom-reset'); await click(local.paneID,'#tools');
        rec.check('reset zoom restores native page geometry', await owner(local.paneID) && await d.settle(async () => (await snapshot(native)).innerWidth === geometryBefore.innerWidth));
        await page.send('Emulation.setDeviceMetricsOverride',{width:900,height:650,deviceScaleFactor:1,mobile:false});
        rec.check('resizing the client updates the exact reserved native page rectangle', await geometryMatches(local.paneID) && await d.settle(async () => (await snapshot(native)).innerWidth < geometryBefore.innerWidth));
        await page.send('Emulation.clearDeviceMetricsOverride'); if (!await owner(local.paneID)) throw new Error('Native placement did not restore after resize');
        await click(local.paneID,'#address'); await page.key('Comma',{modifiers:d.MOD.meta,key:','});
        rec.check('an app settings modal covers and parks the replacement’s native page', await d.settleDom(page,`document.querySelector('[data-testid="settings-close"]')`) && await owner(local.paneID,'holder'));
        await rec.shot(page,'browser-lab-app-modal');
        await page.click('[data-testid="settings-close"]');
        rec.check('closing the app modal restores the existing native page', await owner(local.paneID) && await sameState(native,firstState));
        await click(local.paneID,'#tools'); await click(local.paneID,'#inspect');
        if (!await owner(local.paneID)) throw new Error('Inspector did not uncover native page');
        const beforePick = await inside(local.paneID,'browserLab.state.inspection.revision');
        await native.page.click('#increment');
        rec.check('a native element pick invalidates the public watch without polling inspector results', await check(local.paneID,`browserLab.state.inspection.revision > ${beforePick} && browserLab.state.inspection.pendingResults === 1`));
        rec.check('SDK inspector collects an actual native-page selection', await check(local.paneID,`(async () => { const result = await kelpi.browser.inspectResult(browserLab.state.paneID); return JSON.stringify(result).includes('increment'); })()`));
        await inside(local.paneID,'kelpi.browser.inspectResult(browserLab.state.paneID,{clear:true})');
        rec.check('clearing collected picks updates the public inspection metadata', await check(local.paneID,'browserLab.state.inspection.pendingResults === 0'));
        await inside(local.paneID,'kelpi.browser.batch.toggle(browserLab.state.paneID)');
        if (!await check(local.paneID,'browserLab.state.inspection.batchVisible && browserLab.state.inspection.armed')) throw new Error('Native batch picker did not arm');
        const beforeBatchPick = await inside(local.paneID,'browserLab.state.inspection.revision');
        await native.page.click('#increment');
        rec.check('a native batch pick invalidates the public browser watch', await check(local.paneID,`browserLab.state.inspection.revision > ${beforeBatchPick} && browserLab.state.inspection.batchItems === 1`));
        const beforeComment = await inside(local.paneID,'browserLab.state.inspection.revision');
        await inside(local.paneID,`(async () => { const result = await kelpi.browser.batch.state(browserLab.state.paneID); await kelpi.browser.batch.comment(browserLab.state.paneID,result.batch.items[0].id,'SDK comment'); })()`);
        rec.check('same-count batch comment edits advance the watch revision', await check(local.paneID,`browserLab.state.inspection.revision > ${beforeComment} && browserLab.state.inspection.batchItems === 1`));
        await inside(local.paneID,'kelpi.browser.batch.cancel(browserLab.state.paneID)');
        if (!await check(local.paneID,'!browserLab.state.inspection.batchVisible && browserLab.state.inspection.batchItems === 0')) throw new Error('Native batch picker did not cancel');

        rec.note('Private mode intentionally rebuilds native pages and switches session partitions');
        await inside(local.paneID,'kelpi.browser.inspect(browserLab.state.paneID)');
        if (!await check(local.paneID,'browserLab.state.inspection.armed')) throw new Error('Native inspector did not arm before session switch');
        const beforePrivate = await snapshot(native);
        await click(local.paneID,'#tools'); await click(local.paneID,'#private');
        rec.check('private mode warns before discarding live page state', await check(local.paneID,`!document.getElementById('confirmation').hidden && document.getElementById('confirmation-message').textContent.includes('Unsaved page state will be lost')`) && await sameState(native,beforePrivate));
        await click(local.paneID,'#cancel-private');
        rec.check('cancelling private mode leaves native page state untouched', await sameState(native,beforePrivate) && await check(local.paneID,'!browserLab.state.isPrivate'));
        await click(local.paneID,'#private');
        // Another client can change the shared session while this confirmation is open.
        // Confirming Enable must remain an Enable intent after that watch update.
        await cli.ok(['web','private','on','--target',local.paneID]);
        native.page.close(); native = await targetFor(sandbox.debugPort,local.url,native.id);
        const privateState = await snapshot(native);
        if (!await check(local.paneID,"browserLab.state.isPrivate && document.getElementById('confirm-private').textContent === 'Enable private mode'")) throw new Error('Private-mode watch did not update the open Enable confirmation');
        await click(local.paneID,'#confirm-private');
        rec.check('Enable confirmation preserves private mode when another client already enabled it', await check(local.paneID,"browserLab.state.isPrivate && document.getElementById('confirmation').hidden") && await sameState(native,privateState));
        rec.check('private mode rebuilds against an isolated native session and clears stale inspection', await check(local.paneID,'browserLab.state.isPrivate && !browserLab.state.inspection.armed') && privateState.instance !== beforePrivate.instance && privateState.cookies === '' && privateState.storage === null);
        await native.page.click('#cookie'); const privateSaved = await snapshot(native);
        await cli.ok(['plugin','reload',pluginID]);
        rec.check('plugin reload preserves the private page and its ephemeral session', await ready(local.paneID) && await owner(local.paneID) && await sameState(native,privateSaved));
        await click(local.paneID,'#tools'); await click(local.paneID,'#private'); await click(local.paneID,'#confirm-private');
        native.page.close(); native = await targetFor(sandbox.debugPort,local.url,native.id);
        rec.check('leaving private mode restores the saved native session', await check(local.paneID,'!browserLab.state.isPrivate') && (await snapshot(native)).cookies.includes('kelpi_browser_fixture=saved') && (await snapshot(native)).storage === 'persistent fixture value');
        await harness.crash(local.paneID); native.page.close(); native = await targetFor(sandbox.debugPort,local.url,native.id);
        rec.check('a single native page crash recovers beneath the plugin controls', await owner(local.paneID) && await ready(local.paneID) && (await snapshot(native)).cookies.includes('kelpi_browser_fixture=saved'));
        await harness.crash(local.paneID); native.page.close();
        rec.check('repeat native crashes show the host-owned recovery card', await d.settleDom(page,`document.querySelector('[data-testid="web-crashed-${local.paneID}"]')`));
        await page.click(`[data-testid="web-crashed-reload-${local.paneID}"]`); native = await targetFor(sandbox.debugPort,local.url);
        rec.check('host recovery reload works with custom browser controls selected', await owner(local.paneID) && await ready(local.paneID) && !await page.eval(`!!document.querySelector('[data-testid="web-crashed-${local.paneID}"]')`));
        await diagnostics('desktop');
        await rec.shot(page,'browser-lab-desktop-chrome'); await nativeShot(native,'browser-lab-native-page');

        rec.note('Remote controls cannot claim page pixels from another native shell');
        const localBeforeRemote = await snapshot(native);
        remote = await d.boot({repoRoot,label:'browser-remote',build:false,window:'hidden',log:message => rec.note(`remote: ${message}`)});
        const remotePane = await open(remote.cli,'Remote Browser Lab','remote');
        remoteNative = await targetFor(remote.sandbox.debugPort,remotePane.url);
        await remote.cli.ok(['plugin','install',packagePath,'--trust']);
        const token = fs.readFileSync(path.join(remote.sandbox.runDir,`daemon-v${PROTOCOL_VERSION}.token`),'utf8').trim();
        fs.writeFileSync(sandbox.configPath,`${config}\nremote-daemon = BrowserRemote:${remote.sandbox.base}/?token=${token}\n`);
        if (!await check(local.paneID,`(async () => (await kelpi.ui.getNavigation()).hosts.some(host => host.name === 'BrowserRemote' && host.connection === 'connected'))()`)) throw new Error('Remote daemon did not connect');
        await inside(local.paneID,`void (async () => { const navigation = await kelpi.ui.getNavigation(); await kelpi.ui.selectWorkspace(navigation.hosts.find(host => host.name === 'BrowserRemote').id, '${remotePane.workspaceID}'); })(); true`);
        await choose(remotePane.paneID); if (!await ready(remotePane.paneID)) throw new Error('Remote Browser Lab did not attach');
        rec.check('embedded remote controls report that page display belongs to another shell', await check(remotePane.paneID,'browserLab.state.host.available && !browserLab.presentation.available') && await owner(remotePane.paneID,'main',remote.shell) && placementOf(shell,remotePane.paneID) === null);
        await fill(remotePane.paneID,'#address',`${fixture.url}/page/two?owner=remote`); await page.enter();
        rec.check('remote navigation targets its own native page and preserves the local address caret', await d.settle(async () => { try { return (await snapshot(remoteNative)).page === '/page/two'; } catch { return false; } }) && await sameState(native,localBeforeRemote) && await check(remotePane.paneID,`document.activeElement === document.getElementById('address')`));
        rec.check('the remote SDK refuses a pane from the local daemon', await inside(remotePane.paneID,`kelpi.browser.get('${local.paneID}').then(() => false, () => true)`));
        await choose(remotePane.paneID,'kelpi.web');
        const remoteAddress = `[data-testid="web-url-${remotePane.paneID}"]`;
        await page.click(remoteAddress);
        await page.eval(`document.querySelector(${JSON.stringify(remoteAddress)}).addEventListener('keydown', event => { globalThis.__browserNativeCaret = {prevented:event.defaultPrevented,trusted:event.isTrusted}; },{once:true})`);
        await page.key('ArrowLeft',{key:'ArrowLeft',modifiers:d.MOD.meta});
        rec.check('remote bundled browser preserves native address editing chords', await page.eval('globalThis.__browserNativeCaret?.trusted && !globalThis.__browserNativeCaret.prevented') && (await snapshot(remoteNative)).page === '/page/two');
        await page.key('KeyF',{key:'f',keyCode:70,modifiers:d.MOD.meta});
        const remoteFind = `[data-testid="web-find-input-${remotePane.paneID}"]`;
        if (!await d.settleDom(page,`document.activeElement === document.querySelector(${JSON.stringify(remoteFind)})`)) throw new Error('Remote bundled Find shortcut did not focus its search field');
        await page.insertText('kelpi-browser-needle');
        rec.check('remote bundled browser shortcuts search only their owning native page', await d.settleDom(page,`document.querySelector('[data-testid="web-find-count-${remotePane.paneID}"]')?.textContent.includes('2')`) && await sameState(native,localBeforeRemote));
        await page.click(`[data-testid="web-find-close-${remotePane.paneID}"]`);
        await page.click(`[data-testid="web-batch-toggle-${remotePane.paneID}"]`);
        rec.check('remote bundled pickup shows its owning daemon session and controls', await d.settleDom(page,`document.querySelector('[data-testid="web-batch-panel-${remotePane.paneID}"]') && document.querySelector('[data-testid="web-batch-toggle-${remotePane.paneID}"]').getAttribute('aria-label') === 'Hide element pickup'`) && await d.settle(() => remoteNative.page.eval('window.__kelpiInspectorArmed?.() === true')));
        await remoteNative.page.click('#increment');
        rec.check('a native pick appears in the remote bundled pickup panel', await d.settleDom(page,`document.querySelector('[data-testid="web-batch-items-${remotePane.paneID}"]')?.textContent.includes('increment')`) && await sameState(native,localBeforeRemote));
        await page.click(`[data-testid="web-batch-cancel-${remotePane.paneID}"]`);
        rec.check('remote bundled Cancel clears the panel and native picker', await d.settleDom(page,`!document.querySelector('[data-testid="web-batch-panel-${remotePane.paneID}"]') && document.querySelector('[data-testid="web-batch-toggle-${remotePane.paneID}"]').getAttribute('aria-label') === 'Start element pickup'`) && await d.settle(() => remoteNative.page.eval('window.__kelpiInspectorArmed?.() === false')));
        await choose(remotePane.paneID); if (!await ready(remotePane.paneID)) throw new Error('Remote custom browser did not restore');
        const remoteBeforePhone = await snapshot(remoteNative);
        await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
        await page.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
        const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${remotePane.workspaceID}"]`;
        if (await d.settleDom(page,`document.querySelector(${JSON.stringify(phoneRow)})`)) await page.click(phoneRow);
        rec.check('phone Browser Lab controls remain available with an explicit native-display limit', await ready(remotePane.paneID) && await check(remotePane.paneID,'!browserLab.presentation.available') && await sameState(remoteNative,remoteBeforePhone));
        rec.check('phone browser controls fit the viewport and do not mount a terminal key bar', await check(remotePane.paneID,'document.documentElement.scrollWidth <= document.documentElement.clientWidth') && !await page.eval(`!!document.querySelector('[data-testid="terminal-key-ctrl-${remotePane.paneID}"]')`));
        await rec.shot({screenshot:async file => { const shot = await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true}); fs.writeFileSync(file,Buffer.from(shot.data,'base64')); return file; }},'browser-lab-phone');
        await page.send('Emulation.clearDeviceMetricsOverride'); await page.send('Emulation.setTouchEmulationEnabled',{enabled:false});
        await page.send('Page.navigate',{url:`${remote.sandbox.base}/?token=${token}`});
        await choose(remotePane.paneID);
        rec.check('a direct browser client exposes controls without pretending to host native pixels', await ready(remotePane.paneID) && await check(remotePane.paneID,'browserLab.state.host.available && !browserLab.presentation.available') && await owner(remotePane.paneID,'main',remote.shell) && await sameState(remoteNative,remoteBeforePhone));
        await inside(remotePane.paneID,'kelpi.browser.inspect(browserLab.state.paneID)');
        if (!await check(remotePane.paneID,'browserLab.state.inspection.armed')) throw new Error('Remote inspector did not arm before host loss');
        await remote.shell.quit(); remoteNative.page.close(); remoteNative = null;
        rec.check('host loss updates availability and clears stale native inspection', await check(remotePane.paneID,'!browserLab.state.host.available && !browserLab.state.inspection.armed',20_000));
        await page.send('Page.navigate',{url:originalURL});
        rec.check('returning to the original shell restores its same local page', await ready(local.paneID) && await owner(local.paneID) && await sameState(native,localBeforeRemote));
        rec.note('The onscreen harness captures the composed native window, including its sibling WebContentsView. A separate native-page capture and placement logs corroborate page composition and ownership. Hidden screenshots are not visual evidence. Phone coverage uses emulation; physical-device keyboards and OS IME remain manual.');
    } catch (error) { await diagnostics('failure').catch(() => {}); await rec.shot(page,'browser-failure').catch(() => {}); throw error; }
    finally {
        await diagnostics('final').catch(() => {});
        fs.writeFileSync(sandbox.configPath,config);
        await page.send('Emulation.clearDeviceMetricsOverride').catch(() => {}); await page.send('Emulation.setTouchEmulationEnabled',{enabled:false}).catch(() => {});
        await page.send('Page.navigate',{url:originalURL}).catch(() => {});
        native?.page.close(); remoteNative?.page.close();
        if (remote) await remote.stop();
        await cli.run(['plugin','remove',pluginID]);
        for (const workspace of await json(['workspace','list','--json'])) if (!initial.has(workspace.id)) await cli.run(['workspace','delete',workspace.id,'--force']);
        await fixture.close();
    }
}
