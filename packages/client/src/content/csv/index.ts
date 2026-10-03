/**
 * #324 - the csv document pane, client half (docs/csv-pane.md).
 *
 *   `csv-client.ts`   the per-connection multiplexer over the csv WS verbs (refcount, reconnect)
 *   `csv-model.ts`    one pane's row window cache, fetch pump, edit queue and optimistic cells
 *   `scroll-map.ts`   the capped-spacer scroll mapping for files taller than a browser lays out
 *   `CsvGrid.tsx`     the virtualised, editable grid (desktop keys, phone touch, find)
 *   `CsvPane.tsx`     grid or raw text, by the pane record's `isEditing`
 */

export {
    CSV_EDIT_TIMEOUT_MS,
    CSV_SLOW_COMMAND_TIMEOUT_MS,
    createCsvClient,
    isNewerCsvState,
    type CsvApi,
    type CsvClient,
    type CsvClientOptions,
    type CsvListener,
    type CsvSubscription
} from './csv-client';
export {
    CSV_COLUMN_BLOCK,
    CSV_MAX_IN_FLIGHT,
    CSV_ROW_BLOCK,
    createCsvPaneModel,
    csvCacheKey,
    csvPaneHasModel,
    flushCsvPane,
    type CsvCellView,
    type CsvPaneModel,
    type CsvViewport
} from './csv-model';
export { CsvGrid, type CsvGridProps } from './CsvGrid';
export { CsvPane, useCsvPaneModel, type CsvPaneProps } from './CsvPane';
export { csvChromeFacts, publishCsvChromeFacts, useCsvChromeFacts, type CsvChromeFacts } from './chrome-facts';
export { csvRawUnavailableReason } from './state-text';
export { parseCsvState } from './types';
