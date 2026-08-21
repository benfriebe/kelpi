/**
 * Client-facing path canonicalization (§APP-071 / §GIT-092, audit ledger **N5**).
 *
 * Two subsystems produce the paths the chrome has to compare, and they produce different
 * KINDS of path for the same directory:
 *
 *   - a **repo association** carries git's answer to `rev-parse --show-toplevel`, which is the
 *     PHYSICAL path — `/private/var/folders/…/repo` on macOS;
 *   - a **pane** carries the LOGICAL path it was spawned with, or the one the shell reported
 *     over OSC 7 — `/var/folders/…/repo`, because that is what the user typed and what `$PWD`
 *     says.
 *
 * `/var`, `/tmp` and plenty of `$HOME`s are symlinks, so a `startsWith` between those two
 * strings is false for the same directory and the status footer's `doc N +A -B` silently drew
 * nothing. Neither side can be dropped: the logical path is what the footer and `pane list`
 * DISPLAY, and the physical path is what git will answer with next time. So the daemon ships
 * BOTH, and the comparison is done on the canonical one.
 *
 * A browser cannot call `realpath`, which is why this lives here rather than in the client: the
 * canonical form is computed at the single seam where daemon state turns into wire JSON
 * (`serializePane`, `serializeAssociation`) and rides along beside the literal path.
 *
 * Resolution is `graft/paths.ts`'s `canonicalizePath`: it walks up to the longest existing
 * prefix, resolves that, and re-appends the missing tail — so a pane sitting in a directory
 * that has since been deleted still canonicalizes to a comparable path instead of throwing.
 * Anything that still throws yields `''`, which every consumer reads as "no canonical form",
 * falling back to the literal path rather than blanking.
 *
 * The results are memoized because `serializePane` runs on every `pane-upserted` delta and on
 * every snapshot. Entries expire so a symlink that is re-pointed mid-session cannot pin a
 * stale answer forever.
 */

import { canonicalizePath, type RealpathFn } from '../graft/paths.js';

/** How long a resolved path is trusted. Matches the association status poll's cadence. */
export const CANONICAL_PATH_TTL_MS = 30_000;

/** Bound on the memo; a daemon that has seen thousands of directories drops the oldest. */
export const CANONICAL_PATH_CACHE_LIMIT = 512;

export interface ClientPathResolverOptions {
    readonly realpath?: RealpathFn | undefined;
    readonly now?: (() => number) | undefined;
    readonly ttlMs?: number | undefined;
    readonly cacheLimit?: number | undefined;
}

export interface ClientPathResolver {
    /**
     * `input` with symlinks resolved, or `''` when there is nothing to resolve (an empty
     * input) or resolution failed outright.
     */
    canonicalize(input: string): string;
    /** Drop every memoized entry (tests, and a config reload that moves the home). */
    reset(): void;
    /** Entry count; diagnostics and the cache-bound test. */
    size(): number;
}

interface CacheEntry {
    readonly value: string;
    readonly at: number;
}

export function createClientPathResolver(options: ClientPathResolverOptions = {}): ClientPathResolver {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? CANONICAL_PATH_TTL_MS;
    const limit = options.cacheLimit ?? CANONICAL_PATH_CACHE_LIMIT;
    const cache = new Map<string, CacheEntry>();

    return {
        canonicalize(input: string): string {
            if (typeof input !== 'string') return '';
            const trimmed = input.trim();
            if (trimmed === '') return '';
            const at = now();
            const hit = cache.get(trimmed);
            if (hit !== undefined && at - hit.at < ttlMs) return hit.value;
            let value: string;
            try {
                value =
                    options.realpath === undefined
                        ? canonicalizePath(trimmed)
                        : canonicalizePath(trimmed, options.realpath);
            } catch {
                // `canonicalizePath` already swallows ENOENT; anything left (a permission
                // error on an ancestor, a path so long the syscall refuses) must not take the
                // whole serialization down with it.
                value = '';
            }
            if (cache.size >= limit) {
                const oldest = cache.keys().next();
                if (oldest.done !== true) cache.delete(oldest.value);
            }
            cache.set(trimmed, { value, at });
            return value;
        },

        reset(): void {
            cache.clear();
        },

        size(): number {
            return cache.size;
        }
    };
}

/** The process-wide resolver the serializers use. */
export const clientPaths: ClientPathResolver = createClientPathResolver();

/**
 * `input` with symlinks resolved, memoized. `''` when there is no canonical form — consumers
 * fall back to the literal path, which is exactly the pre-fix behaviour.
 */
export function canonicalizeForClient(input: string): string {
    return clientPaths.canonicalize(input);
}
