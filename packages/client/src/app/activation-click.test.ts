import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installActivationClick, isActivatingPress, onActivationPress } from './activation-click';

/** The shell's `shell-activation` reports, hand-delivered. */
function activation(initial: boolean): {
    isActive: () => boolean;
    onActiveChange: (listener: (active: boolean) => void) => () => void;
    report: (active: boolean) => void;
} {
    let active = initial;
    const listeners = new Set<(active: boolean) => void>();
    return {
        isActive: () => active,
        onActiveChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        report(next) {
            active = next;
            for (const listener of [...listeners]) listener(next);
        }
    };
}

/** Raise `type` on `target` as made by the OS at `at` (the clock `timeStamp` is on). */
function raise(target: Element, type: string, at: number, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    Object.defineProperty(event, 'timeStamp', { value: at });
    target.dispatchEvent(event);
    return event;
}

/** One whole primary click, the way a browser without pointer events raises it. */
function click(target: Element, at: number, init: MouseEventInit = {}): void {
    raise(target, 'mousedown', at, init);
    raise(target, 'mouseup', at + 1, init);
    raise(target, 'click', at + 1, init);
}

describe('isActivatingPress', () => {
    it('is never a press while nothing is pending', () => {
        expect(isActivatingPress(false, null, 5)).toBe(false);
        expect(isActivatingPress(false, 10, 5)).toBe(false);
    });

    it('is the pending press while the window is still reported inactive', () => {
        expect(isActivatingPress(true, null, 5)).toBe(true);
    });

    it('is the pending press when the OS made it before the "active" report arrived', () => {
        expect(isActivatingPress(true, 10, 5)).toBe(true);
    });

    it('is not a press made after the window came back some other way (⌘Tab, the Dock)', () => {
        expect(isActivatingPress(true, 10, 15)).toBe(false);
    });
});

describe('installActivationClick (#339)', () => {
    let pane: HTMLElement;
    let heard: string[];
    let activated: Element[];
    let teardown: Array<() => void>;
    let clock: number;

    beforeEach(() => {
        pane = document.createElement('div');
        pane.setAttribute('data-pane-id', 'right');
        document.body.appendChild(pane);
        heard = [];
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            pane.addEventListener(type, () => heard.push(type));
        }
        activated = [];
        clock = 100;
        teardown = [onActivationPress((target) => activated.push(target))];
    });

    afterEach(() => {
        for (const off of teardown) off();
        pane.remove();
        vi.useRealTimers();
    });

    function install(source: ReturnType<typeof activation>): void {
        teardown.push(
            installActivationClick({
                target: window,
                isActive: source.isActive,
                onActiveChange: source.onActiveChange,
                now: () => clock
            })
        );
    }

    it('leaves every press alone while the window is active', () => {
        install(activation(true));
        click(pane, 200);
        expect(heard).toEqual(['mousedown', 'mouseup', 'click']);
        expect(activated).toEqual([]);
    });

    it('consumes the press that activates the window and reports where it landed', () => {
        const shell = activation(true);
        install(shell);
        shell.report(false);
        click(pane, 200);
        expect(heard).toEqual([]);
        expect(activated).toEqual([pane]);
    });

    it('cancels the press, so a browser raises no compatibility mouse events for it', () => {
        const shell = activation(false);
        install(shell);
        const down = raise(pane, 'pointerdown', 200);
        expect(down.defaultPrevented).toBe(true);
    });

    it('consumes a pointer gesture whole, its compatibility events included', () => {
        const shell = activation(false);
        install(shell);
        raise(pane, 'pointerdown', 200);
        raise(pane, 'mousedown', 200);
        raise(pane, 'pointerup', 201);
        raise(pane, 'mouseup', 201);
        raise(pane, 'click', 201);
        expect(heard).toEqual([]);
        expect(activated).toEqual([pane]);
    });

    it('takes only the first press after the window went inactive', () => {
        const shell = activation(true);
        install(shell);
        shell.report(false);
        click(pane, 200);
        click(pane, 300);
        expect(heard).toEqual(['mousedown', 'mouseup', 'click']);
        expect(activated).toHaveLength(1);
    });

    it('still takes the press when the "active" report beat it to the page', () => {
        const shell = activation(true);
        install(shell);
        shell.report(false);
        clock = 205;
        shell.report(true);
        click(pane, 200);
        expect(heard).toEqual([]);
        expect(activated).toEqual([pane]);
    });

    it('leaves a press made after the window came back some other way, and stops waiting', () => {
        const shell = activation(true);
        install(shell);
        shell.report(false);
        clock = 150;
        shell.report(true);
        click(pane, 200);
        expect(heard).toEqual(['mousedown', 'mouseup', 'click']);
        expect(activated).toEqual([]);
        // ...and a press with an older stamp later on is not taken either: one candidate per spell.
        click(pane, 120);
        expect(activated).toEqual([]);
    });

    it('treats a window that is already inactive when installed as waiting for its press', () => {
        install(activation(false));
        click(pane, 200);
        expect(activated).toEqual([pane]);
    });

    it('ignores a non-primary press, and keeps waiting for the primary one', () => {
        install(activation(false));
        raise(pane, 'mousedown', 200, { button: 2 });
        expect(heard).toEqual(['mousedown']);
        click(pane, 300);
        expect(heard).toEqual(['mousedown']);
        expect(activated).toEqual([pane]);
    });

    it('ends the consumed gesture one task after its release, click or no click', () => {
        vi.useFakeTimers();
        install(activation(false));
        raise(pane, 'mousedown', 200);
        raise(pane, 'mouseup', 201);
        vi.advanceTimersByTime(0);
        raise(pane, 'click', 400);
        expect(heard).toEqual(['click']);
    });

    it('stops listening when torn down', () => {
        const shell = activation(true);
        install(shell);
        for (const off of teardown.splice(1)) off();
        shell.report(false);
        click(pane, 200);
        expect(heard).toEqual(['mousedown', 'mouseup', 'click']);
        expect(activated).toEqual([]);
    });
});
