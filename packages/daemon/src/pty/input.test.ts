import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NAMED_KEYS, unknownNamedKeyError } from '@kelpi/protocol';
import type { NamedKey } from '@kelpi/protocol';
import type { PtyManager, VtModes } from '../seams.js';
import {
    BRACKETED_PASTE_END,
    BRACKETED_PASTE_START,
    UnknownNamedKeyError,
    createTerminalInput,
    encodeNamedKey,
    encodePasteText,
    filterPasteText,
    isUnknownNamedKeyError
} from './input.js';
import { FALLBACK_SHELL, createPtyManager } from './manager.js';
import type { KelpiPtyManager } from './manager.js';
import type { PtyProcessHandle } from './types.js';

/** Minimal in-memory PTY for the "programmatic sends don't mirror" check. */
class StubPty implements PtyProcessHandle {
    readonly pid = 1234;
    readonly writes: string[] = [];

    write(data: string | Uint8Array): void {
        this.writes.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    }

    resize(): void {}
    kill(): void {}
    onData(): void {}
    onExit(): void {}
}

const OFF: VtModes = { applicationCursorKeys: false, bracketedPaste: false };
const DECCKM: VtModes = { applicationCursorKeys: true, bracketedPaste: false };
const BRACKETED: VtModes = { applicationCursorKeys: false, bracketedPaste: true };

/** Records what reached the PTY, in order. */
function recorder(): { pty: Pick<PtyManager, 'writeDirect'>; writes: string[] } {
    const writes: string[] = [];
    return {
        writes,
        pty: {
            writeDirect(_paneID: string, data: Uint8Array | string): void {
                writes.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
            }
        }
    };
}

function inputWith(modes: VtModes) {
    const { pty, writes } = recorder();
    return { input: createTerminalInput({ pty, modes: () => modes }), writes };
}

describe('encodeNamedKey — the §9.2 table', () => {
    const byteKeys: Array<[NamedKey, string]> = [
        ['enter', '\r'],
        ['return', '\r'],
        ['tab', '\t'],
        ['escape', '\x1b'],
        ['esc', '\x1b'],
        ['space', ' '],
        ['backspace', '\x7f'],
        ['ctrl-c', '\x03']
    ];

    it.each(byteKeys)('%s → raw byte, identical in both cursor-key modes', (key, expected) => {
        expect(encodeNamedKey(key, OFF)).toBe(expected);
        expect(encodeNamedKey(key, DECCKM)).toBe(expected);
        expect(encodeNamedKey(key, BRACKETED)).toBe(expected);
    });

    it('backspace is DEL (0x7f), not BS (0x08)', () => {
        expect(Buffer.from(encodeNamedKey('backspace', OFF), 'utf8')).toEqual(
            Buffer.from([0x7f])
        );
    });

    it('ctrl-c is the raw ETX byte so the line discipline raises SIGINT', () => {
        expect(Buffer.from(encodeNamedKey('ctrl-c', OFF), 'utf8')).toEqual(Buffer.from([0x03]));
    });

    const arrows: Array<[NamedKey, string, string]> = [
        ['up', '\x1b[A', '\x1bOA'],
        ['down', '\x1b[B', '\x1bOB'],
        ['right', '\x1b[C', '\x1bOC'],
        ['left', '\x1b[D', '\x1bOD']
    ];

    it.each(arrows)('%s: normal → %j, DECCKM → %j', (key, normal, application) => {
        expect(encodeNamedKey(key, OFF)).toBe(normal);
        expect(encodeNamedKey(key, DECCKM)).toBe(application);
    });

    it('covers every name in the wire vocabulary', () => {
        for (const key of NAMED_KEYS) {
            expect(encodeNamedKey(key, OFF).length).toBeGreaterThan(0);
        }
    });
});

