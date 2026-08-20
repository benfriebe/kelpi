/**
 * Settings ▸ **Repositories** — the global repo registry (graft-git.md §GIT-065…§GIT-072,
 * settings §SET-052…§SET-057), plus the auto-detect toggle §GIT-074 puts on the General tab.
 *
 * The registry is what the workspace inspector's "New Worktree" picker chooses from and what
 * `nex workspace create --worktree` resolves against, so it needs a home even though every
 * association can also be made from the inspector. `RepoRegistryView.swift` is the reference:
 *
 *   - a **filter field** matching name OR path, case-insensitively (§SET-052);
 *   - **Scan Directory** and **Add Repo**, both taking a directory (§SET-053/§SET-054). The
 *     shipped app opens an `NSOpenPanel`; in the shell that is `onBrowse` (a native dialog), and
 *     in a browser — where no such thing exists — it is the path field beside it, which also
 *     keeps the flow usable against a REMOTE daemon whose filesystem this machine cannot browse;
 *   - a row per repo: name, middle-truncated path, remote URL when known (§SET-056);
 *   - the **two distinct empty states** (§SET-057): "No repositories registered", with a hint
 *     naming both buttons, versus "No matching repositories" when the filter excludes them all.
 *
 * Two documented divergences, both additive:
 *
 *   1. Auto-discovered repos are hidden by default, exactly as §SET-055/§GIT-070 specify — but a
 *      "Show auto-detected" checkbox reveals them, tagged `auto`. The Swift list hides them
 *      unconditionally because they are transient; being able to SEE what auto-detect has
 *      inferred (and promote one with Add) is worth a checkbox, and hiding stays the default.
 *   2. Remove and Rename are visible row buttons rather than a right-click-only context menu.
 *      §GIT-071's menu is a macOS affordance; a row whose only action is hidden behind a
 *      right-click is undiscoverable in a browser. Rename has no shipped UI at all (§GIT-072 is
 *      reducer-only), so this is its first surface.
 */

import { useMemo, useState, type ReactElement } from 'react';

import { tokens } from '../chrome';
import type { SettingsActions, SettingsPaths } from './types';
import { SettingsButton, SettingsFooterNote, SettingsRow, SettingsSection, SettingsToggle } from './ui';

/** A registry row as the client mirror carries it (`daemon.state.repos`). */
export interface RepositoryEntry {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly remoteURL?: string | null | undefined;
    readonly isAutoDiscovered?: boolean | undefined;
}

export interface RepositoriesTabProps {
    readonly repos: readonly RepositoryEntry[];
    readonly actions: SettingsActions;
    readonly paths: SettingsPaths;
    /** `auto-detect-repos`; the toggle renders from this, never from local state (§GIT-074). */
    readonly autoDetectRepos: boolean;
    /** Electron's native directory chooser. Absent in a browser — the path field stands in. */
    readonly onBrowse?: (() => Promise<string | null>) | undefined;
}

/** §SET-052: name OR path, case-insensitive. */
export function filterRepos(
    repos: readonly RepositoryEntry[],
    query: string,
    options: { includeAuto: boolean }
): readonly RepositoryEntry[] {
    const visible = options.includeAuto ? repos : repos.filter((repo) => repo.isAutoDiscovered !== true);
    const needle = query.trim().toLowerCase();
    if (needle === '') return visible;
    return visible.filter(
        (repo) => repo.name.toLowerCase().includes(needle) || repo.path.toLowerCase().includes(needle)
    );
}

