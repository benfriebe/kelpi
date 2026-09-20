import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { declarationDependencies, declarationReader, declarationFile, validateDeclarations, matchesAssertionSegments } from './assertion-declarations.mjs';
import { scenarioPlan, auditPlan } from './incident-diagnostics-plan.mjs';
import { assertionIdentities, inspectSelection } from './acceptance-selection.mjs';
import { smokePlan } from './smoke-plan.mjs';
import { CANONICAL_ORDER } from './shards.mjs';
const repo = path.resolve(import.meta.dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'source-assertion-contracts-'));
afterAll(() => fs.rmSync(temporary, {recursive:true, force:true}));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => structuredClone(value);
let serial = 0;
function fixture() {
    const root = path.join(temporary, String(++serial));
    const source = 'scripts/scenarios/reviewed.mjs';
    const files = {
        [source]: "import { labels } from '../helper.mjs'; export default async ({ rec }) => { for (const label of labels) rec.check(label, true); rec.check('fixture cleanup: owned pane', true); };",
        'scripts/helper.mjs': "export const labels = ['probe', 'probe', 'probe [1]'];",
        'scripts/scenario.mjs': '// fixture runner\n',
        'scripts/ui-audit/lib/driver.mjs': '// fixture driver\n',
        'scripts/ui-audit/lib/placement.mjs': '// fixture placement resolver\n',
        'package.json': '{"type":"module"}',
        'pnpm-lock.yaml': 'lockfileVersion: 9.0\n'
    };
    for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root,file)), {recursive:true}); fs.writeFileSync(path.join(root,file),text); }
    for (const file of ['scripts/fixtures', 'scripts/ui-audit/fixtures']) fs.mkdirSync(path.join(root,file),{recursive:true});
    const dependencies = declarationDependencies(root, 'scenario', source);
    const labels = ['probe','probe','probe [1]','fixture cleanup: owned pane'];
    const document = {schemaVersion:1,bindings:Object.fromEntries(dependencies.map(file=>[file,hash(path.join(root,file))])),members:[{
        kind:'scenario',id:'reviewed',source,dependencies,limitations:[{error:'dynamic assertion loop',reason:'Expand the imported, byte-bound three-item labels list in source order.'}],
        paths:[{reason:'Three loop receipts followed by required cleanup.',count:labels.length,assertions:labels}],requiredVisuals:[],review:'The imported helper emits all three ordered labels before the mandatory cleanup receipt.'
    }]};
    const selected = {id:'reviewed',mode:'assert',complete:false,contractErrors:['dynamic assertion loop'],requiredAssertions:['fixture cleanup: owned pane'],assertionPaths:[['fixture cleanup: owned pane']],minAssertions:1,requiredVisuals:[]};
    const read = (doc=document, base=selected, kind='scenario', file=source) => declarationReader(root,doc)(kind,path.join(root,file),base);
    return {root,source,document,selected,read};
}

