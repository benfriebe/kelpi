/**
 * Who draws the Settings dialog, and what still works when that is not the selected presenter.
 *
 * The sibling of `interaction/InteractionHost.test.tsx`'s presenter half, and the same standing-in
 * trick: `PluginView` is replaced by a component that records the grant it was given and subscribes
 * to the feed the way the real bridge does, which is what arms the watchdogs. What the real bridge
 * does with that grant is `plugins/PluginView.ui.test.tsx`'s business; what is asserted here is who
 * the dialog mounts, what it keeps drawing itself, and what happens when the presenter stops
 * working.
 *
 * The four rules this file exists for:
 *
 *   1. A presenter draws the rail and the panel; the host keeps the frame, the toolbar, Close and
 *      Escape.
 *   2. A permanently native section is NEVER in the frame: the host draws it below the presenter,
 *      which is what keeps Plugins - and so the route to switching the presenter off - reachable.
 *   3. A failure hands the dialog back to the bundled panel on the SAME section with every draft
 *      intact, and writes nothing on the way out.
 *   4. Retry is the only thing that lifts a latch the window has not already moved past.
 */

import { DEFAULT_KEYBINDINGS } from '@kelpi/core/config';
import { DEFAULT_WS_SETTINGS, decodePluginManifest } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerModal } from '../chrome/modal-presence';
import { WorkbenchProvider } from '../plugins/Workbench';
import { BUNDLED_VIEWS, resolveSidebarViews, type ViewContribution } from '../plugins/registry';
import type { KelpiRuntime } from '../state';
import { SettingsOverlay } from './SettingsOverlay';
import {
    SETTINGS_PLACEMENT,
    clearSettingsPresenterFailure,
    noteSettingsPresenterFailure,
    resetSettingsPresenterFailures,
    settingsPresenterFailures,
    type SettingsPresenterHost,
    type SettingsPresenterSnapshot
} from './presenter';
import { settingsPresenterChords } from './presenter-slot';
import { createSettingsSurface, type SettingsSurface } from './surface';
import type { SettingsTabID } from './catalog';
import type { SettingsActions } from './types';
import { useSettingsSurface } from './use-settings';

interface MountedPresenter {
    viewID: string;
    visible?: boolean | undefined;
    focused?: boolean | undefined;
    claimedChords?: readonly string[] | undefined;
    settingsPresenter?: SettingsPresenterHost | undefined;
    onError?: ((message: string) => void) | undefined;
    frames: SettingsPresenterSnapshot[];
}
const view: { current: MountedPresenter | null } = { current: null };

vi.mock('../plugins/PluginView', () => ({
    PluginView: (props: MountedPresenter): ReactElement => {
        const frames = view.current?.frames ?? [];
        view.current = { ...props, frames };
        useEffect(
            () =>
                props.settingsPresenter?.subscribe((value) => {
                    frames.push(value);
                }),
            [props.settingsPresenter]
        );
        return (
            <div data-testid={`plugin-view-${props.viewID}`}>
                <iframe title="presenter frame" />
            </div>
        );
    }
}));

const PRESENTER_VIEW = 'sample.present.view';
const PRESENTER: ViewContribution = {
    ...decodePluginManifest({
        id: 'sample.present',
        version: '1.0.0',
        apiVersion: 1,
        trust: 'full',
        contributes: {
            views: [
                {
                    id: PRESENTER_VIEW,
                    title: 'Lab settings',
                    entry: 'ui/index.html',
                    placements: ['settings.window']
                }
            ]
        }
    }).contributes.views[0]!,
    pluginID: 'sample.present'
};

/** A connection whose status the test can move, so the disconnected fallback can be driven. */
const connection = { status: 'connected', listeners: new Set<(status: string) => void>() };
const runtime = {
    connection: {
        get status() {
            return connection.status;
        },
        on: (_event: string, listener: (status: string) => void) => {
            connection.listeners.add(listener);
            return () => connection.listeners.delete(listener);
        }
    }
} as unknown as KelpiRuntime;
const setConnection = (status: string): void => {
    connection.status = status;
    for (const listener of [...connection.listeners]) listener(status);
};

const actions = (): SettingsActions => ({
    setKeybinding: vi.fn(),
    resetKeybindings: vi.fn(),
    setGeneralSetting: vi.fn(),
    setGhosttySetting: vi.fn(),
    setProfiles: vi.fn(),
    addLabelPreset: vi.fn(),
    updateLabelPreset: vi.fn(),
    removeLabelPreset: vi.fn()
});

