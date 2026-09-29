/**
 * Settings ▸ **Repositories** — the global repo registry (graft-git.md §GIT-065…§GIT-072,
 * settings §SET-052…§SET-057), plus the auto-detect toggle §GIT-074 puts on the General tab.
 *
 * The registry is what the workspace inspector's "New Worktree" picker chooses from and what
 * `kelpi workspace create --worktree` resolves against, so it needs a home even though every
 * association can also be made from the inspector. `RepoRegistryView.swift` is the reference:
 *
 *   - a **filter field** matching name OR path, case-insensitively (§SET-052);
 *   - **Scan Directory** and **Add Repo**, both taking a directory (§SET-053/§SET-054). The
 *     shipped app opens an `NSOpenPanel` from both. Here (#283) a button pressed with the path
 *     field EMPTY does the same in the desktop app, through `onBrowse` (a native panel raised by
 *     the shell), and then scans or adds the folder chosen; a cancel does nothing. A typed path
 *     always wins, so the field doubles as the way to name a path without the panel. In a
 *     browser there is no `onBrowse` and the field is the only input (the buttons stay disabled
 *     until it holds something), which also keeps the flow usable against a REMOTE daemon whose
 *     filesystem this machine cannot browse. There is no separate "Choose…" button: the two
 *     buttons ARE the choosers, as they were in the shipped app;
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

import { useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { tokens } from '../chrome';
import { ExternalDriveGlyph, FolderBadgeGearGlyph, PlusGlyph } from './glyphs';
import type { SettingsActions, SettingsPaths } from './types';
import {
    SettingsButton,
    SettingsEmptyState,
    SettingsFooterNote,
    SettingsRow,
    SettingsSection,
    SettingsToggle,
    hoverBackground,
    useHover
} from './ui';

/**
 * One registry row. H11: `RepoRegistryView.swift:18-24` renders a `List`, whose rows AppKit
 * lights under the pointer; these were flat tinted strips that never moved, so a row with two
 * buttons on it read as a static line of text.
 *
 * L86: **at rest it paints nothing.** `.listStyle(.inset)` (`:51`) draws no fill per row — the
 * port's `rgba(128,128,128,0.06)` card was the same misplaced grouped-form tone L79 took off the
 * form rows, and it also swallowed the hover response, since a lit row and a tinted row are hard
 * to tell apart. Transparent at rest, `selectionFill` under the pointer.
 */