describe('reviewed assertion declaration schema and byte binding', () => {
    it('expands only a reviewed parser limitation and retains duplicate literal labels plus cleanup', () => {
        const f=fixture(), result=f.read();
        expect(validateDeclarations(f.document)).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.assertionPaths[0]).toEqual(['probe','probe','probe [1]','fixture cleanup: owned pane']);
        expect(result.parserLimitations).toEqual(f.document.members[0].limitations);
        expect(result.reviewedContract.dependencies).toEqual(f.document.bindings);
    });
    it.each(['scripts/scenarios/reviewed.mjs','scripts/helper.mjs','scripts/ui-audit/lib/driver.mjs','scripts/ui-audit/lib/placement.mjs','pnpm-lock.yaml'])('rejects changed bytes in %s, even when the id and labels remain unchanged', file => {
        const f=fixture(); fs.appendFileSync(path.join(f.root,file),'\n// changed bytes\n');
        const result=f.read(); expect(result.complete).toBe(false);expect(result.contractErrors).toContain(`reviewed assertion source/helper bytes differ: ${file}`);
    });
    it('does not memoize helper hashes across separate plan discoveries', () => {
        const f=fixture();expect(f.read().complete).toBe(true);fs.appendFileSync(path.join(f.root,'scripts/helper.mjs'),'\n// drift\n');expect(f.read().complete).toBe(false);
    });
    it('rejects omitted helpers even if all remaining hashes still match', () => {
        const f=fixture(); f.document.members[0].dependencies=f.document.members[0].dependencies.filter(file=>file!=='scripts/helper.mjs');
        expect(f.read().contractErrors).toContain('reviewed assertion dependency graph differs');
    });
    it('binds path-loaded fixture helpers, including newly added files', () => {
        const f=fixture();fs.writeFileSync(path.join(f.root,'scripts/fixtures/probe.mjs'),'export const probe = true;');
        expect(f.read().contractErrors).toContain('reviewed assertion dependency graph differs');
    });
    it('does not reuse a known id from another source path or namespace', () => {
        const f=fixture();fs.writeFileSync(path.join(f.root,'scripts/scenarios/other.mjs'),'export default () => {};');
        expect(f.read(f.document,f.selected,'scenario','scripts/scenarios/other.mjs').complete).toBe(false);
        const other=f.read(f.document,f.selected,'audit');expect(other.complete).toBe(false);expect(other.reviewedContract).toBeUndefined();
    });
    it('rejects a source symlink escaping the declared harness root', () => {
        const f=fixture(),file=path.join(f.root,'scripts/helper.mjs'),outside=path.join(temporary,'outside.mjs');fs.copyFileSync(file,outside);fs.unlinkSync(file);fs.symlinkSync(outside,file);
        expect(f.read().complete).toBe(false);expect(f.read().contractErrors.join(' ')).toContain('escapes harness root');
    });
    it.each([
        doc=>{doc.schemaVersion=2;},
        doc=>{doc.members[0].paths[0].count++;},
        doc=>{doc.members[0].paths[0].assertions.pop();},
        doc=>{doc.members[0].paths[0].assertions[0]='';},
        doc=>{doc.members[0].paths[0].assertions='probe';},
        doc=>{doc.members[0].paths.push(clone(doc.members[0].paths[0]));},
        doc=>{doc.members.push(clone(doc.members[0]));},
        doc=>{doc.members[0].complete=true;},
        doc=>{doc.members[0].limitations[0].error='known cleanup helper must be awaited';},
        doc=>{doc.members[0].limitations[0].reason='';},
        doc=>{doc.members[0].dependencies.push('../escaped.mjs');},
        doc=>{doc.bindings['scripts/helper.mjs']='opaque-last-run-digest';}
    ])('rejects malformed declarations without falling back to a complete parser result (%#)', mutate => {
        const f=fixture();mutate(f.document);expect(validateDeclarations(f.document).length).toBeGreaterThan(0);expect(f.read(f.document,{...f.selected,complete:true,contractErrors:[]}).complete).toBe(false);
    });
    it.each(['known cleanup helper must be awaited','known cleanup helper requires a fixture cleanup failure receipt','cleanup helper import is shadowed or lexical identity is unproven','visual requirement has no statically named screenshot','no complete successful assertion path','successful path limit exceeded','requiresNativeFocus must be an immutable literal boolean export'])('retains structural error: %s', error => {
        const f=fixture(),result=f.read(f.document,{...f.selected,contractErrors:[...f.selected.contractErrors,error]});expect(result.complete).toBe(false);expect(result.contractErrors).toContain(error);
    });
    it('rejects dropping a mandatory cleanup receipt from an otherwise valid full path', () => {
        const f=fixture(),p=f.document.members[0].paths[0];p.assertions.pop();p.count--;expect(f.read().complete).toBe(false);expect(f.read().contractErrors).toContain('reviewed assertion path omits statically required assertions');
    });
    it('retains discovered visual review obligations', () => {
        const f=fixture(),selected={...f.selected,requiredVisuals:['reviewed:shot:live']};expect(f.read(f.document,selected).complete).toBe(false);f.document.members[0].requiredVisuals=['reviewed:shot:live'];expect(f.read(f.document,selected).requiredVisuals).toEqual(selected.requiredVisuals);
    });
});

