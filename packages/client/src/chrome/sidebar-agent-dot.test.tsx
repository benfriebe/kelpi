/**
 * §AGNT-103 / §AGNT-104 — the sidebar's agent dot, and §H24: it BREATHES, it does not ping.
 *
 * The colour rule (waiting wins over running, nothing when neither) is asserted in
 * `Sidebar.test.tsx`. What is asserted here is the ANIMATION, against
 * `PulsingStatusDot` (`WorkspaceRowView.swift:5-23`) — a filled `Circle` with a 1.5 pt
 * `borderColor` ring, `.opacity(isPulsing ? 0.35 : 1.0)`, and
 * `.easeInOut(duration: 1.0).repeatForever(autoreverses: true)`. The dot fades to 35 % and back,
 * forever, and there is **no halo in the Swift at all**. The port used to grow a `0 0 0 4px`
 * box-shadow halo on a fully-opaque dot, driven by a `--kelpi-dot-halo` custom property.
 *
 * A CSS animation is not something a screenshot can hold, so this reads the two halves that
 * decide it: the element's residue (the class it carries and the one property it still
 * publishes) and — the `batch-script.test.ts` idiom — the KEYFRAMES themselves, parsed out of
 * `styles.css`, because the numbers the fade interpolates live there and nowhere else.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const stylesheet = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
    'utf8'
);

/** The body of a top-level `@keyframes <name> { … }` block, braces balanced. */
function keyframesBody(name: string): string {
    const start = stylesheet.indexOf(`@keyframes ${name} {`);
    expect(start, `@keyframes ${name} is not in styles.css`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = stylesheet.indexOf('{', start); i < stylesheet.length; i += 1) {
        if (stylesheet[i] === '{') depth += 1;
        else if (stylesheet[i] === '}') {
            depth -= 1;
            if (depth === 0) return stylesheet.slice(stylesheet.indexOf('{', start) + 1, i);
        }
    }
    throw new Error(`@keyframes ${name} is unterminated`);
}

/** The declaration block of a top-level `.<class> { … }` rule. */
function ruleBody(selector: string): string {
    const start = stylesheet.indexOf(`\n${selector} {`);
    expect(start, `${selector} is not a top-level rule in styles.css`).toBeGreaterThan(-1);
    return stylesheet.slice(stylesheet.indexOf('{', start) + 1, stylesheet.indexOf('}', start));
}

/** The stylesheet with every `/* … *​/` comment removed — declarations only. */
const declarations = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const G1 = 'cccccccc-0000-4000-8000-000000000001';

function pane(id: string, status: ChromePane['status']): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test/code',
        gitBranch: null,
        status,
        agentSessionID: status === 'idle' ? null : 'session',
        agentKind: 'claude',
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function workspace(id: string, name: string, status: ChromePane['status']): ChromeWorkspace {
    return { id, name, color: 'blue', icon: null, labels: [], panes: [pane(`${id}-p1`, status)] };
}

function entries(status: ChromePane['status']): ChromeSidebarEntry[] {
    return [
        { kind: 'workspace', workspace: workspace(W1, 'alpha', status) },
        {
            kind: 'group',
            group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
            // The group header aggregates its members, so one member is enough to light it.
            workspaces: [workspace(W2, 'beta', status)]
        }
    ];
}

function renderSidebar(status: ChromePane['status']): void {
    render(
        <Sidebar
            entries={entries(status)}
            activeWorkspaceID={W1}
            filter=""
            onFilterChange={vi.fn()}
            rowHeight={20}
        />
    );
}

