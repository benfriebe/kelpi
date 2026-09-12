import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modalPresenceCount, overlayPresenceCount, registerModal } from '../chrome/modal-presence';
import { InteractionHost } from './InteractionHost';
import { createInteractionSurface, type InteractionScope, type InteractionSurface, type InteractionSurfaceConfig } from './surface';
import { useInteractionSurface } from './use-interaction';

const surfaces: InteractionSurface[] = [];
const nativeOwner = (id = 'native:shortcut') => ({ id, kind: 'native' as const, displayName: 'Command Palette' });

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
