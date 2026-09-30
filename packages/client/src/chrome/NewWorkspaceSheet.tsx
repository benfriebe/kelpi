/**
 * The New Workspace / New Group sheet — `NewWorkspaceSheet.swift` + `NewGroupSheet.swift`.
 *
 * **This is a modal sheet, presented over the window, exactly as the shipped app presents it.**
 * `ContentView.swift:289-294` hangs `NewWorkspaceSheet` off the window with `.sheet(isPresented:)`,
 * raised by `AppReducer.showNewWorkspaceSheet(groupID:)` (`AppReducer.swift:1485-1493`) from every
 * route that creates a workspace — ⌘N, File ▸ New Workspace, the footer's "+ New Workspace", the
 * footer chevron's first row, a group header's "New Workspace" (which carries the group as
 * `pendingSheetGroupID`) and the no-workspace empty state.
 *
 * The port used to expand this form INLINE in the sidebar footer. Everything it collected was the
 * sheet's; where it appeared was not, and the user's report was exactly that. Nothing about the
 * fields, the defaults or the submission changed in the move — the form is the same component,
 * lifted out of the footer and given the chrome the other modal surfaces in this client already
 * use (`SettingsOverlay`'s dimmed backdrop + centring, `QuitConfirmDialog`'s body portal and
 * capture-phase Escape).
 *
 * The rules that are contracts rather than styling, each with the Swift line that fixes it:
 *
 *   - **Field order is the Swift's `Field` enum** (`NewWorkspaceSheet.swift:10-23`): name, colour,
 *     group, profile, each repo's remove button, Add Repository, the worktree toggle and its three
 *     controls, Cancel, Create. Kelpi adds one stop the Swift never had, Mute Notifications, right
 *     after profile (agent-lifecycle §7.6). Tab is driven by hand for the reason the Swift drives its own
 *     (#64): the colour row is ONE stop with ←/→ moving inside it, and a disabled Create is
 *     skipped rather than landed on — AppKit refuses first responder to a disabled button, so
 *     including it would strand the loop.
 *   - **The colour opens on `nextRandomColor`** — a random swatch that avoids the trailing
 *     workspace's (`WorkspaceFeature.swift:1993-2003`); the caller rolls it once per opening.
 *   - **The Group picker exists only when groups exist** and preselects the sheet's scope: the
 *     explicit `pendingSheetGroupID` first, else the active workspace's group when
 *     `inherit-group-on-new-workspace` is on (`NewWorkspaceSheet.swift:65-71`).
 *   - **The Profile picker leads with the built-in `default`** (§SET-214), which rides the wire as
 *     "unassigned".
 *   - **Escape cancels and the backdrop cancels**, innermost surface first: with the repo picker
 *     open, both close the picker and leave the sheet standing.
 *   - **The repo picker is a SUB-SHEET over this one** (`NewWorkspaceSheet.swift:227-239` hangs
 *     `RepoPickerView` off the sheet with its own `.sheet(isPresented:)`): its own dimming
 *     layer above the sheet, landing at the sheet's top edge and at the sheet's width, so
 *     "which panel is live" is never a question.
 *   - **A second Create cannot race the first.** The in-flight guard is a ref, not the rendered
 *     `busy` flag, so two submits in the SAME tick cannot both pass (`isSubmittingWorktree`,
 *     `NewWorkspaceSheet.swift:52-56`).
 *
 *   - **Create is the DEFAULT ACTION** (`.keyboardShortcut(.defaultAction)`,
 *     `NewWorkspaceSheet.swift:205`), which on macOS is two things at once: the filled accent push
 *     button, and Return from anywhere in the sheet. M9 restored both — the port's Create was an
 *     outline identical in weight to Cancel, and Return only submitted from the name field,
 *     because that is what a browser's implicit form submission happens to give you.
 *
 * One divergence, stated. An EMPTY registry gets the Repositories heading plus one line saying
 * where repositories come from, where the Swift renders the section not at all; see the section's
 * own comment for why a silent gap was the user's report and why the line is not a focusable stop.
 *
 * (The worktree section used to be a second one — offered whenever the registry was non-empty,
 * with a repo `<select>` inside it. M4 took it back to the Swift's rule: it is revealed only when
 * the Repositories section above names EXACTLY ONE repo, `NewWorkspaceSheet.swift:179-183`, and
 * the picker inside it is gone because there is no longer anything for it to disambiguate.)
 */

import type { WorkspaceColor } from '@kelpi/daemon/store';
import {
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactElement
} from 'react';
import { createPortal } from 'react-dom';

