/**
 * New workspace on a phone: a name, where it goes (a group, or nested under a workspace), the
 * repository it starts in and, for a repository, a git worktree on its own branch. The rules are
 * `phone/new-workspace.ts`'s; this is the bottom sheet that edits them.
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * The pickers are native `<select>`s: on a phone that is the system's own wheel or list, at the
 * system's own size, which no hand-built menu matches. The sheet is mounted only while open, so
 * every opening starts from the defaults rather than from the last draft.
 *
 * The prefill follows the desktop sheet (app-state-core.md §5.5): the placement's group lends its
 * default repository and worktree switch until the person picks a repository or touches the
 * worktree switch themselves, and it is re-applied when the registry arrives after the sheet
 * opened. The worktree name follows the workspace name, and the branch the worktree name, until
 * each is typed over.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useStore } from 'zustand';

import { parseRepos } from '../app/inspector';
import { tokens } from '../chrome/tokens';
import type { ChromeRepo, WorktreeCreateProgress } from '../chrome/types';
import { WORKTREE_STEP_LABELS, worktreeNameFromWorkspace, worktreePreview } from '../chrome/worktree';
import { selectSidebarEntries } from '../state';
import type { PhoneHostModel } from './model';
import {
    createPhoneWorkspace,
    parsePlacementValue,
    placementDefaults,
    placementOptions,
    placementValue,
    type PhonePlacement
} from './new-workspace';
import { PHONE_ROW_MIN_PX, PhoneSheet, PhoneSheetHeader } from './ui';

export interface PhoneNewWorkspaceSheetProps {
    /** The host the workspace is created on: the one on screen when the sheet was opened. */
    readonly host: PhoneHostModel;
    /** Said under the title when the phone knows more than one host, so "where" is never a guess. */
    readonly showHostName: boolean;
    /** Where the picker opens: §SET-011's inherited group, or top level. */
    readonly defaultPlacement: PhonePlacement;
    /** The create succeeded: show the new workspace. */
    readonly onCreated: (workspaceID: string) => void;
    readonly onClose: () => void;
}

const FIELD_CLASS = 'min-w-0 w-full rounded border px-3 text-[16px] outline-none';
const EMPTY_REPOS: readonly ChromeRepo[] = [];

