/**
 * #283: Settings ▸ Repositories' Scan Directory and Add Repo open a folder selector in the desktop
 * app, as the shipped app's `NSOpenPanel` did, and the inspector's Add Repository ▸ Choose… fills
 * its path from the same panel.
 *
 * The native panel is an OS window CDP cannot click, so its ANSWER is scripted through the shell's
 * `KELPI_AUDIT_CHOOSE_FOLDER` seam (`driver.mjs` ▸ `scriptFolderAnswer`), exactly as the audit's
 * ⌘O step scripts `KELPI_AUDIT_OPEN_FILE`. Everything else is real: the page sends `shell-action`
 * `choose-folder-dialog` to the sandbox daemon, the daemon broadcasts it to this window's shell,
 * the shell answers with `choose-folder-answer`, the daemon hands `choose-folder-result` back to
 * this page alone, and the page registers or scans the folder with the ordinary `repo-add` /
 * `repo-scan` verbs. The repos are real `git init` checkouts under the sandbox root.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The source this drives, so `verify.mjs` re-runs it when any hop of the round trip moves. */
export const covers = [
    'packages/client/src/settings/RepositoriesTab.tsx',
    'packages/client/src/chrome/Inspector.tsx',
    'packages/client/src/app/folder-chooser.ts',
    'packages/client/src/App.tsx',
    'packages/daemon/src/ws/desktop.ts',
    'packages/daemon/src/ws/sync.ts',
    'packages/shell/src/status.ts',
    'packages/shell/src/shell-actions.ts',
    'packages/shell/src/main.ts'
];

const ROWS = `Array.from(document.querySelectorAll('[data-testid^="repo-row-"]'))`;

function gitInit(dir) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
}

