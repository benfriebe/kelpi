#!/usr/bin/env node
// Independent recorder safety fixture. Node builtins only; imports actual supplied repository.
// Required: KELPI_REGRESSION_ROOT (exact clean Git root), KELPI_REGRESSION_REPORT
// (fresh absolute JSON path outside source, with existing parent). Exit 0/1/2 = pass/fail/error.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const hash = value => createHash('sha256').update(value).digest('hex');
const guard = (ok, message) => { if (!ok) throw new Error(message); };
const assertions = [], errors = [], controls = [], observations = [], artifacts = [];
const cleanup = { attempted: false, completed: false, errors: [], leaks: [], privateRenderers: [] };
const contexts = [], sessions = [], pages = [];
const startedAt = new Date().toISOString();
const fixturePath = fileURLToPath(import.meta.url), fixtureHash = hash(fs.readFileSync(fixturePath));
let root, output, artifactDir, outputFD, before, after, sourceFiles = {}, arm, makeRecorder;
const key = '__kelpiIncidentRecorder';
const allowed = ['SYNTHETIC_SELECTION'];
const unallowed = 'SYNTHETIC_NOT_ALLOWLISTED_PAYLOAD';
function git(...args) { return execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8' }); }
function identity() { return { head: git('rev-parse', 'HEAD').trim(), dirtyFiles: git('status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean) }; }
function outside(parent, child) { const r = path.relative(parent, child); return r.startsWith('..' + path.sep) || path.isAbsolute(r); }
function error(phase, e) { errors.push({ kind: 'infrastructure/config/import/control', phase, message: String(e.stack ?? e) }); }
function check(name, ok, detail) { assertions.push({ name, ok: ok === true, detail: JSON.parse(JSON.stringify(detail)) }); }
function save(rel, data) { const p = path.join(artifactDir, rel); fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); return p; }
function sourceInventory() {
 const result = {};
 // Bind all tracked scripts, including the complete local import graph, without changing any source.
 for (const rel of git('ls-files', '-z', '--', 'scripts').split('\0').filter(Boolean)) {
  const p = path.join(root, rel); if (fs.statSync(p).isFile()) result[rel] = hash(fs.readFileSync(p));
 }
 return result;
}
function renderer(label, { failAdd, observerError = false } = {}) {
 const listeners = new Map(), addAttempts = [], removeAttempts = [], undoAttempts = [];
 let selection = '', ctx, injected = false, undoInjected = false, failUndo = false;
 const originalPromise = Promise.resolve(allowed[0]), originalThrown = new Error('synthetic original operation error');
 const calls = { read: 0, write: 0, terminalWrite: 0 };
 const terminalTarget = {
  write() { calls.terminalWrite++; throw originalThrown; }, reset() { selection = ''; }, clear() { selection = ''; }, resize() {},
  select() { selection = allowed[0]; }, clearSelection() { selection = ''; }, getSelection() { return selection; }
 };
 const terminal = new Proxy(terminalTarget, { defineProperty(object, name, descriptor) {
  if (failUndo) { undoAttempts.push(String(name)); if (name === 'getSelection' && !undoInjected) { undoInjected = true; throw new Error('SYNTHETIC_UNDO_FAILURE'); } }
  return Reflect.defineProperty(object, name, descriptor);
 }});
 const clipboard = {
  readText() { calls.read++; return originalPromise; },
  writeText() { calls.write++; throw originalThrown; }
 };
 const originals = { terminal: Object.fromEntries(Object.keys(terminalTarget).map(n => [n, terminalTarget[n]])), clipboard: { ...clipboard } };
 const document = {
  activeElement: { tagName: 'TEXTAREA', getAttribute: () => null }, visibilityState: 'visible', body: { dataset: {} },
  hasFocus() { if (observerError) throw new Error('SYNTHETIC_OBSERVER_FAILURE'); return true; }, querySelectorAll: () => [],
  addEventListener(type, fn) { addAttempts.push(type); if (type === failAdd) { injected = true; throw new Error('SYNTHETIC_ADD_FAILURE'); } if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
  removeEventListener(type, fn) { removeAttempts.push(type); listeners.get(type)?.delete(fn); if (!listeners.get(type)?.size) listeners.delete(type); }
 };
 ctx = vm.createContext({ document, navigator: { clipboard }, terminalLab: { terminal }, performance });
 vm.runInContext('globalThis.top = globalThis', ctx);
 const h = {
  label, listeners, terminal, clipboard, originals, calls, originalPromise, originalThrown, addAttempts, removeAttempts, undoAttempts,
  eval: async source => { guard(ctx, 'private renderer already released'); return vm.runInContext(source, ctx, { timeout: 3000 }); },
  emit(type) { for (const fn of listeners.get(type) ?? []) fn({ type, isTrusted: true, code: 'KeyC', clipboardData: { getData: () => unallowed } }); },
  count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  acquired: () => injected, undoInjected: () => undoInjected, injectUndo: () => { failUndo = true; },
  originalMethods: (except = []) => Object.entries(originals.terminal).every(([n, fn]) => except.includes(n) || terminal[n] === fn) && Object.entries(originals.clipboard).every(([n, fn]) => clipboard[n] === fn),
  async release() {
   const residualListeners = h.count();
   failUndo = false;
   // Independent test teardown: recover private objects even when product cleanup is defective.
   for (const [type, fns] of [...listeners]) for (const fn of [...fns]) document.removeEventListener(type, fn);
   for (const [name, fn] of Object.entries(originals.terminal)) Object.defineProperty(terminal, name, { value: fn, writable: true, configurable: true, enumerable: true });
   Object.assign(clipboard, originals.clipboard);
   if (ctx) vm.runInContext(`delete globalThis[${JSON.stringify(key)}]`, ctx);
   guard(h.count() === 0 && h.originalMethods(), 'private renderer teardown did not restore fixture-owned boundaries');
   ctx = null;
   cleanup.privateRenderers.push({ label, residualListenersBeforeFixtureTeardown: residualListeners, listenersAfter: h.count(), originalMethodsRestored: true, recorderHandleDeleted: true, contextReferenceReleased: true });
  }
 };
 contexts.push(h); return h;
}
function pageFor(initial) {
 let host = initial, sequence = 0;
 const scripts = new Map(), commands = [];
 const page = { eval: source => host.eval(source), async send(method, args) {
  commands.push({ method, ...(args?.identifier ? { identifier: args.identifier } : {}) });
  if (method === 'Page.enable') return {};
  if (method === 'Page.addScriptToEvaluateOnNewDocument') { guard(typeof args?.source === 'string', 'missing navigation injection source'); const identifier = `private-script-${++sequence}`; scripts.set(identifier, args.source); return { identifier }; }
  if (method === 'Page.removeScriptToEvaluateOnNewDocument') { guard(scripts.delete(args.identifier), 'unexpected navigation script removal'); return {}; }
  throw new Error('unsupported private CDP command: ' + method);
 }};
 const p = { page, scripts, commands, async navigate(next) { host = next; guard(scripts.size > 0, 'no automatic navigation script installed'); for (const script of scripts.values()) await next.eval(script); } };
 pages.push(p); return p;
}
function record(name) { const r = makeRecorder({ name, outDir: path.join(artifactDir, name) }); guard(typeof r.onFirstFailure === 'function' && typeof r.flushFirstFailure === 'function', 'recorder API missing'); return r; }
async function start(p, r) { const s = await arm({ page: p.page, rec: r, allowed, capacity: 128 }); guard(s && ['close', 'freeze', 'ensureHost'].every(n => typeof s[n] === 'function'), 'diagnostics session API missing'); sessions.push(s); return s; }
function evidence(r) {
 const file = path.join(r.outDir, `${r.name}-first-incident.json`), e = JSON.parse(fs.readFileSync(file, 'utf8'));
 guard(typeof e.complete === 'boolean' && Array.isArray(e.renderers), 'incident evidence contract missing'); return e;
}
const kinds = e => e.renderers.flatMap(r => (r.events ?? []).map(event => event.kind));
async function test(name, fn) { try { await fn(); } catch (e) { error(name, e); } }
try {
 guard(typeof process.env.KELPI_REGRESSION_ROOT === 'string' && process.env.KELPI_REGRESSION_ROOT.length > 0, 'KELPI_REGRESSION_ROOT is required');
 guard(typeof process.env.KELPI_REGRESSION_REPORT === 'string' && path.isAbsolute(process.env.KELPI_REGRESSION_REPORT), 'fresh absolute KELPI_REGRESSION_REPORT is required');
 root = fs.realpathSync(process.env.KELPI_REGRESSION_ROOT);
 guard(fs.realpathSync(git('rev-parse', '--show-toplevel').trim()) === root, 'supply the actual repository root');
 const requested = process.env.KELPI_REGRESSION_REPORT;
 output = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
 guard(outside(root, output), 'output must resolve outside the source repository');
 artifactDir = output + '.artifacts';
 guard(!fs.existsSync(output) && !fs.existsSync(artifactDir), 'refusing to overwrite report or sibling evidence directory');
 outputFD = fs.openSync(output, 'wx'); fs.mkdirSync(artifactDir);
 before = identity(); guard(before.dirtyFiles.length === 0, 'requires a clean source checkout');
 sourceFiles = sourceInventory();
 fs.writeFileSync(path.join(artifactDir, 'fixture.mjs'), fs.readFileSync(fixturePath), { flag: 'wx', mode: 0o444 });
 save('source-before.json', { root, ...before, files: sourceFiles });
 ({ armIncidentDiagnostics: arm } = await import(pathToFileURL(path.join(root, 'scripts/ui-audit/lib/incident-diagnostics.mjs')).href));
 ({ recorder: makeRecorder } = await import(pathToFileURL(path.join(root, 'scripts/ui-audit/lib/driver.mjs')).href));
 guard(typeof arm === 'function' && typeof makeRecorder === 'function', 'required module export missing');
 await test('healthy-controls', async () => {
  const h = renderer('healthy'), p = pageFor(h), r = record('healthy'), s = await start(p, r);
  guard(h.count() > 0 && !h.originalMethods(), 'healthy arm did not acquire listeners and wrappers');
  h.terminal.select(0, 0, 19); guard(h.terminal.getSelection() === allowed[0], 'original synchronous return changed'); h.emit('copy');
  guard(h.clipboard.readText() === h.originalPromise, 'original clipboard promise identity changed'); await h.originalPromise;
  let thrown; try { h.clipboard.writeText(unallowed); } catch (e) { thrown = e; } guard(thrown === h.originalThrown && h.calls.write === 1 && h.calls.read === 1, 'original thrown identity or call count changed');
  await s.freeze('healthy-control'); const first = evidence(r), firstBytes = fs.readFileSync(path.join(r.outDir, 'healthy-first-incident.json'));
  guard(first.complete && ['armed', 'select:call', 'getSelection:call', 'copy', 'readText:resolved', 'writeText:threw'].every(k => kinds(first).includes(k)), 'healthy real arm/event/freeze capture failed');
  guard(!JSON.stringify(first).includes(unallowed), 'nonallowlisted synthetic text was not redacted');
  h.emit('paste'); const frozen = await h.eval(`globalThis.${key}.snapshot()`); guard(!frozen.events.some(e => e.kind === 'paste'), 'freeze did not stop event recording');
  await s.close(); guard(h.count() === 0 && h.originalMethods() && !(await h.eval(`Boolean(globalThis.${key})`)) && p.scripts.size === 0, 'healthy restore did not release ownership');
  guard(firstBytes.equals(fs.readFileSync(path.join(r.outDir, 'healthy-first-incident.json'))), 'close rewrote frozen evidence');
  controls.push({ name: 'normal-arm-event-freeze-restore', ok: true, promiseIdentity: true, thrownIdentity: true, originalCalls: h.calls, frozenFileUnchanged: true, redaction: true });
  const observer = renderer('observer', { observerError: true }), op = pageFor(observer), or = record('observer'), osession = await start(op, or);
  guard(observer.clipboard.readText() === observer.originalPromise, 'observer error changed promise identity'); await observer.originalPromise;
  let observedThrow; try { observer.clipboard.writeText(unallowed); } catch (e) { observedThrow = e; }
  guard(observedThrow === observer.originalThrown && observer.calls.read === 1 && observer.calls.write === 1, 'observer error changed original operation semantics');
  await osession.freeze('observer-control'); const oe = evidence(or); guard(!oe.complete && kinds(oe).includes('readText:resolved') && kinds(oe).includes('writeText:threw'), 'observer failure not retained as incomplete capture');
  await osession.close(); guard(observer.count() === 0 && observer.originalMethods() && op.scripts.size === 0, 'observer control cleanup failed');
  controls.push({ name: 'observer-failure-preserves-return-promise-throw', ok: true, complete: oe.complete, calls: observer.calls });
 });
 guard(controls.length === 2, 'healthy controls failed; regression assertions not evaluated');
 await test('rejected-second-arm-preserves-first-owner', async () => {
  const h = renderer('owner'), p = pageFor(h), a = record('owner-first'), b = record('owner-second'), first = await start(p, a);
  const owned = await h.eval(`globalThis.${key}`), count = h.count(); h.emit('copy');
  let rejected; try { await start(p, b); } catch (e) { rejected = e; }
  guard(rejected && /already armed/i.test(String(rejected.message)), 'second arm did not specifically reject duplicate ownership');
  const sameOwner = (await h.eval(`globalThis.${key}`)) === owned, listenerCount = h.count(); h.emit('paste');
  await first.freeze('owner-control-after-rejection'); const e = evidence(a);
  check('rejected-second-arm-preserves-first-owner', sameOwner && listenerCount === count && e.complete === true && kinds(e).includes('copy') && kinds(e).includes('paste'), { sameOwner, listenerCount, originalListenerCount: count, complete: e.complete, retainedKinds: kinds(e) });
  await first.close();
 });
 await test('partial-listener-install-removes-owned-listeners', async () => {
  const h = renderer('partial', { failAdd: 'copy' }), p = pageFor(h), r = record('partial');
  let rejected; try { await start(p, r); } catch (e) { rejected = e; }
  guard(h.acquired() && rejected && /SYNTHETIC_ADD_FAILURE/.test(String(rejected.message)), 'partial listener fault not reached or replaced by unrelated failure');
  guard(h.addAttempts.indexOf('copy') > 0, 'partial-install fault preceded all acquisitions');
  const remaining = [...h.listeners.keys()];
  check('partial-listener-install-removes-owned-listeners', h.count() === 0 && h.originalMethods() && !(await h.eval(`Boolean(globalThis.${key})`)), { remainingListeners: remaining, addAttempts: h.addAttempts, removeAttempts: h.removeAttempts });
 });
 await test('restore-exception-attempts-all-remaining-undo', async () => {
  const h = renderer('restore'), p = pageFor(h), r = record('restore'), s = await start(p, r);
  const installedTypes = [...h.listeners.keys()]; guard(installedTypes.length > 0, 'restore fault had no acquired listeners'); h.injectUndo();
  await s.close(); guard(h.undoInjected(), 'injected property restore failure was not reached');
  const handlePresent = await h.eval(`Boolean(globalThis.${key})`), remaining = [...h.listeners.keys()];
  check('restore-exception-attempts-all-remaining-undo', h.count() === 0 && installedTypes.every(t => h.removeAttempts.includes(t)) && h.originalMethods(['getSelection']) && !handlePresent && p.scripts.size === 0, { remainingListeners: remaining, handlePresent, removeAttempts: h.removeAttempts, propertyUndoAttempts: h.undoAttempts, otherMethodsRestored: h.originalMethods(['getSelection']), failedProperty: 'getSelection' });
 });
 await test('automatic-navigation-retains-history-or-marks-incomplete', async () => {
  const previous = renderer('navigation-before'), p = pageFor(previous), r = record('navigation'), s = await start(p, r);
  previous.emit('copy'); const current = renderer('navigation-after'); await p.navigate(current);
  guard(current.count() > 0, 'actual automatic navigation injection did not install recorder');
  await s.ensureHost(); current.emit('paste'); r.check('synthetic failure after automatic navigation', false); await r.flushFirstFailure(); await s.close();
  const e = evidence(r), historyRetained = kinds(e).includes('copy'), incomplete = e.complete === false;
  check('automatic-navigation-retains-history-or-marks-incomplete', historyRetained || incomplete, { complete: e.complete, historyRetained, retainedKinds: kinds(e), rendererNames: e.renderers.map(x => x.name) });
  observations.push({ name: 'navigation', recorderSummary: r.summary() });
 });
} catch (e) { error('setup-or-controls', e); }
finally {
 cleanup.attempted = true;
 for (const s of sessions) try { await s.close(); } catch (e) { cleanup.errors.push(String(e.stack ?? e)); }
 for (const h of contexts) try { await h.release(); } catch (e) { cleanup.errors.push(String(e.stack ?? e)); }
 for (const p of pages) { const residual = [...p.scripts.keys()]; for (const identifier of residual) try { await p.page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); } catch (e) { cleanup.errors.push(String(e.stack ?? e)); } if (p.scripts.size) cleanup.leaks.push('private navigation script'); }
 contexts.length = 0; sessions.length = 0; pages.length = 0;
 cleanup.completed = cleanup.errors.length === 0 && cleanup.leaks.length === 0;
 if (!cleanup.completed) error('fixture-teardown', new Error('private fixture cleanup failed'));
 if (root && before) try {
  after = identity(); const afterFiles = sourceInventory();
  guard(JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(sourceFiles) === JSON.stringify(afterFiles), 'source identity changed during execution');
  guard(hash(fs.readFileSync(fixturePath)) === fixtureHash, 'fixture changed during execution');
  if (artifactDir) save('source-after.json', { root, ...after, files: afterFiles });
 } catch (e) { error('identity-after', e); }
}
if (!errors.length && assertions.length !== 4) error('assertion-coverage', new Error('required four behavioral assertions were not all evaluated'));
function inventory(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) inventory(p); else artifacts.push({ path: p, sha256: hash(fs.readFileSync(p)), bytes: fs.statSync(p).size }); } }
try { if (outputFD !== undefined) inventory(artifactDir); } catch (e) { error('artifact-inventory', e); }
const report = {
 schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), assertions, errors, controls, observations,
 environment: { id: `${os.hostname()}:${process.platform}:${process.arch}:${process.version}`, kind: 'local', details: 'Node process imports supplied actual repository modules; renderer globals and CDP commands use private VM boundary stubs, synthetic terminal/clipboard only; no Electron, installed application, OS clipboard, daemon, network, peer or physical device exercised.' },
 cleanup, fixture: { path: fixturePath, sha256: fixtureHash }, source: { root, before, after, files: sourceFiles }, artifacts,
 limitations: ['Recorder-safety regressions D4-D6 only; not original Copy/paste product incident proof.', 'Injected listener acquisition and one property restoration failure are bounded fault models.', 'VM navigation replaces a private document and runs actual registered injection; browser lifecycle timing is not simulated.', 'Fixture teardown independently releases baseline residual listeners/wrappers; behavioral assertions retain pre-teardown failures.', 'No desktop or physical environment coverage; candidate before/after comparison belongs to coordinator.']
};
const exitCode = errors.length ? 2 : assertions.some(a => !a.ok) ? 1 : 0;
if (outputFD !== undefined) { try { fs.writeFileSync(outputFD, JSON.stringify(report, null, 2) + '\n'); fs.closeSync(outputFD); } catch (e) { console.error(e); process.exitCode = 2; } }
else console.error(JSON.stringify({ errors, reportWritten: false }));
console.log(JSON.stringify({ reportPath: outputFD === undefined ? null : output, fixtureHash, assertions: assertions.map(({ name, ok }) => ({ name, ok })), errors, exitCode }));
process.exitCode ??= exitCode;
