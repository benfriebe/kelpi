import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const covers = ['examples/plugins/ui-lab/', 'packages/protocol/src/plugin', 'packages/daemon/src/plugins/',
    'packages/client/src/plugins/', 'packages/client/src/interaction/', 'packages/client/src/App.tsx', 'packages/client/src/chrome/',
    'packages/client/src/grid/', 'packages/plugin-sdk/'];
const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/plugins/ui-lab');
const id = 'example.ui-lab';

export default async function ({ page, cli, rec, d }) {
    await page.watchFrames();
    const json = async args => JSON.parse(await cli.ok(args));
    const workspace = await json(['workspace', 'create', '--name', 'Plugin UI validation', '--json']);
    const workspaceID = workspace.workspace_id;
    const snapshot = () => json(['plugin', 'run', `${id}.snapshot`]);
    const toggle = (field, value) => cli.ok(['plugin', 'run', `${id}.toggle`, '--args', JSON.stringify({ field, value })]);
    const painted = () => page.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    const selectAll = async () => {
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4 });
    };
    const modal = '[data-testid="plugin-ui-dialog"]';
    try {
        await cli.ok(['plugin', 'install', packagePath, '--trust']);
        const pane = await json(['plugin', 'open', id, `${id}.panel`, '--workspace', workspaceID]);
        const frame = `[data-testid="plugin-view-${pane.paneID}"] iframe`;
        const inFrame = expression => page.evalInFrame(frame, expression);
        const frameCheck = expression => d.settle(async () => { try { return await inFrame(expression); } catch { return false; } }, { ceilingMs: 12_000 });
        const ready = () => frameCheck(`document.body.dataset.ready === 'true'`);
        const clickFrame = async target => {
            if (!await frameCheck(`document.querySelector(${JSON.stringify(target)}) && !document.querySelector(${JSON.stringify(target)}).disabled`)) throw new Error(`Missing or disabled ${target}`);
            const inner = await inFrame(`(() => { const target = document.querySelector(${JSON.stringify(target)}); target.scrollIntoView({block:'center'}); const box = target.getBoundingClientRect(); return {x:box.x + box.width/2,y:box.y + box.height/2}; })()`);
            await painted();
            const outer = await page.box(frame);
            await page.clickAt(outer.x + inner.x, outer.y + inner.y);
        };
        const output = (name, value) => frameCheck(`document.getElementById('${name}-result').textContent === ${JSON.stringify(JSON.stringify(value))}`);
        const item = (name, container = '') => `${container} [data-plugin-item="${id}.${name}"]`.trim();
        const counter = item('counter');
        const paneItem = item('pane', `[data-testid="pane-header-${pane.paneID}"]`);
        const countIs = count => d.settleDom(page, `document.querySelector(${JSON.stringify(counter)})?.getAttribute('aria-label')?.endsWith(', ${count}')`);
        rec.check('UI Lab attaches a real isolated plugin pane', await ready() && await inFrame(`(() => { try { parent.document.body; return false; } catch { return true; } })()`));
        rec.check('all native contribution placements render with the initial badge', await countIs(0)
            && await d.settleDom(page, `document.querySelector(${JSON.stringify(paneItem)}) && document.querySelector('[data-testid="workspace-contributions"] [data-plugin-item="${id}.workspace"]')`));
        rec.check('the CLI exposes sequenced contribution state', (await json(['plugin', 'contributions', '--json'])).some(row => row.pluginID === id && row.sequence >= 1 && row.state.context.count === 0));
        await page.click(counter);
        rec.check('clicking a native status item executes the backend and broadcasts its new badge', await countIs(1) && await frameCheck(`document.getElementById('count').textContent === '1'`));
        await page.click(paneItem);
        rec.check('pane header actions carry their explicit pane and workspace context', await countIs(2) && (await snapshot()).lastInvocation?.paneID === pane.paneID && (await snapshot()).lastInvocation?.workspaceID === workspaceID);
        await clickFrame('#toggle-enabled');
        rec.check('context changes disable native items and leave them visible', await d.settleDom(page, `document.querySelector(${JSON.stringify(counter)})?.disabled && document.querySelector(${JSON.stringify(paneItem)})?.disabled`));
        const disabledCount = (await snapshot()).state.context.count;
        await page.key('KeyU', { modifiers: 3, key: 'u', keyCode: 85 });
        rec.check('a disabled plugin shortcut leaves the backend unchanged', (await snapshot()).state.context.count === disabledCount);
        await page.key('KeyP', { modifiers: 4, key: 'p', keyCode: 80 });
        if (!await d.settleDom(page, `document.querySelector('[data-testid="command-palette"]')`)) throw new Error('palette did not open');
        await page.insertText('UI Lab: Increment');
        rec.check('conditional commands appear disabled in the real palette', await d.settleDom(page, `document.querySelector('[data-testid="palette-row"][aria-disabled="true"]')?.textContent.includes('UI Lab: Increment')`));
        await page.key('Enter');
        rec.check('confirming a disabled palette row keeps the palette open', await page.eval(`!!document.querySelector('[data-testid="command-palette"]')`) && (await snapshot()).state.context.count === disabledCount);
        await page.key('Escape');
        await toggle('visible', false);
        rec.check('when clauses remove contributions from the shell', await d.settleDom(page, `!document.querySelector('[data-plugin-item^="${id}."]')`));
        await toggle('visible', true); await toggle('enabled', true);
        await clickFrame('#refresh');
        await page.key('KeyU', { modifiers: 3, key: 'u', keyCode: 85 });
        rec.check('reenabled shortcuts cross the iframe and update live native badges', await countIs(disabledCount + 1));

        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`);
        await page.click('[data-testid="settings-tab-button-plugins"]');
        const step = `[id="plugin-setting-${id}-step"]`, density = `[id="plugin-setting-${id}-density"]`;
        rec.check('plugin settings render declared groups, enum choices and numeric input', await d.settleDom(page, `document.querySelector('[data-plugin-setting-group="${id}.appearance"]') && document.querySelector('[data-plugin-setting-group="${id}.behavior"]') && document.querySelector(${JSON.stringify(density)})?.tagName === 'SELECT' && document.querySelector(${JSON.stringify(step)})?.getAttribute('inputmode') === 'decimal'`));
        await page.eval(`document.querySelector(${JSON.stringify(step)}).scrollIntoView({block:'center'})`); await page.click(step); await selectAll(); await page.insertText('11');
        rec.check('out-of-range edits remain visible without corrupting daemon settings', await d.settleDom(page, `document.querySelector(${JSON.stringify(step)})?.getAttribute('aria-invalid') === 'true'`) && (await snapshot()).settings.step === 1);
        await selectAll(); await page.insertText('3');
        await page.eval(`(() => { const select = document.querySelector(${JSON.stringify(density)}); select.value = 'compact'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
        rec.check('valid settings writes persist through the daemon', await d.settle(async () => { const value = (await snapshot()).settings; return value.step === 3 && value.density === 'compact'; }));
        await inFrame(`void kelpi.ui.showInput({title:'Queued behind Settings'}).then(value => { document.body.dataset.queuedResult = JSON.stringify(value); }); true`);
        rec.check('plugin prompts wait behind the existing Settings overlay', await d.settleDom(page, `document.querySelector('[data-testid="plugin-ui-backdrop"]')?.hidden === true && !!document.querySelector('[data-testid="settings-close"]')`));
        await page.click('[data-testid="settings-close"]');
        rec.check('closing Settings reveals its queued plugin prompt', await d.settleDom(page, `document.querySelector('[data-testid="plugin-ui-backdrop"]')?.hidden === false && document.querySelector(${JSON.stringify(modal)})?.textContent.includes('Queued behind Settings')`));
        await page.key('Escape');
        rec.check('settings changes update the mounted plugin view', await frameCheck(`document.body.dataset.density === 'compact' && document.getElementById('state-summary').textContent.includes('Step 3')`));

        await clickFrame('#pick');
        rec.check('quick pick opens in the owning Kelpi window', await d.settleDom(page, `document.querySelector(${JSON.stringify(modal)})?.textContent.includes('UI Lab: choose a color')`));
        const panesBeforePrompt = (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length;
        await page.key('KeyD', { modifiers: 4, key: 'd', keyCode: 68 });
        await page.key('Comma', { modifiers: 4, key: ',' });
        rec.check('native split and Settings shortcuts leave the active prompt in control', (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length === panesBeforePrompt && !await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`) && await page.eval(`document.querySelector('input[aria-label="UI Lab: choose a color"]') === document.activeElement`));
        await page.insertText('green'); await page.key('Enter');
        rec.check('filtering and Enter return the selected quick-pick ID to its iframe', await output('pick', 'green'));
        await clickFrame('#input');
        await d.settleDom(page, `document.querySelector('input[aria-label="UI Lab: enter a label"]')`);
        await page.insertText('My plugin label'); await page.key('Enter');
        rec.check('input prompts return actual typed text', await output('input', 'My plugin label'));
        await clickFrame('#input'); await d.settleDom(page, `document.querySelector(${JSON.stringify(modal)})`);
        await page.key('KeyW', { modifiers: 4, key: 'w', keyCode: 87 });
        rec.check('the native Close shortcut cancels the prompt and preserves every pane', await output('input', null) && (await json(['pane', 'list', '--workspace', workspaceID, '--json'])).length === panesBeforePrompt);
        await clickFrame('#dialog');
        await d.settleDom(page, `document.querySelector(${JSON.stringify(modal)})?.textContent.includes('UI Lab: confirm action')`);
        await rec.shot(page, 'shared-dialog-and-native-contributions');
        await page.click(`${modal} > div:last-child button:last-child`);
        rec.check('dialog actions return their declared action ID', await output('dialog', 'confirm'));
        await clickFrame('#pick'); await d.settleDom(page, `document.querySelector(${JSON.stringify(modal)})`); await page.key('Escape');
        rec.check('Escape cancels a prompt without disabling the plugin', await output('pick', null) && await ready());
        await clickFrame('#notification');
        await d.settleDom(page, `document.querySelector('[data-testid="plugin-ui-notification"]')`);
        await page.click('[data-testid="plugin-ui-notification"] > div:last-child button:last-child');
        rec.check('notification actions settle in their requesting view', await output('notification', 'ack'));
        await clickFrame('#input'); await d.settleDom(page, `document.querySelector(${JSON.stringify(modal)})`);
        await cli.ok(['plugin', 'reload', id]);
        rec.check('plugin reload cancels its open prompt and restores a fresh working view', await d.settleDom(page, `!document.querySelector(${JSON.stringify(modal)})`) && await ready());
        rec.check('reload resets volatile state while retaining grouped settings', await countIs(0) && (await snapshot()).settings.step === 3 && await frameCheck(`document.body.dataset.density === 'compact'`));
        await page.click(counter);
        rec.check('restored contributions use the persisted counter step', await countIs(3));
        await cli.ok(['plugin', 'disable', id]);
        rec.check('disable removes all contribution controls', await d.settleDom(page, `!document.querySelector('[data-plugin-item^="${id}."]')`));
        await cli.ok(['plugin', 'enable', id]);
        rec.check('reenabling restores the pane and freshly initialized badges', await ready() && await countIs(0));
        await rec.shot(page, 'ui-lab-ready');
    } catch (error) { await rec.shot(page, 'failure-live'); throw error; }
    finally {
        await cli.run(['plugin', 'remove', id]);
        await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}
