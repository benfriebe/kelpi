import { pluginRecord, type JsonObject, type JsonValue } from '@kelpi/protocol';
import type { BuiltinPluginService } from '../plugins/builtin-services.js';
import { renderDiffDocument } from './diff.js';
import { renderMarkdownDocument } from './markdown.js';

export const CONTENT_RENDER_SERVICE = 'kelpi.content.render';
export const CONTENT_RENDER_VERSION = 1;

export interface ContentRenderArgs {
    readonly kind: 'markdown' | 'diff';
    readonly source: string;
    readonly backgroundColor: string;
    readonly fontSize: number;
    readonly assetBase: string | null;
}

export function parseContentRenderArgs(args: JsonObject): ContentRenderArgs {
    if (args['kind'] !== 'markdown' && args['kind'] !== 'diff') throw new Error('render kind must be markdown or diff');
    if (typeof args['source'] !== 'string') throw new Error('render source must be a string');
    if (typeof args['backgroundColor'] !== 'string') throw new Error('render backgroundColor must be a string');
    if (typeof args['fontSize'] !== 'number' || !Number.isFinite(args['fontSize']) || args['fontSize'] < 8 || args['fontSize'] > 32) throw new Error('render fontSize must be between 8 and 32');
    if (args['assetBase'] !== null && typeof args['assetBase'] !== 'string') throw new Error('render assetBase must be a string or null');
    return { kind: args['kind'], source: args['source'], backgroundColor: args['backgroundColor'], fontSize: args['fontSize'], assetBase: args['assetBase'] };
}

export function contentRenderHTML(result: JsonValue): string {
    if (!pluginRecord(result) || typeof result['html'] !== 'string') throw new Error('content renderer must return {html: string}');
    return result['html'];
}

/** Pure, synchronous native implementation; direct native calls have no plugin envelope limit. */
export function renderContentDocument(args: ContentRenderArgs): string {
    const options = { backgroundColor: args.backgroundColor, baseFontSize: args.fontSize };
    return args.kind === 'markdown'
        ? renderMarkdownDocument(args.source, { ...options, ...(args.assetBase === null ? {} : { baseHref: args.assetBase }) })
        : renderDiffDocument(args.source, options);
}

export function createContentRenderService(): BuiltinPluginService {
    return {
        id: CONTENT_RENDER_SERVICE,
        title: 'Content rendering',
        version: CONTENT_RENDER_VERSION,
        methods: {
            render: {
                validateArgs: args => { parseContentRenderArgs(args); },
                validateResult: result => { contentRenderHTML(result); },
                run: (args, _context, signal) => {
                    if (signal?.aborted) throw new Error('content rendering cancelled');
                    return { html: renderContentDocument(parseContentRenderArgs(args)) };
                }
            }
        }
    };
}
