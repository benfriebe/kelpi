/**
 * #375: the web pane remembers the pages the USER navigates to, prefills the URL bar from them,
 * and suggests them in a list under it. Nothing an agent loads is remembered.
 *
 * Driven end to end against the real app: Settings clears the history first (the battery shares
 * one daemon, and an earlier scenario's clicks inside a page are the user's), `kelpi web open` is
 * the agent, and the URL bar is typed into one physical key at a time, because the prefill only
 * answers a typed character (`insertText`), never a paste.
 */

import http from 'node:http';

export const covers = [
    'packages/client/src/webpane/WebPane.tsx',
    'packages/client/src/webpane/HistorySuggestions.tsx',
    'packages/client/src/webpane/history.ts',
    'packages/client/src/features/BrowserFeaturePane.tsx',
    'packages/client/src/settings/WebTab.tsx',
    'packages/daemon/src/webpane/history.ts',
    'packages/daemon/src/webpane/service.ts',
    'packages/daemon/src/webpane/handlers.ts',
    'packages/daemon/src/ws/web-ui.ts',
    'packages/shell/src/webhost/tab.ts'
];

const page = (title, body) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const PAGES = {
    '/': page('History Home', '<a href="/guide">guide</a>'),
    '/guide': page('Zebra Guide Page', '<p>the guide</p>'),
    '/agent-only': page('Agent Only Page', '<p>an agent was here</p>')
};

/** Punctuation an address needs, as `code` and Windows virtual key (`.` is 190, not 46: 46 is Delete). */
const PUNCTUATION = {
    '.': { code: 'Period', keyCode: 190 },
    '/': { code: 'Slash', keyCode: 191 },
    ':': { code: 'Semicolon', keyCode: 186, shift: true },
    '-': { code: 'Minus', keyCode: 189 }
};

/** One physical key per character: `type()` also sends a `char`, which inserts twice into a field. */
async function typeKeys(target, text) {
    for (const character of text) {
        const punctuation = PUNCTUATION[character];
        const code =
            punctuation?.code ?? (/[a-z]/i.test(character) ? `Key${character.toUpperCase()}` : `Digit${character}`);
        const keyCode = punctuation?.keyCode ?? character.toUpperCase().charCodeAt(0);
        await target.key(code, { key: character, text: character, keyCode, modifiers: punctuation?.shift === true ? 8 : 0 });
    }
}

export default async function ({ page: client, cli, shell, rec, d, sleep }) {
    if (shell === null) {
        rec.check('this scenario needs the sandbox this runner boots', false, 'run it without --attach');
        return;
    }
    const server = http.createServer((request, response) => {
        const body = PAGES[request.url ?? '/'] ?? PAGES['/'];
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const host = `127.0.0.1:${String(server.address().port)}`;
    const base = `http://${host}`;

    let paneID = null;
    try {
        // ── a clean slate, through the one control Settings has for it ────────────────────
        await d.openSettingsTab(client, 'web');
        await client.click('[data-testid="settings-web-history-clear"]');
        const confirm = await d.settleDom(client, `document.querySelector('[data-testid="settings-web-history-confirm"]')`, { ceilingMs: 3_000 });
        rec.check('Settings ▸ Web asks before clearing the browsing history', confirm);
        if (confirm) await client.click('[data-testid="settings-web-history-confirm"]');
        rec.check(
            'and says it was cleared',
            await d.settleDom(client, `document.querySelector('[data-testid="settings-web-history-cleared"]')`, { ceilingMs: 3_000 })
        );
        await client.key('Escape');
        await d.settle(async () => (await client.eval(`document.querySelector('${d.PAGE.settingsPanel}') === null`)) === true, { ceilingMs: 5_000 });

        // ── the agent opens a page: nothing is remembered ─────────────────────────────────
        const opened = await cli.run(['web', 'open', `${base}/agent-only`], { timeoutMs: 60_000 });
        paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened.stdout) ?? [])[1] ?? null;
        rec.check('`kelpi web open` opened a web pane on the fixture', paneID !== null, opened.stdout || opened.stderr);
        if (paneID === null) return;
        const field = `[data-testid="web-url-${paneID}"]`;
        const list = `[data-testid="web-history-list-${paneID}"]`;
        const titleIs = async (title) =>
            d.settle(async () => (await cli.run(['web', 'url', '--target', paneID, '--json'])).stdout.includes(title), { ceilingMs: 20_000 });
        rec.check('the agent\'s page loaded', await titleIs('Agent Only Page'));

        const fieldState = async () =>
            JSON.parse(
                String(
                    await client.eval(`(() => {
                        const input = document.querySelector('${field}');
                        return JSON.stringify({ value: input?.value ?? null, start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null });
                    })()`)
                )
            );
        const rowTexts = async () =>
            JSON.parse(
                String(
                    await client.eval(
                        `JSON.stringify([...document.querySelectorAll('${list} [role="option"]')].map((row) => row.innerText.replace(/\\s+/g, ' ').trim()))`
                    )
                )
            );
        /** Focus the bar, select what is in it, and type `text` over it, key by key. */
        const typeInBar = async (text) => {
            await client.click(field);
            await client.eval(`document.querySelector('${field}')?.select()`);
            await typeKeys(client, text);
        };

        await typeInBar('agent');
        const listUp = await d.settleDom(client, `document.querySelector('${list}')`, { ceilingMs: 3_000 });
        rec.check('typing in the bar puts the suggestion list up', listUp);
        await sleep(600);
        rec.check('the page the agent opened is not suggested', (await rowTexts()).length === 0, JSON.stringify(await rowTexts()));
        await client.key('Escape');

        // ── the user types an address: it is remembered as typed ──────────────────────────
        await typeInBar(`${host}/guide`);
        await client.key('Enter');
        rec.check('the address the user typed loaded', await titleIs('Zebra Guide Page'));
        await sleep(400);

        await typeInBar('127.0');
        const prefilled = await d.settle(async () => (await fieldState()).value === `${host}/`, { ceilingMs: 3_000 });
        const state = await fieldState();
        rec.check('the bar prefills the site the user typed', prefilled, JSON.stringify(state));
        rec.check('with the prefilled part selected, after what was typed', state.start === 5 && state.end === `${host}/`.length, JSON.stringify(state));
        await rec.shot(client, 'prefill');

        await client.key('Escape');
        await typeInBar('zebra');
        const suggested = await d.settle(async () => (await rowTexts()).some((text) => text.includes('Zebra Guide Page')), { ceilingMs: 3_000 });
        rec.check('the list suggests the page by a word in its title', suggested, JSON.stringify(await rowTexts()));
        await rec.shot(client, 'suggestions');

        // ── Shift+Delete forgets it ───────────────────────────────────────────────────────
        await client.key('ArrowDown');
        await client.key('Backspace', { modifiers: 8 });
        const removed = await d.settle(async () => (await rowTexts()).length === 0, { ceilingMs: 3_000 });
        rec.check('Shift+Backspace on the highlighted row removes it', removed, JSON.stringify(await rowTexts()));
        await client.key('Escape');
        await typeInBar('zebra');
        await sleep(600);
        rec.check('and it stays forgotten', (await rowTexts()).length === 0, JSON.stringify(await rowTexts()));
        await client.key('Escape');
    } finally {
        if (paneID !== null) await cli.run(['pane', 'close', '--target', paneID]);
        server.close();
    }
}
