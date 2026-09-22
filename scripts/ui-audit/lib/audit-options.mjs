import { expandChains } from './shards.mjs';

const WINDOW_PLACEMENTS = new Set(['hidden', 'offscreen', 'onscreen', 'default']);

export function parseArgs(argv) {
    const options = {
        out: null,
        build: true,
        forceBuild: false,
        packaged: false,
        keep: false,
        verbose: false,
        only: null,
        /**
         * Does `--only` bring the chain its steps declare?
         *
         * On, because a step that reads `state.webPane` cannot do anything alone but fail (#203).
         * `--no-chain` is the opt-out, and it exists for one caller: `verify-manifest.mjs` runs a
         * candidate step ALONE from a cold boot on purpose, and "alone" is the measurement.
         */
        chain: true,
        /*
         * Where the shell window goes.
         *
         * `default` — a visible window, exactly as before — because it is the only placement
         * measured to keep BOTH the assertions and the screenshots. Freeing the machine's display
         * was the goal and it was tried three ways; `packages/shell/src/audit-window.ts` holds the
         * table. In short: `offscreen` loses the Retina backing store (devicePixelRatio 2 → 1,
         * which turned two green assertions red in a full run), and `hidden` (zero opacity) is
         * assertion-identical but writes blank PNGs, which is fatal for a suite where 107 of 118
         * steps are `needs-eyes`.
         *
         * `--window hidden` is still worth having for an assertions-only regression run, and
         * `--window onscreen` is the per-class fidelity pin used by `lib/shards.mjs`'s
         * `ONSCREEN_STEPS`. The throttling half of the change (`backgroundThrottling: false`) is
         * unconditional under `KELPI_AUDIT` and is what makes any of them survive being occluded.
         *
         * There is deliberately no `phone` placement: a phone viewport is a size, a device scale
         * factor and a pointer type, which is precisely what a placement is forbidden to change.
         * The phone lane emulates per step instead - see `emulatePhone` and the block above it.
         */
        window: 'default',
        // The parent partition must survive a child's actual placement override.
        planWindow: null,
        requestedOnly: null,
        /** Total shards. 1 = the classic single-process serial run. */
        shards: 1,
        /** Which shard THIS process is; null in the parent. Set by the parent on each child. */
        shard: null
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const valued = (name) => (arg === `--${name}` ? (argv[++i] ?? '') : arg.slice(`--${name}=`.length));
        if (arg === '--out' || arg.startsWith('--out=')) options.out = valued('out');
        else if (arg === '--no-build') options.build = false;
        else if (arg === '--force-build') options.forceBuild = true;
        else if (arg === '--packaged') options.packaged = true;
        else if (arg === '--keep') options.keep = true;
        else if (arg === '--verbose') options.verbose = true;
        else if (arg === '--only' || arg.startsWith('--only=')) options.only = valued('only').split(',').filter(Boolean);
        else if (arg === '--no-chain') options.chain = false;
        else if (arg === '--window' || arg.startsWith('--window=')) options.window = valued('window');
        else if (arg === '--plan-window' || arg.startsWith('--plan-window=')) options.planWindow = valued('plan-window');
        else if (arg === '--shards' || arg.startsWith('--shards=')) options.shards = Number.parseInt(valued('shards'), 10);
        else if (arg === '--shard' || arg.startsWith('--shard=')) options.shard = Number.parseInt(valued('shard'), 10);
        else if (arg === '--help' || arg === '-h') {
            process.stdout.write(
                'usage: node scripts/ui-audit/audit.mjs [--out <dir>] [--packaged] [--no-build] [--force-build]\n' +
                    '                                      [--keep] [--verbose] [--only a,b] [--no-chain]\n' +
                    '                                      [--window hidden|offscreen|onscreen|default] [--shards N]\n'
            );
            process.exit(0);
        } else throw new Error(`unknown argument: ${arg}`);
    }
    if (!WINDOW_PLACEMENTS.has(options.window)) {
        throw new Error(`--window must be one of ${[...WINDOW_PLACEMENTS].join(', ')} (got "${options.window}")`);
    }
    options.planWindow ??= options.window;
    if (!WINDOW_PLACEMENTS.has(options.planWindow)) throw new Error('--plan-window must be a valid window placement');
    options.requestedOnly = options.only;
    /**
     * `--only` runs the steps named AND the prerequisites those steps have already declared.
     *
     * `lib/shards.mjs` records which accumulated value binds each spine step, and `--only` used to
     * ignore it: `--only web-batch-pickup` ran a step the manifest describes as "reads
     * state.webPane" with nothing having written it, so its whole output was one failed "a web
     * pane exists" (#203). `expandChains` turns that declaration into the step that writes it.
     *
     * Done after the loop, not inside the `--only` branch, so `--no-chain` works whichever side of
     * `--only` it is written on.
     */
    if (options.only !== null && options.chain) {
        const asked = options.only;
        options.only = expandChains(asked);
        const added = options.only.filter((id) => !asked.includes(id));
        // Loud, because the alternative is a developer who asked for one step watching two run. A
        // child preserves the original selection but need not repeat the parent’s notice.
        if (added.length > 0 && options.shard === null) {
            process.stdout.write(`--only also runs ${added.join(', ')} (the chain these steps declare in lib/shards.mjs)\n`);
        }
    }
    if (!Number.isInteger(options.shards) || options.shards < 1) throw new Error('--shards must be a positive integer');
    if (options.shard !== null && (!Number.isInteger(options.shard) || options.shard < 0)) {
        throw new Error('--shard must be a non-negative integer');
    }
    // Deliberately NOT bounded by `--shards`: a manifest that pins a fidelity class to its own
    // window placement produces one more group than the requested shard count, and the parent
    // addresses it by index. `planShards` is the authority on how many groups there are.
    return options;
}

/** Shared parent-to-child placement and selection handoff, round-tripped in unit tests. */
export function shardArgs(options, plan, index) {
    return [
        '--shards', String(options.shards), '--shard', String(index),
        '--plan-window', options.planWindow,
        '--window', plan.placements[index] ?? options.window,
        ...(options.chain ? [] : ['--no-chain']),
        ...(options.requestedOnly === null ? [] : ['--only', options.requestedOnly.join(',')])
    ];
}

export function shardPlanOptions(options) {
    return { windowPlacement: options.planWindow, only: options.requestedOnly, chain: options.chain };
}