describe('sendNamedKey', () => {
    it('writes exactly one payload per key, un-mirrored (§8.2)', () => {
        const { input, writes } = inputWith(OFF);
        input.sendNamedKey('pane-1', 'enter');
        expect(writes).toEqual(['\r']);
    });

    it('lowercases the name before lookup (Enter / ENTER / enter)', () => {
        const { input, writes } = inputWith(OFF);
        input.sendNamedKey('pane-1', 'Enter');
        input.sendNamedKey('pane-1', 'ENTER');
        input.sendNamedKey('pane-1', 'EsC');
        expect(writes).toEqual(['\r', '\r', '\x1b']);
    });

    it('consults live DECCKM state per call', () => {
        const { pty, writes } = recorder();
        let application = false;
        const input = createTerminalInput({
            pty,
            modes: () => ({ applicationCursorKeys: application, bracketedPaste: false })
        });

        input.sendNamedKey('pane-1', 'up');
        application = true;
        input.sendNamedKey('pane-1', 'up');

        expect(writes).toEqual(['\x1b[A', '\x1bOA']);
    });

    it('throws the wire-protocol error for an unknown key, before writing anything', () => {
        const { input, writes } = inputWith(OFF);
        let thrown: unknown;
        try {
            input.sendNamedKey('pane-1', 'F13');
        } catch (error) {
            thrown = error;
        }

        expect(isUnknownNamedKeyError(thrown)).toBe(true);
        expect((thrown as UnknownNamedKeyError).message).toBe(unknownNamedKeyError('F13'));
        expect((thrown as UnknownNamedKeyError).message).toBe(
            "unknown key 'f13' (valid: enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c)"
        );
        expect((thrown as UnknownNamedKeyError).key).toBe('F13');
        expect(writes).toEqual([]);
    });

    it('falls back to default modes when the pane has no VT state', () => {
        const { pty, writes } = recorder();
        const input = createTerminalInput({
            pty,
            modes: () => {
                throw new Error('no such pane');
            }
        });
        input.sendNamedKey('pane-1', 'up');
        expect(writes).toEqual(['\x1b[A']);
    });
});

describe('filterPasteText / encodePasteText (§9.1 paste pipeline)', () => {
    it('passes ordinary text (and non-ASCII) through untouched', () => {
        expect(filterPasteText('git status — ✅')).toBe('git status — ✅');
    });

    it('keeps tabs but drops other C0 controls and DEL', () => {
        expect(filterPasteText('a\tb\x07c\x00d\x7fe')).toBe('a\tbcde');
    });

    it('normalizes CRLF and LF to CR', () => {
        expect(filterPasteText('one\r\ntwo\nthree\rfour')).toBe('one\rtwo\rthree\rfour');
    });

    it('strips embedded bracketed-paste markers so text cannot close its own envelope', () => {
        expect(filterPasteText(`evil${BRACKETED_PASTE_END}rm -rf /`)).toBe('evilrm -rf /');
        expect(filterPasteText(`${BRACKETED_PASTE_START}x`)).toBe('x');
    });

    it('drops escape sequences that would otherwise reach the emulator', () => {
        expect(filterPasteText('safe\x1b[31mred')).toBe('safe[31mred');
    });

    it('wraps in the envelope only when the app enabled bracketed paste', () => {
        expect(encodePasteText('ls', BRACKETED)).toBe(
            `${BRACKETED_PASTE_START}ls${BRACKETED_PASTE_END}`
        );
        expect(encodePasteText('ls', OFF)).toBe('ls');
    });

    it('emits nothing for text that filters down to empty', () => {
        expect(encodePasteText('\x00\x07', BRACKETED)).toBe('');
    });
});

