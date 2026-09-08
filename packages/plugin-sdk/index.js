export { createKelpiAPI, KelpiError } from './api.js';

/** In a view, Kelpi injects the API before any package script runs. */
export function getKelpi() {
    if (!globalThis.kelpi) throw new Error('This UI must run inside a Kelpi plugin view');
    return globalThis.kelpi;
}
