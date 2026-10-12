/**
 * The `GridApi` handed to consumers, implemented over the grid store and geometry. Every read answers
 * from grid state, never from the DOM. Calls after destroy are no-ops returning empty values.
 */
import type {
    AnchorRect,
    CellPosition,
    DataSource,
    DisplayedColumn,
    GeometryApi,
    GridApi,
    GridState,
    QueryState,
    ResolvedColumn,
    RowModel,
} from '../contract';
import { hasData } from '../contract';
import type { GridStore } from '../grid/store';
import { LocalRowModel } from '../models/localRowModel';
import type { LaidOutColumn } from '../virtual/horizontalLayout';

export type GridApiDeps<TData> = {
    store: GridStore<TData>;
    geometry: GeometryApi;
    dataSource: () => DataSource<TData>;
    /** Resolves after measurement, anchoring and rendering have settled. */
    whenSettled: () => Promise<void>;
    setQuickFilter: (text: string) => void;
    /** Width and placement of a displayed column, from the column layout. */
    getLaidOutColumn: (colId: string) => LaidOutColumn | undefined;
    /** DOM measurement for autosizing; absent without a rendered grid. */
    autoSizeColumns?: (colIds?: string[]) => void;
    showColumnChooser?: (anchor?: AnchorRect) => void;
};

