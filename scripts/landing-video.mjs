#!/usr/bin/env node
/**
 * Record the landing page's session video (`site/assets/video/kelpi-session.*`) from a sandboxed
 * Kelpi running real Claude Code agents.
 *
 *     node scripts/landing-video.mjs                    # build, record a take, edit, encode
 *     node scripts/landing-video.mjs --no-build         # reuse the bundles already on disk
 *     node scripts/landing-video.mjs --edit <take-dir>  # re-edit and re-encode a recorded take
 *     node scripts/landing-video.mjs --claude-config ~/.claude_1   # another logged-in account
 *
 * The sandbox is the README screenshots' (`scripts/ui-audit/lib/driver.mjs` ▸ `boot`, window
 * parked off screen): its own daemon, socket, database, config and Electron profile. The demo is
 * Paddock, a grazing planner in two repositories (`scripts/demo-fixture.mjs`), each the default
 * repository of its own group: API holds `paddock-api`, Web holds `paddock-web`. The story:
 *
 *   1. The window opens on Web's preview workspace: the map's dev server, the API server and the
 *      map itself in a web pane. A demo cursor opens New Workspace, names it rest-days, picks the
 *      API group, Claude and types a prompt. The workspace is cut on its own worktree, Claude
 *      starts with the prompt pasted in, and the cursor's Enter sends it.
 *   2. That Claude is the coordinator. Following the repo's CLAUDE.md, it writes docs/plan.md and
 *      opens it beside itself (`kelpi md`), then starts two workers on worktrees of their own:
 *      one nested under itself in API (`kelpi workspace create --nested …`), one in the Web group
 *      on paddock-web (`kelpi workspace create --group Web …`).
 *   3. The workers are real Claude sessions too. The web worker changes the map and opens it
 *      beside itself (`kelpi open public/index.html`); the API worker adds the maths and its
 *      tests and opens its diff. The cursor visits each once it is done, then goes back to the
 *      coordinator, which marks the plan done.
 *
 * Nothing in the agents is scripted beyond their prompts and the repos' CLAUDE.md: they read,
 * edit, test and drive Kelpi through the real `kelpi` CLI, and the dots come from the same
 * Claude Code hooks `kelpi install-hooks` writes. The harness only plays the person: the cursor,
 * the typing, an Enter, a few clicks. It also answers Claude's folder trust prompt, which shows
 * once per path on an account that has never opened it, so make one rehearsal take first; the
 * trust it grants is remembered for the next.
 *
 * Claude Code finds its login through the real HOME, so it runs on that HOME (and the logged-in
 * account's config dir) with `--setting-sources project,local`: none of that account's own
 * settings, statusline, plugins, MCP servers or hooks load, only the Kelpi hooks and the
 * permissions this script passes with `--settings`. Everything else in the sandbox gets a demo
 * HOME at `/Users/Shared/kelpi-demo`, made for the take and removed after it, so shells read
 * `~/paddock-api` and absolute paths (Claude's header, the New Workspace sheet's preview, a
 * `file://` page) name no account. A take spends the account's usage: three Sonnet sessions for
 * a minute or two.
 *
 * Frames are 2x captures of the renderer's surface (`Page.captureScreenshot`, about 7 a second).
 * A web pane is a native view that surface does not hold, so each visible one is captured from
 * its own target a few times a second and composited into its hole in the edit. The edit
 * (`EDIT` below) keeps the person's moments at real speed and time-lapses the agents' work, and
 * `kelpi-session.json` beside the video records the chapters and where it is sped up, which the
 * page shows as captions and a speed badge. Watch every take before committing it: an agent's
 * output is different every time.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};
const outDir = path.resolve(value('--out') ?? path.join(repoRoot, 'site', 'assets', 'video'));
const log = (line) => console.log(`[video] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the edit ─────────────────────────────────────────────────────────────────────────

/**
 * The cut, as marks the take records and what happens to the stretch after each: `speed` plays
 * it that many times faster, `fit` squeezes (or keeps) it to at most that many seconds. A mark a
 * take never reached is skipped, and its stretch joins the one before.
 */
const EDIT = [
    ['start', { speed: 1 }],
    ['sheet-open', { speed: 1.6, fit: 9 }],
    ['submitted', { fit: 3 }],
    ['workspace-open', { fit: 2 }],
    ['prompt-ready', { speed: 1, fit: 1.5 }],
    ['prompt-sent', { fit: 5 }],
    ['plan-open', { fit: 3 }],
    ['workers-started', { fit: 6 }],
    ['jumped-web', { speed: 1, fit: 5 }],
    ['jumped-api', { speed: 1, fit: 3.5 }],
    ['back', { fit: 4 }],
    ['coordinator-done', { speed: 1, fit: 3.5 }],
    ['end', null]
];

/** The captions under the video: each starts at its mark and runs to the next. */
const CHAPTERS = [
    ['start', 'Start a task in the API group: a new workspace on its own git worktree, with Claude ready'],
    ['prompt-sent', 'The coordinator writes the plan and opens it beside its terminal'],
    ['workers-started', 'It starts a worker in each group, each on its own worktree, and the dots show who is running'],
    ['jumped-web', 'The web worker opens the map it changed in a pane beside it'],
    ['jumped-api', 'The API worker opens its diff for review'],
    ['back', 'Back with the coordinator, which marks the plan done once both workers finish']
];

// ── the demo ─────────────────────────────────────────────────────────────────────────

const PROMPT = 'Plan the rest days feature in docs/plan.md, then hand each task to its own worker';

/** The workspaces the coordinator starts, by the names its CLAUDE.md gives them. */
const WORKERS = { api: 'api', web: 'ready-badge' };

const WORKING_IN_KELPI = `## Working in Kelpi

You are running in a Kelpi pane. Coordinate with the \`kelpi\` CLI, never with subagents, and keep
replies short. Write and change files with your Write and Edit tools, never through the shell, and
run each \`kelpi\` command on its own, never chained to another command.
`;

const WORKER_RULE = `### If your prompt starts with "Task"

You are a worker. Do only that task, in this worktree, then stop. Do not start other workers.
`;

