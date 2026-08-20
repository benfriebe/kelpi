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

    it('fills the path from a native directory chooser when one is available', async () => {
        const onBrowse = vi.fn().mockResolvedValue('/chosen/dir');
        renderTab({ onBrowse });
        fireEvent.click(screen.getByTestId('repo-browse'));
        await vi.waitFor(() => {
            expect((screen.getByTestId('repo-path') as HTMLInputElement).value).toBe('/chosen/dir');
        });
    });

    it('offers no chooser button in a browser', () => {
        renderTab();
        expect(screen.queryByTestId('repo-browse')).toBeNull();
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
