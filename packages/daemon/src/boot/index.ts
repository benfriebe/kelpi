/**
 * WP2.8b — boot: the composition root and the `kelpid` entrypoint's building blocks.
 *
 * `createDaemon(options).start()` is the whole daemon: seams wired, listeners bound, the
 * spec's restore ordering performed. `src/main.ts` adds only argument parsing and the
 * detach/stop/status verbs on top of it.
 */

export {
    ALLOW_EPHEMERAL_STATE_ENV,
    createDaemon,
    DEFAULT_WORKSPACE_NAME,
    HTTP_HOST_ENV,
    HTTP_PORT_ENV,
    PERSISTENCE_DEGRADED_EVENT,
    persistenceDegradedEvent,
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
export {
    collectMissingLabelPresets,
    MIGRATED_LABEL_PRESET_COLOR,
    runLabelPresetMigration,
    type LabelPresetMigrationDeps,
    type LabelPresetMigrationOutcome
} from './labels.js';
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
export {
    maintainLegacyCompatSocket,
    migrateLegacyState,
    type LegacyCompatSocketOptions,
    type LegacyMigrationLookup
} from './legacy-migration.js';
