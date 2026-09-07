import { describe, expect, it } from 'vitest';

import {
    HARNESS_OPS,
    HarnessCounters,
    NOTIFICATION_HISTORY,
    LineBuffer,
    acceleratorMatches,
    closestLabels,
    encodeResponse,
    findByAccelerator,
    findMenuItem,
    harnessQuietNotifications,
    harnessSocketPath,
    menuClickVerdict,
    messageBoxSpecFrom,
    normaliseAccelerator,
    normaliseLabel,
    parseDialogArm,
    parseRequest,
    respond,
    respondToLine,
    serialiseMenu,
    type HarnessRequest,
    type HarnessSurface,
    type MenuEntryLike,
    type WindowSnapshot
} from './harness-protocol.js';
import type { KelpiNotificationHandle, KelpiNotificationRequest } from './notify.js';

// ── fixtures ────────────────────────────────────────────────────────────────────────

/** A plain-object stand-in for an Electron `MenuItem`; `submenu.items` is the recursion. */
interface FakeItem extends MenuEntryLike<FakeItem> {
    readonly clicks?: string[];
}

function row(spec: Partial<FakeItem> & { label: string }): FakeItem {
    return spec;
}

function sub(label: string, items: FakeItem[], extra: Partial<FakeItem> = {}): FakeItem {
    return { label, submenu: { items }, ...extra };
}

/** The shape of the shipped menu (shell-ui.md §13), enough of it for every rule to have a row. */
function fixture(): FakeItem[] {
    return [
        sub('Kelpi', [
            row({ label: 'About Kelpi', role: 'about' }),
            row({ label: 'Check for Updates…', enabled: false }),
            row({ label: '', type: 'separator' }),
            row({ label: 'Quit Kelpi', role: 'quit', accelerator: 'Command+Q' })
        ]),
        sub('&File', [
            row({ label: 'New Workspace', accelerator: 'CommandOrControl+N' }),
            row({ label: 'New Group', accelerator: 'CommandOrControl+Shift+G' }),
            row({ label: 'Preview Markdown…', accelerator: 'CommandOrControl+O' }),
            row({ label: 'Close', accelerator: 'CommandOrControl+W' }),
            row({ label: '', type: 'separator' }),
            row({ label: 'Deselect All Workspaces', id: 'deselect-all-workspaces', enabled: false }),
            row({ label: 'Switch to Workspace 1', accelerator: 'CommandOrControl+1' }),
            row({ label: 'Find && Replace', accelerator: 'CommandOrControl+F' })
        ]),
        sub('Edit', [row({ label: 'Copy', role: 'copy', accelerator: 'Command+C' })], { role: 'editMenu' }),
        sub('View', [
            row({ label: 'Toggle Sidebar', accelerator: 'CommandOrControl+Shift+S' }),
            row({ label: 'Show Status Bar', type: 'checkbox', checked: true }),
            row({ label: 'Secret', visible: false, accelerator: 'CommandOrControl+Shift+X' }),
            row({ label: 'Retired', enabled: false, accelerator: 'CommandOrControl+Shift+R' }),
            row({ label: 'Reload Everything', accelerator: 'CommandOrControl+Shift+R' }),
            row({ label: 'Toggle Full Screen', role: 'togglefullscreen', accelerator: 'Control+Command+F' })
        ]),
        sub('Debug', [row({ label: 'Seed Test Group', accelerator: 'CommandOrControl+Shift+D' })], { enabled: false }),
        sub('Help', [row({ label: 'Kelpi Help', accelerator: 'CommandOrControl+?' })])
    ];
}

interface FakeSurfaceState {
    readonly clicked: FakeItem[];
    window: WindowSnapshot | null;
    focused: boolean;
    /** #75's two window states, tracked the way a real `BrowserWindow` reports them. */
    visible: boolean;
    minimized: boolean;
}

function fakeSurface(items: FakeItem[] = fixture()): { surface: HarnessSurface<FakeItem>; state: FakeSurfaceState } {
    const state: FakeSurfaceState = {
        clicked: [],
        window: { focused: true, visible: true, minimized: false, bounds: { x: 10, y: 20, width: 800, height: 600 } },
        focused: true,
        visible: true,
        minimized: false
    };
    const surface: HarnessSurface<FakeItem> = {
        platform: 'darwin',
        pid: 4242,
        version: () => '0.1.0-test',
        menuItems: () => items,
        clickItem: (item) => {
            if (item.label === 'Reload Everything') throw new Error('relay is down');
            state.clicked.push(item);
        },
        window: () => state.window,
        focus: () => {
            if (state.window === null) return null;
            state.focused = true;
            return true;
        },
        blur: () => {
            if (state.window === null) return null;
            state.focused = false;
            return false;
        },
        hide: () => {
            if (state.window === null) return null;
            state.visible = false;
            state.focused = false;
            return { visible: state.visible, minimized: state.minimized };
        },
        minimize: () => {
            if (state.window === null) return null;
            state.minimized = true;
            state.focused = false;
            return { visible: state.visible, minimized: state.minimized };
        },
        restore: () => {
            if (state.window === null) return null;
            state.minimized = false;
            state.visible = true;
            return { visible: state.visible, minimized: state.minimized };
        },
        counters: new HarnessCounters()
    };
    return { surface, state };
}

function request(op: string, params: Record<string, unknown> = {}, id: number | string = 1): HarnessRequest {
    return { id, op, params };
}

// ── the gate ────────────────────────────────────────────────────────────────────────

