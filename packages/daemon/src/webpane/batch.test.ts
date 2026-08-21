/**
 * The batch "element pickup" session (WEB-126…WEB-145).
 *
 * Two layers are exercised: the pure session state (`./batch.ts`) and the whole loop through the
 * service — an armed sticky picker, picks arriving as host events, the page's own intents coming
 * back, and the final paste into a shell pane.
 */

import { describe, expect, it } from 'vitest';

import { batchMarkerInputs, createBatchState, formatBatchForPaste, serializeBatchSession } from './batch.js';
import type { InspectResult } from './inspect.js';
import {
    attachFakeHost,
    id,
    webHarness,
    NOW,
    SHELL_PANE,
    WEB_PANE,
    WEB_TAB
} from './testing.js';
import { webPaneGuiCommand } from '../ws/web-ui.js';

function result(selector: string): InspectResult {
    return {
        tabID: WEB_TAB,
        selector,
        xpath: `//${selector}`,
        tag: 'button',
        elementID: '',
        outerHTML: '<button>Go</button>',
        attributes: { id: 'go' },
        rect: { x: 1, y: 2, w: 3, h: 4 },
        text: 'Go',
        contextHTML: '',
        url: 'https://example.com',
        capturedAt: NOW,
        comment: ''
    };
}

describe('the session state', () => {
    it('is a three-way toggle whose items survive hide/show (WEB-126)', () => {
        const state = createBatchState();
        expect(state.toggle('p')).toBe('started');
        state.add('p', { id: 'i1', result: result('#a'), comment: '' });

        expect(state.toggle('p')).toBe('hidden');
        // Hidden is PAUSED, not cleared: the items are still there…
        expect(state.sessionOf('p')?.items).toHaveLength(1);
        // …but the page shows nothing (WEB-127).
        expect(batchMarkerInputs(state.sessionOf('p')!)).toEqual([]);

        expect(state.toggle('p')).toBe('shown');
        expect(state.sessionOf('p')?.items).toHaveLength(1);
        expect(batchMarkerInputs(state.sessionOf('p')!)).toEqual([
            { id: 'i1', selector: '#a', label: '1', comment: '' }
        ]);
    });

    it('refuses a pick while hidden, so a single-shot arm can take it (WEB-128)', () => {
        const state = createBatchState();
        state.toggle('p');
        state.hide('p');
        expect(state.add('p', { id: 'i1', result: result('#a'), comment: '' })).toBeNull();
        expect(state.sessionOf('p')?.items).toHaveLength(0);
    });

    it('focuses the newest pick, and drops focus with the item it named', () => {
        const state = createBatchState();
        state.toggle('p');
        state.add('p', { id: 'i1', result: result('#a'), comment: '' });
        state.add('p', { id: 'i2', result: result('#b'), comment: '' });
        expect(state.sessionOf('p')?.focusedID).toBe('i2');
        state.remove('p', 'i2');
        expect(state.sessionOf('p')?.focusedID).toBeNull();
    });

    it('will not focus an item that is not in the set', () => {
        const state = createBatchState();
        state.toggle('p');
        state.add('p', { id: 'i1', result: result('#a'), comment: '' });
        state.focus('p', 'nope');
        expect(state.sessionOf('p')?.focusedID).toBe('i1');
    });

    it('remembers a real destination and never remembers the local-queue branch (WEB-132)', () => {
        const state = createBatchState();
        state.toggle('p');
        state.add('p', { id: 'i1', result: result('#a'), comment: '' });
        state.take('p', { rememberTarget: SHELL_PANE });
        expect(state.toggle('p')).toBe('started');
        expect(state.sessionOf('p')?.lastTarget).toBe(SHELL_PANE);

        state.add('p', { id: 'i2', result: result('#b'), comment: '' });
        state.take('p'); // sent with no destination
        state.toggle('p');
        // Still the old pane, not overwritten by a "local" marker.
        expect(state.sessionOf('p')?.lastTarget).toBe(SHELL_PANE);
    });

    it('clamps a comment and leaves an unchanged one alone', () => {
        const state = createBatchState();
        state.toggle('p');
        state.add('p', { id: 'i1', result: result('#a'), comment: '' });
        const before = state.sessionOf('p');
        state.setComment('p', 'i1', '');
        expect(state.sessionOf('p')).toBe(before);
        state.setComment('p', 'i1', 'x'.repeat(5000));
        expect(state.sessionOf('p')?.items[0]?.comment.endsWith('... [truncated]')).toBe(true);
    });
});

