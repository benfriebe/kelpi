/**
 * Settings Lab, the SDK-only Settings presenter, driven exactly as the window drives it.
 *
 * The shipped view module is evaluated unchanged in jsdom against a fake `kelpi` whose `ui` methods
 * are the REAL presenter model over a REAL surface (`settings/presenter.ts`, `settings/surface.ts`),
 * as `features/interaction-lab.test.ts` runs Interaction Lab against the real interaction model: a
 * field id, a native section or a disabled row the host would refuse is refused here too, and a
 * write that reaches `SettingsActions` is the same write the daemon would have been sent. So what
 * the example proves is behaviour, not a mock's agreement.
 *
 * The subscription wrapper also copies the SDK's delivery rule - one frame at a time, acknowledged
 * only once the listener settles - because that is what makes the example's `stall()` hook a real
 * missed acknowledgement rather than a flag.
 *
 * Two layers are asserted separately throughout, which is the contract's own shape. The lab refuses
 * what the frame told it not to send (a draft past `maxLength`, a choice outside `choices`, a number
 * off the published grid, a colour that is not `#rrggbb`), and the HOST refuses what reaches it
 * anyway - which is the path the live scenario drives, since a value the lab's own controls cannot
 * produce has to be sent through the SDK directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WS_SETTINGS, type JsonObject, type WsSettingsSnapshot } from '@kelpi/protocol';

import { SETTINGS_TABS } from '../settings/catalog';
import {
    createSettingsPresenterHost,
    type SettingsPresenterHost,
    type SettingsPresenterSnapshot
} from '../settings/presenter';
import { createSettingsSurface, type SettingsSurface } from '../settings/surface';
import type { SettingsActions } from '../settings/types';

const assets = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../examples/plugins/settings-lab/ui'
);
const view = fs.readFileSync(path.join(assets, 'settings.js'), 'utf8');
const shell = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');

/** What the view publishes for the scenario, and what this suite reads back. */
interface LabDiagnostics {
    readonly snapshot: SettingsPresenterSnapshot | null;
    readonly ready: boolean;
    readonly frames: number;
    readonly lastError: string | null;
    crash(mode?: string): void;
    stall(): void;
}

/** One write as `SettingsActions` received it: the file, the key, and the encoded value. */
interface Write {
    readonly file: 'kelpi' | 'ghostty';
    readonly key: string;
    readonly value: string | null;
}

type General = Partial<WsSettingsSnapshot['general']>;
type Chrome = Partial<WsSettingsSnapshot['chrome']>;
type Appearance = Partial<WsSettingsSnapshot['appearance']>;

const surfaces: SettingsSurface[] = [];
const cleanups: Array<() => void> = [];

/** Comfortably past the view's own 50 ms draft coalescing window. */
const DRAFT_SETTLE_MS = 120;

