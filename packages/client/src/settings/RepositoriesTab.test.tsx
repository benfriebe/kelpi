/**
 * Settings ▸ Repositories: the filter, the two empty states, the four registry gestures, and
 * §GIT-074's auto-detect toggle.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepositoriesTab, filterRepos, type RepositoryEntry } from './RepositoriesTab';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';

interface Recorder {
    readonly general: { key: string; value: string }[];
    readonly added: { path: string }[];
    readonly removed: string[];
    readonly renamed: { repoID: string; name: string }[];
    readonly scanned: string[];
}

function actions(overrides: Partial<SettingsActions> = {}): SettingsActions & { readonly log: Recorder } {
    const log: Recorder = { general: [], added: [], removed: [], renamed: [], scanned: [] };
    return {
        log,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => log.general.push({ key, value }),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn(),
        addRepo: (input) => log.added.push({ path: input.path }),
        removeRepo: (input) => log.removed.push(input.repoID),
        renameRepo: (input) => log.renamed.push(input),
        scanRepos: (input) => log.scanned.push(input.path),
        ...overrides
    } as SettingsActions & { readonly log: Recorder };
}

const REPOS: readonly RepositoryEntry[] = [
    { id: 'r1', name: 'app', path: '/src/app', remoteURL: 'git@example.invalid:acme/app.git' },
    { id: 'r2', name: 'tools', path: '/src/tools', remoteURL: null },
    { id: 'r3', name: 'scratch', path: '/tmp/scratch', isAutoDiscovered: true }
];

function renderTab(
    props: Partial<React.ComponentProps<typeof RepositoriesTab>> = {}
): ReturnType<typeof actions> {
    const acts = (props.actions as ReturnType<typeof actions> | undefined) ?? actions();
    render(
        <RepositoriesTab
            repos={props.repos ?? REPOS}
            actions={acts}
            paths={DEFAULT_SETTINGS_PATHS}
            autoDetectRepos={props.autoDetectRepos ?? true}
            {...(props.onBrowse === undefined ? {} : { onBrowse: props.onBrowse })}
        />
    );
    return acts;
}

afterEach(cleanup);

describe('filterRepos (§SET-052, §SET-055)', () => {
    it('matches name or path, case-insensitively', () => {
        expect(filterRepos(REPOS, 'APP', { includeAuto: true }).map((r) => r.id)).toEqual(['r1']);
        expect(filterRepos(REPOS, '/src/', { includeAuto: true }).map((r) => r.id)).toEqual(['r1', 'r2']);
        expect(filterRepos(REPOS, '  ', { includeAuto: true })).toHaveLength(3);
    });

    it('hides auto-discovered repos unless they are asked for (§SET-055)', () => {
        expect(filterRepos(REPOS, '', { includeAuto: false }).map((r) => r.id)).toEqual(['r1', 'r2']);
        expect(filterRepos(REPOS, '', { includeAuto: true })).toHaveLength(3);
    });
});

describe('the list (§SET-055, §SET-056)', () => {
    it('lists the manual repos with name, path and remote URL', () => {
        renderTab();
        const row = screen.getByTestId('repo-row-r1');
        expect(row.textContent).toContain('app');
        expect(row.textContent).toContain('/src/app');
        expect(row.textContent).toContain('git@example.invalid:acme/app.git');
        expect(row.getAttribute('data-origin')).toBe('manual');
        expect(screen.queryByTestId('repo-row-r3')).toBeNull();
    });

    it('reveals auto-detected rows, tagged as such, when the checkbox is on', () => {
        renderTab();
        fireEvent.click(screen.getByTestId('repo-show-auto'));
        const auto = screen.getByTestId('repo-row-r3');
        expect(auto.getAttribute('data-origin')).toBe('auto');
        expect(screen.getByTestId('repo-auto-r3').textContent).toBe('auto');
    });

    it('narrows to the filter', () => {
        renderTab();
        fireEvent.change(screen.getByTestId('repo-filter'), { target: { value: 'tools' } });
        expect(screen.queryByTestId('repo-row-r1')).toBeNull();
        expect(screen.getByTestId('repo-row-r2')).toBeTruthy();
    });
});

describe('the two empty states (§SET-057)', () => {
    it('says "No repositories registered" with the hint when the registry is empty', () => {
        renderTab({ repos: [] });
        const empty = screen.getByTestId('repo-empty');
        expect(empty.textContent).toContain('No repositories registered');
        expect(empty.textContent).toContain('Scan Directory');
        expect(empty.textContent).toContain('Add Repo');
    });

    it('says "No matching repositories" — without the hint — when the filter excluded them', () => {
        renderTab();
        fireEvent.change(screen.getByTestId('repo-filter'), { target: { value: 'zzz' } });
        const empty = screen.getByTestId('repo-empty');
        expect(empty.textContent).toContain('No matching repositories');
        expect(empty.textContent).not.toContain('Add Repo');
    });

    it('counts only manual repos as "registered" while auto rows are hidden', () => {
        renderTab({ repos: [REPOS[2] as RepositoryEntry] });
        expect(screen.getByTestId('repo-empty').textContent).toContain('No repositories registered');
    });
});

describe('the registry gestures (§SET-053, §SET-054, §GIT-071, §GIT-072)', () => {
    it('adds the typed path, and clears the field', () => {
        const acts = renderTab();
        const field = screen.getByTestId('repo-path');
        fireEvent.change(field, { target: { value: '  /src/new  ' } });
        fireEvent.click(screen.getByTestId('repo-add'));
        expect(acts.log.added).toEqual([{ path: '/src/new' }]);
        expect((field as HTMLInputElement).value).toBe('');
    });

    it('adds on Enter as well', () => {
        const acts = renderTab();
        fireEvent.change(screen.getByTestId('repo-path'), { target: { value: '/src/new' } });
        fireEvent.keyDown(screen.getByTestId('repo-path'), { key: 'Enter' });
        expect(acts.log.added).toEqual([{ path: '/src/new' }]);
    });

    it('scans the typed directory', () => {
        const acts = renderTab();
        fireEvent.change(screen.getByTestId('repo-path'), { target: { value: '/src' } });
        fireEvent.click(screen.getByTestId('repo-scan'));
        expect(acts.log.scanned).toEqual(['/src']);
    });

    it('disables both buttons until a path is typed', () => {
        renderTab();
        expect((screen.getByTestId('repo-add') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('repo-scan') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(screen.getByTestId('repo-path'), { target: { value: '/src' } });
        expect((screen.getByTestId('repo-add') as HTMLButtonElement).disabled).toBe(false);
    });

    it('offers no separate chooser button: the two buttons are the choosers (#283)', () => {
        renderTab({ onBrowse: vi.fn() });
        expect(screen.queryByTestId('repo-browse')).toBeNull();
        renderTab();
        expect(screen.queryByTestId('repo-browse')).toBeNull();
    });
});

/**
 * #283: Scan Directory and Add Repo in the desktop app. With the path field empty they raise the
 * native folder panel (`onBrowse`) and act on the folder chosen, as the shipped app's
 * `NSOpenPanel` did; a typed path still wins; a browser, with no panel, keeps them disabled
 * until a path is typed.
 */
