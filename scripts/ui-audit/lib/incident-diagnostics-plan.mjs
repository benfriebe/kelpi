/** Read-only selection discovery. Parsing never imports a scenario or starts a desktop. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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
function contract(id, body, bindings={}, kind='scenario') {
    const errors = new Set(), visuals = new Set();
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
    const expression = (node, states) => {
        if (!node) return states;
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
            for(const state of states) if(node.id.type === 'Identifier') {const value=literal(node.init,state.bindings); if(value!==undefined)state.bindings[node.id.name]=value;}
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
    const assertionPaths=[...new Map(paths.map(s=>[JSON.stringify([...new Set(s.assertions)]),[...new Set(s.assertions)]])).values()];
    const requiredAssertions=assertionPaths[0]?.filter(name=>assertionPaths.every(p=>p.includes(name))) ?? [];
    const checks=hasEvidence(body) && assertionPaths.some(p=>p.length);
    if(!paths.length || checks && assertionPaths.some(p=>!p.length))errors.add('no complete successful assertion path');
    if(!checks && hasEvidence(body) && !visuals.size)errors.add('assertion contract cannot be derived');
    return {id, mode:checks ? 'assert' : visuals.size ? 'visual' : 'setup', complete:errors.size===0, contractErrors:[...errors], requiredAssertions, assertionPaths, minAssertions:assertionPaths.length ? Math.min(...assertionPaths.map(p=>p.length)) : 0, requiredVisuals:[...visuals]};
}
export function scenarioPlan(repoRoot, files) {
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
        const selected = contract(path.basename(file,'.mjs'),fn.body);
        return {...selected, complete:selected.complete && selected.mode === 'assert', mode:'assert', minAssertions:Math.max(1,selected.minAssertions), file:path.resolve(file)};
    })};
    plan.complete=plan.members.every(member=>member.complete);
    return plan;
}
export function auditPlan(repoRoot, ids) {
    const entries = new Map();
    const collect=(node,bindings={})=>{
        if(node.type!=='ObjectExpression')return;
        const id=literal(node.properties.find(item=>item.key?.name==='id')?.value,bindings);
        const run=node.properties.find(item=>item.key?.name==='run')?.value;
        if(typeof id==='string' && run?.body) {
            const selected=contract(id,run.body,bindings,'audit');
            const needsEyes=literal(node.properties.find(item=>item.key?.name==='needsEyes')?.value,bindings) === true;
            if(needsEyes || selected.requiredVisuals.length)selected.requiredVisuals=[id];
            if(needsEyes && selected.mode==='setup')selected.mode='visual';
            entries.set(id,selected);
        }
    };
    walk(ast(path.join(repoRoot,'scripts/ui-audit/audit.mjs')), node => {
        collect(node);
        if(node.type==='CallExpression' && node.callee.type==='MemberExpression' && node.callee.property.name==='map' && node.callee.object.type==='ArrayExpression') {
            const callback=node.arguments[0];
            if(callback?.params?.length===1 && callback.body.type==='ObjectExpression') {
                for(const value of node.callee.object.elements) collect(callback.body,{[callback.params[0].name]:literal(value)});
            }
        }
    });
    entries.set('renderer-console',{id:'renderer-console',mode:'assert',requiredAssertions:['no renderer console errors/warnings'],minAssertions:1});
    const members=ids.map(id => { if (!entries.has(id)) throw new Error(`unknown audit step ${id}`); return entries.get(id); });
    return {kind:'audit',complete:members.every(member=>member.complete!==false),ordered:true,members};
}
