/**
 * M7 — the graft engine and the git long tail.
 *
 * Spec: docs/current/graft-git.md. The engine (`service.ts`) owns sessions, the tree-based
 * sync, breadcrumbs and the derived root claim; `watcher.ts` / `head-watcher.ts` own watcher
 * discipline; `associations.ts` bridges the store's repo associations to both watchers and to
 * the unconditional force-stop every removal path owes graft; `wire.ts` renders the `graft-*`
 * replies and the `graft-changed` WS broadcast.
 *
 * Wiring: `boot/compose.ts` creates the service, hands it to `handlers/app/graft.ts` (the
 * three wire verbs), fans session events out to clients, and flushes every session on
 * shutdown so a clean quit never leaves a breadcrumb behind.
 */

export {
    BREADCRUMB_FILENAME,
    BREADCRUMB_VERSION,
    breadcrumbPath,
    decodeBreadcrumb,
    encodeBreadcrumb,
    readBreadcrumb,
    removeBreadcrumb,
    writeBreadcrumb,
    type GraftBreadcrumb
} from './breadcrumb.js';

export {
    describeSyncError,
    errorText,
    GraftError,
    graftErrorKind,
    isGraftError,
    type GraftErrorKind
} from './errors.js';

export {
    canonicalizePath,
    canonicalizeUserPath,
    directoryExists,
    lastPathComponent,
    type RealpathFn
} from './paths.js';

export {
    createGraftService,
    GRAFT_SHUTDOWN_GRACE_MS,
    stashMessageFor,
    type CreateGraftServiceOptions,
    type GraftGit,
    type GraftService
} from './service.js';

export type {
    GraftAssociation,
    GraftOrphan,
    GraftSession,
    GraftSessionEvent,
    GraftSessionStatus
} from './types.js';

export {
    GRAFT_IGNORED_COMPONENTS,
    GRAFT_WATCH_DEBOUNCE_MS,
    isIgnoredPath,
    watchRecursive,
    type RecursiveWatcher,
    type RecursiveWatchFn,
    type WatchRecursiveOptions
} from './watcher.js';

export {
    createHeadWatchService,
    HEAD_CHANGE_DEBOUNCE_MS,
    type CreateHeadWatchServiceOptions,
    type HeadWatchFn,
    type HeadWatchService
} from './head-watcher.js';

export {
    createRepoAssociationWatch,
    GIT_STATUS_POLL_MS,
    type CreateRepoAssociationWatchOptions,
    type RepoAssociationWatchService
} from './associations.js';

export {
    GRAFT_CHANGED_EVENT,
    GRAFT_ORPHANS_EVENT,
    graftChangedEvent,
    graftOrphanEntry,
    graftOrphansEvent,
    graftSessionEntry,
    graftStartedEntry
} from './wire.js';
