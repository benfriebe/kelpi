import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useEffect, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modalPresenceCount, overlayPresenceCount, registerModal } from '../chrome/modal-presence';
import { decodePluginManifest } from '@kelpi/protocol';
import { DEFAULT_KEYBINDINGS } from '@kelpi/core/config';
import type { KelpiRuntime } from '../state';
import { WorkbenchProvider } from '../plugins/Workbench';
import { BUNDLED_VIEWS, resolveSidebarViews, type ViewContribution } from '../plugins/registry';
import { InteractionHost } from './InteractionHost';
import { resetInteractionPresenterFailures, type InteractionPresenterHost, type InteractionPresenterSnapshot } from './presenter';
import { interactionPresenterChords } from './presenter-slot';
import { createInteractionSurface, type InteractionScope, type InteractionSurface, type InteractionSurfaceConfig } from './surface';
import { useInteractionSurface } from './use-interaction';

const surfaces: InteractionSurface[] = [];
const nativeOwner = (id = 'native:shortcut') => ({ id, kind: 'native' as const, displayName: 'Command Palette' });

/**
 * The mounted presenter, standing in for the isolated view: it records the grant it was given and
 * subscribes to the feed the way `PluginView`'s bridge does, which is what arms the watchdogs.
 * The real bridge is `plugins/PluginView.ui.test.tsx`'s business; what is asserted here is who the
 * host mounts, what it grants and what it does when that presenter stops working.
 */
interface MountedPresenter {
    viewID: string;
    visible?: boolean | undefined;
    focused?: boolean | undefined;
    claimedChords?: readonly string[] | undefined;
    presenter?: InteractionPresenterHost | undefined;
    onError?: ((message: string) => void) | undefined;
    frames: InteractionPresenterSnapshot[];
}
const view: { current: MountedPresenter | null } = { current: null };

vi.mock('../plugins/PluginView', () => ({
    PluginView: (props: MountedPresenter): ReactElement => {
        const frames = view.current?.frames ?? [];
        view.current = { ...props, frames };
        useEffect(() => props.presenter?.subscribe(value => { frames.push(value); }), [props.presenter]);
        return <div data-testid={`plugin-view-${props.viewID}`}><iframe title="presenter frame" /></div>;
    }
}));

const PRESENTER_VIEW = 'sample.present.view';
const PRESENTER: ViewContribution = {
    ...decodePluginManifest({ id: 'sample.present', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: PRESENTER_VIEW, title: 'Lab presenter', entry: 'ui/index.html', placements: ['interaction.palette', 'interaction.prompts'] }]
    } }).contributes.views[0]!,
    pluginID: 'sample.present'
};
/** A connection whose status the test can move, so the disconnected fallback can be driven. */
const connection = { status: 'connected', listeners: new Set<(status: string) => void>() };
const runtime = { connection: {
    get status() { return connection.status; },
    on: (_event: string, listener: (status: string) => void) => {
        connection.listeners.add(listener);
        return () => connection.listeners.delete(listener);
    }
} } as unknown as KelpiRuntime;
const setConnection = (status: string): void => {
    connection.status = status;
    for (const listener of [...connection.listeners]) listener(status);
};

/** A workbench with the presenter selected for the prompts placement, and nothing else moved. */
function Selected({ children, views = [...BUNDLED_VIEWS, PRESENTER] }: { children: ReactNode; views?: readonly ViewContribution[] }): ReactElement {
    const selections = { 'interaction.prompts': PRESENTER_VIEW } as const;
    return <WorkbenchProvider runtime={runtime} chords={[]} layout={{
        views, selections, activeTabs: {}, sidebars: resolveSidebarViews(views, selections),
        select: () => {}, activateTab: () => {}
    }}>{children}</WorkbenchProvider>;
}

