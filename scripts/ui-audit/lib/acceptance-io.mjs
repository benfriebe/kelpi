import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export const digest = (data) => createHash('sha256').update(data).digest('hex');
export function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
export function snapshot(root) {
    return { head: git(root, ['rev-parse', '--verify', 'HEAD']), dirty: git(root, ['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean) };
}
export function resolveRef(root, ref) {
    if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('reference must be a non-option git revision');
    return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}
export function startRun(root, { outRoot = path.join(root, 'docs/audit/acceptance'), args = [], reference = null } = {}) {
    const startedAt = new Date().toISOString();
    const runId = `${startedAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
    const outDir = path.join(outRoot, runId);
    fs.mkdirSync(outDir, { recursive: true });
    return { schemaVersion: 1, runId, repositoryRoot: fs.realpathSync(root), outDir, startedAt, args, reference, start: snapshot(root), environment: { hostname: os.hostname(), platform: process.platform, release: os.release(), arch: process.arch, node: process.version }, artifacts: [] };
}
export function readArtifact(file, run, { startedAt = Date.parse(run.startedAt), kind } = {}) {
    try {
        const bytes = fs.readFileSync(file);
        const stat = fs.statSync(file);
        if (stat.mtimeMs < startedAt - 1000) throw new Error('artifact predates attempt');
        const artifact = { path: path.resolve(file), sha256: digest(bytes), bytes: bytes.length, kind, recordedAt: new Date().toISOString() };
        run.artifacts.push(artifact);
        return { artifact, data: JSON.parse(bytes) };
    } catch (error) { return { data: null, error: String(error.message ?? error) }; }
}
export function verifyArtifacts(artifacts) {
    return Array.isArray(artifacts) && artifacts.every(a => { try { return /^[a-f0-9]{64}$/.test(a.sha256) && digest(fs.readFileSync(a.path)) === a.sha256; } catch { return false; } });
}
export function writeAcceptance(run, result) {
    const report = { ...run, ...result, finishedAt: new Date().toISOString() };
    const target = path.join(run.outDir, 'acceptance.json');
    delete report.completion;
    // The final JSON is the commit point; a failed Markdown/receipt write cannot authorize publication.
    const lines = ['# Commit acceptance', '', `Verdict: **${report.verdict}**`, '', `Commit: \`${report.start.head}\``, `Reference: \`${report.reference ?? 'missing'}\``, `Run: \`${report.runId}\``, `Scope: ${report.scope ?? 'commit'}`, '', '## Reasons', '', ...(report.reasons ?? []).map(r => `- ${r}`), '', '## Components', '', ...(report.components ?? []).map(c => `- ${c.label}: ${c.state}`), '', '## Dirty paths', '', ...[...new Set([...report.start.dirty, ...(report.end?.dirty ?? [])])].map(p => `- ${p}`), '', '## Artifacts', '', ...report.artifacts.map(a => `- ${a.path} — SHA256 \`${a.sha256}\``), ''];
    const markdownPath = path.join(run.outDir, 'acceptance.md');
    fs.writeFileSync(markdownPath, lines.join('\n'), { flag: 'wx' });
    const receipt = { schemaVersion: 1, reportDigest: digest(JSON.stringify(report)), markdown: { path: markdownPath, sha256: digest(fs.readFileSync(markdownPath)) }, artifactManifestDigest: digest(JSON.stringify(report.artifacts)) };
    const completionPath = path.join(run.outDir, 'acceptance-complete.json');
    fs.writeFileSync(completionPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
    report.completion = { path: completionPath, sha256: digest(fs.readFileSync(completionPath)) };
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return report;
}

export const canonicalRunId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export function verifyCompletion(report) {
    try {
        const { completion, ...data } = report;
        if (!verifyArtifacts([completion])) return false;
        const receipt = JSON.parse(fs.readFileSync(completion.path, 'utf8'));
        return receipt.schemaVersion === 1 && receipt.reportDigest === digest(JSON.stringify(data)) && receipt.artifactManifestDigest === digest(JSON.stringify(report.artifacts)) && verifyArtifacts([receipt.markdown]) && verifyArtifacts(report.artifacts);
    } catch { return false; }
}
