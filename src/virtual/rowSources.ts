/**
 * Adapters from the row projections to the layout's `RowSource`.
 */
import type { LocalProjection } from '../rows/localProjection';
import type { ServerProjection } from '../rows/serverProjection';
import type { RowSource } from './verticalLayout';

export function localRowSource<TData>(projection: LocalProjection<TData>): RowSource<TData> {
    return {
        count: projection.getRowCount(),
        rowAt: (index) => projection.getRowAtIndex(index)?.row,
        indexOf: (id) => projection.getIndexOf(id),
        forEachKnown: (callback) => projection.forEachRow((row, index) => callback(row, index!)),
    };
}

/** Only loaded rows are visited for per-row heights; placeholders use the estimate. */
export function serverRowSource<TData>(projection: ServerProjection<TData>): RowSource<TData> {
    return {
        count: projection.getDisplayCount(),
        rowAt: (index) => projection.getRowAtIndex(index)?.row,
        indexOf: (id) => projection.getIndexOf(id),
        forEachKnown: (callback) => projection.forEachLoaded(callback),
    };
}