const flush = async (): Promise<void> => {
    for (let index = 0; index < 12; index++) await Promise.resolve();
};
async function until(condition: () => boolean, label: string): Promise<void> {
    for (let index = 0; index < 240; index++) {
        // A condition that reads an element the view has not drawn yet is "not yet", not a failure.
        try {
            if (condition()) return;
        } catch {
            /* keep polling */
        }
        await new Promise((resolve) => setTimeout(resolve, 4));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function make(
    options: {
        readonly general?: General;
        readonly chrome?: Chrome;
        readonly appearance?: Appearance;
        readonly disabled?: readonly string[];
    } = {}
) {
    const writes: Write[] = [];
    let settings: WsSettingsSnapshot = {
        ...DEFAULT_WS_SETTINGS,
        general: { ...DEFAULT_WS_SETTINGS.general, ...options.general },
        chrome: { ...DEFAULT_WS_SETTINGS.chrome, ...options.chrome },
        appearance: { ...DEFAULT_WS_SETTINGS.appearance, ...options.appearance }
    };
    const actions: SettingsActions = {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => {
            writes.push({ file: 'kelpi', key, value });
        },
        setGhosttySetting: (key, value) => {
            writes.push({ file: 'ghostty', key, value });
        },
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
    const disabled = new Set<string>(options.disabled ?? []);
    // No `section` arm: the surface holds the route itself, which is what a fixture wants.
    const surface = createSettingsSurface({
        settings: () => settings,
        actions: () => actions,
        disabled: (fieldID) => disabled.has(fieldID)
    });
    surfaces.push(surface);
    return {
        surface,
        writes,
        /** The daemon broadcast: a new snapshot, then the reconciliation hook. */
        broadcast(next: { readonly general?: General; readonly chrome?: Chrome }): void {
            settings = {
                ...settings,
                general: { ...settings.general, ...next.general },
                chrome: { ...settings.chrome, ...next.chrome }
            };
            surface.settingsChanged();
        }
    };
}

async function mount(surface: SettingsSurface, options: { readonly visible?: boolean } = {}) {
    document.documentElement.innerHTML = new DOMParser().parseFromString(shell, 'text/html').documentElement
        .innerHTML;
    const state = { visible: options.visible ?? true };
    const failures: string[] = [];
    const thrown: Error[] = [];
    const errors: Error[] = [];
    const calls: Array<{ method: string; args: JsonObject }> = [];
    let acknowledged = 0;
    let readied = 0;
    let closed = 0;
    const host: SettingsPresenterHost = createSettingsPresenterHost({
        surface,
        placement: 'settings.window',
        // A presenter is desktop-only in this release, so a frame it receives always says so.
        formFactor: () => 'desktop',
        visible: () => state.visible,
        close: () => {
            closed += 1;
        },
        fail: (detail) => {
            failures.push(detail);
        },
        onAcknowledged: () => {
            acknowledged += 1;
        },
        onReady: () => {
            readied += 1;
        }
    });
    const call = async (method: string, args: JsonObject): Promise<void> => {
        calls.push({ method, args });
        await host.call(method, args);
    };
    // The SDK's own rule: frames drain one at a time, and each is acknowledged only after the
    // author's listener settles. A listener that never settles never acknowledges.
    let draining: Promise<void> = Promise.resolve();
    const onSettingsPresentation = (
        listener: (value: SettingsPresenterSnapshot) => void | Promise<void>,
        onError?: (error: Error) => void | Promise<void>
    ): (() => void) =>
        host.subscribe(
            (value) => {
                draining = draining.then(async () => {
                    try {
                        await listener(value);
                    } catch (error) {
                        thrown.push(error as Error);
                    }
                    host.noteAcknowledged();
                });
            },
            (error) => {
                errors.push(error);
                void onError?.(error);
            }
        );
    vi.stubGlobal('kelpi', {
        ready: Promise.resolve(),
        ui: {
            getSettingsPresentation: async () => host.getSettingsPresentation(),
            onSettingsPresentation,
            reportPresenterReady: () => call('ui.reportPresenterReady', {}),
            setSettingsSection: (id: string) => call('ui.setSettingsSection', { id }),
            setSettingsDraft: (fieldID: string, text: string) => call('ui.setSettingsDraft', { fieldID, text }),
            commitSettingsField: (fieldID: string) => call('ui.commitSettingsField', { fieldID }),
            resetSettingsField: (fieldID: string) => call('ui.resetSettingsField', { fieldID }),
            closeSettings: () => call('ui.closeSettings', {})
        }
    });
    // Evaluate the shipped module unchanged, exactly as `features/interaction-lab.test.ts` does.
    const events = vi.spyOn(globalThis, 'addEventListener');
    const registered: typeof events.mock.calls = [];
    try {
        await new Function(`return (async () => { ${view}\n})();`)();
    } finally {
        registered.push(...events.mock.calls);
        events.mockRestore();
    }
    cleanups.push(() => {
        window.dispatchEvent(new Event('pagehide'));
        host.dispose();
        for (const [name, listener, listenerOptions] of registered)
            globalThis.removeEventListener(name, listener, listenerOptions);
    });
    return {
        calls,
        errors,
        failures,
        thrown,
        acknowledged: () => acknowledged,
        readied: () => readied,
        closed: () => closed,
        lab: (): LabDiagnostics => (globalThis as unknown as { settingsLab: LabDiagnostics }).settingsLab,
        /** The host re-reads its own paint decision; the surface knows nothing about it. */
        show(visible: boolean) {
            state.visible = visible;
            host.refresh();
        },
        /**
         * A call the lab's own controls cannot produce, straight down the SDK's pipe - which is
         * what an `inFrame` evaluation in the live scenario is. The host answers it on its own.
         */
        send: (method: string, args: JsonObject) => host.call(method, args),
        sent: (method: string) => calls.filter((entry) => entry.method === method).map((entry) => entry.args)
    };
}
type Harness = Awaited<ReturnType<typeof mount>>;

const found = (testid: string): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)
];
function one(testid: string): HTMLElement {
    const [first] = found(testid);
    expect(first, `Missing [data-testid="${testid}"]`).toBeDefined();
    return first!;
}
function fieldRow(fieldID: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(
        `[data-testid="lab-settings-field"][data-field-id="${fieldID}"]`
    );
    expect(node, `Missing field row ${fieldID}`).not.toBeNull();
    return node!;
}
const inputFor = (fieldID: string): HTMLInputElement =>
    fieldRow(fieldID).querySelector<HTMLInputElement>('[data-testid="lab-settings-input"]')!;
const press = (fieldID: string, testid: string): void => {
    fieldRow(fieldID).querySelector<HTMLElement>(`[data-testid="${testid}"]`)!.click();
};
function type(control: HTMLElement, value: string): void {
    (control as HTMLInputElement).value = value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
}
const railIDs = (): string[] => found('lab-settings-rail-item').map((node) => node.dataset.sectionId ?? '');
const fieldIDs = (): string[] => found('lab-settings-field').map((node) => node.dataset.fieldId ?? '');
const frameField = (h: Harness, fieldID: string) =>
    h.lab().snapshot?.fields.find((field) => field.id === fieldID);

const ready = (h: Harness): Promise<void> =>
    until(() => document.body.dataset.ready === 'true', 'the presenter to report readiness').then(() => {
        expect(h.lab().ready).toBe(true);
    });
async function route(h: Harness, sectionID: string): Promise<void> {
    found('lab-settings-rail-item').find((node) => node.dataset.sectionId === sectionID)!.click();
    await until(() => document.body.dataset.section === sectionID, `the route to ${sectionID}`);
}

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const surface of surfaces.splice(0)) surface.dispose();
    await flush();
    vi.unstubAllGlobals();
    delete (globalThis as unknown as { settingsLab?: LabDiagnostics }).settingsLab;
    document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('Settings Lab reports readiness and draws the rail', () => {
    it('reports readiness after the first frame, mounted while the dialog is closed', async () => {
        const { surface } = make();
        // How a Settings presenter starts: the slot mounts it with the dialog CLOSED and arms the
        // 5 second readiness window on this first frame anyway.
        const h = await mount(surface, { visible: false });
        expect(h.lab().frames).toBeGreaterThanOrEqual(1);
        await ready(h);
        expect(h.readied()).toBe(1);
        expect(h.sent('ui.reportPresenterReady')).toHaveLength(1);
        expect(h.failures).toEqual([]);
        expect(h.lab().lastError).toBeNull();
        expect(h.lab().snapshot?.formFactor).toBe('desktop');
        // Nothing was presented, so nothing was drawn.
        expect(found('lab-settings')).toHaveLength(0);
        expect(document.body.dataset.visible).toBe('false');
    });

    it('lists every section, native ones included, and routes the host along the rail', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-rail-item').length === SETTINGS_TABS.length, 'the whole rail');
        expect(railIDs()).toEqual(SETTINGS_TABS.map((tab) => tab.id));
        expect(one('lab-settings').dataset.testid).toBe('lab-settings');
        expect(document.body.dataset.section).toBe('general');
        expect(found('lab-settings-rail-item')[0]!.getAttribute('aria-current')).toBe('true');
        /*
         * `icon` is an SF Symbol NAME, never a glyph: printing it raw would paint
         * "antenna.radiowaves" down the rail. The name stays on the cell for anyone reading the DOM.
         */
        const icons = found('lab-settings-rail-item').map((node) => node.firstElementChild as HTMLElement);
        expect(icons.map((cell) => cell.dataset.icon)).toEqual(SETTINGS_TABS.map((tab) => tab.icon));
        expect(found('lab-settings-rail-item').every((node) => !node.textContent?.includes('.'))).toBe(true);
        // Routing to Plugins is how a user reaches the row that switches a presenter off, so it is
        // in the rail like everything else and the presenter cannot withhold it.
        await route(h, 'plugins');
        expect(h.sent('ui.setSettingsSection')).toEqual([{ id: 'plugins' }]);
        expect(surface.getSnapshot().sectionID).toBe('plugins');
        expect(fieldIDs()).toEqual([]);
        expect(one('lab-settings-native-note').dataset.native).toBe('full');
        expect(railIDs()).toEqual(SETTINGS_TABS.map((tab) => tab.id));
        // A projected section says the same thing about the remainder below its fields.
        await route(h, 'general');
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        expect(one('lab-settings-native-note').dataset.native).toBe('remainder');
        expect(h.failures).toEqual([]);
    });

    it('groups the projected fields into the cards that named them', async () => {
        const { surface } = make({ general: { tcpPort: 19400 } });
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length === 7, "General's seven rows");
        expect(fieldIDs()).toEqual([
            'general.worktreeBasePath',
            'general.autoDetectRepos',
            'general.inheritGroupOnNewWorkspace',
            'general.newWorkspacePlacement',
            'general.newGroupPlacement',
            'general.tcpListener',
            'general.tcpPort'
        ]);
        expect(found('lab-settings-field').map((node) => node.dataset.kind)).toEqual([
            'text',
            'toggle',
            'toggle',
            'select',
            'select',
            'toggle',
            'number'
        ]);
        const cards = [...document.querySelectorAll<HTMLElement>('#panel > .card')];
        expect(cards.map((card) => card.dataset.key)).toEqual(
            h.lab().snapshot?.groups.map((group) => group.id)
        );
        // The port row is published only while the listener is on, so its card holds two rows.
        expect(cards.at(-1)!.querySelectorAll('[data-testid="lab-settings-field"]')).toHaveLength(2);
        // Nothing is orphaned in this catalog, so no fallback card is drawn for one.
        expect(cards.some((card) => card.dataset.key === 'lab:ungrouped')).toBe(false);
    });

    it('names every control, button and rail entry for a screen reader', async () => {
        const { surface } = make({ general: { tcpPort: 19400 } });
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length === 7, 'the General fields');
        // The switch reads "On"/"Off", which names a state and not the setting it belongs to.
        const toggle = inputFor('general.autoDetectRepos');
        expect(toggle.textContent).toBe('On');
        expect(toggle.getAttribute('aria-label')).toBe(frameField(h, 'general.autoDetectRepos')?.label);
        expect(inputFor('general.worktreeBasePath').getAttribute('aria-label')).toBe('Base path');
        expect(inputFor('general.newWorkspacePlacement').getAttribute('aria-label')).toBe(
            'New workspace placement'
        );
        // Every row has a button reading "Commit" and one reading "Reset", so the text names none.
        const row = fieldRow('general.worktreeBasePath');
        expect(row.querySelector('[data-testid="lab-settings-commit"]')!.getAttribute('aria-label')).toBe(
            'Commit Base path'
        );
        expect(row.querySelector('[data-testid="lab-settings-reset"]')!.getAttribute('aria-label')).toBe(
            'Reset Base path'
        );
        // The rail glyph is decoration: the entry is named by its title, once.
        expect(
            found('lab-settings-rail-item').every(
                (node) => node.firstElementChild!.getAttribute('aria-hidden') === 'true'
            )
        ).toBe(true);
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields');
        const segments = [
            ...fieldRow('appearance.chromeAppearance').querySelectorAll<HTMLElement>(
                '[data-testid="lab-settings-input"]'
            )
        ];
        expect(segments.map((node) => node.getAttribute('aria-label'))).toEqual([
            'Appearance: System',
            'Appearance: Light',
            'Appearance: Dark'
        ]);
    });
});

