/**
 * Cell ranges: resolving a logical range against a snapshot, border edges for rendering,
 * keyboard extension and aggregation of the selected values.
 *
 * Ranges are addressed by row id and colId. A resolved range is only valid for the snapshot it was
 * resolved against.
 */
import type { CellPosition, CellRange, DataRow, GridRow, ResolvedCellRange, RowId } from '../contract';
import { isPlaceholder } from '../contract';
import type { NavigationKey } from './navigation';
import type { GridSnapshot } from './snapshot';

/** Border flags for one cell, rendered as data attributes. `count` is how many ranges contain the cell. */
export type CellRangeEdges = {
    inRange: boolean;
    top: boolean;
    bottom: boolean;
    left: boolean;
    right: boolean;
    count: number;
};

/** Sum, average, minimum and maximum over numeric values. All null when there are no numeric values. */
export type AggregateValues = {
    sum: number | null;
    avg: number | null;
    min: number | null;
    max: number | null;
    numericCount: number;
};

/** Aggregates for the numeric values that share one group key (a currency code, or null for plain numbers). */
export type AggregateGroup = AggregateValues & {
    key: string | null;
};

/**
 * Aggregation over the cells of one or more ranges.
 *
 * The app never adds amounts in different currencies together: it groups the values by the row's
 * currency code and shows one line per currency (`parseRanges.ts`, `SelectionAggregationTooltip`). The
 * same applies here. `groups` holds one entry per key in first seen order. When the values fall into more
 * than one group, `mixed` is true and the top level `sum`, `avg`, `min` and `max` are null, because a
 * single total would add pounds to euros. `count` and `numericCount` always cover every cell.
 */
export type AggregateResult = AggregateValues & {
    /** Distinct data cells in the ranges whose raw value is not null, undefined or an empty string. */
    count: number;
    groups: AggregateGroup[];
    mixed: boolean;
};

/** Options for `aggregate`. */
export type AggregateOptions<TData> = {
    /**
     * The group key of a numeric cell, usually its currency code. Defaults to the currency carried by a
     * money object (`currency` as a string or `{ code }`, or `currencyCode`), and null for plain numbers.
     * A column that keeps the currency on the row instead passes, for example,
     * `(row) => row.data.currency?.code ?? null`.
     */
    groupKeyOf?(row: DataRow<TData>, colId: string, value: unknown): string | null;
};

/** Options for `extendRange`. */
export type ExtendRangeOptions = {
    /** Rows moved by `pageUp` and `pageDown`. Without it those keys leave the range unchanged. */
    pageSize?: number;
};

/** Builds a range from two cells. The anchor stays fixed while the end moves. */
export function rangeFromCells(anchor: CellPosition, end: CellPosition): CellRange {
    return { anchor: { ...anchor }, end: { ...end } };
}

/**
 * Resolves a range against the displayed rows and columns. The rectangle spans every displayed row and
 * column between the two corners in display order, whichever direction it was dragged, and across pinned
 * sections (the snapshot lists columns in visual order). Placeholder rows are listed in `unloadedIndexes`
 * and left out of `rowIds`.
 *
 * Returns null when the anchor row or column is no longer displayed. When only the end is gone, the range
 * collapses to the anchor cell.
 */
export function resolveRange<TData>(range: CellRange, snapshot: GridSnapshot<TData>): ResolvedCellRange | null {
    const anchorRow = snapshot.indexOf(range.anchor.rowId);
    const anchorColumn = snapshot.columnIndexOf(range.anchor.colId);

    if (anchorRow === undefined || anchorColumn === undefined) {
        return null;
    }

    const endRow = snapshot.indexOf(range.end.rowId) ?? anchorRow;
    const endColumn = snapshot.columnIndexOf(range.end.colId) ?? anchorColumn;

    const startIndex = Math.min(anchorRow, endRow);
    const endIndex = Math.max(anchorRow, endRow);
    const firstColumn = Math.min(anchorColumn, endColumn);
    const lastColumn = Math.max(anchorColumn, endColumn);

    const rowIds: RowId[] = [];
    const unloadedIndexes: number[] = [];

    for (let index = startIndex; index <= endIndex; index++) {
        const row = snapshot.rowAt(index);

        if (row === undefined || isPlaceholder(row)) {
            unloadedIndexes.push(index);
        } else {
            rowIds.push(row.id);
        }
    }

    const colIds = snapshot.columns.slice(firstColumn, lastColumn + 1).map((column) => column.colId);

    return { rowIds, colIds, startIndex, endIndex, unloadedIndexes };
}

type Rectangle = { top: number; bottom: number; left: number; right: number };

