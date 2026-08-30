/**
 * The one filesystem seam the installer runs through.
 *
 * Everything `kelpi install-hooks` touches lives under a directory the caller names
 * (`--claude-dir` / `--codex-dir` / `--install-dir`), and every one of those defaults to a path
 * in the *user's real home*. So the installer never calls `node:fs` directly: it calls this
 * interface, the production binding is at the bottom of the file, and tests bind a fixture root
 * instead. A test that reached `~/.claude` would rewrite the developer's own agent config.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface InstallFs {
    /** File contents, or null when the file is absent or unreadable. */
    readFile(file: string): string | null;
    writeFile(file: string, contents: string): void;
    /** `lstat`-based: a dangling symlink still "exists". */
    exists(file: string): boolean;
    isDirectory(dir: string): boolean;
    mkdirp(dir: string): void;
    /** Byte-for-byte copy, used for the pre-write backup. */
    copyFile(from: string, to: string): void;
    /** `readlink`, or null when the path is not a symlink. */
    readLink(file: string): string | null;
    /** True when the path is a symlink (dangling included). */
    isSymlink(file: string): boolean;
    /** Remove a file or symlink; a missing path is not an error. */
    remove(file: string): void;
    symlink(target: string, linkPath: string): void;
    /** Real path of a file, following symlinks; null when it cannot be resolved. */
    realPath(file: string): string | null;
    /** Is this path writable by the current user? (`access(W_OK)`) */
    isWritable(file: string): boolean;
}

export const nodeInstallFs: InstallFs = {
    readFile(file) {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
    },
    writeFile(file, contents) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents, 'utf8');
    },
    exists(file) {
        try {
            fs.lstatSync(file);
            return true;
        } catch {
            return false;
        }
    },
    isDirectory(dir) {
        try {
            return fs.statSync(dir).isDirectory();
        } catch {
            return false;
        }
    },
    mkdirp(dir) {
        fs.mkdirSync(dir, { recursive: true });
    },
    copyFile(from, to) {
        fs.copyFileSync(from, to);
    },
    readLink(file) {
        try {
            return fs.readlinkSync(file);
        } catch {
            return null;
        }
    },
    isSymlink(file) {
        try {
            return fs.lstatSync(file).isSymbolicLink();
        } catch {
            return false;
        }
    },
    remove(file) {
        try {
            fs.unlinkSync(file);
        } catch {
            // Already gone, or a directory we were never going to replace anyway.
        }
    },
    symlink(target, linkPath) {
        fs.symlinkSync(target, linkPath);
    },
    realPath(file) {
        try {
            return fs.realpathSync(file);
        } catch {
            return null;
        }
    },
    isWritable(file) {
        try {
            fs.accessSync(file, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    }
};
