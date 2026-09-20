import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspectSelection } from './acceptance-selection.mjs';
import { inspectProvenance } from './acceptance-provenance.mjs';
/** Strict interpretation of raw runner records. Summary booleans are never authority. */
export const precedence = (values) => values.includes('failed') ? 'failed' : values.includes('unverified') || values.length === 0 ? 'unverified' : 'verified';
export const exitCode = (verdict) => verdict === 'verified' ? 0 : verdict === 'failed' ? 1 : 2;
const list = (value) => Array.isArray(value) ? value : [];
const named = (value) => typeof value === 'string' && value.trim().length > 0;

export function inspectResults(kind, report, { exitStatus = 0, runId, head, startedAt, finishedAt = Date.now(), requireProvenance = true, approvedVisuals = [], selection, expectedPlan, buildReceipt, path: reportPath } = {}) {
    const failures = [], missing = [], assertions = [], visuals = [];
    const visualRequirements = collectVisualRequirements(kind, report, selection ?? expectedPlan, reportPath);
    const bad = (message) => failures.push(message);
    const absent = (message) => missing.push(message);
    if (exitStatus !== 0) bad(`process exit ${exitStatus}`);
    if (report?.harnessFailure) bad(`harness failure: ${JSON.stringify(report.harnessFailure)}`);
    if (!report || typeof report !== 'object' || Array.isArray(report)) absent('missing or malformed structured report');
    if (report && kind !== 'vitest' && requireProvenance) {
        const p = report.provenance ?? report.meta?.provenance;
        missing.push(...inspectProvenance(p, { head, buildReceipt }));
        for (const id of (selection ?? expectedPlan)?.runtimeRequirements ?? []) if (list(p?.runtimeBindings).filter(b => b?.id === id).length !== 1) absent('required runtime artifact binding absent or duplicated');
        if (!p || p.runId !== runId || p.head !== head || (p.requestedHead != null && p.requestedHead !== p.head)) absent('report run/commit identity does not match');
        if (!Array.isArray(p?.dirtyFiles) || p.dirtyFiles.length) absent('runner source was dirty or not recorded');
        const reportStart = Date.parse(p?.startedAt ?? report.startedAt ?? report.meta?.startedAt);
        if (!Number.isFinite(reportStart) || reportStart < startedAt - 1000 || reportStart > finishedAt) absent('stale or absent report start time');
    }
    const check = (entry, prefix, vitest = false) => {
        const id = vitest ? entry?.fullName ?? entry?.title : kind === 'scenario' ? entry?.label : entry?.name;
        const status = vitest ? entry?.status : entry?.ok === true ? 'passed' : entry?.ok === false ? 'failed' : 'unknown';
        if (!named(id)) absent(`${prefix}: assertion has no name`);
        if (status === 'failed') bad(`${prefix}: ${id}`);
        else if (status !== 'passed') absent(`${prefix}: ${id ?? 'assertion'} ${status}`);
        assertions.push({ id: `${prefix} > ${id}`, name: id, status });
    };
    if (kind === 'vitest') {
        if (!Array.isArray(report?.testResults) || report.testResults.length === 0) absent('no test files executed');
        if (requireProvenance && (!Number.isFinite(report?.startTime) || report.startTime < startedAt - 1000 || report.startTime > finishedAt)) absent('stale or absent vitest start time');
        for (const file of list(report?.testResults)) {
            if (!named(file?.name) || !Array.isArray(file?.assertionResults)) absent('malformed test file');
            if (file?.status === 'failed' || file?.message) bad(`${file?.name}: test file error`);
            if (!['passed', 'failed'].includes(file?.status)) absent(`${file?.name}: incomplete test file`);
            for (const entry of list(file?.assertionResults)) check(entry, file.name, true);
        }
        const counts = { numTotalTests: assertions.length, numPassedTests: assertions.filter(a => a.status === 'passed').length, numFailedTests: assertions.filter(a => a.status === 'failed').length };
        for (const [key, count] of Object.entries(counts)) if (report?.[key] !== count) absent(`vitest ${key} counter mismatch`);
        if (Number(report?.numFailedTestSuites) > 0 || Number(report?.numRuntimeErrorTestSuites) > 0 || list(report?.unhandledErrors).length > 0) bad('vitest runtime/suite errors');
        if (report?.success === false) bad('vitest reported failure');
    } else if (kind === 'audit') {
        if (!Array.isArray(report?.steps) || report.steps.length === 0) absent('no audit steps executed');
        for (const step of list(report?.steps)) {
            if (!named(step?.id) || !Array.isArray(step?.assertions)) absent('malformed audit step');
            if (step?.error) bad(`${step.id}: step error: ${step.error}`);
            for (const entry of list(step?.assertions)) check(entry, step.id);
        }
        const counts = { total: list(report?.steps).length, assertions: assertions.length, failedAssertions: assertions.filter(a => a.status === 'failed').length, errored: list(report?.steps).filter(s => s?.error).length, eyes: list(report?.steps).filter(s => s?.needsEyes).length };
        for (const [key, count] of Object.entries(counts)) if (report?.summary?.[key] !== count) absent(`audit ${key} counter mismatch`);
    } else if (kind === 'scenario') {
        if (!Array.isArray(report?.summaries) || report.summaries.length === 0) absent('no scenarios executed');
        for (const summary of list(report?.summaries)) {
            const entries = summary?.results;
            if (!named(summary?.name) || !Array.isArray(entries)) absent('missing raw scenario assertions');
            for (const entry of list(entries)) check(entry, summary.name);
            const failed = list(entries).filter(a => a?.ok === false).length;
            if (summary?.checks !== list(entries).length || summary?.failed !== failed) absent(`${summary?.name}: scenario counter mismatch`);
            if (Number(summary?.failed) > 0 || summary?.error) bad(`${summary?.name}: scenario failed`);
            if (list(summary?.leaked).length > 0) bad(`${summary.name}: cleanup leak`);
        }
        if (list(report?.leaks).length > 0) bad('scenario cleanup leaks');
    } else absent(`unsupported structured report kind: ${kind}`);
    if (kind === 'audit' || kind === 'scenario') {
        const cleanup = report?.cleanup ?? report?.meta?.cleanup;
        if (!cleanup || cleanup.attempted !== true || cleanup.completed !== true || !Array.isArray(cleanup.errors) || !Array.isArray(cleanup.leaks)) absent('cleanup was not fully evidenced');
        if (list(cleanup?.errors).length > 0 || list(cleanup?.leaks).length > 0) bad('cleanup errors or unresolved leaks');
    }
    missing.push(...inspectSelection(kind, report, selection ?? expectedPlan));
    if (assertions.length === 0 && !(selection ?? expectedPlan)?.members?.every(m => ['setup','visual'].includes(m?.mode))) absent('no named assertions executed');
    if (new Set(assertions.map(a => a.id)).size !== assertions.length) absent('duplicate assertion identities');
    for(const visual of visualRequirements) if(!approvedVisuals.includes(visual.id) || !visual.shots.length || visual.placement === 'hidden' || visual.shots.some(s => s?.blank || s?.placement === 'hidden') || kind === 'scenario' && visual.placement !== 'onscreen') visuals.push(visual.id);
    if (visuals.length > 0) absent(`outstanding visual review: ${visuals.join(', ')}`);
    return { verdict: failures.length ? 'failed' : missing.length ? 'unverified' : 'verified', failures, missing, assertions, visuals, visualRequirements, counts: { total: assertions.length, failed: assertions.filter(a => a.status === 'failed').length, stepErrors: kind === 'audit' ? list(report?.steps).filter(s => s?.error).length : 0, harnessErrors: report?.harnessFailure ? 1 : 0, cleanupErrors: list((report?.cleanup ?? report?.meta?.cleanup)?.errors).length, cleanupLeaks: list((report?.cleanup ?? report?.meta?.cleanup)?.leaks).length + list(report?.leaks).length } };
}

