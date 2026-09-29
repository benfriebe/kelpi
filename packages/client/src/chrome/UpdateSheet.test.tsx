import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UpdateView } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpdateSheet, updateSheetCopy } from './UpdateSheet';

afterEach(cleanup);

/** What the daemon's `renderReleaseNotes` makes of a typical release body. */
const NOTES_MD = '## Fixes\n\n- The update asks before it restarts.\n- `kelpi --version` works.\n\nSee [the release](https://github.com/benfriebe/kelpi/releases/tag/v0.2.3).';
const NOTES_HTML =
    '<h2>Fixes</h2>\n<ul>\n<li><p>The update asks before it restarts.</p>\n</li>\n<li><p><code>kelpi --version</code> works.</p>\n</li>\n</ul>\n' +
    '<p>See <a href="https://github.com/benfriebe/kelpi/releases/tag/v0.2.3">the release</a>.</p>\n' +
    '<div class="code-block"><pre><code class="language-sh">kelpi update\n</code></pre></div>\n';

const AVAILABLE: UpdateView = { phase: 'available', currentVersion: '0.2.2', version: '0.2.3', notes: NOTES_MD };

function sheet(view: UpdateView, extra: { notesHTML?: string; openLink?: (href: string) => void } = {}) {
    const onAction = vi.fn();
    render(<UpdateSheet view={view} notesHTML={extra.notesHTML} onAction={onAction} openLink={extra.openLink} />);
    return onAction;
}

