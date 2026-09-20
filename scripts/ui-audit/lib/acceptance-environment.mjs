/** Non-local labels are requirements, never evidence of an actual device or transport. */
import fs from 'node:fs';
import { digest, verifyArtifacts } from './acceptance-io.mjs';
export const ENVIRONMENTS = ['local', 'installed-tailscale', 'remote-codex', 'safari', 'physical-phone', 'native-ime'];
const named = v => typeof v === 'string' && v.trim().length > 0;
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function inspectEnvironment(environment, { head, artifacts = [] } = {}) {
    const missing = [], evidence = [];
    if (!named(environment?.id) || !named(environment?.details) || !ENVIRONMENTS.includes(environment?.kind)) return { missing: ['actual environment identity absent'], evidence };
    if (environment.kind === 'local') return { missing, evidence };
    const e = environment.evidence;
    if (!named(e?.sessionId) || e?.head !== head || !sha(e?.buildDigest) || !named(e?.operator) || !Array.isArray(e?.facts)) return { missing: ['non-local environment corroboration absent'], evidence };
    const roles = ['build', 'session', 'device'];
    if (['installed-tailscale', 'remote-codex'].includes(environment.kind)) roles.push('transport');
    if (['physical-phone', 'native-ime'].includes(environment.kind)) roles.push('native-events');
    const facts = {};
    for (const role of roles) {
        const refs = e.facts.filter(f => f?.role === role);
        try {
            if (refs.length !== 1 || !verifyArtifacts(refs) || !artifacts.some(a => a.path === refs[0].path && a.sha256 === refs[0].sha256)) throw new Error('unbound');
            const fact = JSON.parse(fs.readFileSync(refs[0].path, 'utf8'));
            if (fact.role !== role || fact.sessionId !== e.sessionId || fact.head !== head || fact.buildDigest !== e.buildDigest) throw new Error('wrong session/build');
            facts[role] = fact; evidence.push(refs[0]);
        } catch { missing.push(`non-local environment ${role} facts missing or unbound`); }
    }
    const build = facts.build;
    if (!Array.isArray(build?.outputs) || !build.outputs.length || build.outputs.some(o => !named(o?.path) || !sha(o?.sha256)) || digest(JSON.stringify(build?.outputs)) !== e.buildDigest || build.sourceHead !== head) missing.push('environment build identity inconsistent');
    const session = facts.session, device = facts.device;
    if (!named(session?.startedAt) || !Number.isFinite(Date.parse(session.startedAt)) || !named(session?.driver) || ['node', 'vm', 'cdp-emulation'].includes(session.driver) || session.emulated !== false) missing.push('environment live session absent');
    if (!named(device?.os) || !named(device?.osVersion) || !named(device?.hardwareId) || device.virtual !== false) missing.push('environment actual device facts absent');
    if (environment.kind === 'physical-phone' && (!['phone', 'tablet'].includes(device?.formFactor) || session?.driver !== 'native-device')) missing.push('physical phone not corroborated');
    if (environment.kind === 'safari' && (device?.browser !== 'Safari' || device?.engine !== 'WebKit' || !named(device?.browserVersion))) missing.push('Safari browser not corroborated');
    if (roles.includes('transport')) {
        const transport = facts.transport;
        if (transport?.connected !== true || !named(transport?.localPeer) || !named(transport?.remotePeer) || transport.localPeer === transport.remotePeer || !named(transport?.connectionId) || transport.kind !== (environment.kind === 'installed-tailscale' ? 'tailscale' : 'remote-codex')) missing.push('real remote transport not corroborated');
    }
    if (roles.includes('native-events')) {
        const native = facts['native-events'];
        if (!named(native?.platformAPI) || native?.injected !== false || !Number.isInteger(native?.trustedEventCount) || native.trustedEventCount < 1 || (environment.kind === 'native-ime' && (!named(native?.inputMethod) || native.compositionObserved !== true))) missing.push('native input events not corroborated');
    }
    const review = e.review;
    if (!named(review?.reviewer) || review.reviewer === e.operator || review.independent !== true || review.verdict !== 'passed' || review.sessionId !== e.sessionId || review.head !== head || review.buildDigest !== e.buildDigest || review.factsDigest !== digest(JSON.stringify(e.facts)) || !Number.isFinite(Date.parse(review.at)) || Date.parse(review.at) < Date.parse(session?.startedAt)) missing.push('independent environment review attestation absent or inconsistent');
    return { missing, evidence };
}
