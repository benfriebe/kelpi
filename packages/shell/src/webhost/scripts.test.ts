/**
 * The injected sources and the expressions that drive them (web-pane.md §7, §8.2, §8.5).
 *
 * These scripts run in a page, so their *behaviour* is proven by the live smoke
 * (`scripts/web-smoke.mjs`) against a real engine. What is checkable here — and what actually
 * breaks silently when someone edits this file — is the shape of what gets injected: the
 * main-frame guards CDP injection makes mandatory, the idempotency guards, the binding name
 * rewrite, and the exec wrapper's statement-vs-expression rule.
 */

import { describe, expect, it } from 'vitest';

import {
    BINDING_NAME,
    EXEC_STATEMENT_PATTERN,
    actuatorScript,
    bridgeScript,
    buildActuatorCall,
    buildFindCall,
    buildInspectArm,
    buildInspectDisarm,
    findScript,
    injectedScriptSources,
    inspectorScript,
    wrapExecScript
} from './scripts.js';

describe('injection', () => {
    it('installs the bridge before anything that posts through it', () => {
        const sources = injectedScriptSources();
        expect(sources[0]).toBe(bridgeScript());
        expect(sources).toHaveLength(4);
    });

    it('guards every main-frame script against running in subframes', () => {
        // `Page.addScriptToEvaluateOnNewDocument` runs in ALL frames, unlike WKWebView's
        // `forMainFrameOnly` — the guard is the whole reason these scripts port safely.
        for (const source of [actuatorScript(), inspectorScript(), findScript()]) {
            expect(source).toContain('window !== window.top');
        }
    });

    it('deliberately does not inject the console script (the port takes the CDP branch)', () => {
        const all = injectedScriptSources().join('\n');
        expect(all).not.toContain('__nexConsoleInstalled');
        expect(all).not.toContain('__nexConsoleOriginals');
    });

    it('keeps the idempotency guards CDP re-injection needs', () => {
        expect(actuatorScript()).toContain('__nexActInstalled');
        expect(inspectorScript()).toContain('__nexInspectorInstalled');
        expect(bridgeScript()).toContain('__nexBridgeInstalled');
        expect(findScript()).toContain('__nexWebFind');
    });

    it('rewrites the binding placeholder to the real Runtime.addBinding name', () => {
        const source = bridgeScript();
        // The quoting depends on whatever transform produced `Function.prototype.toString()`
        // output, so assert on the name itself rather than on a quote style.
        expect(source).toContain(BINDING_NAME);
        expect(source).not.toContain('__NEX_BINDING__');
    });

    it('keeps the webkit.messageHandlers shim so page code reads like the Swift original', () => {
        const source = bridgeScript();
        expect(source).toContain('messageHandlers');
        expect(source).toContain('nexInspect');
    });

    it('keeps the find highlight palette (it matches the terminal/markdown find colors)', () => {
        const source = findScript();
        expect(source).toContain('#F2D027');
        expect(source).toContain('#FF7A00');
    });

    it('keeps the picker overlay palette and the overlay-passthrough attributes', () => {
        const source = inspectorScript();
        expect(source).toContain('#007AFF');
        expect(source).toContain('data-nex-overlay');
        expect(source).toContain('data-nex-batch-popover');
    });
});

describe('buildActuatorCall', () => {
    it('awaits the call and JSON-encodes the reply inside the page', () => {
        const expression = buildActuatorCall('wait', [{ selector: '#x', timeout: 1000 }]);
        expect(expression).toContain('await window.__nexAct["wait"]');
        expect(expression).toContain('JSON.stringify');
        expect(expression).toContain('{"selector":"#x","timeout":1000}');
    });

    it('reports a missing actuator as the spec string, not as an evaluation failure', () => {
        expect(buildActuatorCall('click', [])).toContain("actuator not installed");
    });

    it('encodes arguments as JSON literals (a quote in a selector must not break out)', () => {
        const expression = buildActuatorCall('text', ['a"b\\c', null]);
        expect(expression).toContain(JSON.stringify('a"b\\c'));
        expect(expression).toContain('null');
    });

    it('turns an undefined argument into null so the arity is preserved', () => {
        expect(buildActuatorCall('attr', ['#x', undefined])).toContain('"#x", null');
    });
});

describe('wrapExecScript (§8.5)', () => {
    it('auto-returns a single expression, stripping one trailing semicolon', () => {
        expect(wrapExecScript('document.title;')).toContain('return (document.title);');
    });

    it('uses a statement body verbatim when it starts with a keyword', () => {
        const body = 'const t = document.title; return t.length;';
        const wrapped = wrapExecScript(body);
        expect(wrapped).toContain(body);
        expect(wrapped).not.toContain('return (const');
    });

    it('detects a keyword after a semicolon, not only at line start', () => {
        expect(EXEC_STATEMENT_PATTERN.test('foo(); return 1')).toBe(true);
        expect(EXEC_STATEMENT_PATTERN.test('document.title')).toBe(false);
        // A property named `return`-ish must not be mistaken for the keyword.
        expect(EXEC_STATEMENT_PATTERN.test('x.returned')).toBe(false);
    });

    it('exposes $, $$ and nex as the actuator aliases', () => {
        const wrapped = wrapExecScript('1');
        expect(wrapped).toContain('($, $$, nex)');
        expect(wrapped).toContain('window.__nexAct.find, window.__nexAct.findAll, window.__nexAct');
    });

    it('carries the js_error shape on a throw', () => {
        const wrapped = wrapExecScript('1');
        expect(wrapped).toContain('js_error');
        expect(wrapped).toContain('line:');
        expect(wrapped).toContain('column:');
    });
});

describe('picker + find expressions', () => {
    it('passes the nonce and sticky flag through as literals', () => {
        expect(buildInspectArm('deadbeef', true)).toContain('"deadbeef", true');
        expect(buildInspectArm('deadbeef', false)).toContain('"deadbeef", false');
    });

    it('is a no-op expression when the picker is not installed', () => {
        expect(buildInspectArm('n', false)).toContain('if (!window.__nexInspectorEnable) return false');
        expect(buildInspectDisarm()).toContain('if (!window.__nexInspectorDisable) return false');
    });

    it('only search takes a needle', () => {
        expect(buildFindCall('search', 'needle')).toContain('search("needle")');
        expect(buildFindCall('next', 'ignored')).toContain('next()');
        expect(buildFindCall('clear', '')).toContain('clear()');
    });
});
