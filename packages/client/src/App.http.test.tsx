// @vitest-environment-options {"url":"http://100.64.0.2:19470/"}
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createFakeSocketFactory } from './connection/testing';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('plain HTTP client initialization', () => {
    it('mounts before connecting or selecting a plugin when randomUUID is unavailable', () => {
        expect(window.location.origin).toBe('http://100.64.0.2:19470');
        // Non-localhost HTTP exposes getRandomValues, but not secure-context randomUUID.
        vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const runtime = createKelpiRuntime({
            store: createKelpiStore(),
            url: 'ws://100.64.0.2:19470/ws',
            socketFactory: createFakeSocketFactory().factory,
            notifications: null,
            tokenStorage: null,
        });
        try {
            render(<App runtime={runtime} autoConnect={false} createRenderer={createFakeRendererFactory().factory} />);
            expect(screen.getByTestId('kelpi-app')).toBeTruthy();
            expect(screen.getByTestId('connection-splash')).toBeTruthy();
        } finally {
            cleanup();
            runtime.dispose();
        }
    });
});
