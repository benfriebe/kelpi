import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANE_RENDERER_LIMIT, paneRenderer, publishRendererToggle, setPaneRenderer, toggleDocumentRenderer } from './pane-renderers';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('per-pane renderer choices', () => {
    it('keeps a choice per pane, and drops it when the pane follows its type again', () => {
        setPaneRenderer('a', 'example.markdown');
        setPaneRenderer('b', 'kelpi.scratchpad');
        expect(paneRenderer('a')).toBe('example.markdown');
        expect(paneRenderer('b')).toBe('kelpi.scratchpad');
        setPaneRenderer('a', null);
        expect(paneRenderer('a')).toBeNull();
        expect(JSON.parse(localStorage.getItem('kelpi.pane-renderers.v1')!)).toEqual({ b: 'kelpi.scratchpad' });
    });

    it('tells this window when a choice changes, and not when it stays', () => {
        const changed = vi.fn();
        window.addEventListener('kelpi-pane-renderers', changed);
        setPaneRenderer('a', 'example.markdown');
        setPaneRenderer('a', 'example.markdown');
        window.removeEventListener('kelpi-pane-renderers', changed);
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('ages out the oldest choice past the limit', () => {
        for (let index = 0; index <= PANE_RENDERER_LIMIT; index++) setPaneRenderer(`pane-${String(index)}`, 'example.markdown');
        expect(paneRenderer('pane-0')).toBeNull();
        expect(paneRenderer('pane-1')).toBe('example.markdown');
        // A pane switched again counts as the newest.
        setPaneRenderer('pane-1', 'kelpi.scratchpad');
        setPaneRenderer('another', 'example.markdown');
        expect(paneRenderer('pane-1')).toBe('kelpi.scratchpad');
        expect(paneRenderer('pane-2')).toBeNull();
    });

    it('ignores storage that is not a map of ids', () => {
        localStorage.setItem('kelpi.pane-renderers.v1', '["a"]');
        expect(paneRenderer('0')).toBeNull();
        localStorage.setItem('kelpi.pane-renderers.v1', '{"a":1,"b":"x"}');
        expect(paneRenderer('a')).toBeNull();
        expect(paneRenderer('b')).toBe('x');
    });
});

describe('the header toggle bridge', () => {
    it('runs the toggle a body offers until it withdraws it, and not a later offer', () => {
        const first = vi.fn(), second = vi.fn();
        const withdrawFirst = publishRendererToggle('a', { plugin: false, title: 'Markdown' }, first);
        expect(toggleDocumentRenderer('a')).toBe(true);
        const withdrawSecond = publishRendererToggle('a', { plugin: true, title: 'Markdown' }, second);
        withdrawFirst();
        expect(toggleDocumentRenderer('a')).toBe(true);
        expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);
        withdrawSecond();
        expect(toggleDocumentRenderer('a')).toBe(false);
    });
});