describe('the sidebar agent dot pulses', () => {
    it('carries the pulse class and publishes its ring colour on a workspace row', () => {
        renderSidebar('waitingForInput');
        const dots = screen.getAllByTestId('status-dot');
        expect(dots.length).toBeGreaterThan(0);
        const dot = dots[0] as HTMLElement;
        expect(dot.className).toContain('kelpi-agent-dot-pulse');
        // The 1.5 px ring — the Swift's `borderColor` stroke — is published as a property and
        // PAINTED by the class, so the animated opacity carries the fill and the ring together
        // exactly as one SwiftUI view's `.opacity` does.
        expect(dot.style.getPropertyValue('--kelpi-dot-ring')).not.toBe('');
        /*
         * L18: and the 1.5px is CENTRED on the dot's edge. `Circle().stroke(borderColor,
         * lineWidth: 1.5)` (`WorkspaceRowView.swift:15`) straddles the path — 0.75 out, 0.75 in
         * — where a single `0 0 0 1.5px` spread hung the whole ring outside and made the marker
         * 12px across instead of 10.5.
         */
        expect(ruleBody('.kelpi-agent-dot-pulse')).toContain(
            '0 0 0 0.75px var(--kelpi-dot-ring), inset 0 0 0 0.75px var(--kelpi-dot-ring)'
        );
    });

    it('L18: a group band’s dot sits a point lower than a workspace row’s', () => {
        renderSidebar('running');
        // `.offset(x: 3, y: -3)` on an avatar (`WorkspaceRowView.swift:129`) vs `.offset(x: 3,
        // y: -2)` on a group glyph (`GroupHeaderRow.swift:139`) — the port drew -3 for both.
        const row = within(screen.getAllByTestId('workspace-row')[0] as HTMLElement).getByTestId('status-dot');
        expect((row as HTMLElement).style.top).toBe('-3px');
        const header = screen.queryByTestId('group-header');
        if (header !== null) {
            expect((within(header).getByTestId('status-dot') as HTMLElement).style.top).toBe('-2px');
        }
    });

    it('§H24: fades opacity 1 → 0.35 and back, and grows no halo', () => {
        const frames = keyframesBody('kelpi-agent-dot-pulse');
        // The Swift's two opacity endpoints, and the only two declarations in the animation.
        expect(frames).toMatch(/from\s*\{\s*opacity:\s*1;\s*\}/);
        expect(frames).toMatch(/to\s*\{\s*opacity:\s*0\.35;\s*\}/);
        // `autoreverses: true` + `repeatForever` at a 1 s ease-in-out.
        expect(ruleBody('.kelpi-agent-dot-pulse')).toContain(
            'animation: kelpi-agent-dot-pulse 1s ease-in-out infinite alternate'
        );
        // No halo anywhere: the keyframes animate nothing but opacity, and the property that used
        // to colour the expanding ring is gone from every DECLARATION (the prose above the rule
        // still names it, which is why the comments are stripped) and from the element.
        expect(frames).not.toContain('box-shadow');
        expect(declarations).not.toContain('--kelpi-dot-halo');

        renderSidebar('waitingForInput');
        const dot = screen.getAllByTestId('status-dot')[0] as HTMLElement;
        expect(dot.style.getPropertyValue('--kelpi-dot-halo')).toBe('');
        // …and nothing paints an inline shadow that could outlive the class.
        expect(dot.style.boxShadow).toBe('');
    });

    it('reduced motion keeps the dot at FULL opacity rather than freezing it mid-fade', () => {
        // `animation: none` alone would leave whatever opacity the frame stopped on; the state
        // is the colour, so the dot has to come back to 1.
        const reduced = stylesheet.slice(stylesheet.indexOf('.kelpi-agent-dot-pulse {'));
        const block = reduced.slice(
            reduced.indexOf('@media (prefers-reduced-motion: reduce)'),
            reduced.indexOf('@keyframes kelpi-sidebar-row-enter')
        );
        expect(block).toContain('animation: none');
        expect(block).toContain('opacity: 1');
    });

    it('pulses the group header’s aggregated dot too (AGNT-104)', () => {
        renderSidebar('running');
        // Two dots: the workspace row's and the group header's aggregate.
        const dots = screen.getAllByTestId('status-dot');
        expect(dots.length).toBeGreaterThanOrEqual(2);
        for (const dot of dots) expect((dot as HTMLElement).className).toContain('kelpi-agent-dot-pulse');
        expect((dots[0] as HTMLElement).dataset['status']).toBe('running');
    });

    it('draws no dot at all when nothing is running or waiting', () => {
        renderSidebar('idle');
        expect(screen.queryByTestId('status-dot')).toBeNull();
    });
});
