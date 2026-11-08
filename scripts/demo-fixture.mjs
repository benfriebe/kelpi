/**
 * The demo the README screenshots and the landing page video share: a plain zsh prompt and
 * Paddock, a grazing planner for a sheep farm, in two repositories: `paddock-api`, the grazing
 * maths and a small JSON server, and `paddock-web`, the paddock map page and its dev server.
 *
 * Nothing here is faked: the repositories are real git, the API's tests really run
 * (`node --test`), and the dev server really serves the map. `makeRepos` builds both under a
 * sandbox: bare origins under `sandbox.root`, clones at `<home>/paddock-api` and
 * `<home>/paddock-web`. The map page uses plain scripts and relative paths, so it also works
 * straight from disk (`kelpi open public/index.html`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Sam Rivera',
    GIT_AUTHOR_EMAIL: 'sam@paddock.test',
    GIT_COMMITTER_NAME: 'Sam Rivera',
    GIT_COMMITTER_EMAIL: 'sam@paddock.test'
};
export const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const write = (file, text, mode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, mode === undefined ? undefined : { mode });
};

export const ZSHRC = `# demo: a plain, readable prompt
autoload -Uz vcs_info
precmd() { vcs_info }
zstyle ':vcs_info:git:*' formats ' %F{magenta}(%b)%f'
setopt PROMPT_SUBST
PROMPT='%F{blue}%~%f\${vcs_info_msg_0_} %F{242}$%f '
HISTFILE=/dev/null
unsetopt PROMPT_SP
export CLICOLOR=1 PAGER=cat GIT_PAGER=cat
`;

/** The demo HOME's git identity, so nothing on screen or in a commit names this machine. */
export const GITCONFIG = '[user]\n\tname = Sam Rivera\n\temail = sam@paddock.test\n[init]\n\tdefaultBranch = main\n';

// ── paddock-api ──────────────────────────────────────────────────────────────────────

export const GRAZING_JS = `// Grazing maths for the planner. Areas are hectares, feed is kilograms of dry matter (kg DM).

export function feedOnOffer(paddock) {
    return Math.round(paddock.hectares * paddock.coverKgPerHa);
}

export function dailyDemand(mob) {
    return Math.round(mob.head * mob.intakeKg);
}

// Whole days a mob can stay before the paddock is grazed down to the residual.
export function grazingDays(paddock, mob, residualKgPerHa = 1200) {
    const available = feedOnOffer(paddock) - paddock.hectares * residualKgPerHa;
    return Math.max(0, Math.floor(available / dailyDemand(mob)));
}

export function stockingRate(mob, paddock) {
    return Math.round((mob.head / paddock.hectares) * 10) / 10;
}
`;

export const GRAZING_TEST = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dailyDemand, feedOnOffer, grazingDays, stockingRate } from '../src/grazing.js';

const creekFlat = { name: 'Creek Flat', hectares: 42.5, coverKgPerHa: 2350 };
const ewes = { head: 420, intakeKg: 1.6 };

