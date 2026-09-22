import { describe, expect, it } from 'vitest';
import { parseArgs, shardArgs, shardPlanOptions } from './audit-options.mjs';
import { CANONICAL_ORDER, planShards } from './shards.mjs';

const planFor = (options) => planShards(CANONICAL_ORDER, options.shards, shardPlanOptions(options));

describe('parent/child placement handoff', () => {
    for (const window of ['default', 'hidden', 'offscreen', 'onscreen']) {
        for (const shards of [1, 2, 4]) {
            for (const selection of [[], ['--only', 'web-batch-pickup,web-batch-internals,web-console-frames'], ['--only', 'web-batch-pickup', '--no-chain']]) {
                it(`preserves assignments at ${window}, ${shards} shards, ${selection.join(' ') || 'full'}`, () => {
                    const parent = parseArgs(['--window', window, '--shards', String(shards), ...selection]);
                    const plan = planFor(parent);
                    for (const [index, ids] of plan.groups.entries()) {
                        if (ids.length === 0) continue;
                        const child = parseArgs(shardArgs(parent, plan, index));
                        const rebuilt = planFor(child);
                        expect(rebuilt.groups[index]).toEqual(ids);
                        expect(rebuilt.supports[index]).toEqual(plan.supports[index]);
                        expect(child.window).toBe(plan.placements[index] ?? window);
                        expect(child.planWindow).toBe(window);
                    }
                });
            }
        }
    }

    it('starts only the isolated child for a narrow native-page rerun and brings its writer', () => {
        const plan = planFor(parseArgs(['--only', 'web-batch-pickup']));
        const active = plan.groups.flatMap((ids, index) => ids.length ? [{ ids, setup: plan.supports[index] }] : []);
        expect(active).toEqual([{ ids: ['web-batch-pickup'], setup: ['web-pane'] }]);
    });

    it('keeps an explicitly requested writer canonical and respects no-chain', () => {
        const plan = planFor(parseArgs(['--only', 'web-pane,web-batch-pickup']));
        expect(plan.groups[0]).toEqual(['web-pane']);
        const alone = planFor(parseArgs(['--only', 'web-batch-pickup', '--no-chain']));
        expect(alone.supports.flat()).toEqual([]);
    });
});
