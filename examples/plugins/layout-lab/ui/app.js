// Layout Lab: one script for three bands. Each view declares its band height in the manifest and
// renders the window's arrangement commands from the chrome snapshot, so every button here is
// the same verb as the View menu row, the palette entry and the chord.
const api = globalThis.kelpi;
const element = id => document.getElementById(id);
const view = document.body.dataset.view;
// The toolbar and the panel carry every command; the thin status bar only the three that matter
// most when bands are missing.
const WANTED = view === 'status'
    ? ['kelpi.zenMode.toggle', 'kelpi.toolbar.toggle', 'kelpi.window.resetArrangement']
    : ['kelpi.zenMode.toggle', 'kelpi.toolbar.toggle', 'kelpi.statusbar.toggle', 'kelpi.panel.bottom.toggle', 'kelpi.window.resetArrangement'];
let disposed = false, hiddenCount = 0, lastVisible = null;

function failed(error) {
    if (disposed) return;
    const output = element('error'); output.textContent = error.message; output.title = error.message; output.hidden = false;
}
function render(snapshot) {
    if (disposed) return;
    const host = element('commands');
    const commands = WANTED.map(id => snapshot.commands.find(command => command.id === id)).filter(Boolean);
    host.replaceChildren(...commands.map(command => {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.command = command.id; button.textContent = command.title;
        button.disabled = !command.enabled;
        if (command.checked !== undefined) button.setAttribute('aria-pressed', String(command.checked));
        button.addEventListener('click', () => {
            element('error').hidden = true;
            api.ui.executeChromeCommand(command.id, {}).catch(failed);
        });
        return button;
    }));
    document.body.dataset.ready = 'true';
}
// Visibility is the host's to report: a hidden band keeps this document and says `visible=false`.
function visibility(visible) {
    if (lastVisible === true && visible === false) hiddenCount += 1;
    lastVisible = visible;
    document.body.dataset.visible = String(visible);
    document.body.dataset.hiddenCount = String(hiddenCount);
    document.body.dataset.height = String(innerHeight);
    const note = element('visibility');
    if (note) note.textContent = `Visible, ${innerHeight} px tall; hidden ${hiddenCount} time${hiddenCount === 1 ? '' : 's'} without reloading.`;
}

await api.ready;
visibility(api.visible);
const stopContext = api.onContext(value => visibility(value.visible));
addEventListener('resize', () => visibility(lastVisible ?? api.visible));
const stopChrome = api.ui.onChrome(render, failed);
addEventListener('pagehide', () => { disposed = true; stopChrome(); stopContext(); });