function rectangleOf<TData>(range: ResolvedCellRange, snapshot: GridSnapshot<TData>): Rectangle | null {
    const firstColId = range.colIds[0];
    const lastColId = range.colIds[range.colIds.length - 1];

    if (firstColId === undefined || lastColId === undefined) {
        return null;
    }

    const left = snapshot.columnIndexOf(firstColId);
    const right = snapshot.columnIndexOf(lastColId);

    if (left === undefined || right === undefined) {
        return null;
    }

    return { top: range.startIndex, bottom: range.endIndex, left: Math.min(left, right), right: Math.max(left, right) };
}

/**
 * Border flags for one cell. A cell is in range when it lies inside any resolved rectangle (placeholder
 * rows included, so the outline stays closed). Each flag is set when the cell sits on that edge of at
 * least one range containing it, so overlapping ranges each keep their own outline.
 */
export function cellRangeEdges<TData>(
    ranges: readonly ResolvedCellRange[],
    rowId: RowId,
    colId: string,
    snapshot: GridSnapshot<TData>
): CellRangeEdges {
    const edges: CellRangeEdges = { inRange: false, top: false, bottom: false, left: false, right: false, count: 0 };
    const rowIndex = snapshot.indexOf(rowId);
    const columnIndex = snapshot.columnIndexOf(colId);

    if (rowIndex === undefined || columnIndex === undefined) {
        return edges;
    }

    for (const range of ranges) {
        const rectangle = rectangleOf(range, snapshot);

        if (
            rectangle === null ||
            rowIndex < rectangle.top ||
            rowIndex > rectangle.bottom ||
            columnIndex < rectangle.left ||
            columnIndex > rectangle.right
        ) {
            continue;
        }

        edges.inRange = true;
        edges.count++;
        edges.top ||= rowIndex === rectangle.top;
        edges.bottom ||= rowIndex === rectangle.bottom;
        edges.left ||= columnIndex === rectangle.left;
        edges.right ||= columnIndex === rectangle.right;
    }

    return edges;
}

function focusableColumnIndexes<TData>(snapshot: GridSnapshot<TData>): number[] {
    const indexes: number[] = [];

    snapshot.columns.forEach((column, index) => {
        if (column.focusable) {
            indexes.push(index);
        }
    });

    return indexes;
}

function stepColumn(focusable: readonly number[], from: number, direction: 1 | -1): number {
    if (direction === 1) {
        return focusable.find((index) => index > from) ?? from;
    }

    for (let position = focusable.length - 1; position >= 0; position--) {
        const index = focusable[position];

        if (index !== undefined && index < from) {
            return index;
        }
    }

    return from;
}

/**
 * Moves the end of a range for Shift plus a navigation key, keeping the anchor. Arrows move one row or
 * one focusable column, row start and row end go to the first or last focusable column, grid start and
 * grid end go to the first or last row and column. Movement is clamped at the grid's edges. `next` and
 * `previous` (Tab) do not extend a range and return it unchanged, as does any key when the anchor is gone.
 */
export function extendRange<TData>(
    range: CellRange,
    snapshot: GridSnapshot<TData>,
    key: NavigationKey,
    options: ExtendRangeOptions = {}
): CellRange {
    const anchorRow = snapshot.indexOf(range.anchor.rowId);
    const anchorColumn = snapshot.columnIndexOf(range.anchor.colId);

    if (anchorRow === undefined || anchorColumn === undefined || snapshot.rowCount === 0) {
        return range;
    }

    let row = snapshot.indexOf(range.end.rowId) ?? anchorRow;
    let column = snapshot.columnIndexOf(range.end.colId) ?? anchorColumn;

    const focusable = focusableColumnIndexes(snapshot);
    const firstColumn = focusable[0] ?? column;
    const lastColumn = focusable[focusable.length - 1] ?? column;
    const lastRow = snapshot.rowCount - 1;

    switch (key) {
        case 'up':
            row = Math.max(0, row - 1);
            break;
        case 'down':
            row = Math.min(lastRow, row + 1);
            break;
        case 'left':
            column = stepColumn(focusable, column, -1);
            break;
        case 'right':
            column = stepColumn(focusable, column, 1);
            break;
        case 'rowStart':
            column = firstColumn;
            break;
        case 'rowEnd':
            column = lastColumn;
            break;
        case 'columnTop':
            row = 0;
            break;
        case 'columnBottom':
            row = lastRow;
            break;
        case 'gridStart':
            row = 0;
            column = firstColumn;
            break;
        case 'gridEnd':
            row = lastRow;
            column = lastColumn;
            break;
        case 'pageUp':
        case 'pageDown':
            if (options.pageSize === undefined || options.pageSize <= 0) {
                return range;
            }
            row = key === 'pageUp' ? Math.max(0, row - options.pageSize) : Math.min(lastRow, row + options.pageSize);
            break;
        case 'next':
        case 'previous':
            return range;
    }

    const endRow = snapshot.rowAt(row);
    const endColumn = snapshot.columns[column];

    if (endRow === undefined || endColumn === undefined) {
        return range;
    }

    return { anchor: range.anchor, end: { rowId: endRow.id, colId: endColumn.colId } };
}

