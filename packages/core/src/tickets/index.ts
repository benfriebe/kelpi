/**
 * Tickets: GitHub issues and pull requests as the starting point of a workspace
 * (docs/integrations.md). Pure string work with no Node imports, like `@kelpi/core/git`: the
 * daemon resolves and creates with it, and the client and the CLI may take any of it.
 *
 *   refs.ts         what a pasted reference or a remote URL names
 *   names.ts        the workspace name, branch and worktree folder a ticket gets
 *   text.ts         untrusted text made safe for a name, a prompt or a file
 *   template.ts     the agent prompt (one renderer, the default templates)
 *   ticket-file.ts  the `.kelpi/ticket-<n>.md` an agent reads first
 *   search.ts       the picker's GitHub search queries
 *   defaults.ts     what a create does with every field it is not told
 *   tracking.ts     which remote is a ticket's repository, and which branch is a pull request's
 */

export {
    gitHubOwnersFromRemotes,
    gitHubRepoKey,
    gitHubTicketKey,
    gitHubTicketURL,
    isGitHubOwner,
    isGitHubRepoName,
    parseGitHubRemote,
    parseTicketRef,
    replaceGitHubRemoteRepo,
    sameGitHubRepo,
    ticketIdentity
} from './refs.js';
export type { GitHubRemote, GitHubTicketRef, TicketIdentityInput } from './refs.js';
export {
    BRANCH_NAME_MAX_LENGTH,
    NO_LOCAL_BRANCHES,
    TICKET_SLUG_MAX_LENGTH,
    TICKET_TITLE_MAX_LENGTH,
    isSafeBranchName,
    issueBranchName,
    prLocalBranchName,
    prWorktreeName,
    ticketSlug,
    ticketWorkspaceName,
    ticketWorktreeName
} from './names.js';
export type { LocalBranchFact, LocalBranchLookup, PrLocalBranchDecision, PrLocalBranchInput, TicketNameInput } from './names.js';
export { capText, capUtf8, cleanUntrustedText, hasInvisibleCharacters, neutralizeMentions, untrustedLine, utf8ByteLength } from './text.js';
export type { CappedText } from './text.js';
export {
    DEFAULT_TICKET_PROMPT_TEMPLATES,
    TICKET_PROMPT_VARIABLES,
    renderTemplate,
    renderTicketPrompt,
    ticketPromptVars,
    withoutTicketFileReference
} from './template.js';
export type { RenderedTemplate, TicketPromptInput, TicketPromptVariable, TicketPromptVars } from './template.js';
export {
    TICKET_FILE_BODY_MAX_BYTES,
    TICKET_FILE_COMMENT_MAX_BYTES,
    TICKET_FILE_DIRECTORY,
    TICKET_FILE_DIRECTORY_GITIGNORE,
    TICKET_FILE_MAX_COMMENTS,
    TICKET_FILE_MAX_REVIEW_COMMENTS,
    renderTicketFile,
    ticketFileFooter,
    ticketFilePath
} from './ticket-file.js';
export type { TicketFileComment, TicketFileDetail, TicketFileReviewComment } from './ticket-file.js';
export { DEFAULT_TICKET_SEARCHES, GITHUB_SEARCH_QUERY_MAX_LENGTH, buildTicketSearchQueries } from './search.js';
export type { TicketSearchOwner, TicketSearchPlan, TicketSearchQuery } from './search.js';
export { serializeTicketDefaults, ticketCreateDefaults } from './defaults.js';
export type { TicketCreateDefaults, TicketDefaultsInput, TicketDefaultsPullRequest } from './defaults.js';
export { bestRemoteFor, pullRequestUpstreamPointsAt, remoteFetchesFrom, remoteRank, tracksPullRequest } from './tracking.js';
export type { BranchUpstream, PullRequestRemotes, TicketRemote, TrackedPullRequest, UpstreamPointsAt } from './tracking.js';
