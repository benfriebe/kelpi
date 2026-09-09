import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modalPresenceCount, overlayPresenceCount, registerModal } from '../chrome/modal-presence';
import { createUIServices, type UIServiceModel, type UIServiceScope } from './ui-services';
import { UIServiceHost, useUIServices } from './UIServiceHost';

const models: UIServiceModel[] = [];
function setup(): { model: UIServiceModel; scope: UIServiceScope } {
    const model = createUIServices(); models.push(model);
    const scope = model.createScope({ id: 'view', pluginID: 'example.test', pluginName: 'Test Plugin' });
    render(<UIServiceHost services={model} />);
    return { model, scope };
}
afterEach(() => { cleanup(); for (const model of models.splice(0)) model.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });

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

    it.each(['removed', 'hidden', 'offscreen', 'visible'])('restores an owning frame only when it remains visible: %s', async state => {
        const frame = document.createElement('iframe'); document.body.append(frame);
        vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 200, left: 0, top: 0, right: 200, bottom: 200 } as DOMRect);
        frame.focus(); const focus = vi.spyOn(frame, 'focus');
        const { scope } = setup(); let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showInput', { title: 'Prompt' }); });
        if (state === 'removed') frame.remove();
        if (state === 'hidden') frame.hidden = true;
        if (state === 'offscreen') vi.mocked(frame.getBoundingClientRect).mockReturnValue({ width: 200, height: 200, left: -300, top: 0, right: -100, bottom: 200 } as DOMRect);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await expect(answer).resolves.toBeNull();
        expect(focus).toHaveBeenCalledTimes(state === 'visible' ? 1 : 0);
    });

    it('keeps notifications actionable without taking focus or registering a window modal', async () => {
        const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
        const { scope } = setup(); let result!: Promise<unknown>;
        act(() => { result = scope.request('ui.showNotification', { message: 'Saved', tone: 'success', actions: [{ id: 'open', label: 'Open saved item' }] }); });
        expect(modalPresenceCount()).toBe(0); expect(overlayPresenceCount()).toBe(1);
        expect(document.activeElement).toBe(trigger);
        fireEvent.click(screen.getByRole('button', { name: 'Open saved item' }));
        await expect(result).resolves.toBe('open'); expect(overlayPresenceCount()).toBe(0);
    });

    it('survives StrictMode rehearsal and resolves pending work on actual window disposal', async () => {
        let model!: UIServiceModel;
        function Host(): ReactElement { model = useUIServices(); return <UIServiceHost services={model} />; }
        const view = render(<StrictMode><Host /></StrictMode>);
        await act(async () => { await Promise.resolve(); });
        const scope = model.createScope({ id: 'view', pluginID: 'example.test', pluginName: 'Test' });
        let answer!: Promise<unknown>;
        act(() => { answer = scope.request('ui.showInput', { title: 'Still usable' }); });
        expect(modalPresenceCount()).toBe(1);
        view.unmount();
        await expect(answer).resolves.toBeNull(); expect(modalPresenceCount()).toBe(0);
    });
});
