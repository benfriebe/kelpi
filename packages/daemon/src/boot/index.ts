/**
 * WP2.8b — boot: the composition root and the `nexd` entrypoint's building blocks.
 *
 * `createDaemon(options).start()` is the whole daemon: seams wired, listeners bound, the
 * spec's restore ordering performed. `src/main.ts` adds only argument parsing and the
 * detach/stop/status verbs on top of it.
 */

export {
    createDaemon,
    DEFAULT_WORKSPACE_NAME,
    HTTP_HOST_ENV,
    HTTP_PORT_ENV,
    type Daemon,
    type DaemonInfo,
    type DaemonOptions
} from './compose.js';
export {
    CONFIG_PATH_ENV,
    configuredTcpPort,
    createProfileReader,
    loadDaemonConfig,
    readConfigContents,
    resolveConfigPath,
    type ConfigLookup,
    type DaemonConfig,
    type LoadConfigOptions
} from './config.js';
export {
    GHOSTTY_CONFIG_PATH_ENV,
    SettingsError,
    buildSettingsSnapshot,
    contentAppearanceOf,
    createSettingsService,
    keybindLinesFrom,
    parseGhosttyAppearance,
    resolveGhosttyConfigPath,
    watchConfigFile,
    type GhosttyAppearance,
    type SettingsService,
    type SettingsServiceOptions,
    type SettingsSnapshot
} from '../settings/index.js';
export {
    createDispatcher,
    mergeHandlerTables,
    unknownCommandError,
    type DispatcherOptions
} from './dispatch.js';
export { clearPortFile, portFilePath, readPortFile, writePortFile } from './port.js';
export {
    runRestorePipeline,
    spawnRestoredPanes,
    typeResumeCommands,
    type RestoreDeps,
    type ResumeDeps,
    type ResumeOutcome
} from './resume.js';
export {
    BUILD_ENV,
    DAEMON_BUILD,
    DAEMON_VERSION,
    resolveDaemonVersion,
    VERSION_ENV,
    type DaemonVersion
} from './version.js';
