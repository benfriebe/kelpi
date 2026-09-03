import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    SERVICE_WORKER_SCOPE,
    SERVICE_WORKER_URL,
    registerServiceWorker,
    serviceWorkerDecision,
    type ServiceWorkerEnvironment
} from './register';

/** A browser on the tailnet with nothing wrong with it. */
const PHONE: ServiceWorkerEnvironment = {
    supported: true,
    shellWindowID: null,
    secureContext: true,
    hostname: 'mac.tailnet.ts.net'
};

function env(overrides: Partial<ServiceWorkerEnvironment>): ServiceWorkerEnvironment {
    return { ...PHONE, ...overrides };
}

describe('the registration gate', () => {
    it('registers in a secure browser that is not the shell', () => {
        expect(serviceWorkerDecision(PHONE)).toBe('register');
    });

    it('does nothing without `serviceWorker` in navigator', () => {
        expect(serviceWorkerDecision(env({ supported: false }))).toBe('unsupported');
        // Unsupported wins over everything else, since nothing later can be attempted.
        expect(
            serviceWorkerDecision(env({ supported: false, shellWindowID: 'w1', secureContext: false }))
        ).toBe('unsupported');
    });

    /**
     * Guardrail 1 of the phone program: desktop is untouched. The Electron shell loads the same
     * URL a browser does, so this is the only thing standing between the desktop app and a
     * worker on the daemon's origin intercepting every asset load the shell makes.
     */
    it('does nothing inside the Electron shell, whatever else is true', () => {
        expect(serviceWorkerDecision(env({ shellWindowID: 'A0E1-2B3C' }))).toBe('electron-shell');
        expect(
            serviceWorkerDecision(env({ shellWindowID: 'A0E1-2B3C', hostname: '127.0.0.1', secureContext: false }))
        ).toBe('electron-shell');
    });

    it('does nothing on an insecure origin', () => {
        expect(serviceWorkerDecision(env({ secureContext: false, hostname: 'mac.local' }))).toBe(
            'insecure-origin'
        );
    });

    it('registers on loopback even when the host does not call it secure', () => {
        for (const hostname of ['localhost', 'LOCALHOST', 'kelpi.localhost', '127.0.0.1', '::1', '[::1]']) {
            expect([hostname, serviceWorkerDecision(env({ secureContext: false, hostname }))]).toEqual([
                hostname,
                'register'
            ]);
        }
    });

    it('treats a lookalike host as insecure', () => {
        for (const hostname of ['localhost.evil.com', 'notlocalhost', '127.0.0.2', 'localhost.']) {
            expect([hostname, serviceWorkerDecision(env({ secureContext: false, hostname }))]).toEqual([
                hostname,
                'insecure-origin'
            ]);
        }
    });
});

describe('what gets registered', () => {
    afterEach(() => {
        Reflect.deleteProperty(navigator, 'serviceWorker');
    });

    /** Stand in for `ServiceWorkerContainer`, which jsdom does not implement at all. */
    function stubContainer(register: (...args: unknown[]) => unknown): void {
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { register }
        });
    }

    it('asks for the root script at the root scope, once', () => {
        const register = vi.fn(async () => ({}));
        stubContainer(register);
        expect(registerServiceWorker(PHONE)).toBe('register');
        expect(register).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
    });

    /**
     * Guardrail 3, at the one call that would make a URL permanent: the browser remembers the
     * script URL and the scope for the life of the installation and re-fetches that exact URL
     * to check for an update, so a token in either would outlive the address-bar strip
     * `app/config.ts` performs on first sight.
     */
    it('names no query string and no fragment in the script URL or the scope', () => {
        for (const value of [SERVICE_WORKER_URL, SERVICE_WORKER_SCOPE]) {
            expect([value, value.includes('?')]).toEqual([value, false]);
            expect([value, value.includes('#')]).toEqual([value, false]);
            expect([value, value.startsWith('/')]).toEqual([value, true]);
        }
    });

    it('never calls register when the gate refused', () => {
        for (const refused of [
            env({ supported: false }),
            env({ shellWindowID: 'w1' }),
            env({ secureContext: false, hostname: 'mac.local' })
        ]) {
            const register = vi.fn(async () => ({}));
            stubContainer(register);
            expect(registerServiceWorker(refused)).not.toBe('register');
            expect(register).not.toHaveBeenCalled();
        }
    });

    it('swallows a rejected registration rather than surfacing an unhandled promise', async () => {
        const register = vi.fn(async () => {
            throw new Error('SecurityError');
        });
        stubContainer(register);
        expect(registerServiceWorker(PHONE)).toBe('register');
        await Promise.resolve();
        expect(register).toHaveBeenCalledTimes(1);
    });
});