const surfaces: SettingsSurface[] = [];

function Selected(props: {
    readonly children: ReactNode;
    readonly views?: readonly ViewContribution[];
    readonly selected?: boolean;
}): ReactElement {
    const views = props.views ?? [...BUNDLED_VIEWS, PRESENTER];
    const selections = props.selected === false ? {} : { [SETTINGS_PLACEMENT]: PRESENTER_VIEW };
    return (
        <WorkbenchProvider
            runtime={runtime}
            chords={[]}
            layout={{
                views,
                selections,
                activeTabs: {},
                sidebars: resolveSidebarViews(views, selections),
                select: () => {},
                activateTab: () => {}
            }}
        >
            {props.children}
        </WorkbenchProvider>
    );
}

/** A daemon whose TCP bind failed and whose CLI-compat socket is owned by another Kelpi. */
const DEGRADED_TRANSPORT = {
    tcp: { requested: 19400, host: '127.0.0.1', bound: null, error: 'listen EADDRINUSE' },
    compat: { path: '/tmp/kelpi.sock', error: 'in use' }
};

function setup(
    options: {
        presenters?: boolean;
        selected?: boolean;
        settings?: typeof DEFAULT_WS_SETTINGS;
        surface?: SettingsSurface;
        transport?: typeof DEGRADED_TRANSPORT;
        modalPresence?: number;
    } = {}
) {
    const verbs = actions();
    const settings = options.settings ?? DEFAULT_WS_SETTINGS;
    const surface =
        options.surface ??
        createSettingsSurface({ settings: () => settings, actions: () => verbs });
    if (options.surface === undefined) surfaces.push(surface);
    const onClose = vi.fn();
    const failures: string[] = [];
    render(
        <Selected {...(options.selected === false ? { selected: false } : {})}>
            <SettingsOverlay
                open
                settings={settings}
                domain={{ labelPresets: [], workspaces: [] }}
                actions={verbs}
                surface={surface}
                presenters={options.presenters ?? true}
                presenterChords={settingsPresenterChords(DEFAULT_KEYBINDINGS)}
                {...(options.transport === undefined ? {} : { transport: options.transport })}
                {...(options.modalPresence === undefined ? {} : { modalPresence: options.modalPresence })}
                onPresenterFailure={(detail) => failures.push(detail)}
                onClose={onClose}
                pluginContent={<div data-testid="plugins-settings">Plugins</div>}
            />
        </Selected>
    );
    return { surface, verbs, onClose, failures };
}

const presenter = (): MountedPresenter => {
    const current = view.current;
    if (current === null) throw new Error('no presenter mounted');
    return current;
};
const drawnBy = (): string | undefined =>
    screen.getByTestId('settings-presenter').dataset['settingsPresenter'];

afterEach(() => {
    cleanup();
    for (const surface of surfaces.splice(0)) surface.dispose();
    resetSettingsPresenterFailures();
    view.current = null;
    setConnection('connected');
    vi.useRealTimers();
});

