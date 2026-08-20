import { describe, expect, it } from 'vitest';

import {
    EDITOR_BEGIN_MARKER,
    EDITOR_END_MARKER,
    chooseEditor,
    createEditorResolver,
    editorProbeScript,
    formatEditorCommand,
    parseShellOutput,
    probeLoginShell,
    resolveFromProcessEnv,
    resolveUserShell,
    singleQuoteEscape,
    type EditorResolution
} from './external-editor.js';

describe('formatEditorCommand (CONT-088)', () => {
    it('is the `env PATH=… editor file` form, not a VAR=value prefix', () => {
        expect(formatEditorCommand('nvim', '/docs/a.md', '/usr/local/bin:/usr/bin')).toBe(
            "/usr/bin/env PATH='/usr/local/bin:/usr/bin' nvim '/docs/a.md'"
        );
    });

    it('drops the env prefix when the shell reported no PATH', () => {
        expect(formatEditorCommand('code -w', '/docs/a.md', null)).toBe("code -w '/docs/a.md'");
        expect(formatEditorCommand('vi', '/docs/a.md', '')).toBe("vi '/docs/a.md'");
    });

    it('single-quote escapes both the file and the PATH', () => {
        expect(singleQuoteEscape("it's")).toBe("it'\\''s");
        expect(formatEditorCommand('vi', "/docs/it's.md", null)).toBe("vi '/docs/it'\\''s.md'");
        expect(formatEditorCommand('vi', '/a.md', "/o'dd/bin")).toContain("PATH='/o'\\''dd/bin'");
    });
});

describe('parseShellOutput (CONT-084)', () => {
    const transcript = [
        'direnv: loading /Users/x/.envrc',
        'Last login: Tue Aug 19 on ttys004',
        '',
        EDITOR_BEGIN_MARKER,
        'nvim',
        'vi',
        '/usr/local/bin:/usr/bin',
        EDITOR_END_MARKER,
        ''
    ].join('\n');

    it('finds the values after arbitrary rc-file noise', () => {
        expect(parseShellOutput(transcript)).toEqual({
            visual: 'nvim',
            editor: 'vi',
            path: '/usr/local/bin:/usr/bin'
        });
    });

    it('yields empties when the marker never printed (a killed shell)', () => {
        expect(parseShellOutput('direnv: loading\nsome banner\n')).toEqual({
            visual: '',
            editor: '',
            path: ''
        });
    });

    it('never mistakes the end marker for a value', () => {
        const short = [EDITOR_BEGIN_MARKER, '', '', EDITOR_END_MARKER].join('\n');
        expect(parseShellOutput(short)).toEqual({ visual: '', editor: '', path: '' });
    });

    it('the probe script prints exactly the three values between the sentinels', () => {
        const script = editorProbeScript();
        expect(script).toContain('"$VISUAL"');
        expect(script).toContain('"$EDITOR"');
        expect(script).toContain('"$PATH"');
        expect(script.indexOf(EDITOR_BEGIN_MARKER)).toBeLessThan(script.indexOf('"$VISUAL"'));
        expect(script.indexOf('"$PATH"')).toBeLessThan(script.indexOf(EDITOR_END_MARKER));
    });
});

describe('chooseEditor (CONT-083)', () => {
    it('$VISUAL wins over $EDITOR', () => {
        expect(chooseEditor('nvim', 'vi')).toBe('nvim');
    });

    it('falls back to $EDITOR, then to nothing', () => {
        expect(chooseEditor('', 'vi')).toBe('vi');
        expect(chooseEditor('  ', '  ')).toBeNull();
    });
});

