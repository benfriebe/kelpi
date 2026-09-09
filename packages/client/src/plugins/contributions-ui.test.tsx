import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginContributionItems } from './contributions-ui';
import type { ResolvedContributionItem } from './contributions';

afterEach(cleanup);
const item: ResolvedContributionItem = { id: 'sample.ui.run-item', pluginID: 'sample.ui', command: 'sample.ui.run',
    text: 'Run checks', tooltip: 'Check this pane', badge: '3', tone: 'warning', enabled: true, order: 0 };

describe('native plugin contribution controls', () => {
    it('forwards the explicit pane and item identity so the host can revalidate a click', () => {
        const execute = vi.fn(), parent = vi.fn();
        render(<div onClick={parent} onPointerDown={parent} onDoubleClick={parent}><PluginContributionItems items={[item]} execute={execute} paneID="pane-two" compact /></div>);
        const control = screen.getByRole('button', { name: 'Run checks, 3' });
        expect(control.getAttribute('title')).toBe('Check this pane');
        expect(control.getAttribute('data-tone')).toBe('warning');
        fireEvent.pointerDown(control);
        fireEvent.doubleClick(control);
        fireEvent.click(control);
        expect(execute).toHaveBeenCalledExactlyOnceWith('sample.ui.run', 'pane-two', item.id);
        expect(parent).not.toHaveBeenCalled();
    });

    it('updates a retained control and refuses clicks after it becomes disabled', () => {
        const execute = vi.fn();
        const view = render(<PluginContributionItems items={[item]} execute={execute} />);
        const control = screen.getByRole('button');
        view.rerender(<PluginContributionItems items={[{ ...item, text: 'Checking', badge: '4', tone: 'info', enabled: false }]} execute={execute} />);
        expect(screen.getByRole('button', { name: 'Checking, 4' })).toBe(control);
        expect((control as HTMLButtonElement).disabled).toBe(true);
        expect(control.getAttribute('data-tone')).toBe('info');
        fireEvent.click(control);
        expect(execute).not.toHaveBeenCalled();
        view.rerender(<PluginContributionItems items={[]} execute={execute} />);
        expect(screen.queryByRole('group')).toBeNull();
    });

    it('renders passive text without executable markup or an extra tab stop', () => {
        const execute = vi.fn();
        const { container } = render(<PluginContributionItems items={[{ id: 'sample.ui.status', pluginID: 'sample.ui',
            text: '<img src=x onerror=bad()>', badge: '<b>ok</b>', tone: 'success', enabled: true, order: 0 }]} execute={execute} />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('b')).toBeNull();
        expect(screen.getByText('<img src=x onerror=bad()>')).toBeTruthy();
        expect(screen.getByTestId('plugin-item-sample.ui.status').getAttribute('tabindex')).toBeNull();
        expect(screen.getByTestId('plugin-contribution-items').className).toContain('overflow-x-auto');
    });
});