// Frozen source obligations and legacy notes are additive; deleting a raw flag
// never removes a source requirement. A scenario visual is tied to its shot label.
export function collectVisualRequirements(kind, report, selection, reportPath) {
    const requirements = [];
    const resolveShot = shot => typeof shot === 'string' ? {path: path.resolve(path.dirname(reportPath ?? '.'),shot)} : shot;
    for (const member of kind === 'scenario' ? list(report?.summaries) : kind === 'audit' ? list(report?.steps) : []) {
        if (!member || typeof member !== 'object') continue;
        const id = kind === 'scenario' ? member.name : member.id;
        const spec = list(selection?.members).find(m => m?.id === id);
        const byId = new Map();
        const add = visual => { if(named(visual?.id)) byId.set(visual.id, {...byId.get(visual.id), ...visual}); };
        for (const required of list(spec?.requiredVisuals)) add({id:required});
        if (kind === 'audit') {
            if (member.needsEyes || spec?.mode === 'visual') add({id});
            for (const v of byId.values()) Object.assign(v, {shots:list(member.shots).map(resolveShot), placement: member.placement ?? report.meta?.windowPlacement ?? report.meta?.window});
        } else {
            const screenshots = list(member.screenshots);
            let previousShot;
            for (const note of list(member.notes)) {
                if(typeof note !== 'string') continue;
                if(note.startsWith('shot: ')) {
                    const match=/^shot: (.*?)(?:  \[(hidden|offscreen|onscreen):.*)?$/.exec(note);
                    if(match) {
                        const file=match[1], label=path.basename(file).replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}-\\d+-`),'').replace(/\.png$/,'');
                        previousShot={id:`${id}:shot:${label}`,path:file,placement:match[2] ?? member.placement,blank:/BLANK/.test(note)};
                    }
                }
                if(/^EYES\b/.test(note)) add({id:previousShot?.id ?? `${id}:eyes:missing-shot`,reason:note,shots:previousShot ? [previousShot] : [],placement:previousShot?.placement});
            }
            for(const v of list(member.visuals)) if(v && typeof v === 'object') add({...v,shots:screenshots.filter(s=>s?.id===(v.screenshotId ?? v.id)),placement:member.placement});
            for(const v of byId.values()) {
                const recorded=screenshots.filter(s=>s?.id===v.id);
                if(recorded.length) v.shots=recorded;
                v.placement ??= member.placement;
            }
        }
        for(const v of byId.values()) requirements.push({...v,memberId:id,kind,shots:list(v.shots).map(resolveShot)});
    }
    // Absent selected members retain their visual obligations as well.
    for(const spec of list(selection?.members)) for(const id of list(spec?.requiredVisuals)) if(!requirements.some(v=>v.id===id))requirements.push({id,memberId:spec.id,kind,shots:[]});
    return requirements;
}

/** Decode the bounded 8-bit RGB/RGBA PNGs emitted by CDP; unsupported images fail closed.
 * Uniform or fully transparent images cannot be signed as visible UI evidence. */
export function reviewablePng(file) {
    try {
        const { inflateSync } = createRequire(import.meta.url)('node:zlib');
        const bytes=fs.readFileSync(file);
        if(bytes.length>64*1024*1024 || !bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return false;
        let width,height,bpp,ended=false;const chunks=[];
        for(let offset=8;offset+12<=bytes.length;) {
            const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+size);
            if(offset+12+size>bytes.length)return false;
            if(type==='IHDR') {width=data.readUInt32BE(0);height=data.readUInt32BE(4);bpp=data[9]===2 ? 3 : data[9]===6 ? 4 : 0;if(data[8]!==8 || data[10] || data[11] || data[12])return false;}
            if(type==='IDAT')chunks.push(data);
            if(type==='IEND') {ended=true;break;} offset+=size+12;
        }
        if(!ended || !bpp || !width || !height || width*height>16_000_000)return false;
        const stride=width*bpp,raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:(stride+1)*height});
        if(raw.length!==(stride+1)*height)return false;
        let prior=Buffer.alloc(stride),first,nonuniform=false;
        const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc ? a : pb<=pc ? b : c;};
        for(let y=0;y<height;y++) {
            const filter=raw[y*(stride+1)],row=Buffer.from(raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)));
            if(filter>4)return false;
            for(let x=0;x<stride;x++) {const a=x>=bpp?row[x-bpp]:0,b=prior[x],c=x>=bpp?prior[x-bpp]:0;row[x]=(row[x]+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255;}
            for(let x=0;x<stride;x+=bpp) {
                const alpha=bpp===4?row[x+3]/255:1;
                const color=(Math.round(row[x]*alpha+255*(1-alpha))<<16) | (Math.round(row[x+1]*alpha+255*(1-alpha))<<8) | Math.round(row[x+2]*alpha+255*(1-alpha));
                first ??= color;if(color!==first)nonuniform=true;
            }
            prior=row;
        }
        return nonuniform;
    } catch {return false;}
}