describe('sendText (§9.1: text-as-paste, then Enter-as-keystroke)', () => {
    it('sends the paste and the Enter as two separate writes', () => {
        const { input, writes } = inputWith(BRACKETED);
        input.sendText('pane-1', 'echo hi', { bare: false });
        expect(writes).toEqual([
            `${BRACKETED_PASTE_START}echo hi${BRACKETED_PASTE_END}`,
            '\r'
        ]);
    });

    it('leaves the Enter out with bare=true', () => {
        const { input, writes } = inputWith(BRACKETED);
        input.sendText('pane-1', 'echo hi', { bare: true });
        expect(writes).toEqual([`${BRACKETED_PASTE_START}echo hi${BRACKETED_PASTE_END}`]);
    });

    it('sends raw text when bracketed paste is off', () => {
        const { input, writes } = inputWith(OFF);
        input.sendText('pane-1', 'echo hi', { bare: false });
        expect(writes).toEqual(['echo hi', '\r']);
    });

    it('still presses Enter when the payload filters to nothing', () => {
        const { input, writes } = inputWith(OFF);
        input.sendText('pane-1', '\x00', { bare: false });
        expect(writes).toEqual(['\r']);
    });

    it('re-reads the pane modes on every send', () => {
        const { pty, writes } = recorder();
        let bracketed = false;
        const input = createTerminalInput({
            pty,
            modes: () => ({ applicationCursorKeys: false, bracketedPaste: bracketed })
        });

        input.sendText('pane-1', 'a', { bare: true });
        bracketed = true;
        input.sendText('pane-1', 'b', { bare: true });

        expect(writes).toEqual(['a', `${BRACKETED_PASTE_START}b${BRACKETED_PASTE_END}`]);
    });

    it('never mirrors to sync siblings — programmatic sends target one pane (§8.2)', () => {
        const procs: StubPty[] = [];
        const manager = createPtyManager({
            spawner: () => {
                const proc = new StubPty();
                procs.push(proc);
                return proc;
            }
        });
        const paneOpts = (paneID: string) => ({
            paneID,
            cwd: '/',
            env: [] as ReadonlyArray<readonly [string, string]>,
            cols: 80,
            rows: 24,
            shell: FALLBACK_SHELL
        });
        manager.spawn(paneOpts('a'));
        manager.spawn(paneOpts('b'));
        manager.setSyncGroup('ws-1', new Set(['a', 'b']));

        const input = createTerminalInput({ pty: manager, modes: () => OFF });
        input.sendText('a', 'x', { bare: true });
        input.sendNamedKey('a', 'ctrl-c');

        expect(procs[0]?.writes).toEqual(['x', '\x03']);
        expect(procs[1]?.writes).toEqual([]);

        // Control: interactive input through write() DOES mirror.
        manager.write('a', 'y');
        expect(procs[1]?.writes).toEqual(['y']);
    });
});

describe('real PTY input pipeline', () => {
    const managers: KelpiPtyManager[] = [];
    const dirs: string[] = [];

    const delay = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        });

    async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (predicate()) return;
            await delay(10);
        }
        throw new Error('waitFor: condition not met within timeout');
    }

    afterEach(async () => {
        await Promise.all(managers.splice(0).map((manager) => manager.killAll()));
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('drives a real shell with sendText + sendNamedKey', { timeout: 20_000 }, async () => {
        const manager = createPtyManager();
        managers.push(manager);
        const dir = mkdtempSync(join(tmpdir(), 'kelpi-input-'));
        dirs.push(dir);

        let output = '';
        manager.onData((_paneID, data) => {
            output += Buffer.from(data).toString('utf8');
        });
        manager.spawn({
            paneID: 'pane-1',
            cwd: dir,
            env: [['NEX_PANE_ID', 'pane-1']],
            cols: 80,
            rows: 24,
            shell: FALLBACK_SHELL
        });

        const input = createTerminalInput({ pty: manager, modes: () => OFF });

        // `pane send` with the Enter appended.
        input.sendText('pane-1', 'printf "SEND[%s]\\n" one', { bare: false });
        await waitFor(() => output.includes('SEND[one]'));

        // `pane send --bare` leaves the line un-submitted until send-key delivers Enter.
        const before = output.length;
        input.sendText('pane-1', 'printf "BARE[%s]\\n" two', { bare: true });
        await delay(200);
        expect(output.slice(before)).not.toContain('BARE[two]');

        input.sendNamedKey('pane-1', 'enter');
        await waitFor(() => output.includes('BARE[two]'));
    });

    it('ctrl-c interrupts the foreground command', { timeout: 20_000 }, async () => {
        const manager = createPtyManager();
        managers.push(manager);
        const dir = mkdtempSync(join(tmpdir(), 'kelpi-input-'));
        dirs.push(dir);

        let output = '';
        manager.onData((_paneID, data) => {
            output += Buffer.from(data).toString('utf8');
        });
        manager.spawn({
            paneID: 'pane-1',
            cwd: dir,
            env: [['NEX_PANE_ID', 'pane-1']],
            cols: 80,
            rows: 24,
            shell: FALLBACK_SHELL
        });

        const input = createTerminalInput({ pty: manager, modes: () => OFF });
        input.sendText('pane-1', 'sleep 30', { bare: false });
        await delay(500);

        // The raw ETX byte must reach the line discipline: without SIGINT the shell stays
        // blocked in `sleep 30` and the follow-up command could not run for 30s.
        const started = Date.now();
        input.sendNamedKey('pane-1', 'ctrl-c');
        input.sendText('pane-1', 'printf "ALIVE[%s]\\n" yes', { bare: false });
        await waitFor(() => output.includes('ALIVE[yes]'), 8_000);
        expect(Date.now() - started).toBeLessThan(8_000);
    });
});
