/**
 * The names a ticket gives a workspace: what it is called, which branch it works on and which
 * folder its worktree goes in (docs/integrations.md "Names").
 *
 *   - workspace name, issue or pull request: `#418 Retry login on 401` (`ticketWorkspaceName`);
 *   - issue branch AND worktree folder: `418-retry-login-on-401` (`issueBranchName`), a slug of the
 *     title in ASCII lowercase, at most 40 characters and cut at a `-`, so it reads as words;
 *     a title with nothing ASCII in it (emoji, a script with no Latin transliteration) leaves the
 *     number alone, `418`;
 *   - pull request branch: the head branch's OWN name, unrewritten (`prLocalBranchName`): a
 *     checkout of someone's pull request is on the branch they named, as `gh pr checkout` leaves
 *     it, and `sanitizedGitName` would turn `feat+x`, `fix#12` or `día` into another branch that
 *     pushes nowhere. It must pass `isSafeBranchName` (and, in the daemon, `git check-ref-format
 *     --branch`) instead. When that name is taken, `<head owner>/<head>`, then `pr-<n>`;
 *   - pull request worktree folder: the local branch with `/` made `-` (`prWorktreeName`).
 *
 * One function decides each name, and both the daemon's resolve (the sheet's prefill) and its
 * create (the CLI's `--from`) call it, so the two can never disagree.
 */

import type { TicketKind } from '@kelpi/protocol';

import { sanitizedGitName } from '../git/index.js';
import { isGitHubOwner } from './refs.js';
import { hasInvisibleCharacters, untrustedLine } from './text.js';

/** A title is cut to this many UTF-16 units wherever it is shown or prompted (`untrustedLine`). */
export const TICKET_TITLE_MAX_LENGTH = 200;
/** The slug part of an issue branch (`418-<slug>`). */
export const TICKET_SLUG_MAX_LENGTH = 40;
/** A branch name longer than this is not used (git's own limit is the filesystem's). */
export const BRANCH_NAME_MAX_LENGTH = 200;

/**
 * Latin letters NFKD does not decompose, spelled the way an English branch name would. Everything
 * else outside `a-z0-9` becomes a separator.
 */
const LATIN_FOLDS: Readonly<Record<string, string>> = {
    ß: 'ss',
    æ: 'ae',
    œ: 'oe',
    ø: 'o',
    đ: 'd',
    ð: 'd',
    ł: 'l',
    þ: 'th',
    ı: 'i'
};

/**
 * A title as a branch slug: invisible characters dropped, accents folded to ASCII (`Café` →
 * `cafe`), lowercased, every other run of characters one `-`, trimmed, then cut to at most
 * `maxLength` at the last `-` that fits (a single word longer than that is cut where it hits the
 * limit). `''` when nothing ASCII survives.
 */
export function ticketSlug(title: string, maxLength: number = TICKET_SLUG_MAX_LENGTH): string {
    const folded = untrustedLine(title, Number.MAX_SAFE_INTEGER)
        .toLowerCase()
        .replace(/[ßæœøđðłþı]/g, (letter) => LATIN_FOLDS[letter] ?? letter)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');
    let slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug.length > maxLength) {
        const window = slug.slice(0, maxLength + 1);
        const boundary = window.lastIndexOf('-');
        slug = boundary > 0 ? window.slice(0, boundary) : slug.slice(0, maxLength);
    }
    return slug.replace(/-+$/, '');
}

export interface TicketNameInput {
    /** `#418`. */
    readonly key: string;
    readonly title: string;
}

/** `#418 Retry login on 401`: the key, then the title as one cleaned line (`#418` alone when blank). */
export function ticketWorkspaceName(ticket: TicketNameInput): string {
    const title = untrustedLine(ticket.title, TICKET_TITLE_MAX_LENGTH);
    return title === '' ? ticket.key : `${ticket.key} ${title}`;
}

/** An issue's branch and worktree folder: `418-retry-login-on-401`, or `418` when the title gives no slug. */
export function issueBranchName(number: number, title: string): string {
    const slug = ticketSlug(title);
    return slug === '' ? String(number) : `${number}-${slug}`;
}

/**
 * Whether git would take `name` as a branch (`git check-ref-format --branch`), judged without git
 * and on the strict side: no ASCII control, space or `~ ^ : ? * [ \`, no `..`, `@{` or `//`, not
 * `@`, no leading or trailing `/`, no trailing `.`, no component starting with `.` or ending in
 * `.lock`; and, beyond git, never starting with `-` (it would read as an option) and never holding a
 * character `cleanUntrustedText` drops (a bidi override in a branch name is a spoof, not a name).
 * Unicode, `+`, `#` and `@` otherwise pass: a pull request's head keeps its own spelling.
 */
export function isSafeBranchName(name: string): boolean {
    if (name === '' || name.length > BRANCH_NAME_MAX_LENGTH || name === '@') return false;
    if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
    if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false;
    if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
    if (hasInvisibleCharacters(name)) return false;
    return name.split('/').every((component) => !component.startsWith('.') && !component.endsWith('.lock'));
}

