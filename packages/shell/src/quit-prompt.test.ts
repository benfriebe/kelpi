import { describe, expect, it, vi } from 'vitest';

import {
    QUIT_GATE_GLOBAL,
    QUIT_GATE_VERSION,
    normalizeQuitVerdict,
    promptForQuit,
    quitGateDismissScript,
    quitGateOpenScript,
    quitGateProbeScript,
    type QuitPromptRenderer,
    type QuitVerdict
} from './quit-prompt.js';
import { EMPTY_COUNTS } from './agents.js';
import { quitDialogSpec } from './settings.js';

const SPEC = quitDialogSpec({
    ...EMPTY_COUNTS,
    running: 1,
    workspaces: [{ workspaceID: 'w1', name: 'alpha', running: 1, waiting: 0 }]
});

/** A page-side gate, evaluated for real: the scripts are source, so they have to BE source. */
function pageWithGate(open: (spec: unknown) => Promise<unknown> | unknown, version = QUIT_GATE_VERSION) {
    const calls: { opened: unknown[]; dismissed: number } = { opened: [], dismissed: 0 };
    const scope: Record<string, unknown> = {};
    scope[QUIT_GATE_GLOBAL] = {
        version,
        open: (spec: unknown) => {
            calls.opened.push(spec);
            return open(spec);
        },
        dismiss: () => {
            calls.dismissed += 1;
        }
    };
    // `globalThis` inside the injected source is the page's global; a fresh function scope with
    // a `globalThis` binding is the closest a Node test gets to evaluating it in one.
    const evaluate = (source: string): unknown =>
        // eslint-disable-next-line no-new-func
        new Function('globalThis', `return ${source};`)(scope);
    return { calls, evaluate, scope };
}

function renderer(evaluate: (source: string) => unknown): QuitPromptRenderer {
    return {
        probe: async () => (await evaluate(quitGateProbeScript())) === true,
        ask: async (spec) => await evaluate(quitGateOpenScript(spec)),
        dismiss: () => {
            evaluate(quitGateDismissScript());
        }
    };
}

describe('the injected gate scripts (§AGNT-116)', () => {
    it('probes true only for a page carrying a gate of a version we understand', () => {
        const withGate = pageWithGate(() => ({ response: 1, checkboxChecked: false }));
        expect(withGate.evaluate(quitGateProbeScript())).toBe(true);

        const older = pageWithGate(() => ({ response: 1, checkboxChecked: false }), 0);
        expect(older.evaluate(quitGateProbeScript())).toBe(false);

        // A page that predates the gate entirely — the upgrade case, and the browser case.
        // eslint-disable-next-line no-new-func
        expect(new Function('globalThis', `return ${quitGateProbeScript()};`)({})).toBe(false);
    });

    it('carries the spec through as data, quotes and all', async () => {
        const page = pageWithGate((spec) => ({ response: 0, checkboxChecked: false, echo: spec }));
        const spec = { ...SPEC, detail: `A workspace called "it's \\ odd" is still active` };
        await page.evaluate(quitGateOpenScript(spec));
        expect(page.calls.opened[0]).toEqual(spec);
    });

    it('dismisses without caring whether a gate is there', () => {
        const page = pageWithGate(() => ({ response: 1, checkboxChecked: false }));
        expect(page.evaluate(quitGateDismissScript())).toBe(true);
        expect(page.calls.dismissed).toBe(1);
        // eslint-disable-next-line no-new-func
        expect(new Function('globalThis', `return ${quitGateDismissScript()};`)({})).toBe(true);
    });
});

describe('normalizeQuitVerdict', () => {
    it('accepts a well-formed verdict and defaults the checkbox to false', () => {
        expect(normalizeQuitVerdict({ response: 0 }, SPEC)).toEqual({ response: 0, checkboxChecked: false });
        expect(normalizeQuitVerdict({ response: 1, checkboxChecked: true }, SPEC)).toEqual({
            response: 1,
            checkboxChecked: true
        });
    });

    it('refuses anything it cannot read as a decision about quitting', () => {
        for (const value of [null, undefined, 'quit', 0, { response: '0' }, { response: 1.5 }, { response: -1 }, { response: 2 }, {}]) {
            expect(normalizeQuitVerdict(value, SPEC)).toBeNull();
        }
    });
});