describe('the harness socket is OFF unless KELPI_HARNESS_SOCKET names a path', () => {
    it('returns null for an empty environment', () => {
        expect(harnessSocketPath({})).toBeNull();
    });

    it('treats an empty or blank value as unset', () => {
        expect(harnessSocketPath({ KELPI_HARNESS_SOCKET: '' })).toBeNull();
        expect(harnessSocketPath({ KELPI_HARNESS_SOCKET: '   ' })).toBeNull();
    });

    it('is not switched on by the other harness markers', () => {
        // The load-bearing case: the smoke, the packaging probes and the audit all set these and
        // assert on a shell a user would get. None of them may grow a control socket.
        expect(harnessSocketPath({ KELPI_HARNESS: '1', KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: 'hidden' })).toBeNull();
    });

    it('returns the path verbatim when set', () => {
        expect(harnessSocketPath({ KELPI_HARNESS_SOCKET: '/tmp/x y/harness.sock' })).toBe('/tmp/x y/harness.sock');
    });
});

// ── requests ────────────────────────────────────────────────────────────────────────

describe('parseRequest', () => {
    it('accepts a numeric id, a string id, and keeps the other fields as params', () => {
        expect(parseRequest('{"id":1,"op":"ping"}')).toEqual({ ok: true, request: { id: 1, op: 'ping', params: {} } });
        expect(parseRequest('{"id":"a","op":"press","accelerator":"Cmd+N"}')).toEqual({
            ok: true,
            request: { id: 'a', op: 'press', params: { accelerator: 'Cmd+N' } }
        });
    });

    it('rejects the malformed shapes with a reason each', () => {
        expect(parseRequest('{not json')).toMatchObject({ ok: false, error: expect.stringMatching(/^malformed JSON/) });
        expect(parseRequest('[1,2]')).toMatchObject({ ok: false, error: 'request must be a JSON object' });
        expect(parseRequest('"ping"')).toMatchObject({ ok: false });
        expect(parseRequest('{"op":"ping"}')).toMatchObject({ ok: false, error: expect.stringMatching(/request\.id/) });
        expect(parseRequest('{"id":null,"op":"ping"}')).toMatchObject({ ok: false, error: expect.stringMatching(/request\.id/) });
        expect(parseRequest('{"id":1}')).toMatchObject({ ok: false, error: expect.stringMatching(/request\.op/) });
        expect(parseRequest('{"id":1,"op":""}')).toMatchObject({ ok: false, error: expect.stringMatching(/request\.op/) });
    });

    it('answers a malformed line with id null and ok false, on one line', () => {
        const { surface } = fakeSurface();
        const response = respondToLine('nope', surface);
        expect(response).toMatchObject({ id: null, ok: false });
        const encoded = encodeResponse(response);
        expect(encoded.endsWith('\n')).toBe(true);
        expect(encoded.slice(0, -1)).not.toContain('\n');
        expect(JSON.parse(encoded)).toMatchObject({ id: null, ok: false });
    });

    it('answers an unknown op with ok false and the list of ops', () => {
        const { surface } = fakeSurface();
        const response = respond(request('teleport'), surface);
        expect(response).toMatchObject({ id: 1, ok: false, error: expect.stringContaining('unknown op "teleport"') });
        expect(response.ok ? '' : response.error).toContain(HARNESS_OPS.join(', '));
    });
});

describe('LineBuffer', () => {
    it('reassembles lines across chunks, strips CR, and skips blank lines', () => {
        const buffer = new LineBuffer();
        expect(buffer.push('{"id":1,')).toEqual([]);
        expect(buffer.push('"op":"ping"}\r\n\n{"id":2,"op":"menu"}\n{"id":3')).toEqual([
            '{"id":1,"op":"ping"}',
            '{"id":2,"op":"menu"}'
        ]);
        expect(buffer.push(',"op":"window"}\n')).toEqual(['{"id":3,"op":"window"}']);
    });
});

// ── menu serialisation ──────────────────────────────────────────────────────────────

describe('serialiseMenu', () => {
    it('emits every field of MenuNode with Electron defaults filled in', () => {
        const [kelpi] = serialiseMenu(fixture());
        expect(kelpi).toMatchObject({
            id: null,
            label: 'Kelpi',
            accelerator: null,
            enabled: true,
            visible: true,
            type: 'submenu',
            role: null,
            checked: null
        });
        expect(kelpi?.submenu?.map((node) => node.label)).toEqual(['About Kelpi', 'Check for Updates…', '', 'Quit Kelpi']);
        expect(kelpi?.submenu?.[0]).toEqual({
            id: null,
            label: 'About Kelpi',
            accelerator: null,
            enabled: true,
            visible: true,
            type: 'normal',
            role: 'about',
            checked: null,
            submenu: null
        });
        expect(kelpi?.submenu?.[1]?.enabled).toBe(false);
        expect(kelpi?.submenu?.[2]?.type).toBe('separator');
        expect(kelpi?.submenu?.[3]).toMatchObject({ role: 'quit', accelerator: 'Command+Q' });
    });

    it('carries ids, hidden rows, role submenus and checkbox state', () => {
        const nodes = serialiseMenu(fixture());
        const file = nodes[1]?.submenu ?? [];
        expect(file.find((node) => node.id === 'deselect-all-workspaces')).toMatchObject({ enabled: false });
        expect(nodes[2]).toMatchObject({ label: 'Edit', role: 'editMenu', type: 'submenu' });
        const view = nodes[3]?.submenu ?? [];
        expect(view.find((node) => node.label === 'Secret')).toMatchObject({ visible: false });
        expect(view.find((node) => node.label === 'Show Status Bar')).toMatchObject({ type: 'checkbox', checked: true });
    });

    it('is plain JSON all the way down', () => {
        const nodes = serialiseMenu(fixture());
        expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes);
    });
});