/**
 * What the daemon knows about one local branch of the matched repository:
 *
 *   - `exists: false`: there is no such branch;
 *   - `tracksPullRequest`: its config already points at THIS pull request's head
 *     (`branch.<b>.merge` = `refs/heads/<head>` on the base remote or the head's remote, or
 *     `refs/pull/<n>/head`), or, for a pull request from the same repository, it has no upstream at
 *     all (the author's own branch, before or without `push -u`). Always false for an issue lookup;
 *   - `checkedOutAt`: the checkout it is checked out in (the repository itself or a linked
 *     worktree), or null. A branch can be checked out in only one place, so a new worktree of it
 *     is impossible and the defaults open a workspace at that checkout instead;
 *   - `staleCheckoutAt`: a worktree git still lists for the branch although its folder is gone
 *     (`prunable`: deleted, never `git worktree prune`d), or null (absent = null). No workspace can
 *     open there, and git refuses to check the branch out anywhere else until it is pruned, so the
 *     branch is BUSY: a pull request's checkout takes another name (`prLocalBranchName`), and an
 *     issue's defaults say to prune.
 */
export type LocalBranchFact =
    | { readonly exists: false }
    | {
          readonly exists: true;
          readonly tracksPullRequest: boolean;
          readonly checkedOutAt: string | null;
          readonly staleCheckoutAt?: string | null | undefined;
      };

/** The folder-gone worktree that holds a branch no live checkout has (`LocalBranchFact`), or null. */
export function staleCheckoutOf(fact: LocalBranchFact): string | null {
    return fact.exists && fact.checkedOutAt === null ? (fact.staleCheckoutAt ?? null) : null;
}

/** What a create says about a branch a folder-gone worktree still holds. */
export function staleCheckoutWarning(branch: string, staleAt: string): string {
    return `branch "${untrustedLine(branch, 100)}" is still held by a worktree whose folder is gone (${untrustedLine(staleAt, 200)}): run \`git worktree prune\` in the repository to free it`;
}

/** Synchronous, so the daemon reads the branches once (`for-each-ref` + `worktree list`) and answers from that. */
export type LocalBranchLookup = (name: string) => LocalBranchFact;

/** For a repository that is not registered, or not read: every branch is absent. */
export const NO_LOCAL_BRANCHES: LocalBranchLookup = () => ({ exists: false });

export interface PrLocalBranchInput {
    readonly number: number;
    /** The head branch's name exactly as GitHub reports it (`headRefName`). */
    readonly headRef: string;
    /** The head repository's owner login; null when the fork was deleted. */
    readonly headOwner: string | null;
    /** The base repository's default branch (`main`): a fork's `main` must not check out as ours. */
    readonly baseDefaultBranch: string;
    readonly localBranch: LocalBranchLookup;
}

export type PrLocalBranchDecision =
    | { readonly ok: true; readonly branch: string; readonly fact: LocalBranchFact }
    | { readonly ok: false; readonly error: string };

/**
 * THE local branch name for a pull request's checkout (docs/integrations.md §4). Candidates in order: the head's own
 * name; `<head owner>/<head>` (skipped for a deleted fork); `pr-<n>`. A candidate is taken when it
 * is the base repository's default branch (a fork's `main`), an existing local branch that does
 * not track this pull request (`tracksPullRequest`), or a branch a folder-gone worktree still holds
 * (`staleCheckoutAt`, which git refuses to check out); the first candidate that is free, or already
 * this pull request's, wins. A head name `isSafeBranchName` refuses, or every candidate taken, is
 * an error ready to show.
 */
export function prLocalBranchName(input: PrLocalBranchInput): PrLocalBranchDecision {
    if (!isSafeBranchName(input.headRef)) {
        return {
            ok: false,
            error: `pull request #${input.number}'s head branch "${untrustedLine(input.headRef, 100)}" is not a branch name Kelpi can check out`
        };
    }
    const candidates = [input.headRef];
    if (input.headOwner !== null && isGitHubOwner(input.headOwner)) candidates.push(`${input.headOwner}/${input.headRef}`);
    candidates.push(`pr-${input.number}`);
    const stale: string[] = [];
    for (const candidate of candidates) {
        if (!isSafeBranchName(candidate) || candidate === input.baseDefaultBranch) continue;
        const fact = input.localBranch(candidate);
        // Held by a worktree whose folder is gone: git would refuse it, so it is taken too.
        const staleAt = staleCheckoutOf(fact);
        if (staleAt !== null) {
            stale.push(staleCheckoutWarning(candidate, staleAt));
            continue;
        }
        if (fact.exists && !fact.tracksPullRequest) continue;
        return { ok: true, branch: candidate, fact };
    }
    return {
        ok: false,
        error: [
            `local branches ${candidates.map((name) => `"${untrustedLine(name, 100)}"`).join(', ')} already exist and none of them tracks pull request #${input.number}: rename or delete one`,
            ...stale
        ].join('; ')
    };
}

/** A pull request's worktree folder: its local branch with `/` as `-` (`octocat/main` → `octocat-main`), else `pr-<n>`. */
export function prWorktreeName(branch: string, number: number): string {
    return sanitizedGitName(branch.replace(/\//g, '-')) ?? `pr-${number}`;
}

/** The worktree folder a ticket's checkout goes in, by kind (module note). */
export function ticketWorktreeName(kind: TicketKind, number: number, branch: string): string {
    return kind === 'pr' ? prWorktreeName(branch, number) : branch;
}
