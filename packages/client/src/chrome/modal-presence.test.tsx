/**
 * The modal-presence registry (UI-FIDELITY H1).
 *
 * What it has to get right is not "is there a boolean somewhere": it is that a surface the
 * ASSEMBLY cannot see — a dialog the shell opened, a prompt inside the inspector, a portal menu
 * — is counted for exactly as long as it is painted, and that the count returns to zero
 * afterwards. A count that leaks would park a web pane's page forever; a count that drops early
 * would slice the dialog it was protecting.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState, type ReactElement } from 'react';

import { modalPresenceCount, registerModal, useAnyModalOpen, useModalPresence } from './index';

afterEach(cleanup);

function Modal({ active = true }: { readonly active?: boolean }): ReactElement {
    useModalPresence(active);
    return <div data-testid="modal" />;
}

/** The assembly's read, published as an attribute so a test can watch it change. */
function Watcher({ children }: { readonly children?: ReactElement | null }): ReactElement {
    const open = useAnyModalOpen();
    return (
        <div data-testid="watcher" data-modal-open={open ? 'true' : 'false'}>
            {children}
        </div>
    );
}

describe('registerModal', () => {
    it('counts up and back down', () => {
        expect(modalPresenceCount()).toBe(0);
        const release = registerModal();
        expect(modalPresenceCount()).toBe(1);
        release();
        expect(modalPresenceCount()).toBe(0);
    });

    it('is idempotent per registration, so a double release cannot go negative', () => {
        const first = registerModal();
        const second = registerModal();
        expect(modalPresenceCount()).toBe(2);
        first();
        first();
        first();
        expect(modalPresenceCount()).toBe(1);
        second();
        expect(modalPresenceCount()).toBe(0);
    });
});

describe('useModalPresence / useAnyModalOpen', () => {
    it('a mounted modal makes the assembly read true, and unmounting hands it back', () => {
        function Host(): ReactElement {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" data-testid="toggle" onClick={() => setOpen((v) => !v)}>
                        toggle
                    </button>
                    <Watcher>{open ? <Modal /> : null}</Watcher>
                </>
            );
        }
        render(<Host />);
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('false');

        fireEvent.click(screen.getByTestId('toggle'));
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('true');
        expect(modalPresenceCount()).toBe(1);

        fireEvent.click(screen.getByTestId('toggle'));
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('false');
        expect(modalPresenceCount()).toBe(0);
    });

    it('`active: false` registers nothing — the ToastStack case, mounted but painting nothing', () => {
        render(
            <Watcher>
                <Modal active={false} />
            </Watcher>
        );
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('false');
        expect(modalPresenceCount()).toBe(0);
    });

    it('two modals at once keep the read true until BOTH are gone', () => {
        function Host(): ReactElement {
            const [count, setCount] = useState(2);
            return (
                <>
                    <button type="button" data-testid="drop" onClick={() => setCount((v) => v - 1)}>
                        drop
                    </button>
                    <Watcher>
                        <>
                            {count > 0 ? <Modal /> : null}
                            {count > 1 ? <Modal /> : null}
                        </>
                    </Watcher>
                </>
            );
        }
        render(<Host />);
        expect(modalPresenceCount()).toBe(2);
        fireEvent.click(screen.getByTestId('drop'));
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('true');
        fireEvent.click(screen.getByTestId('drop'));
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('false');
        expect(modalPresenceCount()).toBe(0);
    });

    it('unmounting the whole tree releases what it held', () => {
        const view = render(
            <Watcher>
                <Modal />
            </Watcher>
        );
        expect(modalPresenceCount()).toBe(1);
        view.unmount();
        expect(modalPresenceCount()).toBe(0);
    });
});