function setupSelected(config: InteractionSurfaceConfig = {}, options: { presenters?: boolean; strict?: boolean } = {}): { surface: InteractionSurface; scope: InteractionScope } {
    const surface = createInteractionSurface({ focus: { paneHandoff: spy(), handBackCaret: spy(), fallbackPaneID: () => 'pane-focused' }, ...config });
    surfaces.push(surface);
    const scope = surface.createScope({ id: 'view', pluginID: 'example.test', pluginName: 'Test Plugin' });
    const tree = <Selected><InteractionHost surface={surface} presenters={options.presenters ?? true} chords={['0/Escape', '8/KeyW']} /></Selected>;
    render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree);
    return { surface, scope };
}

const spy = () => vi.fn((_paneID: string | null): void => {});
type Focus = { readonly paneHandoff: ReturnType<typeof spy>; readonly handBackCaret: ReturnType<typeof spy>; fallbackPaneID(): string | null };

function setup(config: InteractionSurfaceConfig = {}): { surface: InteractionSurface; scope: InteractionScope; focus: Focus } {
    const focus: Focus = { paneHandoff: spy(), handBackCaret: spy(), fallbackPaneID: () => 'pane-focused' };
    const surface = createInteractionSurface({ focus, ...config });
    surfaces.push(surface);
    const scope = surface.createScope({ id: 'view', pluginID: 'example.test', pluginName: 'Test Plugin' });
    render(<InteractionHost surface={surface} />);
    return { surface, scope, focus };
}
afterEach(() => {
    cleanup();
    for (const surface of surfaces.splice(0)) surface.dispose();
    document.body.replaceChildren();
    resetInteractionPresenterFailures();
    view.current = null;
    connection.status = 'connected';
    connection.listeners.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('shared window prompts', () => {
    it('filters choices, skips disabled rows with arrows, and returns the selected ID on Enter', async () => {
        const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
        const { scope } = setup(); let result!: Promise<unknown>;
        act(() => { result = scope.request('ui.showQuickPick', { title: 'Choose tool', items: [
            { id: 'one', label: 'Git status' }, { id: 'disabled', label: 'Git disabled', disabled: true },
            { id: 'two', label: 'Git diff', description: '<script>not executable</script>' }, { id: 'other', label: 'Terminal' }
        ] }); });
        expect(document.activeElement).toBe(screen.getByRole('combobox'));
        expect(modalPresenceCount()).toBe(1);
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'git' } });
        expect(screen.queryByRole('option', { name: 'Terminal' })).toBeNull();
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
        expect(screen.getByRole('option', { name: /Git diff/ }).getAttribute('aria-selected')).toBe('true');
        expect(document.querySelector('script')).toBeNull();
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
        await expect(result).resolves.toBe('two');
        expect(modalPresenceCount()).toBe(0);
        expect(document.activeElement).toBe(trigger);
    });

    it('traps Tab, accepts an empty password input, and preserves focus through the next queued prompt', async () => {
        const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
        const { scope } = setup(); let first!: Promise<unknown>, next!: Promise<unknown>;
        act(() => {
            first = scope.request('ui.showInput', { title: 'Secret', password: true, value: 'initial', maxLength: 30 });
            next = scope.request('ui.showInput', { title: 'Next' });
        });
        const input = screen.getByLabelText('Secret', { selector: 'input' }) as HTMLInputElement;
        expect(input.type).toBe('password'); expect(input.maxLength).toBe(30);
        fireEvent.change(input, { target: { value: '' } });
        screen.getByRole('button', { name: 'Continue' }).focus();
        fireEvent.keyDown(window, { key: 'Tab' });
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss prompt' }));
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        await expect(first).resolves.toBe('');
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Next' }));
        fireEvent.keyDown(window, { key: 'Escape' });
        await expect(next).resolves.toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('returns only explicit dialog action IDs; Escape and backdrop cancellation return null', async () => {
        const { scope } = setup();
        const options = { title: 'Delete item?', message: 'Choose an action.', actions: [{ id: 'delete', label: 'Delete', kind: 'danger' }, { id: 'keep', label: 'Keep' }], cancelID: 'keep' };
        let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showDialog', options); });
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete' })); await expect(answer).resolves.toBe('delete');
        act(() => { answer = scope.request('ui.showDialog', options); });
        fireEvent.keyDown(window, { key: 'Escape' }); await expect(answer).resolves.toBeNull();
        act(() => { answer = scope.request('ui.showDialog', options); });
        fireEvent.click(screen.getByTestId('plugin-ui-backdrop')); await expect(answer).resolves.toBeNull();
    });

    it('cancels an active prompt, its queued request and its notification when the owner disappears', async () => {
        const { scope } = setup(); let results!: Promise<unknown>[];
        act(() => { results = [scope.request('ui.showInput', { title: 'Active' }), scope.request('ui.showInput', { title: 'Queued' }), scope.request('ui.showNotification', { message: 'Notice' })]; });
        expect(modalPresenceCount()).toBe(1);
        act(() => scope.dispose());
        await expect(Promise.all(results)).resolves.toEqual([null, null, null]);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByTestId('plugin-ui-notification')).toBeNull();
        expect(modalPresenceCount()).toBe(0);
    });

    it('waits behind an existing modal, suspends for a new modal, and resumes the edited value without competing traps', async () => {
        let release = registerModal();
        const { scope } = setup(); let answer!: Promise<unknown>;
        try {
            act(() => { answer = scope.request('ui.showInput', { title: 'Queued prompt' }); });
            expect(screen.queryByRole('dialog')).toBeNull(); expect(modalPresenceCount()).toBe(1);
            act(() => release());
            fireEvent.change(screen.getByRole('textbox', { name: 'Queued prompt' }), { target: { value: 'preserve me' } });
            act(() => { release = registerModal(); });
            expect(screen.queryByRole('dialog')).toBeNull(); expect(modalPresenceCount()).toBe(1);
            expect(screen.getByTestId('plugin-ui-backdrop').style.display).toBe('none');
            act(() => release());
            expect((screen.getByRole('textbox', { name: 'Queued prompt' }) as HTMLInputElement).value).toBe('preserve me');
            expect(modalPresenceCount()).toBe(1);
            fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
            await expect(answer).resolves.toBe('preserve me');
            expect(modalPresenceCount()).toBe(0);
        } finally { release(); }
    });

    it('keeps notifications actionable without taking focus or registering a window modal', async () => {
        const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
        const { scope } = setup(); let result!: Promise<unknown>;
        act(() => { result = scope.request('ui.showNotification', { message: 'Saved', tone: 'success', actions: [{ id: 'open', label: 'Open saved item' }] }); });
        // §2.6: a toast in the corner registers WHERE it is, not the whole window.
        expect(modalPresenceCount()).toBe(0); expect(overlayPresenceCount()).toBe(1);
        expect(document.activeElement).toBe(trigger);
        fireEvent.click(screen.getByRole('button', { name: 'Open saved item' }));
        await expect(result).resolves.toBe('open'); expect(overlayPresenceCount()).toBe(0);
    });

    it('survives StrictMode rehearsal and resolves pending work on actual window disposal', async () => {
        let surface!: InteractionSurface;
        function Host(): ReactElement { surface = useInteractionSurface(); return <InteractionHost surface={surface} />; }
        const view = render(<StrictMode><Host /></StrictMode>);
        await act(async () => { await Promise.resolve(); });
        const scope = surface.createScope({ id: 'view', pluginID: 'example.test', pluginName: 'Test' });
        let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showInput', { title: 'Still usable' }); });
        expect(modalPresenceCount()).toBe(1);
        view.unmount();
        await expect(answer).resolves.toBeNull();
        expect(modalPresenceCount()).toBe(0);
    });
});