describe('complete ordered assertion identities', () => {
    const raw=['probe','probe','probe [1]','@assertion:["probe",1]','fixture cleanup: owned pane'];
    const labels=assertionIdentities(raw);
    const selection={kind:'audit',ordered:true,complete:true,members:[{id:'fixture',mode:'assert',complete:true,requiredAssertions:labels,assertionPaths:[labels],minAssertions:raw.length,requiredVisuals:[]}]};
    const report=entries=>({steps:[{id:'fixture',assertions:entries.map(name=>({name,ok:true}))}]});
    it('keeps repeated prose distinct from literal suffixes and encoded-looking labels', () => {expect(new Set(labels).size).toBe(raw.length);expect(assertionIdentities(labels)).toEqual(labels);expect(inspectSelection('audit',report(raw),selection)).toEqual([]);});
    it.each([raw.slice(1),[...raw,'extra'],[raw[2],...raw.slice(0,2),...raw.slice(3)],[...raw.slice(0,-1)],['different',...raw.slice(1)]].map(entries=>[entries]))('rejects dropped, added, reordered, renamed, or missing cleanup assertions (%#)', entries=>{expect(inspectSelection('audit',report(entries),selection).length).toBeGreaterThan(0);});
    it('matches complete alternatives rather than their union or a subsequence',()=>{
        const spec={...selection,members:[{...selection.members[0],requiredAssertions:['start','end'],minAssertions:3,assertionPaths:[['start','A','end'],['start','B','end']]}]};
        expect(inspectSelection('audit',report(['start','B','end']),spec)).toEqual([]);expect(inspectSelection('audit',report(['start','A','B','end']),spec).length).toBeGreaterThan(0);
    });
});

describe('static discovery fail-closed boundaries',()=>{
    it('does not hide a nested predicate assertion behind its outer aggregate',()=>{
        const f=fixture();fs.writeFileSync(path.join(f.root,f.source),`export default async ({rec}) => { rec.check('outer aggregate', await (async () => { rec.check('inner pane', true); return true; })()); };`);
        const plan=scenarioPlan(f.root,[path.join(f.root,f.source)]);
        expect(plan.complete).toBe(false);expect(plan.members[0].contractErrors).toContain('assertion or visual inside an unresolved callback');
    });
    it('does not freeze an initial label value that is later reassigned',()=>{
        const f=fixture();fs.writeFileSync(path.join(f.root,f.source),"export default async ({rec}) => { let route = '(not reached)'; route = await Promise.resolve('real route'); rec.check(`via ${route}`, true); };");
        const member=scenarioPlan(f.root,[path.join(f.root,f.source)]).members[0];
        expect(member.complete).toBe(false);expect(member.contractErrors).toContain('dynamic assertion name');expect(member.assertionPaths.flat()).not.toContain('via (not reached)');
    });
    it.each([['',false],['export const requiresNativeFocus = false;',false],['export const requiresNativeFocus = true;',true],['const needsFocus = true; export { needsFocus as requiresNativeFocus };',true]])('freezes the prospective focus requirement from %s',(declaration,expected)=>{
        const f=fixture();fs.writeFileSync(path.join(f.root,f.source),`${declaration} export default ({rec}) => rec.check('body', true);`);
        const member=scenarioPlan(f.root,[path.join(f.root,f.source)]).members[0];expect(member.complete).toBe(true);expect(member.requiresNativeFocus).toBe(expected);
    });
    it.each(['export const requiresNativeFocus = "true";','export const requiresNativeFocus = undefined;','export const requiresNativeFocus = Boolean(1);','export let requiresNativeFocus = true;','export function requiresNativeFocus() {}','export { requiresNativeFocus } from "../helper.mjs";','export * as requiresNativeFocus from "../helper.mjs";'])('refuses an unproven or malformed focus declaration: %s',declaration=>{
        const f=fixture();fs.writeFileSync(path.join(f.root,f.source),`${declaration} export default ({rec}) => rec.check('body', true);`);
        const member=scenarioPlan(f.root,[path.join(f.root,f.source)]).members[0];expect(member.complete).toBe(false);expect(member.requiresNativeFocus).toBe(false);expect(member.contractErrors).toContain('requiresNativeFocus must be an immutable literal boolean export');
    });
    it('counts the required renderer receipt along with the complete scenario body',()=>{
        const f=fixture();fs.writeFileSync(path.join(f.root,f.source),`export default async ({rec}) => { rec.check('body', true); };`);
        const member=scenarioPlan(f.root,[path.join(f.root,f.source)]).members[0];
        expect(member.complete).toBe(true);expect(member.minAssertions).toBe(2);expect(member.assertionPaths).toEqual([['body','the renderer threw nothing and logged no error']]);
    });
});

