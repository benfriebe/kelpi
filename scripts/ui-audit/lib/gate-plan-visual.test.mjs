import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { scenarioPlan, auditPlan } from './incident-diagnostics-plan.mjs';
import { inspectResults, reviewablePng } from './acceptance-results.mjs';
import { recorder } from './driver.mjs';
const root=path.resolve(import.meta.dirname,'../../..');
const out=fs.mkdtempSync(path.join(process.env.KELPI_GATE_FIXTURE_ROOT ?? os.tmpdir(),'gate-plan-visual-'));
afterAll(()=>{if(!process.env.KELPI_GATE_FIXTURE_ROOT)fs.rmSync(out,{recursive:true,force:true});});
const cleanup={attempted:true,completed:true,errors:[],leaks:[]};
// Actual named result inventory from the retained 1f84 scoped run (153 checks).
// The expected contract is always rediscovered from the selected real source.
const labels={
  "plugin-document-features": [
    "native markdown attaches to a real isolated SDK-only renderer",
    "replacement markdown reads the existing file and preserves pane identity",
    "other document types retain their native renderer",
    "diff exposes raw source and remains read-only",
    "SDK discovery includes three independently selectable document placements",
    "replacement edits autosave through the native file buffer",
    "switching back preserves the native edit mode and exact text",
    "preview mode survives renderer changes",
    "rapid input preserves the newest draft through serialized revision checks",
    "CLI watch streams initial and subsequently saved source snapshots",
    "renderer UI state persists independently of native document source",
    "CLI revisions reject stale edits without replacing the winner",
    "browser conflict reports a typed error and preserves the rejected input outside the iframe",
    "closing through the SDK refuses to orphan an unapplied draft",
    "a failed renderer falls back to the bundled editor with recovery controls",
    "the recovery review retains the exact rejected text",
    "window reload preserves both renderer choice and the recovery draft",
    "explicit recovery restores and saves through a fresh guarded revision",
    "failed disk saves retain the buffer and refuse CLI close",
    "repairing storage permits an explicit save of the retained buffer",
    "remote native documents render through their owning runtime",
    "embedded remote renderer edits only its remote file",
    "phone single-pane view mounts the same remote document renderer",
    "document controls fit the phone viewport",
    "daemon restart restores saved documents and invalidates old revision tokens",
    "direct browser attachment supports its own document preference",
    "disable restores all native documents without replacing panes",
    "reenabling restores saved per-type renderer choices",
    "cleanup: workbench placements restored",
    "cleanup: private remote workbench store removed",
    "the renderer threw nothing and logged no error"
  ],
  "plugin-terminal-features": [
    "isolated SDK-only terminal attaches to the existing full-screen process",
    "ANSI and Unicode viewport agrees exactly with daemon capture",
    "application terminal modes cross the renderer bridge",
    "CDP keyboard and injected composition commit reach the same raw process",
    "platform paste preserves the application bracketed-paste envelope",
    "platform Copy obtains live renderer selection",
    "cleared selection cannot copy a stale cached value",
    "returning to the bundled renderer preserves pane and operating-system PID",
    "four MiB of live ANSI and Unicode output converges without display corruption",
    "a slow real renderer triggers native resync and recovers an exact screen",
    "switching renderers during a four MiB burst preserves process and authoritative screen",
    "plugin reload reattaches and replays without restarting the process",
    "delayed renderer attachment preserves an active chrome text field",
    "renderer failure activates a bundled fallback with the same process",
    "retry restores the replacement after failure",
    "an empty renderer error still activates the bundled fallback",
    "retry restores the renderer after an empty error",
    "leaving a workspace preserves the daemon-owned process",
    "returning to a workspace reattaches to the same process and screen",
    "renderer measurements resize the existing PTY through the window connection",
    "plugin resize cannot override another native connection owning PTY geometry",
    "native size control returns ownership to the plugin renderer window",
    "a live query still receives its response after a newer resize replay supersedes it",
    "a queued device query survives resize replay before its renderer callback begins",
    "native terminal search reveals and selects a plugin-rendered hit",
    "repeating the same search hit delivers a fresh reveal action",
    "local zoom follows native renderer eviction while preserving the process",
    "zooming out replays the original process into its original pane",
    "keyboard input still mirrors to synchronized sibling processes",
    "native SGR mouse reports remain direct and never mirror into a sibling",
    "window reconnect preserves the process and restores the renderer preference",
    "disabling a plugin restores the bundled renderer without closing its terminal",
    "reenabling restores the selected renderer",
    "external-editor mode renders exact fixture text on the document pane",
    "switching an external-editor renderer retains its editor process",
    "exiting the external editor restores the same document with saved source",
    "embedded remote terminal replays through the remote runtime",
    "remote keyboard input reaches only its owning daemon process",
    "remote platform paste targets only the remote process",
    "remote platform Copy resolves the remote renderer selection",
    "a remote pane hidden by zoom retains its renderer and attachment",
    "hidden renderer keyboard input and geometry are ignored",
    "a hidden renderer still answers live terminal protocol queries",
    "revealing the hidden pane preserves its original iframe identity",
    "phone remote workspace mounts the same replacement contract",
    "phone remote pane/layout toggles preserve the process and screen",
    "phone key bar dispatches application cursor keys through the plugin renderer",
    "phone Control applies to an actual key and clears both latches",
    "the following phone key is unmodified",
    "phone ctrl+[ preserves software-keyboard character encoding",
    "phone ctrl+\\ preserves software-keyboard character encoding",
    "phone alt+/ preserves software-keyboard character encoding",
    "phone alt+X preserves software-keyboard character encoding",
    "terminal replacement fits the phone viewport",
    "the phone key bar fits inside the visible viewport",
    "direct browser attachment preserves the remote process",
    "non-Mac Ctrl+C sends exactly one interrupt with an empty selection",
    "returning to the original window restores its local terminal process",
    "incident diagnostics complete without observer errors",
    "cleanup: phone returned to landing",
    "cleanup: terminal placement restored",
    "cleanup: private remote workbench store removed",
    "the renderer threw nothing and logged no error"
  ],
  "plugin-terminal-geometry": [
    "an owning renderer mirrors nothing and renders its own measured grid",
    "the screen element fills the view to the sub-cell remainder, minus the scrollbar gutter",
    "the chip is not offered to a window that owns sizing",
    "the window is told another client owns sizing (the chip appears)",
    "the renderer publishes the owner grid it is mirroring",
    "the emulator is at the owner grid and letterboxed inside a wider view",
    "nothing is scaled to fit: no transform on the container or the emulator root",
    "the soft-wrapped owner line reads exactly as the daemon capture prints it",
    "and it wraps at the OWNER's 40th column, on three physical rows, not glued into one",
    "the mirror survives that output and the process is untouched",
    "a mirroring renderer keeps reporting its own measurement, never the mirrored grid",
    "and the daemon cached that report rather than applying it: the PTY is still the owner's",
    "a viewer narrower than the owner keeps the owner grid and is clipped, not re-wrapped",
    "and the container clips rather than offering a scroll: overflow clip on both axes",
    "the clipped screen still reads exactly as the daemon capture prints it",
    "and the owner's line runs past this view's right edge, cut rather than re-wrapped",
    "a click inside the letterbox reports the mirrored grid's cell to the process",
    "a renderer hidden by a workspace switch reattaches, mirrors again and keeps its process",
    "the bundled renderer mirrors the same grid through its own contract",
    "switching back to the SDK renderer re-establishes the mirror on the same process",
    "taking size control clears the mirror and puts the emulator back on this box",
    "and the chip goes away again",
    "the PTY is the window's measurement again, neither 40 nor 120 columns",
    "an owner disconnecting hands sizing to this window: the mirror clears and the PTY follows it",
    "a fresh owner re-establishes the mirror at its own grid",
    "a disposed session refuses to resize or to write",
    "a fresh renderer attaches over the disposed one and mirrors the standing owner",
    "a remote pane with no other client owns its own runtime's sizing",
    "a raw client of the REMOTE daemon makes the embedded remote pane mirror",
    "and the local pane is untouched by it: no mirror, and it still sizes its own PTY",
    "cleanup: workbench placements restored",
    "cleanup: private remote workbench store removed",
    "the renderer threw nothing and logged no error"
  ],
  "renderer-errors-at-boot": [
    "CDP attaches before any client navigation",
    "the first document was intercepted",
    "boot returned despite the missing app root",
    "startup errors fail the named renderer check",
    "the first document exception is preserved exactly once",
    "the first document console error is preserved exactly once",
    "startup errors are consumed once",
    "the renderer threw nothing and logged no error"
  ],
  "terminal-copy-paste-chords": [
    "a workspace of its own to copy in",
    "a terminal pane to copy from",
    "⌘D gave us a second pane to paste into",
    "the drag made a selection the engine reports",
    "the clipboard was overwritten with the sentinel after the drag",
    "the sentinel really is on the clipboard before ⌘C",
    "⌘C put the terminal selection on the clipboard (#81)",
    "and the sentinel is gone, so nothing overwrote the copy afterwards (no Edit menu double-fire)",
    "⌘] focused the second pane",
    "the copied text was still on the clipboard at the moment of ⌘V",
    "the first paste operation delivered the synthetic marker",
    "the ⌘V chord ALONE pasted the copied text into the focused pane (#81)",
    "and it arrived exactly once, so the Edit menu Paste did not also fire",
    "DECSET 1000 reached the client as a live pane mode",
    "with an application owning the mouse, a plain drag selects nothing",
    "and Shift+drag selects anyway, which is the bypass the help overlay now names",
    "incident diagnostics complete without observer errors",
    "the renderer threw nothing and logged no error"
  ]
};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4//8/AwMDAA74Av7Ji4P1AAAAAElFTkSuQmCC','base64'),blank=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGP4DwYAFPIF+6QNfF4AAAAASUVORK5CYII=','base64');
const source=(name)=>path.join(root,'scripts/scenarios',name+'.mjs');
function actual(names) {
 const selection=scenarioPlan(root,names.map(source));
 const raw={files:names.map(source),cleanup,summaries:names.map(name=>({name,checks:labels[name].length,failed:0,results:labels[name].map(label=>({label,ok:true})),notes:[]}))};
 return {raw,selection,requireProvenance:false};
}
const checked=f=>inspectResults('scenario',f.raw,f);
describe('successful paths derived from actual selected sources and reports',()=>{
 it.each(['terminal-copy-paste-chords','plugin-document-features','plugin-terminal-features','renderer-errors-at-boot'])('%s retains its full control and rejects omitted behavior',name=>{
  const f=actual([name]);expect(f.selection.complete).toBe(true);expect(checked(f).verdict).toBe('verified');
  for(const required of f.selection.members[0].requiredAssertions){const g=structuredClone(f);g.raw.summaries[0].results=g.raw.summaries[0].results.filter(a=>a.label!==required);g.raw.summaries[0].checks--;expect(checked(g).verdict,required).toBe('unverified');}
  f.raw.summaries[0].results=f.raw.summaries[0].results.slice(0,1);f.raw.summaries[0].checks=1;expect(checked(f).verdict).toBe('unverified');
 });
 it('refuses an unexplained one-check minimum even if a producer labels it complete',()=>{
  const f=actual(['terminal-copy-paste-chords']);f.selection.members[0].requiredAssertions=[];delete f.selection.members[0].assertionPaths;f.selection.members[0].minAssertions=1;expect(checked(f).verdict).toBe('unverified');
 });
 it('keeps selected component order and derives all literal modifier loop cases',()=>{
  const f=actual(['terminal-copy-paste-chords','plugin-terminal-features']);expect(checked(f).verdict).toBe('verified');expect(f.selection.members[1].requiredAssertions.filter(n=>n.includes('software-keyboard character encoding'))).toHaveLength(4);f.raw.summaries.reverse();expect(checked(f).verdict).toBe('unverified');
 });
 it('keeps branch alternatives, and refuses unknown callbacks, loops and dynamic names',()=>{
  const file=path.join(out,'branches.mjs');
  const plan=text=>{fs.writeFileSync(file,text);return scenarioPlan(out,[file]);};
  const selection=plan("export default ({rec,flag})=>{rec.check('setup',true);if(flag){rec.check('a',true)}else{rec.check('b',true)}rec.check('end',true)}");
  expect(selection.complete).toBe(true);expect(selection.members[0].assertionPaths).toEqual([['setup','a','end'],['setup','b','end']]);
  for(const code of ["items.forEach(x=>rec.check('nested',true))","for(const x of items) rec.check(x,true)","rec.check(dynamic,true)"]){const p=plan(`export default ({rec,items,dynamic})=>{rec.check('setup',true);${code}}`);expect(p.complete).toBe(false);}
 });
 it('keeps explicit source-derived audit setup and visual-only modes',()=>{
  const dir=path.join(out,'audit-source');fs.mkdirSync(path.join(dir,'scripts/ui-audit'),{recursive:true});fs.writeFileSync(path.join(dir,'scripts/ui-audit/audit.mjs'),"const flows=[{id:'setup',run(r){r.note('ready')}},{id:'picture',needsEyes:true,run(r){r.shot(page,'view')}}];");
  const selection=auditPlan(dir,['setup','picture']);expect(selection.complete).toBe(true);
  const raw={cleanup,steps:[{id:'setup',assertions:[]},{id:'picture',assertions:[],shots:['view.png']}],summary:{total:2,assertions:0,failedAssertions:0,errored:0,eyes:0}};
  expect(inspectResults('audit',raw,{selection,requireProvenance:false}).verdict).toBe('unverified');expect(inspectResults('audit',raw,{selection,requireProvenance:false,approvedVisuals:['picture']}).verdict).toBe('verified');
 });
});
describe('source and recorder visual requirements',()=>{
 it('retains the five actual geometry EYES even when raw visual markers disappear',()=>{
  const f=actual(['plugin-terminal-geometry']);expect(f.selection.complete).toBe(true);expect(f.selection.members[0].requiredVisuals).toHaveLength(5);expect(checked(f).visuals).toHaveLength(5);expect(checked(f).verdict).toBe('unverified');
 });
 it('freezes audit source needsEyes and its executable pane aggregate',()=>{
  const selection=auditPlan(root,['workspace-switch','renderer-console']);expect(selection.complete).toBe(true);expect(selection.members[0].requiredAssertions).toContain('every eligible revealed terminal paints its own screen');
  const raw={cleanup,steps:selection.members.map(m=>({id:m.id,assertions:m.requiredAssertions.map(name=>({name,ok:true})),shots:['reviewed.png']})),summary:{total:2,assertions:selection.members.reduce((n,m)=>n+m.requiredAssertions.length,0),failedAssertions:0,errored:0,eyes:0}};
  const opts={selection,requireProvenance:false};expect(inspectResults('audit',raw,opts).visuals).toEqual(['workspace-switch']);expect(inspectResults('audit',raw,{...opts,approvedVisuals:['workspace-switch']}).verdict).toBe('verified');
 });
 it.each(['hidden','onscreen'])('records legacy EYES and screenshot hashes at %s placement',async placement=>{
  const rec=recorder({name:'geometry',outDir:out,placement});await rec.shot({screenshot:async file=>fs.writeFileSync(file,placement==='hidden'?blank:png)},'view');rec.note('EYES - inspect the screenshot above');rec.check('geometry is present',true);const s=rec.summary();expect(s.visuals[0].id).toBe('geometry:shot:view');expect(s.screenshots[0].sha256).toMatch(/^[a-f0-9]{64}$/);expect(s.screenshots[0].blank).toBe(placement==='hidden');
  const selection={kind:'scenario',complete:true,ordered:true,members:[{id:'geometry',mode:'assert',minAssertions:1,requiredAssertions:['geometry is present'],requiredVisuals:['geometry:shot:view']}]};
  expect(inspectResults('scenario',{cleanup,summaries:[s]},{selection,requireProvenance:false,approvedVisuals:['geometry:shot:view']}).verdict).toBe(placement==='hidden'?'unverified':'verified');
 });
 it('keeps malformed visual and member rows unverified instead of throwing',()=>{
  const f=actual(['plugin-terminal-geometry']);f.raw.summaries.push(null);f.raw.summaries[0].visuals=[null];expect(()=>checked(f)).not.toThrow();expect(checked(f).verdict).toBe('unverified');
 });
 it('rejects uniform, missing and unsupported image bytes',()=>{
  const good=path.join(out,'visible.png'),bad=path.join(out,'blank.png');fs.writeFileSync(good,png);fs.writeFileSync(bad,blank);expect(reviewablePng(good)).toBe(true);expect(reviewablePng(bad)).toBe(false);expect(reviewablePng(path.join(out,'missing.png'))).toBe(false);fs.writeFileSync(bad,'not an image');expect(reviewablePng(bad)).toBe(false);
 });
});