describe('Settings Lab commits one field of every kind', () => {
    it('holds a text draft, counts it dirty, and commits it as the field it names', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        expect(one('lab-settings-dirty').dataset.count).toBe('0');
        type(inputFor('general.worktreeBasePath'), '/tmp/kelpi-lab');
        await until(
            () => frameField(h, 'general.worktreeBasePath')?.draft === '/tmp/kelpi-lab',
            'the held draft'
        );
        // A draft is held in the HOST and writes nothing: who paints is the only thing a failure
        // changes, so the value has to survive this view.
        expect(writes).toEqual([]);
        expect(h.sent('ui.setSettingsDraft').at(-1)).toEqual({
            fieldID: 'general.worktreeBasePath',
            text: '/tmp/kelpi-lab'
        });
        await until(() => one('lab-settings-dirty').dataset.count === '1', 'the dirty count');
        expect(fieldRow('general.worktreeBasePath').dataset.draft).toBe('true');
        press('general.worktreeBasePath', 'lab-settings-commit');
        await until(() => writes.length === 1, 'the write');
        expect(h.sent('ui.commitSettingsField')).toEqual([{ fieldID: 'general.worktreeBasePath' }]);
        expect(writes).toEqual([{ file: 'kelpi', key: 'worktree-base-path', value: '/tmp/kelpi-lab' }]);
        // The write is out and the broadcast has not arrived, which the frame reports as `busy`.
        await until(() => fieldRow('general.worktreeBasePath').dataset.busy === 'true', 'the busy flag');
        expect(frameField(h, 'general.worktreeBasePath')?.busy).toBe(true);
        expect(h.failures).toEqual([]);
    });

    it('commits a text row with Enter', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        const input = inputFor('general.worktreeBasePath');
        input.focus();
        type(input, '/tmp/entered');
        await until(() => frameField(h, 'general.worktreeBasePath')?.draft === '/tmp/entered', 'the draft');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await until(() => writes.length === 1, 'the write');
        expect(writes).toEqual([{ file: 'kelpi', key: 'worktree-base-path', value: '/tmp/entered' }]);
        expect(h.sent('ui.commitSettingsField')).toEqual([{ fieldID: 'general.worktreeBasePath' }]);
    });

    it('commits a toggle, a select and a number with the values the frame published', async () => {
        const { surface, writes } = make({ general: { tcpPort: 19400 } });
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length === 7, 'the General fields');
        // A switch has no draft phase, so the lab holds and commits in one gesture.
        expect(inputFor('general.autoDetectRepos').getAttribute('aria-checked')).toBe('true');
        inputFor('general.autoDetectRepos').click();
        await until(() => writes.length === 1, 'the toggle write');
        expect(writes.at(-1)).toEqual({ file: 'kelpi', key: 'auto-detect-repos', value: 'false' });
        const picker = inputFor('general.newWorkspacePlacement') as unknown as HTMLSelectElement;
        expect([...picker.options].map((option) => option.value)).toEqual(['near-selection', 'end-of-list']);
        picker.value = 'near-selection';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => writes.length === 2, 'the select write');
        expect(writes.at(-1)).toEqual({ file: 'kelpi', key: 'new-workspace-placement', value: 'near-selection' });
        type(inputFor('general.tcpPort'), '19500');
        press('general.tcpPort', 'lab-settings-commit');
        await until(() => writes.length === 3, 'the number write');
        expect(writes.at(-1)).toEqual({ file: 'kelpi', key: 'tcp-port', value: '19500' });
        expect(h.sent('ui.commitSettingsField').map((args) => args['fieldID'])).toEqual([
            'general.autoDetectRepos',
            'general.newWorkspacePlacement',
            'general.tcpPort'
        ]);
        expect(h.failures).toEqual([]);
    });

    it('commits a segmented choice, a slider and a colour in Appearance', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields');
        const segments = [
            ...fieldRow('appearance.chromeAppearance').querySelectorAll<HTMLElement>(
                '[data-testid="lab-settings-input"]'
            )
        ];
        // The segments are built FROM `choices`, so this control cannot spell a value the field
        // did not offer.
        expect(segments.map((node) => node.dataset.value)).toEqual(['system', 'light', 'dark']);
        expect(segments[0]!.getAttribute('aria-pressed')).toBe('true');
        segments[2]!.click();
        await until(() => writes.length === 1, 'the segmented write');
        expect(writes.at(-1)).toEqual({ file: 'kelpi', key: 'chrome-appearance', value: 'dark' });
        // The slider's own bounds and grid come from the frame, and this value sits on that grid.
        const slider = inputFor('appearance.backgroundOpacity');
        expect([slider.min, slider.max, slider.step]).toEqual(['0.1', '1', '0.05']);
        type(slider, '0.85');
        press('appearance.backgroundOpacity', 'lab-settings-commit');
        await until(() => writes.length === 2, 'the slider write');
        // Written to ghostty's own config file, which is the host's business and not the lab's:
        // the lab named a field id and never a key, a file or a verb.
        expect(writes.at(-1)).toEqual({ file: 'ghostty', key: 'background-opacity', value: '0.85' });
        type(inputFor('appearance.searchMatchColor'), '#00FF88');
        press('appearance.searchMatchColor', 'lab-settings-commit');
        await until(() => writes.length === 3, 'the colour write');
        expect(writes.at(-1)).toEqual({ file: 'kelpi', key: 'search-match-color', value: '#00ff88' });
        expect(h.failures).toEqual([]);
    });
});

