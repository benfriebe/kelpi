/**
 * Git's own progress meter, read off stderr (issue #294, graft-git.md §8.5).
 *
 * `git fetch --progress` and a checkout's "Updating files" write a status line and then rewrite
 * it in place: each update ends in `\r` when git thinks it is talking to a terminal, and in `\n`
 * when it does not, and a fetch's `remote:` lines arrive relayed with either. Chunks split lines
 * anywhere, so the parser buffers the unterminated tail and only reads a line once its
 * terminator has arrived; `end()` reads whatever is left.
 *
 * Only lines of the `<Phase>: <n>% (<done>/<total>)` shape are progress. Everything else (the
 * `From …` line, `fatal:`, `remote: Total …`) is not, which is also what `stripGitProgress` uses
 * to take the meter back out of an error message.
 */

export interface GitProgress {
    /** `Receiving objects`, `Resolving deltas`, `Updating files`, `Counting objects`, … */
    readonly phase: string;
    /** 0–100, as git printed it. */
    readonly percent: number;
    readonly current: number;
    readonly total: number;
    /** True for a phase git ran on the remote side (`remote: Counting objects`). */
    readonly remote: boolean;
}

/**
 * `remote: Counting objects:  45% (18/40)` and `Receiving objects:  45% (18/40), 1.2 MiB | …`.
 * The phase is letters and spaces only, so a path or a ref in some other line can never match.
 */
const PROGRESS_LINE = /^(remote:\s+)?([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%\s+\((\d+)\/(\d+)\)/;

/** One line (terminator already removed) → its progress, or null when it is not a meter line. */
export function parseGitProgressLine(line: string): GitProgress | null {
    const match = PROGRESS_LINE.exec(line.trim());
    if (match === null) return null;
    const percent = Number(match[3]);
    const current = Number(match[4]);
    const total = Number(match[5]);
    if (!Number.isFinite(percent) || percent > 100) return null;
    return { phase: match[2] ?? '', percent, current, total, remote: match[1] !== undefined };
}

export interface GitProgressParser {
    /** Feed a stderr chunk; every completed meter line in it is reported, in order. */
    push(chunk: string): void;
    /** Flush the unterminated tail (git's last line can end without a terminator). */
    end(): void;
}

export function createGitProgressParser(onProgress: (progress: GitProgress) => void): GitProgressParser {
    let tail = '';
    const read = (line: string): void => {
        const progress = parseGitProgressLine(line);
        if (progress !== null) onProgress(progress);
    };
    return {
        push(chunk) {
            const text = tail + chunk;
            const segments = text.split(/\r\n|\r|\n/);
            // The last segment has no terminator yet: keep it for the next chunk.
            tail = segments.pop() ?? '';
            for (const segment of segments) read(segment);
        },
        end() {
            const rest = tail;
            tail = '';
            if (rest !== '') read(rest);
        }
    };
}

/**
 * Stderr with the meter taken out, for an error message: `\r`-rewritten lines become separate
 * lines, meter lines are dropped, and blank lines go. `worktreeErrorMessage` then finds the
 * `fatal:` line the way it always has, and its "last line" fallback cannot land on a percentage.
 */
export function stripGitProgress(stderr: string): string {
    return stderr
        .split(/\r\n|\r|\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== '' && parseGitProgressLine(line) === null)
        .join('\n')
        .trim();
}