export function PhoneNewWorkspaceSheet(props: PhoneNewWorkspaceSheetProps): ReactElement {
    const { host } = props;
    const entries = useStore(host.runtime.store, selectSidebarEntries);
    const options = useMemo(() => placementOptions(entries), [entries]);
    const [repos, setRepos] = useState<readonly ChromeRepo[]>(EMPTY_REPOS);

    const [name, setName] = useState('');
    const [placement, setPlacement] = useState(() => placementValue(props.defaultPlacement));
    const [repoID, setRepoID] = useState('');
    const [repoTouched, setRepoTouched] = useState(false);
    const [worktree, setWorktree] = useState(false);
    const [updateMain, setUpdateMain] = useState(false);
    const [worktreeTouched, setWorktreeTouched] = useState(false);
    const [worktreeName, setWorktreeName] = useState<string | null>(null);
    const [branch, setBranch] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<WorktreeCreateProgress | null>(null);
    const submitting = useRef(false);
    const mounted = useRef(true);
    const nameRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    // The keyboard comes up for the field the sheet was opened to type into.
    useEffect(() => {
        const frame = requestAnimationFrame(() => nameRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, []);

    // The registry is that host's, read once per opening; a failed read leaves only "None".
    useEffect(() => {
        let cancelled = false;
        host.runtime.commands.listRepos().then(
            (reply) => {
                if (!cancelled && reply['ok'] === true) setRepos(parseRepos(reply));
            },
            () => undefined
        );
        return () => {
            cancelled = true;
        };
    }, [host.runtime]);

    // A placement whose group or parent went away while the sheet was open falls back to top level.
    const chosen = parsePlacementValue(placement);
    const live: PhonePlacement =
        (chosen.kind === 'group' && !options.groups.some((group) => group.id === chosen.groupID)) ||
        (chosen.kind === 'parent' && !options.parents.some((parent) => parent.id === chosen.workspaceID))
            ? { kind: 'top' }
            : chosen;

    const defaults = placementDefaults(live, options, repos);
    const defaultsKey = `${defaults.repoIDs.join(',')}|${String(defaults.worktree)}`;
    const appliedDefaultsKey = useRef('|false');
    useEffect(() => {
        if (appliedDefaultsKey.current === defaultsKey) return;
        appliedDefaultsKey.current = defaultsKey;
        if (repoTouched) return;
        setRepoID(defaults.repoIDs[0] ?? '');
        if (worktreeTouched) return;
        setWorktree(defaults.worktree);
        setUpdateMain(defaults.worktree);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the defaults' content
    }, [defaultsKey]);

    const repo = repos.find((candidate) => candidate.id === repoID) ?? null;
    const makeWorktree = repo !== null && worktree;
    const followedWorktreeName = worktreeName ?? worktreeNameFromWorkspace(name);
    const followedBranch = branch ?? followedWorktreeName;
    const preview = repo === null ? null : worktreePreview({ name: followedWorktreeName, branch: followedBranch, base: repo.worktreeBase });

    // #294: start fetching the base while the person is still typing, once per repository.
    const prefetched = useRef(new Set<string>());
    useEffect(() => {
        if (!makeWorktree || !updateMain || prefetched.current.has(repo.id)) return;
        prefetched.current.add(repo.id);
        void host.runtime.commands.prefetchRepo(repo.id).catch(() => undefined);
    }, [makeWorktree, updateMain, repo, host.runtime]);

    // A refusal answers the draft that was sent: any change to the draft makes it stale, so it goes.
    useEffect(() => {
        setError(null);
    }, [name, placement, repoID, worktree, updateMain, worktreeName, branch]);

    const canSubmit = !busy && name.trim().length > 0 && (!makeWorktree || preview?.valid === true);

    const submit = (event: FormEvent): void => {
        event.preventDefault();
        if (!canSubmit || submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError(null);
        setProgress(null);
        void createPhoneWorkspace(
            host.runtime.commands,
            {
                name,
                placement: live,
                repo,
                worktree: makeWorktree ? { name: followedWorktreeName, branch: followedBranch, updateMain } : null
            },
            {
                focus: host.kind === 'origin',
                onProgress: (next) => {
                    if (mounted.current) setProgress(next);
                }
            }
        ).then((result) => {
            submitting.current = false;
            if (!result.ok) {
                if (!mounted.current) return;
                setBusy(false);
                setError(result.error);
                return;
            }
            // Closed while it ran: the create finished anyway, and the person asked for it.
            props.onCreated(result.workspaceID);
            if (mounted.current) props.onClose();
        });
    };

    const fieldStyle = {
        minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
        background: tokens.windowBackground,
        borderColor: tokens.divider,
        color: tokens.textPrimary
    } as const;
    const labelClass = 'flex flex-col gap-1 text-[13px]';
    const labelStyle = { color: tokens.textSecondary } as const;
    const checkClass = 'flex items-center gap-3 text-[15px]';
    const checkStyle = { minHeight: `${String(PHONE_ROW_MIN_PX)}px`, color: tokens.textPrimary } as const;
    const running = progress?.steps.find((step) => step.status === 'running');

    return (
        <PhoneSheet open side="bottom" label="New workspace" testID="phone-new-workspace-sheet" onClose={props.onClose}>
            <PhoneSheetHeader title="New workspace" testID="phone-new-workspace-header" onClose={props.onClose} />
            {/* The fields scroll and Create does not: with a worktree's fields open the form is
                taller than the sheet on a phone, and the one button that matters must not be
                below the fold. */}
            <form className="flex min-h-0 flex-col" onSubmit={submit} data-testid="phone-new-workspace-form">
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
                    {props.showHostName ? (
                        <span data-testid="phone-new-workspace-host" className="text-[13px]" style={{ color: tokens.textTertiary }}>
                            On {host.name}
                        </span>
                    ) : null}
                    <label className={labelClass} style={labelStyle}>
                        Name
                        <input
                            ref={nameRef}
                            data-testid="phone-new-workspace-name"
                            className={FIELD_CLASS}
                            style={fieldStyle}
                            value={name}
                            placeholder="workspace name"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            enterKeyHint="go"
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                    {options.groups.length > 0 || options.parents.length > 0 ? (
                        <label className={labelClass} style={labelStyle}>
                            Location
                            <select
                                data-testid="phone-new-workspace-placement"
                                className={FIELD_CLASS}
                                style={fieldStyle}
                                value={placementValue(live)}
                                onChange={(event) => setPlacement(event.target.value)}
                            >
                                <option value="top">No group</option>
                                {options.groups.length > 0 ? (
                                    <optgroup label="In group">
                                        {options.groups.map((group) => (
                                            <option key={group.id} value={placementValue({ kind: 'group', groupID: group.id })}>
                                                {group.name}
                                            </option>
                                        ))}
                                    </optgroup>
                                ) : null}
                                {options.parents.length > 0 ? (
                                    <optgroup label="Nested under">
                                        {options.parents.map((parent) => (
                                            <option key={parent.id} value={placementValue({ kind: 'parent', workspaceID: parent.id })}>
                                                {parent.groupName === null ? parent.name : `${parent.name} (${parent.groupName})`}
                                            </option>
                                        ))}
                                    </optgroup>
                                ) : null}
                            </select>
                        </label>
                    ) : null}
                    {repos.length > 0 ? (
                        <label className={labelClass} style={labelStyle}>
                            Repository
                            <select
                                data-testid="phone-new-workspace-repo"
                                className={FIELD_CLASS}
                                style={fieldStyle}
                                value={repo === null ? '' : repo.id}
                                onChange={(event) => {
                                    setRepoTouched(true);
                                    setRepoID(event.target.value);
                                }}
                            >
                                <option value="">None</option>
                                {repos.map((candidate) => (
                                    <option key={candidate.id} value={candidate.id}>
                                        {candidate.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    {repo === null ? null : (
                        <label className={checkClass} style={checkStyle}>
                            <input
                                type="checkbox"
                                data-testid="phone-new-workspace-worktree"
                                checked={worktree}
                                onChange={(event) => {
                                    setWorktreeTouched(true);
                                    setWorktree(event.target.checked);
                                }}
                            />
                            Create a git worktree
                        </label>
                    )}
                    {!makeWorktree || preview === null ? null : (
                        <div className="flex flex-col gap-3" data-testid="phone-new-workspace-worktree-fields">
                            <label className={labelClass} style={labelStyle}>
                                Worktree
                                <input
                                    data-testid="phone-new-workspace-worktree-name"
                                    className={FIELD_CLASS}
                                    style={fieldStyle}
                                    value={followedWorktreeName}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    // Cleared, it follows the workspace name again (the desktop's rule).
                                    onChange={(event) => setWorktreeName(event.target.value === '' ? null : event.target.value)}
                                />
                            </label>
                            <label className={labelClass} style={labelStyle}>
                                Branch
                                <input
                                    data-testid="phone-new-workspace-branch"
                                    className={FIELD_CLASS}
                                    style={fieldStyle}
                                    value={followedBranch}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    onChange={(event) => setBranch(event.target.value === '' ? null : event.target.value)}
                                />
                            </label>
                            <label className={checkClass} style={checkStyle}>
                                <input
                                    type="checkbox"
                                    data-testid="phone-new-workspace-update-main"
                                    checked={updateMain}
                                    onChange={(event) => {
                                        setWorktreeTouched(true);
                                        setUpdateMain(event.target.checked);
                                    }}
                                />
                                Start from the latest main
                            </label>
                            <span data-testid="phone-new-workspace-preview" className="break-all text-[12px]" style={{ color: tokens.textTertiary }}>
                                {preview.path}
                                <br />
                                {preview.branchLine}
                            </span>
                        </div>
                    )}
                </div>
                <div className="flex shrink-0 flex-col gap-2 border-t px-3 py-2" style={{ borderColor: tokens.divider }}>
                    {error === null ? null : (
                        <span data-testid="phone-new-workspace-error" role="alert" className="text-[13px]" style={{ color: '#E5484D' }}>
                            {error}
                        </span>
                    )}
                    <button
                        type="submit"
                        data-testid="phone-new-workspace-create"
                        disabled={!canSubmit}
                        className="flex shrink-0 items-center justify-center rounded text-[15px] font-semibold"
                        style={{
                            minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
                            background: tokens.accent,
                            color: '#fff',
                            opacity: canSubmit || busy ? 1 : 0.4
                        }}
                    >
                        {busy ? (running === undefined ? 'Creating…' : `${WORKTREE_STEP_LABELS[running.id]}…`) : 'Create'}
                    </button>
                </div>
            </form>
        </PhoneSheet>
    );
}