describe('Settings Lab never sends a value the contract forbids', () => {
    it('caps a text draft at the field maxLength', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        const field = frameField(h, 'general.worktreeBasePath');
        expect(field?.kind === 'text' && field.maxLength).toBe(1024);
        expect(inputFor('general.worktreeBasePath').maxLength).toBe(1024);
        // jsdom does not enforce the attribute on a programmatic set, which is exactly the paste
        // path: the cap has to be in the view as well as on the element.
        const input = inputFor('general.worktreeBasePath');
        input.focus();
        type(input, 'a'.repeat(2000));
        await until(
            () => frameField(h, 'general.worktreeBasePath')?.draft?.length === 1024,
            'the capped draft in the frame'
        );
        expect(h.sent('ui.setSettingsDraft')).toHaveLength(1);
        expect(String(h.sent('ui.setSettingsDraft')[0]!['text']).length).toBe(1024);
        expect(frameField(h, 'general.worktreeBasePath')?.error).toBeUndefined();
        // The caret is in the box, so no frame has written into it: it still holds what was pasted,
        // and the row says what was actually sent.
        expect(input.value.length).toBe(2000);
        expect(fieldRow('general.worktreeBasePath').dataset.error).toBe(`Sent as ${'a'.repeat(1024)}.`);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // `change` ends the edit, so the box is caught up with the 1024 the host is holding.
        expect(input.value.length).toBe(1024);
        expect(writes).toEqual([]);
    });

    it('refuses a choice the field never offered and a colour that is not #rrggbb', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        const picker = inputFor('general.newWorkspacePlacement') as unknown as HTMLSelectElement;
        const rogue = document.createElement('option');
        rogue.value = 'rm -rf ~';
        picker.append(rogue);
        picker.value = 'rm -rf ~';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();
        expect(h.sent('ui.setSettingsDraft')).toEqual([]);
        expect(h.sent('ui.commitSettingsField')).toEqual([]);
        // The refusal is the view's own, and says so: the host never saw the value at all.
        const message = fieldRow('general.newWorkspacePlacement').querySelector<HTMLElement>('.message')!;
        expect(message.hidden).toBe(false);
        expect(message.dataset.local).toBe('true');
        expect(fieldRow('general.newWorkspacePlacement').dataset.error).toBe(
            'That option is not one this field offers.'
        );
        // The positive control: the frame's own value is drawn back into the control, and the
        // option that was never published goes with it, because the choices are rebuilt per frame.
        expect(picker.value).toBe('end-of-list');
        expect([...picker.options].map((option) => option.value)).toEqual([
            'near-selection',
            'end-of-list'
        ]);
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields');
        type(inputFor('appearance.searchMatchColor'), 'rebeccapurple');
        await flush();
        expect(h.sent('ui.setSettingsDraft')).toEqual([]);
        expect(fieldRow('appearance.searchMatchColor').dataset.error).toBe('A colour has to be #rrggbb.');
        expect(writes).toEqual([]);
        expect(h.failures).toEqual([]);
    });

    it('clamps a number into the published bounds and snaps a slider onto its step grid', async () => {
        const { surface, writes } = make({ general: { tcpPort: 19400 } });
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length === 7, 'the General fields');
        type(inputFor('general.tcpPort'), '99999');
        await until(() => h.sent('ui.setSettingsDraft').length === 1, 'the clamped draft');
        expect(h.sent('ui.setSettingsDraft')[0]).toEqual({ fieldID: 'general.tcpPort', text: '65535' });
        // An emptied box is a value on its way somewhere, and `Number('')` is 0: a cleared port
        // must not be sent as this row's minimum.
        type(inputFor('general.tcpPort'), '');
        await flush();
        expect(h.sent('ui.setSettingsDraft')).toHaveLength(1);
        expect(fieldRow('general.tcpPort').dataset.error).toBe('That is not a number yet, so nothing was sent.');
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields');
        // jsdom does not snap a range to its step, so 0.37 reaches the view as 0.37 - which is the
        // value the host would refuse, and the view sends the nearest grid point instead.
        type(inputFor('appearance.backgroundOpacity'), '0.37');
        await until(
            () => h.sent('ui.setSettingsDraft').some((args) => args['fieldID'] === 'appearance.backgroundOpacity'),
            'the snapped draft'
        );
        expect(h.sent('ui.setSettingsDraft').at(-1)).toEqual({
            fieldID: 'appearance.backgroundOpacity',
            text: '0.35'
        });
        expect(frameField(h, 'appearance.backgroundOpacity')?.error).toBeUndefined();
        press('appearance.backgroundOpacity', 'lab-settings-commit');
        await until(() => writes.length === 1, 'the snapped write');
        expect(writes).toEqual([{ file: 'ghostty', key: 'background-opacity', value: '0.35' }]);
    });

    it('catches the box up with what is held once the caret leaves it', async () => {
        const { surface } = make({ general: { tcpPort: 19400 } });
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length === 7, 'the General fields');
        const port = inputFor('general.tcpPort');
        port.focus();
        expect(document.activeElement).toBe(port);
        type(port, '99999');
        await flush();
        /*
         * The caret is in the box, so a frame never writes into it - that is what keeps a frame
         * arriving on every keystroke from eating the caret, and it is also why the clamped value
         * has not reached the box yet. The row says so rather than letting the two disagree in
         * silence.
         */
        expect(port.value).toBe('99999');
        expect(fieldRow('general.tcpPort').dataset.error).toBe('Sent as 65535.');
        expect(h.sent('ui.setSettingsDraft')).toEqual([]);
        port.blur();
        // SYNCHRONOUSLY, not on whichever frame happens along next: the edit is over, so the
        // coalescing value goes out now and the box is caught up with it in the same turn.
        expect(port.value).toBe('65535');
        expect(h.sent('ui.setSettingsDraft')).toEqual([{ fieldID: 'general.tcpPort', text: '65535' }]);
        await until(() => frameField(h, 'general.tcpPort')?.draft === '65535', 'the held draft');
        // A commit is this view saying it is done with the value, so its own note goes with it.
        press('general.tcpPort', 'lab-settings-commit');
        await until(() => fieldRow('general.tcpPort').dataset.error === undefined, 'the cleared note');
    });

    it('coalesces a drag into one draft instead of one per event', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields');
        const slider = inputFor('appearance.backgroundOpacity');
        // A real drag fires one of these per pixel, and 240 calls in a rolling second FAILS the
        // presenter rather than dropping a frame.
        for (const step of ['0.2', '0.3', '0.4', '0.5', '0.6']) type(slider, step);
        await until(() => h.sent('ui.setSettingsDraft').length === 1, 'the coalesced draft');
        await flush();
        expect(h.sent('ui.setSettingsDraft')).toEqual([
            { fieldID: 'appearance.backgroundOpacity', text: '0.6' }
        ]);
        // A Commit landing inside that window still commits the value the drag ended on, because
        // the commit flushes whatever was waiting before it asks for the write.
        type(slider, '0.7');
        press('appearance.backgroundOpacity', 'lab-settings-commit');
        await until(() => h.sent('ui.commitSettingsField').length === 1, 'the commit');
        expect(h.sent('ui.setSettingsDraft').at(-1)).toEqual({
            fieldID: 'appearance.backgroundOpacity',
            text: '0.7'
        });
        expect(frameField(h, 'appearance.backgroundOpacity')?.draft).toBe('0.7');
    });

    it('drops a coalescing draft when the placement stops presenting', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields');
        type(inputFor('appearance.backgroundOpacity'), '0.5');
        // Still inside the coalescing window, so nothing has gone out yet.
        expect(h.sent('ui.setSettingsDraft')).toEqual([]);
        h.show(false);
        await until(() => found('lab-settings').length === 0, 'the hidden placement');
        await new Promise((resolve) => setTimeout(resolve, DRAFT_SETTLE_MS));
        // The timer came due on a window the user is no longer looking at. The host refuses a
        // mutating call outright then, so the value is dropped rather than sent and reported.
        expect(h.sent('ui.setSettingsDraft')).toEqual([]);
        expect(h.lab().lastError).toBeNull();
        expect(h.failures).toEqual([]);
    });

    it('drops a local note when its field leaves the frame', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields');
        type(inputFor('appearance.searchMatchColor'), 'rebeccapurple');
        await until(() => fieldRow('appearance.searchMatchColor').dataset.error !== undefined, 'the note');
        await route(h, 'general');
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields again');
        // The note belonged to a frame that has gone, so it does not come back with the row.
        expect(fieldRow('appearance.searchMatchColor').dataset.error).toBeUndefined();
        expect(
            fieldRow('appearance.searchMatchColor').querySelector<HTMLElement>('.message')!.hidden
        ).toBe(true);
    });

    it('draws a disabled field and edits nothing in it', async () => {
        const { surface, writes } = make({ disabled: ['general.worktreeBasePath'] });
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        expect(frameField(h, 'general.worktreeBasePath')?.disabled).toBe(true);
        const row = fieldRow('general.worktreeBasePath');
        expect(row.dataset.disabled).toBe('true');
        expect(inputFor('general.worktreeBasePath').disabled).toBe(true);
        expect(
            [...row.querySelectorAll<HTMLButtonElement>('.actions button')].every((node) => node.disabled)
        ).toBe(true);
        // The host refuses a disabled field on its own account too, so nothing here is the only
        // thing standing between a disabled row and a write.
        expect(() => h.send('ui.commitSettingsField', { fieldID: 'general.worktreeBasePath' })).toThrow(
            'That settings field cannot be changed right now.'
        );
        expect(writes).toEqual([]);
    });
});

