/** #237: trusted pointer input, two real daemons, and an independent WS mirror. */
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';

export const covers = [
    'packages/client/src/app/RemoteDaemonSections.tsx',
    'packages/client/src/app/RemoteDaemonSections.test.tsx'
];

// This is a second connected client, not a command spy. It retains only the two pieces of
// daemon state this scenario checks, advancing them from the real ordered delta stream.
async function observe(remote, token) {
    const ws = new WebSocket(`${remote.base.replace(/^http/, 'ws')}/ws?token=${token}`);
    const mirror = { top: [], groups: [], seq: null, error: null, ws };
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Remote observer snapshot timed out')), 10_000);
        ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Remote observer failed')); });
        ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION,
            token, client: { kind: 'browser', name: 'remote-reorder-observer' } })));
        ws.addEventListener('message', ({ data }) => {
            if (typeof data !== 'string') return;
            const message = JSON.parse(data);
            if (message.type === 'snapshot') {
                mirror.top = message.state.topLevelOrder;
                mirror.groups = message.state.groups;
                mirror.seq = message.seq;
                clearTimeout(timeout); resolve();
            } else if (message.type === 'delta') {
                if (message.seq !== mirror.seq + 1) mirror.error = 'Observer delta sequence gap';
                mirror.seq = message.seq;
                for (const event of message.events) {
                    if (event.kind === 'order-changed') mirror.top = event.topLevelOrder;
                    if (event.kind === 'group-upserted') {
                        mirror.groups = mirror.groups.filter(group => group.id !== event.id);
                        mirror.groups.push(event.group);
                    }
                    if (event.kind === 'group-removed') mirror.groups = mirror.groups.filter(group => group.id !== event.id);
                }
            }
        });
    });
    return mirror;
}