// ── label lookup ────────────────────────────────────────────────────────────────────

describe('normaliseLabel', () => {
    it('drops every ampersand, collapses whitespace, and strips a trailing ellipsis', () => {
        expect(normaliseLabel('&File')).toBe('file');
        expect(normaliseLabel('Find && Replace')).toBe('find replace');
        expect(normaliseLabel('Find & Replace')).toBe('find replace');
        expect(normaliseLabel('Find Replace')).toBe('find replace');
        expect(normaliseLabel('Preview Markdown…')).toBe('preview markdown');
        expect(normaliseLabel('Preview Markdown...')).toBe('preview markdown');
        expect(normaliseLabel('  Check for Updates… ')).toBe('check for updates');
    });
});

describe('findMenuItem', () => {
    it('finds by id first', () => {
        const found = findMenuItem(fixture(), { id: 'deselect-all-workspaces' });
        expect(found.ok && found.item.label).toBe('Deselect All Workspaces');
    });

    it('finds by label path, case-insensitively, through ampersands and ellipses', () => {
        const items = fixture();
        for (const path of [
            ['File', 'New Workspace'],
            ['file', 'new workspace'],
            ['&File', 'New Workspace'],
            ['File', 'Preview Markdown'],
            ['File', 'Preview Markdown...'],
            ['File', 'Preview Markdown…'],
            ['File', 'Find & Replace'],
            ['File', 'Find && Replace']
        ]) {
            const found = findMenuItem(items, { path });
            expect(found.ok, path.join(' > ')).toBe(true);
        }
        const preview = findMenuItem(items, { path: ['File', 'Preview Markdown'] });
        expect(preview.ok && preview.item.label).toBe('Preview Markdown…');
        const top = findMenuItem(items, { path: ['View'] });
        expect(top.ok && top.item.submenu?.items.length).toBe(6);
    });

    it('names the closest labels at the level that missed', () => {
        const miss = findMenuItem(fixture(), { path: ['File', 'New Workspce'] });
        expect(miss.ok).toBe(false);
        expect(miss.ok ? '' : miss.error).toContain('no menu item "New Workspce" under File');
        expect(miss.ok ? '' : miss.error).toMatch(/closest: New Workspace/);
        const bar = findMenuItem(fixture(), { path: ['Fil', 'Close'] });
        expect(bar.ok ? '' : bar.error).toContain('under the menu bar');
        // Display labels in the hint: a driver copies these back into a path, so no mnemonic.
        expect(bar.ok ? '' : bar.error).toMatch(/closest: File/);
        expect(bar.ok ? '' : bar.error).not.toContain('&');
    });

    it('falls back from a missing id to the path, and lists ids when there is no path', () => {
        const fallback = findMenuItem(fixture(), { id: 'nope', path: ['File', 'Close'] });
        expect(fallback.ok && fallback.item.label).toBe('Close');
        const missing = findMenuItem(fixture(), { id: 'nope' });
        expect(missing.ok ? '' : missing.error).toBe('no menu item with id "nope" (ids: deselect-all-workspaces)');
    });

    it('rejects a request with neither id nor path', () => {
        expect(findMenuItem(fixture(), {}).ok).toBe(false);
        expect(findMenuItem(fixture(), { path: [] }).ok).toBe(false);
    });

    it('does not match separators by their empty label', () => {
        expect(findMenuItem(fixture(), { path: ['Kelpi', ''] }).ok).toBe(false);
    });
});

describe('closestLabels', () => {
    it('ranks substring matches ahead of edit distance', () => {
        expect(closestLabels('Workspace', ['Close', 'New Workspace', 'Switch to Workspace 1', 'Copy'], 2)).toEqual([
            'New Workspace',
            'Switch to Workspace 1'
        ]);
    });
});

describe('menuClickVerdict', () => {
    const rows = (fixture()[0]?.submenu?.items ?? []) as FakeItem[];

    it('refuses a role row with the message the driver is written against', () => {
        expect(menuClickVerdict(rows[0] as FakeItem)).toBe('role item; use press or a CDP key');
    });

    it('refuses disabled, hidden, separator and submenu rows', () => {
        expect(menuClickVerdict(rows[1] as FakeItem)).toBe('menu item "Check for Updates…" is disabled');
        expect(menuClickVerdict(rows[2] as FakeItem)).toContain('separator');
        expect(menuClickVerdict(row({ label: 'Secret', visible: false }))).toBe('menu item "Secret" is hidden');
        expect(menuClickVerdict(fixture()[1] as FakeItem)).toContain('is a submenu');
    });

    it('allows a plain enabled row', () => {
        expect(menuClickVerdict(row({ label: 'New Workspace' }))).toBeNull();
    });
});

// ── accelerators ────────────────────────────────────────────────────────────────────