describe('current source inventories',()=>{
    it('validates the checked-in review document',()=>{expect(validateDeclarations(JSON.parse(fs.readFileSync(declarationFile,'utf8')))).toEqual([]);});
    it('discovers complete plans for every scenario and canonical audit flow',()=>{
        const files=fs.readdirSync(path.join(repo,'scripts/scenarios')).filter(file=>file.endsWith('.mjs')).map(file=>path.join(repo,'scripts/scenarios',file));
        for(const plan of [scenarioPlan(repo,files),auditPlan(repo,[...CANONICAL_ORDER,'renderer-console'])])expect(plan.members.filter(member=>!member.complete).map(member=>({id:member.id,errors:member.contractErrors}))).toEqual([]);
    });
    it('cannot turn any real popup alternative into another by dropping a receipt',()=>{
        const member=auditPlan(repo,['web-popup-layering']).members[0],segments=member.assertionPathSegments;
        expect(member.complete,JSON.stringify(member.contractErrors)).toBe(true);expect(segments).toHaveLength(14);
        for(let index=0;index<segments.length;index++)for(const alternative of segments[index].alternatives){
            const labels=segments.flatMap((segment,i)=>i===index?alternative:segment.alternatives[0]);expect(matchesAssertionSegments(segments,labels)).toBe(true);
            for(let receipt=0;receipt<labels.length;receipt++)expect(matchesAssertionSegments(segments,labels.filter((_,i)=>i!==receipt)),labels[receipt]).toBe(false);
        }
    });
    it('keeps hidden presenter EYES reviews and requires the restart arm',()=>{
        for(const name of ['plugin-interaction-presenters','plugin-pane-chrome','plugin-settings-presenter']){
            const member=scenarioPlan(repo,[path.join(repo,`scripts/scenarios/${name}.mjs`)]).members[0];expect(member.requiredVisuals.length).toBeGreaterThan(3);expect(member.assertionPaths.every(labels=>labels.some(label=>/daemon.*(restart|disconnect)|stopping the primary daemon/.test(label)))).toBe(true);
        }
    });
    it.each(['shell','web','pwa','terminal','packaged'])('freezes a complete %s smoke inventory before execution',name=>{
        const plan=smokePlan(repo,name,{});expect(plan.complete,JSON.stringify(plan.members[0].contractErrors)).toBe(true);const labels=plan.members[0].assertionPaths[0];expect(labels.length).toBeGreaterThan(10);expect(inspectSelection('smoke',{name,assertions:labels.map(name=>({name,ok:true}))},plan)).toEqual([]);
    });
    it('selects the packaged signing branch from the prospective environment',()=>{
        const signed=smokePlan(repo,'packaged',{KELPI_MACOS_IDENTITY:'Developer ID Application: fixture'}),adhoc=smokePlan(repo,'packaged',{});
        expect(signed.members[0].assertionPaths).toHaveLength(1);expect(adhoc.members[0].assertionPaths).toHaveLength(1);expect(signed.members[0].requiredAssertions.some(label=>label.startsWith('cookie encryption is on'))).toBe(true);expect(adhoc.members[0].requiredAssertions.some(label=>label.startsWith('cookie encryption is off'))).toBe(true);
    });
});