describe('Settings Lab renders what the host refuses', () => {
    it('keeps an off-grid draft with the host error and writes nothing', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await route(h, 'appearance');
        await until(() => found('lab-settings-field').length > 0, 'the Appearance fields');
        // Straight down the SDK's pipe, because this view's own slider cannot produce the value:
        // the same shape the live scenario drives through an `inFrame` evaluation.
        await h.send('ui.setSettingsDraft', { fieldID: 'appearance.backgroundOpacity', text: '0.37' });
        await until(
            () => fieldRow('appearance.backgroundOpacity').dataset.error !== undefined,
            "the host's refusal"
        );
        const row = fieldRow('appearance.backgroundOpacity');
        expect(row.dataset.error).toBe('Background opacity must be in steps of 0.05.');
        expect(row.querySelector<HTMLElement>('.message')!.dataset.local).toBe('false');
        // The draft is KEPT and the error is explained, and the commit still writes nothing.
        expect(frameField(h, 'appearance.backgroundOpacity')?.draft).toBe('0.37');
        await h.send('ui.commitSettingsField', { fieldID: 'appearance.backgroundOpacity' });
        await flush();
        expect(writes).toEqual([]);
        expect(frameField(h, 'appearance.backgroundOpacity')?.draft).toBe('0.37');
    });

    it('keeps a line break out of a line-oriented config file', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        await h.send('ui.setSettingsDraft', {
            fieldID: 'general.worktreeBasePath',
            text: 'x\ncommand = /bin/true'
        });
        await until(() => fieldRow('general.worktreeBasePath').dataset.error !== undefined, 'the refusal');
        expect(fieldRow('general.worktreeBasePath').dataset.error).toBe(
            'Base path cannot contain line breaks or control characters.'
        );
        await h.send('ui.commitSettingsField', { fieldID: 'general.worktreeBasePath' });
        await flush();
        expect(writes).toEqual([]);
    });

    it('refuses a field the current frame never published', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        // The port row exists only while the listener is on, so it is not in this frame.
        expect(fieldIDs()).not.toContain('general.tcpPort');
        expect(() => h.send('ui.commitSettingsField', { fieldID: 'general.tcpPort' })).toThrow(
            'That settings field is not in the current section.'
        );
        // Another section's field, and a native section's, land in the same place.
        expect(() => h.send('ui.setSettingsDraft', { fieldID: 'appearance.fontFamily', text: 'Mono' })).toThrow(
            'That settings field is not in the current section.'
        );
        expect(writes).toEqual([]);
    });
});