describe('normaliseAccelerator', () => {
    it('folds every Electron spelling of the Command key on darwin', () => {
        for (const spelling of ['CommandOrControl+N', 'CmdOrCtrl+n', 'Command+N', 'Cmd+N', 'Super+N', 'Meta+N', 'cmd+N']) {
            expect(normaliseAccelerator(spelling, 'darwin'), spelling).toBe('Cmd+N');
        }
    });

    it('sends CommandOrControl to Ctrl off darwin, and keeps Cmd as Cmd', () => {
        expect(normaliseAccelerator('CommandOrControl+N', 'linux')).toBe('Ctrl+N');
        expect(normaliseAccelerator('CmdOrCtrl+N', 'win32')).toBe('Ctrl+N');
        expect(normaliseAccelerator('Command+N', 'linux')).toBe('Cmd+N');
        expect(normaliseAccelerator('Super+N', 'linux')).toBe('Super+N');
    });

    it('is order-insensitive across modifiers and case-insensitive on the key', () => {
        expect(normaliseAccelerator('Shift+Cmd+g', 'darwin')).toBe('Cmd+Shift+G');
        expect(normaliseAccelerator('Cmd+Shift+G', 'darwin')).toBe('Cmd+Shift+G');
        expect(normaliseAccelerator('Option+Control+Shift+Command+f', 'darwin')).toBe('Cmd+Ctrl+Alt+Shift+F');
        expect(normaliseAccelerator('Alt+Ctrl+Shift+Cmd+F', 'darwin')).toBe('Cmd+Ctrl+Alt+Shift+F');
    });

    it('treats Enter/Return and Esc/Escape as one key and keeps punctuation keys', () => {
        expect(normaliseAccelerator('Cmd+Enter', 'darwin')).toBe('Cmd+RETURN');
        expect(normaliseAccelerator('Cmd+Return', 'darwin')).toBe('Cmd+RETURN');
        expect(normaliseAccelerator('Esc', 'darwin')).toBe('ESCAPE');
        expect(normaliseAccelerator('CommandOrControl+?', 'darwin')).toBe('Cmd+?');
    });

    it('returns null for nothing at all', () => {
        expect(normaliseAccelerator('', 'darwin')).toBeNull();
        expect(normaliseAccelerator('  ', 'darwin')).toBeNull();
        expect(normaliseAccelerator(null, 'darwin')).toBeNull();
        expect(normaliseAccelerator(undefined, 'darwin')).toBeNull();
    });
});

describe('acceleratorMatches', () => {
    it('compares chords, not strings', () => {
        expect(acceleratorMatches('CommandOrControl+Shift+G', 'shift+cmd+g', 'darwin')).toBe(true);
        expect(acceleratorMatches('CommandOrControl+Shift+G', 'Cmd+G', 'darwin')).toBe(false);
        expect(acceleratorMatches('CommandOrControl+N', 'Ctrl+N', 'darwin')).toBe(false);
        expect(acceleratorMatches('CommandOrControl+N', 'Ctrl+N', 'linux')).toBe(true);
        expect(acceleratorMatches(null, null, 'darwin')).toBe(false);
        expect(acceleratorMatches('', 'Cmd+N', 'darwin')).toBe(false);
    });
});

describe('findByAccelerator', () => {
    it('lands on the first enabled, visible row whose chord matches', () => {
        const found = findByAccelerator(fixture(), 'cmd+n', 'darwin');
        expect(found.ok && found.item.label).toBe('New Workspace');
        // The disabled "Retired" row shares its chord with "Reload Everything": a keystroke would
        // skip the greyed one, and so does press.
        const reload = findByAccelerator(fixture(), 'Cmd+Shift+R', 'darwin');
        expect(reload.ok && reload.item.label).toBe('Reload Everything');
    });

    it('skips hidden rows and everything under a disabled submenu', () => {
        expect(findByAccelerator(fixture(), 'Cmd+Shift+X', 'darwin').ok).toBe(false);
        expect(findByAccelerator(fixture(), 'Cmd+Shift+D', 'darwin').ok).toBe(false);
    });

    it('reaches role rows, because the OS routes the chord to them too', () => {
        const quit = findByAccelerator(fixture(), 'Cmd+Q', 'darwin');
        expect(quit.ok && quit.item.role).toBe('quit');
    });

    it('lists the chords the menu has on a miss', () => {
        const miss = findByAccelerator(fixture(), 'Cmd+Shift+Z', 'darwin');
        expect(miss.ok ? '' : miss.error).toContain('no enabled, visible menu item on "Cmd+Shift+Z"');
        expect(miss.ok ? '' : miss.error).toContain('CommandOrControl+N');
        expect(miss.ok ? '' : miss.error).toContain('Command+Q');
        expect(findByAccelerator(fixture(), '+', 'darwin').ok).toBe(false);
    });
});

// ── counters and the arm ────────────────────────────────────────────────────────────