describe('explicit full popup path segments',()=>{
    const segments=[
        {reason:'both pages start live',alternatives:[['start']]},
        {reason:'first popup covers one or both pages and restores both',alternatives:[['first open','first park left','first spare right','first restore left','first restore right'],['first open','first park left','first park right','first restore left','first restore right']]},
        {reason:'middle popup must execute in full',alternatives:[['middle open','middle close']]},
        {reason:'final cleanup',alternatives:[['cleanup']]}
    ];
    const one=segments.flatMap(s=>s.alternatives[0]);
    const both=segments.flatMap((s,i)=>s.alternatives[i===1?1:0]);
    it('accepts the complete single-page and both-page alternatives',()=>{
        expect(matchesAssertionSegments(segments,one)).toBe(true);expect(matchesAssertionSegments(segments,both)).toBe(true);
    });
    it('integrates complete segments with the frozen selection verifier',()=>{
        const selection={kind:'audit',ordered:true,complete:true,members:[{id:'popup',mode:'assert',complete:true,requiredAssertions:['start','cleanup'],minAssertions:one.length,assertionPaths:[one],assertionPathSegments:segments,requiredVisuals:['popup']}]};
        const report=entries=>({steps:[{id:'popup',needsEyes:true,assertions:entries.map(name=>({name,ok:true}))}]});
        expect(inspectSelection('audit',report(one),selection)).toEqual([]);expect(inspectSelection('audit',report(both),selection)).toEqual([]);
        expect(inspectSelection('audit',report(one.filter(label=>label!=='middle close')),selection).length).toBeGreaterThan(0);
    });
    it.each([
        one.filter(label=>label!=='first restore left'),
        one.filter(label=>!label.startsWith('middle')),
        [...one.slice(0,3),'first park right',...one.slice(3)],
        [...one,'extra'],one.slice(0,-1),
        [one[1],one[0],...one.slice(2)],
        [...one.slice(0,2),one[1],...one.slice(2)]
    ].map(entries=>[entries]))('rejects a partial, omitted, mixed, duplicated, extra, reordered or truncated segment (%#)',entries=>{
        expect(matchesAssertionSegments(segments,entries)).toBe(false);
    });
    it.each([
        s=>{s[1].alternatives.push([]);},
        s=>{s[1].alternatives.push([...s[1].alternatives[0]]);},
        s=>{s[1].alternatives.push(s[1].alternatives[0].slice(0,2));},
        s=>{s[1].alternatives.push(s[1].alternatives[0].filter(label=>label!=='first park left'));},
        s=>{s[1].alternatives[0].push('first open');},
        s=>{s[2].alternatives[0].push('start');},
        s=>{s[0].wildcard=true;},
        s=>{s[0].alternatives='anything';}
    ])('rejects malformed, ambiguous, or duplicate segment identities (%#)',mutate=>{
        const bad=clone(segments);mutate(bad);expect(matchesAssertionSegments(bad,one)).toBe(false);
    });
    it('validates the schema and preserves mandatory receipts across every alternative',()=>{
        const f=fixture(),member=f.document.members[0];member.pathSegments=[{reason:'bound producer',alternatives:[['probe','other'],['probe','different']]},{reason:'cleanup required',alternatives:[['fixture cleanup: owned pane']]}];
        member.paths=[{reason:'first full alternative',count:3,assertions:member.pathSegments.flatMap(s=>s.alternatives[0])}];
        expect(validateDeclarations(f.document)).toEqual([]);expect(f.read().complete).toBe(true);
        member.pathSegments[1].alternatives.push(['omitted cleanup']);expect(f.read().complete).toBe(false);
    });
});


