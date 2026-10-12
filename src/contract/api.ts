import type {
    ApplyColumnStateOptions,
    ColumnDefinition,
    ColumnGroupState,
    ColumnState,
    DisplayedColumn,
    ResolvedColumn,
} from './columns';
import type { DataSource, RowModel, RowModelStatus, RowTransaction } from './data-source';
import type { GridEventListener, GridEventName } from './events';
/**
 * The owned grid api handed to consumers (ref, `ready` event, renderer props).
 *
 * Every read answers from grid state, so results do not depend on which rows or columns are mounted.
 * Calls after `destroyed` are no-ops that return empty values; `isDestroyed()` tells them apart.
 */
import type { AnchorRect } from './geometry';
import type { GeometryApi } from './geometry';
import type { GridRow, RowId } from './rows';
import type {
    CellPosition,
    CellRange,
    ExternalFilters,
    FilterCondition,
    FilterModel,
    GridState,
    ResolvedCellRange,
    RowSelection,
    SortModel,
} from './state';

export type GridApi<TData> = {
    readonly rows: RowModel<TData>;
    readonly geometry: GeometryApi;

    isDestroyed(): boolean;
    getState(): GridState;
    /** Applies part of the state at once; one event per changed area, in the order defined in events.ts. */
    setState(state: Partial<GridState>): void;

    // Data
    applyTransaction(transaction: RowTransaction<TData>): void;
    patchRows(updates: { id: RowId; data: TData }[]): void;
    /** Server models refetch (see `RowModelControl.refresh`). Local models re-run sort, filter and grouping. */
    refresh(options?: { route?: (string | null)[]; purge?: boolean }): void;
    setPinnedRows(section: 'top' | 'bottom', rows: readonly TData[]): void;
    getStatus(): RowModelStatus;
    /** The data source the grid was given, for code that branches on local or server. */
    getDataSource(): DataSource<TData>;
    /**
     * Writes one cell through the column's setter and fires `cellValueChanged` with source 'api'. Returns
     * false when the row is not loaded, the column has no setter, or the value did not change.
     */
    setCellValue(cell: CellPosition, value: unknown): boolean;
    /**
     * Writes cells as one batch for bulk actions: applied locally at once, then persisted through
     * `persist` (source 'api'), with rollback and errors for rejected cells. Cells that are not editable,
     * that `canWrite` refuses, or whose value is unchanged are skipped, as for paste.
     */
    writeCells(cells: { cell: CellPosition; value: unknown }[]): Promise<{ written: number; rejected: number }>;
    /**
     * Re-renders cells after data changed in place, without re-sorting or re-filtering. With
     * `rowIds`, only those rows; with no arguments, every mounted row. `colIds` and `force` are accepted
     * for compatibility; rows re-render whole.
     */
    refreshCells(options?: { rowIds?: RowId[]; colIds?: string[]; force?: boolean }): void;
    setExpanded(rowId: RowId, expanded: boolean): void;

    // Columns
    setColumnDefinitions(definitions: ColumnDefinition<TData>[]): void;
    getColumn(colId: string): ResolvedColumn<TData> | undefined;
    /** All leaf columns, hidden included, in definition order. */
    getColumns(): ResolvedColumn<TData>[];
    getDisplayedColumns(): DisplayedColumn<TData>[];
    getColumnState(): ColumnState[];
    applyColumnState(state: ColumnState[], options?: ApplyColumnStateOptions): void;
    resetColumnState(): void;
    getColumnGroupState(): ColumnGroupState[];
    setColumnGroupState(state: ColumnGroupState[]): void;
    resetColumnGroupState(): void;
    setColumnsVisible(colIds: string[], visible: boolean): void;
    setRowGroupColumns(colIds: string[]): void;
    getRowGroupColumns(): ResolvedColumn<TData>[];

    // Query
    /** Current local data in source order, including edits and transactions. Null for server data. */
    getSourceRows(): readonly TData[] | null;
    getSortModel(): SortModel;
    setSortModel(sortModel: SortModel): void;
    getFilterModel(): FilterModel;
    setFilterModel(filterModel: FilterModel): void;
    setColumnFilter(colId: string, condition: FilterCondition | null): void;
    getSearch(): string;
    setSearch(search: string): void;
    setExternalFilters(filters: ExternalFilters): void;
    /** Local models only. */
    setQuickFilter(text: string): void;

    // Row selection and active row
    getSelection(): RowSelection;
    /**
     * Loaded selected rows, including local rows hidden by filters when selected by id.
     * With `mode: 'all'`, only loaded rows matching the current query are returned.
     */
    getSelectedRows(): GridRow<TData>[];
    isSelected(rowId: RowId): boolean;
    /**
     * Accepts ids of rows that are not loaded: they are stored in the selection and reported by
     * `getSelection()`, and appear in `getSelectedRows()` once loaded. Unselectable rows are ignored.
     */
    setSelected(rowIds: RowId[], selected: boolean, options?: { clearOthers?: boolean }): void;
    selectAll(): void;
    deselectAll(): void;
    getActiveRowId(): RowId | null;
    setActiveRowId(rowId: RowId | null): void;

    // Focus, ranges, editing
    getFocusedCell(): CellPosition | null;
    setFocusedCell(cell: CellPosition | null, options?: { scroll?: boolean }): void;
    /**
     * Moves focus like Tab / Shift+Tab or the arrow keys. While an edit is active, the edit is committed
     * first (as with Tab); if the commit is rejected, focus stays and null is returned. Returns null at the edge.
     */
    moveFocus(direction: 'next' | 'previous' | 'up' | 'down' | 'left' | 'right'): CellPosition | null;
    getRanges(): CellRange[];
    getResolvedRanges(): ResolvedCellRange[];
    setRanges(ranges: CellRange[]): void;
    clearRanges(): void;
    getCellValue(cell: CellPosition, options?: { formatted?: boolean }): unknown;
    /**
     * Scrolls the cell into view, mounts it and starts the editor. Does nothing for rows that are not
     * loaded, placeholder rows or non-editable cells. The editing row stays mounted until the edit ends.
     */
    startEditing(cell: CellPosition, options?: { startKey?: string }): void;
    /** Ends the active edit through the same path as a user action. */
    stopEditing(commit: boolean): void;
    getEditingCell(): CellPosition | null;

    // Pagination (server resource grids page at 100 rows today)
    getPagination(): {
        page: number;
        pageSize: number;
        pageCount: number | null;
        rowCount: number | null;
    } | null;
    setPage(page: number): void;

    // Layout
    /** Resolves after pending measurement, scroll anchoring and rendering have finished. */
    whenSettled(): Promise<void>;
    /**
     * Sizes columns to their content: the header label and the cells currently mounted (as
     * measures). With no ids, every displayed column. Locked widths (`resizable: false`) are left alone.
     */
    autoSizeColumns(colIds?: string[]): void;
    /** Opens the column chooser (visibility per column) at an anchor, or below the header. */
    showColumnChooser(anchor?: AnchorRect): void;

    // Overlays
    /** Forces an overlay regardless of model status, or `null` to follow status again. */
    setOverlay(overlay: 'loading' | 'empty' | null): void;

    // Events
    on<TName extends GridEventName>(name: TName, listener: GridEventListener<TData, TName>): () => void;
    off<TName extends GridEventName>(name: TName, listener: GridEventListener<TData, TName>): void;
};
