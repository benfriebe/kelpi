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
    if(node?.type==='Identifier')return bindings[node.name];
    if(node?.type==='TemplateLiteral') {
        const values=node.expressions.map(item=>literal(item,bindings));
        if(values.some(value=>value===undefined))return undefined;
        return node.quasis.map((part,index)=>part.value.cooked+(index<values.length?values[index]:'')).join('');
    }
}
function contract(id, body, bindings={}) {
    let checks = false, visual = false;
    walk(body, node => { if (method(node,'check')) checks = true; if (method(node,'eyes')) visual = true; });
    const requiredAssertions = [];
    const expression = node => {
        if (!node || /Function/.test(node.type)) return;
        if (method(node,'check') && typeof literal(node.arguments[0],bindings) === 'string') requiredAssertions.push(literal(node.arguments[0],bindings));
        // Conditional and short-circuit RHS are optional observations.
        if (node.type === 'ConditionalExpression') return expression(node.test);
        if (node.type === 'LogicalExpression') return expression(node.left);
        for (const child of children(node)) expression(child);
    };
    const hasReturn = node => { let found = false; walk(node, child => { if (child.type === 'ReturnStatement') found = true; }); return found; };
    const statements = body => {
        for (const statement of body?.body ?? []) {
            if (statement.type === 'TryStatement') { statements(statement.block); statements(statement.finalizer); if (hasReturn(statement)) break; }
            else if (statement.type === 'BlockStatement') statements(statement);
            else if (statement.type === 'IfStatement') { expression(statement.test); if (hasReturn(statement)) break; }
            else if (statement.type === 'ExpressionStatement' || statement.type === 'VariableDeclaration') expression(statement);
            else if (statement.type === 'ReturnStatement') { expression(statement.argument); break; }
        }
    };
    if (body?.type === 'BlockStatement') statements(body); else expression(body);
    return {id, mode:checks ? 'assert' : visual ? 'visual' : 'setup',requiredAssertions:[...new Set(requiredAssertions)],minAssertions:checks ? Math.max(1,new Set(requiredAssertions).size) : 0};
}
export function scenarioPlan(repoRoot, files) {
    return {kind:'scenario',complete:true,ordered:true,runtimeRequirements:[...new Set(files.filter(file=>/plugin-terminal-(features|geometry)\.mjs$/.test(file)).map(file=>`terminal-lab:${path.basename(file,'.mjs')}`))],members:files.map(file => {
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
        return {...selected,mode:'assert',minAssertions:Math.max(1,selected.minAssertions),file:path.resolve(file)};
    })};
}
export function auditPlan(repoRoot, ids) {
    const entries = new Map();
    const collect=(node,bindings={})=>{
        if(node.type!=='ObjectExpression')return;
        const id=literal(node.properties.find(item=>item.key?.name==='id')?.value,bindings);
        const run=node.properties.find(item=>item.key?.name==='run')?.value;
        if(typeof id==='string' && run?.body)entries.set(id,contract(id,run.body,bindings));
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
    return {kind:'audit',complete:true,ordered:true,members:ids.map(id => { if (!entries.has(id)) throw new Error(`unknown audit step ${id}`); return entries.get(id); })};
}
