import { DROPPED_FILES_STASH, MAX_DROPPED_FILES } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DROPPED_FILES_LOOKUP_DEADLINE_MS,
    DROPPED_FILES_OBJECT_GROUP,
    resolveDroppedFiles,
    serialized,
    stashTakeExpression,
    type DebuggerLike
} from './dropped-files.js';

/**
 * A scripted `webContents.debugger`: the stash is a `Map` of request id to "remote objects", each
 * a path (a `File` on disk), an empty string (a `File` made of bytes) or null (not a `File`).
 */
interface FakeOptions {
    readonly stash?: Map<string, (string | null)[]>;
    readonly attached?: boolean;
    readonly attachThrows?: boolean;
    readonly evaluateThrows?: boolean;
    /**
     * Commands that never settle on their own, by `method#n` (n counts that method's calls from 1),
     * e.g. `Runtime.evaluate#1`. Each is parked in `parked` for the test to settle late.
     */
    readonly hang?: readonly string[];
}

function fakeDebugger(options: FakeOptions = {}) {
    const stash = options.stash ?? new Map<string, (string | null)[]>();
    let attached = options.attached ?? false;
    const calls: string[] = [];
    const objects = new Map<string, string | null>();
    let expression = '';
    const counts = new Map<string, number>();
    const parked: { method: string; settle: () => void }[] = [];
    const target: DebuggerLike = {
        isAttached: () => attached,
        attach: () => {
            calls.push('attach');
            if (options.attachThrows === true) throw new Error('Another debugger is already attached');
            attached = true;
        },
        detach: () => {
            calls.push('detach');
            attached = false;
        },
        sendCommand: (method, params = {}) => {
            calls.push(method);
            if (!attached) return Promise.reject(new Error('not attached'));
            const count = (counts.get(method) ?? 0) + 1;
            counts.set(method, count);
            if (options.hang?.includes(`${method}#${String(count)}`) === true) {
                // Settled late, the way a command answers once DevTools resumes: with a real
                // result, so an abandoned lookup that failed to stop would carry on.
                return new Promise((resolve) => {
                    parked.push({ method, settle: () => resolve({ result: { type: 'object', objectId: 'array-1' } }) });
                });
            }
            switch (method) {
                case 'Runtime.evaluate': {
                    if (options.evaluateThrows === true) return Promise.reject(new Error('target closed'));
                    expression = String(params['expression']);
                    expect(params['objectGroup']).toBe(DROPPED_FILES_OBJECT_GROUP);
                    // Run the real expression against a real Map, so what is asserted is the
                    // expression's own behaviour (take-and-delete), not a restatement of it.
                    const page: Record<string, unknown> = { [DROPPED_FILES_STASH]: stash };
                    const taken = new Function('globalThis', `return ${expression}`)(page) as (string | null)[] | undefined;
                    if (taken === undefined) return Promise.resolve({ result: { type: 'undefined' } });
                    taken.forEach((value, index) => objects.set(`obj-${String(index)}`, value));
                    return Promise.resolve({ result: { type: 'object', subtype: 'array', objectId: 'array-1' } });
                }
                case 'Runtime.getProperties':
                    expect(params['objectId']).toBe('array-1');
                    return Promise.resolve({
                        result: [
                            // Out of order and with extras, as V8 may list them.
                            ...[...objects.keys()].reverse().map((id) => ({ name: id.slice(4), value: { objectId: id } })),
                            { name: 'length', value: { type: 'number', value: objects.size } },
                            { name: 'extra', value: { objectId: 'sneaky' } }
                        ]
                    });
                case 'DOM.getFileInfo': {
                    const value = objects.get(String(params['objectId']));
                    if (value === null || value === undefined) return Promise.reject(new Error('Object is not a file'));
                    return Promise.resolve({ path: value });
                }
                case 'Runtime.releaseObjectGroup':
                    return Promise.resolve({});
                default:
                    return Promise.reject(new Error(`unexpected ${method}`));
            }
        }
    };
    return { target, calls, stash, parked, expression: () => expression, attached: () => attached };
}

