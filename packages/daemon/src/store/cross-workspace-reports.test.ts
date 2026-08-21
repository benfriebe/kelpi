/**
 * §TERM-047 / §TERM-048 — a terminal report lands on the pane that made it, whichever workspace
 * that pane is in.
 *
 * The Swift routing goes surface → pane id → `state.workspaces[id: …]`, never through the
 * active workspace (`ContentView.swift:359-365` looks the surface up across every workspace and
 * `AppReducer+SearchNotify.swift:25-31` dispatches into the one that owns it). The port's store
 * is global for the same reason, so the *code* has never had an active-workspace filter — but
 * neither did anything drive a report at a background workspace's pane, which is the whole of
 * what kept both items partial.
 *
 * These are the store-side assertions. The end-to-end half — a real OSC 2 / OSC 7 from a real
 * shell in a background workspace, with the sidebar and the footer read afterwards — is the
 * audit's `terminal-host-edges` step.
 */

import { describe, expect, it } from 'vitest';

import { harness, id, seededState, NOW, W1, W2 } from './testing.js';

const PANE_ACTIVE = id('dddddddd', 100);
const PANE_BACKGROUND = id('dddddddd', 200);

/** `W1` active with `PANE_ACTIVE`; `W2` in the background with `PANE_BACKGROUND`. */
function twoWorkspaces(): ReturnType<typeof harness> {
    const h = harness(seededState(W1, PANE_ACTIVE));
    h.dispatch({
        type: 'create-workspace',
        id: W2,
        paneID: PANE_BACKGROUND,
        name: 'background',
        color: 'green',
        now: NOW
    });
    h.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    expect(h.state().lastActiveWorkspaceID).toBe(W1);
    return h;
}

function paneIn(h: ReturnType<typeof harness>, workspaceID: string, paneID: string) {
    return h.state().workspaces.find((w) => w.id === workspaceID)?.panes.find((p) => p.id === paneID);
}

describe('§TERM-047 — an OSC 0/2 title report is dispatched cross-workspace', () => {
    it('updates the title of a pane in a NON-active workspace', () => {
        const h = twoWorkspaces();
        h.dispatch({
            type: 'pane-title-changed',
            paneID: PANE_BACKGROUND,
            title: 'make -j8',
            now: NOW + 5_000
        });
        expect(paneIn(h, W2, PANE_BACKGROUND)?.title).toBe('make -j8');
        // …and leaves the active workspace's pane alone.
        expect(paneIn(h, W1, PANE_ACTIVE)?.title).toBeNull();
    });

    it('bumps that pane’s lastActivityAt, which is what `last_activity_at` sorting reads', () => {
        const h = twoWorkspaces();
        const before = paneIn(h, W2, PANE_BACKGROUND)?.lastActivityAt ?? 0;
        h.dispatch({
            type: 'pane-title-changed',
            paneID: PANE_BACKGROUND,
            title: 'make -j8',
            now: NOW + 60_000
        });
        const after = paneIn(h, W2, PANE_BACKGROUND)?.lastActivityAt ?? 0;
        expect(after).toBeGreaterThan(before);
    });

    it('emits a delta for the background workspace, so a second window follows it', () => {
        const h = twoWorkspaces();
        const mark = h.events.length;
        h.dispatch({
            type: 'pane-title-changed',
            paneID: PANE_BACKGROUND,
            title: 'make -j8',
            now: NOW + 5_000
        });
        const emitted = h.events.slice(mark);
        expect(emitted.length).toBeGreaterThan(0);
        expect(JSON.stringify(emitted)).toContain(PANE_BACKGROUND);
    });

    it('does not move the active workspace (a background report is not a switch)', () => {
        const h = twoWorkspaces();
        h.dispatch({ type: 'pane-title-changed', paneID: PANE_BACKGROUND, title: 'x', now: NOW + 1 });
        expect(h.state().lastActiveWorkspaceID).toBe(W1);
    });
});

describe('§TERM-048 — an OSC 7 pwd report is dispatched cross-workspace', () => {
    it('updates the working directory of a pane in a NON-active workspace', () => {
        const h = twoWorkspaces();
        h.dispatch({
            type: 'pane-directory-changed',
            paneID: PANE_BACKGROUND,
            directory: '/work/elsewhere',
            now: NOW + 5_000
        });
        expect(paneIn(h, W2, PANE_BACKGROUND)?.workingDirectory).toBe('/work/elsewhere');
        expect(paneIn(h, W1, PANE_ACTIVE)?.workingDirectory).not.toBe('/work/elsewhere');
    });

    it('bumps lastActivityAt with it', () => {
        const h = twoWorkspaces();
        const before = paneIn(h, W2, PANE_BACKGROUND)?.lastActivityAt ?? 0;
        h.dispatch({
            type: 'pane-directory-changed',
            paneID: PANE_BACKGROUND,
            directory: '/work/elsewhere',
            now: NOW + 60_000
        });
        expect(paneIn(h, W2, PANE_BACKGROUND)?.lastActivityAt ?? 0).toBeGreaterThan(before);
    });

    /**
     * §GIT-091's chain is a store *reconciler* (`git/branch.ts`), not a call site behind the pwd
     * dispatch — so the branch a background pane carries is written by the same
     * `pane-branch-changed` the active one uses, and the reducer must accept it for a pane it
     * cannot see.
     */
    it('accepts a branch resolved for a background pane', () => {
        const h = twoWorkspaces();
        h.dispatch({
            type: 'pane-branch-changed',
            paneID: PANE_BACKGROUND,
            branch: 'feature/branch-chip'
        });
        expect(paneIn(h, W2, PANE_BACKGROUND)?.gitBranch).toBe('feature/branch-chip');
        expect(paneIn(h, W1, PANE_ACTIVE)?.gitBranch).toBeNull();
    });
});