describe('HarnessCounters', () => {
    it('starts empty', () => {
        expect(new HarnessCounters().snapshot()).toEqual({
            dockBounces: 0,
            lastBounce: null,
            dialogs: 0,
            lastDialog: null,
            notifications: 0,
            lastNotification: null,
            recentNotifications: [],
            externalOpens: 0,
            lastExternalUrl: null
        });
    });

    it('counts bounces and remembers the last type, defaulting to informational', () => {
        const counters = new HarnessCounters();
        counters.recordBounce('informational');
        counters.recordBounce(undefined);
        counters.recordBounce('critical');
        expect(counters.snapshot()).toMatchObject({ dockBounces: 3, lastBounce: 'critical' });
    });

    /**
     * #83. "The browser opened, with this URL" is otherwise unobservable from a driver, which is
     * why the ⌘-click path had no live coverage at all. The URL is kept WHOLE: the bug being
     * fixed is a truncated address, so a counter that trimmed one would be useless.
     */
    it('counts external opens and remembers the last URL in full', () => {
        const counters = new HarnessCounters();
        expect(counters.snapshot()).toMatchObject({ externalOpens: 0, lastExternalUrl: null });
        counters.recordExternalOpen('https://example.com/first');
        counters.recordExternalOpen('https://example.com/wrapped/path/that/continues/here?q=1#x');
        expect(counters.snapshot()).toMatchObject({
            externalOpens: 2,
            lastExternalUrl: 'https://example.com/wrapped/path/that/continues/here?q=1#x'
        });
    });

    it('arms once: the arm is consumed by the next take and gone after it', () => {
        const counters = new HarnessCounters();
        expect(counters.armed).toBe(false);
        expect(counters.takeArm()).toBeNull();
        expect(counters.arm({ response: 1, checkboxChecked: true })).toEqual({ armed: true });
        expect(counters.armed).toBe(true);
        expect(counters.takeArm()).toEqual({ response: 1, checkboxChecked: true });
        expect(counters.armed).toBe(false);
        expect(counters.takeArm()).toBeNull();
    });

    it('a second arm replaces the first rather than queueing', () => {
        const counters = new HarnessCounters();
        counters.arm({ response: 0, checkboxChecked: false });
        counters.arm({ response: 2, checkboxChecked: false });
        expect(counters.takeArm()).toEqual({ response: 2, checkboxChecked: false });
        expect(counters.takeArm()).toBeNull();
    });

    it('records a dialog when it opens and its response when it settles', () => {
        const counters = new HarnessCounters();
        const handle = counters.openDialog({
            title: 'Quit Kelpi?',
            message: 'An agent is running',
            detail: 'It keeps running',
            buttons: ['Quit', 'Cancel'],
            defaultId: 1
        });
        expect(counters.snapshot()).toMatchObject({
            dialogs: 1,
            lastDialog: { title: 'Quit Kelpi?', buttons: ['Quit', 'Cancel'], defaultId: 1, response: null }
        });
        const before = counters.snapshot();
        counters.settleDialog(handle, 1);
        expect(counters.snapshot().lastDialog?.response).toBe(1);
        // A snapshot is a copy: settling later does not rewrite one already handed out.
        expect(before.lastDialog?.response).toBeNull();
    });
});

// ── notifications (#67) ─────────────────────────────────────────────────────────────

/** The real Electron notification the channel stands in front of, as a recorder. */
function fakeDelegate(): { shows: number; closes: number; handle: KelpiNotificationHandle } {
    const state = { shows: 0, closes: 0, handle: null as unknown as KelpiNotificationHandle };
    state.handle = {
        show: () => {
            state.shows += 1;
        },
        close: () => {
            state.closes += 1;
        }
    };
    return state;
}

/** `agentNotificationSpec`'s shape, as `status.ts` hands it to the seam. */
function agentRequest(overrides: Partial<KelpiNotificationRequest> = {}): KelpiNotificationRequest {
    return {
        title: 'Kelpi',
        body: 'Agent is waiting for input',
        silent: false,
        actions: [
            { type: 'button', text: 'Open' },
            { type: 'button', text: 'Dismiss' }
        ],
        paneID: 'PANE-A',
        key: 'kelpi-PANE-A',
        ...overrides
    };
}

describe('the quiet-notification gate', () => {
    it('is off unless KELPI_HARNESS_QUIET_NOTIFICATIONS is exactly 1', () => {
        expect(harnessQuietNotifications({})).toBe(false);
        expect(harnessQuietNotifications({ KELPI_HARNESS_QUIET_NOTIFICATIONS: '' })).toBe(false);
        expect(harnessQuietNotifications({ KELPI_HARNESS_QUIET_NOTIFICATIONS: '0' })).toBe(false);
        expect(harnessQuietNotifications({ KELPI_HARNESS_QUIET_NOTIFICATIONS: 'true' })).toBe(false);
        expect(harnessQuietNotifications({ KELPI_HARNESS_QUIET_NOTIFICATIONS: '1' })).toBe(true);
        // Neither harness marker implies it: the socket alone must not silence a run's toasts.
        expect(harnessQuietNotifications({ KELPI_HARNESS_SOCKET: '/tmp/h.sock', KELPI_HARNESS: '1' })).toBe(false);
    });
});

