import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { auditPlan } from './incident-diagnostics-plan.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const audit = fs.readFileSync(path.join(root, 'scripts/ui-audit/audit.mjs'), 'utf8');
const geometry = fs.readFileSync(path.join(root, 'scripts/scenarios/plugin-terminal-geometry.mjs'), 'utf8');
const terminalLabStyle = fs.readFileSync(path.join(root, 'examples/plugins/terminal-lab/ui/style.css'), 'utf8');

test('shared acceptance: phone shell retains its screenshot review contract', () => {
    const start = audit.indexOf("id: 'phone-shell'");
    const end = audit.indexOf('\n        },\n        /*', start);
    assert.ok(start >= 0 && end > start, 'phone-shell flow must remain a bounded audit entry');
    assert.match(audit.slice(start, end), /needsEyes:\s*true/, 'phone-shell screenshots must require a visual review');
    const plan = auditPlan(root, ['phone-shell']);
    assert.equal(plan.complete, true);
    assert.deepEqual(plan.members[0].requiredVisuals, ['phone-shell'], 'the acceptance plan must retain the review obligation');
});

test('shared acceptance: geometry records xterm viewport evidence for lower-right bars', () => {
    assert.match(geometry, /const viewport = root\.querySelector\('\.xterm-viewport'\)/);
    for (const field of ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'offsetWidth', 'offsetHeight', 'scrollLeft', 'scrollTop']) {
        assert.match(geometry, new RegExp(`\\b${field}: viewport\\.${field}`));
    }
    assert.match(geometry, /afterKeyboard === true/, 'a timed-out settle returns false and must not satisfy the keyboard scrollback check');
    assert.match(geometry, /JSON\.stringify\(\{\s*before:\s*beforeKeyboard,\s*after:\s*keyboardState\s*\}\)/, 'both starting and final keyboard viewport diagnostics must be retained');
    assert.match(geometry, /\[\?1002l/, 'the normal-buffer wheel setup must disable fixture mouse reporting before asserting scrollback');
});

test('shared acceptance: Terminal Lab removes viewport chrome styling without claiming source inspection proves scrolling', () => {
    assert.match(terminalLabStyle, /#terminal\s*\{[^}]*padding:\s*0\b[^}]*\}/s, 'the host must not retain the bottom padding strip');
    const viewportRule = terminalLabStyle.match(/#terminal\s+\.xterm-viewport\s*\{([^}]*)\}/s)?.[1] ?? '';
    assert.match(viewportRule, /background-color:\s*transparent\b/, 'the viewport must not paint a second background shade');
    assert.match(terminalLabStyle, /#terminal\s+\.xterm-viewport::\-webkit-scrollbar\s*\{[^}]*display:\s*none\b[^}]*\}/s, 'Chromium must suppress the visible native scrollbar');
    assert.ok(!/overflow-y:\s*hidden\b/.test(viewportRule), 'the viewport rule must not explicitly disable vertical overflow');
    // Scrollback is behavioral: plugin-terminal-geometry performs the live wheel/keyboard check.
});

test('shared acceptance: cleanup helper recognition and receipts fail closed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-acceptance-plan-'));
    try {
        const plan = (code, params = '') => {
            const file = path.join(dir, 'scripts/ui-audit/audit.mjs');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `import { cleanupSteps } from './lib/incident-diagnostics.mjs';\nconst steps = [{ id: 'probe', run: async (${params}) => { recorder.check('normal behavior', true); ${code} } }];\n`);
            return auditPlan(dir, ['probe']).members[0];
        };
        const valid = plan(`await cleanupSteps([['remove', async () => { await remove(); recorder.check('fixture cleanup: removed', true); }]], (label, error) => recorder.check('fixture cleanup: failed', false, error));`);
        assert.equal(valid.complete, true);
        assert.ok(valid.requiredAssertions.includes('fixture cleanup: removed'));
        for (const [name, code, error] of [
            ['shadowed import', `const cleanupSteps = async () => {}; await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => recorder.check('fixture cleanup: failed', false, error));`, 'cleanup helper import is shadowed or lexical identity is unproven'],
            ['missing success receipt', `await cleanupSteps([['remove', async () => { await remove(); }]], (label, error) => recorder.check('fixture cleanup: failed', false, error));`, 'known cleanup helper step remove requires a fixture cleanup success receipt'],
            ['dead failure receipt', `await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => { if (false) recorder.check('fixture cleanup: failed', false, error); });`, 'known cleanup helper requires a fixture cleanup failure receipt'],
            ['nested failure receipt', `await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => { () => recorder.check('fixture cleanup: failed', false, error); });`, 'known cleanup helper requires a fixture cleanup failure receipt'],
            ['unawaited helper', `cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => recorder.check('fixture cleanup: failed', false, error));`, 'known cleanup helper must be awaited'],
            ['function declaration shadow', `function cleanupSteps() {} await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => recorder.check('fixture cleanup: failed', false, error));`, 'cleanup helper import is shadowed or lexical identity is unproven'],
            ['return before failure receipt', `await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => { return; recorder.check('fixture cleanup: failed', false, error); });`, 'known cleanup helper requires a fixture cleanup failure receipt'],
            ['conditional return before failure receipt', `await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => { if (error) return; recorder.check('fixture cleanup: failed', false, error); });`, 'known cleanup helper requires a fixture cleanup failure receipt'],
            ['async failure reporter', `await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], async (label, error) => { await pending(); recorder.check('fixture cleanup: failed', false, error); });`, 'known cleanup helper requires a fixture cleanup failure receipt'],
            ['generator failure reporter', `await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], function* (label, error) { recorder.check('fixture cleanup: failed', false, error); });`, 'known cleanup helper requires a fixture cleanup failure receipt']
        ]) {
            const result = name === 'parameter shadow' ? plan(code, 'cleanupSteps') : plan(code);
            assert.equal(result.complete, false, name);
            assert.ok(result.contractErrors.includes(error), `${name}: ${JSON.stringify(result.contractErrors)}`);
        }
        const parameterShadow = plan(`await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => recorder.check('fixture cleanup: failed', false, error));`, 'cleanupSteps');
        assert.equal(parameterShadow.complete, false);
        assert.ok(parameterShadow.contractErrors.includes('cleanup helper import is shadowed or lexical identity is unproven'));
        const factoryFile = path.join(dir, 'scripts/ui-audit/audit.mjs');
        fs.writeFileSync(factoryFile, `import { cleanupSteps } from './lib/incident-diagnostics.mjs';
            function factory(cleanupSteps) { const steps = [{ id: 'probe', run: async () => { recorder.check('normal behavior', true); await cleanupSteps([['remove', async () => recorder.check('fixture cleanup: removed', true)]], (label, error) => recorder.check('fixture cleanup: failed', false, error)); } }]; return steps; }
            factory(cleanupSteps);\n`);
        const outerParameter = auditPlan(dir, ['probe']).members[0];
        assert.equal(outerParameter.complete, false);
        assert.ok(outerParameter.contractErrors.includes('cleanup helper import is shadowed or lexical identity is unproven'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