describe('resolveDroppedFiles (#288)', () => {
    it('resolves every stashed File to its path, in drop order, and takes the entry out of the stash', async () => {
        const fake = fakeDebugger({ stash: new Map([['R1', ['/Users/me/a b.png', '/Users/me/dir', '/tmp/c']]]) });
        const result = await resolveDroppedFiles(fake.target, 'R1');
        expect(result).toEqual({ paths: ['/Users/me/a b.png', '/Users/me/dir', '/tmp/c'], unresolved: 0 });
        // Resolvable once: the page's Files do not outlive the request.
        expect(fake.stash.has('R1')).toBe(false);
        // Attached for the lookup and let go of afterwards, objects released first.
        expect(fake.calls[0]).toBe('attach');
        expect(fake.calls.slice(-2)).toEqual(['Runtime.releaseObjectGroup', 'detach']);
        expect(fake.attached()).toBe(false);
    });

    it('counts a File with no path on disk, and an object that is not a File, as unresolved', async () => {
        const fake = fakeDebugger({ stash: new Map([['R1', ['/a', '', null, '/b']]]) });
        expect(await resolveDroppedFiles(fake.target, 'R1')).toEqual({ paths: ['/a', '/b'], unresolved: 2 });
    });

    it('leaves other requests’ entries alone', async () => {
        const fake = fakeDebugger({ stash: new Map([['R1', ['/a']], ['R2', ['/b']]]) });
        await resolveDroppedFiles(fake.target, 'R1');
        expect([...fake.stash.keys()]).toEqual(['R2']);
    });

    it('answers with a reason when the entry is gone (the page reloaded, or already gave up)', async () => {
        const fake = fakeDebugger();
        const result = await resolveDroppedFiles(fake.target, 'missing');
        expect(result.paths).toEqual([]);
        expect(result.error).toContain('no longer waiting');
        expect(fake.attached()).toBe(false);
    });

    it('answers with a reason, and never throws, when the debugger will not attach', async () => {
        const fake = fakeDebugger({ attachThrows: true, stash: new Map([['R1', ['/a']]]) });
        const result = await resolveDroppedFiles(fake.target, 'R1');
        expect(result).toMatchObject({ paths: [], unresolved: 0 });
        expect(result.error).toContain('could not attach');
        expect(fake.calls).toEqual(['attach']);
    });

    it('detaches even when a command fails halfway', async () => {
        const fake = fakeDebugger({ evaluateThrows: true, stash: new Map([['R1', ['/a']]]) });
        const result = await resolveDroppedFiles(fake.target, 'R1');
        expect(result.error).toContain('target closed');
        expect(fake.attached()).toBe(false);
    });

    it('borrows a debugger someone else attached, and leaves it attached', async () => {
        const fake = fakeDebugger({ attached: true, stash: new Map([['R1', ['/a']]]) });
        expect((await resolveDroppedFiles(fake.target, 'R1')).paths).toEqual(['/a']);
        expect(fake.calls).not.toContain('attach');
        expect(fake.calls).not.toContain('detach');
        expect(fake.attached()).toBe(true);
    });

    it('stops at MAX_DROPPED_FILES', async () => {
        const many = Array.from({ length: MAX_DROPPED_FILES + 3 }, (_value, index) => `/f${String(index)}`);
        const fake = fakeDebugger({ stash: new Map([['R1', many]]) });
        const result = await resolveDroppedFiles(fake.target, 'R1');
        expect(result.paths).toEqual(many.slice(0, MAX_DROPPED_FILES));
        // The ones past the cap are counted, so the page can say how many were left out.
        expect(result.unresolved).toBe(3);
    });
});

