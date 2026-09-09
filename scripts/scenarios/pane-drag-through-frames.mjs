import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const covers = ['packages/client/src/grid/PaneGrid.tsx', 'packages/client/src/grid/PaneHeader.tsx'];

export default async function ({ page, cli, sandbox, rec, d, repoRoot }) {
    await page.watchFrames();
    const repo = path.join(sandbox.root, 'frame-drag-repo');
    fs.mkdirSync(repo);
    const git = args => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--initial-branch=main']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Frame drag target\n');
    git(['add', 'README.md']);
    git(['-c', 'user.name=Kelpi Scenario', '-c', 'user.email=scenario@localhost', 'commit', '-m', 'Private fixture']);
    fs.appendFileSync(path.join(repo, 'README.md'), '\nA visible diff.\n');
    const json = async args => JSON.parse(await cli.ok(args));
    const zone = () => page.eval(`document.querySelector('[data-testid="drop-zone-overlay"]')?.getAttribute('data-zone') ?? null`);
    let workspaceID;
    try {
        await cli.ok(['plugin', 'install', path.join(repoRoot, 'examples/plugins/agent-board'), '--trust']);
        for (const kind of ['plugin', 'markdown', 'diff']) {
            workspaceID = (await json(['workspace', 'create', '--name', `Frame drag ${kind}`, '--path', repo, '--json'])).workspace_id;
            const panes = () => json(['pane', 'list', '--workspace', workspaceID, '--json']);
            const source = (await panes())[0].id;
            const command = kind === 'plugin' ? ['plugin', 'run', 'example.agent-board.open']
                : kind === 'markdown' ? ['open', path.join(repo, 'README.md')] : ['diff'];
            await cli.ok(command, { cwd: repo, paneID: source });
            let destination;
            await d.settle(async () => { destination = (await panes()).find(pane => pane.type === kind); return !!destination; });
            if (!destination) throw new Error(`${kind} target did not open`);
            const targetSelector = `[data-testid="pane-${destination.id}"]`;
            const sourceSelector = `[data-testid="pane-${source}"]`;
            const headerSelector = `[data-testid="pane-header-${source}"]`;
            const frame = `${targetSelector} iframe`;
            const frameAcceptsPointer = () => page.eval(`(() => {
                const frame = document.querySelector(${JSON.stringify(frame)});
                if (!frame) return false;
                const box = frame.getBoundingClientRect();
                return getComputedStyle(frame).pointerEvents !== 'none' &&
                    document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === frame;
            })()`);
            const ready = await d.settle(async () => {
                try { return await page.evalInFrame(frame, 'document.body.innerText.trim().length > 0'); }
                catch { return false; }
            });
            rec.check(`${kind} target has a live iframe`, ready);
            if (!ready) throw new Error(`${kind} target iframe did not render`);
            for (const edge of ['top', 'bottom']) {
                await cli.ok(['layout', 'select', 'even-horizontal'], { paneID: source });
                const aligned = await d.settle(async () => {
                    const a = await page.box(sourceSelector), b = await page.box(targetSelector);
                    return !!a && !!b && Math.abs(a.x - b.x) > 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.height - b.height) < 2;
                });
                if (!aligned) throw new Error(`${kind} panes did not return to a horizontal layout`);
                const from = await page.box(headerSelector);
                const target = await page.box(targetSelector);
                if (!from || !target) throw new Error('pane geometry missing');
                await page.mouse('mouseMoved', from.cx, from.cy, { button: 'none', buttons: 0 });
                await page.mouse('mousePressed', from.cx, from.cy);
                await page.mouse('mouseMoved', from.cx + 25, from.cy + 4, { buttons: 1 });
                // Enter through the parent-owned header, then cross the iframe surface.
                // Electron can retain valid capture while still sending these moves to the
                // child; excluding the frame from hit-testing keeps the target live.
                await page.mouse('mouseMoved', target.x + 5, target.y + 16, { buttons: 1 });
                rec.check(`${kind} ${edge} drag begins with a left-edge target`, await d.settle(async () => await zone() === 'left', { ceilingMs: 1000 }));
                const dropY = target.y + target.height * (edge === 'top' ? 0.22 : 0.8);
                await page.mouse('mouseMoved', target.cx, dropY, { buttons: 1 });
                rec.check(`${kind} drag updates to ${edge} while inside the iframe`, await d.settle(async () => await zone() === edge, { ceilingMs: 1000 }), `zone=${await zone()}`);
                await page.mouse('mouseReleased', target.cx, dropY);
                rec.check(`${kind} ${edge} release ends the drag and restores iframe hit-testing`, await d.settle(async () => await zone() === null && await frameAcceptsPointer(), { ceilingMs: 1000 }));
                rec.check(`${kind} release places the source ${edge === 'top' ? 'above' : 'below'} the target`, await d.settle(async () => {
                    const a = await page.box(sourceSelector), b = await page.box(targetSelector);
                    if (!a || !b || Math.abs(a.x - b.x) >= 2 || Math.abs(a.width - b.width) >= 2) return false;
                    return edge === 'top' ? b.y >= a.y + a.height - 2 : a.y >= b.y + b.height - 2;
                }, { ceilingMs: 1000 }));
                // Restore a failed pre-fix gesture too, so every edge and frame is measured.
                await page.eval(`window.dispatchEvent(new Event('pointercancel'))`);
            }

            const from = await page.box(headerSelector);
            const target = await page.box(targetSelector);
            if (!from || !target) throw new Error('pane geometry missing');
            for (const finish of ['cancellation', 'header click']) {
                const before = await Promise.all([page.box(sourceSelector), page.box(targetSelector)]);
                await page.mouse('mouseMoved', from.cx, from.cy, { button: 'none', buttons: 0 });
                await page.mouse('mousePressed', from.cx, from.cy);
                const suppressed = await d.settle(async () => !await frameAcceptsPointer());
                if (finish === 'cancellation') {
                    try {
                        await page.mouse('mouseMoved', target.cx, target.y + 16, { buttons: 1 });
                        const active = await d.settle(async () => await zone() !== null);
                        await page.eval(`window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }))`);
                        // Assert cancellation before mouseup can perform its own cleanup.
                        const cancelled = await d.settle(async () => {
                            if (await zone() !== null || !await frameAcceptsPointer()) return false;
                            const after = await Promise.all([page.box(sourceSelector), page.box(targetSelector)]);
                            return before.every((box, index) => box && after[index] &&
                                ['x', 'y', 'width', 'height'].every(key => Math.abs(box[key] - after[index][key]) < 1));
                        }, { ceilingMs: 1000 });
                        rec.check(`${kind} cancellation clears the overlay, restores iframe hit-testing and keeps the layout`, suppressed && active && cancelled);
                    } finally {
                        await page.mouse('mouseReleased', from.cx, from.cy);
                    }
                } else {
                    await page.mouse('mouseReleased', from.cx, from.cy);
                    rec.check(`${kind} ${finish} restores iframe hit-testing`, suppressed && await d.settle(async () => await zone() === null && await frameAcceptsPointer(), { ceilingMs: 1000 }));
                }
            }
            await cli.ok(['workspace', 'delete', workspaceID, '--force']);
            workspaceID = undefined;
        }
    } finally {
        await page.eval(`window.dispatchEvent(new Event('pointercancel'))`);
        if (workspaceID) await cli.run(['workspace', 'delete', workspaceID, '--force']);
        await cli.run(['plugin', 'remove', 'example.agent-board']);
    }
}