export function createGridApi<TData>(deps: GridApiDeps<TData>): GridApi<TData> {
    const { store, geometry } = deps;
    let destroyed = false;
    store.events.on('destroyed', () => {
        destroyed = true;
    });

    const query = (): QueryState => store.query;
    const resolvedColumns = (colIds: readonly string[]): ResolvedColumn<TData>[] =>
        colIds
            .map((colId) => store.columns.getResolved(colId))
            .filter((column): column is ResolvedColumn<TData> => column !== undefined);
    // Delegates to the store's current row model, so it stays right when the model changes.
    const rows: RowModel<TData> = {
        get version() {
            return store.rowsVersion;
        },
        get status() {
            return store.rowModel.status;
        },
        getPinnedRows: (section) => store.rowModel.getPinnedRows(section),
        getRowCount: () => store.rowModel.getRowCount(),
        getRowAtIndex: (index) => store.rowModel.getRowAtIndex(index),
        getRow: (id) => store.rowModel.getRow(id),
        getIndexOf: (id) => store.rowModel.getIndexOf(id),
        forEachRow: (callback, options) => store.rowModel.forEachRow(callback, options),
    };

    const api: GridApi<TData> = {
        rows,
        geometry,
        isDestroyed: () => destroyed,
        getSourceRows: () => (destroyed ? [] : store.rowModel instanceof LocalRowModel ? store.rowModel.rows : null),
        getState: (): GridState => ({
            columnState: store.columns.getColumnState(),
            columnGroupState: store.columns.getColumnGroupState(),
            query: query(),
            expandedRowIds: store.rowModel.expandedIds,
            selection: store.selection,
            activeRowId: store.activeRowId,
            focusedCell: store.focusedCell,
            ranges: [...store.ranges],
        }),
        setState: (state) => {
            if (destroyed) {
                return;
            }
            if (state.columnState) {
                store.applyColumnState(state.columnState, { applyOrder: true }, 'api');
            }
            if (state.columnGroupState) {
                store.setColumnGroupState(state.columnGroupState, 'api');
            }
            if (state.query) {
                store.setSortModel(state.query.sortModel, 'api');
                store.setFilterModel(state.query.filterModel, 'api');
                store.setSearch(state.query.search, 'api');
                store.setExternalFilters(state.query.externalFilters, 'api');
            }
            if (state.selection) {
                store.setSelection(state.selection, 'api');
            }
            if (state.activeRowId !== undefined) {
                store.setActiveRow(state.activeRowId, 'api');
            }
            if (state.focusedCell !== undefined) {
                store.focusCell(state.focusedCell, 'api');
            }
            if (state.ranges) {
                store.setRanges(state.ranges, 'api');
            }
            if (state.expandedRowIds) {
                // Works for local and server rows: close what should be closed, open what should be open.
                const wanted = state.expandedRowIds;
                for (const rowId of [...store.rowModel.expandedIds]) {
                    if (!wanted.has(rowId)) {
                        store.setExpanded(rowId, false);
                    }
                }
                for (const rowId of wanted) {
                    if (!store.rowModel.isExpanded(rowId)) {
                        store.setExpanded(rowId, true);
                    }
                }
            }
        },

        applyTransaction: (transaction) => store.applyTransaction(transaction),
        patchRows: (updates) => store.patchRows(updates),
        refresh: (options) => store.refresh(options ?? {}),
        setPinnedRows: (section, rows) => store.setPinnedRows(section, rows),
        getStatus: () => store.rowModel.status,
        getDataSource: () => deps.dataSource(),
        setCellValue: (cell, value) => {
            const row = store.getRow(cell.rowId);
            const column = store.columns.getResolved(cell.colId);
            if (destroyed || !row || row.kind !== 'data' || !hasData(row) || !column?.setValue) {
                return false;
            }
            const oldValue = column.getValue(row);
            if (Object.is(oldValue, value) || !column.setValue(row, value)) {
                return false;
            }
            store.events.emit('cellValueChanged', {
                cell,
                row,
                oldValue,
                newValue: column.getValue(row),
                source: 'api',
            });
            store.setOptions({ ...store.options });

            return true;
        },
        refreshCells: (options) => store.refreshCells(options?.rowIds),
        autoSizeColumns: (colIds) => deps.autoSizeColumns?.(colIds),
        showColumnChooser: (anchor) => deps.showColumnChooser?.(anchor),
        writeCells: (cells) => (destroyed ? Promise.resolve({ written: 0, rejected: 0 }) : store.writeCells(cells)),
        setExpanded: (rowId, expanded) => store.setExpanded(rowId, expanded),

        setColumnDefinitions: (definitions) => store.setOptions({ ...store.options, columns: definitions }),
        getColumn: (colId) => store.columns.getResolved(colId),
        getColumns: () =>
            resolvedColumns(
                store.columns
                    .getAllLeaves()
                    .sort((a, b) => a.definitionIndex - b.definitionIndex)
                    .map((leaf) => leaf.colId)
            ),
        getDisplayedColumns: () =>
            store.columns.getDisplayedLeaves().map((leaf, index): DisplayedColumn<TData> => {
                const laidOut = deps.getLaidOutColumn(leaf.colId);

                return {
                    column: store.columns.getResolved(leaf.colId)!,
                    section: laidOut?.section ?? 'center',
                    index,
                    width: laidOut?.width ?? 0,
                    left: laidOut?.left ?? 0,
                };
            }),
        getColumnState: () => store.columns.getColumnState(),
        applyColumnState: (state, options) => store.applyColumnState(state, options ?? {}, 'api'),
        resetColumnState: () => store.resetColumnState('api'),
        getColumnGroupState: () => store.columns.getColumnGroupState(),
        setColumnGroupState: (state) => store.setColumnGroupState(state, 'api'),
        resetColumnGroupState: () => {
            store.columns.resetColumnGroupState();
            store.setColumnGroupState(store.columns.getColumnGroupState(), 'api');
        },
        setColumnsVisible: (colIds, visible) => store.setColumnsVisible(colIds, visible, 'api'),
        setRowGroupColumns: (colIds) => store.setRowGroupColumns(colIds, 'api'),
        getRowGroupColumns: () => resolvedColumns(store.columns.getRowGroupColumnIds()),

        getSortModel: () => store.columns.getSortModel(),
        setSortModel: (sortModel) => store.setSortModel(sortModel, 'api'),
        getFilterModel: () => store.query.filterModel,
        setFilterModel: (model) => store.setFilterModel(model, 'api'),
        setColumnFilter: (colId, condition) => {
            const next = { ...store.query.filterModel };
            if (condition) {
                next[colId] = condition;
            } else {
                delete next[colId];
            }
            api.setFilterModel(next);
        },
        getSearch: () => store.query.search,
        setSearch: (text) => store.setSearch(text, 'api'),
        setExternalFilters: (filters) => store.setExternalFilters(filters, 'api'),
        setQuickFilter: (text) => deps.setQuickFilter(text),

        getSelection: () => store.selection,
        getSelectedRows: () => store.getSelectedRows(),
        isSelected: (rowId) => store.isRowSelected(rowId),
        setSelected: (rowIds, selected, options) => store.setSelected(rowIds, selected, options),
        selectAll: () => store.selectAllRows(),
        deselectAll: () => store.deselectAllRows(),
        getActiveRowId: () => store.activeRowId,
        setActiveRowId: (rowId) => store.setActiveRow(rowId, 'api'),

        getFocusedCell: () => store.focusedCell,
        setFocusedCell: (cell, options) => {
            store.focusCell(cell, 'api');
            if (cell && options?.scroll !== false) {
                geometry.ensureCellVisible(cell);
            }
        },
        moveFocus: (direction) => {
            if (store.editSession) {
                // Like Tab: commit first, and stay when the commit is rejected.
                void store.stopEditing(true, 'api', direction);

                return null;
            }
            const next = store.navigate(direction);
            if (next) {
                geometry.ensureCellVisible(next);
            }

            return next;
        },
        getRanges: () => [...store.ranges],
        getResolvedRanges: () => store.resolvedRanges,
        setRanges: (ranges) => store.setRanges(ranges, 'api'),
        clearRanges: () => store.setRanges([], 'api'),
        getCellValue: (cell: CellPosition, options) => {
            const row = store.getRow(cell.rowId);
            const column = store.columns.getResolved(cell.colId);
            if (!row || !column || !hasData(row)) {
                return undefined;
            }
            const value = column.getValue(row);

            return options?.formatted ? column.formatValue(row, value) : value;
        },
        startEditing: (cell, options) => {
            geometry.ensureCellVisible(cell);
            void store.startEditing(cell, { startKey: options?.startKey ?? null });
        },
        stopEditing: (commit) => {
            void store.stopEditing(commit, 'api');
        },
        getEditingCell: () => store.editSession?.cell ?? null,

        getPagination: () => store.getPagination(),
        setPage: (page) => store.setPage(page, 'api'),

        whenSettled: () => deps.whenSettled(),
        setOverlay: (overlay) => store.setOverlay(overlay),

        on: (name, listener) => (destroyed ? () => {} : store.events.on(name, listener as never)),
        off: (name, listener) => store.events.off(name, listener as never),
    };

    return api;
}