describe('the host’s key policy', () => {
    it('cancels on Escape and on the rebound close chord, and stands down while an IME is composing', async () => {
        const { surface, scope } = setup(); let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showQuickPick', { title: 'Choose', items: [{ id: 'one', label: 'One' }] }); });
        // A keydown that COMMITS a composition is the composition's: neither confirm nor cancel.
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true });
        fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
        let settled = false;
        void answer.then(() => { settled = true; });
        await act(async () => { await Promise.resolve(); });
        expect(settled).toBe(false);
        expect(screen.getByRole('dialog')).toBeTruthy();

        fireEvent.keyDown(window, { key: 'Escape' });
        await expect(answer).resolves.toBeNull();

        // The rebindable `close_pane` chord reaches the same authority through the dispatcher.
        let second!: Promise<unknown>;
        act(() => { second = scope.request('ui.showInput', { title: 'Chord' }); });
        act(() => { expect(surface.dismissTopmost()).toBe(true); });
        await expect(second).resolves.toBeNull();
        expect(modalPresenceCount()).toBe(0);
    });
});

describe('one registration for either surface', () => {
    it('holds exactly one modal while the palette or a prompt is painted, and none after', async () => {
        const { surface, scope } = setup();
        expect(modalPresenceCount()).toBe(0);
        const session = act(() => surface.palette.open(nativeOwner())) as unknown as string;
        expect(modalPresenceCount()).toBe(1);

        let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showInput', { title: 'Queued behind the palette' }); });
        // The palette outranks a queued prompt, and the two share the ONE registration.
        expect(modalPresenceCount()).toBe(1);
        expect(screen.getByTestId('plugin-ui-backdrop').hidden).toBe(true);

        act(() => surface.palette.dismiss(surface.palette.getSnapshot().sessionID ?? session, 'user'));
        expect(modalPresenceCount()).toBe(1);
        expect(screen.getByTestId('plugin-ui-backdrop').hidden).toBe(false);

        fireEvent.keyDown(window, { key: 'Escape' });
        await expect(answer).resolves.toBeNull();
        expect(modalPresenceCount()).toBe(0);
    });
});