describe('recording notifications', () => {
    it('records a notification when it is SHOWN, not when it is built', () => {
        const counters = new HarnessCounters();
        const entry = counters.openNotification(agentRequest(), {});
        // status.ts builds one, then decides; a built-and-dropped notification was never shown.
        expect(counters.snapshot()).toMatchObject({ notifications: 0, lastNotification: null });
        entry.show();
        expect(counters.snapshot()).toMatchObject({
            notifications: 1,
            lastNotification: {
                seq: 0,
                title: 'Kelpi',
                body: 'Agent is waiting for input',
                // §AGNT-073's set, in the order macOS shows it.
                actions: ['Open', 'Dismiss'],
                paneID: 'PANE-A',
                silent: false,
                key: 'kelpi-PANE-A',
                closed: false
            }
        });
    });

    it('passes show and close through to the real notification, and records displayed', () => {
        const counters = new HarnessCounters();
        const delegate = fakeDelegate();
        const entry = counters.openNotification(agentRequest(), {});
        entry.attach(delegate.handle);
        entry.show();
        entry.close();
        expect([delegate.shows, delegate.closes]).toEqual([1, 1]);
        expect(counters.snapshot().lastNotification).toMatchObject({ displayed: true, closed: true });
    });

    it('under the quiet gate records everything and posts nothing', () => {
        const counters = new HarnessCounters();
        // No delegate is exactly what `wrapNotifications(counters, true)` attaches.
        const entry = counters.openNotification(agentRequest(), {});
        entry.attach(null);
        entry.show();
        expect(counters.snapshot()).toMatchObject({
            notifications: 1,
            lastNotification: { displayed: false, title: 'Kelpi' }
        });
    });

    it('defaults the fields Electron defaults, for a notification with no category', () => {
        const counters = new HarnessCounters();
        counters
            .openNotification({ title: 'Kelpi CLI is out of date', body: 'Could not update /usr/local/bin/kelpi' }, {})
            .show();
        expect(counters.snapshot().lastNotification).toMatchObject({
            actions: [],
            paneID: null,
            key: null,
            // An unset `silent` is an audible notification, which is Electron's own default.
            silent: false
        });
    });

    it(`keeps the last ${String(NOTIFICATION_HISTORY)} shown, oldest first, while the count stays exact`, () => {
        const counters = new HarnessCounters();
        for (let index = 0; index < NOTIFICATION_HISTORY + 5; index += 1) {
            counters.openNotification(agentRequest({ title: `n${String(index)}` }), {}).show();
        }
        const snapshot = counters.snapshot();
        expect(snapshot.notifications).toBe(NOTIFICATION_HISTORY + 5);
        expect(snapshot.recentNotifications).toHaveLength(NOTIFICATION_HISTORY);
        // Oldest first, and `seq` is the run-wide ordinal, so the window's start is visible.
        expect(snapshot.recentNotifications[0]).toMatchObject({ title: 'n5', seq: 5 });
        expect(snapshot.lastNotification).toMatchObject({ title: `n${String(NOTIFICATION_HISTORY + 4)}` });
    });

    it('fires the OS click and action handlers the call site registered', () => {
        const counters = new HarnessCounters();
        const fired: string[] = [];
        const entry = counters.openNotification(agentRequest(), {
            onClick: () => fired.push('click'),
            onAction: (index) => fired.push(`action:${String(index)}`)
        });
        entry.show();
        expect(entry.fire(undefined)).toMatchObject({ seq: 0, action: null, actionIndex: null });
        // By NAME, resolved against the record's own action list, so the two cannot drift.
        expect(entry.fire('Open')).toMatchObject({ action: 'Open', actionIndex: 0 });
        expect(entry.fire('dismiss')).toMatchObject({ action: 'Dismiss', actionIndex: 1 });
        expect(fired).toEqual(['click', 'action:0', 'action:1']);
    });

    it('refuses an action the notification does not carry, and a handler it never had', () => {
        const counters = new HarnessCounters();
        const withActions = counters.openNotification(agentRequest(), { onClick: () => {} });
        withActions.show();
        // Named, so a typo in a scenario is a one-line fix rather than a silent pass.
        expect(withActions.fire('Snooze')).toContain('actions: Open, Dismiss');
        expect(withActions.fire('Open')).toContain('no action handler');
        const bare = counters.openNotification({ title: 'Kelpi CLI is out of date', body: '' }, {});
        bare.show();
        expect(bare.fire(undefined)).toContain('no click handler');
        expect(bare.fire('Open')).toContain('it has no actions');
    });

    it('fires close exactly once however the close arrived', () => {
        const counters = new HarnessCounters();
        let closes = 0;
        const delegate = fakeDelegate();
        const entry = counters.openNotification(agentRequest(), {
            onClose: () => {
                closes += 1;
            }
        });
        entry.attach(delegate.handle);
        entry.show();
        // `close()` closes the real one, whose own close event comes straight back through
        // `dispatchClose`, status.ts's live-map handler must not run twice for one withdrawal.
        entry.close();
        entry.dispatchClose();
        entry.close();
        expect(closes).toBe(1);
        expect(counters.snapshot().lastNotification?.closed).toBe(true);
    });

    it('addresses a notification by its position in the history, newest by default', () => {
        const counters = new HarnessCounters();
        const first = counters.openNotification(agentRequest({ title: 'first' }), {});
        const second = counters.openNotification(agentRequest({ title: 'second' }), {});
        expect(counters.notificationAt(undefined)).toBe('no notification has been shown yet');
        first.show();
        second.show();
        expect(counters.notificationAt(undefined)).toBe(second);
        expect(counters.notificationAt(0)).toBe(first);
        expect(counters.notificationAt(-1)).toBe(second);
        expect(counters.notificationAt(-2)).toBe(first);
        expect(counters.notificationAt(2)).toContain('outside the 2 notification(s)');
        expect(counters.notificationAt('0')).toBe('"index" must be an integer');
        expect(counters.notificationAt(1.5)).toBe('"index" must be an integer');
    });

    it('§7.5: a repost under the same key closes the previous one, so only one is live', () => {
        // The shape status.ts produces: `liveNotifications.get(key)?.close()` before the new one
        // is shown. The record is what makes "replaces the older one" assertable from outside.
        const counters = new HarnessCounters();
        const first = counters.openNotification(agentRequest({ body: 'a question' }), {});
        first.show();
        first.close();
        const second = counters.openNotification(agentRequest({ body: 'a question' }), {});
        second.show();
        const snapshot = counters.snapshot();
        const live = snapshot.recentNotifications.filter((record) => record.key === 'kelpi-PANE-A' && !record.closed);
        expect(snapshot.notifications).toBe(2);
        expect(live).toHaveLength(1);
        expect(live[0]).toMatchObject({ seq: 1 });
    });
});