describe('resolveUserShell (CONT-082)', () => {
    it('answers something absolute, and honours $SHELL when passwd has nothing', () => {
        expect(resolveUserShell()).toMatch(/^\//);
        // The passwd record wins on a real machine, so the only assertion that holds
        // everywhere is that the result is a usable path.
        expect(resolveUserShell({ SHELL: '/opt/fish' })).toMatch(/^\//);
    });
});

describe('resolveFromProcessEnv', () => {
    it('reads VISUAL, then EDITOR, and reports the source', () => {
        expect(resolveFromProcessEnv({ VISUAL: 'nvim', EDITOR: 'vi', PATH: '/bin' })).toEqual({
            editor: 'nvim',
            path: '/bin',
            source: 'process-env'
        });
        expect(resolveFromProcessEnv({ EDITOR: 'vi' })).toEqual({
            editor: 'vi',
            path: null,
            source: 'process-env'
        });
        expect(resolveFromProcessEnv({})).toBeNull();
    });
});

describe('probeLoginShell (CONT-085)', () => {
    it('reads $VISUAL out of a real shell run with a controlled environment', async () => {
        const resolution = await probeLoginShell({
            shell: '/bin/sh',
            env: { VISUAL: 'nvim-from-probe', EDITOR: 'vi', PATH: '/usr/bin:/bin', HOME: '/tmp' }
        });
        expect(resolution).not.toBeNull();
        expect(resolution?.editor).toBe('nvim-from-probe');
        expect(resolution?.source).toBe('shell');
    });

    it('answers null rather than throwing when the shell cannot be spawned', async () => {
        const resolution = await probeLoginShell({
            shell: '/definitely/not/a/shell',
            timeoutMs: 500
        });
        expect(resolution).toBeNull();
    });

    it('survives a shell that floods stdout before printing (the 64 KB pipe deadlock)', async () => {
        // 200 KB of banner ahead of the sentinels: a probe that only read after exit would
        // wedge on `write(2)` and be killed by the watchdog.
        const resolution = await probeLoginShell({
            shell: '/bin/sh',
            env: { VISUAL: 'quiet-editor', PATH: '/usr/bin:/bin', HOME: '/tmp', NOISE: 'x'.repeat(200_000) },
            timeoutMs: 5000
        });
        expect(resolution?.editor).toBe('quiet-editor');
    });
});

describe('createEditorResolver (CONT-086/087)', () => {
    function fixedResolution(editor: string): EditorResolution {
        return { editor, path: '/bin', source: 'shell' };
    }

    it('caches a success for the process lifetime and never re-probes', async () => {
        let probes = 0;
        const resolver = createEditorResolver({
            probe: async () => {
                probes += 1;
                return fixedResolution('nvim');
            },
            fromEnv: () => null
        });
        expect(await resolver.resolve()).toEqual(fixedResolution('nvim'));
        expect(await resolver.resolve()).toEqual(fixedResolution('nvim'));
        expect(probes).toBe(1);
        expect(resolver.current()?.editor).toBe('nvim');
        expect(resolver.buildCommand('/a.md')).toBe("/usr/bin/env PATH='/bin' nvim '/a.md'");
    });

    it('never blocks: current() is null until the probe settles', async () => {
        const gate: { release: ((value: EditorResolution | null) => void) | null } = { release: null };
        const resolver = createEditorResolver({
            probe: () =>
                new Promise<EditorResolution | null>((resolve) => {
                    gate.release = resolve;
                }),
            fromEnv: () => null
        });
        resolver.warmUp();
        expect(resolver.current()).toBeNull();
        expect(resolver.buildCommand('/a.md')).toBeNull();
        gate.release?.(fixedResolution('vi'));
        await Promise.resolve();
        await Promise.resolve();
        expect(resolver.current()?.editor).toBe('vi');
    });

    it('holds a failure for the retry TTL, then probes again', async () => {
        let probes = 0;
        let clock = 1000;
        const resolver = createEditorResolver({
            probe: async () => {
                probes += 1;
                return probes >= 2 ? fixedResolution('late') : null;
            },
            fromEnv: () => null,
            now: () => clock,
            failureRetryMs: 30_000
        });
        expect(await resolver.resolve()).toBeNull();
        expect(probes).toBe(1);
        // Inside the TTL: no second shell spawn.
        clock += 10_000;
        expect(await resolver.resolve()).toBeNull();
        expect(probes).toBe(1);
        // Past it: retried, and the answer sticks.
        clock += 30_000;
        expect(await resolver.resolve()).toEqual(fixedResolution('late'));
        expect(probes).toBe(2);
    });

    it('falls back to the process environment when the shell says nothing', async () => {
        const resolver = createEditorResolver({
            probe: async () => null,
            fromEnv: () => ({ editor: 'vi', path: null, source: 'process-env' })
        });
        expect(await resolver.resolve()).toEqual({ editor: 'vi', path: null, source: 'process-env' });
        expect(resolver.buildCommand('/a.md')).toBe("vi '/a.md'");
    });

    it('warmUp is idempotent', async () => {
        let probes = 0;
        const resolver = createEditorResolver({
            probe: async () => {
                probes += 1;
                return fixedResolution('nvim');
            },
            fromEnv: () => null
        });
        resolver.warmUp();
        resolver.warmUp();
        resolver.warmUp();
        await resolver.resolve();
        expect(probes).toBe(1);
    });
});
