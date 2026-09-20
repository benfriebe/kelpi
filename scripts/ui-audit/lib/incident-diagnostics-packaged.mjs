/** Bind packaged runtime bytes to the already recorded core build, without launching Electron. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// ASAR's two size-prefixed Pickle buffers precede its file data. Read only the requested entry;
// refuse links/unpacked entries here rather than resolving outside the retained package.
export function readAsarEntry(file, entry) {
    const fd=fs.openSync(file,'r');
    try {
        const prefix=Buffer.alloc(16);if(fs.readSync(fd,prefix,0,16,0)!==16)throw new Error('truncated ASAR header');
        const headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
        if(prefix.readUInt32LE(0)!==4 || jsonSize<2 || jsonSize>16*1024*1024 || headerSize<jsonSize+8) throw new Error('invalid ASAR header');
        const bytes=Buffer.alloc(jsonSize);if(fs.readSync(fd,bytes,0,jsonSize,16)!==jsonSize)throw new Error('truncated ASAR JSON');
        let node=JSON.parse(bytes.toString('utf8'));
        for(const part of entry.split('/')) {if(!part || part==='..')throw new Error('invalid ASAR entry');node=node.files?.[part];if(!node)throw new Error(`missing ASAR entry ${entry}`);}
        if(node.link || node.unpacked || !Number.isSafeInteger(node.size) || node.size<0 || !/^\d+$/.test(node.offset))throw new Error(`unsupported ASAR entry ${entry}`);
        const offset=8+headerSize+Number(node.offset);
        if(!Number.isSafeInteger(offset) || offset+node.size>fs.fstatSync(fd).size)throw new Error('invalid ASAR data range');
        const result=Buffer.alloc(node.size);if(fs.readSync(fd,result,0,result.length,offset)!==result.length)throw new Error('truncated ASAR entry');
        return result;
    } finally {fs.closeSync(fd);}
}

export function bindPackagedRuntime(repoRoot, provenance, {packaged=false,clientDir}={}) {
    if(!packaged && !clientDir) return null;
    const resource=path.join('packages/shell/out',`Kelpi-darwin-${process.arch}`,'Kelpi.app/Contents/Resources');
    const outputs=[],executedOutputs=[],mappings=[],errors=[];
    if (provenance.executionContext && clientDir) {
        const relative = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(clientDir));
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) errors.push('strict target client override escapes target root');
    }
    const bind=(built,relative,read)=>{
        mappings.push({builtPath:built.path,runtimePath:relative});
        outputs.push({path:relative,sha256:built.sha256});
        try {executedOutputs.push({path:relative,sha256:digest(read())});}catch(error){errors.push(`${relative}: ${error.message}`);}
    };
    for(const built of provenance.build?.outputs ?? []) {
        const match=/^packages\/(client|daemon|cli|shell)\/dist\/(.+)$/.exec(built.path);
        if(!match)continue;
        const [,name,suffix]=match;
        if(name==='client') {
            const absolute=clientDir ? path.resolve(clientDir,suffix) : path.join(repoRoot,resource,'client',suffix);
            // Relative logical paths remain portable even with an explicit absolute client override.
            const relative=clientDir ? `runtime-client/${suffix}` : `${resource}/client/${suffix}`;
            bind(built,relative,()=>fs.readFileSync(absolute));
        } else if(packaged && name==='shell' && /^main\.js(?:\.map)?$/.test(suffix)) {
            bind(built,`${resource}/app.asar/dist/${suffix}`,()=>readAsarEntry(path.join(repoRoot,resource,'app.asar'),`dist/${suffix}`));
        } else if(packaged && ((name==='daemon' && /^(kelpid\.js(?:\.map)?|runner\.mjs)$/.test(suffix)) || (name==='cli' && /^kelpi\.js(?:\.map)?$/.test(suffix)))) {
            bind(built,`${resource}/${name}/${suffix}`,()=>fs.readFileSync(path.join(repoRoot,resource,name,suffix)));
        }
    }
    if(!outputs.length || packaged && !mappings.some(mapping=>mapping.builtPath==='packages/shell/dist/main.js'))errors.push('bound core build outputs unavailable');
    if(JSON.stringify(outputs)!==JSON.stringify(executedOutputs))errors.push('runtime artifacts differ from recorded build outputs');
    return {id:packaged?'packaged-runtime':'client-override',source:provenance.source,
        build:{inputManifestSha256:provenance.source.inputManifestSha256,outputs,forced:provenance.build?.forced === true},executedOutputs,mappings,
        complete:errors.length===0,errors,limitations:['These bindings verify packaged application bundles against core build outputs; they do not establish native runtime or installed-device acceptance.']};
}
