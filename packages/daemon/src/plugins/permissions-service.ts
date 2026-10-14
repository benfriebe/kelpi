import { pluginRecord } from '@kelpi/protocol';
import type { BuiltinPluginService } from './builtin-services.js';

/** #388: who decides an agent's permission requests (`permission-request`, wire-protocol.md §6.1.1). */
export const PERMISSIONS_SERVICE = 'kelpi.agent.permissions';
export const PERMISSIONS_SERVICE_VERSION = 1;
/** The provider id of the bundled implementation, as the service registry lists it. */
export const BUNDLED_PERMISSIONS_PROVIDER = `${PERMISSIONS_SERVICE}.bundled`;

const BEHAVIORS: ReadonlySet<unknown> = new Set(['allow', 'deny', 'abstain']);

/**
 * The bundled provider never decides: `abstain` leaves Claude's own prompt in place. Only a
 * provider the user explicitly selected replaces it, so installing a plugin never approves anything.
 */
export function createPermissionsService(): BuiltinPluginService {
    return {
        id: PERMISSIONS_SERVICE, title: 'Agent permission decisions', version: PERMISSIONS_SERVICE_VERSION,
        methods: {
            decide: {
                validateArgs(args) {
                    const toolName = args['toolName'];
                    if (typeof toolName !== 'string' || !toolName) throw new Error('missing or invalid toolName');
                    if (!pluginRecord(args['toolInput'])) throw new Error('toolInput must be an object');
                },
                validateResult(result) {
                    if (!pluginRecord(result) || !BEHAVIORS.has(result['behavior'])) throw new Error('expected behavior allow, deny or abstain');
                    if (result['message'] !== undefined && typeof result['message'] !== 'string') throw new Error('permission message must be a string');
                },
                run: () => ({ behavior: 'abstain' })
            }
        }
    };
}
