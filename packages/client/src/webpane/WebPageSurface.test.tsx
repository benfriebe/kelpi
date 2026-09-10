import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebPageSurface } from './WebPageSurface';
import type { WebPaneCommands } from './commands';

afterEach(cleanup);

function fixture() {
    const placement: string[] = [];
    const props = {
        paneID: 'browser', tabs: [{ id: 'tab', url: 'https://example.test', live: true }], activeTabID: 'tab',
        embedded: true, visible: true,
        commands: { poster: vi.fn(async () => ({ ok: false })) } as unknown as WebPaneCommands,
        measure: () => ({ x: 20, y: 40, w: 500, h: 300 }),
        onGeometry: () => placement.push('visible'), onHidden: () => placement.push('hidden')
    };
    return { props, placement };
}

describe('native page placement ownership', () => {
    it('retires the old renderer before the replacement publishes the same page', () => {
        const h = fixture();
        const view = render(<WebPageSurface key="bundled" {...h.props} />);
        expect(h.placement.at(-1)).toBe('visible');
        h.placement.length = 0;
        view.rerender(<WebPageSurface key="plugin" {...h.props} />);
        expect(h.placement[0]).toBe('hidden');
        expect(h.placement.at(-1)).toBe('visible');
        h.placement.length = 0;
        view.rerender(<WebPageSurface key="bundled" {...h.props} />);
        expect(h.placement[0]).toBe('hidden');
        expect(h.placement.at(-1)).toBe('visible');
    });

    it('parks the previous placement when the native host moves out of this window', () => {
        const h = fixture();
        const view = render(<WebPageSurface {...h.props} />);
        view.rerender(<WebPageSurface {...h.props} embedded={false} />);
        expect(h.placement.at(-1)).toBe('hidden');
        h.placement.length = 0;
        window.dispatchEvent(new Event('resize'));
        expect(h.placement).toEqual([]);
        view.rerender(<WebPageSurface {...h.props} />);
        expect(h.placement.at(-1)).toBe('visible');
    });
});