export default async function ({ page, sandbox, shell, harness, rec, d, sleep }) {
    if (sandbox === undefined || sandbox === null || shell === null || shell === undefined) {
        rec.check('this scenario boots its own sandbox (the folder answer is scripted through the shell it launches)', false, 'run without --attach');
        return;
    }

    // ── fixtures: one repo to add, and a parent holding two repos (and one plain folder) to scan ─
    const root = fs.realpathSync(fs.mkdtempSync(path.join(sandbox.root, 'folder-selector-')));
    const solo = path.join(root, 'solo-repo');
    const scanRoot = path.join(root, 'projects');
    const alpha = path.join(scanRoot, 'alpha-repo');
    const beta = path.join(scanRoot, 'beta-repo');
    gitInit(solo);
    gitInit(alpha);
    gitInit(beta);
    fs.mkdirSync(path.join(scanRoot, 'notes'), { recursive: true });
    rec.note(`fixtures: ${solo}; ${scanRoot} holding alpha-repo, beta-repo and a plain notes/ folder`);

    const answerFile = d.chooseFolderAnswerPath(sandbox);
    const rowNames = async () =>
        JSON.parse(String(await page.eval(`JSON.stringify(${ROWS}.map(el => (el.innerText ?? '').split('\\n')[0].trim()))`)));
    const hasRow = (name) => `${ROWS}.some(el => (el.innerText ?? '').includes(${JSON.stringify(name)}))`;
    const notice = async () => String(await page.eval(`document.querySelector('[data-testid="repo-notice"]')?.innerText ?? ''`));
    const scriptedLines = () => shell.lines.filter((line) => String(line).includes('choose-folder dialog: scripted answer'));

    await d.openSettingsTab(page, 'repositories');
    const before = await rowNames();
    rec.note(`registry before: ${JSON.stringify(before)}`);

    // ── 1. the desktop app enables both buttons on an EMPTY field ─────────────────────────────
    const state = JSON.parse(
        String(
            await page.eval(`JSON.stringify({
                path: document.querySelector('[data-testid="repo-path"]')?.value ?? null,
                placeholder: document.querySelector('[data-testid="repo-path"]')?.placeholder ?? null,
                add: document.querySelector('[data-testid="repo-add"]')?.disabled ?? null,
                scan: document.querySelector('[data-testid="repo-scan"]')?.disabled ?? null,
                addTitle: document.querySelector('[data-testid="repo-add"]')?.title ?? null,
                chooseButton: document.querySelector('[data-testid="repo-browse"]') !== null
            })`)
        )
    );
    rec.check('the path field starts empty', state.path === '', JSON.stringify(state));
    rec.check('Add Repo and Scan Directory are ENABLED on the empty field, because a folder panel can fill it', state.add === false && state.scan === false, JSON.stringify(state));
    rec.check('the field and the buttons say an empty press chooses a folder', /choose a folder/i.test(state.placeholder ?? '') && /choose/i.test(state.addTitle ?? ''), JSON.stringify(state));
    rec.check('there is no separate Choose… button: the two buttons are the choosers', state.chooseButton === false);
    await rec.shot(page, 'empty-field-buttons-enabled');

    // ── 2. Add Repo, empty field → the panel → the chosen repo is registered ─────────────────
    d.scriptFolderAnswer(sandbox, solo);
    await page.click('[data-testid="repo-add"]');
    const added = await d.settleDom(page, hasRow('solo-repo'), { ceilingMs: 10_000 });
    rec.check('Add Repo with an empty field registers the folder the panel returned', added, JSON.stringify(await rowNames()));
    rec.check('the notice names the chosen path', (await notice()) === `Added ${solo}`, await notice());
    rec.check('the shell answered the panel from the scripted file, and consumed it', scriptedLines().some((line) => String(line).includes(solo)) && !fs.existsSync(answerFile), scriptedLines().join(' | '));
    rec.check('the chosen path did not go through the field, so the next press asks again', (await page.eval(`document.querySelector('[data-testid="repo-path"]')?.value`)) === '');
    await rec.shot(page, 'added-from-folder-panel');

    // ── 3. a cancel does nothing ─────────────────────────────────────────────────────────────
    const rowsBeforeCancel = await rowNames();
    const noticeBeforeCancel = await notice();
    const cancelsBefore = scriptedLines().filter((line) => String(line).includes('(cancelled)')).length;
    d.scriptFolderAnswer(sandbox, null);
    await page.click('[data-testid="repo-add"]');
    const cancelled = await d.settle(
        async () => scriptedLines().filter((line) => String(line).includes('(cancelled)')).length > cancelsBefore,
        { ceilingMs: 10_000 }
    );
    rec.check('the shell answered the second panel as a cancel', cancelled, scriptedLines().join(' | '));
    // The answer is null; give the page the same moment it took to act on a real one.
    await sleep(400);
    rec.check('a cancelled panel registers nothing', JSON.stringify(await rowNames()) === JSON.stringify(rowsBeforeCancel), JSON.stringify(await rowNames()));
    rec.check('and leaves the notice as it was', (await notice()) === noticeBeforeCancel, await notice());

    // ── 4. Scan Directory, empty field → the panel → every repo below the chosen folder ──────
    d.scriptFolderAnswer(sandbox, scanRoot);
    await page.click('[data-testid="repo-scan"]');
    rec.check('the notice says which folder is being scanned', await d.settle(async () => (await notice()) === `Scanning ${scanRoot}…`, { ceilingMs: 10_000 }), await notice());
    const scanned = await d.settleDom(page, `${hasRow('alpha-repo')} && ${hasRow('beta-repo')}`, { ceilingMs: 15_000 });
    const afterScan = await rowNames();
    rec.check('Scan Directory with an empty field registers both repos under the chosen folder', scanned, JSON.stringify(afterScan));
    rec.check('and not the plain folder beside them', !afterScan.includes('notes'), JSON.stringify(afterScan));
    await rec.shot(page, 'scanned-from-folder-panel');

    // ── 5. a typed path still wins, with no panel ────────────────────────────────────────────
    const panelsBeforeTyped = scriptedLines().length;
    await page.click('[data-testid="repo-path"]');
    await page.insertText(path.join(scanRoot, 'notes'));
    const typedEnabled = await page.eval(`document.querySelector('[data-testid="repo-add"]')?.disabled === false`);
    rec.check('with a typed path the buttons act on it', typedEnabled === true);
    await page.click('[data-testid="repo-add"]');
    rec.check('Add Repo on a typed path registers it', await d.settleDom(page, hasRow('notes'), { ceilingMs: 10_000 }), JSON.stringify(await rowNames()));
    rec.check('and raises no panel', scriptedLines().length === panelsBeforeTyped, scriptedLines().join(' | '));

    // ── cleanup: remove what this scenario registered, so the registry is handed on as found ─
    for (const name of ['solo-repo', 'alpha-repo', 'beta-repo', 'notes']) {
        const id = await page.eval(
            `(${ROWS}.find(el => (el.innerText ?? '').split('\\n')[0].trim() === ${JSON.stringify(name)})?.getAttribute('data-testid') ?? '').slice('repo-row-'.length)`
        );
        if (typeof id === 'string' && id !== '') {
            await page.click(`[data-testid="repo-remove-${id}"]`);
            await d.settleDom(page, `document.querySelector('[data-testid="repo-row-${id}"]') === null`, { ceilingMs: 5_000 });
        }
    }
    rec.check('the scenario leaves the registry as it found it', JSON.stringify(await rowNames()) === JSON.stringify(before), JSON.stringify(await rowNames()));
    await page.key('Escape');
    await d.settleDom(page, `document.querySelector('${d.PAGE.settingsPanel}') === null`, { ceilingMs: 3_000 });

    // ── 6. the inspector's Add Repository ▸ Choose… fills its path from the same panel ───────
    const inspectorWasOpen = (await page.eval(`document.querySelector('[data-testid="inspector"]') !== null`)) === true;
    if (!inspectorWasOpen) await harness.menuClick({ path: ['View', 'Toggle Inspector'] });
    const inspectorUp = await d.settleDom(page, `document.querySelector('[data-testid="inspector-add-repo"]')`, { ceilingMs: 5_000 });
    rec.check('the inspector is open with its Add menu', inspectorUp);
    if (inspectorUp) {
        let menuUp = false;
        for (let attempt = 0; attempt < 3 && !menuUp; attempt += 1) {
            // The inspector slides in; a press while its box is still moving can miss.
            await sleep(400);
            await page.click('[data-testid="inspector-add-repo"]');
            menuUp = await d.settleDom(page, `document.querySelector('[data-menu-item="add-repo"]')`, { ceilingMs: 2_000 });
        }
        rec.check('Add ▸ Add Repository… is offered', menuUp);
        if (menuUp) {
            await page.click('[data-menu-item="add-repo"]');
            const browse = await d.settleDom(page, `document.querySelector('[data-testid="add-repo-browse"]')`, { ceilingMs: 3_000 });
            rec.check('the sheet shows Choose… in the desktop app', browse);
            if (browse) {
                const associationsBefore = await page.eval(`document.querySelectorAll('[data-testid^="inspector-assoc-"]').length`);
                d.scriptFolderAnswer(sandbox, solo);
                await page.click('[data-testid="add-repo-browse"]');
                const filled = await d.settleDom(page, `document.querySelector('[data-testid="add-repo-path"]')?.value === ${JSON.stringify(solo)}`, { ceilingMs: 10_000 });
                rec.check('Choose… fills the sheet’s path with the folder the panel returned', filled, String(await page.eval(`document.querySelector('[data-testid="add-repo-path"]')?.value`)));
                // Give an (unwanted) association or registration the moment it would need to land.
                await sleep(600);
                rec.check('and adds nothing until Add is pressed: the sheet stays open', (await page.eval(`document.querySelector('[data-testid="add-repo-sheet"]') !== null`)) === true);
                rec.check(
                    'the workspace gained no association',
                    (await page.eval(`document.querySelectorAll('[data-testid^="inspector-assoc-"]').length`)) === associationsBefore
                );
                await rec.shot(page, 'inspector-choose-filled-path');
            }
            await page.click('[data-testid="add-repo-cancel"]');
            await d.settleDom(page, `document.querySelector('[data-testid="add-repo-sheet"]') === null`, { ceilingMs: 3_000 });
            // The registry itself is the proof that Choose… registered nothing.
            await d.openSettingsTab(page, 'repositories');
            rec.check('and the registry did not grow', JSON.stringify(await rowNames()) === JSON.stringify(before), JSON.stringify(await rowNames()));
            await page.key('Escape');
            await d.settleDom(page, `document.querySelector('${d.PAGE.settingsPanel}') === null`, { ceilingMs: 3_000 });
        }
    }
    if (!inspectorWasOpen) await harness.menuClick({ path: ['View', 'Toggle Inspector'] });
    // No answer left behind for a later scenario's panel.
    fs.rmSync(answerFile, { force: true });
}
