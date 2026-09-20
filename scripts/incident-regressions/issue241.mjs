import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Immutable, real assembled regression for issue #241.
 *
 * The same bytes run against the exact original and candidate commits. Every workspace is
 * created inside the driver's disposable private daemon/app sandbox. The fixture uses the
 * production CLI for workspace/pane/lifecycle mutations, trusted CDP input for Sidebar and
 * Command-W, and confirms actual deletion through the production workspace list.
 */

function removeRendererObservers(undo) {
    const failures = [];
    for (const remove of undo) {
        try { remove(); }
        catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Failed to remove every renderer observer');
}

async function observeRenderer(page) {
    let total = 0;
    const samples = [];
    const record = (kind, detail) => {
        total += 1;
        if (samples.length < 50) samples.push({ kind, detail: String(detail).slice(0, 2000) });
    };
    const undo = [];
    try {
        undo.push(page.on('Runtime.exceptionThrown', (params) =>
            record('uncaught', params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '?')));
        undo.push(page.on('Runtime.consoleAPICalled', (params) => {
            if (params.type === 'error') {
                record('console.error', (params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' '));
            }
        }));
        await page.send('Runtime.enable');
    } catch (error) {
        try { removeRendererObservers(undo); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Renderer observer setup and teardown failed'); }
        throw error;
    }
    return {
        finish(recorder) {
            let primaryError;
            try {
                recorder.check('the renderer threw nothing and logged no error', total === 0,
                    JSON.stringify({ total, samples, scope: 'post-boot' }));
            }
            catch (error) { primaryError = error; }
            try { removeRendererObservers(undo); }
            catch (cleanupError) {
                if (primaryError) throw new AggregateError([primaryError, cleanupError], 'Renderer evidence and observer teardown failed');
                throw cleanupError;
            }
            if (primaryError) throw primaryError;
        }
    };
}

const root = fs.realpathSync(process.env.KELPI_REGRESSION_ROOT);
const reportPath = path.resolve(process.env.KELPI_REGRESSION_REPORT);
const out = `${reportPath}.artifacts`;
fs.mkdirSync(out, { recursive: false });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const assertions = [];
const errors = [];
const artifacts = [];
const calls = [];
const stateReceipts = [];
const cleanup = { attempted: false, completed: false, errors: [], leaks: [] };
const result = {
    schemaVersion: 1,
    assertions,
    errors,
    cleanup,
    environment: {
        id: 'local-macos-private-workspace-deletion',
        kind: 'local',
        details: 'Real disposable private daemon and Electron application; production CLI lifecycle events, trusted CDP pointer input, and CDP Command-W. No user workspace or installed app state is touched. Does not certify physical keyboard input or a remote/device environment.',
        evidence: { facts: artifacts }
    },
    head: git('rev-parse', 'HEAD'),
    startedAt: new Date().toISOString()
};

const retain = (name, value, role = 'diagnostic') => {
    const file = path.join(out, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    artifacts.push({ role, path: file, sha256: sha(fs.readFileSync(file)) });
};
const check = (name, ok, detail) => assertions.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
// cleanup-plan:start
async function runCleanupPlan(steps, recordFailure) {
    for (const [label, action] of steps) {
        try { await action(); }
        catch (error) { recordFailure(label, error); }
    }
}
function buildPrimaryCleanupPlan({ rendererWatch, runtime, retain, check, daemonPid, shellPid, exists, fs, cleanup, finalRetains = [] }) {
    const observe = (name, pid) => {
        if (!pid) throw new Error(`${name} process id is unavailable`);
        if (exists(pid)) cleanup.leaks.push({ name, pid });
    };
    return [
        ...(rendererWatch ? [['finalize renderer evidence', () => rendererWatch.finish({check(name,ok,detail){check(`renderer: ${name}`,ok,detail);}})]] : []),
        ...(runtime ? [
            ['retain primary daemon output', () => retain('daemon-output.json', { text: runtime.daemon?.text(), shell: runtime.shell?.text(), daemonPid, shellPid }, 'runtime')],
            ['stop primary runtime', async () => {
                // Historical target drivers can attempt file cleanup after a failed
                // stop. Guard that actual deletion boundary inside their lifecycle.
                const removeSandbox = runtime.sandbox.cleanup;
                const pids = [['daemon', daemonPid], ['shell', shellPid]];
                if (runtime.daemon?.pid && runtime.daemon.pid !== daemonPid) pids.push(['current daemon', runtime.daemon.pid]);
                runtime.sandbox.cleanup = () => {
                    for (const [name, pid] of pids) {
                        if (!pid || exists(pid)) throw new Error(`preserving primary sandbox: ${name} exit is unverified`);
                    }
                    return removeSandbox.call(runtime.sandbox);
                };
                try { await runtime.stop(); }
                finally { runtime.sandbox.cleanup = removeSandbox; }
            }],
            ['check primary daemon process', () => observe('daemon', daemonPid)],
            ['check primary shell process', () => observe('shell', shellPid)],
            ['check primary sandbox removal', () => {if (fs.existsSync(runtime.sandbox.root)) cleanup.leaks.push({ path: runtime.sandbox.root });}],
        ] : []),
        ...finalRetains,
    ];
}
// cleanup-plan:end
const recordCleanupFailure = (label, error) => cleanup.errors.push(`${label}: ${String(error?.stack ?? error)}`);
const exists = (pid) => {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
    }
};

let t;
let daemonPid;
let shellPid;
let rendererWatch;
let bootAttempted = false;

try {
    const d = await import(pathToFileURL(path.join(root, 'scripts/ui-audit/lib/driver.mjs')));
    const stack = await import(pathToFileURL(path.join(root, 'scripts/ui-audit/lib/stack.mjs')));
    await stack.buildAll(root, { force: true, log: (line) => console.log(line) });

    const collectBuildFiles = () => ['daemon', 'cli', 'client', 'shell'].flatMap((pkg) => {
        const base = path.join(root, 'packages', pkg, 'dist');
        return fs.readdirSync(base, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
    }).sort();
    const buildFiles = collectBuildFiles();
    const build = buildFiles.map((file) => ({ path: file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
    const sourceFiles = git('ls-files', '-z').split('\0').filter(Boolean);
    const source = sourceFiles
        .filter((file) => fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile())
        .map((file) => ({ path: file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
    retain('source-and-build.json', { head: result.head, source, build, forced: true }, 'build');

    bootAttempted = true;
    t = await d.boot({
        repoRoot: root,
        label: 'incident241-expanded',
        build: false,
        window: 'onscreen',
        log: (line) => console.log(line)
    });
    daemonPid = t.daemon?.pid;
    shellPid = t.shell?.child?.pid;
    rendererWatch = await observeRenderer(t.page);
    retain('native-runtime-identity.json', {
        shell: await t.harness.ping(),
        window: await t.harness.window(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        rendererWatchScope: 'after-boot; first-document startup belongs to the separate issue239 fixture'
    }, 'environment');

    const run = async (args, options) => {
        const answer = await t.cli.run(args, options);
        calls.push({ at: new Date().toISOString(), args, options: options?.env === undefined ? undefined : { env: options.env }, answer });
        return answer;
    };
    const json = async (args, options) => {
        const answer = await run(args, options);
        if (answer.code !== 0) throw new Error(`fixture command failed ${args.join(' ')}: ${answer.stderr || answer.stdout}`);
        return JSON.parse(answer.stdout);
    };
    const workspaces = () => json(['workspace', 'list', '--json']);
    const workspaceExists = async (id) => (await workspaces()).some((workspace) => workspace.id === id);
    const panes = (id) => json(['pane', 'list', '--workspace', id, '--json']);
    const workspaceGone = async (id) => await d.settle(async () => !(await workspaceExists(id)), { ceilingMs: 5000 });
    const shot = async (name) => {
        const file = path.join(out, `${name}.png`);
        await t.page.screenshot(file);
        artifacts.push({ role: 'visual', path: file, sha256: sha(fs.readFileSync(file)) });
    };

    const lifecycle = async (paneID, status, session) => {
        const env = { KELPI_PANE_ID: paneID };
        const bound = await run(['event', 'session-start', '--agent', 'codex'], {
            env,
            stdin: JSON.stringify({ session_id: session })
        });
        if (bound.code !== 0) throw new Error(`session binding failed for ${paneID}: ${bound.stderr}`);
        if (status === 'running' || status === 'waitingForInput') {
            const started = await run(['event', 'start', '--agent', 'codex'], { env });
            if (started.code !== 0) throw new Error(`agent start failed for ${paneID}: ${started.stderr}`);
        }
        if (status === 'waitingForInput') {
            const stopped = await run(['event', 'stop', '--agent', 'codex'], { env, stdin: '{}' });
            if (stopped.code !== 0) throw new Error(`agent stop failed for ${paneID}: ${stopped.stderr}`);
        }
    };

    const createWorkspace = async (name, paneCount = 1) => {
        const created = await json(['workspace', 'create', '--name', name, '--json']);
        const id = created.workspace_id;
        if (!id) throw new Error(`workspace create returned no id for ${name}`);
        for (let index = 1; index < paneCount; index += 1) {
            await json(['pane', 'create', '--workspace', id, '--json']);
        }
        const visible = await panes(id);
        if (visible.length !== paneCount) throw new Error(`${name} expected ${paneCount} panes, saw ${visible.length}`);
        return { id, name, paneIDs: visible.map((pane) => pane.id) };
    };

    const parkAsMarkdown = async (fixture, sourcePaneID, label) => {
        const before = await panes(fixture.id);
        const opened = await run(['md', '--here', path.join(root, 'README.md')], { env: { KELPI_PANE_ID: sourcePaneID } });
        if (opened.code !== 0) throw new Error(`markdown replacement failed for ${sourcePaneID}: ${opened.stderr}`);
        let after = [];
        const replaced = await d.settle(async () => {
            after = await panes(fixture.id);
            return !after.some((pane) => pane.id === sourcePaneID) && after.length === before.length;
        }, { ceilingMs: 5000 });
        const replacement = after.find((pane) => !before.some((old) => old.id === pane.id));
        const receipt = { label, workspaceID: fixture.id, sourcePaneID, before, after, replacement };
        stateReceipts.push(receipt);
        check(`${label}: source agent pane is parked behind a real markdown replacement`,
            replaced && replacement?.type === 'markdown', receipt);
        return replacement?.id;
    };

    const makeMixed = async (route) => {
        const fixture = await createWorkspace(`incident241-${route}`, 4);
        const [running, waiting, inactiveVisible, inactiveParked] = fixture.paneIDs;
        await lifecycle(running, 'running', `${route}-running-session`);
        await lifecycle(waiting, 'waitingForInput', `${route}-waiting-session`);
        await lifecycle(inactiveVisible, 'idle', `${route}-inactive-visible-session`);
        await lifecycle(inactiveParked, 'idle', `${route}-inactive-parked-session`);
        const ready = await d.settle(async () => {
            const now = await panes(fixture.id);
            return now.some((pane) => pane.id === running && pane.status === 'running' && pane.agent_session_id === `${route}-running-session`) &&
                now.some((pane) => pane.id === waiting && pane.status === 'waitingForInput' && pane.agent_session_id === `${route}-waiting-session`) &&
                now.some((pane) => pane.id === inactiveVisible && pane.status === 'idle' && pane.agent_session_id === `${route}-inactive-visible-session`) &&
                now.some((pane) => pane.id === inactiveParked && pane.status === 'idle' && pane.agent_session_id === `${route}-inactive-parked-session`);
        }, { ceilingMs: 5000 });
        check(`${route}: real running, waiting and two inactive bound sessions established`, ready, await panes(fixture.id));
        fixture.markdownPaneID = await parkAsMarkdown(fixture, inactiveParked, `${route}: inactive bound session`);
        fixture.roles = { running, waiting, inactiveVisible, inactiveParked };
        return fixture;
    };

    const sentinel = await createWorkspace('incident241-sentinel');
    const mixedWarning = 'This workspace has 1 running agent, 1 agent waiting for input and 2 inactive agents. Deleting it will close all 4.';

    // CLI: exact three-way breakdown, parked-inclusive predicate, preservation, and force.
    const cli = await makeMixed('cli');
    const refusal = await run(['workspace', 'delete', cli.id, '--json']);
    let refusalData = null;
    try {
        refusalData = JSON.parse(refusal.stdout)[0];
    } catch {
        // The assertion below retains stdout/stderr; malformed output is a product failure, not a crash.
    }
    check('cli: unconfirmed delete refuses exact mixed visible and parked breakdown',
        refusal.code === 1 &&
        refusalData?.active_agents === 4 &&
        refusalData?.running === 1 &&
        refusalData?.waiting === 1 &&
        refusalData?.inactive === 2 &&
        refusalData?.error === `workspace ${cli.name} has 1 running agent, 1 agent waiting for input and 2 inactive agents; pass --force to delete anyway`,
        { refusal, refusalData });
    check('cli: refused mixed delete preserves the workspace', await workspaceExists(cli.id));
    const forced = await run(['workspace', 'delete', cli.id, '--force', '--json']);
    check('cli: explicit force performs actual deletion while preserving the sentinel',
        forced.code === 0 && await workspaceGone(cli.id) && await workspaceExists(sentinel.id), forced);

    // Sidebar: exact warning and an actual confirmed deletion of all visible and parked panes.
    const sidebar = await makeMixed('sidebar');
    if (!await d.settleDom(t.page, `document.querySelector('[data-testid="workspace-row"]')?.textContent !== undefined`, { ceilingMs: 5000 })) {
        throw new Error('sidebar never rendered');
    }
    await d.openSidebarMenu(t.page, d.PAGE.workspaceRows, sidebar.name);
    await d.clickMenuItem(t.page, 'Delete');
    const sidebarText = await t.page.eval(`document.querySelector('[data-testid="confirm-active-agents"]')?.textContent ?? ''`);
    const sidebarExact = sidebarText === mixedWarning;
    check('sidebar: exact mixed visible and parked breakdown appears before deletion', sidebarExact,
        { expected: mixedWarning, actual: sidebarText });
    check('sidebar: mixed workspace is preserved until explicit confirmation', await workspaceExists(sidebar.id));
    await shot('sidebar-mixed-confirmation');
    await d.clickDialogButton(t.page, 'Delete');
    check('sidebar: confirmation performs actual mixed workspace deletion', await workspaceGone(sidebar.id));

    // Last-pane Command-W: one visible markdown pane backed by one parked inactive session.
    const keyboard = await createWorkspace('incident241-keyboard');
    const parkedShell = keyboard.paneIDs[0];
    await lifecycle(parkedShell, 'idle', 'keyboard-inactive-parked-session');
    const boundBeforePark = await d.settle(async () => {
        const now = await panes(keyboard.id);
        return now.some((pane) => pane.id === parkedShell && pane.status === 'idle' && pane.agent_session_id === 'keyboard-inactive-parked-session');
    }, { ceilingMs: 5000 });
    check('keyboard: real inactive bound session established before parking', boundBeforePark);
    const onlyVisible = await parkAsMarkdown(keyboard, parkedShell, 'keyboard: inactive bound session');
    if (!onlyVisible) throw new Error('keyboard fixture produced no visible replacement');
    if (!await d.settleDom(t.page, `document.querySelector('[data-testid="pane-header-${onlyVisible}"]')`, { ceilingMs: 5000 })) {
        throw new Error('keyboard replacement pane never rendered');
    }
    await d.clickPaneHeader(t.page, onlyVisible);
    await t.page.key('KeyW', { key: 'w', modifiers: d.MOD.meta });
    const keyboardExpected = 'This workspace has 1 inactive agent. Deleting it will close it.';
    const keyboardGate = await d.settleDom(t.page,
        `document.querySelector('[data-testid="agent-delete-gate"]')?.textContent.includes(${JSON.stringify(keyboardExpected)})`,
        { ceilingMs: 2000 });
    check('keyboard: last-pane Command-W warns for a parked inactive session before deletion',
        keyboardGate && await workspaceExists(keyboard.id), { expected: keyboardExpected });
    await shot('keyboard-parked-confirmation');
    if (keyboardGate) await t.page.click('[data-testid="agent-delete-confirm"]');
    check('keyboard: confirmed gate performs actual last-pane workspace deletion', keyboardGate && await workspaceGone(keyboard.id),
        { gateObserved: keyboardGate });

    // Inactive-only controls exercise the incident predicate without any active agent.
    const makeInactiveOnly = async route => {
        const fixture = await createWorkspace(`incident241-${route}`, 2);
        for (const [index, paneID] of fixture.paneIDs.entries()) {
            await lifecycle(paneID, 'idle', `${route}-inactive-${index}`);
        }
        const bound = await d.settle(async () => {
            const now = await panes(fixture.id);
            return fixture.paneIDs.every((paneID, index) => now.some(pane =>
                pane.id === paneID && pane.status === 'idle' && pane.agent_session_id === `${route}-inactive-${index}`));
        }, { ceilingMs: 5000 });
        check(`${route}: exactly two inactive bound sessions and no active agents established`, bound, await panes(fixture.id));
        await parkAsMarkdown(fixture, fixture.paneIDs[1], `${route}: inactive bound session`);
        return fixture;
    };
    const inactiveCLI = await makeInactiveOnly('inactive-cli');
    const inactiveRefusal = await run(['workspace', 'delete', inactiveCLI.id, '--json']);
    let inactiveData;
    try { inactiveData = JSON.parse(inactiveRefusal.stdout)[0]; } catch { /* asserted below */ }
    check('inactive-only CLI: unforced deletion refuses visible and parked inactive sessions',
        inactiveRefusal.code === 1 && inactiveData?.running === 0 && inactiveData?.waiting === 0 &&
        inactiveData?.inactive === 2 && inactiveData?.active_agents === 2 && await workspaceExists(inactiveCLI.id),
        { answer: inactiveRefusal, data: inactiveData });
    const inactiveForce = await run(['workspace', 'delete', inactiveCLI.id, '--force', '--json']);
    check('inactive-only CLI: force deletes the preserved inactive workspace',
        inactiveForce.code === 0 && await workspaceGone(inactiveCLI.id), inactiveForce);

    const inactiveSidebar = await makeInactiveOnly('inactive-sidebar');
    const inactiveWarning = 'This workspace has 2 inactive agents. Deleting it will close all 2.';
    await d.openSidebarMenu(t.page, d.PAGE.workspaceRows, inactiveSidebar.name);
    await d.clickMenuItem(t.page, 'Delete');
    const inactiveText = await t.page.eval(`document.querySelector('[data-testid="confirm-active-agents"]')?.textContent ?? ''`);
    const inactiveGate = inactiveText === inactiveWarning;
    check('inactive-only Sidebar: warning counts visible and parked sessions before deletion',
        inactiveGate && await workspaceExists(inactiveSidebar.id), { expected: inactiveWarning, actual: inactiveText });
    await shot('sidebar-inactive-only-confirmation');
    await d.clickDialogButton(t.page, 'Cancel');
    check('inactive-only Sidebar: cancel preserves the workspace and closes the confirmation',
        await workspaceExists(inactiveSidebar.id) && await d.settleDom(t.page,
            `!document.querySelector('[data-testid="confirm-dialog"]')`, { ceilingMs: 3000 }));
    await d.openSidebarMenu(t.page, d.PAGE.workspaceRows, inactiveSidebar.name);
    await d.clickMenuItem(t.page, 'Delete');
    const warningRepeated = await t.page.eval(`document.querySelector('[data-testid="confirm-active-agents"]')?.textContent === ${JSON.stringify(inactiveWarning)}`);
    await d.clickDialogButton(t.page, 'Delete');
    check('inactive-only Sidebar: explicit warning confirmation performs actual deletion',
        inactiveGate && warningRepeated && await workspaceGone(inactiveSidebar.id));

    // No-agent controls: preserve all three historical route behaviors.
    const cliEmpty = await createWorkspace('incident241-no-agent-cli');
    const cliEmptyDelete = await run(['workspace', 'delete', cliEmpty.id, '--json']);
    check('no-agent CLI: unforced delete remains immediate success',
        cliEmptyDelete.code === 0 && await workspaceGone(cliEmpty.id), cliEmptyDelete);

    const sidebarEmpty = await createWorkspace('incident241-no-agent-sidebar');
    await d.openSidebarMenu(t.page, d.PAGE.workspaceRows, sidebarEmpty.name);
    await d.clickMenuItem(t.page, 'Delete');
    const plainDialog = await t.page.eval(`(() => {
        const dialog = document.querySelector('[data-testid="confirm-dialog"]');
        return dialog === null ? null : {
            active: dialog.getAttribute('data-active-agents'),
            warning: dialog.querySelector('[data-testid="confirm-active-agents"]')?.textContent ?? null,
            suppress: dialog.querySelector('[data-testid="confirm-suppress"]') !== null
        };
    })()`);
    check('no-agent Sidebar: plain confirmation is preserved',
        plainDialog?.active === '0' && plainDialog.warning === null && plainDialog.suppress === false, plainDialog);
    await d.clickDialogButton(t.page, 'Delete');
    check('no-agent Sidebar: plain confirmation still performs actual deletion', await workspaceGone(sidebarEmpty.id));

    const keyboardEmpty = await createWorkspace('incident241-no-agent-keyboard');
    const emptyPane = keyboardEmpty.paneIDs[0];
    if (!await d.settleDom(t.page, `document.querySelector('[data-testid="pane-header-${emptyPane}"]')`, { ceilingMs: 5000 })) {
        throw new Error('no-agent keyboard pane never rendered');
    }
    await d.clickPaneHeader(t.page, emptyPane);
    await t.page.key('KeyW', { key: 'w', modifiers: d.MOD.meta });
    const silent = await workspaceGone(keyboardEmpty.id);
    const anyDeleteDialog = await t.page.eval(`document.querySelector('[data-testid="agent-delete-gate"], [data-testid="confirm-dialog"]') !== null`);
    check('no-agent Command-W: silent actual deletion is preserved', silent && anyDeleteDialog === false,
        { silent, anyDeleteDialog });

    check('control: sentinel workspace survives every deletion route', await workspaceExists(sentinel.id));

    if (JSON.stringify(collectBuildFiles()) !== JSON.stringify(buildFiles)) {
        throw new Error('build output membership changed during incident test');
    }
    const after = buildFiles.map((file) => ({ path: file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
    if (JSON.stringify(after) !== JSON.stringify(build)) {
        throw new Error('executed build outputs changed during the incident test');
    }
} catch (error) {
    errors.push(String(error?.stack ?? error));
} finally {
    cleanup.attempted = true;
    await runCleanupPlan(buildPrimaryCleanupPlan({
        rendererWatch, runtime: t, retain, check, daemonPid, shellPid, exists, fs, cleanup,
        finalRetains: [
            ['retain CLI calls', () => retain('cli-calls.json', calls)],
            ['retain state receipts', () => retain('state-receipts.json', stateReceipts)],
        ],
    }), recordCleanupFailure);
    if (bootAttempted && !t) {
        cleanup.errors.push('boot rejected before returning owned runtime handles; process and sandbox cleanup is unverified and requires external inspection');
    }
    cleanup.completed = cleanup.errors.length === 0 && cleanup.leaks.length === 0;
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
}

process.exitCode = errors.length || !cleanup.completed
    ? 2
    : assertions.some((assertion) => !assertion.ok)
      ? 1
      : 0;
