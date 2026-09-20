import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Portable across clean baseline/candidate checkouts. The fixture only replaces the private
// instance and slot; it executes the selected checkout's real runner and recorder unchanged.
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
for(let i=0;i<args.length;i+=2) if(!['--root','--out'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('usage: cleanup-regression.mjs [--root checkout] --out report.json');
const root=fs.realpathSync(option('--root') ?? process.env.KELPI_REGRESSION_ROOT ?? fileURLToPath(new URL('../../../',import.meta.url)));
const output=option('--out') ?? process.env.KELPI_REGRESSION_REPORT;
if(!output) throw new Error('a fresh --out report.json or KELPI_REGRESSION_REPORT is required');
const reportPath=path.resolve(output);
if(!reportPath.endsWith('.json')) throw new Error('fixture output must be a .json report');
for(const file of ['scripts/scenario.mjs','scripts/ui-audit/lib/driver.mjs','scripts/ui-audit/lib/desktop-lifecycle.mjs']) if(!fs.statSync(path.join(root,file)).isFile()) throw new Error(`invalid fixture checkout: ${file}`);
const temp=path.join(path.dirname(reportPath),'cleanup-fixture-'+path.basename(reportPath,'.json'));
if(fs.existsSync(reportPath) || fs.existsSync(temp)) throw new Error('refusing to overwrite retained cleanup fixture evidence');
fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const assertions=[], errors=[], cleanup={attempted:false,completed:false,errors:[],leaks:[]};
const sha=b=>createHash('sha256').update(b).digest('hex');
const sources=['scripts/scenario.mjs','scripts/ui-audit/lib/driver.mjs','scripts/ui-audit/lib/desktop-lifecycle.mjs'];
const result={schemaVersion:1,assertions,errors,cleanup,environment:{id:'private-node-cleanup-fixture',kind:'local',details:'Actual scenario runner and recorder with only desktop instance and desktop slot replaced by owned Node fixtures; no Electron, OS clipboard, peer or device.'},sources:sources.map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))}))};
try {
  fs.mkdirSync(temp);
  const driver=path.join(temp,'driver.mjs'),slot=path.join(temp,'slot.mjs'),hook=path.join(temp,'hook.mjs');
  fs.writeFileSync(slot,'export const DESKTOP_TEST_PORT=19735; export async function holdDesktopTestSlot(){return {release:async()=>{}};}');
  fs.writeFileSync(driver,`
    export {recorder,WINDOW_PLACEMENTS} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/ui-audit/lib/driver.mjs')).href+'?fixture-real')};
    export async function boot({window}) {
      const page={fixtureLeak:false,eval:async()=>JSON.stringify({phonePlace:null,phoneLanding:null,workbench:page.fixtureLeak?{'terminal @ private-fixture':'example.synthetic'}:{},settingsOpen:false,overlays:[],hasFocus:true,viewport:'800x600',url:'http://fixture'})};
      return {page,sandbox:{base:'private-fixture'},debugPort:1,harness:{path:'private-fixture'},windowPlacement:window,rendererErrors:{finish(){}},stop:async()=>{}};
    }
  `);
  fs.writeFileSync(hook,`
    import {registerHooks} from 'node:module';
    registerHooks({resolve(s,c,next){
      if(s.endsWith('/desktop-slot.mjs'))return {url:${JSON.stringify(pathToFileURL(slot).href)},shortCircuit:true};
      if(s===${JSON.stringify(path.join(root,'scripts/ui-audit/lib/driver.mjs'))})return {url:${JSON.stringify(pathToFileURL(driver).href)},shortCircuit:true};
      return next(s,c);
    }});
  `);
  const attempts=[];
  for(const leak of [false,true]) {
    const name=leak?'leaking':'healthy',first=path.join(temp,name+'.mjs'),next=path.join(temp,name+'-next.mjs'),out=path.join(temp,name+'-output');
    fs.writeFileSync(first,`export default async({page,rec})=>{page.fixtureLeak=${leak};rec.check('fixture body executed',true);};`);
    fs.writeFileSync(next,`export default async({rec})=>{rec.check('following fixture executed',true);};`);
    const run=spawnSync(process.execPath,['--import',hook,path.join(root,'scripts/scenario.mjs'),'--no-build','--window','hidden','--out',out,first,next],{cwd:root,encoding:'utf8',timeout:20000});
    fs.writeFileSync(path.join(temp,name+'-stdout.txt'),run.stdout??'');fs.writeFileSync(path.join(temp,name+'-stderr.txt'),run.stderr??'');
    if(run.error||run.signal)throw new Error('fixture process failed: '+(run.error?.message??run.signal));
    const raw=JSON.parse(fs.readFileSync(path.join(out,'results.json'),'utf8'));
    if(raw.harnessFailure||raw.summaries.length!==2||raw.summaries.some(s=>s.error))throw new Error('scenario fixture did not execute normally');
    const bodies=raw.summaries.flatMap(s=>s.results).filter(a=>a.label==='fixture body executed'||a.label==='following fixture executed');
    if(bodies.length!==2||bodies.some(a=>a.ok!==true))throw new Error('fixture body missing or failed');
    attempts.push({name,exitStatus:run.status,resultPath:path.join(out,'results.json'),raw});
  }
  const [healthy,leaking]=attempts;
  if(healthy.exitStatus!==0||healthy.raw.leaks.length)throw new Error('healthy control refused; not evidence of cleanup regression');
  if(leaking.raw.leaks.length!==1)throw new Error('expected one observed leak; fixture is not exercising the incident');
  assertions.push({name:'healthy shared fixture remains accepted',ok:true});
  const failures=leaking.raw.summaries.flatMap(s=>s.results).filter(a=>a.ok===false);
  assertions.push({name:'observed shared fixture leak blocks scenario acceptance',ok:leaking.exitStatus===1&&failures.some(a=>a.failureClass==='cleanup'),detail:{observedLeaks:leaking.raw.leaks.length,exitStatus:leaking.exitStatus,failedChecks:failures.length}});
  result.attempts=attempts.map(({raw,...a})=>({...a,checks:raw.summaries.reduce((n,s)=>n+s.results.length,0),failedChecks:raw.summaries.reduce((n,s)=>n+s.results.filter(a=>a.ok===false).length,0),observedLeaks:raw.leaks.length,sha256:sha(fs.readFileSync(a.resultPath))}));
}catch(error){errors.push(String(error?.stack??error));}
finally{cleanup.attempted=true;cleanup.completed=true;}
fs.writeFileSync(reportPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
process.exitCode=errors.length?2:assertions.some(a=>!a.ok)?1:0;
