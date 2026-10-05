import { describe, expect, it } from 'vitest';

import { W1, harness, seedSplit, seedWorkspace, testID } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const P3 = testID('3', 3);

function seeded() {
    const h = harness();
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    return h;
}

const ownSize = (h: ReturnType<typeof seeded>, paneID: string): number | null | undefined =>
    h.workspace(W1).panes.find((pane) => pane.id === paneID)?.terminalFontSize;

describe('pane-font-size', () => {
    it("sets the resolved pane's own size and answers with it", () => {
        const h = seeded();
        expect(h.run({ command: 'pane-font-size', pane_id: P1, target: 'worker-1', size: 18, reset: false }).only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            label: 'worker-1',
            font_size: 18
        });
        expect(ownSize(h, P2)).toBe(18);
        // Every other pane keeps following the daemon-wide size.
        expect(ownSize(h, P1)).toBeNull();
    });

    it('drops the own size on reset', () => {
        const h = seeded();
        h.run({ command: 'pane-font-size', target: P2, size: 20, reset: false });
        expect(h.run({ command: 'pane-font-size', target: P2, reset: true }).only()).toMatchObject({ ok: true, font_size: null });
        expect(ownSize(h, P2)).toBeNull();
    });

    it('refuses a pane that does not render a terminal', () => {
        const h = seeded();
        h.store.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: P3, now: Date.now() });
        expect(h.run({ command: 'pane-font-size', target: P3, size: 18, reset: false }).only()).toEqual({
            ok: false,
            error: `pane ${P3} is not a terminal pane`
        });
    });

    it('reports an unknown target verbatim and changes nothing', () => {
        const h = seeded();
        expect(h.run({ command: 'pane-font-size', target: P3, size: 18, reset: false }).only()).toEqual({
            ok: false,
            error: `no pane with UUID '${P3}'`
        });
        expect(ownSize(h, P1)).toBeNull();
        expect(ownSize(h, P2)).toBeNull();
    });
});
