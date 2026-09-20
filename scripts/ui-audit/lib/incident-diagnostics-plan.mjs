/** Read-only selection discovery. Parsing never imports a scenario or starts a desktop. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertionIdentities } from './acceptance-selection.mjs';
import { declarationReader } from './assertion-declarations.mjs';
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite/package.json', {paths:[path.resolve(import.meta.dirname, '../../../packages/client')]}));
const { parse } = viteRequire('acorn');
const ast = file => parse(fs.readFileSync(file, 'utf8'), {ecmaVersion:'latest',sourceType:'module',allowAwaitOutsideFunction:true});
const children = node => Object.values(node ?? {}).flatMap(value => Array.isArray(value) ? value : [value]).filter(value => value && typeof value.type === 'string');
function walk(node, visit) { if (!node) return; visit(node); for (const child of children(node)) walk(child, visit); }
const method = (node, name) => node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === name;
function literal(node, bindings={}) {
    if(node?.type==='Literal')return node.value;
    if(node?.type==='ArrayExpression') {const values=node.elements.map(item=>literal(item,bindings));return values.some(value=>value===undefined) ? undefined : values;}
    if(node?.type==='Identifier')return bindings[node.name];
    if(node?.type==='TemplateLiteral') {
        const values=node.expressions.map(item=>literal(item,bindings));
        if(values.some(value=>value===undefined))return undefined;
        return node.quasis.map((part,index)=>part.value.cooked+(index<values.length?values[index]:'')).join('');
    }
}
// Successful contracts follow normal completion. Guarded early exits and throw paths
// cannot certify a completed scenario; returns in callbacks belong to that callback.
// Bounded literal loops are expanded. Dynamic assertion producers fail closed.
const functionNode = node => /Function/.test(node?.type ?? '');
const key = node => JSON.stringify(node, (name, value) => ['start', 'end', 'loc'].includes(name) ? undefined : value);
const eyeText = node => typeof literal(node) === 'string' ? /^EYES\b/.test(literal(node)) : node?.type === 'TemplateLiteral' && /^EYES\b/.test(node.quasis[0]?.value.cooked ?? '');
const namesInPattern = (node, names = new Set()) => {
    if (!node) return names;
    if (node.type === 'Identifier') names.add(node.name);
    else if (node.type === 'RestElement' || node.type === 'AssignmentPattern') namesInPattern(node.argument ?? node.left, names);
    else if (node.type === 'ArrayPattern') for (const item of node.elements) namesInPattern(item, names);
    else if (node.type === 'ObjectPattern') for (const item of node.properties) namesInPattern(item.value ?? item.argument, names);
    return names;
};
// An import proves identity only until a binding in the analysed function shadows it.  Be
// conservative for nested blocks: rejecting an ambiguous helper is preferable to accepting a
// local look-alike as the cleanup primitive whose callbacks certify the gate.
const shadowedCleanupAliases = (body, aliases, parameters = []) => {
    const shadowed = new Set();
    for (const parameter of parameters) for (const name of namesInPattern(parameter)) if (aliases.has(name)) shadowed.add(name);
    const visit = node => {
        if (!node) return;
        if (node.type === 'VariableDeclarator') for (const name of namesInPattern(node.id)) if (aliases.has(name)) shadowed.add(name);
        if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && aliases.has(node.id?.name)) shadowed.add(node.id.name);
        if (node.type === 'CatchClause') for (const name of namesInPattern(node.param)) if (aliases.has(name)) shadowed.add(name);
        // A declaration itself binds in this lexical scope; its body is a different scope.
        if (node !== body && functionNode(node)) return;
        for (const child of children(node)) visit(child);
    };
    visit(body);
    return shadowed;
};
const fixtureCleanupReceipt = (node, expected) => {
    if (!method(node, 'check') || node.arguments.length < 2) return false;
    // A direct cleanup success check normally has a dynamic predicate (for example, a post-close
    // roster comparison). It is still a receipt: the recorder will retain either outcome. Failure
    // reporters, conversely, must unambiguously record false.
    if (expected === false ? literal(node.arguments[1]) !== false : literal(node.arguments[1]) === false) return false;
    const label = literal(node.arguments[0]);
    return typeof label === 'string'
        ? label.startsWith('fixture cleanup:')
        : node.arguments[0]?.type === 'TemplateLiteral' && node.arguments[0].quasis[0]?.value.cooked.startsWith('fixture cleanup:');
};
// A receipt nested in a conditional or a second, uncalled function is not proven to execute when
// cleanupSteps catches a failing step.  Only a direct callback-body check is certification.
const directFixtureCleanupReceipt = (node, expected) => {
    // cleanupSteps awaits each step but invokes its failure reporter synchronously.
    // An async reporter can finish after the helper, losing the only failed receipt.
    if (!functionNode(node) || node.generator === true || (expected === false && node.async === true)) return false;
    const direct = statement => {
        const expression = statement?.type === 'ExpressionStatement' ? statement.expression : statement;
        const unwrapped = expression?.type === 'AwaitExpression' ? expression.argument : expression;
        return fixtureCleanupReceipt(unwrapped, expected);
    };
    if (node.body?.type !== 'BlockStatement') return direct(node.body);
    // A cleanup step may throw before its success receipt; cleanupSteps catches that branch and
    // invokes the separately verified failure reporter. Its normal branch is still certified by
    // the direct success check, so do not confuse conditional failure handling with a missing
    // success postcondition.
    if (expected !== false) return node.body.body.some(direct);
    for (const statement of node.body.body) {
        if (direct(statement)) return true;
        // Any return path before the receipt can suppress the report for a caught cleanup error.
        // Reject rather than trying to prove arbitrary predicates or nested control flow safe.
        let returns = false;
        walk(statement, child => { if (child.type === 'ReturnStatement' || child.type === 'ThrowStatement') returns = true; });
        if (returns) return false;
    }
    return false;
};
function contract(id, body, bindings={}, kind='scenario', knownCleanupHelpers=new Set(), parameters=[], enclosingShadowed=new Set()) {
    const errors = new Set(), visuals = new Set();
    // An initializer is not the value of a label after a later mutation. Conservative
    // invalidation also covers writes inside callbacks/loops that discovery cannot run.
    const mutableBindings = new Set();
    walk(body, node => {
        if (node.type === 'AssignmentExpression') for (const name of namesInPattern(node.left)) mutableBindings.add(name);
        if (node.type === 'UpdateExpression') for (const name of namesInPattern(node.argument)) mutableBindings.add(name);
    });
    const shadowedHelpers = new Set([...enclosingShadowed, ...shadowedCleanupAliases(body, knownCleanupHelpers, parameters)]);
    const trustedCleanupHelpers = new Set([...knownCleanupHelpers].filter(name => !shadowedHelpers.has(name)));
    const initial = { assertions: [], facts: new Set(), bindings: {...bindings} };
    const copy = state => ({ assertions: [...state.assertions], facts: new Set(state.facts), bindings: {...state.bindings} });
    const unique = states => {
        const result = [...new Map(states.map(s => [JSON.stringify([s.assertions,[...s.facts],s.bindings]),s])).values()];
        if (result.length > 128) { errors.add('successful path limit exceeded'); return result.slice(0,128); }
        return result;
    };
    const hasEvidence = node => { let found=false; walk(node,n=>{ if(method(n,'check') && literal(n.arguments[3]) !== 'cleanup' && literal(n.arguments[1]) !== false || method(n,'eyes') || method(n,'note') && eyeText(n.arguments[0]))found=true; });return found; };
    // Visual identities use the literal preceding shot label, shared with recorder.note.
    let lastShot;
    const discoverVisuals = node => {
        if (!node || functionNode(node)) return;
        if (method(node,'shot')) lastShot = literal(node.arguments[1],bindings);
        if (method(node,'eyes') || method(node,'note') && eyeText(node.arguments[0])) {
            if(kind === 'audit') visuals.add(id);
            else if(typeof lastShot === 'string') visuals.add(`${id}:shot:${lastShot.replace(/[^a-z0-9-]+/gi, '-')}`);
            else errors.add('visual requirement has no statically named screenshot');
        }
        for(const child of children(node)) discoverVisuals(child);
    };
    discoverVisuals(body);
    const cleanupCallName = node => node?.type === 'CallExpression' && node.callee.type === 'Identifier' && knownCleanupHelpers.has(node.callee.name) ? node.callee.name : null;
    const knownCleanupCall = node => trustedCleanupHelpers.has(cleanupCallName(node));
    const expression = (node, states, context = {}) => {
        if (!node) return states;
        // Only the exact helper imported from incident-diagnostics is cleanup machinery.
        // Its statically named callbacks stay in the contract so their successful cleanup
        // checks are required in the result; its failure reporter is separately required to
        // emit a failing `fixture cleanup:` receipt. Arbitrary same-named helpers fail closed.
        if (knownCleanupCall(node)) {
            if (context.awaited !== true) errors.add('known cleanup helper must be awaited');
            const entries = node.arguments[0], reporter = node.arguments[1];
            if (entries?.type !== 'ArrayExpression') errors.add('known cleanup helper requires a static step list');
            else for (const entry of entries.elements) {
                const label = entry?.type === 'ArrayExpression' ? literal(entry.elements[0]) : undefined;
                const callback = entry?.type === 'ArrayExpression' ? entry.elements[1] : undefined;
                if (!functionNode(callback) || callback.generator === true) { errors.add('known cleanup helper requires non-generator static callbacks'); continue; }
                if (typeof label !== 'string') errors.add('known cleanup helper requires static step labels');
                if (!directFixtureCleanupReceipt(callback, true)) errors.add(`known cleanup helper step ${typeof label === 'string' ? label : '(unknown)'} requires a fixture cleanup success receipt`);
                states = statement(callback.body, states);
            }
            if (!directFixtureCleanupReceipt(reporter, false)) errors.add('known cleanup helper requires a fixture cleanup failure receipt');
            return states;
        }
        if (cleanupCallName(node) !== null) {
            errors.add('cleanup helper import is shadowed or lexical identity is unproven');
            return states;
        }
        if (node.type === 'AwaitExpression') return expression(node.argument, states, {...context, awaited:true});
        if (functionNode(node)) {
            // Cleanup callbacks have a separate required runtime cleanup receipt.
            if(hasEvidence(node.body)) errors.add('assertion or visual inside an unresolved callback');
            return states;
        }
        // boot awaits this documented hook before releasing the first document.
        if(method(node,'boot')) {
            const hook=node.arguments[0]?.properties?.find(p=>p.key?.name==='beforeLoad')?.value;
            if(functionNode(hook)) {
                states=statement(hook.body,states);
                for(const child of node.arguments[0].properties.filter(p=>p.value!==hook))states=expression(child,states);
                return states;
            }
        }
        if(method(node,'check')) {
            // Nested producers in a predicate execute before this outer receipt. Their
            // local returns must not end the scenario, but their evidence cannot vanish.
            if (node.arguments.some(argument => hasEvidence(argument))) errors.add('assertion or visual inside an unresolved callback');
            if(literal(node.arguments[1]) === false) return [];
            for(const state of states) {
                const name=literal(node.arguments[0],state.bindings);
                if(typeof name !== 'string') errors.add('dynamic assertion name');
                else state.assertions.push(name);
                state.facts.add(key(node.arguments[1]));
            }
            // Predicates can return locally without ending the surrounding scenario.
            return states;
        }
        if(node.type === 'ConditionalExpression') {
            const tested=expression(node.test,states);
            return unique(tested.flatMap(state=>state.facts.has(key(node.test)) ? expression(node.consequent,[state]) : [...expression(node.consequent,[copy(state)]),...expression(node.alternate,[copy(state)])]));
        }
        if(node.type === 'LogicalExpression') {
            const left=expression(node.left,states);
            if(!hasEvidence(node.right)) return left;
            return unique(left.flatMap(state=>[copy(state),...expression(node.right,[state])]));
        }
        if(node.type === 'VariableDeclarator') {
            for(const state of states) if(node.id.type === 'Identifier' && !mutableBindings.has(node.id.name)) {const value=literal(node.init,state.bindings); if(value!==undefined)state.bindings[node.id.name]=value;}
        }
        for(const child of children(node)) states=expression(child,states);
        return states;
    };
    const statement = (node, states) => {
        if(!node || !states.length) return states;
        if(node.type === 'BlockStatement') { for(const child of node.body) states=statement(child,states); return states; }
        if(node.type === 'FunctionDeclaration') return states;
        if(node.type === 'ReturnStatement' || node.type === 'ThrowStatement') return [];
        if(node.type === 'IfStatement') {
            const tested=expression(node.test,states);
            return unique(tested.flatMap(state=>{
                const known=state.facts.has(key(node.test)) ? true : node.test.type==='UnaryExpression' && node.test.operator==='!' && state.facts.has(key(node.test.argument)) ? false : literal(node.test,state.bindings);
                return known===true ? statement(node.consequent,[state]) : known===false ? statement(node.alternate,[state]) : [...statement(node.consequent,[copy(state)]),...statement(node.alternate,[copy(state)])];
            }));
        }
        if(node.type === 'TryStatement') {
            // A catch that records a failure or rethrows is not a successful alternative.
            const success=statement(node.block,states.map(copy));
            const caught=node.handler ? statement(node.handler.body,states.map(copy)) : [];
            return statement(node.finalizer,unique([...success,...caught]));
        }
        if(node.type === 'ForOfStatement') {
            if(!hasEvidence(node.body)) return states;
            const rows=literal(node.right,states[0]?.bindings);
            const pattern=node.left.declarations?.[0]?.id;
            if(!Array.isArray(rows) || rows.length>128 || !pattern) {errors.add('dynamic assertion loop');return states;}
            for(const row of rows) {
                for(const state of states) {
                    if(pattern.type==='Identifier')state.bindings[pattern.name]=row;
                    else if(pattern.type==='ArrayPattern' && Array.isArray(row)) pattern.elements.forEach((item,i)=>{if(item?.type==='Identifier')state.bindings[item.name]=row[i];else errors.add('unsupported loop binding');});
                    else errors.add('unsupported loop binding');
                }
                states=statement(node.body,states);
            }
            return states;
        }
        if(['ForStatement','ForInStatement','WhileStatement','DoWhileStatement','SwitchStatement'].includes(node.type)) {
            if(hasEvidence(node))errors.add('dynamic assertion control flow');
            return states;
        }
        return expression(node,states);
    };
    const paths=unique(body?.type==='BlockStatement' ? statement(body,[initial]) : expression(body,[initial]));
    const assertionPaths=[...new Map(paths.map(s=>[JSON.stringify(s.assertions),s.assertions])).values()];
    const requiredAssertions=assertionPaths[0]?.filter(name=>assertionPaths.every(p=>p.includes(name))) ?? [];
    const checks=hasEvidence(body) && assertionPaths.some(p=>p.length);
    if(!paths.length || checks && assertionPaths.some(p=>!p.length))errors.add('no complete successful assertion path');
    if(!checks && hasEvidence(body) && !visuals.size)errors.add('assertion contract cannot be derived');
    return {id, mode:checks ? 'assert' : visuals.size ? 'visual' : 'setup', complete:errors.size===0, contractErrors:[...errors], requiredAssertions, assertionPaths, minAssertions:assertionPaths.length ? Math.min(...assertionPaths.map(p=>p.length)) : 0, requiredVisuals:[...visuals]};
}
// The runner reports occurrence-qualified identities.  Preserve every dynamic/parameterised
// probe rather than treating repeated prose as one assertion.
const qualifyContract = selected => {
    const assertionPaths = selected.assertionPaths.map(assertionIdentities);
    return {...selected, assertionPaths, requiredAssertions: selected.assertionPathSegments ? selected.requiredAssertions : assertionPaths[0]?.filter(name => assertionPaths.every(labels => labels.includes(name))) ?? []};
};
// Only an immutable literal export can grant the default-window visual exception.
// Runtime summaries cannot establish this prospective source requirement.
function nativeFocusDeclaration(parsed) {
    const binding = name => {
        for (const item of parsed.body) {
            const node = item.type === 'ExportNamedDeclaration' ? item.declaration : item;
            if (node?.type !== 'VariableDeclaration' || node.kind !== 'const') continue;
            const entry = node.declarations.find(declaration => declaration.id.type === 'Identifier' && declaration.id.name === name);
            if (entry?.init?.type === 'Literal' && typeof entry.init.value === 'boolean') return entry.init.value;
        }
    };
    let present = false, value;
    for (const node of parsed.body) {
        if (node.type === 'ExportAllDeclaration' && (node.exported?.name ?? node.exported?.value) === 'requiresNativeFocus') present = true;
        if (node.type !== 'ExportNamedDeclaration') continue;
        const declaration = node.declaration;
        const declared = declaration?.type === 'VariableDeclaration'
            ? declaration.declarations.some(entry => namesInPattern(entry.id).has('requiresNativeFocus'))
            : declaration?.id?.name === 'requiresNativeFocus';
        if (declared) { present = true; value = binding('requiresNativeFocus'); }
        for (const specifier of node.specifiers) if ((specifier.exported.name ?? specifier.exported.value) === 'requiresNativeFocus') {
            present = true;
            value = node.source ? undefined : binding(specifier.local.name);
        }
    }
    return { value: value === true, error: present && typeof value !== 'boolean' ? 'requiresNativeFocus must be an immutable literal boolean export' : null };
}
export function scenarioPlan(repoRoot, files) {
    const reviewed = declarationReader(repoRoot);
    const plan = {kind:'scenario',complete:true,ordered:true,runtimeRequirements:[...new Set(files.filter(file=>/plugin-terminal-(features|geometry)\.mjs$/.test(file)).map(file=>`terminal-lab:${path.basename(file,'.mjs')}`))],members:files.map(file => {
        const parsed = ast(file), exported = parsed.body.find(node => node.type === 'ExportDefaultDeclaration');
        let fn = exported?.declaration;
        if (fn?.type === 'Identifier') {
            for (const node of parsed.body) {
                if (node.type === 'FunctionDeclaration' && node.id?.name === fn.name) {fn=node;break;}
                const found = node.declarations?.find(item => item.id.name === fn.name); if (found) {fn=found.init;break;}
            }
        }
        if (!fn?.body) throw new Error(`cannot discover scenario contract: ${file}`);
        const focus = nativeFocusDeclaration(parsed), discovered = contract(path.basename(file,'.mjs'),fn.body);
        if (focus.error) { discovered.complete = false; discovered.contractErrors.push(focus.error); }
        const bodyContract = reviewed('scenario', file, discovered);
        // scenario.mjs always calls rendererErrors.finish(rec) after the scenario body.
        // This runner receipt is part of the prospective full path, including setup-only
        // source bodies, and cannot be supplied by a later retry or another scenario.
        const selected = qualifyContract({...bodyContract, minAssertions:bodyContract.minAssertions + 1, assertionPaths:bodyContract.assertionPaths.map(labels => [...labels, 'the renderer threw nothing and logged no error'])});
        return {...selected, complete:selected.complete && selected.mode === 'assert', mode:'assert', requiresNativeFocus:focus.value, minAssertions:Math.max(1,selected.minAssertions), file:path.resolve(file)};
    })};
    plan.complete=plan.members.every(member=>member.complete);
    return plan;
}
export function auditPlan(repoRoot, ids) {
    const file = path.join(repoRoot,'scripts/ui-audit/audit.mjs');
    const reviewed = declarationReader(repoRoot);
    const parsed = ast(file);
    const knownCleanupHelpers = new Set(parsed.body
        .filter(node => node.type === 'ImportDeclaration' && node.source?.value === './lib/incident-diagnostics.mjs')
        .flatMap(node => node.specifiers)
        .filter(specifier => specifier.type === 'ImportSpecifier' && specifier.imported?.name === 'cleanupSteps')
        .map(specifier => specifier.local.name));
    const entries = new Map();
    const collect=(node,bindings={},enclosingShadowed=new Set())=>{
        if(node.type!=='ObjectExpression')return;
        const id=literal(node.properties.find(item=>item.key?.name==='id')?.value,bindings);
        const run=node.properties.find(item=>item.key?.name==='run')?.value;
        if(typeof id==='string' && run?.body) {
            let selected=contract(id,run.body,bindings,'audit',knownCleanupHelpers,run.params,enclosingShadowed);
            const needsEyes=literal(node.properties.find(item=>item.key?.name==='needsEyes')?.value,bindings) === true;
            if(needsEyes || selected.requiredVisuals.length)selected.requiredVisuals=[id];
            if(needsEyes && selected.mode==='setup')selected.mode='visual';
            selected=qualifyContract(reviewed('audit',file,selected));
            if (entries.has(id)) throw new Error(`duplicate audit step identity ${id}`);
            entries.set(id,selected);
        }
    };
    const functionScopeShadows = node => shadowedCleanupAliases(node.body, knownCleanupHelpers, node.params);
    const visit = (node, enclosingShadowed = new Set()) => {
        if (!node) return;
        collect(node, {}, enclosingShadowed);
        if(node.type==='CallExpression' && node.callee.type==='MemberExpression' && node.callee.property.name==='map' && node.callee.object.type==='ArrayExpression') {
            const callback=node.arguments[0];
            if(callback?.params?.length===1 && callback.body.type==='ObjectExpression') {
                for(const value of node.callee.object.elements) collect(callback.body,{[callback.params[0].name]:literal(value)},enclosingShadowed);
            }
        }
        const nextShadowed = functionNode(node)
            ? new Set([...enclosingShadowed, ...functionScopeShadows(node)])
            : enclosingShadowed;
        for (const child of children(node)) visit(child, nextShadowed);
    };
    visit(parsed);
    entries.set('renderer-console',{id:'renderer-console',mode:'assert',complete:true,requiredAssertions:['no renderer console errors/warnings'],assertionPaths:[['no renderer console errors/warnings']],minAssertions:1,requiredVisuals:[]});
    const members=ids.map(id => { if (!entries.has(id)) throw new Error(`unknown audit step ${id}`); return entries.get(id); });
    return {kind:'audit',complete:members.every(member=>member.complete!==false),ordered:true,members};
}