export function RepositoriesTab(props: RepositoriesTabProps): ReactElement {
    const [query, setQuery] = useState('');
    const [includeAuto, setIncludeAuto] = useState(false);
    const [path, setPath] = useState('');
    const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const actions = props.actions;
    const rows = useMemo(
        () => filterRepos(props.repos, query, { includeAuto }),
        [props.repos, query, includeAuto]
    );
    const manualCount = props.repos.filter((repo) => repo.isAutoDiscovered !== true).length;
    const registryEmpty = includeAuto ? props.repos.length === 0 : manualCount === 0;

    const chooseDirectory = async (): Promise<void> => {
        if (props.onBrowse === undefined) return;
        const chosen = await props.onBrowse();
        if (chosen !== null && chosen !== '') setPath(chosen);
    };

    const submitAdd = (): void => {
        const target = path.trim();
        if (target === '' || actions.addRepo === undefined) return;
        actions.addRepo({ path: target });
        setPath('');
        setNotice(`Added ${target}`);
    };

    const submitScan = (): void => {
        const target = path.trim();
        if (target === '' || actions.scanRepos === undefined) return;
        actions.scanRepos({ path: target });
        setNotice(`Scanning ${target}…`);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-repositories">
            <SettingsSection
                title="Registry"
                hint="Registered repositories are what the inspector's New Worktree picker and nex workspace create --worktree choose from."
                testID="registry-section"
            >
                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        aria-label="Filter repos"
                        placeholder="Filter repos..."
                        data-testid="repo-filter"
                        className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[12px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                        }}
                    />
                    <label className="flex shrink-0 items-center gap-1 text-[11px]" style={{ color: tokens.textTertiary }}>
                        <SettingsToggle
                            testID="repo-show-auto"
                            label="Show auto-detected"
                            checked={includeAuto}
                            onChange={setIncludeAuto}
                        />
                        Show auto-detected
                    </label>
                </div>

                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        aria-label="Repository path"
                        placeholder="/path/to/repo or a folder to scan"
                        data-testid="repo-path"
                        className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[12px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        value={path}
                        onChange={(event) => {
                            setPath(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') submitAdd();
                        }}
                    />
                    {props.onBrowse === undefined ? null : (
                        <SettingsButton
                            testID="repo-browse"
                            onClick={() => {
                                void chooseDirectory();
                            }}
                        >
                            Choose…
                        </SettingsButton>
                    )}
                    <SettingsButton
                        testID="repo-scan"
                        disabled={path.trim() === '' || actions.scanRepos === undefined}
                        onClick={submitScan}
                    >
                        Scan Directory
                    </SettingsButton>
                    <SettingsButton
                        testID="repo-add"
                        tone="accent"
                        disabled={path.trim() === '' || actions.addRepo === undefined}
                        onClick={submitAdd}
                    >
                        Add Repo
                    </SettingsButton>
                </div>

                {notice === null ? null : (
                    <p data-testid="repo-notice" className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        {notice}
                    </p>
                )}

                {rows.length === 0 ? (
                    <div
                        data-testid="repo-empty"
                        className="flex flex-col items-center gap-1 rounded border border-dashed px-3 py-6 text-center"
                        style={{ borderColor: tokens.divider }}
                    >
                        <span className="text-[12px]" style={{ color: tokens.textSecondary }}>
                            {registryEmpty ? 'No repositories registered' : 'No matching repositories'}
                        </span>
                        {registryEmpty ? (
                            <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                                Use “Scan Directory” to find repos or “Add Repo” to add one.
                            </span>
                        ) : null}
                    </div>
                ) : (
                    <ul className="flex flex-col gap-1" data-testid="repo-list">
                        {rows.map((repo) => (
                            <li
                                key={repo.id}
                                data-testid={`repo-row-${repo.id}`}
                                data-origin={repo.isAutoDiscovered === true ? 'auto' : 'manual'}
                                className="flex items-center gap-2 rounded px-2 py-1.5"
                                style={{ background: 'rgba(128,128,128,0.06)' }}
                            >
                                <div className="flex min-w-0 flex-1 flex-col">
                                    {renaming !== null && renaming.id === repo.id ? (
                                        <input
                                            autoFocus
                                            aria-label="Repository name"
                                            data-testid={`repo-rename-input-${repo.id}`}
                                            className="min-w-0 rounded border bg-transparent px-1 py-[1px] text-[13px] outline-none"
                                            style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                            value={renaming.value}
                                            onChange={(event) => {
                                                setRenaming({ id: repo.id, value: event.target.value });
                                            }}
                                            onBlur={() => {
                                                setRenaming(null);
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Escape') setRenaming(null);
                                                if (event.key !== 'Enter') return;
                                                const next = renaming.value.trim();
                                                if (next !== '' && next !== repo.name) {
                                                    actions.renameRepo?.({ repoID: repo.id, name: next });
                                                }
                                                setRenaming(null);
                                            }}
                                        />
                                    ) : (
                                        <span
                                            className="truncate text-[13px] font-medium"
                                            style={{ color: tokens.textPrimary }}
                                        >
                                            {repo.name}
                                            {repo.isAutoDiscovered === true ? (
                                                <span
                                                    data-testid={`repo-auto-${repo.id}`}
                                                    className="ml-1 rounded px-1 text-[10px]"
                                                    style={{
                                                        background: 'rgba(211,163,41,0.18)',
                                                        color: '#D3A329'
                                                    }}
                                                >
                                                    auto
                                                </span>
                                            ) : null}
                                        </span>
                                    )}
                                    {/*
                                      * §SET-056 middle-truncates the path; a browser can only
                                      * truncate at one end, and the END is the informative half
                                      * of a repo path. `direction: rtl` moves the ellipsis to
                                      * the front, and `unicode-bidi: plaintext` keeps the path
                                      * itself in its own (LTR) order — without it the leading
                                      * "/" is re-ordered to the far end and the path reads as
                                      * nonsense.
                                      */}
                                    <span
                                        className="truncate text-[11px]"
                                        title={repo.path}
                                        style={{
                                            color: tokens.textSecondary,
                                            direction: 'rtl',
                                            unicodeBidi: 'plaintext',
                                            textAlign: 'left'
                                        }}
                                    >
                                        {repo.path}
                                    </span>
                                    {typeof repo.remoteURL === 'string' && repo.remoteURL !== '' ? (
                                        <span className="truncate text-[10px]" style={{ color: tokens.textTertiary }}>
                                            {repo.remoteURL}
                                        </span>
                                    ) : null}
                                </div>
                                <SettingsButton
                                    testID={`repo-rename-${repo.id}`}
                                    disabled={actions.renameRepo === undefined}
                                    onClick={() => {
                                        setRenaming({ id: repo.id, value: repo.name });
                                    }}
                                >
                                    Rename
                                </SettingsButton>
                                <SettingsButton
                                    testID={`repo-remove-${repo.id}`}
                                    tone="danger"
                                    disabled={actions.removeRepo === undefined}
                                    onClick={() => {
                                        actions.removeRepo?.({ repoID: repo.id });
                                        setNotice(`Removed ${repo.name}`);
                                    }}
                                >
                                    Remove
                                </SettingsButton>
                            </li>
                        ))}
                    </ul>
                )}
            </SettingsSection>

            <SettingsSection title="Auto-detect" testID="auto-detect-section">
                <SettingsRow
                    label="Auto-detect from pane directories"
                    detail="When a pane's working directory is inside a Git repository, automatically associate the repo (or worktree) with the workspace. Removed a few seconds after no pane remains in it. Manually added repos are never auto-removed."
                    testID="auto-detect-row"
                >
                    <SettingsToggle
                        testID="auto-detect-toggle"
                        label="Auto-detect from pane directories"
                        checked={props.autoDetectRepos}
                        onChange={(next) => {
                            actions.setGeneralSetting('auto-detect-repos', next ? 'true' : 'false');
                        }}
                    />
                </SettingsRow>
            </SettingsSection>

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.paths.nexConfig}</span>
            </SettingsFooterNote>
        </div>
    );
}