describe('Settings Lab resets, closes and presents nothing when told to', () => {
    it('drops a draft through the host and leaves the committed value alone', async () => {
        const { surface, writes } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        type(inputFor('general.worktreeBasePath'), '/tmp/discarded');
        await until(() => one('lab-settings-dirty').dataset.count === '1', 'the dirty count');
        press('general.worktreeBasePath', 'lab-settings-reset');
        await until(() => one('lab-settings-dirty').dataset.count === '0', 'the cleared draft');
        expect(h.sent('ui.resetSettingsField')).toEqual([{ fieldID: 'general.worktreeBasePath' }]);
        expect(frameField(h, 'general.worktreeBasePath')?.draft).toBeUndefined();
        expect(inputFor('general.worktreeBasePath').value).toBe(DEFAULT_WS_SETTINGS.general.worktreeBasePath);
        expect(writes).toEqual([]);
    });

    it('closes the dialog through the only window verb a presenter has', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-close').length === 1, 'the Close button');
        one('lab-settings-close').click();
        await until(() => h.closed() === 1, 'the dialog close');
        expect(h.sent('ui.closeSettings')).toEqual([{}]);
        expect(h.failures).toEqual([]);
    });

    it('presents nothing while the placement is not painted, and keeps every draft', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        inputFor('general.worktreeBasePath').focus();
        type(inputFor('general.worktreeBasePath'), '/tmp/half-typed');
        await until(() => frameField(h, 'general.worktreeBasePath')?.draft === '/tmp/half-typed', 'the draft');
        h.show(false);
        await until(() => found('lab-settings').length === 0, 'the hidden placement');
        await flush();
        expect(h.lab().lastError).toBeNull();
        expect(h.failures).toEqual([]);
        expect(found('lab-settings-rail-item')).toHaveLength(0);
        expect(found('lab-settings-field')).toHaveLength(0);
        expect(found('lab-settings-native-note')).toHaveLength(0);
        expect(document.getElementById('root')!.hidden).toBe(true);
        expect(document.body.dataset.visible).toBe('false');
        // A mutating call while nothing is painted is a presenter acting on a window the user is
        // not looking at, so the host refuses it outright.
        expect(() => h.send('ui.commitSettingsField', { fieldID: 'general.worktreeBasePath' })).toThrow(
            'The Settings window is not presented right now.'
        );
        // The draft lives in the host, so it is still there when the placement paints again.
        h.show(true);
        await until(() => found('lab-settings-field').length > 0, 'the restored panel');
        expect(inputFor('general.worktreeBasePath').value).toBe('/tmp/half-typed');
        expect(one('lab-settings-dirty').dataset.count).toBe('1');
    });
});