describe('the paste payload (WEB-134)', () => {
    it('is a counted header over one fenced, sorted-key JSON array', () => {
        const text = formatBatchForPaste(
            [
                { id: 'i1', result: result('#a'), comment: 'first' },
                { id: 'i2', result: result('#b'), comment: '' }
            ],
            NOW
        );
        expect(text.split('\n')[0]).toBe(`# nex inspect batch ${new Date(NOW).toISOString()} (2 items)`);
        expect(text).toContain('```json');
        const body = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as unknown[];
        expect(body).toHaveLength(2);
        expect(body[0]).toMatchObject({ selector: '#a', comment: 'first', tag: 'button' });
        // Sorted keys, so a diff of two pastes is readable.
        expect(Object.keys(body[0] as object)).toEqual([...Object.keys(body[0] as object)].sort());
    });

    it('says "1 item" for a single pick', () => {
        const text = formatBatchForPaste([{ id: 'i1', result: result('#a'), comment: '' }], NOW);
        expect(text).toContain('(1 item)');
    });
});

describe('the whole loop', () => {
    it('arms sticky, collects picks, and pastes them into a shell pane', async () => {
        const harness = webHarness({ nonce: () => 'NONCE' });
        const host = attachFakeHost(harness.service);

        const started = webPaneGuiCommand(harness.service, harness.store, 'web-batch-toggle', WEB_PANE, {});
        const arm = host.answer({ ok: true }, 'inspect-arm');
        // WEB-127: sticky, unlike `nex web inspect`'s single-shot arm.
        expect(arm.args).toMatchObject({ paneID: WEB_PANE, tabID: WEB_TAB, sticky: true });
        await expect(started).resolves.toMatchObject({ ok: true, armed: true, toggled: 'started' });

        host.emit('inspect', WEB_PANE, { ...pickPayload('#one') }, WEB_TAB);
        host.emit('inspect', WEB_PANE, { ...pickPayload('#two') }, WEB_TAB);

        const session = harness.service.batch.sessionOf(WEB_PANE);
        expect(session?.items.map((item) => item.result.selector)).toEqual(['#one', '#two']);
        // The picker stayed armed across both picks.
        expect(harness.service.inspect.armOf(WEB_PANE)).not.toBeNull();

        // The page got numbered markers, and the newest pick was focused WITHOUT a scroll.
        const [first, second] = session?.items ?? [];
        const markers = host.notifies.filter((entry) => entry.verb === 'batch-markers').at(-1);
        expect(markers?.args['items']).toEqual([
            { id: first?.id, selector: '#one', label: '1', comment: '' },
            { id: second?.id, selector: '#two', label: '2', comment: '' }
        ]);
        const highlight = host.notifies.filter((entry) => entry.verb === 'batch-highlight').at(-1);
        expect(highlight?.args).toMatchObject({ itemID: second?.id, scrollIntoView: false });

        await webPaneGuiCommand(harness.service, harness.store, 'web-batch-send', WEB_PANE, {
            send_to: SHELL_PANE
        });
        expect(harness.pasted).toHaveLength(1);
        expect(harness.pasted[0]?.paneID).toBe(SHELL_PANE);
        expect(harness.pasted[0]?.bare).toBe(true);
        expect(harness.pasted[0]?.text).toContain('# nex inspect batch');
        expect(harness.pasted[0]?.text).toContain('#one');
        // Teardown: session gone, picker disarmed, markers cleared.
        expect(harness.service.batch.sessionOf(WEB_PANE)).toBeNull();
        expect(harness.service.inspect.armOf(WEB_PANE)).toBeNull();
        expect(host.notifies.filter((entry) => entry.verb === 'batch-clear').length).toBeGreaterThan(0);
    });

    it('queues every item locally, comment stamped, when there is no destination (WEB-135)', async () => {
        const harness = webHarness({ nonce: () => 'NONCE' });
        const host = attachFakeHost(harness.service);
        const started = webPaneGuiCommand(harness.service, harness.store, 'web-batch-toggle', WEB_PANE, {});
        host.answer({ ok: true }, 'inspect-arm');
        await started;

        host.emit('inspect', WEB_PANE, pickPayload('#one'), WEB_TAB);
        const itemID = harness.service.batch.sessionOf(WEB_PANE)?.items[0]?.id ?? '';
        await webPaneGuiCommand(harness.service, harness.store, 'web-batch-comment', WEB_PANE, {
            item_id: itemID,
            comment: 'this one'
        });
        await webPaneGuiCommand(harness.service, harness.store, 'web-batch-send', WEB_PANE, {});

        expect(harness.pasted).toHaveLength(0);
        const queued = harness.service.inspect.queued(WEB_PANE);
        expect(queued).toHaveLength(1);
        expect(queued[0]?.comment).toBe('this one');
    });

    it('an empty batch just tears down (WEB-135)', async () => {
        const harness = webHarness({ nonce: () => 'NONCE' });
        const host = attachFakeHost(harness.service);
        const started = webPaneGuiCommand(harness.service, harness.store, 'web-batch-toggle', WEB_PANE, {});
        host.answer({ ok: true }, 'inspect-arm');
        await started;
        await expect(
            webPaneGuiCommand(harness.service, harness.store, 'web-batch-send', WEB_PANE, { send_to: SHELL_PANE })
        ).resolves.toMatchObject({ ok: true, sent: 0 });
        expect(harness.pasted).toHaveLength(0);
        expect(harness.service.batch.sessionOf(WEB_PANE)).toBeNull();
    });

    it('refuses a destination that is not a shell pane (§17.9)', async () => {
        const harness = webHarness({ nonce: () => 'NONCE' });
        const host = attachFakeHost(harness.service);
        const started = webPaneGuiCommand(harness.service, harness.store, 'web-batch-toggle', WEB_PANE, {});
        host.answer({ ok: true }, 'inspect-arm');
        await started;
        await expect(
            webPaneGuiCommand(harness.service, harness.store, 'web-batch-send', WEB_PANE, { send_to: WEB_PANE })
        ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('shell pane') as unknown as string });
        // Nothing was torn down by the refusal.
        expect(harness.service.batch.sessionOf(WEB_PANE)).not.toBeNull();
    });

    it('routes the page’s own intents: badge click, comment, dismiss, remove', async () => {
        const harness = webHarness({ nonce: () => 'NONCE' });
        const host = attachFakeHost(harness.service);
        const started = webPaneGuiCommand(harness.service, harness.store, 'web-batch-toggle', WEB_PANE, {});
        host.answer({ ok: true }, 'inspect-arm');
        await started;
        host.emit('inspect', WEB_PANE, pickPayload('#one'), WEB_TAB);
        host.emit('inspect', WEB_PANE, pickPayload('#two'), WEB_TAB);

        const items = harness.service.batch.sessionOf(WEB_PANE)?.items ?? [];
        const one = items[0]?.id ?? '';
        const two = items[1]?.id ?? '';

        // A badge click focuses page-origin: no scroll, because the element is under the cursor.
        host.emit('batch-marker', WEB_PANE, { id: one }, WEB_TAB);
        expect(harness.service.batch.sessionOf(WEB_PANE)?.focusedID).toBe(one);
        expect(host.notifies.filter((entry) => entry.verb === 'batch-highlight').at(-1)?.args).toMatchObject({
            itemID: one,
            scrollIntoView: false
        });

        // A popover edit is stored but NOT echoed back — the page is the author (WEB-141).
        const before = host.notifies.filter((entry) => entry.verb === 'batch-comment').length;
        host.emit('batch-marker', WEB_PANE, { commentChanged: { id: one, comment: 'typed' } }, WEB_TAB);
        expect(harness.service.batch.sessionOf(WEB_PANE)?.items[0]?.comment).toBe('typed');
        expect(host.notifies.filter((entry) => entry.verb === 'batch-comment')).toHaveLength(before);

        host.emit('batch-marker', WEB_PANE, { dismiss: { id: one } }, WEB_TAB);
        expect(harness.service.batch.sessionOf(WEB_PANE)?.focusedID).toBeNull();

        host.emit('batch-marker', WEB_PANE, { remove: { id: two } }, WEB_TAB);
        expect(harness.service.batch.sessionOf(WEB_PANE)?.items.map((item) => item.id)).toEqual([one]);
    });

    it('Escape in the page cancels the whole batch (WEB-131’s hint, WEB-136)', async () => {
        const harness = webHarness({ nonce: () => 'NONCE' });
        const host = attachFakeHost(harness.service);
        const started = webPaneGuiCommand(harness.service, harness.store, 'web-batch-toggle', WEB_PANE, {});
        host.answer({ ok: true }, 'inspect-arm');
        await started;
        host.emit('inspect', WEB_PANE, pickPayload('#one'), WEB_TAB);

        host.emit('inspect', WEB_PANE, { nonce: 'NONCE', cancelled: true }, WEB_TAB);
        expect(harness.service.batch.sessionOf(WEB_PANE)).toBeNull();
    });

    /**
     * §WEB-124 / §WEB-125. A batch the user has not sent is pending work, and a headless caller
     * (`nex web inspect-result`) is entitled to it — comments included. `--clear` then cancels
     * the batch, which is where the "only when a batch exists" clause matters: an independently
     * armed single-shot picker must survive it.
     */
    it('drains pending batch items, comments and all, and --clear cancels the batch', async () => {
        const harness = webHarness({ nonce: () => 'NONCE' });
        const host = attachFakeHost(harness.service);
        const started = webPaneGuiCommand(harness.service, harness.store, 'web-batch-toggle', WEB_PANE, {});
        host.answer({ ok: true }, 'inspect-arm');
        await started;
        host.emit('inspect', WEB_PANE, pickPayload('#one'), WEB_TAB);
        host.emit('inspect', WEB_PANE, pickPayload('#two'), WEB_TAB);
        const itemID = harness.service.batch.sessionOf(WEB_PANE)?.items[0]?.id ?? '';
        await webPaneGuiCommand(harness.service, harness.store, 'web-batch-comment', WEB_PANE, {
            item_id: itemID,
            comment: 'the primary CTA'
        });

        const drained = harness.reply({ command: 'web-inspect-result', pane_id: WEB_PANE });
        const results = drained['results'] as Record<string, unknown>[];
        expect(results.map((entry) => entry['selector'])).toEqual(['#one', '#two']);
        expect(results[0]?.['comment']).toBe('the primary CTA');
        // An item with no comment omits the field entirely (the serialiser's rule).
        expect(results[1]?.['comment']).toBeUndefined();
        // A plain drain leaves the batch alone: the panel is still on screen.
        expect(harness.service.batch.sessionOf(WEB_PANE)?.items).toHaveLength(2);

        harness.reply({ command: 'web-inspect-result', pane_id: WEB_PANE, clear: true });
        expect(harness.service.batch.sessionOf(WEB_PANE)).toBeNull();
        expect(
            (harness.reply({ command: 'web-inspect-result', pane_id: WEB_PANE })['results'] as unknown[])
        ).toEqual([]);
    });

    it('--clear leaves an independently armed single-shot picker alone (WEB-125)', () => {
        const harness = webHarness({ nonce: () => 'NONCE-SOLO' });
        attachFakeHost(harness.service);
        harness.service.inspect.arm({
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            nonce: 'NONCE-SOLO',
            sendTo: null,
            submit: false
        });

        harness.reply({ command: 'web-inspect-result', pane_id: WEB_PANE, clear: true });
        expect(harness.service.inspect.armOf(WEB_PANE)?.nonce).toBe('NONCE-SOLO');
    });

    it('tears the session down when the arm fails, rather than leaving a dead panel', async () => {
        const harness = webHarness({ nonce: () => 'NONCE' });
        const host = attachFakeHost(harness.service);
        const started = webPaneGuiCommand(harness.service, harness.store, 'web-batch-toggle', WEB_PANE, {});
        host.answer({ ok: false, error: 'failed to arm inspector for active tab' }, 'inspect-arm');
        await expect(started).resolves.toMatchObject({ ok: false, batch: null });
        expect(harness.service.batch.sessionOf(WEB_PANE)).toBeNull();
    });

    it('serializes a session into the shape the panel renders', () => {
        const state = createBatchState();
        state.toggle('p');
        state.add('p', { id: 'i1', result: result('#a'), comment: 'note' });
        expect(serializeBatchSession(state.sessionOf('p'))).toEqual({
            visible: true,
            focused_id: 'i1',
            last_target: null,
            submit: false,
            items: [
                {
                    id: 'i1',
                    selector: '#a',
                    tag: 'button',
                    text: 'Go',
                    url: 'https://example.com',
                    comment: 'note'
                }
            ]
        });
        expect(serializeBatchSession(null)).toBeNull();
    });
});

function pickPayload(selector: string): Record<string, unknown> {
    return {
        nonce: 'NONCE',
        selector,
        xpath: `//${selector}`,
        tag: 'BUTTON',
        element_id: '',
        outer_html: '<button>Go</button>',
        attributes: { id: 'go' },
        rect: { x: 1, y: 2, w: 3, h: 4 },
        text: 'Go',
        context_html: '',
        url: 'https://example.com',
        captured_at: new Date(NOW).toISOString()
    };
}

// Keeps `id` imported for the canonical-UUID helper used by the harness options above.
void id;