const CLAUDE_MD_API = `# paddock-api

Grazing maths for Paddock, a sheep farm's grazing planner. \`npm test\` runs the unit tests
(node --test). Areas are hectares and feed is kilograms of dry matter. The paddock map lives in
paddock-web, the repository of the Web group in Kelpi.

${WORKING_IN_KELPI}
### If you were asked to plan the rest days feature

1. Write docs/plan.md from the template below with your Write tool, then open it beside you
   with \`kelpi md docs/plan.md\`.
2. Start one worker per task, each on its own worktree. Run each of these exactly as written,
   one command at a time. The first nests under your workspace in the API group, the second
   goes to the Web group, which holds paddock-web:

   kelpi workspace create --nested --name ${WORKERS.api} --worktree rest-days-api --agent claude --send --prompt "Task api: add restDays(paddock, today) and readyToGraze(paddock, today) to src/grazing.js. restDays is the whole days from paddock.lastGrazed (an ISO date) to today, and a paddock is ready to graze once it has rested 30 days or more. Add tests to test/grazing.test.js, run npm test, then run kelpi diff (it opens your changes in a pane beside you and prints nothing), and stop."

   kelpi workspace create --group Web --name ${WORKERS.web} --worktree ${WORKERS.web} --agent claude --send --prompt "Task web: in public/app.js, give each paddock card that has no mob and has rested 30 days or more a Ready to graze badge, styled in public/style.css. Then run kelpi open public/index.html (it opens the page in a pane beside you and prints one line), and stop."

3. Check on them every 15 seconds with \`sleep 15 && kelpi pane list\` until the shell pane in
   each worker's workspace (${WORKERS.api} and ${WORKERS.web}) is no longer running (it shows
   waitingForInput or idle; idle means someone already looked). Their status is all you need:
   never cd into their worktrees or run git there. Then change both rows of docs/plan.md to
   ✅ done and tick both boxes. Finish with one short line per worker saying what it changed, and
   stop.

${WORKER_RULE}
## Plan template

\`\`\`markdown
# Rest days

Show which paddocks have rested long enough to graze again, from the API to the map.

| Task | Worker | Group | Status |
|------|--------|-------|--------|
| restDays and readyToGraze | ${WORKERS.api} | API | 🚧 in progress |
| Ready to graze badge on the map | ${WORKERS.web} | Web | 🚧 in progress |

## Done when

- [ ] \`npm test\` passes in paddock-api
- [ ] The map shows the badge on rested paddocks
\`\`\`
`;

const CLAUDE_MD_WEB = `# paddock-web

The paddock map for Paddock, a sheep farm's grazing planner. \`npm run dev\` serves it, and
\`public/index.html\` also opens straight from disk. The grazing maths lives in paddock-api.

${WORKING_IN_KELPI}
${WORKER_RULE}`;

/**
 * What the sandbox's Claude Code may do without asking. A prompt for anything else is read by
 * `approvable` below: approved if every command in it is one of these (plus a few harmless shell
 * words) and every absolute path stays under the demo HOME; otherwise it stops the take.
 */
const ALLOWED_BASH = ['kelpi', 'npm', 'node', 'git', 'sleep', 'ls', 'cat', 'grep', 'head', 'tail', 'wc'];