describe('Settings Lab fails on purpose for the recovery paths', () => {
    it('throws inside the next frame when the crash hook is armed', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        h.lab().crash();
        const frames = h.lab().frames;
        surface.setSection('appearance');
        await until(() => h.thrown.length === 1, 'the armed crash');
        expect(h.thrown[0]!.message).toBe('Settings Lab crashed on purpose.');
        expect(h.lab().frames).toBe(frames + 1);
        expect(h.lab().lastError).toBe('Settings Lab crashed on purpose.');
        // The SDK catches a listener error, so the frame is still acknowledged - and nothing was
        // drawn for it: the panel still shows the section the crashed frame moved away from.
        expect(document.body.dataset.section).toBe('general');
        // The next frame renders again: one armed crash is one crash.
        surface.setDraft('appearance.fontFamily', 'Mono');
        await until(() => document.body.dataset.section === 'appearance', 'the frame after the crash');
        expect(h.thrown).toHaveLength(1);
    });

    it('rethrows an armed uncaught crash where the SDK reports it as a view error', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        // The SDK reports an uncaught error, never a caught listener error, so the escalated hook
        // schedules the rethrow outside the callback. Delayed timers stay real: `until` uses them.
        const scheduled: Array<() => void> = [];
        const real = globalThis.setTimeout;
        const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) =>
            ms === undefined ? (scheduled.push(callback), 0) : real(callback, ms)) as unknown as typeof globalThis.setTimeout);
        try {
            h.lab().crash('uncaught');
            surface.setSection('workspaces');
            await until(() => h.thrown.length === 1, 'the armed crash');
        } finally {
            timers.mockRestore();
        }
        expect(scheduled).toHaveLength(1);
        expect(() => scheduled[0]!()).toThrow('Settings Lab crashed on purpose.');
        expect(document.body.dataset.section).toBe('general');
    });

    it('stops acknowledging frames when the stall hook is armed', async () => {
        const { surface } = make();
        const h = await mount(surface);
        await ready(h);
        await until(() => found('lab-settings-field').length > 0, 'the General fields');
        // The control: a live presenter acknowledges every frame it is given, so the count has to
        // be seen moving before its standing still means anything.
        const before = h.acknowledged();
        surface.setSection('workspaces');
        await until(() => document.body.dataset.section === 'workspaces', 'the routed frame');
        await until(() => h.acknowledged() > before, 'a frame being acknowledged');
        const acknowledged = h.acknowledged();
        const frames = h.lab().frames;
        h.lab().stall();
        surface.setSection('appearance');
        await until(() => h.lab().frames > frames, 'the stalled frame');
        await flush();
        // The frame arrived and was never settled, so the host is still waiting for its
        // acknowledgement: this is the watchdog path, not a view error.
        expect(h.acknowledged()).toBe(acknowledged);
        // Nothing was drawn for it either: the panel still shows the section before the stall.
        expect(document.body.dataset.section).toBe('workspaces');
        expect(h.failures).toEqual([]);
        expect(h.thrown).toEqual([]);
    });
});