describe('the lookup deadline (#288 review)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const count = (calls: readonly string[], method: string): number => calls.filter((call) => call === method).length;

    it('sits well inside the page’s own timeout, so the page hears the shell’s reason', () => {
        expect(DROPPED_FILES_LOOKUP_DEADLINE_MS).toBeLessThan(15_000);
    });

    it('answers with an error when a command never settles, and detaches exactly once', async () => {
        vi.useFakeTimers();
        const fake = fakeDebugger({ stash: new Map([['R1', ['/a']]]), hang: ['Runtime.evaluate#1'] });
        let settled: unknown = null;
        void resolveDroppedFiles(fake.target, 'R1', { deadlineMs: 8_000 }).then((result) => {
            settled = result;
        });
        await vi.advanceTimersByTimeAsync(7_999);
        expect(settled).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toEqual({ paths: [], unresolved: 0, error: 'the window did not answer within 8s' });
        expect(count(fake.calls, 'detach')).toBe(1);
        expect(fake.attached()).toBe(false);

        // The hung command answers late. The abandoned lookup must stop there: no second answer,
        // no more commands, and above all no second detach.
        const before = fake.calls.length;
        fake.parked[0]?.settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.calls.length).toBe(before);
        expect(count(fake.calls, 'detach')).toBe(1);
    });

    it('lets the next queued lookup run, and a late answer never touches its session', async () => {
        vi.useFakeTimers();
        const fake = fakeDebugger({
            stash: new Map([
                ['R1', ['/first']],
                ['R2', ['/second']]
            ]),
            hang: ['Runtime.evaluate#1']
        });
        const lookup = serialized((requestID: string) => resolveDroppedFiles(fake.target, requestID, { deadlineMs: 8_000 }));
        const first = lookup('R1');
        const second = lookup('R2');
        await vi.advanceTimersByTimeAsync(8_000);
        await expect(first).resolves.toMatchObject({ error: 'the window did not answer within 8s' });
        await expect(second).resolves.toEqual({ paths: ['/second'], unresolved: 0 });
        // One attach and one detach for each lookup, never an extra detach from the abandoned one.
        expect(count(fake.calls, 'attach')).toBe(2);
        expect(count(fake.calls, 'detach')).toBe(2);

        // And if the first lookup's command answers only now, while nothing else is attached, it
        // sends nothing on anyone's session.
        const before = fake.calls.length;
        fake.parked[0]?.settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.calls.length).toBe(before);
    });

    it('leaves a borrowed debugger attached even when the deadline passes', async () => {
        vi.useFakeTimers();
        const fake = fakeDebugger({ attached: true, stash: new Map([['R1', ['/a']]]), hang: ['Runtime.evaluate#1'] });
        const result = resolveDroppedFiles(fake.target, 'R1', { deadlineMs: 1_000 });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(result).resolves.toMatchObject({ error: 'the window did not answer within 1s' });
        expect(fake.calls).not.toContain('detach');
        expect(fake.attached()).toBe(true);
    });

    it('clears its timer when the lookup finishes first', async () => {
        vi.useFakeTimers();
        const fake = fakeDebugger({ stash: new Map([['R1', ['/a']]]) });
        await expect(resolveDroppedFiles(fake.target, 'R1')).resolves.toEqual({ paths: ['/a'], unresolved: 0 });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('stashTakeExpression (#288)', () => {
    it('interpolates the request id only as a JSON string literal', () => {
        const hostile = `"); globalThis.pwned = true; ("`;
        const expression = stashTakeExpression(hostile);
        expect(expression).toContain(JSON.stringify(hostile));
        const page: Record<string, unknown> = { [DROPPED_FILES_STASH]: new Map([[hostile, ['x']]]) };
        const taken = new Function('globalThis', `return ${expression}`)(page) as unknown;
        expect(taken).toEqual(['x']);
        expect(page['pwned']).toBeUndefined();
    });

    it('reads nothing from a stash that is not a Map, or an entry that is not an array', () => {
        const run = (page: Record<string, unknown>, id: string): unknown =>
            new Function('globalThis', `return ${stashTakeExpression(id)}`)(page) as unknown;
        expect(run({}, 'R1')).toBeUndefined();
        expect(run({ [DROPPED_FILES_STASH]: { R1: ['x'] } }, 'R1')).toBeUndefined();
        expect(run({ [DROPPED_FILES_STASH]: new Map([['R1', 'x']]) }, 'R1')).toBeUndefined();
    });
});

describe('serialized (#288)', () => {
    it('runs one lookup at a time, and a failure does not wedge the next', async () => {
        const events: string[] = [];
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const run = serialized(async (name: string) => {
            events.push(`start ${name}`);
            if (name === 'a') await gate;
            if (name === 'b') throw new Error('b failed');
            events.push(`end ${name}`);
            return name;
        });
        const a = run('a');
        const b = run('b');
        const c = run('c');
        await Promise.resolve();
        expect(events).toEqual(['start a']);
        release?.();
        await expect(a).resolves.toBe('a');
        await expect(b).rejects.toThrow('b failed');
        await expect(c).resolves.toBe('c');
        expect(events).toEqual(['start a', 'end a', 'start b', 'start c', 'end c']);
    });
});
