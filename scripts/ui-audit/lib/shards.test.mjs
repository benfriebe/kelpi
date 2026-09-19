import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANONICAL_ORDER, STEP_MANIFEST, aggregateShards, expandChains, manifestEntry, planShards, windowPlacementOf, writesOf } from './shards.mjs';

/**
 * `--only` against the chains the manifest already declares (#203).
 *
 * The audit's spine is one continuous session, and `chain` is the field that records which
 * accumulated value binds each step to it. `--only` ignored that, so `--only web-batch-pickup`
 * ran a step the manifest describes as "reads state.webPane" with nothing having written it: the
 * step spent its single assertion on "a web pane exists" and returned, which is why the one
 * failing step in the suite was the one that could not be re-run alone.
 *
 * What is pinned here is the rule, not the list: the expansion is WRITERS ONLY (a reader adds
 * nothing a later reader needs), it never reaches forwards, and it is stable under re-application
 * because a shard parent hands its children the expanded list and every child parses it again.
 */
describe('expandChains', () => {
    const index = (id) => CANONICAL_ORDER.indexOf(id);

    it('runs the step that opens the web pane before a step declared to read it', () => {
        expect(manifestEntry('web-batch-pickup').chain).toBe('webPane');
        expect(expandChains(['web-batch-pickup'])).toEqual(['web-pane', 'web-batch-pickup']);
        expect(expandChains(['web-batch-internals'])).toEqual(['web-pane', 'web-batch-internals']);
    });

    it('adds the chain\'s writers and not the readers sitting between them', () => {
        const expanded = expandChains(['web-batch-pickup']);
        // Both of these are `chain: 'webPane'` and both only read it, so neither is a prerequisite.
        expect(expanded).not.toContain('web-find');
        expect(expanded).not.toContain('web-url-bar-shortcut');
    });

    it('takes every writer a composite chain names, in canonical order, with the asked-for step last', () => {
        expect(manifestEntry('external-editor').chain).toBe('openedByDialog+mdPane');
        const expanded = expandChains(['external-editor']);
        expect(expanded).toContain('open-file-dialog');
        expect(expanded).toContain('markdown-pane');
        expect(expanded).toContain('content-pane-keybindings');
        expect(expanded.at(-1)).toBe('external-editor');
        expect(expanded.map(index)).toEqual([...expanded.map(index)].sort((a, b) => a - b));
    });

    it('never reaches forwards: a prerequisite always runs before the step that asked for it', () => {
        for (const id of ['web-batch-pickup', 'external-editor', 'repo-autodetect', 'agent-notification']) {
            for (const added of expandChains([id])) expect(index(added)).toBeLessThanOrEqual(index(id));
        }
    });

    it('leaves a self-provisioning step, an empty list and an unknown id exactly as they came', () => {
        expect(manifestEntry('phone-form-factor').chain).toBe(null);
        expect(expandChains(['phone-form-factor'])).toEqual(['phone-form-factor']);
        expect(expandChains([])).toEqual([]);
        expect(expandChains(['not-a-step'])).toEqual(['not-a-step']);
    });

    it('is stable under re-application, because a shard child re-parses the list its parent expanded', () => {
        for (const ids of [['web-batch-pickup'], ['external-editor'], ['fresh-boot', 'terminal-ls'], ['mac-chrome']]) {
            expect(expandChains(expandChains(ids))).toEqual(expandChains(ids));
        }
    });

    /**
     * The expansion reads the manifest's own prose ("writes state.X"), so this is the guard that
     * keeps that reading honest: a re-worded `reason` that drops the declaration fails here
     * instead of silently un-teaching `--only` the dependency it was taught.
     *
     * Through `writesOf` itself, not a second copy of its pattern: a guard that matched the prose
     * slightly differently from the code it guards would be the very drift it is here to catch.
     * It covers DECLARED chain variables only (see `expandChains`'s note on `state.agentFocusWas`).
     */
    it('finds a declared writer at or before every step that declares a chain', () => {
        const written = new Set();
        const orphans = [];
        for (const entry of STEP_MANIFEST) {
            const writes = new Set(writesOf(entry));
            for (const variable of entry.chain === null ? [] : entry.chain.split('+')) {
                if (!written.has(variable) && !writes.has(variable)) orphans.push(`${entry.id} reads state.${variable}`);
            }
            for (const variable of writes) written.add(variable);
        }
        expect(orphans).toEqual([]);
    });

    it('reads a writer declaration out of the manifest\'s own prose, wherever the sentence puts it', () => {
        // `terminal-ls` opens with the phrase; `fresh-boot` buries it mid-sentence; a reader has none.
        expect(writesOf(manifestEntry('terminal-ls'))).toEqual(['firstPane']);
        expect(writesOf(manifestEntry('fresh-boot'))).toEqual(['firstPane']);
        expect(writesOf(manifestEntry('web-pane'))).toEqual(['webPane']);
        expect(writesOf(manifestEntry('web-batch-pickup'))).toEqual([]);
    });
});

describe('native-page placement floors', () => {
    const sensitive = ['web-batch-pickup', 'web-batch-internals', 'web-console-frames'];

    it('declares the three native-page flows offscreen, alongside their audit definitions', () => {
        expect(sensitive.map(windowPlacementOf)).toEqual(['offscreen', 'offscreen', 'offscreen']);
    });

    it('gives those flows an offscreen process when the audit default may be covered', () => {
        const plan = planShards(CANONICAL_ORDER, 1, { windowPlacement: 'default' });
        const isolatedAt = plan.groups.findIndex((group) => group.includes('web-batch-pickup'));

        expect(isolatedAt).toBeGreaterThan(0);
        expect(plan.groups[0]).not.toEqual(expect.arrayContaining(sensitive));
        expect(plan.groups[isolatedAt]).toEqual(sensitive);
        expect(plan.placements[isolatedAt]).toBe('offscreen');
        expect(plan.supports[isolatedAt]).toEqual(['web-pane']);
    });

    it('does not split an audit already running at a non-occludable placement', () => {
        const plan = planShards(CANONICAL_ORDER, 1, { windowPlacement: 'onscreen' });
        expect(plan.groups).toEqual([CANONICAL_ORDER]);
        expect(plan.supports).toEqual([[]]);
    });

    it('keeps a normal chain writer in the aggregate and drops its isolated setup duplicate', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-shards-'));
        const first = path.join(root, 'first');
        const second = path.join(root, 'second');
        const step = (id, support = false) => ({
            index: '01', id, slug: `01-${id}`, expect: '', needsEyes: false, notes: [], assertions: [], shots: [], blocks: [], error: null,
            startedAt: '2026-09-19T00:00:00.000Z', finishedAt: '2026-09-19T00:00:00.000Z', ...(support ? { support: true } : {})
        });
        try {
            fs.mkdirSync(first); fs.mkdirSync(second);
            fs.writeFileSync(path.join(first, 'results.json'), JSON.stringify({ summary: {}, steps: [step('web-pane')] }));
            fs.writeFileSync(path.join(second, 'results.json'), JSON.stringify({ summary: {}, steps: [step('web-pane', true), step('web-batch-pickup')] }));

            aggregateShards({ outDir: path.join(root, 'out'), shardDirs: [first, second], canonicalOrder: CANONICAL_ORDER, meta: {} });
            const ids = JSON.parse(fs.readFileSync(path.join(root, 'out', 'results.json'), 'utf8')).steps.map((entry) => entry.id);
            expect(ids).toEqual(['web-pane', 'web-batch-pickup']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
