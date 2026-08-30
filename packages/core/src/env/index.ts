/** Public surface of the spawn-environment module (WP1.4). */

export {
    DEFAULT_PROFILE_NAME,
    FALLBACK_PATH,
    KELPI_PANE_ID_ENV_KEY,
    KELPI_PROFILE_ENV_KEY,
    KELPI_SOCKET_ENV_KEY,
    RESERVED_ENV_KEYS,
    buildPanePath,
    effectiveProfileName,
    isDefinedProfile,
    mergedEnvVars,
    normalizedAssignment,
    paneSpawnEnvVars,
    resolveProfileEnv
} from './merged-env.js';
export type { EnvVar, MergedEnvInput, PaneSpawnEnvInput } from './merged-env.js';
