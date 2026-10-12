/**
 * Row models and data sources.
 *
 * A row model turns a data source plus query state into the displayed projection. The grid reads rows only
 * through the model, never from the DOM, so every lookup works for offscreen and unloaded rows.
 */
import type { ColumnState } from './columns';
import type { DisplayedRow, GetDataPath, GetRowId, GridRow, RowId } from './rows';
import type { ExternalFilters, FilterModel, QueryState, SortModel } from './state';

/** Local rows held in memory. Sorting, filtering, grouping and quick filter run in the browser. */
export type LocalDataSource<TData> = {
    type: 'local';
    rows: readonly TData[];
    getRowId?: GetRowId<TData>;
    /** Turns rows into a tree. Used by client participation. */
    getDataPath?: GetDataPath<TData>;
    /** Runs after sorting. Must return the same rows, reordered. Used for pinned-first and custom orders. */
    sortRows?: (rows: readonly TData[]) => readonly TData[];
    /** Text matched against every visible column's formatted value. */
    quickFilter?: string;
    /** Row ids that start expanded, or a predicate over tree/group level. */
    expandedByDefault?: boolean | number | ((row: GridRow<TData>) => boolean);
};

/**
 * One block request. This maps field for field onto today's GET query string:
 * `startRow`, `endRow`, JSON `sortModel`, `filterModel`, `groupKeys`, `rowGroupCols`, `q` and `filter[key]`.
 */
export type ServerRowsRequest = {
    startRow: number;
    endRow: number;
    sortModel: SortModel;
    filterModel: FilterModel;
    /** Key path of the group whose children are requested. Empty for root rows. */
    groupKeys: (string | null)[];
    /** Active group columns in the backend's `{ id, field, displayName }` shape. */
    rowGroupCols: { id: string; field: string; displayName: string }[];
    q: string;
    externalFilters: ExternalFilters;
    /** Aborted when the request becomes obsolete (query changed, block evicted, grid destroyed). */
    signal: AbortSignal;
};

export type ServerRowsResponse<TData> = {
    /** Rows in the backend's shape. Group rows carry `_group`, `_groupKey`, `_groupField`, `_childCount`. */
    rows: TData[];
    /** Total rows for this group level (`metadata.found`). Null when the backend does not know. */
    rowCount: number | null;
};

export type ServerDataSource<TData> = {
    type: 'server';
    getRows: (request: ServerRowsRequest) => Promise<ServerRowsResponse<TData>>;
    getRowId?: GetRowId<TData>;
    /** Rows per block. The backend and current app use 100. Must not exceed the backend maximum of 1000. */
    blockSize?: number;
    /** Blocks kept per group level before the least recently used is evicted. */
    maxBlocksInCache?: number;
    /**
     * Loading rows shown past the loaded rows while a level's count is unknown. Default: one block, so a
     * fast scroll has rows to land on; 1 shows a single loading row.
     */
    unknownCountRows?: number;
    /**
     * When false, the model shows the empty state without requesting until the query has search text,
     * a filter, a group key or an external filter (today's "no filters" state).
     */
    loadWithoutQuery?: boolean;
    /**
     * Server tree data (activities): returns the child route key for rows that have children, or null for
     * leaves. Rows with a key are expandable; expanding requests `groupKeys: [...parentKeys, key]`.
     */
    getTreeKey?: (data: TData) => string | null;
    /** Server groups that start open. */
    isGroupOpenByDefault?: (group: { groupColId: string; key: string | null; level: number }) => boolean;
};

export type DataSource<TData> = LocalDataSource<TData> | ServerDataSource<TData>;

/**
 * Overall load status of the displayed projection. `empty` distinguishes the two current overlays:
 * `noQuery` (nothing requested yet) and `noResults` (the query returned nothing).
 */
export type RowModelStatus =
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'ready' }
    | { state: 'empty'; reason: 'noQuery' | 'noResults' }
    | { state: 'error'; error: unknown };

/** A change set for local rows. Ids come from `getRowId`. */
export type RowTransaction<TData> = {
    add?: { rows: TData[]; index?: number };
    update?: TData[];
    remove?: RowId[];
};

/**
 * The read side of a row model. Every method answers from model state only; none of them touches the DOM.
 *
 * Semantics for rows that are not mounted or not loaded:
 * - Displayed indexes cover the whole known row count. An index inside the count whose block has not
 *   loaded returns a `LoadingRow` (or `FailedRow`), not undefined.
 * - `getRow(id)` returns undefined for ids that are not currently loaded, even if the id was seen before.
 * - Iteration only visits loaded rows. Remote models never fetch as a side effect of iteration.
 */
export type RowModel<TData> = {
    readonly version: number;
    readonly status: RowModelStatus;
    /** Known displayed row count in the body. Null while a remote count is unknown. */
    getRowCount(): number | null;
    getRowAtIndex(index: number): DisplayedRow<TData> | undefined;
    getRow(id: RowId): GridRow<TData> | undefined;
    /** Displayed index of a row, or undefined when it is not displayed (collapsed parent, filtered, unloaded). */
    getIndexOf(id: RowId): number | undefined;
    /**
     * Every loaded row in display order. `includeCollapsed` adds rows below collapsed groups;
     * `includeFiltered` adds local rows the filter hides.
     * Rows that are not displayed get index undefined.
     */
    forEachRow(
        callback: (row: GridRow<TData>, index: number | undefined) => void,
        options?: { includeCollapsed?: boolean; includeFiltered?: boolean }
    ): void;
    getPinnedRows(section: 'top' | 'bottom'): readonly GridRow<TData>[];
};

/** Write side, owned by the grid. Consumers reach it through `GridApi`. */
export type RowModelControl<TData> = {
    setQuery(query: QueryState): void;
    setColumnState(columnState: ColumnState[]): void;
    setExpanded(id: RowId, expanded: boolean): void;
    /** Local only. Throws for server models. */
    applyTransaction(transaction: RowTransaction<TData>): void;
    /** Replaces loaded data for rows by id without reloading. Used for optimistic edits and reconciliation. */
    patchRows(updates: { id: RowId; data: TData }[]): void;
    /**
     * Server only. Drops cached blocks and refetches visible ones. With `route`, only that group level.
     * `purge: false` keeps current rows visible until the new blocks arrive.
     */
    refresh(options?: { route?: (string | null)[]; purge?: boolean }): void;
    /** Server only. Asks for the blocks covering this index range. Called by the viewport, not by consumers. */
    ensureRange(firstIndex: number, lastIndex: number): void;
    setPinnedRows(section: 'top' | 'bottom', rows: readonly TData[]): void;
};
