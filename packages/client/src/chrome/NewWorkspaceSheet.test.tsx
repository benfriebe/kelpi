/**
 * The New Workspace / New Group sheet's PRESENTATION — `ContentView.swift:289-294`.
 *
 * The shipped app hangs this form off the window with `.sheet(isPresented:)`; the port used to
 * expand it inline in the sidebar footer. This file is the difference: it asserts the surface
 * (portalled out of the sidebar, centred over the window, on a dimmed backdrop, above every
 * chrome layer), the two dismissals a modal owes the user (Escape and the backdrop) and the fact
 * that neither of them creates anything, that the sheet resolves innermost-first when its own
 * repo picker is up, that the footer bar it was raised from is still there underneath, and that a
 * second Create in the same tick cannot race the first.
 *
 * The FIELDS are `Sidebar.create.test.tsx`. Both drive the sheet through `Sidebar`, because every
 * route to it does.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromePane, ChromeRepo, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const G1 = 'cccccccc-0000-4000-8000-000000000001';

function pane(id: string): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/src/app',
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function workspace(id: string, name: string): ChromeWorkspace {
    return { id, name, color: 'blue', icon: null, labels: [], panes: [pane(`${id}-p1`)] };
}

/** alpha (top level) · squad[beta] — the group is what §WS-076's preselection is measured on. */
function entries(): ChromeSidebarEntry[] {
    return [
        { kind: 'workspace', workspace: workspace(W1, 'alpha') },
        {
            kind: 'group',
            group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
            workspaces: [workspace(W2, 'beta')]
        }
    ];
}

