/**
 * #313: applied at import time, and imported FIRST by `main.ts`, so no other module (the harness
 * gate, the daemon discovery, the config readers) ever sees a variable a packaged app must not
 * take from the shell that launched it. `./shell-env.ts` has the policy and the reasons.
 */

import { app } from 'electron';

import { applyShellEnvPolicy, type ShellEnvReport } from './shell-env.js';

export const shellEnvReport: ShellEnvReport = applyShellEnvPolicy(process.env, app.isPackaged);