/**
 * The numeric value of a raw cell value, or null. Finite numbers, strings that parse to a finite number
 * after trimming, and money objects whose `amount` is one of those count. The app passes any non-null
 * value to `Number()`; text that is not a number is left out here instead of turning the total into NaN.
 */
export function numericValue(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();

        if (trimmed === '') {
            return null;
        }

        const parsed = Number(trimmed);

        return Number.isFinite(parsed) ? parsed : null;
    }

    if (isMoney(value)) {
        const amount = value.amount;

        return typeof amount === 'number' || typeof amount === 'string' ? numericValue(amount) : null;
    }

    return null;
}

type MoneyLike = { amount: unknown; currency?: unknown; currencyCode?: unknown };

function isMoney(value: unknown): value is MoneyLike {
    return typeof value === 'object' && value !== null && 'amount' in value;
}

function defaultGroupKey(value: unknown): string | null {
    if (!isMoney(value)) {
        return null;
    }

    const currency = value.currency;

    if (typeof currency === 'string') {
        return currency;
    }

    if (typeof currency === 'object' && currency !== null && 'code' in currency && typeof currency.code === 'string') {
        return currency.code;
    }

    return typeof value.currencyCode === 'string' ? value.currencyCode : null;
}

function summarize(values: readonly number[]): AggregateValues {
    if (values.length === 0) {
        return { sum: null, avg: null, min: null, max: null, numericCount: 0 };
    }

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    for (const value of values) {
        sum += value;
        min = Math.min(min, value);
        max = Math.max(max, value);
    }

    return { sum, avg: sum / values.length, min, max, numericCount: values.length };
}

function isAggregatableRow<TData>(
    row: GridRow<TData> | undefined,
    snapshot: GridSnapshot<TData>
): row is DataRow<TData> {
    return row !== undefined && row.kind === 'data' && !snapshot.isFullWidth(row);
}

function isBlank(value: unknown): boolean {
    return value === null || value === undefined || value === '';
}

/**
 * Aggregates the raw values of the data cells in the ranges. Each cell counts once, however many ranges
 * contain it. Group, full width and placeholder rows are skipped. Numeric values are grouped by
 * `options.groupKeyOf` (currency by default); see `AggregateResult` for how mixed groups are reported.
 *
 * The app only shows the aggregation tooltip when every range covers the same single column and at least
 * two values are numeric. That gating belongs to the caller, which can read it from the ranges and
 * `numericCount`.
 */
export function aggregate<TData>(
    ranges: readonly ResolvedCellRange[],
    snapshot: GridSnapshot<TData>,
    options: AggregateOptions<TData> = {}
): AggregateResult {
    const seen = new Set<string>();
    const groupValues = new Map<string | null, number[]>();
    const allValues: number[] = [];
    let count = 0;

    for (const range of ranges) {
        for (const rowId of range.rowIds) {
            const index = snapshot.indexOf(rowId);
            const row = index === undefined ? undefined : snapshot.rowAt(index);

            if (!isAggregatableRow(row, snapshot)) {
                continue;
            }

            for (const colId of range.colIds) {
                const cellKey = JSON.stringify([rowId, colId]);

                if (seen.has(cellKey)) {
                    continue;
                }

                seen.add(cellKey);

                const columnIndex = snapshot.columnIndexOf(colId);
                const column = columnIndex === undefined ? undefined : snapshot.columns[columnIndex];

                if (column === undefined) {
                    continue;
                }

                const value = column.getValue(row);

                if (isBlank(value)) {
                    continue;
                }

                count++;

                const number = numericValue(value);

                if (number === null) {
                    continue;
                }

                const key = options.groupKeyOf ? options.groupKeyOf(row, colId, value) : defaultGroupKey(value);
                const bucket = groupValues.get(key);

                if (bucket === undefined) {
                    groupValues.set(key, [number]);
                } else {
                    bucket.push(number);
                }

                allValues.push(number);
            }
        }
    }

    const groups: AggregateGroup[] = [...groupValues.entries()].map(([key, values]) => ({ key, ...summarize(values) }));
    const mixed = groups.length > 1;
    const totals = summarize(allValues);

    return {
        ...(mixed ? { sum: null, avg: null, min: null, max: null } : totals),
        numericCount: totals.numericCount,
        count,
        groups,
        mixed,
    };
}