const REPOS: ChromeRepo[] = [
    { id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/wt/app' },
    { id: 'r2', name: 'infra', path: '/src/infra', worktreeBase: '/wt/infra' }
];

function base() {
    return { activeWorkspaceID: W1, filter: '', onFilterChange: vi.fn(), rowHeight: 20 };
}

function renderSidebar(props: Record<string, unknown> = {}) {
    const onCreateWorkspace = vi.fn().mockResolvedValue(null);
    render(
        <Sidebar
            {...base()}
            entries={entries()}
            profiles={['work']}
            onCreateWorkspace={onCreateWorkspace as never}
            {...props}
        />
    );
    return onCreateWorkspace;
}

function openSheet(props: Record<string, unknown> = {}) {
    const onCreateWorkspace = renderSidebar(props);
    fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
    return onCreateWorkspace;
}

describe('the sheet is a modal over the window (§WS-075, `ContentView.swift:289-294`)', () => {
    it('is portalled OUT of the sidebar, onto the document body', () => {
        openSheet();
        const sheet = screen.getByTestId('new-workspace-sheet');
        const sidebar = screen.getByTestId('sidebar');
        // The whole point of the move: it is no longer inside the panel it was raised from, so
        // its size is not the sidebar's problem and its centre is the window's centre.
        expect(sidebar.contains(sheet)).toBe(false);
        expect(document.body.contains(sheet)).toBe(true);
    });

    it('is a labelled modal dialog titled "New Workspace"', () => {
        openSheet();
        const sheet = screen.getByTestId('new-workspace-sheet');
        expect(sheet.getAttribute('role')).toBe('dialog');
        expect(sheet.getAttribute('aria-modal')).toBe('true');
        expect(sheet.getAttribute('aria-label')).toBe('New Workspace');
        // `Text("New Workspace").font(.headline)` is the sheet's first row.
        expect(screen.getByTestId('new-workspace-title').textContent).toBe('New Workspace');
    });

    it('centres itself over the window on a backdrop that dims what is behind it', () => {
        openSheet();
        const backdrop = screen.getByTestId('new-workspace-backdrop');
        // Covers the window…
        expect(backdrop.className).toContain('fixed');
        expect(backdrop.className).toContain('inset-0');
        // …centres the panel horizontally…
        expect(backdrop.className).toContain('justify-center');
        // …dims (the pattern `SettingsOverlay` and `QuitConfirmDialog` already use)…
        expect(backdrop.style.background).toBe('rgba(0, 0, 0, 0.45)');
        // …and sits above every chrome layer, the sidebar's own z-10 ghost layer included.
        expect(backdrop.className).toContain('z-50');
    });

    it('leaves the footer bar it was raised from standing underneath', () => {
        openSheet();
        // It used to REPLACE the bar, so the ⌘N hint and the chevron vanished while the form was
        // up. A sheet is over the window; the window is unchanged.
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
        expect(screen.getByTestId('sidebar-new-workspace')).toBeTruthy();
        expect(screen.getByTestId('sidebar-new-menu-toggle')).toBeTruthy();
        expect(screen.getByTestId('sidebar-new-workspace-hint').textContent).toBe('⌘N');
    });

    it('opens with the caret in the name field', () => {
        openSheet();
        expect(document.activeElement).toBe(screen.getByLabelText('New workspace name'));
    });

    it('tells assembly it is open, and that it has closed', () => {
        // Assembly folds this into `modalOpen`: the key dispatcher stops handing chords to panes
        // behind the sheet, and the Electron shell parks a web pane's native view.
        const onCreateSheetOpenChange = vi.fn();
        openSheet({ onCreateSheetOpenChange });
        expect(onCreateSheetOpenChange).toHaveBeenLastCalledWith(true);
        fireEvent.click(screen.getByTestId('new-workspace-cancel'));
        expect(onCreateSheetOpenChange).toHaveBeenLastCalledWith(false);
    });
});

describe('the two dismissals a modal owes the user (§WS-075)', () => {
    it('Escape cancels, and creates nothing', () => {
        const onCreateWorkspace = openSheet();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('new-workspace-sheet')).toBeNull();
        expect(onCreateWorkspace).not.toHaveBeenCalled();
    });

    it('a click on the backdrop cancels, and creates nothing', () => {
        const onCreateWorkspace = openSheet();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.mouseDown(screen.getByTestId('new-workspace-backdrop'));
        expect(screen.queryByTestId('new-workspace-sheet')).toBeNull();
        expect(onCreateWorkspace).not.toHaveBeenCalled();
    });

    it('a click INSIDE the panel does not', () => {
        openSheet();
        // The backdrop's handler fires for every bubbling mousedown; only the one that lands on
        // the backdrop itself is a dismissal.
        fireEvent.mouseDown(screen.getByTestId('new-workspace-sheet'));
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
    });

    it('the Cancel button cancels, and creates nothing', () => {
        const onCreateWorkspace = openSheet();
        fireEvent.click(screen.getByTestId('new-workspace-cancel'));
        expect(screen.queryByTestId('new-workspace-sheet')).toBeNull();
        expect(onCreateWorkspace).not.toHaveBeenCalled();
    });

    it('resolves innermost-first: with the repo picker up, Escape closes only the picker', () => {
        openSheet({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        expect(screen.getByTestId('new-workspace-repo-picker')).toBeTruthy();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('new-workspace-repo-picker')).toBeNull();
        // …and the sheet is still standing, with everything typed into it intact.
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('new-workspace-sheet')).toBeNull();
    });

    it('…and so does a backdrop click', () => {
        openSheet({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        fireEvent.mouseDown(screen.getByTestId('new-workspace-backdrop'));
        expect(screen.queryByTestId('new-workspace-repo-picker')).toBeNull();
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
    });
});

/**
 * "Where's the add repo functionality in the workspace create?" — the user's first report, and
 * the two halves of the answer.
 *
 * With an empty registry the whole Repositories section was gated away, so a fresh install's
 * create sheet showed name, colour, profile and nothing else, with no reason given. With a
 * non-empty registry the button existed and its picker rendered — but as a loose `fixed` panel
 * at a quarter of the VIEWPORT's height, measured against the window rather than the sheet, in
 * the sheet's own surface colour with nothing between them.
 *
 * jsdom has no paint and no layout, so what is asserted here is the STACKING RELATIONSHIP the
 * paint follows from — whose descendant the picker is, which layer carries the z-index, and DOM
 * order inside the backdrop, which decides the winner at equal z. The pixels are the audit's
 * `workspace-create-full` step, which clicks a repo row for real.
 */
describe('the repo picker is a sub-sheet OVER the sheet (§WS-075, `NewWorkspaceSheet.swift:227-239`)', () => {
    const openPicker = (): { sheet: HTMLElement; layer: HTMLElement; picker: HTMLElement } => {
        openSheet({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        return {
            sheet: screen.getByTestId('new-workspace-sheet'),
            layer: screen.getByTestId('new-workspace-repo-picker-layer'),
            picker: screen.getByTestId('new-workspace-repo-picker')
        };
    };

    it('paints ABOVE the sheet: its own layer, above the backdrop’s z, later in the DOM', () => {
        const { sheet, layer, picker } = openPicker();
        const backdrop = screen.getByTestId('new-workspace-backdrop');

        // It is NOT inside the sheet — a descendant of a scrolling `overflow-y-auto` panel
        // could not paint outside it however high its z-index went.
        expect(sheet.contains(picker)).toBe(false);
        expect(layer.contains(picker)).toBe(true);
        expect(backdrop.contains(layer)).toBe(true);

        // The z-index rides on the LAYER, inside the backdrop's own stacking context, and is
        // above it. Read as numbers, so a class rename cannot quietly invert the comparison.
        const zOf = (element: HTMLElement): number =>
            Number(/(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/.exec(element.className)?.[1] ?? NaN);
        expect(zOf(backdrop)).toBe(50);
        expect(zOf(layer)).toBe(60);
        expect(zOf(layer)).toBeGreaterThan(zOf(backdrop));

        // …and it is the later sibling, so it wins the paint order even at equal z.
        expect(sheet.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // The layer dims the sheet behind it, which is the other half of "which panel is live".
        expect(layer.style.background).toBe('rgba(0, 0, 0, 0.35)');
        // And the panel lands ON the sheet — same top offset, same width, not beside it.
        expect(picker.className).toContain('mt-[12vh]');
        expect(picker.className).toContain('w-[360px]');
        expect(sheet.className).toContain('mt-[12vh]');
        expect(sheet.className).toContain('w-[360px]');
        expect(picker.getAttribute('aria-modal')).toBe('true');
    });

    it('is interactable over the sheet: a repo picked there becomes a removable row here', () => {
        const { picker } = openPicker();
        fireEvent.click(within(picker).getByTestId('repo-choice-r1'));
        fireEvent.click(within(picker).getByTestId('repo-picker-choose'));

        expect(screen.queryByTestId('new-workspace-repo-picker')).toBeNull();
        const remove = screen.getByTestId('new-workspace-repo-remove-r1');
        expect(remove.getAttribute('aria-label')).toBe('Remove app');
        // …and the row is removable, which is what makes it a chosen row rather than a label.
        fireEvent.click(remove);
        expect(screen.queryByTestId('new-workspace-repo-remove-r1')).toBeNull();
    });

    it('the layer is the picker’s outside-click target, and closes ONLY the picker', () => {
        const { layer } = openPicker();
        fireEvent.mouseDown(layer);
        expect(screen.queryByTestId('new-workspace-repo-picker')).toBeNull();
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
    });

    it('a click INSIDE the picker panel dismisses nothing', () => {
        const { picker } = openPicker();
        fireEvent.mouseDown(picker);
        expect(screen.getByTestId('new-workspace-repo-picker')).toBeTruthy();
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
    });

    it('an EMPTY registry says where repositories come from, instead of showing a gap', () => {
        openSheet({ repos: [] });
        // The Swift renders the section not at all (`NewWorkspaceSheet.swift:142`); the gap is
        // what the user read as "the add-repo functionality is missing".
        const empty = screen.getByTestId('new-workspace-repos-empty');
        expect(empty.textContent).toContain('Repositories');
        expect(empty.textContent).toContain('Settings');

        // No picker that could only ever offer an empty list, and no dead button…
        expect(screen.queryByTestId('new-workspace-add-repo')).toBeNull();
        expect(screen.queryByTestId('new-workspace-repos')).toBeNull();
        // …and nothing focusable in it, so `visibleFields` — and therefore the Tab loop — is
        // byte-identical to the Swift's in both registry states.
        expect(empty.querySelectorAll('button, input, select, [tabindex]').length).toBe(0);
    });

    it('and a registry with repos in it offers the button rather than the explanation', () => {
        openSheet({ repos: REPOS });
        expect(screen.getByTestId('new-workspace-add-repo')).toBeTruthy();
        expect(screen.queryByTestId('new-workspace-repos-empty')).toBeNull();
    });
});

describe('the colour row is a radio group, not ten tab stops (§WS-077, #64)', () => {
    it('moves the selection with ←/→ and wraps in both directions', () => {
        openSheet();
        const row = screen.getByTestId('new-workspace-colors');
        const selected = (): string | null =>
            within(row)
                .getAllByRole('radio')
                .find((button) => button.getAttribute('aria-checked') === 'true')
                ?.getAttribute('aria-label') ?? null;

        const start = selected();
        expect(start).not.toBeNull();
        fireEvent.keyDown(row, { key: 'ArrowRight' });
        expect(selected()).not.toBe(start);
        fireEvent.keyDown(row, { key: 'ArrowLeft' });
        expect(selected()).toBe(start);

        // Ten swatches, one stop: every swatch is `tabIndex=-1` and the ROW carries the 0.
        const swatches = within(row).getAllByRole('radio');
        expect(swatches).toHaveLength(10);
        expect(swatches.every((swatch) => swatch.getAttribute('tabindex') === '-1')).toBe(true);
        expect(row.getAttribute('tabindex')).toBe('0');
        expect(row.getAttribute('role')).toBe('radiogroup');
    });
});

describe('the group the sheet opens on (§WS-076, `pendingSheetGroupID`)', () => {
    it('preselects the group whose context menu raised it', () => {
        // `WorkspaceListView.swift:1184` → `showNewWorkspaceSheet(groupID:)`: the row's own "New
        // Workspace" scopes the sheet to that group, which the picker must open on.
        renderSidebar();
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.click(within(screen.getByTestId('context-menu')).getByText('New Workspace'));
        expect((screen.getByTestId('new-workspace-group') as HTMLSelectElement).value).toBe(G1);
    });

    it('and an explicit scope beats the inherited one', () => {
        // §SET-011's inheritance is the FALLBACK (`NewWorkspaceSheet.swift:65-71`): a sheet opened
        // from a group is about that group, whatever the active workspace's group is.
        renderSidebar({ inheritGroupID: null });
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.click(within(screen.getByTestId('context-menu')).getByText('New Workspace'));
        expect((screen.getByTestId('new-workspace-group') as HTMLSelectElement).value).toBe(G1);
    });

    it('falls back to the inherited group when nothing scoped it', () => {
        openSheet({ inheritGroupID: G1 });
        expect((screen.getByTestId('new-workspace-group') as HTMLSelectElement).value).toBe(G1);
    });

    it('and to "No group" when neither applies', () => {
        openSheet();
        expect((screen.getByTestId('new-workspace-group') as HTMLSelectElement).value).toBe('');
    });
});

describe('the worktree section (§WS-078)', () => {
    it('is not offered at all when the registry is empty', () => {
        openSheet();
        expect(screen.queryByTestId('new-workspace-worktree-toggle')).toBeNull();
        expect(screen.queryByTestId('new-workspace-worktree')).toBeNull();
    });

    it('reveals its fields only once the toggle is on', () => {
        openSheet({ repos: REPOS });
        expect(screen.getByTestId('new-workspace-worktree-toggle')).toBeTruthy();
        expect(screen.queryByTestId('new-workspace-worktree')).toBeNull();

        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        expect(screen.getByTestId('new-workspace-worktree')).toBeTruthy();
        expect(screen.getByTestId('new-workspace-worktree-name')).toBeTruthy();
        expect(screen.getByTestId('new-workspace-worktree-branch')).toBeTruthy();
        expect(screen.getByTestId('new-workspace-worktree-update-main')).toBeTruthy();
    });

    it('cuts the worktree from the ONE repo the Repositories section named', () => {
        openSheet({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        const picker = screen.getByTestId('new-workspace-repo-picker');
        fireEvent.click(within(picker).getByTestId('repo-choice-r2'));
        fireEvent.click(within(picker).getByTestId('repo-picker-choose'));
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        fireEvent.change(screen.getByTestId('new-workspace-worktree-name'), { target: { value: 'wt' } });

        // Exactly one chosen repo → no repo picker inside the section, and the preview is cut
        // from that repo's own worktree base.
        expect(screen.queryByTestId('new-workspace-worktree-repo')).toBeNull();
        expect(screen.getByTestId('new-workspace-worktree-preview').textContent).toContain('/wt/infra/wt');
    });

    it('mirrors the name into the branch until the branch is hand-edited', () => {
        openSheet({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        const name = screen.getByTestId('new-workspace-worktree-name');
        const branch = screen.getByTestId('new-workspace-worktree-branch') as HTMLInputElement;

        fireEvent.change(name, { target: { value: 'login' } });
        expect(branch.value).toBe('login');

        fireEvent.change(branch, { target: { value: 'feature/login' } });
        fireEvent.change(name, { target: { value: 'something-else' } });
        // The mirroring is off for good — the user has said what the branch is.
        expect(branch.value).toBe('feature/login');
    });
});

describe('the in-flight guard (§WS-079)', () => {
    it('refuses a second Create dispatched in the SAME tick as the first', async () => {
        // `busy` is state: two submits in one tick would both read `false`. The guard is a ref,
        // closed in the same tick the first submit opens it (`NewWorkspaceSheet.swift:255-256`).
        let settle: ((value: string | null) => void) | null = null;
        const onCreateWorkspace = vi.fn().mockImplementation(
            () =>
                new Promise<string | null>((resolve) => {
                    settle = resolve;
                })
        );
        openSheet({ repos: REPOS, onCreateWorkspace });
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        fireEvent.change(screen.getByTestId('new-workspace-worktree-name'), { target: { value: 'wt' } });

        const form = screen.getByTestId('new-workspace-form');
        fireEvent.submit(form);
        fireEvent.submit(form);
        fireEvent.submit(form);
        expect(onCreateWorkspace).toHaveBeenCalledTimes(1);

        // …and the sheet stays open with the daemon's message when the create fails.
        await waitFor(() => {
            expect(settle).not.toBeNull();
        });
        (settle as unknown as (value: string | null) => void)("fatal: 'wt' already exists");
        await waitFor(() => {
            expect(screen.getByTestId('new-workspace-error').textContent).toContain('already exists');
        });
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
    });
});

describe('the New Group sheet is the same surface (§WS-082)', () => {
    it('is a modal titled "New Group", with its own backdrop and Escape', () => {
        render(<Sidebar {...base()} entries={entries()} onCreateGroup={vi.fn()} />);
        fireEvent.click(screen.getByTestId('sidebar-new-menu-toggle'));
        fireEvent.click(screen.getByRole('menuitem', { name: /^New Group/ }));

        const sheet = screen.getByTestId('new-group-sheet');
        expect(sheet.getAttribute('aria-label')).toBe('New Group');
        expect(screen.getByTestId('new-group-title').textContent).toBe('New Group');
        expect(screen.getByTestId('new-group-backdrop')).toBeTruthy();
        expect(screen.getByTestId('sidebar').contains(sheet)).toBe(false);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('new-group-sheet')).toBeNull();
    });
});