function RepoRow(props: {
    readonly id: string;
    readonly auto: boolean;
    readonly children: ReactNode;
}): ReactElement {
    const { hovered, hoverProps } = useHover();
    return (
        <li
            data-testid={`repo-row-${props.id}`}
            data-origin={props.auto ? 'auto' : 'manual'}
            // S64: `px-2.5`, matching `SETTINGS_ROW_PADDING`'s 10 px. Vertical untouched.
            className="flex items-center gap-2 rounded px-2.5 py-1.5 transition-colors duration-100"
            style={{ background: hoverBackground(hovered, 'transparent') }}
            {...hoverProps}
        >
            {props.children}
        </li>
    );
}

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
    /**
     * Electron's native directory chooser, resolving null on a cancel. Present only in the
     * desktop app; absent in a browser, where the path field is the only input.
     */
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

    /*
     * One panel at a time. A double-click on an empty-field button would otherwise queue two
     * native panels, and the second would ask again for a folder the user has just chosen. A ref
     * rather than state because nothing is drawn differently while the panel is up: it is modal
     * over the window, so the buttons cannot be seen, let alone pressed, until it closes.
     */
    const browsing = useRef(false);
    const hasTypedPath = path.trim() !== '';
    const canBrowse = props.onBrowse !== undefined;

    /**
     * The folder the native panel returns, or null for "do nothing": no panel here, a panel
     * already up, a cancel, or a panel that failed. Only reached with the path field empty.
     */
    const chooseFolder = async (): Promise<string | null> => {
        const browse = props.onBrowse;
        if (browse === undefined || browsing.current) return null;
        browsing.current = true;
        try {
            const chosen = (await browse())?.trim() ?? '';
            return chosen === '' ? null : chosen;
        } catch {
            return null;
        } finally {
            browsing.current = false;
        }
    };

    const add = (target: string): void => {
        actions.addRepo?.({ path: target });
        setNotice(`Added ${target}`);
    };

    const scan = (target: string): void => {
        actions.scanRepos?.({ path: target });
        setNotice(`Scanning ${target}…`);
    };

    /*
     * A typed path is acted on at once, exactly as before the panel existed. An empty field asks
     * the panel (desktop app only) and acts on the folder it returns; the field is left alone, so
     * it stays empty and the next press asks again.
     */
    const submitAdd = (): void => {
        if (actions.addRepo === undefined) return;
        const typed = path.trim();
        if (typed !== '') {
            add(typed);
            setPath('');
            return;
        }
        void chooseFolder().then((chosen) => {
            if (chosen !== null) add(chosen);
        });
    };

    const submitScan = (): void => {
        if (actions.scanRepos === undefined) return;
        const typed = path.trim();
        if (typed !== '') {
            scan(typed);
            return;
        }
        void chooseFolder().then((chosen) => {
            if (chosen !== null) scan(chosen);
        });
    };

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-repositories">
            {/*
             * L79's `plain`: `RepoRegistryView.swift:12-55` is `VStack { HStack(toolbar); Divider;
             * List }` — a toolbar over a list, with no `Form` and no card. The Auto-detect section
             * below IS a grouped-form row (it is General ▸ Repositories in the shipped app), so it
             * keeps the card.
             */}
            <SettingsSection
                plain
                title="Registry"
                hint="Registered repositories are what the inspector's New Worktree picker and kelpi workspace create --worktree choose from."
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
                        placeholder={
                            canBrowse
                                ? 'Leave empty to choose a folder, or type a path'
                                : '/path/to/repo or a folder to scan'
                        }
                        data-testid="repo-path"
                        className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[12px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        value={path}
                        onChange={(event) => {
                            setPath(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            // Return adds what was TYPED. On an empty field it does nothing rather
                            // than raising a panel: a key press in a text field is not a click on
                            // a button that says it opens one.
                            if (event.key === 'Enter' && hasTypedPath) submitAdd();
                        }}
                    />
                    {/*
                     * L86: both toolbar buttons are `Label(_, systemImage:)` in the shipped app
                     * (`RepoRegistryView.swift:18-24`) — `folder.badge.gearshape` on Scan,
                     * `plus` on Add — and the port had dropped the glyphs and kept the words.
                     * Hand-rolled on `glyphs.tsx`'s 12 × 12 grid, sized to the 11 px button text.
                     */}
                    {/*
                     * Enabled on an empty field only when a panel can fill it (#283); in a browser
                     * the buttons wait for a typed path exactly as before.
                     */}
                    <SettingsButton
                        testID="repo-scan"
                        disabled={(!hasTypedPath && !canBrowse) || actions.scanRepos === undefined}
                        {...(canBrowse && !hasTypedPath ? { title: 'Choose a folder to scan for repositories' } : {})}
                        onClick={submitScan}
                    >
                        <span className="flex items-center gap-1.5">
                            <FolderBadgeGearGlyph size={11} />
                            Scan Directory
                        </span>
                    </SettingsButton>
                    <SettingsButton
                        testID="repo-add"
                        tone="accent"
                        disabled={(!hasTypedPath && !canBrowse) || actions.addRepo === undefined}
                        {...(canBrowse && !hasTypedPath ? { title: 'Choose a repository folder to add' } : {})}
                        onClick={submitAdd}
                    >
                        <span className="flex items-center gap-1.5">
                            <PlusGlyph size={11} />
                            Add Repo
                        </span>
                    </SettingsButton>
                </div>

                {notice === null ? null : (
                    <p data-testid="repo-notice" className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        {notice}
                    </p>
                )}

                {/*
                 * M45: `RepoRegistryView.swift:31-45` — an `externaldrive` at 36 pt in
                 * `.quaternary` over a `.secondary` headline, centred in the space, with the
                 * "Scan Directory"/"Add Repo" caption only when the REGISTRY is empty (a filter
                 * that matched nothing does not need telling how to add one). The port drew no
                 * glyph at all, inside a dashed card the `VStack` never had.
                 */}
                {rows.length === 0 ? (
                    <SettingsEmptyState
                        testID="repo-empty"
                        glyph={<ExternalDriveGlyph size={36} />}
                        glyphTone="quaternary"
                        title={registryEmpty ? 'No repositories registered' : 'No matching repositories'}
                        {...(registryEmpty
                            ? { detail: 'Use “Scan Directory” to find repos or “Add Repo” to add one.' }
                            : {})}
                    />
                ) : (
                    <ul className="flex flex-col gap-1" data-testid="repo-list">
                        {rows.map((repo) => (
                            <RepoRow
                                key={repo.id}
                                id={repo.id}
                                auto={repo.isAutoDiscovered === true}
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
                            </RepoRow>
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
                Config: <span className="font-mono">{props.paths.kelpiConfig}</span>
            </SettingsFooterNote>
        </div>
    );
}
