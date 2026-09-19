/** Read-only forwarding diagnostics. A refused connection is not proof of ownership. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export type ForwardTargetState = 'listening' | 'refused' | 'unknown';
export type LoopbackHost = '127.0.0.1' | 'localhost' | '::1';
export type ForwardTargetProbe = (host: LoopbackHost, port: number) => Promise<ForwardTargetState>;

/** TCP only: send no application data or credentials to a possibly unrelated service. */
function probeAddress(host: string, port: number, timeoutMs: number): Promise<ForwardTargetState> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const finish = (state: ForwardTargetState): void => {
            clearTimeout(timer);
            socket.destroy();
            resolve(state);
        };
        // A wall-clock deadline, including connection setup; a timeout is never "unused".
        const timer = setTimeout(() => finish('unknown'), timeoutMs);
        socket.once('connect', () => finish('listening'));
        socket.once('error', (error: NodeJS.ErrnoException) =>
            finish(error.code === 'ECONNREFUSED' ? 'refused' : 'unknown')
        );
        try {
            socket.connect(port, host);
        } catch {
            finish('unknown');
        }
    });
}

/** localhost may reach either family: only two refusals establish a refused target. */
export async function probeForwardTarget(
    host: LoopbackHost,
    port: number,
    timeoutMs = 1000
): Promise<ForwardTargetState> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'unknown';
    const addresses = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
    const states = await Promise.all(addresses.map((address) => probeAddress(address, port, timeoutMs)));
    if (states.includes('listening')) return 'listening';
    return states.every((state) => state === 'refused') ? 'refused' : 'unknown';
}

export interface ForwardingRecord {
    readonly version: 1;
    readonly dnsName: string;
    readonly port: number;
    readonly configuredAt: string;
    readonly binary?: string | undefined;
}

/** Diagnostic history only, never authorization to replace a service. */
export function readForwardingRecord(file: string): ForwardingRecord | undefined {
    try {
        const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof value !== 'object' || value === null) return undefined;
        const record = value as Record<string, unknown>;
        if (
            record['version'] !== 1 ||
            typeof record['dnsName'] !== 'string' || record['dnsName'].length === 0 ||
            typeof record['port'] !== 'number' || !Number.isInteger(record['port']) ||
            record['port'] < 1 || record['port'] > 65535 ||
            typeof record['configuredAt'] !== 'string' || !Number.isFinite(Date.parse(record['configuredAt'])) ||
            (record['binary'] !== undefined && typeof record['binary'] !== 'string')
        ) return undefined;
        return record as unknown as ForwardingRecord;
    } catch {
        return undefined;
    }
}

/** Atomic, private, and kept across daemon restarts alongside the remembered HTTP port. */
export function writeForwardingRecord(file: string, record: ForwardingRecord): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}
