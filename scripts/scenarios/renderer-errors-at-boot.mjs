/** #239: errors in the first document must survive boot, including a document with no app root. */
export const covers = [
    'scripts/ui-audit/lib/driver.mjs',
    'scripts/ui-audit/lib/renderer-errors.mjs',
    'scripts/scenario.mjs',
    'packages/shell/src/harness-protocol.ts',
    'packages/shell/src/harness.ts',
    'packages/shell/src/main.ts'
];

export default async function ({ d, rec, repoRoot }) {
    let instance;
    const startupException = 'kelpi-239-first-document-exception';
    const startupConsole = 'kelpi-239-first-document-console';
    let intercepted = false;
    let interceptionError;
    let fulfillment;
    try {
        instance = await d.boot({
            repoRoot, label: 'early-error', build: false, window: 'hidden',
            beforeLoad: async (page) => {
                rec.check('CDP attaches before any client navigation', await page.eval('location.href') === 'about:blank');
                // Replace only this private instance's first document. Its scripts execute as
                // part of navigation, before boot returns, and deliberately never mount an app.
                page.on('Fetch.requestPaused', ({ requestId }) => {
                    intercepted = true;
                    fulfillment = page.send('Fetch.fulfillRequest', {
                        requestId, responseCode: 200,
                        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
                        body: Buffer.from(`<html><body><script>console.error('${startupConsole}'); throw new Error('${startupException}');</script></body></html>`).toString('base64')
                    }).catch((error) => { interceptionError = error; });
                });
                await page.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
            }
        });
        await fulfillment;
        rec.check('the first document was intercepted', intercepted && interceptionError === undefined, interceptionError);
        rec.check('boot returned despite the missing app root', await instance.page.eval(`document.querySelector('${d.PAGE.app}') === null`));
        const checks = [];
        instance.rendererErrors.finish({ check: (...args) => checks.push(args) });
        rec.check('startup errors fail the named renderer check', checks[0]?.[0] === 'the renderer threw nothing and logged no error' && checks[0]?.[1] === false, JSON.stringify(checks));
        rec.check('the first document exception is preserved exactly once', checks[0]?.[2]?.split(startupException).length === 2, JSON.stringify(checks));
        rec.check('the first document console error is preserved exactly once', checks[0]?.[2]?.split(startupConsole).length === 2, JSON.stringify(checks));
        const next = [];
        instance.rendererErrors.finish({ check: (...args) => next.push(args) });
        rec.check('startup errors are consumed once', next[0]?.[1] === true, JSON.stringify(next));
    } finally {
        await instance?.stop();
    }
}
