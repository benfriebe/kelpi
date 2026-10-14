/**
 * The process generation: what `ping` and `/healthz` report, and what names the run-dir files
 * (`daemon-v<N>.sock` / `.token` / `.pid`). Moving it starts a new daemon beside the old one
 * rather than handing off to it, so a change only clients see moves `WS_PROTOCOL_VERSION` alone.
 */
export const PROTOCOL_VERSION = 2;

export * from './wire/index.js';
export * from './replies/index.js';
export * from './ws/index.js';
export * from './allowlist.js';
export * from './dualfire.js';
export * from './framing.js';
export * from './json.js';
export * from './plugins.js';
export * from './plugin-contributions.js';
export * from './plugin-dependencies.js';
export * from './documents.js';
export * from './csv.js';
export * from './browser.js';