describe('grazing', () => {
    it('totals the feed on offer', () => assert.equal(feedOnOffer(creekFlat), 99875));
    it('totals a mob\\'s daily demand', () => assert.equal(dailyDemand(ewes), 672));
    it('counts whole days above the residual', () => assert.equal(grazingDays(creekFlat, ewes), 72));
    it('takes a custom residual', () => assert.equal(grazingDays(creekFlat, ewes, 1500), 53));
    it('never plans negative days', () => assert.equal(grazingDays({ hectares: 10, coverKgPerHa: 900 }, ewes), 0));
    it('rounds the stocking rate to one place', () => assert.equal(stockingRate(ewes, creekFlat), 9.9));
});
`;

export const PADDOCKS_JSON = `${JSON.stringify([
    { name: 'Creek Flat', hectares: 42.5, coverKgPerHa: 2350, lastGrazed: '2026-11-05', mob: 'Mob 1' },
    { name: 'Top Hill', hectares: 61.2, coverKgPerHa: 1980, lastGrazed: '2026-09-28' },
    { name: 'Woolshed', hectares: 18.4, coverKgPerHa: 1640, lastGrazed: '2026-11-02', mob: 'Mob 2' },
    { name: 'Back Gully', hectares: 37.9, coverKgPerHa: 2210, lastGrazed: '2026-10-06' },
    { name: 'Long Paddock', hectares: 74.6, coverKgPerHa: 1720, lastGrazed: '2026-10-27' },
    { name: 'Dam Paddock', hectares: 29.3, coverKgPerHa: 2480, lastGrazed: '2026-11-07', mob: 'Mob 3' }
], null, 2)}\n`;

export const API_SERVER_JS = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { feedOnOffer } from './src/grazing.js';

const port = Number(process.env.PORT ?? 4300);
const paddocks = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'data', 'paddocks.json'), 'utf8'));

http.createServer((req, res) => {
    const started = Date.now();
    const found = req.url === '/paddocks';
    const body = found ? JSON.stringify(paddocks.map((paddock) => ({ ...paddock, feedKg: feedOnOffer(paddock) }))) : '{"error":"not found"}';
    res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    res.end(body);
    console.log(\`\${req.method} \${req.url} \${found ? 200 : 404} \${Date.now() - started}ms\`);
}).listen(port, '127.0.0.1', () => {
    console.log(\`paddock-api listening on http://127.0.0.1:\${port}\`);
});
`;

export const PLAN_MD = `# Spring rotation

Move the three mobs through the eastern paddocks before lambing, give every paddock at least
30 days of rest, and plan each move from the API's numbers.

## Status

| Mob | Paddock now | Next move | State |
|-----|-------------|-----------|-------|
| Mob 1 · 420 ewes | Creek Flat | Top Hill, 14 Nov | ✅ on track |
| Mob 2 · 260 weaners | Woolshed | Back Gully, 11 Nov | 🚧 cover short |
| Mob 3 · 35 rams | Dam Paddock | stays put | ⏳ after shearing |

## Tasks

- [x] Feed on offer per paddock in \`src/grazing.js\`
- [x] Grazing days for a mob, above a residual
- [ ] Rest days since the last mob left
- [ ] Rain gauge readings from the weather station

## Rules of thumb

1. Leave 1,200 kg DM/ha behind.
2. Rest every paddock 30 days or more.
3. Weigh the weaners at each move.

> Every number on the map comes from the API, so the page never does grazing maths itself.

\`\`\`js
grazingDays({ hectares: 42.5, coverKgPerHa: 2350 }, { head: 420, intakeKg: 1.6 }) // 72
\`\`\`
`;

export const API_README_MD = `# paddock-api

Grazing maths and the paddock list for Paddock. \`npm start\` serves \`GET /paddocks\` on port
4300; \`npm test\` runs the unit tests.
`;

// ── paddock-web ──────────────────────────────────────────────────────────────────────

export const WEB_SERVER_JS = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.PORT ?? 4173);
const root = path.join(import.meta.dirname, 'public');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
    const started = Date.now();
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url);
    fs.readFile(file, (error, body) => {
        res.writeHead(error ? 404 : 200, { 'content-type': types[path.extname(file)] ?? 'text/plain' });
        res.end(error ? 'not found' : body);
        console.log(\`\${req.method} \${req.url} \${error ? 404 : 200} \${Date.now() - started}ms\`);
    });
}).listen(port, '127.0.0.1', () => {
    console.log(\`paddock-web dev server ready on http://127.0.0.1:\${port}\`);
});
`;

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Paddocks · Wattle Creek</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <strong class="brand"><i class="logo"></i>Paddock</strong>
  <nav><a class="now">Map</a><a>Mobs</a><a>Rainfall</a><a>Reports</a></nav>
  <span class="farm">Wattle Creek · 264 ha</span>
</header>
<main>
  <section>
    <div class="head"><h1>Paddocks</h1><p id="summary"></p></div>
    <div id="paddocks" class="grid"></div>
  </section>
  <aside>
    <h2>Mobs</h2>
    <ul id="mobs" class="mobs"></ul>
    <h2>Rain this week</h2>
    <div class="rain"><i style="height:20%"></i><i style="height:65%"></i><i style="height:90%"></i><i style="height:10%"></i><i style="height:0%"></i><i style="height:35%"></i><i style="height:50%"></i></div>
    <p class="note">31.4 mm at the woolshed gauge</p>
  </aside>
</main>
<script src="paddocks.js"></script>
<script src="app.js"></script>
</body>
</html>
`;

export const PADDOCKS_JS = `// What the API's GET /paddocks returns, kept here so the page also works straight from disk.
window.PADDOCKS = [
    { name: 'Creek Flat', hectares: 42.5, coverKgPerHa: 2350, restDays: 0, mob: 'Mob 1' },
    { name: 'Top Hill', hectares: 61.2, coverKgPerHa: 1980, restDays: 41 },
    { name: 'Woolshed', hectares: 18.4, coverKgPerHa: 1640, restDays: 0, mob: 'Mob 2' },
    { name: 'Back Gully', hectares: 37.9, coverKgPerHa: 2210, restDays: 33 },
    { name: 'Long Paddock', hectares: 74.6, coverKgPerHa: 1720, restDays: 12 },
    { name: 'Dam Paddock', hectares: 29.3, coverKgPerHa: 2480, restDays: 0, mob: 'Mob 3' }
];

window.MOBS = [
    { name: 'Mob 1', head: 420, kind: 'Merino ewes', paddock: 'Creek Flat', day: 3, days: 7 },
    { name: 'Mob 2', head: 260, kind: 'Weaners', paddock: 'Woolshed', day: 6, days: 6 },
    { name: 'Mob 3', head: 35, kind: 'Rams', paddock: 'Dam Paddock', day: 1, days: 12 }
];
`;

export const APP_JS = `// Draws the paddock map from window.PADDOCKS and the mob list from window.MOBS.

function coverClass(kgPerHa) {
    if (kgPerHa >= 2200) return 'lush';
    if (kgPerHa >= 1800) return 'good';
    return 'short';
}

function card(paddock) {
    const status = paddock.mob
        ? '<span class="grazing">Grazing · ' + paddock.mob + '</span>'
        : '<span class="rest">Rested ' + paddock.restDays + ' days</span>';
    return '<article class="paddock ' + coverClass(paddock.coverKgPerHa) + '">' +
        '<div class="field"></div>' +
        '<h3>' + paddock.name + '</h3>' +
        '<p class="meta">' + paddock.hectares + ' ha · ' + paddock.coverKgPerHa.toLocaleString('en') + ' kg DM/ha</p>' +
        '<p class="status">' + status + '</p>' +
        '</article>';
}

function mobRow(mob) {
    return '<li><b>' + mob.name + '</b><span>' + mob.head + ' ' + mob.kind + '</span>' +
        '<small>' + mob.paddock + ', day ' + mob.day + ' of ' + mob.days + '</small></li>';
}

const head = window.MOBS.reduce((sum, mob) => sum + mob.head, 0);
document.getElementById('summary').textContent =
    window.PADDOCKS.length + ' paddocks · ' + window.MOBS.length + ' mobs · ' + head + ' head';
document.getElementById('paddocks').innerHTML = window.PADDOCKS.map(card).join('');
document.getElementById('mobs').innerHTML = window.MOBS.map(mobRow).join('');
`;

export const STYLE_CSS = `* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2a1c; background: #f4f1e8; }
header { display: flex; align-items: center; gap: 28px; padding: 14px 28px; background: #fffdf7; border-bottom: 1px solid #e4dfcf; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 17px; letter-spacing: -0.01em; }
.logo { width: 18px; height: 18px; border-radius: 5px; background: #4f7a3a; }
nav a { margin-right: 16px; color: #6b705f; }
nav .now { color: #1f2a1c; font-weight: 600; }
.farm { margin-left: auto; color: #6b705f; font-size: 13px; white-space: nowrap; }
@media (max-width: 600px) { .farm { display: none; } }
main { display: grid; grid-template-columns: 1fr; gap: 22px; padding: 22px 28px; }
@media (min-width: 720px) { main { grid-template-columns: 1fr 220px; } }
.head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
h1 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
.head p { margin: 0; color: #6b705f; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
.paddock { position: relative; padding: 0 0 12px; overflow: hidden; background: #fffdf7; border: 1px solid #e4dfcf; border-radius: 12px; }
.field { height: 64px; margin-bottom: 10px; background: repeating-linear-gradient(115deg, rgba(255,255,255,0.12) 0 6px, transparent 6px 14px), var(--grass); }
.lush { --grass: #5f8f45; } .good { --grass: #8fae5a; } .short { --grass: #c9b979; }
.paddock h3 { margin: 0 12px 2px; font-size: 14px; }
.meta { margin: 0 12px 8px; color: #6b705f; font-size: 12px; }
.status { margin: 0 12px; font-size: 12px; }
.grazing { color: #7a4f1d; font-weight: 600; }
.rest { color: #4a5a44; }
aside { align-self: start; padding: 16px; background: #fffdf7; border: 1px solid #e4dfcf; border-radius: 12px; }
h2 { margin: 0 0 10px; font-size: 14px; }
.mobs { margin: 0 0 18px; padding: 0; list-style: none; }
.mobs li { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; margin-bottom: 10px; font-size: 13px; }
.mobs b { font-weight: 600; } .mobs span { color: #4a5a44; } .mobs small { grid-column: 1 / -1; color: #8a8d7c; }
.rain { display: flex; align-items: flex-end; gap: 6px; height: 56px; padding-bottom: 2px; border-bottom: 1px solid #e4dfcf; }
.rain i { flex: 1; min-height: 2px; background: #6f9fbf; border-radius: 3px 3px 0 0; }
.note { margin: 8px 0 0; color: #8a8d7c; font-size: 12px; }
`;

export const WEB_README_MD = `# paddock-web

The paddock map. \`npm run dev\` serves it on port 4173, and \`public/index.html\` also opens
straight from disk.
`;

/**
 * Bare origins under the sandbox root, and clones of them at `<home>/paddock-api` and
 * `<home>/paddock-web`, each with some history. `home` defaults to the sandbox's HOME; `extra`
 * is one more commit per repository, `{ api?: { message, files }, web?: { message, files } }`,
 * made before the clone, so every clone and worktree has it.
 *
 * paddock-web's origin gets a few more commits after the clone, about 3 MB of aerial tiles that
 * do not compress, served slowly by the fixture's own upload-pack wrapper, so a New Workspace
 * that updates main first visibly counts its fetch up.
 */
export function makeRepos(sandbox, { home = sandbox.home, extra = {} } = {}) {
    const origins = path.join(sandbox.root, 'origins');
    fs.mkdirSync(origins, { recursive: true });
    const seedRepo = (name) => {
        const origin = path.join(origins, `${name}.git`);
        const seed = path.join(origins, `${name}-seed`);
        git(origins, 'init', '-q', '--bare', '--initial-branch=main', origin);
        git(origins, 'clone', '-q', origin, seed);
        git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        const commit = (message, files) => {
            for (const [file, text] of Object.entries(files)) write(path.join(seed, file), text);
            // By name and forced: the machine's global gitignore must not decide what the demo
            // holds (one that ignores CLAUDE.md would leave the agents without instructions).
            git(seed, 'add', '-f', '--', ...Object.keys(files));
            git(seed, 'commit', '-q', '-m', message);
        };
        const publish = () => {
            git(seed, 'push', '-q', 'origin', 'main');
            const clone = path.join(home, name);
            git(home, 'clone', '-q', origin, clone);
            return clone;
        };
        return { origin, seed, commit, publish };
    };

    const apiRepo = seedRepo('paddock-api');
    apiRepo.commit('Initial grazing planner', {
        'README.md': API_README_MD,
        'package.json': `${JSON.stringify({ name: 'paddock-api', private: true, type: 'module', scripts: { start: 'node server.js', test: 'node --test' } }, null, 2)}\n`,
        '.gitignore': 'node_modules/\n'
    });
    apiRepo.commit('Feed on offer and grazing days', { 'src/grazing.js': GRAZING_JS });
    apiRepo.commit('Test the grazing maths', { 'test/grazing.test.js': GRAZING_TEST });
    apiRepo.commit('Serve the paddock list', { 'server.js': API_SERVER_JS, 'data/paddocks.json': PADDOCKS_JSON });
    apiRepo.commit('Write up the spring rotation', { 'docs/rotation-plan.md': PLAN_MD });
    if (extra.api !== undefined) apiRepo.commit(extra.api.message, extra.api.files);
    const api = apiRepo.publish();

    const webRepo = seedRepo('paddock-web');
    webRepo.commit('Initial paddock map', {
        'README.md': WEB_README_MD,
        'package.json': `${JSON.stringify({ name: 'paddock-web', private: true, type: 'module', scripts: { dev: 'node server.js' } }, null, 2)}\n`,
        '.gitignore': 'node_modules/\n'
    });
    webRepo.commit('Add a dev server for the static pages', { 'server.js': WEB_SERVER_JS });
    webRepo.commit('Paddock map with cover and rest days', { 'public/index.html': INDEX_HTML, 'public/style.css': STYLE_CSS, 'public/app.js': APP_JS, 'public/paddocks.js': PADDOCKS_JS });
    if (extra.web !== undefined) webRepo.commit(extra.web.message, extra.web.files);
    const web = webRepo.publish();

    for (let index = 0; index < 150; index += 1) {
        write(path.join(webRepo.seed, 'public', 'tiles', `tile-${String(index).padStart(3, '0')}.bin`), execFileSync('head', ['-c', '20000', '/dev/urandom']));
    }
    git(webRepo.seed, 'add', '.');
    git(webRepo.seed, 'commit', '-q', '-m', 'Aerial tiles for the map');
    git(webRepo.seed, 'push', '-q', 'origin', 'main');
    const throttle = path.join(origins, 'slow-upload-pack.sh');
    write(
        throttle,
        '#!/bin/sh\n# Fixture: git-upload-pack at about 0.8 MB/s, so a fetch shows its progress.\n' +
            'git-upload-pack "$@" | perl -e \'$|=1; while (sysread(STDIN, $b, 16384)) { syswrite(STDOUT, $b); select(undef, undef, undef, 0.02); }\'\n',
        0o755
    );
    git(web, 'config', 'remote.origin.uploadpack', throttle);
    return { api, web, origins };
}