describe('messageBoxSpecFrom', () => {
    it('reads either showMessageBox overload and fills Electron defaults', () => {
        const options = { title: 'T', message: 'M', detail: 'D', buttons: ['A', 'B'], defaultId: 1 };
        expect(messageBoxSpecFrom([options])).toEqual({ title: 'T', message: 'M', detail: 'D', buttons: ['A', 'B'], defaultId: 1 });
        expect(messageBoxSpecFrom([{ fake: 'window' }, options])).toEqual(messageBoxSpecFrom([options]));
        expect(messageBoxSpecFrom([{ message: 'Kelpi Help' }])).toEqual({
            title: '',
            message: 'Kelpi Help',
            detail: '',
            buttons: ['OK'],
            defaultId: 0
        });
        expect(messageBoxSpecFrom([])).toMatchObject({ buttons: ['OK'] });
    });
});

describe('parseDialogArm', () => {
    it('needs a non-negative integer response and an optional boolean checkbox', () => {
        expect(parseDialogArm({ response: 1 })).toEqual({ response: 1, checkboxChecked: false });
        expect(parseDialogArm({ response: 0, checkboxChecked: true })).toEqual({ response: 0, checkboxChecked: true });
        expect(typeof parseDialogArm({})).toBe('string');
        expect(typeof parseDialogArm({ response: -1 })).toBe('string');
        expect(typeof parseDialogArm({ response: 1.5 })).toBe('string');
        expect(typeof parseDialogArm({ response: '1' })).toBe('string');
        expect(typeof parseDialogArm({ response: 1, checkboxChecked: 'yes' })).toBe('string');
    });
});

// ── the ops, end to end over a fake surface ─────────────────────────────────────────

