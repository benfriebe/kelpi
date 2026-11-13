import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every payload sent to the daemon: a help request must send none. */
const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../transport.js', async (original) => ({
    ...(await original<object>()),
    sendJSON: (payload: Record<string, unknown>) => {
        sent.push(payload);
        return Promise.resolve();
    }
}));

import { resetIO, setIO } from '../io.js';
import { handleGroup } from './group.js';

let out = '';

beforeEach(() => {
    out = '';
    setIO({ out: (text) => (out += text), err: () => undefined });
});
afterEach(() => {
    sent.length = 0;
    resetIO();
});

describe('kelpi group <subcommand> --help', () => {
    it.each([['create'], ['rename'], ['delete']])('should print help for %s and send nothing', async (action) => {
        await expect(handleGroup([action, '--help'])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain(`kelpi group ${action}`);
        expect(sent).toEqual([]);
    });

    it('should print help for -h after a name', async () => {
        await expect(handleGroup(['create', 'work', '-h'])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain('kelpi group create');
        expect(sent).toEqual([]);
    });

    it('should still create a group from a plain name', async () => {
        await handleGroup(['create', 'work', '--color', 'blue']);
        expect(sent).toEqual([{ command: 'group-create', name: 'work', color: 'blue' }]);
    });
});

describe('kelpi group create|rename|delete names', () => {
    it('should treat a name after -- as a name, so a group called --help can be deleted', async () => {
        await handleGroup(['delete', '--', '--help']);
        expect(sent).toEqual([{ command: 'group-delete', name: '--help', cascade: false }]);
    });

    it('should read a flag given before the name and the -- that follows it', async () => {
        await handleGroup(['create', '--color', 'red', '--', '--help']);
        expect(sent).toEqual([{ command: 'group-create', name: '--help', color: 'red' }]);
    });

    it('should read --cascade given before the name', async () => {
        await handleGroup(['delete', '--cascade', 'work']);
        expect(sent).toEqual([{ command: 'group-delete', name: 'work', cascade: true }]);
    });

    it('should send keep_emoji only with --keep-emoji, on create and on rename', async () => {
        await handleGroup(['create', '🔥 team']);
        await handleGroup(['create', '--keep-emoji', '🔥 team']);
        await handleGroup(['rename', 'team', '🚧 team', '--keep-emoji']);
        expect(sent).toEqual([
            { command: 'group-create', name: '🔥 team' },
            { command: 'group-create', name: '🔥 team', keep_emoji: true },
            { command: 'group-rename', name: 'team', new_name: '🚧 team', keep_emoji: true }
        ]);
    });

    it('should take both rename names from either side of a --', async () => {
        await handleGroup(['rename', 'work', '--', '-h']);
        await handleGroup(['rename', '--', '--help', 'work']);
        expect(sent).toEqual([
            { command: 'group-rename', name: 'work', new_name: '-h' },
            { command: 'group-rename', name: '--help', new_name: 'work' }
        ]);
    });
});
