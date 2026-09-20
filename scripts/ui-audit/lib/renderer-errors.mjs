/**
 * Watch the page for uncaught exceptions and console errors, for one scenario (#235).
 *
 * WHY THIS EXISTS. `plugin-terminal-features` spent a week being triaged as four unrelated
 * phone flakes - a `phone-view-toggle` that matched nothing, a renderer that "did not attach",
 * a missing key bar, and a modifier that never reached the renderer. All four were one thing:
 * the client tore its entire React root down with error #185, the page went blank, and whichever
 * phone step came next reported the blankness in its own words. Nothing in this runner was
 * listening to the renderer, so the one line that named the bug was the only line never written
 * down. A scenario asserts about the DOM, and a page with no DOM left cannot fail honestly.
 *
 * So the runner listens for itself, and the result goes through the scenario's OWN recorder:
 * into `results.json` beside the checks, under the name of the scenario that was running when it
 * arrived. Per scenario rather than per run for exactly that reason - a shared sandbox runs many,
 * and an error belongs to the one that caused it.
 *
 * ARMED BEFORE THE FIRST CLIENT LOAD by driver.boot on a reviewed deferred-capable shell.
 * Legacy shells and attached sessions have post-attach coverage only; coverage records the
 * actual subscription/enable times and the frozen boot contract when one exists. `Runtime.enable`
 * does not replay what was reported before it
 * (unlike `Log.enable`, which buffers), so a watcher armed inside the loop cannot see a React root
 * that died while mounting, a failed first render, or anything thrown between two scenarios. That
 * is the same class of bug this exists to catch, one phase earlier. One watcher per page therefore
 * subscribes once and accumulates, and each scenario TAKES the lines that have arrived since the
 * last one took theirs. Boot-time errors land on the first scenario, which is the right place for
 * them: it is the first thing that could have noticed.
 *
 * `Runtime.enable` is idempotent, and a session that refuses it is reported as itself rather than
 * quietly watching nothing: "no errors seen" and "nobody looked" must not read the same.
 */
export async function watchRendererErrors(page, { timeoutMs = 60_000, scope = 'post-attach', bootCapability } = {}) {
    if (!['pre-first-load', 'post-attach'].includes(scope)) throw new Error('unknown renderer watcher scope');
    const subscribedAt = new Date().toISOString();
    const seen = [];
    let enableError = null;
    // Subscribe before enable: events may arrive before its acknowledgement.
    page.on('Runtime.exceptionThrown', (params) => {
        const details = params.exceptionDetails ?? {};
        seen.push(`uncaught: ${String(details.exception?.description ?? details.text ?? '?')}`);
    });
    page.on('Runtime.consoleAPICalled', (params) => {
        if (params.type !== 'error') return;
        seen.push(`console.error: ${(params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' ')}`);
    });
    try {
        await page.send('Runtime.enable', {}, timeoutMs);
    } catch (error) {
        enableError = error instanceof Error ? error.message : String(error);
    }
    const coverage = Object.freeze({ scope, firstDocument: scope === 'pre-first-load' && enableError === null,
        subscribedAt, enabledAt: enableError === null ? new Date().toISOString() : null,
        ...(bootCapability ? { bootCapability } : {}) });
    return {
        coverage,
        // A setup failure is not evidence that client code ran and failed. Boot must reject
        // it before navigation; attached instances still report it through the named check.
        enableError,
        get hasErrors() { return seen.length > 0; },
        /**
         * Take everything seen since the last call and record the verdict for this scenario.
         *
         * Never throws: this is the reporter, not a step. The subscriptions stay, because the page
         * outlives the scenario and the next one wants the same watch without a gap.
         */
        finish(rec) {
            rec.recordRendererCoverage?.(coverage);
            if (enableError !== null) {
                rec.check('the renderer was watched for errors', false, `Runtime.enable: ${enableError}`);
                return;
            }
            // Distinct, because one teardown produces the same line from every pane that echoes
            // it, and sixty copies of it would bury the checks it is meant to explain.
            const unique = [...new Set(seen.splice(0).map((line) => line.slice(0, 2000)))];
            rec.check('the renderer threw nothing and logged no error', unique.length === 0, unique.slice(0, 5).join(' | '));
        }
    };
}
