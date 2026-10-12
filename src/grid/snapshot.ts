/**
 * The read-only view of the displayed grid that the pure interaction modules (navigation, selection,
 * ranges, clipboard) work on. The Grid builds it from its projection and resolved columns; tests build it
 * from plain arrays with `createSnapshot`.
 */
import type { GridRow, RowId } from '../contract';

export type SnapshotColumn<TData> = {
    colId: string;
    focusable: boolean;
    /** Raw value for a data row, undefined for rows without data. */
    getValue(row: GridRow<TData>): unknown;
    /** Formatted display value. */
    formatValue(row: GridRow<TData>): string;
    isEditable(row: GridRow<TData>): boolean;
};

export type GridSnapshot<TData> = {
    rowCount: number;
    rowAt(index: number): GridRow<TData> | undefined;
    indexOf(id: RowId): number | undefined;
    /** Displayed leaf columns in visual order: left pinned, center, right pinned. */
    columns: readonly SnapshotColumn<TData>[];
    columnIndexOf(colId: string): number | undefined;
    /** Rows that render as one full-width cell. */
    isFullWidth(row: GridRow<TData>): boolean;
};

/** Builds a snapshot from plain rows and columns, for tests and simple local grids. */
export function createSnapshot<TData>(
    rows: readonly GridRow<TData>[],
    columns: readonly SnapshotColumn<TData>[],
    isFullWidth: (row: GridRow<TData>) => boolean = (row) => row.kind === 'fullWidth' || row.kind === 'detail'
): GridSnapshot<TData> {
    const rowIndex = new Map(rows.map((row, index) => [row.id, index]));
    const columnIndex = new Map(columns.map((column, index) => [column.colId, index]));

    return {
        rowCount: rows.length,
        rowAt: (index) => rows[index],
        indexOf: (id) => rowIndex.get(id),
        columns,
        columnIndexOf: (colId) => columnIndex.get(colId),
        isFullWidth,
    };
}
