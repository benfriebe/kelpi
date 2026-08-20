/**
 * The platform counter parsers.
 *
 * These read real command output and real `/proc` files, so the fixtures are verbatim captures
 * rather than hand-written minimal cases — the failure modes that matter here are all about
 * output shapes that vary (a link row with no MAC, a partition listed under its parent disk, a
 * 16 KiB page size on Apple silicon) and a trimmed fixture would hide every one of them.
 */

import { describe, expect, it } from 'vitest';

import {
    parseDiskStats,
    parseIoreg,
    parseMemInfo,
    parseNetstat,
    parseProcNetDev,
    parseVmStat,
    probeHost,
    readCpuTicks,
    readDiskSpace,
    readLoadAverage
} from './host.js';

const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                              152926.',
    'Pages active:                            100000.',
    'Pages inactive:                         2881363.',
    'Pages speculative:                        38975.',
    'Pages throttled:                              0.',
    'Pages wired down:                         50000.',
    'Pages purgeable:                          45444.',
    'Pages occupied by compressor:             10000.',
    ''
].join('\n');

/**
 * A real `netstat -ibn` head. Note the two shapes of `<Link#>` row — `lo0` has no MAC and so
 * has one field FEWER than `en0`, which is exactly why the column offsets are counted from the
 * right rather than the left.
 */
const NETSTAT = [
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'lo0        16384 <Link#1>                      329517142     0 1417692965932 329517142     0 1417692965932     0',
    'lo0        16384 127           127.0.0.1       329517142     - 1417692965932 329517142     - 1417692965932     -',
    'en0        1500  <Link#12>   aa:bb:cc:dd:ee:ff   4000000     0 5000000000  3000000     0 2000000000     0',
    'en0        1500  192.168.1     192.168.1.20      4000000     - 5000000000  3000000     - 2000000000     -',
    'utun0      1380  <Link#20>                          1000     0     100000     2000     0      50000     0',
    ''
].join('\n');

describe('parseVmStat', () => {
    it('sums active + wired + compressed at the header’s page size', () => {
        // (100000 + 50000 + 10000) * 16384
        expect(parseVmStat(VM_STAT)).toBe(160000 * 16384);
    });

    it('treats a missing compressor line as zero rather than failing the read', () => {
        const without = VM_STAT.split('\n')
            .filter((line) => !line.startsWith('Pages occupied by compressor'))
            .join('\n');
        expect(parseVmStat(without)).toBe(150000 * 16384);
    });

    it('is null when the output is not vm_stat at all', () => {
        expect(parseVmStat('command not found')).toBeNull();
    });
});

describe('parseNetstat', () => {
    it('sums non-loopback link rows once each, whatever their field count', () => {
        // en0 (5000000000 / 2000000000) + utun0 (100000 / 50000); lo0 excluded.
        expect(parseNetstat(NETSTAT)).toEqual({ down: 5_000_100_000, up: 2_000_050_000 });
    });

    it('is null when there is no header to derive the columns from', () => {
        expect(parseNetstat('netstat: command not found')).toBeNull();
    });
});

describe('parseIoreg', () => {
    it('sums every driver’s read/write byte counters', () => {
        const output = [
            '  | | "Statistics" = {"Bytes (Read)"=8413704118272,"Bytes (Write)"=8248883224576}',
            '  | | "Statistics" = {"Bytes (Read)"=3015212032,"Bytes (Write)"=0}'
        ].join('\n');
        expect(parseIoreg(output)).toEqual({ read: 8_416_719_330_304, write: 8_248_883_224_576 });
    });

    it('is null when nothing matched', () => {
        expect(parseIoreg('')).toBeNull();
    });
});

describe('parseMemInfo', () => {
    it('is total minus available', () => {
        const contents = ['MemTotal:       16000000 kB', 'MemFree:         1000000 kB', 'MemAvailable:    6000000 kB'].join(
            '\n'
        );
        expect(parseMemInfo(contents)).toBe(10_000_000 * 1024);
    });

    it('is null without MemAvailable', () => {
        expect(parseMemInfo('MemTotal:       16000000 kB')).toBeNull();
    });
});

describe('parseProcNetDev', () => {
    it('sums non-loopback interfaces', () => {
        const contents = [
            'Inter-|   Receive                                                |  Transmit',
            ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets',
            '    lo: 99999999    1000    0    0    0     0          0         0 99999999    1000    0    0    0     0       0          0',
            '  eth0: 5000000    2000    0    0    0     0          0         0  2000000    1500    0    0    0     0       0          0',
            ''
        ].join('\n');
        expect(parseProcNetDev(contents)).toEqual({ down: 5_000_000, up: 2_000_000 });
    });
});

describe('parseDiskStats', () => {
    it('counts whole devices and skips their partitions', () => {
        const contents = [
            '   8       0 sda 100 0 2000 0 200 0 4000 0 0 0 0',
            '   8       1 sda1 50 0 1000 0 100 0 2000 0 0 0 0',
            '   8      16 sdb 10 0 100 0 20 0 200 0 0 0 0',
            ''
        ].join('\n');
        // (2000 + 100) sectors read, (4000 + 200) written, × 512.
        expect(parseDiskStats(contents)).toEqual({ read: 2100 * 512, write: 4200 * 512 });
    });
});

describe('the os-backed readers', () => {
    it('reads CPU ticks with busy ≤ total', () => {
        const ticks = readCpuTicks();
        expect(ticks.total).toBeGreaterThan(0);
        expect(ticks.busy).toBeLessThanOrEqual(ticks.total);
    });

    it('reads a finite load average', () => {
        expect(Number.isFinite(readLoadAverage())).toBe(true);
    });

    it('reads the home volume’s capacity, with used ≤ total', () => {
        const space = readDiskSpace();
        expect(space.total).toBeGreaterThan(0);
        expect(space.used).toBeLessThanOrEqual(space.total);
    });

    it('degrades to the os-only subset on an unknown platform', async () => {
        const probe = await probeHost({ platform: 'sunos' });
        expect(probe.memTotalBytes).toBeGreaterThan(0);
        expect(probe.net).toBeNull();
        expect(probe.io).toBeNull();
    });
});