export default async function ({ page, cli, sandbox, rec, d, sleep, repoRoot, harness }) {
    if (!sandbox) throw new Error('This scenario requires private booted instances');
    const previousConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const remote = await makeSandbox(repoRoot, { label: 'reorder-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
    let daemon = startDaemon(remote, { repoRoot });
    let observer;
    const remoteCLI = makeCli(remote, { repoRoot });
    const json = async args => JSON.parse(await remoteCLI.ok(args));
    const host = '[data-testid="remote-daemon-ReorderRemote"]';
    const row = id => `${host} [data-testid="workspace-row"][data-workspace-id="${id}"]`;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const topIDs = () => observer.top.map(entry => entry.id);
    const children = group => observer.groups.find(entry => entry.id === group)?.childOrder;
    const domIDs = () => page.eval(`Array.from(document.querySelectorAll('${host} [data-testid="workspace-row"]'), el => el.dataset.workspaceId)`);
    const box = async id => {
        const b = await page.box(row(id));
        if (!b || b.height <= 0) throw new Error(`Remote row is not measurable: ${id}`);
        return b;
    };
    const drag = async (from, to, after = false) => {
        const a = await box(from), b = await box(to);
        await page.drag(a.cx, a.cy, b.cx, b.y + b.height * (after ? 0.75 : 0.25));
    };
    const begin = async (from, to) => {
        const a = await box(from), b = await box(to);
        await page.mouse('mouseMoved', a.cx, a.cy, { button: 'none', buttons: 0 });
        await page.mouse('mousePressed', a.cx, a.cy);
        await page.mouse('mouseMoved', b.cx, b.y + b.height / 4, { buttons: 1 });
        return { x: b.cx, y: b.y + b.height / 4 };
    };
    const release = p => page.mouse('mouseReleased', p.x, p.y, { buttons: 0 });
    try {
        await harness.focus();
        if (!await page.eval(`!!document.querySelector('[data-testid="sidebar"]')`)) await harness.menuClick({ path: ['View', 'Toggle Sidebar'] });
        await waitForHealthz(remote.base);
        const localBefore = await cli.ok(['workspace', 'list', '--json']);
        const first = (await json(['workspace', 'create', '--name', 'Reorder First', '--json'])).workspace_id;
        const memberA = (await json(['workspace', 'create', '--name', 'Reorder Member A', '--group', 'Reorder Group', '--json'])).workspace_id;
        const memberB = (await json(['workspace', 'create', '--name', 'Reorder Member B', '--group', 'Reorder Group', '--json'])).workspace_id;
        const tail = (await json(['workspace', 'create', '--name', 'Reorder Tail', '--json'])).workspace_id;
        const token = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        observer = await observe(remote, token);
        const group = observer.groups.find(entry => entry.name === 'Reorder Group').id;
        const originalTop = topIDs();
        fs.writeFileSync(sandbox.configPath, `${previousConfig}\nremote-daemon = ReorderRemote:${remote.base}/?token=${token}\n`);
        rec.check('the real remote mirror renders the seeded sibling lists', await d.settleDom(page,
            `document.querySelector(${JSON.stringify(row(tail))}) && document.querySelector('${host} [data-status="connected"]')`, { ceilingMs: 15_000 }));
        // Trust is read from events delivered by CDP; no DOM-dispatched drag events or mocked RPC.
        await page.eval(`(() => { window.__reorderTrusted = []; window.addEventListener('mousedown', e => window.__reorderTrusted.push(e.isTrusted)); })()`);
        await drag(first, tail, true);
        const movedTop = originalTop.filter(id => id !== first); movedTop.splice(movedTop.indexOf(tail) + 1, 0, first);
        const expectedRows = movedTop.flatMap(id => id === group ? [memberA, memberB] : [id]);
        rec.check('top-level move crosses a group slot and echoes to another connected client', await d.settle(() => same(topIDs(), movedTop)));
        rec.check('the initiating UI renders the daemon echo', await d.settle(async () => same(await domIDs(), expectedRows)));
        await drag(memberA, memberB, true);
        rec.check('group move is observed over the independent remote connection', await d.settle(() => same(children(group), [memberB, memberA])));
        const finalRows = movedTop.flatMap(id => id === group ? [memberB, memberA] : [id]);
        rec.check('group order also echoes into the initiating sidebar', await d.settle(async () => same(await domIDs(), finalRows)));
        const localAfter = await cli.ok(['workspace', 'list', '--json']);
        rec.check('remote gestures leave the local daemon workspace order intact', same(JSON.parse(localBefore), JSON.parse(localAfter)));

        let end = await begin(first, tail);
        await release({ x: end.x + 700, y: end.y });
        await sleep(350);
        rec.check('release outside the remote host cancels', same(topIDs(), movedTop));
        end = await begin(first, tail);
        const localRow = await page.box('[data-testid="workspace-row"]');
        await release({ x: localRow.cx, y: localRow.y + localRow.height / 4 });
        await sleep(350);
        rec.check('release on the local host cannot reorder the remote', same(topIDs(), movedTop));
        end = await begin(first, tail);
        const groupRow = await box(memberB);
        await release({ x: groupRow.cx, y: groupRow.cy });
        await sleep(350);
        rec.check('release on a different container cannot reorder or reparent', same(topIDs(), movedTop) && same(children(group), [memberB, memberA]));
        end = await begin(first, tail);
        await page.key('Escape'); await release(end); await sleep(350);
        rec.check('Escape cancels a trusted pointer gesture', same(topIDs(), movedTop));

        // Another client changes membership while the pointer remains down.
        end = await begin(memberA, memberB);
        await remoteCLI.ok(['workspace', 'move', memberA, '--top-level']);
        rec.check('concurrent external move reaches the sidebar before release', await d.settle(async () => same(children(group), [memberB]) && (await domIDs()).at(-1) === memberA));
        await release(end); await sleep(350);
        rec.check('stale drag does not move the workspace back into its old group', same(children(group), [memberB]) && topIDs().includes(memberA));
        // Restore via the other client so persisted expectations include both successful drags.
        await remoteCLI.ok(['workspace', 'move', memberA, '--group', group, '--index', '1']);
        if (!await d.settle(() => same(topIDs(), movedTop) && same(children(group), [memberB, memberA]))) throw new Error('External restore did not echo');
        rec.check('all recorded pointer presses were trusted', await page.eval('window.__reorderTrusted.length >= 7 && window.__reorderTrusted.every(Boolean)'));
        rec.check('independent client applied an uninterrupted delta stream', observer.error === null, observer.error ?? '');
        observer.ws.close();
        await daemon.stop(); daemon = startDaemon(remote, { repoRoot }); await waitForHealthz(remote.base);
        observer = await observe(remote, token);
        rec.check('a fresh snapshot after daemon restart retains both orders', same(topIDs(), movedTop) && same(children(group), [memberB, memberA]));
        rec.check('the initiating client reconnects and renders persisted order', await d.settle(async () => same(await domIDs(), finalRows), { ceilingMs: 15_000 }));
        await page.send('Page.reload');
        rec.check('a client reload renders the same persisted remote order', await d.settle(async () => same(await domIDs(), finalRows), { ceilingMs: 15_000 }));
    } finally {
        observer?.ws.close();
        fs.writeFileSync(sandbox.configPath, previousConfig);
        await d.settleDom(page, `!document.querySelector('${host}')`, { ceilingMs: 10_000 });
        await daemon.stop(); remote.cleanup();
    }
}
