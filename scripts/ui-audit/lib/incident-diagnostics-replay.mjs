import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const startedAt = new Date().toISOString();
const runId = process.env.KELPI_ACCEPTANCE_RUN_ID ?? randomUUID();

export function captureProvenance(repoRoot, files = []) {
    const git = args => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const hashes = {};
    const visit = relative => {
        const absolute = path.join(repoRoot, relative);
        if (!fs.existsSync(absolute)) { hashes[relative] = null; return; }
        if (fs.statSync(absolute).isDirectory()) {
            for (const child of fs.readdirSync(absolute).sort()) visit(path.join(relative, child));
        } else hashes[relative] = hash(fs.readFileSync(absolute));
    };
    for (const directory of ['packages/client/dist', 'packages/daemon/dist', 'packages/cli/dist', 'packages/shell/dist']) visit(directory);
    for (const file of git(['ls-files', '--others', '--exclude-standard', '--', 'scripts']).split('\n').filter(Boolean)) visit(file);
    for (const file of files) hashes[path.relative(repoRoot, file)] = hash(fs.readFileSync(file));
    const head = git(['rev-parse', 'HEAD']), requestedHead = process.env.KELPI_ACCEPTANCE_HEAD ?? null;
    if (requestedHead !== null && head !== requestedHead) throw new Error(`requested HEAD ${requestedHead} differs from actual ${head}`);
    return { runId, head, requestedHead, startedAt, dirtyFiles: git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean),
        trackedDiffSha256: hash(git(['diff', 'HEAD', '--binary'])), buildHashes: hashes };
}

export function replayFiles(source, through) {
    if (!Array.isArray(source.files) || source.files.length === 0) throw new Error('replay requires the original ordered files');
    const index = through === undefined ? source.sequence?.firstFailure?.index : Number(through);
    if (!Number.isInteger(index) || index < 0 || index >= source.files.length) throw new Error('--through must identify an original scenario index (zero based)');
    return source.files.slice(0, index + 1);
}

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function firstFailureSequence({ files, summaries, resultsPath, windowPlacement }) {
    const index = summaries.findIndex(summary => summary.failed > 0);
    return { orderedFiles: files, firstFailure: index < 0 ? null : {
        index, name: summaries[index].name, selectedFile: files[index], precedingFiles: files.slice(0, index),
        replayCommand: `node scripts/scenario.mjs --no-build --replay ${quote(resultsPath)} --through ${index}${windowPlacement && windowPlacement !== 'attached' ? ` --window ${quote(windowPlacement)}` : ''}`,
        freshSandbox: true, originalArtifactsPreserved: true
    } };
}