const SHELL_WORDS = ['cd', 'echo', 'printf', 'pwd', 'mkdir', 'test', 'true', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr'];

function approvable(promptText, demoHome) {
    const lines = promptText.split('\n');
    const start = lines.findIndex((line) => /Bash command/.test(line));
    const end = lines.findIndex((line, index) => index > start && /Do you want to proceed/.test(line));
    if (start < 0 || end < 0) return { ok: false, why: 'not a Bash prompt' };
    let command = lines.slice(start + 1, end).filter((line) => /^\s*│ ?/.test(line)).map((line) => line.replace(/^\s*│ ?/, '')).join('\n');
    // a heredoc's body is data, not commands
    command = command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, '\n');
    const allowed = new Set([...ALLOWED_BASH, ...SHELL_WORDS]);
    // quoted text is arguments, so a | or ; inside quotes does not start a command
    const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'ARG');
    for (const segment of unquoted.split(/&&|\|\||;|\||\n/)) {
        const words = segment.trim().split(/\s+/).filter((word) => word !== '' && !/^\w+=/.test(word));
        if (words.length === 0) continue;
        const name = words[0].replace(/^[({]+/, '');
        if (name === '' || name.startsWith('#') || name === 'EOF') continue;
        if (!allowed.has(name)) return { ok: false, why: `runs ${name}` };
    }
    for (const match of command.matchAll(/(?:^|[\s'"=>])(\/[^\s'"]*)/g)) {
        const target = match[1];
        if (!(target.startsWith(demoHome) || target.startsWith('/tmp/') || target === '/dev/null')) return { ok: false, why: `touches ${target}` };
    }
    return { ok: true, why: command.trim().split('\n')[0] };
}

function claudeSettings() {
    const hook = (verb) => [{ hooks: [{ type: 'command', command: `kelpi event ${verb}` }] }];
    return {
        // The hooks `kelpi install-hooks` writes, so the dots behave as on a real install.
        hooks: {
            SessionStart: hook('session-start'),
            UserPromptSubmit: hook('start'),
            Stop: hook('stop'),
            Notification: hook('notification'),
            SessionEnd: hook('session-end')
        },
        permissions: { allow: [...ALLOWED_BASH.map((command) => `Bash(${command}:*)`), 'Read', 'Edit', 'Write'] },
        spinnerTipsEnabled: false
    };
}

/**
 * The demo cursor is drawn in the edit, not in the page: the take records where it went and when
 * it clicked (`cursor.json`), and the encoder overlays this sprite at 30 frames a second. Frames
 * of the window come at about 7 a second (see `CAPTURE_PERIOD_MS`), too few for a cursor in
 * motion, and plenty for everything else. The sprite's tip sits at `CURSOR_TIP` px.
 */
const CURSOR_SPRITE = path.join(repoRoot, 'scripts', 'landing-video-cursor.png');
const CURSOR_TIP = { x: 6, y: 6 };
/**
 * Capturing the renderer's surface faster than about one frame per 60 ms starves it: a sheet's
 * open never lands (found while building this). Leave a 75 ms gap after every capture, and aim
 * for one every 130 ms.
 */
const CAPTURE_PERIOD_MS = 130;
const CAPTURE_GAP_MS = 75;
/** Output pixels per CSS pixel: the 1280x820 window becomes a 1920-wide video. */
const OUT_SCALE = 1.5;
/** Capture pixels per CSS pixel, for the window and every web pane alike. */
const CAPTURE_SCALE = 2;
/** A visible web pane is captured from its own target this often (its page rarely moves). */
const WEB_CAPTURE_PERIOD_MS = 300;

// ── encoding ─────────────────────────────────────────────────────────────────────────

/** Turn the EDIT and a take's marks into stretches of the take and their speed-ups. */
function planEdit(marks, takeEnd) {
    const times = new Map(marks.map((mark) => [mark.name, mark.t]));
    const present = EDIT.filter(([name]) => times.has(name) || (name === 'end' && takeEnd !== undefined));
    const timeOf = (name) => (times.has(name) ? times.get(name) : takeEnd);
    const pieces = [];
    for (let index = 0; index < present.length - 1; index += 1) {
        const [name, rule] = present[index];
        const from = timeOf(name);
        const to = timeOf(present[index + 1][0]);
        if (!(to > from)) continue;
        const length = to - from;
        let speed = rule?.speed ?? 1;
        if (rule?.fit !== undefined && length / speed > rule.fit) speed = length / rule.fit;
        pieces.push({ mark: name, from, to, speed });
    }
    let out = 0;
    for (const piece of pieces) {
        piece.outStart = out;
        out += (piece.to - piece.from) / piece.speed;
        piece.outEnd = out;
    }
    const outAt = (name) => pieces.find((piece) => piece.mark === name)?.outStart;
    /** Where a moment of the take lands in the cut. */
    const outTime = (t) => {
        if (pieces.length === 0 || t <= pieces[0].from) return 0;
        for (const piece of pieces) {
            if (t < piece.to) return piece.outStart + (t - piece.from) / piece.speed;
        }
        return out;
    };
    const chapters = [];
    for (const [name, text] of CHAPTERS) {
        const start = outAt(name);
        if (start !== undefined) chapters.push({ start: round(start), text });
    }
    chapters.forEach((chapter, index) => { chapter.end = index + 1 < chapters.length ? chapters[index + 1].start : round(out); });
    // Every stretch played at 1.5 times or faster gets the page's speed badge.
    const fastForward = pieces.filter((piece) => piece.speed >= 1.5).map((piece) => ({
        start: round(piece.outStart), end: round(piece.outEnd), speed: piece.speed < 3 ? Math.round(piece.speed * 10) / 10 : Math.round(piece.speed)
    }));
    return { pieces, duration: round(out), chapters, fastForward, outTime };
}

const round = (number) => Math.round(number * 100) / 100;

/**
 * The cursor as ffmpeg overlays: the sprite eased along each recorded move (an ease-out close to
 * the page's own curve), and a ring that grows and fades at each click.
 */
function cursorFilters(track, plan) {
    const fixed = (number) => number.toFixed(3);
    const px = (value, tip) => fixed(value * OUT_SCALE - tip);
    const rest = track.find((event) => event.type === 'rest') ?? { x: 560, y: 560 };
    const moves = track.filter((event) => event.type === 'move').map((move) => {
        const start = plan.outTime(move.t);
        const end = Math.max(start + 0.05, plan.outTime(move.t + move.ms / 1000));
        return { start, end, from: move.from, to: move.to };
    });
    const along = (axis, tip) => {
        let expression = px(moves.length > 0 ? moves[moves.length - 1].to[axis] : rest[axis], tip);
        for (const move of [...moves].reverse()) {
            const from = move.from[axis] * OUT_SCALE - tip;
            const delta = (move.to[axis] - move.from[axis]) * OUT_SCALE;
            const span = move.end - move.start;
            expression = `if(lt(t,${fixed(move.start)}),${fixed(from)},if(lt(t,${fixed(move.end)}),${fixed(from)}+${fixed(delta)}*(1-pow(1-(t-${fixed(move.start)})/${fixed(span)},4)),${expression}))`;
        }
        return expression;
    };
    const clicks = track.filter((event) => event.type === 'click').map((click) => ({ at: plan.outTime(click.t), x: click.x, y: click.y }));
    const RING = 64;
    const LIFE = 0.5;
    const ringAlpha = clicks.length === 0 ? '0' : clicks.map((click) =>
        `between(T,${fixed(click.at)},${fixed(click.at + LIFE)})*230*(1-(T-${fixed(click.at)})/${String(LIFE)})*lte(abs(hypot(X-${String(RING / 2)},Y-${String(RING / 2)})-(5+(T-${fixed(click.at)})*34)),1.4)`).join('+');
    const ringAt = (axis) => {
        let expression = '-100';
        for (const click of [...clicks].reverse()) {
            expression = `if(between(t,${fixed(click.at - 0.02)},${fixed(click.at + LIFE + 0.02)}),${px(click[axis], RING / 2)},${expression})`;
        }
        return expression;
    };
    return {
        ring: `color=c=black@0:s=${String(RING)}x${String(RING)}:r=30:d=${fixed(plan.duration + 1)},format=rgba,geq=r=255:g=255:b=255:a='${ringAlpha}'`,
        cursorX: along('x', CURSOR_TIP.x),
        cursorY: along('y', CURSOR_TIP.y),
        ringX: ringAt('x'),
        ringY: ringAt('y')
    };
}

/**
 * Put each web pane's page into its hole: for every frame that had a web pane on screen, the
 * page's own capture nearest before it is scaled to the hole and laid over the window's frame.
 * Returns the file to use for each frame. A few ffmpeg processes at a time, one per frame.
 */
async function compositeWebPanes(takeDir, frames) {
    const shotsFile = path.join(takeDir, 'web-shots.json');
    const shots = fs.existsSync(shotsFile) ? JSON.parse(fs.readFileSync(shotsFile, 'utf8')) : [];
    const source = (file) => path.join(takeDir, 'frames', file);
    const files = frames.map((frame) => source(frame.file));
    if (shots.length === 0) return files;
    const outDirFrames = path.join(takeDir, 'composited');
    fs.mkdirSync(outDirFrames, { recursive: true });
    const byPane = new Map();
    for (const shot of shots) {
        if (!byPane.has(shot.pane)) byPane.set(shot.pane, []);
        byPane.get(shot.pane).push(shot);
    }
    const pick = (pane, t) => {
        const list = byPane.get(pane) ?? [];
        let best = null;
        for (const shot of list) {
            if (shot.t <= t + 0.05) best = shot;
            else break;
        }
        return best ?? list[0] ?? null;
    };
    const jobs = [];
    frames.forEach((frame, index) => {
        const layers = (frame.webs ?? []).map((hole) => ({ hole, shot: pick(hole.pane, frame.t) })).filter((layer) => layer.shot !== null);
        if (layers.length === 0) return;
        const out = path.join(outDirFrames, frame.file);
        files[index] = out;
        const inputs = ['-i', source(frame.file), ...layers.flatMap((layer) => ['-i', source(layer.shot.file)])];
        const px = (number) => String(Math.round(number * CAPTURE_SCALE));
        const graph = layers.map((layer, at) => {
            const { x, y, width, height } = layer.hole;
            const below = at === 0 ? '[0:v]' : `[o${String(at - 1)}]`;
            return `[${String(at + 1)}:v]scale=${px(width)}:${px(height)}[w${String(at)}];${below}[w${String(at)}]overlay=${px(x)}:${px(y)}[o${String(at)}]`;
        }).join(';');
        jobs.push(['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', `[o${String(layers.length - 1)}]`, '-q:v', '2', out]);
    });
    log(`compositing web panes into ${String(jobs.length)} of ${String(frames.length)} frames`);
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const argv = jobs[next];
            next += 1;
            await new Promise((resolve, reject) => {
                const child = spawn('ffmpeg', argv, { stdio: ['ignore', 'ignore', 'inherit'] });
                child.on('error', reject);
                child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg composite failed: ${argv.join(' ')}`))));
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, os.cpus().length) }, worker));
    return files;
}

async function encode(takeDir) {
    const frames = JSON.parse(fs.readFileSync(path.join(takeDir, 'frames.json'), 'utf8'));
    const marks = JSON.parse(fs.readFileSync(path.join(takeDir, 'marks.json'), 'utf8'));
    if (frames.length < 2) throw new Error(`take ${takeDir} has no frames`);
    const takeEnd = frames[frames.length - 1].t;
    const plan = planEdit(marks, takeEnd);
    log(`edit: ${plan.pieces.map((p) => `${p.mark} ${(p.to - p.from).toFixed(1)}s ×${p.speed.toFixed(1)}`).join(' | ')}`);
    log(`edit: ${plan.duration}s out of ${takeEnd.toFixed(1)}s`);

    // The frames as a variable-rate stream: each shown until the next was captured.
    const files = await compositeWebPanes(takeDir, frames);
    const list = [];
    frames.forEach((frame, index) => {
        const next = frames[index + 1]?.t ?? frame.t + 0.05;
        list.push(`file '${files[index]}'`, `duration ${Math.max(0.001, next - frame.t).toFixed(4)}`);
    });
    list.push(`file '${files[files.length - 1]}'`);
    const listFile = path.join(takeDir, 'frames.txt');
    fs.writeFileSync(listFile, `${list.join('\n')}\n`);

    const offset = frames[0].t;
    const chains = plan.pieces.map((piece, index) =>
        `[0:v]trim=start=${(piece.from - offset).toFixed(3)}:end=${(piece.to - offset).toFixed(3)},setpts=(PTS-STARTPTS)/${piece.speed.toFixed(4)}[p${String(index)}]`);
    const joined = `${plan.pieces.map((_, index) => `[p${String(index)}]`).join('')}concat=n=${String(plan.pieces.length)}:v=1:a=0,fps=30,scale=1920:-2:flags=lanczos,format=rgba[base]`;
    const trackFile = path.join(takeDir, 'cursor.json');
    const track = fs.existsSync(trackFile) ? JSON.parse(fs.readFileSync(trackFile, 'utf8')) : [];
    const cursor = cursorFilters(track, plan);
    const overlays = [
        `[1:v]format=rgba[sprite]`,
        `[base][sprite]overlay=x='${cursor.cursorX}':y='${cursor.cursorY}':eval=frame:shortest=1[withcursor]`,
        `${cursor.ring}[ring]`,
        `[withcursor][ring]overlay=x='${cursor.ringX}':y='${cursor.ringY}':eval=frame:shortest=1,format=yuv420p[v]`
    ];
    fs.mkdirSync(outDir, { recursive: true });
    const mp4 = path.join(outDir, 'kelpi-session.mp4');
    const ffmpeg = (argv) => {
        const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
        if (result.status !== 0) throw new Error(`ffmpeg failed: ${argv.join(' ')}`);
    };
    ffmpeg([
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-loop', '1', '-framerate', '30', '-i', CURSOR_SPRITE,
        '-filter_complex', [...chains, joined, ...overlays].join(';'), '-map', '[v]',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-tune', 'animation', '-profile:v', 'high',
        '-movflags', '+faststart', '-an', mp4
    ]);
    // The poster is the last frame: the finished plan, every agent settled.
    ffmpeg(['-sseof', '-0.1', '-i', mp4, '-frames:v', '1', '-q:v', '3', path.join(outDir, 'kelpi-session.jpg')]);
    fs.writeFileSync(path.join(outDir, 'kelpi-session.json'), `${JSON.stringify({ duration: plan.duration, chapters: plan.chapters, fastForward: plan.fastForward }, null, 2)}\n`);
    const size = fs.statSync(mp4).size;
    log(`wrote ${path.relative(repoRoot, mp4)} (${(size / 1e6).toFixed(1)} MB, ${plan.duration}s), its poster and timeline`);
}

if (value('--edit') !== undefined) {
    await encode(path.resolve(value('--edit')));
    process.exit(0);
}

// ── the take ─────────────────────────────────────────────────────────────────────────

process.env.TMPDIR = fs.realpathSync(os.tmpdir());
delete process.env.KELPI_PANE_ID;
delete process.env.KELPI_SOCKET;
process.env.KELPI_HARNESS_QUIET_NOTIFICATIONS = '1';

const realHome = os.homedir();
// Outside every account's home, so no absolute path on screen names one.
const demoHome = '/Users/Shared/kelpi-demo';
if (fs.existsSync(demoHome)) {
    throw new Error(`${demoHome} already exists. A take makes and removes it; move it aside first.`);
}
const realClaude = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();
if (realClaude === '') throw new Error('claude is not on PATH');
const claudeConfig = value('--claude-config');
const model = value('--model') ?? 'sonnet';
const takeDir = path.resolve(value('--take') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-video-take-')));
for (const stale of ['frames', 'composited']) fs.rmSync(path.join(takeDir, stale), { recursive: true, force: true });
fs.mkdirSync(path.join(takeDir, 'frames'), { recursive: true });

const { runDesktopTest } = await import('./ui-audit/lib/desktop-lifecycle.mjs');
const d = await import('./ui-audit/lib/driver.mjs');
const { connect, listTargets } = await import('./ui-audit/lib/cdp.mjs');
const { freePort } = await import('./ui-audit/lib/stack.mjs');
const { GITCONFIG, ZSHRC, makeRepos, write } = await import('./demo-fixture.mjs');

await runDesktopTest(async () => {
    log(`booting a sandbox${has('--no-build') ? ' (no build)' : ' (building first; skip with --no-build)'}`);
    const t = await d.boot({ repoRoot, label: 'video', build: !has('--no-build'), log, window: 'offscreen' });
    const { page, cli, sandbox } = t;
    const marks = [];
    const frames = [];
    const webShots = [];
    const webSessions = new Map();
    let clockZero = 0;
    let capturing = false;
    let captureLoop = null;
    let webLoop = null;
    let demoMade = false;

    const now = () => (performance.now() - clockZero) / 1000;
    const mark = (name) => {
        if (marks.some((entry) => entry.name === name)) return;
        marks.push({ name, t: now() });
        log(`mark ${name} @ ${now().toFixed(1)}s`);
    };
    const json = async (argv, opts) => JSON.parse(await cli.ok([...argv, '--json'], opts));
    const asPane = (paneID) => ({ env: { KELPI_PANE_ID: paneID } });
    const capture = async (paneID) => (await cli.run(['pane', 'capture', '--target', paneID])).stdout;
    const allPanes = async () => json(['pane', 'list']);
    const panesOf = async (workspaceID) => json(['pane', 'list', '--workspace', workspaceID]);
    const workspaces = async () => json(['workspace', 'list']);
    const waitForText = async (paneID, needle, ceilingMs = 15_000) => {
        if (!(await d.settle(async () => (await capture(paneID)).includes(needle), { ceilingMs, intervalMs: 200 }))) {
            throw new Error(`pane ${paneID} never showed ${JSON.stringify(needle)}`);
        }
    };

    // ── the person: a cursor that glides, clicks and types ───────────────────────────
    let cursorAt = { x: 560, y: 560 };
    const cursorTrack = [];
    const cursorTo = async (target) => {
        const box = typeof target === 'string' ? await page.box(target) : target;
        if (box === null) throw new Error(`cursor: nothing matches ${String(target)}`);
        const to = { x: box.cx ?? box.x, y: box.cy ?? box.y };
        const distance = Math.hypot(to.x - cursorAt.x, to.y - cursorAt.y);
        const ms = Math.round(Math.min(1100, Math.max(450, distance * 1.4)));
        cursorTrack.push({ type: 'move', t: now(), ms, from: cursorAt, to });
        // the real pointer follows in steps, so hover states show on the way
        const steps = 6;
        for (let step = 1; step <= steps; step += 1) {
            const x = cursorAt.x + ((to.x - cursorAt.x) * step) / steps;
            const y = cursorAt.y + ((to.y - cursorAt.y) * step) / steps;
            await page.mouse('mouseMoved', x, y, { button: 'none', buttons: 0 });
            await sleep(ms / steps);
        }
        cursorAt = to;
        await sleep(120);
        return to;
    };
    // A click whose press and release straddle a surface capture is sometimes lost, so the
    // capture loop holds for the moment of each click (the drawn cursor covers the gap).
    let captureHold = 0;
    let captureInFlight = Promise.resolve();
    const cursorClick = async (target) => {
        const at = await cursorTo(target);
        cursorTrack.push({ type: 'click', t: now(), x: at.x, y: at.y });
        captureHold += 1;
        try {
            await captureInFlight;
            await page.clickAt(at.x, at.y);
            await sleep(140);
        } finally {
            captureHold -= 1;
        }
        await sleep(150);
    };
    const typeText = async (text) => {
        for (const character of text) {
            await page.insertText(character);
            await sleep(38 + Math.random() * 45);
        }
    };
    const choose = (selector, choice) => page.eval(`(() => {
        const select = document.querySelector(${JSON.stringify(selector)});
        if (select === null) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(choice)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    const rowOf = (workspaceID) => `[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`;

    // ── frames ────────────────────────────────────────────────────────────────────────
    // Where the window leaves a hole for a web pane's native view, in CSS px.
    const webHoles = async () => JSON.parse(await page.eval(`JSON.stringify(Array.from(document.querySelectorAll('[data-testid^="web-page-"][data-visible="true"]')).map((el) => {
        const r = el.getBoundingClientRect();
        return { pane: el.getAttribute('data-testid').slice('web-page-'.length), x: r.x, y: r.y, width: r.width, height: r.height };
    }))`));
    let visibleHoles = [];
    /** A CDP session on a web pane's own page, found by its URL, rendering at the capture scale. */
    const webSession = async (paneID) => {
        if (webSessions.has(paneID)) return webSessions.get(paneID);
        const url = (await cli.ok(['web', 'url', '--target', paneID])).trim().split('\t')[0];
        const target = (await listTargets(sandbox.debugPort)).find((entry) => entry.type === 'page' && entry.url === url);
        if (target === undefined) return null;
        const session = await connect(target.webSocketDebuggerUrl, { repoRoot });
        await session.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: CAPTURE_SCALE, mobile: false });
        webSessions.set(paneID, session);
        return session;
    };
    const startCapture = () => {
        capturing = true;
        captureLoop = (async () => {
            while (capturing) {
                if (captureHold > 0) {
                    await sleep(15);
                    continue;
                }
                const started = now();
                try {
                    const pending = page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, fromSurface: true });
                    captureInFlight = pending.then(() => undefined, () => undefined);
                    const shot = await pending;
                    const file = `${String(frames.length).padStart(6, '0')}.jpg`;
                    fs.writeFileSync(path.join(takeDir, 'frames', file), Buffer.from(shot.data, 'base64'));
                    visibleHoles = await webHoles();
                    frames.push({ file, t: started, webs: visibleHoles });
                } catch (error) {
                    log(`frame skipped: ${String(error)}`);
                }
                const spent = (now() - started) * 1000;
                await sleep(Math.max(CAPTURE_GAP_MS, CAPTURE_PERIOD_MS - spent));
            }
        })();
        // The web panes' pages, from their own renderers, for the edit to composite.
        webLoop = (async () => {
            while (capturing) {
                for (const hole of visibleHoles) {
                    try {
                        const session = await webSession(hole.pane);
                        if (session === null) continue;
                        const started = now();
                        const shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true });
                        const file = `web-${String(webShots.length).padStart(5, '0')}.jpg`;
                        fs.writeFileSync(path.join(takeDir, 'frames', file), Buffer.from(shot.data, 'base64'));
                        webShots.push({ pane: hole.pane, t: started, file });
                    } catch (error) {
                        log(`web frame skipped: ${String(error)}`);
                        webSessions.delete(hole.pane);
                    }
                }
                await sleep(WEB_CAPTURE_PERIOD_MS);
            }
        })();
    };

    try {
        // ── the demo HOME, the repos, and Claude Code ─────────────────────────────────
        fs.mkdirSync(demoHome);
        demoMade = true;
        write(path.join(demoHome, '.zshrc'), ZSHRC);
        write(path.join(demoHome, '.gitconfig'), GITCONFIG);
        const { api, web } = makeRepos(sandbox, {
            home: demoHome,
            extra: {
                api: { message: 'Explain how to work on paddock-api in Kelpi', files: { 'CLAUDE.md': CLAUDE_MD_API } },
                web: { message: 'Explain how to work on paddock-web in Kelpi', files: { 'CLAUDE.md': CLAUDE_MD_WEB } }
            }
        });
        fs.appendFileSync(sandbox.configPath, `worktree-base-path = ${path.join(demoHome, 'worktrees')}/<repo>\n`);

        const settingsFile = path.join(sandbox.root, 'claude-settings.json');
        fs.writeFileSync(settingsFile, `${JSON.stringify(claudeSettings(), null, 2)}\n`);
        // The `claude` every pane finds first (the helpers directory leads each pane's PATH).
        const user = os.userInfo().username;
        write(path.join(sandbox.root, 'helpers', 'claude'), [
            '#!/bin/sh',
            '# landing-video: the real Claude Code on the real HOME, where its login lives, with none',
            "# of the account's own settings: only the Kelpi hooks and permissions this take passes.",
            `export HOME='${realHome}' USER='${user}' LOGNAME='${user}'`,
            'export CLAUDE_CODE_HIDE_ACCOUNT_INFO=1 DISABLE_AUTOUPDATER=1',
            // git as the demo's Sam Rivera, never the real account's identity
            `export GIT_CONFIG_GLOBAL='${path.join(demoHome, '.gitconfig')}'`,
            // Named even for the default: a login made with CLAUDE_CONFIG_DIR set lives under a
            // keychain entry that an unset CLAUDE_CONFIG_DIR does not look up.
            `export CLAUDE_CONFIG_DIR='${path.resolve((claudeConfig ?? '~/.claude').replace(/^~/, realHome))}'`,
            `exec '${realClaude}' --setting-sources project,local --settings '${settingsFile}' --strict-mcp-config --model ${model} --permission-mode acceptEdits "$@"`,
            ''
        ].join('\n'), 0o755);

        sandbox.env.SHELL = '/bin/zsh';
        sandbox.env.HOME = demoHome;
        await t.daemon.restart();
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 30_000 });
        await page.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: CAPTURE_SCALE, mobile: false });

        // ── the window before the story: two groups, and Web's preview on screen ─────────
        const [initial] = await workspaces();
        await cli.ok(['workspace', 'rename', initial.id, 'dotfiles']);
        // Its shell started before the demo HOME existed: bring it there.
        for (const pane of await panesOf(initial.id)) {
            await cli.ok(['pane', 'send', '--target', pane.id, 'cd ~ && clear']);
        }
        await cli.ok(['group', 'create', 'API', '--color', 'blue']);
        await cli.ok(['group', 'set-repo', 'API', api, '--worktree']);
        await cli.ok(['group', 'create', 'Web', '--color', 'green']);
        await cli.ok(['group', 'set-repo', 'Web', web, '--worktree']);
        // preview: the map's dev server and the API server stacked on the left, the map on the right
        const preview = await json(['workspace', 'create', '--focus', '--name', 'preview', '--group', 'Web', '--color', 'green']);
        await d.settle(async () => (await panesOf(preview.workspace_id)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });
        const [devPane] = await panesOf(preview.workspace_id);
        await waitForText(devPane.id, '$ ');
        await cli.ok(['pane', 'name', 'web'], asPane(devPane.id));
        const webPort = await freePort();
        await cli.ok(['pane', 'send', '--target', devPane.id, `PORT=${String(webPort)} npm run dev`]);
        await waitForText(devPane.id, 'dev server ready');
        const opened = await cli.ok(['web', 'open', `http://127.0.0.1:${String(webPort)}/`], asPane(devPane.id));
        const mapPane = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1];
        if (mapPane === undefined) throw new Error(`web open said: ${opened}`);
        await sleep(800);
        await cli.ok(['pane', 'resize', '--target', devPane.id, '--workspace', preview.workspace_id, '--ratio', '0.42']);
        await sleep(400);
        await cli.ok(['pane', 'split', '--target', devPane.id, '--direction', 'vertical', '--name', 'api', '--path', api], asPane(devPane.id));
        await d.settle(async () => (await panesOf(preview.workspace_id)).some((pane) => pane.label === 'api'), { ceilingMs: 15_000, intervalMs: 200 });
        const apiPane = (await panesOf(preview.workspace_id)).find((pane) => pane.label === 'api');
        await waitForText(apiPane.id, '$ ');
        const apiPort = await freePort();
        await cli.ok(['pane', 'send', '--target', apiPane.id, `PORT=${String(apiPort)} npm start`]);
        await waitForText(apiPane.id, 'listening on');
        // a request or two, so the API's log reads like a running server
        for (let index = 0; index < 2; index += 1) await (await fetch(`http://127.0.0.1:${String(apiPort)}/paddocks`)).text();
        await d.settle(async () => (await webSession(mapPane).catch(() => null)) !== null, { ceilingMs: 15_000, intervalMs: 300 });
        await sleep(1200);
        await page.mouse('mouseMoved', cursorAt.x, cursorAt.y, { button: 'none', buttons: 0 });
        await sleep(600);

        // ── roll ──────────────────────────────────────────────────────────────────────
        clockZero = performance.now();
        startCapture();
        mark('start');
        cursorTrack.push({ type: 'rest', t: 0, x: cursorAt.x, y: cursorAt.y });
        await sleep(2200);

        // 1 · a new workspace on a worktree, with Claude and a prompt, from the sidebar's own
        // New Workspace button and the sheet's Group picker (the group header's hover "+" needs a
        // hover the parked window's synthetic pointer does not reliably raise).
        const nameField = '[aria-label="New workspace name"]';
        const sheetUp = `document.querySelector('${nameField}') !== null`;
        let sheetOpened = false;
        for (let attempt = 1; attempt <= 3 && !sheetOpened; attempt += 1) {
            await cursorClick('[data-testid="sidebar-new-workspace"]');
            sheetOpened = await d.settleDom(page, sheetUp, { ceilingMs: 2_500 });
            if (!sheetOpened) log(`New Workspace did not open its sheet (try ${String(attempt)}); clicking again`);
        }
        if (!sheetOpened) throw new Error('New Workspace never opened its sheet');
        mark('sheet-open');
        await sleep(500);
        // The sheet scrolls once it grows (choosing a group adds its repository and worktree
        // rows), so every field is scrolled into view and measured again before the cursor goes
        // to it: a click on where a field used to be lands on the backdrop and closes the sheet.
        const inSheet = async (selector) => {
            if (!(await page.eval(sheetUp))) throw new Error(`the New Workspace sheet closed before ${selector}`);
            await page.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'nearest' })`);
            await sleep(250);
        };
        await inSheet(nameField);
        await cursorClick(nameField);
        await typeText('rest-days');
        await sleep(300);
        await inSheet('[aria-label="Group"]');
        await cursorTo('[aria-label="Group"]');
        const apiGroup = await page.eval(`(() => {
            const select = document.querySelector('[aria-label="Group"]');
            const option = Array.from(select?.options ?? []).find((entry) => entry.textContent.trim() === 'API');
            return option === undefined ? null : option.value;
        })()`);
        if (apiGroup === null || !(await choose('[aria-label="Group"]', apiGroup))) throw new Error('the sheet offers no API group');
        await sleep(800);
        const worktreeToggle = '[data-testid="new-workspace-worktree-toggle"]';
        const worktreeOn = await page.eval(`(() => {
            const toggle = document.querySelector('${worktreeToggle}');
            return toggle !== null && (toggle.checked === true || toggle.getAttribute('aria-checked') === 'true');
        })()`);
        if (!worktreeOn) {
            await inSheet(worktreeToggle);
            await cursorClick(worktreeToggle);
        }
        await inSheet('[data-testid="new-workspace-agent"]');
        await cursorTo('[data-testid="new-workspace-agent"]');
        if (!(await choose('[data-testid="new-workspace-agent"]', 'claude'))) throw new Error('no agent picker in the sheet');
        await sleep(500);
        await inSheet('[data-testid="new-workspace-agent-prompt"]');
        await cursorClick('[data-testid="new-workspace-agent-prompt"]');
        await typeText(PROMPT);
        await sleep(400);
        const sendBox = '[data-testid="new-workspace-agent-send"]';
        if (await page.eval(`document.querySelector('${sendBox}')?.checked === true`)) await page.click(sendBox);
        const creating = `document.querySelector('[data-testid="new-workspace-progress"]') !== null || !(${sheetUp})`;
        let submitted = false;
        for (let attempt = 1; attempt <= 3 && !submitted; attempt += 1) {
            await inSheet('[data-testid="new-workspace-submit"]');
            await cursorClick('[data-testid="new-workspace-submit"]');
            submitted = await d.settleDom(page, creating, { ceilingMs: 3_000 });
            if (!submitted) log(`Create did not start (try ${String(attempt)}); clicking again`);
        }
        if (!submitted) throw new Error('Create never started the workspace');
        mark('submitted');
        // The sheet shows the worktree's progress and closes once the workspace exists.
        if (!(await d.settleDom(page, `!(${sheetUp})`, { ceilingMs: 120_000 }))) throw new Error('the New Workspace sheet never finished');
        mark('workspace-open');

        const hero = (await workspaces()).find((entry) => entry.name === 'rest-days');
        if (hero === undefined) throw new Error('rest-days was not created');
        await d.settle(async () => (await panesOf(hero.id)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
        const [coordinator] = await panesOf(hero.id);
        await cli.ok(['pane', 'name', 'coordinator'], asPane(coordinator.id));

        // ── what the take watches while the agents work ─────────────────────────────────
        // Workers are found by the names the coordinator's CLAUDE.md gives them. Done is "not
        // running any more": a pane someone is looking at, or has looked at, settles to idle
        // rather than waiting. The plan, the coordinator's own record, must be filled in.
        const state = { workers: new Map(), ran: new Set(), done: new Set(), coordinatorDone: false, failure: null };
        const planFile = path.join(demoHome, 'worktrees', 'paddock-api', 'rest-days', 'docs', 'plan.md');
        const planDone = () => {
            try {
                const plan = fs.readFileSync(planFile, 'utf8');
                return plan.includes('✅') && !plan.includes('🚧');
            } catch {
                return false;
            }
        };
        /**
         * Claude's folder trust prompt: 'open' while it waits, 'refused' once the shell is back
         * under it (Claude took "No, exit"), null when there is none.
         */
        const trustDialog = (text) => {
            const lines = text.split('\n');
            const at = lines.findLastIndex((line) => /Quick safety check|trust this folder/i.test(line));
            if (at < 0) return null;
            return lines.slice(at + 1).some((line) => /\$\s*$/.test(line)) ? 'refused' : 'open';
        };
        // The dialog opens on "No, exit" and can draw before it takes keys, so the answer moves
        // to "Yes" and confirms only once the screen shows it chosen.
        const answerTrust = async (pane) => {
            log(`answering the trust prompt in ${pane.label ?? pane.id}`);
            await sleep(1000);
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const text = await capture(pane.id);
                if (trustDialog(text) !== 'open') return;
                if (/❯\s*Yes, I trust/.test(text)) {
                    await cli.ok(['pane', 'send-key', '--target', pane.id, 'enter']);
                    await sleep(1500);
                    return;
                }
                await cli.ok(['pane', 'send-key', '--target', pane.id, 'down']);
                await sleep(500);
            }
        };
        let watching = true;
        const watcher = (async () => {
            const seenPrompts = new Set();
            while (watching) {
                try {
                    const panes = await allPanes();
                    for (const pane of panes) {
                        if (pane.type !== undefined && pane.type !== 'shell') continue;
                        const text = await capture(pane.id);
                        const trust = trustDialog(text);
                        if (trust === 'open') {
                            mark('trust');
                            await answerTrust(pane);
                        } else if (trust === 'refused') {
                            state.failure = `Claude in ${pane.label ?? pane.id} exited at its folder trust prompt`;
                        } else if (/Do you want to (proceed|make this edit|create)/i.test(text) && !seenPrompts.has(text)) {
                            seenPrompts.add(text);
                            const verdict = approvable(text, demoHome);
                            if (verdict.ok) {
                                mark('approved');
                                log(`approving in ${pane.label ?? pane.id}: ${verdict.why}`);
                                await cli.ok(['pane', 'send-key', '--target', pane.id, 'enter']);
                                await sleep(800);
                            } else {
                                state.failure = `a permission prompt in ${pane.label ?? pane.id} (${verdict.why}):\n${text.split('\n').slice(-25).join('\n')}`;
                            }
                        }
                    }
                    for (const entry of await workspaces()) {
                        for (const [role, name] of Object.entries(WORKERS)) {
                            if (entry.name === name && !state.workers.has(role)) {
                                state.workers.set(role, entry);
                                log(`worker ${name} (${String(entry.group_name)})`);
                            }
                        }
                    }
                    if (state.workers.size >= 1) mark('worker-started');
                    if (state.workers.size >= 2) mark('workers-started');
                    if (panes.some((pane) => pane.workspace_id === hero.id && pane.type === 'markdown')) mark('plan-open');
                    for (const [role, worker] of state.workers) {
                        const pane = panes.find((entry) => entry.workspace_id === worker.id && (entry.type ?? 'shell') === 'shell');
                        if (pane?.status === 'running') state.ran.add(role);
                        const settled = pane?.status === 'waitingForInput' || (pane?.status === 'idle' && state.ran.has(role));
                        if (settled && !state.done.has(role)) {
                            state.done.add(role);
                            log(`worker ${worker.name} is done (${String(pane?.status)})`);
                        }
                    }
                    const lead = panes.find((pane) => pane.id === coordinator.id);
                    if (state.done.size >= 2 && lead !== undefined && lead.status !== 'running' && planDone()) state.coordinatorDone = true;
                } catch (error) {
                    log(`watch: ${String(error)}`);
                }
                await sleep(700);
            }
        })();
        const until = async (test, what, ceilingMs) => {
            const deadline = Date.now() + ceilingMs;
            while (Date.now() < deadline) {
                if (state.failure !== null) throw new Error(`stopping the take: ${state.failure}`);
                if (await test()) return;
                await sleep(300);
            }
            throw new Error(`timed out waiting for ${what}`);
        };

        try {
            // Claude starts with the prompt pasted in; the person sends it.
            // Kelpi pastes the prompt once Claude says it is ready. A trust prompt on a path this
            // account has never opened can swallow that (the rehearsal take's job is to clear
            // them), so after a while the person types it instead.
            const prefilled = async () => (await capture(coordinator.id)).includes(PROMPT.slice(0, 24));
            try {
                await until(prefilled, 'the prefilled prompt', 45_000);
            } catch {
                log('no prefill; typing the prompt instead');
                await cli.ok(['pane', 'send', '--bare', '--target', coordinator.id, PROMPT]);
                await until(prefilled, 'the typed prompt', 15_000);
            }
            mark('prompt-ready');
            await sleep(900);
            await cli.ok(['pane', 'send-key', '--target', coordinator.id, 'enter']);
            mark('prompt-sent');

            // 2 and 3 · the coordinator plans and starts its workers; they work. The person
            // looks in on the web worker (the map it changed), then the API worker (its diff),
            // then goes back to the coordinator.
            await until(() => state.done.has('web'), 'the web worker to finish', 8 * 60_000);
            await sleep(1500);
            await cursorClick(rowOf(state.workers.get('web').id));
            mark('jumped-web');
            await sleep(5000);
            await until(() => state.done.has('api'), 'the API worker to finish', 6 * 60_000);
            await cursorClick(rowOf(state.workers.get('api').id));
            mark('jumped-api');
            await sleep(3500);
            await cursorClick(rowOf(hero.id));
            mark('back');
            await until(() => state.coordinatorDone, 'the coordinator to mark the plan done', 6 * 60_000);
            mark('coordinator-done');
            await sleep(3500);
            mark('end');
        } finally {
            watching = false;
            await watcher;
        }
    } finally {
        capturing = false;
        await captureLoop;
        await webLoop;
        for (const session of webSessions.values()) {
            try { session?.close(); } catch { /* already gone */ }
        }
        fs.writeFileSync(path.join(takeDir, 'frames.json'), JSON.stringify(frames));
        fs.writeFileSync(path.join(takeDir, 'web-shots.json'), JSON.stringify(webShots));
        fs.writeFileSync(path.join(takeDir, 'marks.json'), JSON.stringify(marks, null, 2));
        fs.writeFileSync(path.join(takeDir, 'cursor.json'), JSON.stringify(cursorTrack, null, 2));
        log(`take: ${String(frames.length)} frames and ${String(webShots.length)} web pane frames in ${takeDir}`);
        await t.stop();
        if (demoMade) fs.rmSync(demoHome, { recursive: true, force: true });
    }
});

await encode(takeDir);
process.exit(process.exitCode ?? 0);
