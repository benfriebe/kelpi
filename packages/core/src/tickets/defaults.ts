/**
 * What a create from a ticket does with every field it is not told (docs/integrations.md
 * "Defaults"; `workspace-create`'s `ticket_defaults`, wire-protocol.md §6.3).
 *
 * ONE function, called by the daemon in two places: the resolve that answers the New Workspace
 * sheet (`ticket-resolve`'s `defaults`, which the sheet prefills and the user may change) and the
 * create that fills a CLI request's blanks (`kelpi workspace create --from`). So the sheet shows
 * exactly what the CLI would do.
 *
 *   issue, its branch new                 new worktree on `418-<slug>`, off the freshly fetched
 *                                         default branch (`new-branch`, update main on)
 *   issue, its branch already made        new worktree on that branch, nothing fetched
 *                                         (`attach-branch`, update main off)
 *   pull request                          new worktree on the local branch `prLocalBranchName`
 *                                         picks, tracking the head (`pr-head`, update main off)
 *   the branch already checked out        no worktree: the workspace opens where it is checked out
 *                                         (`existing-checkout`); git cannot check one branch out
 *                                         twice, and that checkout is where the work already is
 *
 * The prompt is always the `ticket-file` variant here: at resolve time the file has not been
 * written yet, and a create that then fails to write it re-renders (`withoutTicketFileReference`).
 */

import type { TicketKind, TicketPromptVariant, TicketResolveDefaults, WorkspaceCheckoutMode } from '@kelpi/protocol';

import {
    issueBranchName,
    prLocalBranchName,
    ticketWorkspaceName,
    ticketWorktreeName,
    type LocalBranchFact,
    type LocalBranchLookup
} from './names.js';
import { renderTicketPrompt, ticketPromptVars } from './template.js';

export interface TicketDefaultsPullRequest {
    readonly headRef: string;
    /** Null when the fork was deleted. */
    readonly headOwner: string | null;
    /** The branch the pull request merges into. */
    readonly baseRef: string;
    /** The base repository's default branch. */
    readonly baseDefaultBranch: string;
}

export interface TicketDefaultsInput {
    readonly kind: TicketKind;
    readonly number: number;
    /** `#418`. */
    readonly key: string;
    readonly title: string;
    readonly url: string;
    /** `owner/name`. */
    readonly repo: string;
    readonly author: string | null;
    readonly labels: readonly string[];
    /** The registered repository the ticket matched, or null. */
    readonly repoID: string | null;
    /** Required for a pull request, ignored for an issue. */
    readonly pullRequest: TicketDefaultsPullRequest | null;
    /** The matched repository's local branches (`NO_LOCAL_BRANCHES` when there is none). */
    readonly localBranch: LocalBranchLookup;
}

export interface TicketCreateDefaults {
    readonly name: string;
    readonly repoID: string | null;
    /** Null for `existing-checkout`, and when no branch can be used. */
    readonly worktree: string | null;
    /** Null when no branch can be used (`warnings` says why). */
    readonly branch: string | null;
    readonly checkout: WorkspaceCheckoutMode;
    readonly updateMain: boolean;
    readonly prompt: string;
    readonly promptVariant: TicketPromptVariant;
    /** Where `branch` is already checked out (`existing-checkout` opens there), or null. */
    readonly checkedOutAt: string | null;
    readonly warnings: readonly string[];
}

function checkedOutAt(fact: LocalBranchFact): string | null {
    return fact.exists ? fact.checkedOutAt : null;
}

/** The defaults for one ticket (module note). */
export function ticketCreateDefaults(input: TicketDefaultsInput): TicketCreateDefaults {
    const name = ticketWorkspaceName(input);
    const warnings: string[] = [];
    let branch: string | null;
    let checkout: WorkspaceCheckoutMode;
    let updateMain = false;
    let where: string | null = null;

    if (input.kind === 'pr') {
        const pr = input.pullRequest;
        const decision =
            pr === null
                ? ({ ok: false, error: `pull request #${input.number} has no head branch` } as const)
                : prLocalBranchName({
                      number: input.number,
                      headRef: pr.headRef,
                      headOwner: pr.headOwner,
                      baseDefaultBranch: pr.baseDefaultBranch,
                      localBranch: input.localBranch
                  });
        if (decision.ok) {
            branch = decision.branch;
            where = checkedOutAt(decision.fact);
        } else {
            branch = null;
            warnings.push(decision.error);
        }
        checkout = where === null ? 'pr-head' : 'existing-checkout';
    } else {
        branch = issueBranchName(input.number, input.title);
        const fact = input.localBranch(branch);
        where = checkedOutAt(fact);
        checkout = where !== null ? 'existing-checkout' : fact.exists ? 'attach-branch' : 'new-branch';
        updateMain = checkout === 'new-branch';
    }

    const worktree = checkout === 'existing-checkout' || branch === null ? null : ticketWorktreeName(input.kind, input.number, branch);
    const vars = ticketPromptVars({
        kind: input.kind,
        number: input.number,
        key: input.key,
        title: input.title,
        url: input.url,
        repo: input.repo,
        branch: branch ?? input.pullRequest?.headRef ?? null,
        base: input.pullRequest?.baseRef ?? null,
        author: input.author,
        labels: input.labels
    });
    return {
        name,
        repoID: input.repoID,
        worktree,
        branch,
        checkout,
        updateMain,
        prompt: renderTicketPrompt(input.kind, vars, 'ticket-file'),
        promptVariant: 'ticket-file',
        checkedOutAt: where,
        warnings
    };
}

/** The wire form `ticket-resolve` answers with (snake_case; `checkedOutAt` and `warnings` ride beside it). */
export function serializeTicketDefaults(defaults: TicketCreateDefaults): TicketResolveDefaults {
    return {
        name: defaults.name,
        repo_id: defaults.repoID,
        worktree: defaults.worktree,
        branch: defaults.branch,
        checkout: defaults.checkout,
        update_main: defaults.updateMain,
        prompt: defaults.prompt,
        prompt_variant: defaults.promptVariant
    };
}