describe('the focus authority', () => {
    it('cancels a pending palette handoff the moment a queued prompt becomes visible', async () => {
        vi.useFakeTimers();
        const { surface, scope, focus } = setup();
        surface.palette.open(nativeOwner());
        const session = surface.palette.getSnapshot().sessionID!;
        let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showInput', { title: 'Queued behind the palette' }); });
        act(() => surface.palette.dismiss(session, 'user'));
        // Defect (2): the handoff would otherwise fire 200 ms later into a pane BEHIND this prompt.
        expect(screen.getByTestId('plugin-ui-backdrop').hidden).toBe(false);
        expect(surface.hasPendingPaneHandoff()).toBe(false);
        act(() => { vi.advanceTimersByTime(1000); });
        expect(focus.paneHandoff).not.toHaveBeenCalled();
        act(() => { surface.answer(surface.getSnapshot().activeModal!.id, null); });
        await expect(answer).resolves.toBeNull();
    });

    it('leaves the caret to a pending palette handoff instead of releasing it a second time', () => {
        vi.useFakeTimers();
        const { surface, focus } = setup();
        act(() => { surface.palette.open(nativeOwner()); });
        const session = surface.palette.getSnapshot().sessionID!;
        act(() => surface.palette.dismiss(session, 'user'));
        // Precedence (a): §10.4's handoff is already scheduled, so the host does not ALSO release
        // the caret - one authority, one hand-back.
        expect(surface.hasPendingPaneHandoff()).toBe(true);
        expect(focus.handBackCaret).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(200); });
        expect(focus.paneHandoff).toHaveBeenCalledWith('pane-focused');
        expect(focus.paneHandoff).toHaveBeenCalledTimes(1);
    });

    it.each(['removed', 'hidden', 'offscreen', 'body', 'visible'])('restores an owning frame only when it remains visible, else falls back to the pane: %s', async state => {
        const frame = document.createElement('iframe'); document.body.append(frame);
        vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 200, left: 0, top: 0, right: 200, bottom: 200 } as DOMRect);
        // `body`: nothing was focused when the prompt arrived, so the capture is `document.body`.
        // Focusing that back is a no-op that would silently strand the window without a caret.
        if (state !== 'body') frame.focus();
        const focusFrame = vi.spyOn(frame, 'focus');
        const { scope, focus } = setup(); let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showInput', { title: 'Prompt' }); });
        if (state === 'removed') frame.remove();
        if (state === 'hidden') frame.hidden = true;
        if (state === 'offscreen') vi.mocked(frame.getBoundingClientRect).mockReturnValue({ width: 200, height: 200, left: -300, top: 0, right: -100, bottom: 200 } as DOMRect);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await expect(answer).resolves.toBeNull();
        expect(focusFrame).toHaveBeenCalledTimes(state === 'visible' ? 1 : 0);
        // §2.4 precedence (c): a window whose origin cannot take the caret back is not left
        // without one - the focused pane takes it.
        expect(focus.handBackCaret).toHaveBeenCalledTimes(state === 'visible' ? 0 : 1);
        if (state !== 'visible') expect(focus.handBackCaret).toHaveBeenCalledWith('pane-focused');
    });
});