describe('UpdateSheet (#286)', () => {
    it('is a dialog centred in the window', () => {
        sheet(AVAILABLE, { notesHTML: NOTES_HTML });
        const backdrop = screen.getByTestId('update-backdrop');
        expect(backdrop.className).toContain('items-center');
        expect(backdrop.className).toContain('justify-center');
        expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
        expect(screen.getByTestId('update-sheet').getAttribute('data-phase')).toBe('available');
    });

    it('offers an update: current and new version, the notes as markdown, Update Now and Later', () => {
        const onAction = sheet(AVAILABLE, { notesHTML: NOTES_HTML });
        expect(screen.getByTestId('update-title').textContent).toBe('Kelpi 0.2.3 is available');
        expect(screen.getByTestId('update-versions').textContent).toBe('0.2.2→0.2.3');
        const notes = screen.getByTestId('update-notes');
        expect(notes.querySelector('h2')?.textContent).toBe('Fixes');
        expect(notes.querySelectorAll('ul > li')).toHaveLength(2);
        expect(notes.querySelector('li code')?.textContent).toBe('kelpi --version');
        expect(notes.querySelector('pre code')?.textContent).toBe('kelpi update\n');
        fireEvent.click(screen.getByTestId('update-now'));
        fireEvent.click(screen.getByTestId('update-later'));
        expect(onAction.mock.calls).toEqual([['update-now'], ['later']]);
    });

    it('draws a mailto link as text: the shell would not open it', () => {
        sheet(AVAILABLE, { notesHTML: '<p><a href="mailto:team@kelpi.dev">mail us</a></p>' });
        expect(screen.getByTestId('update-notes').querySelector('a')).toBeNull();
        expect(screen.getByTestId('update-notes').textContent).toBe('mail us');
    });

    it('opens a release-note link in the system browser, never in the window', () => {
        const openLink = vi.fn();
        sheet(AVAILABLE, { notesHTML: NOTES_HTML, openLink });
        const link = screen.getByText('the release');
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        expect(openLink).toHaveBeenCalledWith('https://github.com/benfriebe/kelpi/releases/tag/v0.2.3');
    });

    it('rebuilds hostile notes HTML from an allowlist: no script, handler, style, frame, image or unsafe link survives', () => {
        const hostile =
            '<p onclick="alert(1)" style="position:fixed">Hi <script>alert(2)</script><img src=x onerror="alert(3)">' +
            '<a href="javascript:alert(4)">js</a> <a href="file:///etc/passwd">file</a> <a href="https://ok.example" onmouseover="x()">ok</a></p>' +
            '<iframe src="https://evil.example"></iframe><style>body{display:none}</style><svg onload="alert(5)"><circle/></svg>';
        const openLink = vi.fn();
        sheet(AVAILABLE, { notesHTML: hostile, openLink });
        const notes = screen.getByTestId('update-notes');
        expect(notes.querySelector('script, img, iframe, style, svg')).toBeNull();
        for (const element of Array.from(notes.querySelectorAll('*'))) {
            for (const attribute of Array.from(element.attributes)) {
                expect(attribute.name.startsWith('on')).toBe(false);
            }
        }
        expect(notes.querySelector('p')?.getAttribute('style')).toBeNull();
        const anchors = Array.from(notes.querySelectorAll('a'));
        expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(['https://ok.example']);
        // The unsafe links keep their text, as text.
        expect(notes.textContent).toContain('js');
        expect(notes.textContent).toContain('file');
    });

    it('shows the markdown as plain text when there is no HTML, with any raw HTML inert', () => {
        sheet({ ...AVAILABLE, notes: 'Plain <img src=x onerror="alert(1)"> notes' });
        const notes = screen.getByTestId('update-notes');
        expect(notes.querySelector('img')).toBeNull();
        expect(notes.textContent).toBe('Plain <img src=x onerror="alert(1)"> notes');
    });

    it('offers no Update Now when Kelpi runs from somewhere an install cannot replace, and says why', () => {
        const onAction = sheet({ ...AVAILABLE, location: { blocked: true, message: 'Move Kelpi.app into your Applications folder.' } });
        expect(screen.queryByTestId('update-now')).toBeNull();
        const note = screen.getByTestId('update-location');
        expect(note.getAttribute('data-blocked')).toBe('true');
        expect(note.textContent).toBe('Move Kelpi.app into your Applications folder.');
        fireEvent.click(screen.getByTestId('update-ok'));
        expect(onAction).toHaveBeenCalledWith('later');
    });

    it('shows a location warning beside Update Now when the install can still work', () => {
        sheet({ ...AVAILABLE, location: { blocked: false, message: 'Kelpi is running from ~/Downloads.' } });
        expect(screen.getByTestId('update-location').getAttribute('data-blocked')).toBe('false');
        expect(screen.getByTestId('update-now')).toBeTruthy();
    });

    it('downloading: an indeterminate bar, the promise to ask, and Hide', () => {
        const onAction = sheet({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3' });
        expect(screen.getByTestId('update-title').textContent).toBe('Downloading Kelpi 0.2.3…');
        const bar = screen.getByTestId('update-progress');
        expect(bar.getAttribute('role')).toBe('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBeNull();
        expect(screen.getByTestId('update-subtitle').textContent).toContain('Kelpi will ask before it restarts');
        fireEvent.click(screen.getByTestId('update-hide'));
        expect(onAction).toHaveBeenCalledWith('dismiss');
    });

    it('ready: "Kelpi X is ready", Restart Now (focused) and Later, that Kelpi reopens by itself, and to give it a few seconds', () => {
        const onAction = sheet({ phase: 'ready', currentVersion: '0.2.2', version: '0.2.3' });
        expect(screen.getByTestId('update-title').textContent).toBe('Kelpi 0.2.3 is ready');
        expect(screen.getByTestId('update-subtitle').textContent).toContain('reopens by itself');
        expect(screen.getByTestId('update-subtitle').textContent).toContain('Give it those few seconds');
        expect(screen.getByTestId('update-later-note').textContent).toContain('next time you quit');
        expect(screen.getByTestId('update-later-note').textContent).toContain('wait a few seconds before opening Kelpi again');
        expect(document.activeElement).toBe(screen.getByTestId('update-restart'));
        fireEvent.click(screen.getByTestId('update-restart'));
        fireEvent.click(screen.getByTestId('update-later'));
        expect(onAction.mock.calls).toEqual([['restart'], ['later']]);
    });

    it('failed: a readable message and Retry', () => {
        const onAction = sheet({
            phase: 'failed',
            currentVersion: '0.2.2',
            version: '0.2.3',
            retry: 'download',
            message: 'The network connection was lost.'
        });
        expect(screen.getByTestId('update-title').textContent).toBe('Kelpi 0.2.3 could not be downloaded');
        expect(screen.getByTestId('update-message').textContent).toBe('The network connection was lost.');
        fireEvent.click(screen.getByTestId('update-retry'));
        fireEvent.click(screen.getByTestId('update-close'));
        expect(onAction.mock.calls).toEqual([['retry'], ['dismiss']]);
    });

    it('a failed install offers Quit Kelpi (not Retry), says to quit and reopen, and shows the reason', () => {
        const onAction = sheet({ phase: 'failed', currentVersion: '0.2.2', version: '0.2.3', retry: 'install', message: 'ShipIt could not be launched' });
        expect(screen.getByTestId('update-title').textContent).toBe('Kelpi could not finish installing the update');
        expect(screen.getByTestId('update-subtitle').textContent).toContain('Quit Kelpi and open it again');
        expect(screen.getByTestId('update-message').textContent).toBe('ShipIt could not be launched');
        expect(screen.queryByTestId('update-retry')).toBeNull();
        fireEvent.click(screen.getByTestId('update-quit'));
        fireEvent.click(screen.getByTestId('update-close'));
        expect(onAction.mock.calls).toEqual([['quit'], ['dismiss']]);
    });

    it('a slow download says it is still going, not failed', () => {
        sheet({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3', slow: true });
        expect(screen.getByTestId('update-subtitle').textContent).toContain('taking longer than expected');
        expect(screen.getByTestId('update-progress')).toBeTruthy();
    });

    it('acknowledges a view only after it has painted, once per view', async () => {
        const onShown = vi.fn();
        const { rerender } = render(<UpdateSheet view={AVAILABLE} seq={4} onAction={vi.fn()} onShown={onShown} />);
        expect(onShown).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(onShown).toHaveBeenCalledWith(4);
        });
        rerender(<UpdateSheet view={{ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3' }} seq={5} onAction={vi.fn()} onShown={onShown} />);
        await vi.waitFor(() => {
            expect(onShown).toHaveBeenLastCalledWith(5);
        });
        expect(onShown).toHaveBeenCalledTimes(2);
    });

    it('checking, up to date, unsupported and restarting each say what is happening', () => {
        sheet({ phase: 'checking', currentVersion: '0.2.2' });
        expect(screen.getByTestId('update-title').textContent).toBe('Checking for Updates…');
        expect(screen.getByTestId('update-progress')).toBeTruthy();
        cleanup();
        const onAction = sheet({ phase: 'up-to-date', currentVersion: '0.2.3' });
        expect(screen.getByTestId('update-title').textContent).toBe('Kelpi is up to date');
        expect(screen.getByTestId('update-subtitle').textContent).toBe('0.2.3 is the latest version.');
        fireEvent.click(screen.getByTestId('update-ok'));
        expect(onAction).toHaveBeenCalledWith('dismiss');
        cleanup();
        sheet({ phase: 'unsupported', currentVersion: '0.3.0-dev', message: 'This is a development build.' });
        expect(screen.getByTestId('update-message').textContent).toBe('This is a development build.');
        cleanup();
        sheet({ phase: 'restarting', currentVersion: '0.2.2', version: '0.2.3' });
        expect(screen.getByTestId('update-title').textContent).toBe('Restarting into Kelpi 0.2.3…');
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('Escape and the backdrop mean Later for a question, dismiss otherwise, and nothing mid-restart', () => {
        const onReady = sheet({ phase: 'ready', currentVersion: '0.2.2', version: '0.2.3' });
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onReady).toHaveBeenCalledWith('later');
        cleanup();
        const onFailed = sheet({ phase: 'failed', currentVersion: '0.2.2', retry: 'check', message: 'offline' });
        fireEvent.mouseDown(screen.getByTestId('update-backdrop'));
        expect(onFailed).toHaveBeenCalledWith('dismiss');
        cleanup();
        const onRestart = sheet({ phase: 'restarting', currentVersion: '0.2.2', version: '0.2.3' });
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onRestart).not.toHaveBeenCalled();
    });

    it('draws nothing while idle', () => {
        sheet({ phase: 'idle', currentVersion: '0.2.2' });
        expect(screen.queryByTestId('update-sheet')).toBeNull();
        expect(updateSheetCopy({ phase: 'idle', currentVersion: '0.2.2' }).title).toBe('');
    });
});