describe('phone caret source assertion order', () => {
    // audit.mjs awaits checkPhoneHandback in finally before the roster and desktop checks.
    const labels = [
        "a keyboard taking viewport space turns the key into Hide (C8: the label names the keyboard, not the caret)",
        "the keyboard key puts the keyboard away: the caret leaves the engine",
        "and once the keyboard has actually left, the key reads Show with the caret still away: the state every tap below is about",
        "the platform's focus move onto the esc key is reproduced (Android does this; CDP's touch does not)",
        "tapping esc with the keyboard down does not summon it back",
        "the platform's focus move onto the home key is reproduced (Android does this; CDP's touch does not)",
        "tapping home with the keyboard down does not summon it back",
        "the platform's focus move onto the end key is reproduced (Android does this; CDP's touch does not)",
        "tapping end with the keyboard down does not summon it back",
        "the platform's focus move onto the left key is reproduced (Android does this; CDP's touch does not)",
        "tapping left with the keyboard down does not summon it back",
        "the platform's focus move onto the ctrl key is reproduced (Android does this; CDP's touch does not)",
        "tapping ctrl with the keyboard down does not summon it back",
        "the platform's focus move onto the ctrl key is reproduced (Android does this; CDP's touch does not)",
        "tapping ctrl with the keyboard down does not summon it back",
        "closing the Settings sheet does not summon the keyboard either",
        "tapping Show still puts the caret back on the engine, which is the only way up",
        "and the key still reads Show, because the tap asked for a keyboard that no desktop Chromium can produce",
        "and it turns into Hide when that keyboard arrives, over the caret the tap put back",
        "the window the next step inherits is the one this step was handed",
        "the phone lane’s clause: the roster the spine reads is untouched",
        "and NOT on desktop: closing Settings hands the caret back to the focused pane’s surface, as it always has",
    ];
    const selection = auditPlan(repo, ['phone-caret-owner']);
    const report = entries => ({steps:[{id:'phone-caret-owner',assertions:entries.map(name=>({name,ok:true}))}]});
    it('requires all 22 source-ordered receipts, with handback before post-finally checks', () => {
        const member = selection.members[0];
        expect(selection.complete).toBe(true);
        expect(member.minAssertions).toBe(22);
        expect(member.assertionPaths).toEqual([assertionIdentities(labels)]);
        expect(inspectSelection('audit', report(labels), selection)).toEqual([]);
    });
    it('rejects missing receipts, including handback and either repeated ctrl occurrence', () => {
        for (let index=0; index<labels.length; index++) {
            const partial = labels.filter((_,i)=>i!==index);
            expect(inspectSelection('audit', report(partial), selection).length, `missing receipt ${index+1}`).toBeGreaterThan(0);
        }
    });
    it('rejects the erroneous final-handback order, permutations, duplicates and extra receipts', () => {
        const invalid = [
            [...labels.slice(0,19), labels[20], labels[21], labels[19]],
            [...labels, labels[19]], [...labels, 'unexpected receipt'],
            labels.map((label,index)=>index===19 ? 'unproven replacement cleanup' : label),
            labels.filter((_,index)=>index!==13 && index!==14)
        ];
        for (let index=0; index<labels.length-1; index++) {
            const reordered = [...labels];
            [reordered[index],reordered[index+1]] = [reordered[index+1],reordered[index]];
            invalid.push(reordered);
        }
        for (const entries of invalid) expect(inspectSelection('audit', report(entries), selection).length).toBeGreaterThan(0);
    });
});