import { ChromeIcon } from './icons';
import { RepoPicker } from './RepoPicker';
import { WorktreeCreateProgressPanel, type WorktreeCreatePhase } from './WorktreeCreateProgress';
import { withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';
import {
    DEFAULT_PROFILE_NAME,
    WORKSPACE_COLORS,
    type ChromeGroup,
    type ChromeRepo,
    type NewGroupRepo,
    type WorkspaceWorktreeRequest,
    type WorktreeCreateProgress
} from './types';
import { initialWorktreeProgress, worktreeNameFromWorkspace, worktreePreview } from './worktree';

/** Everything the New Workspace / New Group sheet collects, in one submit (§WS-075/§WS-082). */
export interface NewEntryDraft {
    readonly name: string;
    /** `null` = the group sheet's "None" swatch; a workspace always carries a colour. */
    readonly color: WorkspaceColor | null;
    readonly groupID: string | null;
    /** `null` = the built-in `default` baseline, which the daemon normalizes to "unassigned". */
    readonly profile: string | null;
    /** Create the workspace already muted (agent-lifecycle §7.6). Workspace-kind only. */
    readonly muted: boolean;
    /**
     * §1.7 multi-daemon groups: which daemon a NEW GROUP is created on. Null = this one.
     * Group-kind only; the workspace sheet neither shows nor sets it.
     */
    readonly remoteDaemon: string | null;
    /** Repo PATHS to associate once the workspace exists (§WS-075's Repositories section). */
    readonly repoPaths: readonly string[];
    readonly worktree?: WorkspaceWorktreeRequest | undefined;
    /**
     * app-state-core.md §5.5: the New Group sheet's optional repository and worktree switch.
     * Group-kind only (always null from the workspace sheet), and null for a remote group, whose
     * registry is another daemon's.
     */
    readonly groupRepo: NewGroupRepo | null;
}

export interface NewEntrySheetProps {
    readonly kind: 'workspace' | 'group';
    /**
     * §H22: the light/dark bucket the colour swatches resolve against. It used to be pinned to
     * `'dark'` at the swatch, so a light-theme sheet offered the dark palette's hues and then
     * created a row painted in the light ones. Optional (defaulting to `'dark'`) only so a
     * fixture mounted without one keeps rendering, the same contract `tokens.ts` follows.
     */
    readonly bucket?: ChromeBucket | undefined;
    /** The registry: the Repositories section and the worktree section both read it. */
    readonly repos?: readonly ChromeRepo[] | undefined;
    /** Groups for the picker; empty hides it, exactly as the shipped sheet does. */
    readonly groups?: readonly ChromeGroup[] | undefined;
    /** Config-defined profile names. `default` leads the list and is never expected in it. */
    readonly profiles?: readonly string[] | undefined;
    /** §1.7: registered remote daemon names — the group sheet's "Runs on" choices. */
    readonly remoteDaemons?: readonly string[] | undefined;
    /** The group the picker opens on: the menu's explicit one, else SET-011's inherited one. */
    readonly defaultGroupID?: string | null | undefined;
    /** The swatch the sheet opens on — `nextCreateColor`, which avoids the neighbour's colour. */
    readonly defaultColor?: WorkspaceColor | undefined;
    /** The group sheet's pre-filled unique default name ("New Group 2", §WS-083). */
    readonly defaultName?: string | undefined;
    /** Set when the bulk menu raised this sheet: "Group N selected workspace(s)." */
    readonly workspaceCount?: number | undefined;
    /**
     * #283's native folder panel, desktop app only: the New Group sheet's Repository row offers
     * Choose Folder… with it (app-state-core.md §5.5), and shows the row even over an empty
     * registry. Resolves to the chosen path, or null on cancel.
     */
    readonly onBrowseForFolder?: (() => Promise<string | null>) | undefined;
    /**
     * #294: start fetching a repo's default branch in the background, called once per repo per
     * opening while the sheet shows a worktree off latest main for it (a group's switch
     * pre-ticking it included). Fire-and-forget: its outcome is never shown.
     */
    readonly onPrefetchRepo?: ((repoID: string) => void) | undefined;
    /**
     * #294: stop the running worktree create sent with this request id. Absent = the host cannot
     * cancel, and Cancel closes the sheet as it always did (the create finishes on its own).
     */
    readonly onCancelCreate?: ((requestID: string) => void) | undefined;
    readonly onSubmit: (draft: NewEntryDraft) => Promise<string | null>;
    readonly onCancel: () => void;
}

/** A create id the daemon can cancel by: a UUID where the page has one, else unique enough. */
let requestCounter = 0;
function mintRequestID(): string {
    const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    requestCounter += 1;
    return `create-${Date.now().toString(36)}-${String(requestCounter)}`;
}

const EMPTY_REPOS: readonly ChromeRepo[] = [];
const EMPTY_GROUPS: readonly ChromeGroup[] = [];
const EMPTY_PROFILES: readonly string[] = [];
const EMPTY_REPO_IDS: readonly string[] = [];
/** The New Group sheet's Repository value for "the folder Choose Folder… returned". */
const FOLDER_CHOICE = '__folder__';

/** A folder's own name, for the Repository row's option label. */
function folderName(folder: string): string {
    const trimmed = folder.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || folder;
}

/** What a group's default repository prefills in the workspace sheet (app-state-core §5.5). */
export interface GroupSheetDefaults {
    readonly repoIDs: readonly string[];
    /** The worktree toggle AND its update-main box: "a worktree from latest main". */
    readonly worktree: boolean;
}

/**
 * §5.5: the prefill for a workspace created in `groupID`. The group's repository, when the
 * registry still lists it (a repo not loaded yet, or gone, prefills nothing rather than a row
 * the sheet cannot name); with its switch on, the worktree toggle and update main as well.
 */
export function groupSheetDefaults(
    groupID: string | null,
    groups: readonly ChromeGroup[],
    repos: readonly ChromeRepo[]
): GroupSheetDefaults {
    const group = groupID === null ? undefined : groups.find((candidate) => candidate.id === groupID);
    const repoID = group?.repoID ?? null;
    if (repoID === null || !repos.some((repo) => repo.id === repoID)) return { repoIDs: EMPTY_REPO_IDS, worktree: false };
    return { repoIDs: [repoID], worktree: group?.createWorktree === true };
}

/**
 * The sheet's fields are editables and must keep caret dragging, double-click-to-word and
 * shift-arrow selection. The sheet is portalled onto `document.body`, so it no longer inherits
 * the sidebar container's `user-select: none` — but the opt-in is kept beside the fields it
 * protects rather than left implicit in where the node happens to be parented.
 */
const SELECTABLE_TEXT_STYLE = {
    userSelect: 'text'
} as const satisfies CSSProperties;

/**
 * The modal New Workspace / New Group sheet.
 *
 * Centred over the window on a dimmed backdrop, above every chrome surface, with the keyboard
 * trapped by its own Tab loop. The caller owns whether it is mounted; this owns everything it
 * collects and hands one `NewEntryDraft` back.
 */
export function NewEntrySheet(props: NewEntrySheetProps): ReactElement | null {
    const repos = props.repos ?? EMPTY_REPOS;
    const groups = props.groups ?? EMPTY_GROUPS;
    const profiles = props.profiles ?? EMPTY_PROFILES;
    const isWorkspace = props.kind === 'workspace';
    const title = isWorkspace ? 'New Workspace' : 'New Group';

    const [value, setValue] = useState(props.defaultName ?? '');
    const [color, setColor] = useState<WorkspaceColor | null>(
        // The group sheet opens on "None"; the workspace sheet opens on the random colour.
        isWorkspace ? (props.defaultColor ?? 'blue') : null
    );
    const [groupID, setGroupID] = useState<string | null>(props.defaultGroupID ?? null);
    const [profile, setProfile] = useState<string>(DEFAULT_PROFILE_NAME);
    const [muted, setMuted] = useState(false);
    const [remoteDaemon, setRemoteDaemon] = useState<string>('');
    /*
     * app-state-core.md §5.5: the group's default repository prefills the Repositories section,
     * and its worktree switch prefills the worktree toggle with update main ticked. Everything
     * stays editable for a one-off. A change of Group swaps the prefill for the new group's,
     * until the user edits the repo selection themselves (`repoTouched`), after which their
     * choice is theirs. The prefill is also re-applied when the registry arrives after the
     * sheet opened (it is fetched), which is the same "defaults changed, nobody chose" case.
     */
    const initialDefaults = useRef<GroupSheetDefaults | null>(null);
    if (initialDefaults.current === null) {
        initialDefaults.current = isWorkspace
            ? groupSheetDefaults(props.defaultGroupID ?? null, groups, repos)
            : { repoIDs: EMPTY_REPO_IDS, worktree: false };
    }
    const [chosenRepoIDs, setChosenRepoIDs] = useState<readonly string[]>(initialDefaults.current.repoIDs);
    const [repoTouched, setRepoTouched] = useState(false);
    /**
     * The same rule for the worktree toggle and its update-main box: once the user has set
     * either, neither a Group change nor the group's switch changing under the open sheet may
     * overwrite it. The repo prefill still swaps (it has its own flag, above).
     */
    const [worktreeTouched, setWorktreeTouched] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [worktree, setWorktree] = useState(initialDefaults.current.worktree);
    /*
     * app-state-core.md §5.5: the worktree name FOLLOWS the workspace name (through the daemon's
     * own sanitizer, `worktreeNameFromWorkspace`) until the user types in the worktree field
     * themselves; the branch follows the worktree name the way it always has, until the user
     * types in the branch field. It follows even while the worktree section is hidden, so
     * ticking "Create git worktree" (or a group's switch pre-ticking it) shows the fields filled
     * from whatever name is already typed. Clearing the worktree field, or typing it back to
     * exactly what it would follow, resumes following: the same rule as `branchEdited`.
     */
    const [worktreeName, setWorktreeName] = useState(() => worktreeNameFromWorkspace(props.defaultName ?? ''));
    const [worktreeNameEdited, setWorktreeNameEdited] = useState(false);
    const [branch, setBranch] = useState(() => worktreeNameFromWorkspace(props.defaultName ?? ''));
    const [branchEdited, setBranchEdited] = useState(false);
    const [updateMain, setUpdateMain] = useState(initialDefaults.current.worktree);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /*
     * #294 (shell-ui.md §10.1): a worktree create's steps, from the moment Create is pressed until
     * the sheet closes or the next submit. `createPhase` is null for every other create, which
     * keeps the sheet exactly as it was for them.
     */
    const [progress, setProgress] = useState<WorktreeCreateProgress | null>(null);
    const [createPhase, setCreatePhase] = useState<WorktreeCreatePhase | null>(null);
    const [createStartedAt, setCreateStartedAt] = useState(0);
    const [createEndedAt, setCreateEndedAt] = useState<number | null>(null);
    const [clock, setClock] = useState(() => Date.now());
    const [closeHint, setCloseHint] = useState(false);
    const requestID = useRef<string | null>(null);
    const worktreeRunning = createPhase === 'running' || createPhase === 'cancelling';
    /** Read by the window-level Escape handler, installed once. */
    const worktreeRunningRef = useRef(worktreeRunning);
    worktreeRunningRef.current = worktreeRunning;
    /** The New Group sheet's optional repository (§5.5): a registry id, '' = none. */
    const [groupRepoID, setGroupRepoID] = useState('');
    /** A folder the New Group sheet's Choose Folder… returned; picked while `groupRepoID` is FOLDER_CHOICE. */
    const [groupRepoFolder, setGroupRepoFolder] = useState<string | null>(null);
    const browsingFolder = useRef(false);
    const [groupCreateWorktree, setGroupCreateWorktree] = useState(false);

    const defaults = isWorkspace ? groupSheetDefaults(groupID, groups, repos) : initialDefaults.current;
    const defaultsKey = `${defaults.repoIDs.join(',')}|${String(defaults.worktree)}`;
    const appliedDefaultsKey = useRef(
        `${initialDefaults.current.repoIDs.join(',')}|${String(initialDefaults.current.worktree)}`
    );
    useEffect(() => {
        if (appliedDefaultsKey.current === defaultsKey) return;
        appliedDefaultsKey.current = defaultsKey;
        if (repoTouched) return;
        setChosenRepoIDs(defaults.repoIDs);
        if (worktreeTouched) return;
        setWorktree(defaults.worktree);
        setUpdateMain(defaults.worktree);
        // `defaults` is derived from the key's inputs; the key is the change that matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [defaultsKey, repoTouched, worktreeTouched]);

    const ref = useRef<HTMLInputElement | null>(null);
    /** Every focusable stop, by field id — the Tab loop's address book (§WS-077). */
    const stops = useRef(new Map<string, HTMLElement>());
    const registerStop = (id: string, element: HTMLElement | null): void => {
        if (element === null) stops.current.delete(id);
        else stops.current.set(id, element);
    };

    /**
     * §WS-079's in-flight guard, as a REF rather than as the rendered `busy` flag.
     *
     * `busy` is state: two submits dispatched in the same tick both read `false` and both fire
     * `git worktree add`. The ref closes in the same tick the first submit opens it, which is
     * what `isSubmittingWorktree` does in the Swift (`NewWorkspaceSheet.swift:255-256`).
     */
    const inFlight = useRef(false);
    /** Read by the window-level Escape handler, which is installed once. */
    const cancelRef = useRef(props.onCancel);
    cancelRef.current = props.onCancel;
    const pickerOpenRef = useRef(pickerOpen);
    pickerOpenRef.current = pickerOpen;

    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);

    /**
     * Escape closes the INNERMOST surface — the repo picker if it is up, otherwise the sheet.
     *
     * Capture phase on the window, the way `QuitConfirmDialog` takes it: a pane's own key
     * handling (or the terminal engine's) must never be able to swallow the way out of a modal.
     */
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            if (pickerOpenRef.current) {
                setPickerOpen(false);
                return;
            }
            // #294: a running worktree create is not dismissed by a stray Escape (that would
            // leave it running with nothing on screen); the sheet says to press Cancel instead.
            if (worktreeRunningRef.current) {
                setCloseHint(true);
                return;
            }
            cancelRef.current();
        };
        globalThis.window?.addEventListener('keydown', onKeyDown, true);
        return () => globalThis.window?.removeEventListener('keydown', onKeyDown, true);
    }, []);

    const chosenRepos = chosenRepoIDs.flatMap((id) => {
        const repo = repos.find((candidate) => candidate.id === id);
        return repo === undefined ? [] : [repo];
    });

    /*
     * §WS-078 / M4: the worktree is cut from the ONE selected repo, and the section only exists
     * when there IS exactly one.
     *
     * `NewWorkspaceSheet.swift:179-183` — "Inline worktree creation (issue #222). Requires exactly
     * one selected repo to branch from" — gates the whole section on `selectedRepos.count == 1`,
     * and `visibleFields` (`:401-407`) gates the toggle's Tab stop on the same test. The port used
     * to offer it whenever the registry was non-empty and put a "Worktree repository" `<select>`
     * inside it to disambiguate, which is a second way to say the same thing in a sheet that
     * already has a Repositories section — and it let the toggle be flipped with no repo chosen at
     * all, so `repos[0]` decided what got branched.
     */
    const repo = chosenRepos.length === 1 ? (chosenRepos[0] ?? null) : null;
    const preview = worktreePreview({
        name: worktreeName,
        branch,
        base: repo?.worktreeBase ?? ''
    });
    const worktreeOn = isWorkspace && worktree && repo !== null;
    const canSubmit = value.trim() !== '' && !busy && (!worktreeOn || preview.valid);

    /*
     * #294: a worktree off latest main for `repo` is on screen, so start its fetch now: by the
     * time Create is pressed the network is usually done, and the create reuses it. Once per repo
     * per opening (the daemon rate-limits as well); unticking and re-ticking does not ask again.
     */
    const prefetchRepoID = worktreeOn && updateMain && repo !== null ? repo.id : null;
    const prefetchedRepoIDs = useRef(new Set<string>());
    const onPrefetchRepo = props.onPrefetchRepo;
    useEffect(() => {
        if (prefetchRepoID === null || onPrefetchRepo === undefined) return;
        if (prefetchedRepoIDs.current.has(prefetchRepoID)) return;
        prefetchedRepoIDs.current.add(prefetchRepoID);
        onPrefetchRepo(prefetchRepoID);
    }, [prefetchRepoID, onPrefetchRepo]);

    /*
     * #294: the step list, the error line and Cancel are at the BOTTOM of a sheet that scrolls
     * (max 76vh), and a worktree sheet with its fields is taller than that on a small window. So
     * when a create starts, when the Escape hint appears under the steps, and again when it ends,
     * the sheet scrolls to the bottom: the running steps, the way to stop them, and then the
     * outcome are what the user is looking for.
     */
    const sheetRef = useRef<HTMLDivElement | null>(null);
    const hasError = error !== null;
    useEffect(() => {
        if (createPhase === null) return;
        const sheet = sheetRef.current;
        if (sheet !== null) sheet.scrollTop = sheet.scrollHeight;
    }, [createPhase, hasError, closeHint]);

    /** The elapsed clock ticks only while a create runs; it stops where it ended. */
    useEffect(() => {
        if (!worktreeRunning) return;
        const timer = setInterval(() => setClock(Date.now()), 200);
        return () => clearInterval(timer);
    }, [worktreeRunning]);
    /*
     * §5.5: the New Group sheet's repository row exists only for a group created HERE (a remote
     * group's registry is its own daemon's) and only when there is a registry to pick from.
     */
    const groupRepoRow = !isWorkspace && remoteDaemon === '' && (repos.length > 0 || props.onBrowseForFolder !== undefined);
    const groupRepoChoice: NewGroupRepo | null = !groupRepoRow
        ? null
        : groupRepoID === FOLDER_CHOICE && groupRepoFolder !== null
          ? { repoPath: groupRepoFolder, createWorktree: groupCreateWorktree }
          : groupRepoID !== '' && repos.some((entry) => entry.id === groupRepoID)
            ? { repoID: groupRepoID, createWorktree: groupCreateWorktree }
            : null;
    const chooseGroupFolder = (): void => {
        const browse = props.onBrowseForFolder;
        // One panel at a time: a fast double-click must not queue a second native panel.
        if (browse === undefined || browsingFolder.current) return;
        browsingFolder.current = true;
        void browse()
            .then((chosen) => {
                if (chosen === null) return;
                setGroupRepoFolder(chosen);
                setGroupRepoID(FOLDER_CHOICE);
            })
            .catch(() => {
                // A panel that failed to open is the same answer as a cancel.
            })
            .finally(() => {
                browsingFolder.current = false;
            });
    };

    const submit = async (): Promise<void> => {
        if (!canSubmit || inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        setCloseHint(false);
        // #294: a worktree create names itself (for Cancel) and reports its steps here. Frames
        // from an earlier, abandoned request id are ignored.
        let worktreeHooks: Pick<WorkspaceWorktreeRequest, 'requestID' | 'onProgress'> = {};
        if (worktreeOn && repo !== null) {
            const id = mintRequestID();
            requestID.current = id;
            const startedAt = Date.now();
            setProgress(initialWorktreeProgress(updateMain));
            setCreatePhase('running');
            setCreateStartedAt(startedAt);
            setCreateEndedAt(null);
            setClock(startedAt);
            // Create is about to be disabled under the keyboard: Cancel is the live control now.
            stops.current.get('cancel')?.focus();
            worktreeHooks = {
                requestID: id,
                onProgress: (next) => {
                    if (requestID.current === id) setProgress(next);
                }
            };
        } else {
            requestID.current = null;
            setProgress(null);
            setCreatePhase(null);
        }
        const failure = await props.onSubmit({
            name: value.trim(),
            color,
            groupID,
            profile: profile === DEFAULT_PROFILE_NAME ? null : profile,
            muted: isWorkspace && muted,
            remoteDaemon: remoteDaemon === '' ? null : remoteDaemon,
            repoPaths: chosenRepos.map((entry) => entry.path),
            ...(worktreeOn && repo !== null
                ? { worktree: { repoID: repo.id, name: worktreeName, branch, updateMain, ...worktreeHooks } }
                : {}),
            groupRepo: groupRepoChoice
        });
        inFlight.current = false;
        setBusy(false);
        if (requestID.current !== null) {
            // Success closes the sheet (the host unmounts it); these only matter when it stays.
            setCreateEndedAt(Date.now());
            setCreatePhase((phase) => (failure === null ? 'done' : phase === 'cancelling' ? 'cancelled' : 'failed'));
            requestID.current = null;
        }
        if (failure !== null) setError(failure);
    };

    /**
     * #294: Cancel while a worktree create runs STOPS it (the daemon kills git and removes what
     * the create made) instead of closing the sheet over a create that would carry on unseen.
     * The create's own reply then re-enables the form. A second press does nothing.
     */
    const onCancelPressed = (): void => {
        const running = requestID.current;
        if (worktreeRunning && running !== null && props.onCancelCreate !== undefined) {
            if (createPhase === 'cancelling') return;
            setCreatePhase('cancelling');
            props.onCancelCreate(running);
            return;
        }
        props.onCancel();
    };

    /**
     * Visible stops in reading order — the Swift's `visibleFields` (`NewWorkspaceSheet.swift:
     * 378-399`), Cancel included. A disabled Create is omitted, never landed on.
     */
    const fieldOrder = (): string[] => {
        // #294: while a worktree create runs every field is disabled; Cancel is the one stop.
        if (worktreeRunning) return ['cancel'];
        const order = ['name', 'colors'];
        if (isWorkspace) {
            if (groups.length > 0) order.push('group');
            order.push('profile', 'muted');
            if (repos.length > 0) {
                for (const entry of chosenRepos) order.push(`repo:${entry.id}`);
                order.push('add-repo');
            }
            // M4: the worktree stops are on their own gate — `selectedRepos.count == 1`, not
            // `!store.repoRegistry.isEmpty` (`NewWorkspaceSheet.swift:401-407`).
            if (repo !== null) {
                order.push('worktree-toggle');
                if (worktreeOn) order.push('worktree-name', 'worktree-branch', 'update-main');
            }
        } else if (groupRepoRow) {
            order.push('group-repo');
            if (props.onBrowseForFolder !== undefined) order.push('group-repo-browse');
            if (groupRepoChoice !== null) order.push('group-worktree');
        }
        order.push('cancel');
        if (canSubmit) order.push('submit');
        return order;
    };

    const onFormKeyDown = (event: ReactKeyboardEvent): void => {
        /*
         * M9's other half: `.keyboardShortcut(.defaultAction)` (`NewWorkspaceSheet.swift:205`) is
         * not only the button's LOOK — it is Return from anywhere in the sheet, which is why the
         * Swift's worktree-branch field also carries a bare `.onSubmit { create() }` (`:317`) and
         * the name field carries `.onSubmit(create)` (`:130`) without either being special.
         *
         * The port had only the browser's implicit form submission, which fires from a text input
         * and from nothing else: Return on the worktree checkboxes, on either picker, or on Cancel
         * did nothing at all. Handling it here unifies the two routes onto one — `preventDefault`
         * so a keypress in a text field cannot also trigger the implicit submit and run `submit()`
         * twice (the in-flight ref would refuse the second, but a guard is not a design).
         */
        if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
            return;
        }
        if (event.key !== 'Tab') return;
        const order = fieldOrder();
        const active = globalThis.document?.activeElement ?? null;
        const currentIndex = order.findIndex((id) => stops.current.get(id) === active);
        if (currentIndex < 0) return;
        event.preventDefault();
        const nextID = order[(currentIndex + (event.shiftKey ? -1 : 1) + order.length) % order.length];
        if (nextID !== undefined) stops.current.get(nextID)?.focus();
    };

    /**
     * §WS-080: focus the row that will take this one's place BEFORE the array shrinks, so the
     * Tab loop never points at a control that has just been unmounted.
     */
    const removeRepo = (id: string): void => {
        // §5.5: the user's own edit; a later Group change no longer swaps the selection.
        setRepoTouched(true);
        const index = chosenRepoIDs.indexOf(id);
        const next = chosenRepoIDs.filter((candidate) => candidate !== id);
        if (stops.current.get(`repo:${id}`) === globalThis.document?.activeElement) {
            const successor = next[index] ?? null;
            stops.current.get(successor === null ? 'add-repo' : `repo:${successor}`)?.focus();
        }
        setChosenRepoIDs(next);
    };

    /*
     * L1 / L2: the two sheets draw the SAME control at two different sizes, and the port drew
     * one size for both.
     *
     *   - the workspace sheet (`NewWorkspaceSheet.swift:86-97`) is a bare `HStack(spacing: 8)`
     *     of 24pt circles, selection marked by `Circle().strokeBorder(Color.primary, lineWidth:
     *     2)` — `strokeBorder`, so the ring is drawn INSIDE the circle's own bounds and the
     *     swatch never grows;
     *   - the group sheet (`NewGroupSheet.swift:28-60`) is an `HStack(spacing: 6)` that opens
     *     with a "Color" caption and a `Spacer()`, then a no-colour outline swatch and 16pt
     *     circles, selection marked by an 8pt bold CHECKMARK inside the swatch rather than by a
     *     ring at all.
     *
     * The port had 20px swatches at a 6px gap in both, with a 2px `outline` sitting OUTSIDE the
     * circle (so the selected swatch read a touch larger than its neighbours) and no caption on
     * the group sheet.
     */
    const swatchDiameter = isWorkspace ? 24 : 16;
    const swatchRow = (
        <div
            ref={(element) => {
                registerStop('colors', element);
            }}
            role="radiogroup"
            aria-label={isWorkspace ? 'Workspace color' : 'Group color'}
            tabIndex={0}
            data-testid={`new-${props.kind}-colors`}
            /*
             * No `outline-none` here, deliberately: this row is a TAB STOP with its own
             * arrow-key handling, and `NewWorkspaceSheet.swift:98-99` makes the Swift's
             * `.focusable().focused($focusedField, equals: .color)` — a focusable container
             * AppKit rings when the keyboard lands on it. Before §L96 the class said
             * `outline-none` and the unlayered global rule overrode it anyway; layering the rule
             * would have made the class win and left a keyboard user with no way to see they
             * were on the colour row. `:focus-visible` does not match a pointer click on a
             * `tabIndex` div, so this rings on Tab only.
             */
            className={`flex items-center rounded ${isWorkspace ? 'gap-2' : 'ml-auto gap-1.5'}`}
            onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                // The row is a focusable div, which a disabled fieldset does not reach.
                if (worktreeRunning) return;
                event.preventDefault();
                // The row is a single Tab stop with the arrows cycling inside it (§WS-077).
                const options: (WorkspaceColor | null)[] = isWorkspace
                    ? [...WORKSPACE_COLORS]
                    : [null, ...WORKSPACE_COLORS];
                const index = options.indexOf(color);
                const delta = event.key === 'ArrowRight' ? 1 : -1;
                const next = options[(index + delta + options.length) % options.length];
                setColor(next ?? null);
            }}
        >
            {isWorkspace ? null : (
                <button
                    type="button"
                    role="radio"
                    aria-checked={color === null}
                    aria-label="No color"
                    tabIndex={-1}
                    data-testid="new-group-color-none"
                    className="flex shrink-0 items-center justify-center rounded-full text-[8px] font-bold leading-none"
                    style={{
                        width: swatchDiameter,
                        height: swatchDiameter,
                        // `Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1)`.
                        border: `1px solid ${tokens.textTertiary}`,
                        // The Swift's checkmark here carries no `.foregroundStyle`, so it is the
                        // primary label colour — only the ones over a filled swatch are white.
                        color: tokens.textPrimary
                    }}
                    onClick={() => {
                        setColor(null);
                    }}
                >
                    {color === null ? '✓' : ''}
                </button>
            )}
            {WORKSPACE_COLORS.map((candidate) => (
                <button
                    key={candidate}
                    type="button"
                    role="radio"
                    aria-checked={color === candidate}
                    aria-label={candidate}
                    tabIndex={-1}
                    data-testid={`new-${props.kind}-color-${candidate}`}
                    data-selected={color === candidate ? 'true' : 'false'}
                    className="flex shrink-0 items-center justify-center rounded-full text-[8px] font-bold leading-none"
                    style={{
                        width: swatchDiameter,
                        height: swatchDiameter,
                        background: workspaceColorHex(candidate, props.bucket ?? 'dark'),
                        color: '#fff',
                        // `strokeBorder` is an INWARD stroke: the ring eats into the swatch
                        // instead of hanging off it, so a selected circle is the same 24px box
                        // as its neighbours. `outline` + `outlineOffset: 1` was neither.
                        ...(isWorkspace && color === candidate
                            ? { boxShadow: `inset 0 0 0 2px ${tokens.textPrimary}` }
                            : {})
                    }}
                    onClick={() => {
                        setColor(candidate);
                    }}
                >
                    {!isWorkspace && color === candidate ? '✓' : ''}
                </button>
            ))}
        </div>
    );

    const container = globalThis.document?.body;
    if (container === undefined || container === null) return null;

    return createPortal(
        <div
            data-testid={`new-${props.kind}-backdrop`}
            className="fixed inset-0 z-50 flex items-start justify-center"
            /*
             * The dimming is `SettingsOverlay`'s, one step lighter: a create sheet is a dialog
             * over the window rather than a window of its own, so the panes behind it stay
             * legible while still reading as unreachable.
             */
            style={{ background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(event) => {
                if (event.target !== event.currentTarget) return;
                // Innermost first, exactly as Escape resolves it.
                if (pickerOpen) {
                    setPickerOpen(false);
                    return;
                }
                // #294: the same rule as Escape: a running worktree create is not dismissed.
                if (worktreeRunning) {
                    setCloseHint(true);
                    return;
                }
                props.onCancel();
            }}
        >
            <div
                ref={sheetRef}
                data-testid={`new-${props.kind}-sheet`}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className={`mt-[12vh] max-h-[76vh] overflow-y-auto rounded-lg p-5 text-[12px] ${
                    isWorkspace ? 'w-[360px]' : 'w-[320px]'
                }`}
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                }}
            >
                {/* `Text("New Workspace").font(.headline)` — the sheet's first row. */}
                <div
                    data-testid={`new-${props.kind}-title`}
                    className="mb-3 text-[13px] font-semibold"
                    style={{ color: tokens.textPrimary }}
                >
                    {title}
                </div>

                <form
                    data-testid={`new-${props.kind}-form`}
                    /* L16: `VStack(spacing: 16)` for the workspace sheet
                       (`NewWorkspaceSheet.swift:76`) and `VStack(alignment: .leading, spacing:
                       14)` for the group one (`NewGroupSheet.swift:16`) — one 12px gap stood in
                       for both, which cost the taller sheet a quarter of its breathing room. */
                    className={`flex flex-col ${isWorkspace ? 'gap-4' : 'gap-[14px]'}`}
                    onKeyDown={onFormKeyDown}
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    {/* #294: every field is disabled while a worktree create runs; Cancel and
                        the step list below stay live. A fieldset rather than a prop on each
                        control, so a control added later cannot be forgotten. */}
                    <fieldset
                        data-testid={`new-${props.kind}-fields`}
                        disabled={worktreeRunning}
                        className={`m-0 flex min-w-0 flex-col border-0 p-0 ${isWorkspace ? 'gap-4' : 'gap-[14px]'}`}
                        style={worktreeRunning ? { opacity: 0.55 } : undefined}
                    >
                    {props.workspaceCount === undefined ? null : (
                        <div
                            data-testid="new-group-count"
                            className="text-[11px]"
                            style={{ color: tokens.textSecondary }}
                        >
                            Group {props.workspaceCount} selected workspace
                            {props.workspaceCount === 1 ? '' : 's'}.
                        </div>
                    )}

                    <input
                        ref={(element) => {
                            ref.current = element;
                            registerStop('name', element);
                        }}
                        aria-label={isWorkspace ? 'New workspace name' : 'New group name'}
                        placeholder={isWorkspace ? 'Workspace name' : 'Group name'}
                        className="w-full rounded border bg-transparent px-2 py-1.5 text-[12px] outline-none"
                        style={{
                            borderColor: tokens.divider,
                            color: tokens.textPrimary,
                            ...SELECTABLE_TEXT_STYLE
                        }}
                        value={value}
                        onChange={(event) => {
                            const next = event.target.value;
                            setValue(next);
                            if (!worktreeNameEdited) {
                                const followed = worktreeNameFromWorkspace(next);
                                setWorktreeName(followed);
                                if (!branchEdited) setBranch(followed);
                            }
                        }}
                    />

                    {/* L1: the group sheet's swatches are a LABELLED row — `Text("Color")` at
                        11pt secondary, then a `Spacer()`, then the swatches
                        (`NewGroupSheet.swift:28-32`). The workspace sheet has no caption. */}
                    {isWorkspace ? (
                        swatchRow
                    ) : (
                        <div className="flex items-center gap-1.5">
                            <span className="shrink-0 text-[11px]" style={{ color: tokens.textSecondary }}>
                                Color
                            </span>
                            {swatchRow}
                        </div>
                    )}

                    {isWorkspace && groups.length > 0 ? (
                        <label className="flex items-center gap-2">
                            <span className="shrink-0 text-[11px]" style={{ color: tokens.textSecondary }}>
                                Group
                            </span>
                            <select
                                ref={(element) => {
                                    registerStop('group', element);
                                }}
                                aria-label="Group"
                                data-testid="new-workspace-group"
                                /* L21: `HStack { Text; Spacer(); Picker.labelsHidden()
                                   .pickerStyle(.menu) }` (`NewWorkspaceSheet.swift:104-122`) —
                                   the picker is CONTENT-sized and pushed to the trailing edge by
                                   the `Spacer()`, not stretched across the row. `ml-auto` is that
                                   spacer; dropping `flex-1` restores `flex-basis: auto`, and
                                   `min-w-0` keeps it able to shrink on a long profile name. */
                                className="ml-auto min-w-0 rounded border bg-transparent px-1 py-[3px] text-[11px]"
                                style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                value={groupID ?? ''}
                                onChange={(event) => {
                                    setGroupID(event.target.value === '' ? null : event.target.value);
                                }}
                            >
                                <option value="" style={{ color: '#000' }}>
                                    No group
                                </option>
                                {groups.map((group) => (
                                    <option key={group.id} value={group.id} style={{ color: '#000' }}>
                                        {group.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}

                    {isWorkspace ? (
                        <label className="flex items-center gap-2">
                            <span className="shrink-0 text-[11px]" style={{ color: tokens.textSecondary }}>
                                Profile
                            </span>
                            <select
                                ref={(element) => {
                                    registerStop('profile', element);
                                }}
                                aria-label="Profile"
                                data-testid="new-workspace-profile"
                                /* L21: content-sized, trailing — see the Group picker above. */
                                className="ml-auto min-w-0 rounded border bg-transparent px-1 py-[3px] text-[11px]"
                                style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                value={profile}
                                onChange={(event) => {
                                    setProfile(event.target.value);
                                }}
                            >
                                {/* The built-in baseline leads, then the config's own (§SET-214). */}
                                {[
                                    DEFAULT_PROFILE_NAME,
                                    ...profiles.filter((name) => name !== DEFAULT_PROFILE_NAME)
                                ].map((name) => (
                                    <option key={name} value={name} style={{ color: '#000' }}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}

                    {/* Agent-lifecycle §7.6: a conductor's children can start silent. */}
                    {isWorkspace ? (
                        <label
                            className="flex cursor-pointer items-center gap-1.5 text-[11px]"
                            style={{ color: tokens.textSecondary }}
                        >
                            <input
                                ref={(element) => {
                                    registerStop('muted', element);
                                }}
                                type="checkbox"
                                data-testid="new-workspace-muted"
                                checked={muted}
                                onChange={(event) => {
                                    setMuted(event.target.checked);
                                }}
                            />
                            Mute Notifications
                        </label>
                    ) : null}

                    {!isWorkspace && (props.remoteDaemons?.length ?? 0) > 0 ? (
                        <label className="flex items-center gap-2">
                            <span className="shrink-0 text-[11px]" style={{ color: tokens.textSecondary }}>
                                Runs on
                            </span>
                            {/* §1.7: a group may live on another daemon entirely — the group is
                                created THERE (over that daemon's own connection) and its
                                workspaces render under its sidebar section. */}
                            <select
                                aria-label="Runs on"
                                data-testid="new-group-runs-on"
                                className="ml-auto min-w-0 rounded border bg-transparent px-1 py-[3px] text-[11px]"
                                style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                value={remoteDaemon}
                                onChange={(event) => {
                                    setRemoteDaemon(event.target.value);
                                }}
                            >
                                <option value="" style={{ color: '#000' }}>
                                    This Mac
                                </option>
                                {(props.remoteDaemons ?? []).map((name) => (
                                    <option key={name} value={name} style={{ color: '#000' }}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}

                    {/*
                     * app-state-core.md §5.5: the New Group sheet's optional repository. New
                     * workspaces in the group start with it (the workspace sheet prefills it),
                     * and the switch below makes them create a worktree off the latest main.
                     * The switch only appears once a repository is chosen: it acts on that
                     * repository, and the daemon refuses it without one.
                     */}
                    {groupRepoRow ? (
                        // A div, not a label: a label would forward a click on Choose Folder… to
                        // the select as well.
                        <div className="flex items-center gap-2">
                            <span className="shrink-0 text-[11px]" style={{ color: tokens.textSecondary }}>
                                Repository
                            </span>
                            <select
                                ref={(element) => {
                                    registerStop('group-repo', element);
                                }}
                                aria-label="Repository"
                                data-testid="new-group-repo"
                                className="ml-auto min-w-0 rounded border bg-transparent px-1 py-[3px] text-[11px]"
                                style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                value={groupRepoID}
                                onChange={(event) => {
                                    setGroupRepoID(event.target.value);
                                }}
                            >
                                <option value="" style={{ color: '#000' }}>
                                    None
                                </option>
                                {repos.map((entry) => (
                                    <option key={entry.id} value={entry.id} style={{ color: '#000' }}>
                                        {entry.name}
                                    </option>
                                ))}
                                {groupRepoFolder === null ? null : (
                                    <option value={FOLDER_CHOICE} style={{ color: '#000' }}>
                                        {folderName(groupRepoFolder)}
                                    </option>
                                )}
                            </select>
                            {/*
                              * Desktop app only (#283's native panel), like the group menu's
                              * Choose Folder…: the folder is registered and resolved by the daemon
                              * when the group is created (`group-set-repo`).
                              */}
                            {props.onBrowseForFolder === undefined ? null : (
                                <button
                                    ref={(element) => {
                                        registerStop('group-repo-browse', element);
                                    }}
                                    type="button"
                                    data-testid="new-group-repo-browse"
                                    className="shrink-0 text-[11px]"
                                    style={{ color: tokens.accent }}
                                    onClick={chooseGroupFolder}
                                >
                                    Choose Folder…
                                </button>
                            )}
                        </div>
                    ) : null}
                    {groupRepoChoice !== null ? (
                        <label
                            className="flex cursor-pointer items-center gap-1.5 text-[11px]"
                            style={{ color: tokens.textSecondary }}
                        >
                            <input
                                ref={(element) => {
                                    registerStop('group-worktree', element);
                                }}
                                type="checkbox"
                                data-testid="new-group-create-worktree"
                                checked={groupCreateWorktree}
                                onChange={(event) => {
                                    setGroupCreateWorktree(event.target.checked);
                                }}
                            />
                            New workspaces create a worktree from latest main
                        </label>
                    ) : null}

                    {/*
                     * §WS-075's Repositories section. The Swift gates the WHOLE section on
                     * `!store.repoRegistry.isEmpty` (`NewWorkspaceSheet.swift:142`), and the
                     * port copied the gate — so on the state every user is in before they have
                     * ever opened Settings ▸ Repositories (a fresh install; the audit's own
                     * fresh boot), the New Workspace sheet renders name, colour, profile and
                     * nothing else. That is the user's report: there is no "add repo" in the
                     * create sheet, and no reason given for its absence.
                     *
                     * The divergence, stated: an empty registry gets the heading and one line
                     * saying where repositories come from, where the Swift shows a gap. It is
                     * NOT a focusable stop — `fieldOrder()` below is unchanged, so the Tab loop
                     * is byte-identical to the Swift's `visibleFields` in both states, and a
                     * picker that could only ever offer an empty list is not put in the user's
                     * path. (The Swift's own picker has no browse and no scan either —
                     * `RepoPickerView.swift:74-84` sends you to Settings in the same words.)
                     */}
                    {isWorkspace && repos.length === 0 ? (
                        <div className="flex flex-col gap-1" data-testid="new-workspace-repos-empty">
                            <span className="text-[11px]" style={{ color: tokens.textSecondary }}>
                                Repositories
                            </span>
                            <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                                No repositories registered yet - add one in Settings ▸ Repositories, and it
                                will be offered here.
                            </span>
                        </div>
                    ) : null}

                    {isWorkspace && repos.length > 0 ? (
                        <div className="flex flex-col gap-1" data-testid="new-workspace-repos">
                            <span className="text-[11px]" style={{ color: tokens.textSecondary }}>
                                Repositories
                            </span>
                            {chosenRepos.map((entry) => (
                                <div key={entry.id} className="flex items-center gap-1.5 text-[11px]">
                                    <ChromeIcon name="folder" size={10} />
                                    <span
                                        className="min-w-0 flex-1 truncate"
                                        style={{ color: tokens.textSecondary }}
                                    >
                                        {entry.name}
                                    </span>
                                    <button
                                        ref={(element) => {
                                            registerStop(`repo:${entry.id}`, element);
                                        }}
                                        type="button"
                                        aria-label={`Remove ${entry.name}`}
                                        data-testid={`new-workspace-repo-remove-${entry.id}`}
                                        style={{ color: tokens.textTertiary }}
                                        onClick={() => {
                                            removeRepo(entry.id);
                                        }}
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                            <button
                                ref={(element) => {
                                    registerStop('add-repo', element);
                                }}
                                type="button"
                                data-testid="new-workspace-add-repo"
                                className="self-start text-[11px]"
                                style={{ color: tokens.accent }}
                                onClick={() => {
                                    setPickerOpen(true);
                                }}
                            >
                                + Add Repository
                            </button>
                        </div>
                    ) : null}

                    {/* M4: revealed by the ONE chosen repo, not by a non-empty registry. */}
                    {isWorkspace && repo !== null ? (
                        <label
                            className="flex cursor-pointer items-center gap-1.5 text-[11px]"
                            style={{ color: tokens.textSecondary }}
                        >
                            <input
                                ref={(element) => {
                                    registerStop('worktree-toggle', element);
                                }}
                                type="checkbox"
                                data-testid="new-workspace-worktree-toggle"
                                checked={worktree}
                                onChange={(event) => {
                                    setWorktreeTouched(true);
                                    setWorktree(event.target.checked);
                                }}
                            />
                            Create git worktree
                        </label>
                    ) : null}

                    {worktreeOn && repo !== null ? (
                        <div className="flex flex-col gap-1.5 pl-4" data-testid="new-workspace-worktree">
                            {/*
                              * L17: each field is `VStack(alignment: .leading, spacing: 4) {
                              * Text("Worktree name").font(.caption).foregroundStyle(.secondary);
                              * TextField("", …) }` (`NewWorkspaceSheet.swift:293-319`) — a caption
                              * ABOVE the field and an EMPTY placeholder inside it. The port put
                              * the two names in the placeholders, so the moment the user typed
                              * (or the branch mirrored the name) the sheet stopped saying which
                              * field was which. `.caption` is 10pt.
                              */}
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px]" style={{ color: tokens.textSecondary }}>
                                    Worktree name
                                </span>
                                <input
                                    ref={(element) => {
                                        registerStop('worktree-name', element);
                                    }}
                                    aria-label="Worktree name"
                                    data-testid="new-workspace-worktree-name"
                                    className="w-full rounded border bg-transparent px-2 py-1 text-[11px] outline-none"
                                    style={{
                                        borderColor: tokens.divider,
                                        color: tokens.textPrimary,
                                        ...SELECTABLE_TEXT_STYLE
                                    }}
                                    value={worktreeName}
                                    onChange={(event) => {
                                        const next = event.target.value;
                                        setWorktreeName(next);
                                        setWorktreeNameEdited(next !== '' && next !== worktreeNameFromWorkspace(value));
                                        if (!branchEdited) setBranch(next);
                                    }}
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px]" style={{ color: tokens.textSecondary }}>
                                    Branch name
                                </span>
                                <input
                                    ref={(element) => {
                                        registerStop('worktree-branch', element);
                                    }}
                                    aria-label="Branch name"
                                    data-testid="new-workspace-worktree-branch"
                                    className="w-full rounded border bg-transparent px-2 py-1 text-[11px] outline-none"
                                    style={{
                                        borderColor: tokens.divider,
                                        color: tokens.textPrimary,
                                        ...SELECTABLE_TEXT_STYLE
                                    }}
                                    value={branch}
                                    onChange={(event) => {
                                        setBranch(event.target.value);
                                        setBranchEdited(event.target.value !== worktreeName);
                                    }}
                                />
                            </label>
                            <label
                                className="flex cursor-pointer items-center gap-1.5 text-[11px]"
                                style={{ color: tokens.textSecondary }}
                            >
                                <input
                                    ref={(element) => {
                                        registerStop('update-main', element);
                                    }}
                                    type="checkbox"
                                    data-testid="new-workspace-worktree-update-main"
                                    checked={updateMain}
                                    onChange={(event) => {
                                        setWorktreeTouched(true);
                                        setUpdateMain(event.target.checked);
                                    }}
                                />
                                Update main first (fetch + branch off origin)
                            </label>
                            <div
                                data-testid="new-workspace-worktree-preview"
                                className="text-[10px]"
                                style={{ color: tokens.textTertiary }}
                            >
                                <div className="truncate">{preview.path}</div>
                                <div>{preview.branchLine}</div>
                            </div>
                        </div>
                    ) : null}

                    </fieldset>

                    {progress === null || createPhase === null ? null : (
                        <WorktreeCreateProgressPanel
                            progress={progress}
                            phase={createPhase}
                            elapsedMs={(createEndedAt ?? clock) - createStartedAt}
                            closeHint={closeHint}
                        />
                    )}

                    {error === null ? null : (
                        <div data-testid="new-workspace-error" className="text-[11px]" style={{ color: '#E0655C' }}>
                            {createPhase === 'cancelled' ? 'Create cancelled: nothing it made was kept.' : error}
                        </div>
                    )}

                    {/* `HStack { Cancel; Spacer(); Create }` — the sheet's last row. */}
                    <div className="mt-1 flex items-center">
                        <button
                            ref={(element) => {
                                registerStop('cancel', element);
                            }}
                            type="button"
                            data-testid={`new-${props.kind}-cancel`}
                            /* SPACING-REVIEW S10: `px-2.5` — the 10 px gutter the default action
                               beside it already carries, so the sheet's two answers are one
                               control drawn twice. S1's keystone woke both class lists (both had
                               measured `padding: 0px`, and Cancel had no border at all); this is
                               the side inset the row's `padding: '4px 10px'` asks for and `px-2`
                               was 2 px short of. */
                            className="rounded border px-2.5 py-1 text-[12px]"
                            style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                            disabled={createPhase === 'cancelling'}
                            onClick={onCancelPressed}
                        >
                            {createPhase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
                        </button>
                        {/*
                          * M9: the DEFAULT ACTION button. `.keyboardShortcut(.defaultAction)`
                          * makes AppKit draw a filled accent push button — the one control in the
                          * sheet that is visually louder than the rest — where the port drew an
                          * outline indistinguishable in weight from Cancel beside it. Disabled it
                          * stays a filled push button, greyed, rather than becoming an outline:
                          * a default button that changes SHAPE when it is unavailable reads as a
                          * different control.
                          */}
                        <button
                            ref={(element) => {
                                registerStop('submit', element);
                            }}
                            type="submit"
                            data-testid={`new-${props.kind}-submit`}
                            data-default-action="true"
                            disabled={!canSubmit}
                            className="ml-auto rounded border px-2.5 py-1 text-[12px] font-medium"
                            style={{
                                background: canSubmit ? tokens.accent : withAlpha(tokens.textPrimary, 0.08),
                                borderColor: canSubmit ? tokens.accent : 'transparent',
                                color: canSubmit ? '#fff' : tokens.textTertiary
                            }}
                        >
                            {busy ? 'Creating…' : 'Create'}
                        </button>
                    </div>
                </form>
            </div>

            {/*
             * The repo picker is the Swift's SUB-SHEET — `.sheet(isPresented:)` hung off the
             * New Workspace sheet itself (`NewWorkspaceSheet.swift:227-239`), which AppKit
             * presents over its presenter, dimming it, at the presenter's own top edge.
             *
             * So it gets its own layer rather than being a loose `fixed` panel at `top-1/4` of
             * the VIEWPORT: that placement was measured against the window, not the sheet, so
             * the picker landed across the middle of the panel — slicing the colour swatch row
             * in half — in the same surface colour as the sheet with nothing between them, and
             * the two panels read as one blob. The layer restores the two things a sub-sheet
             * owes: the parent is dimmed (so which panel is live is never a question), and the
             * child sits at the parent's top edge and at the parent's width.
             *
             * `z-[60]` is on the LAYER now, inside the backdrop's own stacking context — the
             * picker paints above the sheet because its ancestor does, not because a sibling's
             * z-index happens to win. The layer is also the picker's outside-click target, and
             * it closes the picker ONLY (the innermost-first contract, the same resolution
             * Escape and the backdrop take); `stopPropagation` keeps that click off the
             * backdrop's own cancel path.
             */}
            {pickerOpen ? (
                <div
                    data-testid="new-workspace-repo-picker-layer"
                    className="fixed inset-0 z-[60] flex items-start justify-center"
                    style={{ background: 'rgba(0,0,0,0.35)' }}
                    onMouseDown={(event) => {
                        event.stopPropagation();
                        if (event.target !== event.currentTarget) return;
                        setPickerOpen(false);
                    }}
                >
                    <div
                        data-testid="new-workspace-repo-picker"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Add repositories"
                        /* The sheet's own `mt-[12vh]` and `w-[360px]`: the sub-sheet lands on
                           the panel it was raised from rather than beside it. */
                        className="mt-[12vh] max-h-[76vh] w-[360px] overflow-y-auto rounded-lg p-4 text-[12px]"
                        style={{
                            background: tokens.surfaceBackground,
                            border: `1px solid ${tokens.divider}`,
                            color: tokens.textPrimary,
                            boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                        }}
                    >
                        {/* M50: the headline is `RepoPicker`'s own now
                            (`RepoPickerView.swift:62-63`), so all three hosts say one thing. */}
                        <RepoPicker
                            repos={repos}
                            mode="multiple"
                            disabledRepoIDs={new Set(chosenRepoIDs)}
                            onConfirm={(picked) => {
                                setChosenRepoIDs([...chosenRepoIDs, ...picked.map((entry) => entry.id)]);
                                if (picked.length > 0) setRepoTouched(true);
                                setPickerOpen(false);
                            }}
                            onCancel={() => {
                                setPickerOpen(false);
                            }}
                        />
                    </div>
                </div>
            ) : null}
        </div>,
        container
    );
}
