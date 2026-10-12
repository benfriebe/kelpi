// Keeps the editor and the daemon's scratchpad buffer in step, on Document Lab's rules: every
// input is staged in the host window before its revision-checked write, writes are serialized
// with only the newest input queued, and a conflict caused by autosave alone is retried once.
// Anything else (another window or the CLI changed the text) stops editing; the host keeps the
// local text as a recovery draft.

/** The smallest single replacement that turns `before` into `after`, or null when equal. */
export function textChange(before, after) {
    if (before === after) return null;
    const shorter = Math.min(before.length, after.length);
    let start = 0;
    while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    let end = 0;
    while (end < shorter - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
    return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

const CONTEXT_KEYS = ['paneID', 'workspaceID', 'kind', 'mode', 'path', 'text', 'loaded'];

/**
 * `hooks.onText(text)` receives the daemon's text whenever no local input is outstanding.
 * `hooks.onProblem(message, {conflict})` reports a failure (null clears it); `conflict` means
 * editing has stopped until `reload()`.
 */
export function createDocumentSync(api, hooks) {
    let subscription = null, writeState = null;
    let inputs = 0, accepted = 0, queued = null, writing = false, blocked = false, stopped = false;
    let reading = false, reread = false;
    const offs = [];

    const idle = () => inputs === accepted && !writing && !blocked;

    function receive(next) {
        // A daemon snapshot never rebases text this view has not had acknowledged yet.
        if (!idle() || stopped) return;
        writeState = next;
        hooks.onText(next.text);
    }
    function fail(error, conflict) {
        if (conflict) blocked = true;
        hooks.onProblem(error?.message ?? String(error), { conflict });
    }
    async function readLatest() {
        reread = true;
        if (reading) return;
        reading = true;
        try {
            do { reread = false; const next = await api.documents.get(); receive(next); } while (reread && !stopped);
        } catch (error) { if (!stopped) fail(error, false); } finally { reading = false; }
    }
    async function apply(edit) {
        try { return await api.documents.applyDraft(edit.id, writeState.revision); } catch (error) {
            if (error?.code !== 'DOCUMENT_CONFLICT' || stopped) throw error;
            const current = await api.documents.get();
            // Autosave moves the revision without touching the source. Only that is reconciled.
            if (stopped || !CONTEXT_KEYS.every(key => current[key] === writeState[key])) throw error;
            writeState = current;
            return api.documents.applyDraft(edit.id, writeState.revision);
        }
    }
    async function pump() {
        if (writing || blocked || stopped) return;
        writing = true;
        try {
            while (queued && !blocked && !stopped) {
                const edit = queued; queued = null;
                try {
                    const next = await apply(edit);
                    if (next.text !== edit.text) throw new Error('The scratchpad changed before this edit was saved.');
                    writeState = next; accepted = edit.number;
                } catch (error) {
                    // A newer staged input replaced this one; its own write follows.
                    if (error?.code !== 'DOCUMENT_DRAFT_SUPERSEDED') fail(conflictMessage(error), true);
                }
            }
        } finally { writing = false; }
    }

    return {
        /** Watch the pane's document and return its first snapshot. */
        async start() {
            offs.push(api.events.on('documents.changed', event => { if (event.data.subscription === subscription) void readLatest(); }));
            offs.push(api.events.on('documents.closed', event => {
                if (event.data.subscription !== subscription) return;
                stopped = true; hooks.onClosed?.();
            }));
            const watched = await api.documents.watch();
            subscription = watched.subscription; writeState = watched.state;
            return watched.state;
        },
        /** The editor's whole text after a local change. */
        edit(text) {
            if (blocked || stopped) return;
            const number = ++inputs;
            void api.documents.stage(text, writeState?.revision).then(draft => {
                if (number !== inputs || stopped) return;
                queued = { id: draft.id, text, number }; void pump();
            }).catch(error => fail(error, true));
        },
        /** After a conflict: take the daemon's text. The host keeps the local draft. */
        async reload() {
            const next = await api.documents.get();
            queued = null; inputs = accepted = 0; blocked = false;
            hooks.onProblem(null, { conflict: false });
            receive(next);
        },
        get blocked() { return blocked || stopped; },
        stop() {
            stopped = true;
            for (const off of offs.splice(0)) off();
            if (subscription) void api.documents.unwatch(subscription).catch(() => {});
        }
    };
}

function conflictMessage(error) {
    if (error?.code === 'DOCUMENT_CONFLICT' || /changed before/.test(error?.message ?? '')) {
        return 'This scratchpad was changed somewhere else, so editing has stopped here. Your text is kept as a recovery draft.';
    }
    return `Your last edit was not saved: ${error?.message ?? error}. Your text is kept as a recovery draft.`;
}