describe('a selected prompts presenter', () => {
    it('draws instead of the bundled panel, holds the one registration, and is granted three chords', async () => {
        const { scope } = setupSelected({}, { strict: true });
        let answer!: Promise<unknown>;
        await act(async () => { answer = scope.request('ui.showQuickPick', { title: 'Pick', items: [{ id: 'one', label: 'One' }] }); });

        // One selector answers "who is drawing this".
        expect(screen.getByTestId('interaction-presenter-prompts').dataset['interactionPresenter']).toBe(PRESENTER_VIEW);
        expect(screen.getByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeDefined();
        expect(screen.queryByTestId('plugin-ui-dialog')).toBeNull();
        expect(screen.queryByTestId('plugin-ui-backdrop')).toBeNull();
        // StrictMode's rehearsal must not leave a second registration or a second mount behind.
        expect(modalPresenceCount()).toBe(1);
        expect(screen.getAllByTestId(`plugin-view-${PRESENTER_VIEW}`)).toHaveLength(1);
        expect(view.current).toMatchObject({ visible: true, focused: true, claimedChords: ['0/Escape', '8/KeyW'] });
        expect(view.current!.frames.at(-1)).toMatchObject({ visible: true, prompt: { kind: 'quickPick', owner: { displayName: 'Test Plugin' } } });

        act(() => { view.current!.presenter!.call('ui.respondInteraction', { requestID: view.current!.frames.at(-1)!.prompt!.requestID, value: 'one' }); });
        await expect(answer).resolves.toBe('one');
        expect(modalPresenceCount()).toBe(0);
    });

    it('hands the surface back to the bundled presenter on a view error, with the request intact', async () => {
        const failures: Array<[string, string]> = [];
        const { surface, scope } = setupSelected({ reportFailure: (label, detail) => failures.push([label, detail]) });
        let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showDialog', { title: 'Delete?', message: 'Choose', actions: [{ id: 'keep', label: 'Keep' }] }); });
        const before = surface.getSnapshot().activeModal!.id;

        act(() => { view.current!.onError!('the view crashed'); });

        // Re-presented, not re-raised: the same id, the same unsettled promise.
        expect(screen.getByTestId('plugin-ui-dialog').dataset['requestId']).toBe(before);
        expect(screen.queryByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeNull();
        expect(screen.getByTestId('interaction-presenter-prompts').dataset['interactionPresenter']).toBe('bundled');
        expect(surface.presenterState()['interaction.prompts']).toEqual({ failed: true, detail: 'the view crashed' });
        expect(failures).toEqual([['Interaction presenter', 'the view crashed']]);
        let settled = false;
        void answer.then(() => { settled = true; });
        await act(async () => { await Promise.resolve(); });
        expect(settled).toBe(false);

        // The latch holds for the window session: the next prompt is bundled too.
        fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
        await expect(answer).resolves.toBe('keep');
        let second!: Promise<unknown>;
        act(() => { second = scope.request('ui.showInput', { title: 'After the failure' }); });
        expect(screen.getByRole('textbox', { name: 'After the failure' })).toBeDefined();
        act(() => { surface.answer(surface.getSnapshot().activeModal!.id, null); });
        await expect(second).resolves.toBeNull();
    });

    it('keeps Escape cancelling through the relay, and contains focus inside the frame', async () => {
        const outside = document.createElement('button');
        document.body.append(outside);
        const { scope } = setupSelected();
        let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showInput', { title: 'Owned by the presenter' }); });

        const frame = screen.getByTitle('presenter frame');
        const focusFrame = vi.spyOn(frame, 'focus');
        // §2.4: containment is the wrapper's job - the frame cannot see a focus it never received.
        act(() => { outside.focus(); outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
        expect(focusFrame).toHaveBeenCalled();

        // The relay re-dispatches a granted chord on the owner window, where the host is listening.
        fireEvent.keyDown(window, { key: 'Escape' });
        await expect(answer).resolves.toBeNull();
        expect(modalPresenceCount()).toBe(0);
    });

    it('fails the placement when the presenter never reports that it painted', () => {
        vi.useFakeTimers();
        const { surface, scope } = setupSelected();
        act(() => { void scope.request('ui.showInput', { title: 'Unanswerable' }); });
        expect(screen.getByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeDefined();
        act(() => { vi.advanceTimersByTime(5_000); });
        expect(surface.presenterState()['interaction.prompts']).toEqual({ failed: true, detail: 'The interaction presenter did not report that it had painted.' });
        expect(screen.getByRole('textbox', { name: 'Unanswerable' })).toBeDefined();
    });

    it('fails the placement when a frame carrying a new prompt is never acknowledged', async () => {
        vi.useFakeTimers();
        const { surface, scope } = setupSelected();
        act(() => { view.current!.presenter!.call('ui.reportPresenterReady', {}); });
        act(() => { vi.advanceTimersByTime(5_000); });
        // Readiness was reported, so nothing has failed yet.
        expect(surface.presenterState()['interaction.prompts'].failed).toBe(false);

        await act(async () => { void scope.request('ui.showInput', { title: 'Never acknowledged' }); });
        act(() => { vi.advanceTimersByTime(4_000); });
        expect(surface.presenterState()['interaction.prompts'].failed).toBe(false);
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(surface.presenterState()['interaction.prompts']).toEqual({ failed: true, detail: 'The interaction presenter stopped acknowledging window updates.' });
        expect(screen.getByRole('textbox', { name: 'Never acknowledged' })).toBeDefined();
    });

    it('keeps acknowledging frames alive, and never mounts a presenter on a phone', async () => {
        vi.useFakeTimers();
        const { surface, scope } = setupSelected();
        act(() => { view.current!.presenter!.call('ui.reportPresenterReady', {}); });
        await act(async () => { void scope.request('ui.showInput', { title: 'Acknowledged' }); });
        act(() => { view.current!.presenter!.noteAcknowledged(); });
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(surface.presenterState()['interaction.prompts'].failed).toBe(false);
        expect(screen.queryByTestId('plugin-ui-dialog')).toBeNull();

        cleanup();
        const phone = setupSelected({}, { presenters: false });
        act(() => { void phone.scope.request('ui.showInput', { title: 'Phone prompt' }); });
        // The phone palette owns the software-keyboard inset, which a presenter cannot read.
        expect(screen.queryByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeNull();
        expect(screen.getByRole('textbox', { name: 'Phone prompt' })).toBeDefined();
    });

    it('never presents a notification, and keeps the bundled stack and its rect', async () => {
        const { scope } = setupSelected();
        let notice!: Promise<unknown>;
        await act(async () => { notice = scope.request('ui.showNotification', { message: 'Saved', tone: 'success', actions: [{ id: 'open', label: 'Open saved item' }] }); });

        // §2.6: the stack registers WHERE it is, never the window - and a presenter never registers
        // a rect at all, so the stack stays bundled and keeps drawing its own.
        expect(screen.getByTestId('plugin-ui-notification')).toBeDefined();
        expect(overlayPresenceCount()).toBe(1);
        expect(modalPresenceCount()).toBe(0);
        // The frame is mounted (a prompt must not cost an attach) but nothing is painted in it.
        expect(screen.getByTestId('interaction-presenter-prompts').hidden).toBe(true);
        expect(view.current).toMatchObject({ visible: false, focused: false });
        expect(view.current!.frames.at(-1)!.notifications).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: 'Open saved item' }));
        await expect(notice).resolves.toBe('open');
        expect(overlayPresenceCount()).toBe(0);
    });

    it('is granted Escape and the rebindable close chord, and both still cancel', async () => {
        // What the relay carries, and nothing else: the presenter's own arrows, Enter and Tab trap
        // never leave its frame, and a main-process accelerator has no renderer listener to reach.
        expect(interactionPresenterChords(DEFAULT_KEYBINDINGS)).toEqual(['0/Escape', '8/KeyW']);

        const { surface, scope } = setupSelected();
        let answer!: Promise<unknown>;
        await act(async () => { answer = scope.request('ui.showInput', { title: 'Closed by the chord' }); });
        expect(view.current!.claimedChords).toEqual(['0/Escape', '8/KeyW']);
        // `PluginView` re-dispatches a granted chord on the owner window, where the window's own
        // dispatcher resolves it to `close_pane` and reaches this authority.
        act(() => { expect(surface.dismissTopmost()).toBe(true); });
        await expect(answer).resolves.toBeNull();
        expect(view.current!.frames.at(-1)!.prompt).toBeNull();
        expect(modalPresenceCount()).toBe(0);
    });

    it('stands down to the bundled panel when the daemon connection drops, without calling it a failure', async () => {
        const { surface, scope } = setupSelected();
        act(() => { view.current!.presenter!.call('ui.reportPresenterReady', {}); });
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(false);
        let answer!: Promise<unknown>;
        await act(async () => { answer = scope.request('ui.showInput', { title: 'Mid flight' }); });

        act(() => { setConnection('reconnecting'); });
        // A presenter behind PluginView's "Connecting to daemon…" placeholder would paint that
        // inside the prompt box, so the bundled panel takes the request over - same id, unsettled.
        expect(screen.queryByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeNull();
        expect(screen.getByRole('textbox', { name: 'Mid flight' })).toBeDefined();
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(true);
        // Standing down is nobody's fault: no latch, and no Retry for Settings to offer.
        expect(surface.presenterState()['interaction.prompts']).toEqual({ failed: false, detail: null });

        act(() => { surface.answer(surface.getSnapshot().activeModal!.id, null); });
        await expect(answer).resolves.toBeNull();
    });

    it('withholds a password prompt from the presenter and lets the bundled panel take it', async () => {
        const { surface, scope } = setupSelected();
        let secret!: Promise<unknown>;
        await act(async () => { secret = scope.request('ui.showInput', { title: 'Secret', password: true }); });

        // The selected view stays MOUNTED and hidden: a credential prompt costs no reattachment.
        expect(screen.getByTestId(`plugin-view-${PRESENTER_VIEW}`)).toBeDefined();
        expect(view.current).toMatchObject({ visible: false, focused: false });
        expect(view.current!.frames.at(-1)).toMatchObject({ prompt: null, queued: 1, visible: false });
        const input = screen.getByLabelText('Secret', { selector: 'input' }) as HTMLInputElement;
        expect(input.type).toBe('password');
        expect(screen.getByTestId('interaction-presenter-prompts').dataset['interactionPresenter']).toBe('bundled');
        expect(surface.presenterState()['interaction.prompts'].failed).toBe(false);

        fireEvent.change(input, { target: { value: 'hunter2' } });
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        await expect(secret).resolves.toBe('hunter2');
    });
});