describe('respond', () => {
    it('ping', () => {
        const { surface } = fakeSurface();
        expect(respond(request('ping', {}, 'p'), surface)).toEqual({ id: 'p', ok: true, result: { pid: 4242, version: '0.1.0-test' } });
    });

    it('menu', () => {
        const { surface } = fakeSurface();
        expect(respond(request('menu'), surface)).toEqual({ id: 1, ok: true, result: { items: serialiseMenu(fixture()) } });
    });

    it('menu-click by path clicks the row and reports it', () => {
        const { surface, state } = fakeSurface();
        expect(respond(request('menu-click', { path: ['file', 'new workspace'] }), surface)).toEqual({
            id: 1,
            ok: true,
            result: { id: null, label: 'New Workspace', accelerator: 'CommandOrControl+N' }
        });
        expect(state.clicked.map((item) => item.label)).toEqual(['New Workspace']);
    });

    it('menu-click by id, and the refusals do not click', () => {
        const { surface, state } = fakeSurface();
        expect(respond(request('menu-click', { id: 'deselect-all-workspaces' }), surface)).toMatchObject({
            ok: false,
            error: 'menu item "Deselect All Workspaces" is disabled'
        });
        expect(respond(request('menu-click', { path: ['Kelpi', 'Quit Kelpi'] }), surface)).toEqual({
            id: 1,
            ok: false,
            error: 'role item; use press or a CDP key'
        });
        expect(respond(request('menu-click', { path: ['File', 'Nope'] }), surface)).toMatchObject({
            ok: false,
            error: expect.stringContaining('closest:')
        });
        expect(respond(request('menu-click', {}), surface)).toMatchObject({ ok: false });
        expect(state.clicked).toEqual([]);
    });

    it('press clicks the first live row on the chord, in any spelling', () => {
        const { surface, state } = fakeSurface();
        expect(respond(request('press', { accelerator: 'shift+cmd+s' }), surface)).toEqual({
            id: 1,
            ok: true,
            result: { id: null, label: 'Toggle Sidebar', accelerator: 'CommandOrControl+Shift+S' }
        });
        expect(respond(request('press', { accelerator: 'Cmd+Shift+Q' }), surface)).toMatchObject({
            ok: false,
            error: expect.stringContaining('accelerators:')
        });
        expect(respond(request('press', {}), surface)).toMatchObject({ ok: false });
        expect(state.clicked.map((item) => item.label)).toEqual(['Toggle Sidebar']);
    });

    it('a click that throws becomes an error line, not a dead socket', () => {
        const { surface } = fakeSurface();
        expect(respond(request('press', { accelerator: 'Cmd+Shift+R' }), surface)).toEqual({
            id: 1,
            ok: false,
            error: 'press failed: relay is down'
        });
    });

    it('counters and dialog-arm round-trip through the same counters object', () => {
        const { surface } = fakeSurface();
        expect(respond(request('dialog-arm', { response: 1 }), surface)).toEqual({ id: 1, ok: true, result: { armed: true } });
        expect(surface.counters.takeArm()).toEqual({ response: 1, checkboxChecked: false });
        expect(respond(request('dialog-arm', { response: 'x' }), surface)).toMatchObject({ ok: false });
        surface.counters.recordBounce('informational');
        expect(respond(request('counters'), surface)).toEqual({
            id: 1,
            ok: true,
            result: {
                dockBounces: 1,
                lastBounce: 'informational',
                dialogs: 0,
                lastDialog: null,
                notifications: 0,
                lastNotification: null,
                recentNotifications: [],
                externalOpens: 0,
                lastExternalUrl: null
            }
        });
    });

    it('notification-click fires the body tap or the named action, and refuses the rest', () => {
        const { surface } = fakeSurface();
        const fired: string[] = [];
        surface.counters
            .openNotification(agentRequest({ title: 'needs you' }), {
                onClick: () => fired.push('click'),
                onAction: (index) => fired.push(`action:${String(index)}`)
            })
            .show();
        expect(respond(request('notification-click'), surface)).toEqual({
            id: 1,
            ok: true,
            result: { seq: 0, title: 'needs you', action: null, actionIndex: null }
        });
        // §7.5: the "Open" button and the body tap are the same behaviour, by different routes.
        expect(respond(request('notification-click', { action: 'Open' }), surface)).toMatchObject({
            ok: true,
            result: { action: 'Open', actionIndex: 0 }
        });
        expect(respond(request('notification-click', { index: 7 }), surface)).toMatchObject({ ok: false });
        expect(respond(request('notification-click', { action: 7 }), surface)).toMatchObject({
            ok: false,
            error: 'notification-click "action" must be a string'
        });
        expect(fired).toEqual(['click', 'action:0']);
    });

    it('notification-close withdraws it and marks the record closed', () => {
        const { surface } = fakeSurface();
        let closed = 0;
        surface.counters
            .openNotification(agentRequest(), {
                onClose: () => {
                    closed += 1;
                }
            })
            .show();
        expect(respond(request('notification-close'), surface)).toEqual({
            id: 1,
            ok: true,
            result: { seq: 0, title: 'Kelpi', closed: true }
        });
        expect(closed).toBe(1);
        expect(surface.counters.snapshot().lastNotification?.closed).toBe(true);
    });

    it('answers both notification ops before anything has been shown', () => {
        const { surface } = fakeSurface();
        // A scenario that clicks too early hears why, rather than hanging or passing.
        expect(respond(request('notification-click'), surface)).toEqual({
            id: 1,
            ok: false,
            error: 'no notification has been shown yet'
        });
        expect(respond(request('notification-close'), surface)).toMatchObject({ ok: false });
    });

    it('window, focus and blur, with and without a window', () => {
        const { surface, state } = fakeSurface();
        expect(respond(request('window'), surface)).toEqual({
            id: 1,
            ok: true,
            result: { focused: true, visible: true, minimized: false, bounds: { x: 10, y: 20, width: 800, height: 600 } }
        });
        expect(respond(request('blur'), surface)).toEqual({ id: 1, ok: true, result: { focused: false } });
        expect(respond(request('focus'), surface)).toEqual({ id: 1, ok: true, result: { focused: true } });
        state.window = null;
        expect(respond(request('window'), surface)).toEqual({
            id: 1,
            ok: true,
            result: { focused: null, visible: null, minimized: null, bounds: null }
        });
        expect(respond(request('focus'), surface)).toEqual({ id: 1, ok: true, result: { focused: null } });
        expect(respond(request('blur'), surface)).toEqual({ id: 1, ok: true, result: { focused: null } });
    });

    it('hide, minimize and restore report the window state they left behind (#75)', () => {
        const { surface } = fakeSurface();
        expect(respond(request('hide'), surface)).toEqual({
            id: 1,
            ok: true,
            result: { visible: false, minimized: false }
        });
        expect(respond(request('restore'), surface)).toEqual({
            id: 1,
            ok: true,
            result: { visible: true, minimized: false }
        });
        expect(respond(request('minimize'), surface)).toEqual({
            id: 1,
            ok: true,
            result: { visible: true, minimized: true }
        });
        expect(respond(request('restore'), surface)).toEqual({
            id: 1,
            ok: true,
            result: { visible: true, minimized: false }
        });
    });

    it('hide, minimize and restore answer nulls rather than an error with no window', () => {
        const { surface, state } = fakeSurface();
        state.window = null;
        for (const op of ['hide', 'minimize', 'restore']) {
            expect(respond(request(op), surface)).toEqual({
                id: 1,
                ok: true,
                result: { visible: null, minimized: null }
            });
        }
    });

    /**
     * #76's `crash` op. The recovery it triggers spans three processes and none of it is
     * reachable from a renderer, so the driver needs a way to kill a real one; these are the
     * refusals that keep it from being a way to kill something else by accident.
     */
    it('crashes the named pane, and refuses every shape that is not one', () => {
        const { surface } = fakeSurface();
        const killed: string[] = [];
        const withHost: HarnessSurface<FakeItem> = {
            ...surface,
            crashWebPane: (paneID) => {
                killed.push(paneID);
                return paneID === 'live-pane' ? { paneID, tabID: 'T7' } : null;
            }
        };
        expect(respond(request('crash', { paneID: 'live-pane' }), withHost)).toEqual({
            id: 1,
            ok: true,
            result: { paneID: 'live-pane', tabID: 'T7', crashed: true }
        });
        expect(killed).toEqual(['live-pane']);

        expect(respond(request('crash', { paneID: 'gone-pane' }), withHost)).toMatchObject({
            ok: false,
            error: expect.stringContaining('no live view for pane gone-pane')
        });
        expect(respond(request('crash'), withHost)).toMatchObject({
            ok: false,
            error: expect.stringContaining('non-empty "paneID"')
        });
        expect(respond(request('crash', { paneID: '  ' }), withHost)).toMatchObject({ ok: false });
        // A shell with no web-pane host says so rather than pretending it crashed something.
        expect(respond(request('crash', { paneID: 'live-pane' }), surface)).toMatchObject({
            ok: false,
            error: expect.stringContaining('no web pane host')
        });
    });

    it('answers with no application menu at all', () => {
        const { surface } = fakeSurface([]);
        expect(respond(request('menu'), surface)).toEqual({ id: 1, ok: true, result: { items: [] } });
        expect(respond(request('press', { accelerator: 'Cmd+N' }), surface)).toMatchObject({
            ok: false,
            error: expect.stringContaining('the menu has no accelerators')
        });
    });
});