describe('a selected Settings presenter', () => {
    it('draws the rail and the panel, and the host keeps the dialog', () => {
        setup();
        expect(drawnBy()).toBe(PRESENTER_VIEW);
        expect(screen.getByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeTruthy();
        // The rail and the panel are the presenter's now…
        expect(screen.queryByTestId('settings-tabs')).toBeNull();
        expect(screen.queryByTestId('settings-panel')).toBeNull();
        // …and everything that makes this a modal dialog is still the host's.
        expect(screen.getByRole('dialog', { name: 'Settings' }).getAttribute('aria-modal')).toBe('true');
        expect(screen.getByTestId('settings-toolbar')).toBeTruthy();
        expect(screen.getByTestId('settings-close')).toBeTruthy();
        expect(presenter().visible).toBe(true);
        expect(presenter().focused).toBe(true);
        // The small relayed set, never `allViewChords`.
        expect(presenter().claimedChords).toEqual(['0/Escape', '8/KeyW']);
    });

    it('is granted a frame for the routed section only', async () => {
        const { surface } = setup();
        await act(async () => {
            await Promise.resolve();
        });
        const frame = presenter().frames.at(-1);
        expect(frame).toMatchObject({ placement: SETTINGS_PLACEMENT, visible: true, sectionID: 'general' });
        expect(frame?.fields.map((field) => field.id)).toContain('general.worktreeBasePath');
        act(() => {
            surface.setSection('workspaces');
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(presenter().frames.at(-1)?.sectionID).toBe('workspaces');
    });

    /**
     * A route the SURFACE never heard about.
     *
     * `App` holds `settingsTab`, so ⌘, , the ••• menu, the palette and every deep link ("Manage
     * labels…", Help's keybindings link, "Manage favourites…") move the section through React state
     * with no call into the surface at all - and therefore no notification for the model to hear.
     * The slot reads the routed section on every render, which is exactly when that state has
     * landed, and refreshes the model the way it does for its own paint decision.
     */
    it('publishes a frame when the host routes through its own state', async () => {
        const verbs = actions();
        function Routed(): ReactElement {
            const [tab, setTab] = useState<SettingsTabID>('general');
            const surface = useSettingsSurface({
                settings: () => DEFAULT_WS_SETTINGS,
                actions: () => verbs,
                section: { get: () => tab, set: (id) => setTab(id) }
            });
            return (
                <Selected>
                    <SettingsOverlay
                        open
                        settings={DEFAULT_WS_SETTINGS}
                        domain={{ labelPresets: [], workspaces: [] }}
                        actions={verbs}
                        surface={surface}
                        presenters
                        onClose={vi.fn()}
                        pluginContent={<div data-testid="plugins-settings">Plugins</div>}
                    />
                    {/* Somebody else's route: the menu, the palette, a deep link. */}
                    <button
                        type="button"
                        data-testid="deep-link"
                        onClick={() => {
                            setTab('labels');
                        }}
                    />
                </Selected>
            );
        }
        render(<Routed />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(presenter().frames.at(-1)?.sectionID).toBe('general');

        await act(async () => {
            fireEvent.click(screen.getByTestId('deep-link'));
            await Promise.resolve();
        });
        expect(presenter().frames.at(-1)).toMatchObject({ sectionID: 'labels', native: true });
        expect(presenter().frames.at(-1)?.fields).toEqual([]);
        // …and the host is drawing it, below the frame, as it does for every native section.
        expect(screen.getByTestId('settings-native-remainder').textContent).toContain('Label');
    });

    /**
     * The recovery floor, and the reason Plugins is permanently native: the section that carries
     * "Restore bundled views" and "Retry presenter" is drawn by the HOST, below the frame, so a
     * presenter cannot hide the route to its own removal.
     */
    it('never puts a native section in the frame, and draws it below instead', async () => {
        const { surface } = setup();
        act(() => {
            // Routed by the presenter itself, which is the gesture a user makes on its rail.
            presenter().settingsPresenter!.call('ui.setSettingsSection', { id: 'plugins' });
        });
        expect(surface.getSection()).toBe('plugins');
        await act(async () => {
            await Promise.resolve();
        });
        const frame = presenter().frames.at(-1);
        expect(frame).toMatchObject({ sectionID: 'plugins', native: true });
        expect(frame?.fields).toEqual([]);
        // The host draws it, in the dialog, below the presenter.
        const remainder = screen.getByTestId('settings-native-remainder');
        expect(remainder.contains(screen.getByTestId('plugins-settings'))).toBe(true);
        expect(drawnBy()).toBe(PRESENTER_VIEW);
    });

    /**
     * General has a remainder too, and it is the one that was nearly missed: the failed-bind line
     * and the CLI-compat note report an OUTCOME the daemon sent rather than a value anything can
     * write, so they have no descriptors - and they are exactly what a user goes looking for when
     * `KELPI_SOCKET=tcp:…` stops answering. A presenter must not be able to make them disappear.
     */
    it('keeps General’s outcome rows and footer in the host’s remainder', async () => {
        const { surface } = setup({ transport: DEGRADED_TRANSPORT });
        act(() => {
            surface.setSection('general');
        });
        await act(async () => {
            await Promise.resolve();
        });
        const frame = presenter().frames.at(-1);
        expect(frame).toMatchObject({ sectionID: 'general', native: true });
        expect(frame?.fields.map((field) => field.id)).toContain('general.worktreeBasePath');

        const remainder = screen.getByTestId('settings-native-remainder');
        expect(remainder.contains(screen.getByTestId('tcp-bind-error'))).toBe(true);
        expect(remainder.contains(screen.getByTestId('compat-degraded-note'))).toBe(true);
        expect(remainder.textContent).toContain('Config:');
        expect(remainder.textContent).toContain('Focus-follows-mouse and the two confirmation dialogs');
        // …and the projected rows are the presenter's, drawn once.
        expect(screen.queryByTestId('worktree-base-path')).toBeNull();
        expect(screen.queryByTestId('general-worktrees')).toBeNull();
    });

    it('keeps Workspaces’ footer in the host’s remainder', async () => {
        const { surface } = setup();
        act(() => {
            surface.setSection('workspaces');
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(presenter().frames.at(-1)).toMatchObject({ sectionID: 'workspaces', native: true });
        const remainder = screen.getByTestId('settings-native-remainder');
        expect(remainder.textContent).toContain('Config:');
        expect(remainder.textContent).toContain('Worktree paths, repository auto-detection');
        expect(screen.queryByTestId('confirm-delete-toggle')).toBeNull();
    });

    /** Appearance is the partly projected one: the frame gets the rows, the host draws the rest. */
    it('splits a partly projected section between the frame and the host', async () => {
        const { surface } = setup();
        act(() => {
            surface.setSection('appearance');
        });
        await act(async () => {
            await Promise.resolve();
        });
        const frame = presenter().frames.at(-1);
        expect(frame).toMatchObject({ sectionID: 'appearance', native: true });
        expect(frame?.fields.map((field) => field.id)).toContain('appearance.fontSize');
        const remainder = screen.getByTestId('settings-native-remainder');
        // The hand-built parts are in the host's DOM…
        expect(remainder.contains(screen.getByTestId('theme-preset-nord'))).toBe(true);
        expect(remainder.contains(screen.getByTestId('sidebar-group-fill'))).toBe(true);
        expect(remainder.contains(screen.getByTestId('chrome-color-accent'))).toBe(true);
        // …and the projected rows are not drawn twice.
        expect(screen.queryByTestId('terminal-font-family')).toBeNull();
        expect(screen.queryByTestId('sidebar-avatar-fill')).toBeNull();
        expect(screen.queryByTestId('appearance-chrome')).toBeNull();
    });

    /**
     * Containment is the WRAPPER's job: a dialog keeps focus inside itself, and a frame that has
     * been given the panel is held the same way. It yields to a modal PEER, and it has to - the
     * palette, a prompt and the quit dialog can all be raised over Settings, and that is the route
     * this page is recoverable by.
     */
    it('keeps the caret in the frame, and yields it to a modal peer', () => {
        setup();
        const frame = screen.getByTitle('presenter frame');
        const outside = document.createElement('button');
        document.body.append(outside);
        const focus = vi.spyOn(frame, 'focus');
        act(() => {
            outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        });
        expect(focus).toHaveBeenCalled();

        let release = (): void => {};
        act(() => {
            release = registerModal();
        });
        focus.mockClear();
        act(() => {
            outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        });
        expect(focus).not.toHaveBeenCalled();
        act(() => {
            release();
        });
        outside.remove();
    });

    /**
     * A peer that was ALREADY up when the presenter started painting.
     *
     * The reason the peer test is against the host's own registration rather than a baseline
     * latched at first paint: a palette open over Settings when the dialog re-renders would have
     * been latched in as "just us", and the presenter would then have pulled the caret out of the
     * surface in front of it on every focus change.
     */
    it('stands down from the start when a peer is already up', () => {
        const release = registerModal();
        setup();
        const frame = screen.getByTitle('presenter frame');
        const outside = document.createElement('button');
        document.body.append(outside);
        const focus = vi.spyOn(frame, 'focus');
        act(() => {
            outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        });
        expect(focus).not.toHaveBeenCalled();
        act(() => {
            release();
        });
        act(() => {
            outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        });
        expect(focus).toHaveBeenCalled();
        outside.remove();
    });

    /**
     * Nothing is presented once the dialog is gone.
     *
     * The model is disposed a microtask after the unmount (StrictMode rehearses every effect), so
     * between the two it must not claim to be painting: `visible` is what every mutating call is
     * checked against, and a closed dialog accepting a write is the same defect as a hidden one.
     */
    it('refuses calls between the unmount and the model’s disposal', () => {
        const { surface } = setup();
        const host = presenter().settingsPresenter!;
        cleanup();
        expect(() => host.call('ui.setSettingsSection', { id: 'workspaces' })).toThrow(
            'not presented right now'
        );
        expect(() => host.call('ui.closeSettings', {})).toThrow('not presented right now');
        expect(host.getSettingsPresentation().visible).toBe(false);
        expect(surface.getSection()).toBe('general');
    });

    /**
     * The two boxes do not split the dialog.
     *
     * Both were `flex-1` at first, so they took half the body each whatever they held: General's
     * remainder is two sentences and a footer, and it pushed the presenter's panel into half a
     * dialog it then scrolled inside. The remainder is content-sized with a ceiling; the frame takes
     * the rest.
     */
    it('sizes the remainder to its content and gives the frame the rest', async () => {
        const { surface } = setup();
        act(() => {
            surface.setSection('general');
        });
        await act(async () => {
            await Promise.resolve();
        });
        const remainder = screen.getByTestId('settings-native-remainder');
        // `flex: none`, as the engine spells it back: no grow, no shrink, a content basis.
        expect(remainder.style.flexGrow).toBe('0');
        expect(remainder.style.flexShrink).toBe('0');
        expect(remainder.style.flexBasis).toBe('auto');
        expect(remainder.style.maxHeight).toBe('45%');
        expect(remainder.className).not.toContain('flex-1');
        // It keeps its own scroller, which is what the ceiling is for.
        expect(remainder.className).toContain('overflow-y-auto');
        // …and the frame is the one that grows, with a floor of nothing rather than an overflow.
        const frame = screen.getByTestId('settings-presenter');
        expect(frame.className).toContain('flex-1');
        expect(frame.className).toContain('min-h-0');
    });

    it('closes the dialog through the host, by call and by relayed Escape', () => {
        const { onClose } = setup();
        act(() => {
            presenter().settingsPresenter!.call('ui.closeSettings', {});
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        // An Escape pressed inside the frame arrives as a window event, which the dialog's own
        // React handler never sees; the slot's capture listener is what turns it into Close.
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(onClose).toHaveBeenCalledTimes(2);

        // An Escape typed at a real element is somebody else's - the dialog's own `onKeyDown`, or
        // whatever surface has the caret. The relay only ever answers a key with no element behind
        // it, which is what a re-dispatched chord looks like.
        const outside = document.createElement('button');
        document.body.append(outside);
        act(() => {
            outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(onClose).toHaveBeenCalledTimes(2);
        outside.remove();

        // …and while a modal peer is up (a palette, a prompt, the quit dialog) the relay stands
        // down entirely: that surface answers Escape itself, and two capture-phase listeners racing
        // for one key is how the wrong thing closes.
        let release = (): void => {};
        act(() => {
            release = registerModal();
        });
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(onClose).toHaveBeenCalledTimes(2);
        act(() => {
            release();
        });
    });
});

describe('the recovery floor', () => {
    it('hands the dialog back on a view error, on the same section, with the draft intact', async () => {
        const { surface, verbs, failures } = setup();
        act(() => {
            surface.setSection('general');
            // Half-typed, and never committed: the draft lives in the surface, not in whoever is
            // painting, which is the whole reason a presenter may be replaced mid-edit.
            presenter().settingsPresenter!.call('ui.setSettingsDraft', {
                fieldID: 'general.worktreeBasePath',
                text: '~/half-typed'
            });
        });
        act(() => {
            presenter().onError?.('the view crashed');
        });
        expect(drawnBy()).toBe('bundled');
        expect(failures).toEqual(['the view crashed']);
        // Same section, same draft, and nothing written on the way out.
        expect(surface.getSection()).toBe('general');
        expect(screen.getByTestId('settings-tabs')).toBeTruthy();
        expect((screen.getByTestId('worktree-base-path-input') as HTMLInputElement).value).toBe('~/half-typed');
        expect(verbs.setGeneralSetting).not.toHaveBeenCalled();
        expect(settingsPresenterFailures()[SETTINGS_PLACEMENT]?.detail).toBe('the view crashed');
        await act(async () => {
            await Promise.resolve();
        });
    });

    it('keeps the bundled panel until Retry clears the latch', () => {
        setup();
        act(() => {
            presenter().onError?.('the view crashed');
        });
        expect(drawnBy()).toBe('bundled');
        act(() => {
            clearSettingsPresenterFailure(SETTINGS_PLACEMENT);
        });
        expect(drawnBy()).toBe(PRESENTER_VIEW);
    });

    it('fails the placement when the presenter never reports that it painted', async () => {
        vi.useFakeTimers();
        const { failures } = setup();
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            vi.advanceTimersByTime(5_000);
        });
        expect(failures).toEqual(['The settings presenter did not report that it had painted.']);
        expect(drawnBy()).toBe('bundled');
    });

    it('fails the placement when it stops acknowledging the frames that move the user', async () => {
        vi.useFakeTimers();
        const { surface, failures } = setup();
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            // Painted, and the first frame - the one carrying the section the dialog opened on -
            // acknowledged. Both windows are then closed and nothing is being waited for.
            presenter().settingsPresenter!.call('ui.reportPresenterReady', {});
            presenter().settingsPresenter!.noteAcknowledged();
        });
        act(() => {
            vi.advanceTimersByTime(5_000);
        });
        expect(failures).toEqual([]);
        act(() => {
            surface.setSection('workspaces');
        });
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            presenter().settingsPresenter!.noteAcknowledged();
            vi.advanceTimersByTime(5_000);
        });
        expect(failures).toEqual([]);
        act(() => {
            surface.setSection('general');
        });
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            vi.advanceTimersByTime(5_000);
        });
        expect(failures).toEqual(['The settings presenter stopped acknowledging window updates.']);
        expect(drawnBy()).toBe('bundled');
    });

    /**
     * The bundled dialog is the markup it always was, node for node.
     *
     * The slot wraps it in a `display: contents` div so the rail and the panel keep participating in
     * the dialog's own flex column; if that wrapper ever grew a box, or the branch ever rendered
     * something else, this is where it would show.
     */
    it('draws exactly the surface-less markup inside the display-contents wrapper', () => {
        const verbs = actions();
        const surface = createSettingsSurface({
            settings: () => DEFAULT_WS_SETTINGS,
            actions: () => verbs
        });
        surfaces.push(surface);
        render(
            <Selected selected={false}>
                <SettingsOverlay
                    open
                    settings={DEFAULT_WS_SETTINGS}
                    domain={{ labelPresets: [], workspaces: [] }}
                    actions={verbs}
                    surface={surface}
                    presenters
                    onClose={vi.fn()}
                />
            </Selected>
        );
        const wrapper = screen.getByTestId('settings-presenter');
        expect(wrapper.dataset['settingsPresenter']).toBe('bundled');
        expect(wrapper.style.display).toBe('contents');
        const wrapped = wrapper.innerHTML;
        cleanup();

        // The same dialog with no surface at all: the overlay holds the selection itself and the
        // slot is not in the tree.
        render(
            <SettingsOverlay
                open
                settings={DEFAULT_WS_SETTINGS}
                domain={{ labelPresets: [], workspaces: [] }}
                actions={verbs}
                onClose={vi.fn()}
            />
        );
        const dialog = screen.getByTestId('settings-window');
        // [toolbar, the rail-and-panel row] - the row is what the wrapper wraps.
        expect(dialog.children).toHaveLength(2);
        expect(wrapped).toBe(dialog.children[1]?.outerHTML);
    });

    it('draws the bundled panel with no presenter selected, on a phone, and while disconnected', () => {
        const nothing = setup({ selected: false });
        expect(drawnBy()).toBe('bundled');
        expect(screen.getByTestId('settings-tabs')).toBeTruthy();
        nothing.surface.dispose();
        cleanup();

        // A phone keeps the bundled sheet: the two-screen push navigation and the software-keyboard
        // inset are not things a frame can read.
        const phone = setup({ presenters: false });
        expect(drawnBy()).toBe('bundled');
        phone.surface.dispose();
        cleanup();

        // A presenter behind PluginView's "Connecting to daemon…" placeholder would paint that
        // inside the dialog.
        setup();
        expect(drawnBy()).toBe(PRESENTER_VIEW);
        act(() => {
            setConnection('connecting');
        });
        expect(drawnBy()).toBe('bundled');
        act(() => {
            setConnection('connected');
        });
        expect(drawnBy()).toBe(PRESENTER_VIEW);
    });

    /**
     * A latch belongs to ONE generation (`viewID:revision:instanceID`), so a reload, a rollback or a
     * different selection supersedes it by moving the generation - and the Settings row has to stop
     * reporting a failure the window has already moved past.
     */
    it('clears a latch that belongs to a generation this window has moved past', () => {
        noteSettingsPresenterFailure(SETTINGS_PLACEMENT, 'sample.other.view::', 'an earlier presenter crashed');
        setup();
        expect(drawnBy()).toBe(PRESENTER_VIEW);
        expect(settingsPresenterFailures()[SETTINGS_PLACEMENT]).toBeUndefined();
    });
});
