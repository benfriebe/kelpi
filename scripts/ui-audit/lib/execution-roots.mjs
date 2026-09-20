/** A harness checkout may drive another exact product checkout; neither is an overlay. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { captureSource } from './acceptance-provenance.mjs';
import { digest, snapshot } from './acceptance-io.mjs';

const moduleRoot = fs.realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const canonicalRoot = value => {
    const root = fs.realpathSync(value);
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
    if (fs.realpathSync(top) !== root) throw new Error('execution root must be a Git checkout root');
    return root;
};
const assertCommitBytes = root => {
    const tree = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], { cwd: root, encoding: 'utf8' });
    for (const entry of tree.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t'), [mode, type, oid] = entry.slice(0, tab).split(' '), name = entry.slice(tab + 1);
        if (type !== 'blob' || mode === '120000') throw new Error(`unsupported linked source input: ${name}`);
        const bytes = fs.readFileSync(path.join(root, name));
        const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (actual !== oid) throw new Error(`source bytes differ from exact commit: ${name}`);
    }
};

export function executionRoots({ targetRoot, contextPath = process.env.KELPI_ACCEPTANCE_CONTEXT, contextSha256 = process.env.KELPI_ACCEPTANCE_CONTEXT_SHA256 } = {}) {
    if (!contextPath) return { harnessRoot: moduleRoot, targetRoot: targetRoot ? canonicalRoot(targetRoot) : moduleRoot, context: null };
    const bytes = fs.readFileSync(contextPath);
    if (digest(bytes) !== contextSha256) throw new Error('execution context digest differs');
    const context = JSON.parse(bytes);
    if (context.schemaVersion !== 1 || context.harness?.root !== moduleRoot || canonicalRoot(context.target?.root) !== context.target.root || canonicalRoot(context.harness.root) !== context.harness.root) throw new Error('executing harness/target roots differ from pinned context');
    if (targetRoot && canonicalRoot(targetRoot) !== context.target.root) throw new Error('target root differs from pinned context');
    return { harnessRoot: context.harness.root, targetRoot: context.target.root, context };
}
export function assertTargetExecution(root) {
    if (process.env.KELPI_ACCEPTANCE_CONTEXT) executionRoots({ targetRoot: root });
}

export function captureExecutionRoots({ targetRoot, harnessRoot = moduleRoot, targetHead, harnessHead }) {
    const capture = (root, head, role) => {
        root = canonicalRoot(root);
        const state = snapshot(root);
        if (!/^[a-f0-9]{40}$/.test(head ?? '') || state.head !== head) throw new Error(`${role} exact expected head differs or is absent`);
        if (state.dirty.length) throw new Error(`${role} source is dirty or untracked`);
        // git status can hide assume-unchanged/skip-worktree edits. Compare actual blobs too.
        assertCommitBytes(root);
        return { root, expectedHead: head, state, source: captureSource(root) };
    };
    if (canonicalRoot(harnessRoot) !== moduleRoot) throw new Error('advertised harness differs from executing module');
    return { schemaVersion: 1, target: capture(targetRoot, targetHead, 'target'), harness: capture(harnessRoot, harnessHead, 'harness') };
}

export function observeExecutionRoots(context) {
    if (!context) return null;
    return Object.fromEntries(['target', 'harness'].map(role => {
        const { root } = context[role];
        return [role, { root: canonicalRoot(root), state: snapshot(root), source: captureSource(root) }];
    }));
}

export function executionRootErrors(context, observation) {
    if (!context) return observation ? ['unexpected external execution observation'] : [];
    const errors = [];
    for (const role of ['target', 'harness']) {
        const expected = context[role], actual = observation?.[role];
        if (!actual || actual.root !== expected.root || actual.state?.head !== expected.expectedHead || !Array.isArray(actual.state?.dirty) || actual.state.dirty.length || JSON.stringify(actual.source) !== JSON.stringify(expected.source)) errors.push(`${role} execution source changed or is incomplete`);
    }
    return errors;
}

/** Workspace packages must resolve from the target, even when a dependency store is shared. */
export function targetWorkspaceLinkErrors(targetRoot) {
    const errors = [];
    for (const owner of ['', ...fs.readdirSync(path.join(targetRoot, 'packages')).map(name => `packages/${name}`)]) {
        const directory = path.join(targetRoot, owner, 'node_modules', '@kelpi');
        if (!fs.existsSync(directory)) continue;
        for (const name of fs.readdirSync(directory)) {
            const resolved = fs.realpathSync(path.join(directory, name));
            const expected = path.join(targetRoot, 'packages', name);
            if (!fs.existsSync(expected) || resolved !== fs.realpathSync(expected)) errors.push(`target workspace dependency escapes target: ${owner || '.'}/node_modules/@kelpi/${name}`);
        }
    }
    return errors;
}

/** Preserve prior generated outputs, then force a build into fresh known output directories. */
export function prepareTargetBuild(targetRoot, evidenceRoot) {
    const preserved = [];
    for (const name of ['client', 'daemon', 'cli', 'shell']) {
        const relative = `packages/${name}/dist`, directory = path.join(targetRoot, relative);
        if (!fs.existsSync(directory)) continue;
        if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`target build directory is a symlink: ${relative}`);
        const tracked = execFileSync('git', ['ls-files', '--', relative], { cwd: targetRoot, encoding: 'utf8' }).trim();
        if (tracked) throw new Error(`refusing to move tracked build input: ${relative}`);
        const destination = path.join(evidenceRoot, 'prior-generated-outputs', name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(directory, destination);
        preserved.push({ original: directory, retained: destination });
    }
    return preserved;
}
