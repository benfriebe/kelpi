/** Prospective shell smoke contracts. Reading a plan never starts a process or desktop. */
import path from 'node:path';
import { assertionIdentities } from './acceptance-selection.mjs';
import { declarationReader } from './assertion-declarations.mjs';
const sources = Object.freeze({shell:'smoke',web:'web-smoke',pwa:'pwa-smoke',terminal:'terminal-smoke',packaged:'packaged-smoke'});
export function smokePlan(harnessRoot, name, environment = process.env) {
    if (Array.isArray(name)) {
        if (name.length !== 1 || typeof name[0] !== 'string') throw new Error('smoke contract requires exactly one source file');
        const source = path.resolve(name[0]);
        name = Object.entries(sources).find(([, basename]) => source === path.join(path.resolve(harnessRoot), 'packages/shell/scripts', `${basename}.mjs`))?.[0];
    }
    if (!Object.hasOwn(sources, name)) throw new Error(`unknown smoke contract ${name}`);
    const file = path.join(harnessRoot, 'packages/shell/scripts', `${sources[name]}.mjs`);
    const reviewed = declarationReader(harnessRoot)('smoke', file, { id:name,mode:'assert',complete:false,contractErrors:[],requiredAssertions:[],assertionPaths:[],minAssertions:1,requiredVisuals:[] });
    // The packager selects this label before execution from the same explicit environment.
    // Both alternatives are literal, complete inventories in the reviewed declaration.
    const signed = typeof environment.KELPI_MACOS_IDENTITY === 'string' && environment.KELPI_MACOS_IDENTITY.trim().length > 0;
    const paths = name === 'packaged' ? reviewed.assertionPaths.filter(labels => labels.includes(signed
        ? 'cookie encryption is on (this build is signed, so the keychain key has a stable owner)'
        : 'cookie encryption is off (an ad-hoc build must not block on the login keychain)')) : reviewed.assertionPaths;
    const assertionPaths = paths.map(assertionIdentities);
    const member = {...reviewed, file, complete:reviewed.complete && assertionPaths.length > 0, assertionPaths,
        requiredAssertions:assertionPaths[0]?.filter(label=>assertionPaths.every(labels=>labels.includes(label))) ?? [],
        minAssertions:assertionPaths.length ? Math.min(...assertionPaths.map(labels=>labels.length)) : 1};
    return {kind:'smoke',ordered:true,complete:member.complete,members:[member]};
}
