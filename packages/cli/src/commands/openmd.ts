/**
 * `kelpi open`, `kelpi md`, `kelpi diff` (cli.md §13) — routing, not policy.
 *
 * `kelpi open` decides between a web pane and a markdown pane **in the CLI**, reusing wire
 * commands that already exist (`web-open` / `open`). The decision order is the contract:
 *   1. `webTargetForOpenArg` — a real URL, a `host:port`, `localhost`, an IPv4 literal or a
 *      bare dotted host with a known TLD goes to a web pane (and `--here` is ignored with a
 *      stderr note, because a web pane always opens fresh);
 *   2. otherwise route the local file by lowercased extension: markdown extensions open a
 *      preview pane (honouring `--here`), web extensions open a web pane as a `file://` URL;
 *   3. anything else is a usage error pointing at `kelpi md` / `kelpi web open`.
 *
 * `kelpi md` skips step 1 entirely — it is the escape hatch that forces a markdown pane on any
 * file. Both forward `NEX_PANE_ID` even when it is an EMPTY string (a plain `if let` in the
 * Swift source, no `isEmpty` check), unlike everything else in the CLI.
 */

import path from 'node:path';

import { isHelpToken, popSwitch } from '../args.js';
import { homeDirectory, rawPaneID } from '../env.js';
import { errLine, exit, printLine } from '../io.js';
import type { JsonObject } from '../json.js';
import { fileURLString, markdownOpenExtensions, pathExtensionLower, webOpenExtensions, webTargetForOpenArg } from '../routing.js';
import { sendJSON } from '../transport.js';
import { sendWebOpen } from './web.js';

function routingContext(): { cwd: string; home: string } {
    return { cwd: process.cwd(), home: homeDirectory() };
}

/** Fire-and-forget `open` — the markdown route shared by `kelpi md` and `kelpi open`. */
async function sendMarkdownOpen(absolutePath: string, reuse: boolean): Promise<void> {
    const payload: JsonObject = { command: 'open', path: absolutePath };
    const paneID = rawPaneID();
    // Note: forwarded even when EMPTY (Swift parity).
    if (paneID !== undefined) payload['pane_id'] = paneID;
    if (reuse) payload['reuse'] = true;
    await sendJSON(payload);
}

export async function handleMarkdown(args: string[]): Promise<void> {
    const first = args[0];
    if (first !== undefined && isHelpToken(first)) {
        printLine('Usage: kelpi md [--here] <filepath>');
        exit(0);
    }
    const reuse = popSwitch('--here', args);
    const filePath = args.shift();
    if (filePath === undefined || filePath.startsWith('-')) {
        errLine('Usage: kelpi md [--here] <filepath>');
        exit(1);
    }
    await sendMarkdownOpen(path.resolve(process.cwd(), filePath), reuse);
}

export async function handleOpen(args: string[]): Promise<void> {
    const first = args[0];
    if (first !== undefined && isHelpToken(first)) {
        printLine('Usage: kelpi open [--here] <path-or-url>');
        printLine('URLs & hostnames (google.com, https://…, localhost:3000) → web pane.');
        printLine('Local files route by type: .md/.markdown → markdown pane;');
        printLine('.html/.htm/.pdf/.svg and images (.png/.jpg/.gif/.webp) → web pane.');
        exit(0);
    }
    const reuse = popSwitch('--here', args);
    const argument = args.shift();
    if (argument === undefined || argument.startsWith('-')) {
        errLine('Usage: kelpi open [--here] <path-or-url>');
        exit(1);
    }

    const webTarget = webTargetForOpenArg(argument, routingContext());
    if (webTarget !== null) {
        if (reuse) errLine('kelpi open: --here is ignored for URLs (web panes always open in a new pane)');
        await sendWebOpen(webTarget);
        return;
    }

    const absolutePath = path.resolve(process.cwd(), argument);
    const extension = pathExtensionLower(absolutePath);

    if (markdownOpenExtensions.has(extension)) {
        await sendMarkdownOpen(absolutePath, reuse);
        return;
    }
    if (webOpenExtensions.has(extension)) {
        if (reuse) errLine('kelpi open: --here is ignored for web files (web panes always open in a new pane)');
        await sendWebOpen(fileURLString(absolutePath, false));
        return;
    }
    const shown = extension.length === 0 ? 'files without an extension' : `'.${extension}' files`;
    errLine(`kelpi open: don't know how to open ${shown}`);
    errLine('       URLs & hostnames (e.g. google.com) open a web pane;');
    errLine('       Markdown (.md, .markdown) opens a preview pane; .html/.htm/.pdf/.svg and');
    errLine('       images (.png/.jpg/.gif/.webp) open a web pane.');
    errLine('       Use `kelpi md <file>` to force a markdown pane, or `kelpi web open <url>`.');
    exit(1);
}

export async function handleDiff(args: string[]): Promise<void> {
    const cwd = process.cwd();
    const payload: JsonObject = { command: 'diff', repo_path: cwd };
    const target = args.shift();
    if (target !== undefined) payload['target_path'] = path.resolve(cwd, target);
    const paneID = rawPaneID();
    if (paneID !== undefined) payload['pane_id'] = paneID;
    // Extra positionals beyond the first are silently ignored; there is no help flag.
    await sendJSON(payload);
}
