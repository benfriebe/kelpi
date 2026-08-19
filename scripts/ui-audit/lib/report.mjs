/**
 * The audit's output side: numbered screenshots, machine-checkable assertions, and the two
 * documents a human actually reads.
 *
 * The contract each step signs:
 *
 *   - **screenshot** — always. The audit exists because 3038 green structural tests did not
 *     stop a broken first impression; a step with no picture proves nothing.
 *   - **expect** — one sentence of prose saying what a person should SEE. It is written before
 *     the step runs, so a passing assertion cannot quietly redefine the expectation.
 *   - **assertions** — zero or more machine checks (`check(...)`). These catch regressions on
 *     re-runs without a human in the loop.
 *   - **needsEyes** — the honest admission that some things (tofu glyphs, clipped columns,
 *     spacing, contrast) have no DOM signal at all. A step flagged `needs-eyes` is NOT passing
 *     until someone looks at its PNG; `index.md` says so and `FINDINGS.md` leaves a slot.
 */

import fs from 'node:fs';
import path from 'node:path';

export function createReport({ outDir, meta }) {
    fs.mkdirSync(outDir, { recursive: true });
    const steps = [];
    let counter = 0;

    return {
        outDir,
        meta,
        steps,

        /** Begin a step; returns a recorder the flow fills in as it goes. */
        step(id, { expect, needsEyes = false, notes = [] } = {}) {
            counter += 1;
            const index = String(counter).padStart(2, '0');
            const entry = {
                index,
                id,
                slug: `${index}-${id}`,
                expect: expect ?? '',
                needsEyes,
                notes: [...notes],
                assertions: [],
                shots: [],
                blocks: [],
                error: null,
                startedAt: new Date().toISOString()
            };
            steps.push(entry);
            process.stdout.write(`\n[${index}] ${id}\n`);
            if (expect !== undefined) process.stdout.write(`     expect: ${expect}\n`);

            const recorder = {
                entry,
                /** Record an assertion result. */
                check(name, condition, detail = '') {
                    const ok = condition === true;
                    entry.assertions.push({ name, ok, detail: String(detail) });
                    process.stdout.write(`     ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  — ${String(detail)}`}\n`);
                    return ok;
                },
                /** Record a value worth reading back later (capture text, counts, …). */
                note(text) {
                    entry.notes.push(String(text));
                    process.stdout.write(`     · ${String(text)}\n`);
                },
                /** Flag the step as requiring human/vision judgment. */
                eyes(reason) {
                    entry.needsEyes = true;
                    if (reason !== undefined) entry.notes.push(`needs-eyes: ${reason}`);
                },
                /** Capture a screenshot into the run directory. */
                async shot(session, suffix = '') {
                    const name = suffix === '' ? `${entry.slug}.png` : `${entry.slug}-${suffix}.png`;
                    const file = path.join(outDir, name);
                    await session.screenshot(file);
                    entry.shots.push(name);
                    process.stdout.write(`     ▸ ${name}\n`);
                    return file;
                },
                /**
                 * Embed a verbatim text block in `index.md` — the other half of a parity
                 * check, so the reader can hold the CLI's idea of the screen next to the
                 * screenshot of the screen.
                 */
                block(title, text) {
                    entry.blocks.push({ title: String(title), text: String(text) });
                },
                /** Store a text artefact (terminal capture, CLI output) next to the PNGs. */
                artifact(name, contents) {
                    const file = path.join(outDir, `${entry.slug}-${name}`);
                    fs.writeFileSync(file, contents);
                    entry.notes.push(`artifact: ${path.basename(file)}`);
                    return file;
                },
                fail(error) {
                    entry.error = String(error?.stack ?? error);
                    process.stdout.write(`     ✗ STEP ERROR: ${String(error?.message ?? error)}\n`);
                }
            };
            return recorder;
        },

        /** Wrap a flow so one broken step cannot abort the rest of the audit. */
        async guard(recorder, body) {
            try {
                await body();
            } catch (error) {
                recorder.fail(error);
            } finally {
                recorder.entry.finishedAt = new Date().toISOString();
            }
        },

        summary() {
            const total = steps.length;
            const failedAssertions = steps.reduce(
                (sum, step) => sum + step.assertions.filter((assertion) => !assertion.ok).length,
                0
            );
            const errored = steps.filter((step) => step.error !== null).length;
            const eyes = steps.filter((step) => step.needsEyes).length;
            const assertions = steps.reduce((sum, step) => sum + step.assertions.length, 0);
            return { total, assertions, failedAssertions, errored, eyes };
        },

        write() {
            const summary = this.summary();
            fs.writeFileSync(
                path.join(outDir, 'results.json'),
                `${JSON.stringify({ meta, summary, steps }, null, 2)}\n`
            );
            fs.writeFileSync(path.join(outDir, 'index.md'), renderIndex({ meta, summary, steps }));
            // The seed is scaffolding for a human verdict; once someone has written real findings
            // into it, a re-run must never throw that away.
            const findings = path.join(outDir, 'FINDINGS.md');
            if (!fs.existsSync(findings)) {
                fs.writeFileSync(findings, renderFindingsSeed({ meta, summary, steps }));
            } else {
                fs.writeFileSync(path.join(outDir, 'FINDINGS.seed.md'), renderFindingsSeed({ meta, summary, steps }));
            }
            return summary;
        }
    };
}

function renderIndex({ meta, summary, steps }) {
    const lines = [];
    lines.push('# UI audit run');
    lines.push('');
    lines.push(`- **when**: ${meta.startedAt}`);
    lines.push(`- **commit**: \`${meta.commit}\``);
    lines.push(`- **shell**: ${meta.shellMode}`);
    lines.push(`- **sandbox**: \`${meta.sandboxRoot}\``);
    lines.push(
        `- **result**: ${String(summary.total)} steps · ${String(summary.assertions)} assertions · ` +
            `${String(summary.failedAssertions)} failed · ${String(summary.errored)} step errors · ` +
            `${String(summary.eyes)} need eyes`
    );
    lines.push('');
    lines.push(
        'Every step below is a real user action driven through CDP against a private daemon + shell. ' +
            '`needs-eyes` means no DOM signal can decide it — a human (or a vision model) has to look at the PNG. ' +
            'Verdicts live in `FINDINGS.md`.'
    );
    lines.push('');
    for (const step of steps) {
        lines.push(`## ${step.index}. ${step.id}`);
        lines.push('');
        if (step.expect !== '') lines.push(`**Expect:** ${step.expect}`);
        lines.push('');
        for (const shot of step.shots) lines.push(`![${step.id}](./${shot})`);
        lines.push('');
        if (step.assertions.length > 0) {
            lines.push('| check | result | detail |');
            lines.push('| --- | --- | --- |');
            for (const assertion of step.assertions) {
                lines.push(
                    `| ${escapeCell(assertion.name)} | ${assertion.ok ? 'pass' : '**FAIL**'} | ${escapeCell(assertion.detail)} |`
                );
            }
            lines.push('');
        }
        if (step.needsEyes) {
            lines.push('> **needs-eyes** — this step cannot be decided by a DOM query.');
            lines.push('');
        }
        for (const block of step.blocks) {
            lines.push(`<details><summary>${escapeCell(block.title)}</summary>`);
            lines.push('');
            lines.push('```');
            lines.push(block.text.replace(/```/g, "'''"));
            lines.push('```');
            lines.push('');
            lines.push('</details>');
            lines.push('');
        }
        if (step.notes.length > 0) {
            for (const note of step.notes) lines.push(`- ${escapeCell(note)}`);
            lines.push('');
        }
        if (step.error !== null) {
            lines.push('```');
            lines.push(step.error);
            lines.push('```');
            lines.push('');
        }
    }
    return `${lines.join('\n')}\n`;
}

/**
 * A FINDINGS skeleton, pre-filled with everything the machine already knows. A human (or the
 * agent that ran the audit) replaces each `TBD` after LOOKING at the screenshot.
 */
function renderFindingsSeed({ meta, summary, steps }) {
    const lines = [];
    lines.push('# Findings — TEMPLATE (fill in after viewing every screenshot)');
    lines.push('');
    lines.push(`Run: ${meta.startedAt} · commit \`${meta.commit}\` · shell ${meta.shellMode}`);
    lines.push('');
    lines.push(
        `${String(summary.failedAssertions)} assertion failures and ${String(summary.errored)} step errors were ` +
            'detected automatically; everything else needs eyes.'
    );
    lines.push('');
    lines.push('Severity scale: **blocker** (unusable) · **major** (wrong / misleading) · **minor** (polish) · **nit**.');
    lines.push('');
    for (const step of steps) {
        const auto = [
            ...step.assertions.filter((assertion) => !assertion.ok).map((assertion) => `assertion failed: ${assertion.name} — ${assertion.detail}`),
            ...(step.error === null ? [] : ['step errored (see index.md)'])
        ];
        lines.push(`## ${step.index}. ${step.id}`);
        lines.push('');
        lines.push(`- screenshot: ${step.shots.map((shot) => `\`${shot}\``).join(', ') || '_none_'}`);
        lines.push(`- expected: ${step.expect}`);
        lines.push(`- verdict: ${auto.length > 0 ? '**DEFECT**' : 'TBD'}`);
        lines.push(`- severity: ${auto.length > 0 ? 'TBD' : 'TBD'}`);
        if (auto.length > 0) for (const item of auto) lines.push(`- auto: ${item}`);
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

function escapeCell(value) {
    return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
