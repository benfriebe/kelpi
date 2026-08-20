/** The daemon-side system-stat sampler (APP-078…085, AGNT-107…112). */

export {
    createSystemStatsSampler,
    pushHistory,
    rateBetween,
    type SystemStatsSampler,
    type SystemStatsSamplerOptions,
    type SystemStatsSnapshot
} from './sampler.js';
export {
    parseDiskStats,
    parseIoreg,
    parseMemInfo,
    parseNetstat,
    parseProcNetDev,
    parseVmStat,
    probeHost,
    readCpuTicks,
    readDiskSpace,
    readLoadAverage,
    type HostProbe
} from './host.js';
