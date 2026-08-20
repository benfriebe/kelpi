/**
 * Library surface of the CLI package: the pure pieces other code (and the tests) reuse.
 * The executable entry point is `main.ts`, bundled to `dist/nex.js`.
 */

export { run, configure } from './cli.js';
export * from './args.js';
export * from './routing.js';
export * from './json.js';
export * from './table.js';
export { countBackgroundTasks, TERMINAL_TASK_STATUSES } from './commands/event.js';
export { pruneWorktree } from './commands/workspace.js';
export * from './install/spec.js';
export * from './install/merge.js';
export * from './install/hooks.js';
export * from './install/link.js';
export * from './install/self.js';
export * from './install/skill.js';
export { nodeInstallFs, type InstallFs } from './install/fs.js';
export * from './doctor/checks.js';
export * from './doctor/hooks.js';
export * from './doctor/types.js';
export {
    describeTransportFailure,
    resolveTransport,
    type Transport,
    type TransportFailure
} from './transport.js';
export { resolveCliIdentity, CLI_VERSION, CLI_BUILD, type CliIdentity } from './version.js';