describe('promptForQuit routing (§AGNT-116)', () => {
    const nativeVerdict: QuitVerdict = { response: 1, checkboxChecked: false };

    it('asks the renderer when one is live, and never opens a native dialog', async () => {
        const page = pageWithGate(() => ({ response: 0, checkboxChecked: true }));
        const native = vi.fn(async () => nativeVerdict);
        const result = await promptForQuit(SPEC, { renderer: renderer(page.evaluate), native });
        expect(result).toEqual({ response: 0, checkboxChecked: true, route: 'renderer' });
        expect(native).not.toHaveBeenCalled();
        expect(page.calls.opened).toHaveLength(1);
    });

    it('uses the native dialog when there is no renderer at all (tray quit, signal)', async () => {
        const native = vi.fn(async () => nativeVerdict);
        const logs: string[] = [];
        const result = await promptForQuit(SPEC, { renderer: null, native, log: (line) => logs.push(line) });
        expect(result).toEqual({ ...nativeVerdict, route: 'native' });
        expect(native).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toContain('no renderer');
    });

    it('uses the native dialog when the page has no gate (an older client)', async () => {
        const native = vi.fn(async () => nativeVerdict);
        const bare: QuitPromptRenderer = {
            probe: async () => false,
            ask: async () => null,
            dismiss: () => undefined
        };
        const result = await promptForQuit(SPEC, { renderer: bare, native });
        expect(result.route).toBe('native');
        expect(native).toHaveBeenCalledTimes(1);
    });

    it('falls back when the probe never answers — a wedged renderer must not delay the dialog', async () => {
        const native = vi.fn(async () => nativeVerdict);
        const wedged: QuitPromptRenderer = {
            probe: () => new Promise<boolean>(() => undefined),
            ask: async () => null,
            dismiss: vi.fn()
        };
        const result = await promptForQuit(SPEC, { renderer: wedged, native, probeTimeoutMs: 20 });
        expect(result.route).toBe('native');
        expect(native).toHaveBeenCalledTimes(1);
        // Nothing was opened, so nothing needed dismissing.
        expect(wedged.dismiss).not.toHaveBeenCalled();
    });

    it('falls back when the verdict never comes, dismissing the page dialog first', async () => {
        const page = pageWithGate(() => new Promise<unknown>(() => undefined));
        const native = vi.fn(async () => nativeVerdict);
        const logs: string[] = [];
        const result = await promptForQuit(SPEC, {
            renderer: renderer(page.evaluate),
            native,
            verdictTimeoutMs: 20,
            log: (line) => logs.push(line)
        });
        expect(result).toEqual({ ...nativeVerdict, route: 'native' });
        // The user must never be asked twice at once: the page's dialog is closed first.
        expect(page.calls.dismissed).toBe(1);
        expect(logs.join('\n')).toContain('did not answer');
    });

    it('falls back when the renderer throws, or answers something that is not a verdict', async () => {
        const native = vi.fn(async () => nativeVerdict);
        const throwing: QuitPromptRenderer = {
            probe: async () => true,
            ask: async () => {
                throw new Error('render process gone');
            },
            dismiss: vi.fn()
        };
        expect((await promptForQuit(SPEC, { renderer: throwing, native })).route).toBe('native');

        const nonsense: QuitPromptRenderer = {
            probe: async () => true,
            ask: async () => ({ response: 'quit' }),
            dismiss: vi.fn()
        };
        expect((await promptForQuit(SPEC, { renderer: nonsense, native })).route).toBe('native');
        expect(native).toHaveBeenCalledTimes(2);
    });

    it('reports Cancel from the renderer as a cancel, with the suppression checkbox intact', async () => {
        const page = pageWithGate(() => ({ response: SPEC.cancelId, checkboxChecked: true }));
        const native = vi.fn(async () => nativeVerdict);
        const result = await promptForQuit(SPEC, { renderer: renderer(page.evaluate), native });
        // §10 step 4: the suppression is honoured on Cancel too, so it has to survive the trip.
        expect(result).toEqual({ response: 1, checkboxChecked: true, route: 'renderer' });
        expect(SPEC.buttons[result.response]).toBe('Cancel');
    });
});