describe('the folder chooser behind Scan Directory and Add Repo (#283)', () => {
    const button = (testID: string): HTMLButtonElement => screen.getByTestId(testID) as HTMLButtonElement;

    it('enables both buttons on an empty field when a chooser exists', () => {
        renderTab({ onBrowse: vi.fn() });
        expect(button('repo-add').disabled).toBe(false);
        expect(button('repo-scan').disabled).toBe(false);
        expect(button('repo-add').title).toContain('Choose');
    });

    it('Add Repo on an empty field asks for a folder and adds the one chosen', async () => {
        const onBrowse = vi.fn().mockResolvedValue('/chosen/repo');
        const acts = renderTab({ onBrowse });
        fireEvent.click(screen.getByTestId('repo-add'));
        await vi.waitFor(() => {
            expect(acts.log.added).toEqual([{ path: '/chosen/repo' }]);
        });
        expect(onBrowse).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('repo-notice').textContent).toBe('Added /chosen/repo');
        // The chosen path never went through the field, so the next press asks again.
        expect((screen.getByTestId('repo-path') as HTMLInputElement).value).toBe('');
    });

    it('Scan Directory on an empty field asks for a folder and scans the one chosen', async () => {
        const onBrowse = vi.fn().mockResolvedValue('/chosen/parent');
        const acts = renderTab({ onBrowse });
        fireEvent.click(screen.getByTestId('repo-scan'));
        await vi.waitFor(() => {
            expect(acts.log.scanned).toEqual(['/chosen/parent']);
        });
        expect(screen.getByTestId('repo-notice').textContent).toBe('Scanning /chosen/parent…');
    });

    it('does nothing on a cancel, or a chooser that fails', async () => {
        const onBrowse = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('').mockRejectedValueOnce(new Error('gone'));
        const acts = renderTab({ onBrowse });
        // One at a time: a press while a panel is up is ignored, so each waits for the last.
        for (const testID of ['repo-add', 'repo-scan', 'repo-add']) {
            fireEvent.click(screen.getByTestId(testID));
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(onBrowse).toHaveBeenCalledTimes(3);
        expect(acts.log.added).toEqual([]);
        expect(acts.log.scanned).toEqual([]);
        expect(screen.queryByTestId('repo-notice')).toBeNull();
    });

    it('acts on a typed path without raising the chooser', () => {
        const onBrowse = vi.fn().mockResolvedValue('/chosen');
        const acts = renderTab({ onBrowse });
        fireEvent.change(screen.getByTestId('repo-path'), { target: { value: '/typed/repo' } });
        expect(button('repo-add').title).toBe('');
        fireEvent.click(screen.getByTestId('repo-add'));
        fireEvent.change(screen.getByTestId('repo-path'), { target: { value: '/typed/parent' } });
        fireEvent.click(screen.getByTestId('repo-scan'));
        expect(onBrowse).not.toHaveBeenCalled();
        expect(acts.log.added).toEqual([{ path: '/typed/repo' }]);
        expect(acts.log.scanned).toEqual(['/typed/parent']);
    });

    it('raises one chooser at a time, however fast the button is pressed', async () => {
        let answer: (path: string | null) => void = () => {};
        const onBrowse = vi.fn(() => new Promise<string | null>((resolve) => { answer = resolve; }));
        const acts = renderTab({ onBrowse });
        fireEvent.click(screen.getByTestId('repo-add'));
        fireEvent.click(screen.getByTestId('repo-add'));
        fireEvent.click(screen.getByTestId('repo-scan'));
        expect(onBrowse).toHaveBeenCalledTimes(1);
        answer('/once');
        await vi.waitFor(() => {
            expect(acts.log.added).toEqual([{ path: '/once' }]);
        });
        expect(acts.log.scanned).toEqual([]);
    });

    it('Return on an empty field does not raise the chooser', () => {
        const onBrowse = vi.fn();
        renderTab({ onBrowse });
        fireEvent.keyDown(screen.getByTestId('repo-path'), { key: 'Enter' });
        expect(onBrowse).not.toHaveBeenCalled();
    });

    it('keeps both buttons disabled on an empty field in a browser, where there is no chooser', () => {
        renderTab();
        expect(button('repo-add').disabled).toBe(true);
        expect(button('repo-scan').disabled).toBe(true);
        expect(button('repo-add').title).toBe('');
    });

    it('removes a repo (§GIT-071)', () => {
        const acts = renderTab();
        fireEvent.click(screen.getByTestId('repo-remove-r1'));
        expect(acts.log.removed).toEqual(['r1']);
    });

    it('renames a repo inline, on Enter only (§GIT-072)', () => {
        const acts = renderTab();
        fireEvent.click(screen.getByTestId('repo-rename-r1'));
        const input = screen.getByTestId('repo-rename-input-r1');
        fireEvent.change(input, { target: { value: 'Work App' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(acts.log.renamed).toEqual([]);

        fireEvent.click(screen.getByTestId('repo-rename-r1'));
        const again = screen.getByTestId('repo-rename-input-r1');
        fireEvent.change(again, { target: { value: 'Work App' } });
        fireEvent.keyDown(again, { key: 'Enter' });
        expect(acts.log.renamed).toEqual([{ repoID: 'r1', name: 'Work App' }]);
    });

    it('disables the row actions when the host wired no repo verbs', () => {
        const bare = actions();
        // A host with no repo verbs wired at all: the optional members simply do not exist.
        delete (bare as { removeRepo?: unknown }).removeRepo;
        delete (bare as { renameRepo?: unknown }).renameRepo;
        delete (bare as { addRepo?: unknown }).addRepo;
        renderTab({ actions: bare });
        expect((screen.getByTestId('repo-remove-r1') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('repo-rename-r1') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('auto-detect (§GIT-074)', () => {
    it('renders from the daemon snapshot and writes the config key', () => {
        const acts = renderTab({ autoDetectRepos: true });
        const toggle = screen.getByTestId('auto-detect-toggle') as HTMLInputElement;
        expect(toggle.checked).toBe(true);
        fireEvent.click(toggle);
        expect(acts.log.general).toEqual([{ key: 'auto-detect-repos', value: 'false' }]);
    });

    it('shows OFF when the daemon says off — never from local state', () => {
        renderTab({ autoDetectRepos: false });
        expect((screen.getByTestId('auto-detect-toggle') as HTMLInputElement).checked).toBe(false);
    });

    it('explains what it does, in the shipped app’s words', () => {
        renderTab();
        expect(screen.getByTestId('auto-detect-row').textContent).toContain(
            "When a pane's working directory is inside a Git repository"
        );
    });
});
