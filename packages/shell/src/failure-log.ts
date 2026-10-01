/**
 * One warning per outage instead of one per reconnect attempt (#312).
 *
 * The status socket and the web host each retry a dead daemon with backoff, and each failed
 * attempt used to log its own warning: a daemon stopped overnight left thousands of identical
 * `socket error: connect ECONNREFUSED` lines. This logs the first failure of a run of them, then
 * every `every`th with a count, and says how many there were once a connection works again.
 */

export interface FailureLog {
    /** A connect attempt failed. */
    failed(message: string): void;
    /** A connection worked; returns how many attempts had failed before it. */
    recovered(): number;
}

export function createFailureLog(label: string, emit: (line: string) => void, every = 20): FailureLog {
    let failures = 0;
    return {
        failed(message: string): void {
            failures += 1;
            if (failures === 1) emit(`${label}: ${message}`);
            else if (failures % every === 0) emit(`${label}: ${message} (${String(failures)} failed attempts so far)`);
        },
        recovered(): number {
            const count = failures;
            failures = 0;
            return count;
        }
    };
}
