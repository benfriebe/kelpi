/** Build and bind the ignored terminal plugin at each install boundary. */
import fs from 'node:fs';
import path from 'node:path';
import { captureSource, captureOutputs } from './acceptance-provenance.mjs';
import { buildTerminalLab } from '../../build-terminal-lab.mjs';
const pluginDirectory='examples/plugins/terminal-lab';
export async function buildBoundTerminalLab(repoRoot, {rec, diagnosticsProvenance} = {}) {
    const source=captureSource(repoRoot);
    const packagePath=await buildTerminalLab(repoRoot);
    const after=captureSource(repoRoot);
    if (JSON.stringify(source)!==JSON.stringify(after)) throw new Error('terminal plugin source changed during build');
    const outputs=captureOutputs(repoRoot,[pluginDirectory]);
    for (const file of ['ui/bundle.js','ui/bundle.css']) if (!outputs.some(output=>output.path===`${pluginDirectory}/${file}`)) throw new Error(`terminal plugin build missing ${file}`);
    const binding={id:`terminal-lab:${rec?.name ?? 'standalone'}`,source,build:{inputManifestSha256:source.inputManifestSha256,outputs,forced:true},executedOutputs:outputs,complete:true,errors:[],boundaries:[]};
    diagnosticsProvenance?.provenance.runtimeBindings.push(binding);
    const original=diagnosticsProvenance?.replaySource?.provenance?.runtimeBindings?.find(item=>item.id===binding.id);
    const bindExecution = boundary => {
        binding.executedOutputs=captureOutputs(repoRoot,[pluginDirectory]);
        const errors=[];
        if (JSON.stringify(captureSource(repoRoot))!==JSON.stringify(source)) errors.push('plugin build inputs changed before execution');
        if (JSON.stringify(binding.executedOutputs)!==JSON.stringify(binding.build.outputs)) errors.push('plugin outputs changed after build');
        if (diagnosticsProvenance?.replaySource && (!original || original.complete!==true || JSON.stringify(original.source)!==JSON.stringify(source) || JSON.stringify(original.build)!==JSON.stringify(binding.build) || JSON.stringify(original.executedOutputs)!==JSON.stringify(binding.executedOutputs))) errors.push('replay plugin build differs or original execution binding is missing');
        binding.boundaries.push({boundary,executedOutputs:binding.executedOutputs,errors});
        binding.errors.push(...errors);binding.complete=binding.errors.length===0;
        if(rec) fs.writeFileSync(path.join(rec.outDir,`${rec.name}-build-manifest.json`),JSON.stringify(binding,null,2)+'\n');
        if(errors.length) throw new Error(errors.join('; '));
        // The retained legacy manifest must describe the ignored bytes actually installed.
        for(const output of binding.executedOutputs) if(diagnosticsProvenance?.provenance.buildHashes[output.path] !== undefined) diagnosticsProvenance.provenance.buildHashes[output.path]=output.sha256;
    };
    bindExecution('after-build-before-input');
    return {packagePath,bindExecution};
}
