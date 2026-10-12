/**
 * The grid's state and behaviour without React or the DOM: columns, the query (sort, filters, search), the
 * row model, focus, row selection, cell ranges, clipboard plans, the editor lifecycle and menus, with one
 * event bus.
 *
 * The React layer renders from the store and forwards input to it. Everything a user can do with keyboard
 * or pointer is a store method, so behaviour is tested here and the browser checks only prove the wiring.
 *
 * Rows come from a row model (local rows, or server rows in blocks). The store
 * owns the query and hands it to the model, and reacts to the model's changes: snapshot, focus recovery,
 * the edit session, the active row.
 */
import type {
    CellWriteRequest,
    PropagateWrite,
    WriteBatch,
    WriteResult,
    WriteSource,
    ColumnDef,
    RowWithData,
    CellPosition,
    CellRange,
    ColumnDefinition,
    ColumnGroupState,
    ColumnState,
    ChangeSource,
    DataRow,
    EditStopReason,
    ExternalFilters,
    FilterKind,
    FilterModel,
    GetDataPath,
    GetRowId,
    GridEventMap,
    GridRegistry,
    GridRow,
    MenuItem,
    QueryState,
    ResolvedCellRange,
    ResolvedColumn,
    RowId,
    RowSelection,
    RowSelectionMode,
    RowTransaction,
    ServerDataSource,
    SortModel,
    UnresolvedRegistryKey,
    ContextMenuParams,
    AnchorRect,
} from '../contract';
import { hasData } from '../contract';
import { defaultKey } from '../filters/evaluate';
import { LocalRowModel } from '../models/localRowModel';
import type { GridRowModel, Pagination, RowsChangeSource } from '../models/rowModel';
import { ServerRowModel } from '../models/serverRowModel';
import { isSyntheticRowId } from '../rows/ids';
import type { DefaultExpanded, LocalProjection } from '../rows/localProjection';
import type { RowSource } from '../virtual/verticalLayout';
import {
    copyMatrix,
    parseTsv,
    planClear,
    planFill,
    planPaste,
    serializeHtml,
    serializeTsv,
    type CellPlan,
    type CellWrite,
} from './clipboard';
import { ColumnModel } from './columns';
import { EditController, type EditSession } from './editing';
import { EventBus } from './eventBus';
import { DEFAULT_CONTEXT_MENU, DEFAULT_HEADER_MENU, openMenu, type MenuKind, type MenuState } from './menus';
import { FULL_WIDTH_COLUMN, nextFocus, recoverFocus, type NavigationKey } from './navigation';
import {
    aggregate,
    cellRangeEdges,
    extendRange,
    rangeFromCells,
    resolveRange,
    type AggregateResult,
    type CellRangeEdges,
} from './ranges';
import { BUILTIN_REGISTRY, createResolver, mergeRegistries, resolveColumnRefs } from './registry';
import {
    clickSelection,
    emptySelection,
    isSelected,
    select,
    selectAll,
    selectedLoadedRows,
    type ClickModifiers,
} from './selection';
import type { GridSnapshot, SnapshotColumn } from './snapshot';
import { WriteTracker } from './writes';

/** What covers the body: loading, an empty state with its reason, or a load error. */
export type GridOverlay =
    | { kind: 'loading' }
    | { kind: 'empty'; reason: 'noQuery' | 'noResults' }
    | { kind: 'error'; error: unknown }
    | null;

/** Filter kinds the default filter panel edits. */
export const BUILTIN_FILTER_EDITOR_KINDS: readonly string[] = ['text', 'number', 'date', 'set', 'boolean'];

/** Default id of the generated group column (`groupColumn.colId` changes it). */
export const GROUP_COLUMN_ID = '__group__';

export type GridStoreOptions<TData> = {
    /** Local rows. Ignored when `serverSource` is set. */
    rows: readonly TData[];
    /** Rows from a server, in blocks. */
    serverSource?: ServerDataSource<TData>;
    /** Server grids: rows per page, or null to scroll through every block. */
    pageSize?: number | null;
    paginateChildren?: boolean;
    /**
     * The query the grid starts with (initial filters, search, relationship filters, sort, row groups).
     * Applied before the first load, so a server grid's first request already carries it.
     */
    initialQuery?: Partial<QueryState>;
    /**
     * How group and tree rows display. `column` (default): a generated group column holds the hierarchy
     * (and master rows' toggles) whenever rows are grouped, tree-shaped or have details. `fullWidthRow`: group rows span the grid. `custom`: the
     * application decides with `isFullWidthRow`.
     */
    groupDisplay?: 'column' | 'fullWidthRow' | 'custom';
    /** Overrides for the generated group column (header, width, pinning, a `colId`, a `field` for leaves). */
    groupColumn?: Partial<ColumnDef<TData>>;
    /** Filter kinds with an editor in the filter panel; columns of other kinds offer no "Filter…" item. */
    filterEditorKinds?: readonly string[];
    getRowId?: GetRowId<TData>;
    getDataPath?: GetDataPath<TData>;
    /** Runs after sorting; must return the same rows, reordered. */
    sortRows?: (rows: readonly TData[]) => readonly TData[];
    isMaster?: (data: TData) => boolean;
    expandedByDefault?: DefaultExpanded<TData>;
    columns: ColumnDefinition<TData>[];
    registry?: GridRegistry<TData>;
    /** Throw on unresolved registry keys (development and tests). Default: report through `onUnresolvedKey`. */
    strictRegistry?: boolean;
    onUnresolvedKey?: (miss: UnresolvedRegistryKey) => void;
    interaction?: 'row' | 'cell';
    /**
     * The app owns the active row (`activeRowId` prop): a click reports the row through `activeRowChanged`
     * and the active row changes only when the app passes it back.
     */
    activeRowControlled?: boolean;
    rowSelection?: RowSelectionMode;
    isRowSelectable?: (row: GridRow<TData>) => boolean;
    enableRanges?: boolean;
    enableFill?: boolean;
    fillMode?: 'fill' | 'range';
    /** Paste rule: range paste (`range`) or row paste (`rows`). */
    pasteStrategy?: 'range' | 'rows';
    canWrite?: (cell: CellPosition, row: GridRow<TData>) => boolean;
    /** Text copied for a cell (`clipboard.format`). */
    clipboardFormat?: (
        value: unknown,
        context: { cell: CellPosition; row: GridRow<TData>; formatted: string }
    ) => string;
    /** Pasted text to a value, before the editor's parser (`clipboard.parse`). */
    clipboardParse?: (
        text: string,
        context: { cell: CellPosition; row: GridRow<TData> }
    ) => { ok: true; value: unknown } | { ok: false; error: string } | undefined;
    /**
     * Persists writes: edits, range edits, paste, fill, clear and `writeCells`, applied locally first.
     * Rejected cells roll back and show their error; returned rows replace local rows (see `writes.ts`).
     */
    persist?: (batch: WriteBatch<TData>) => Promise<WriteResult<TData> | void>;
    /** An edit inside a range of several rows writes the same value to the range's other rows in that column. */
    rangeEdit?: boolean;
    /** Derives writes on sibling rows from a committed edit. */
    propagateWrite?: PropagateWrite<TData>;
    isFullWidthRow?: (row: GridRow<TData>) => boolean;
    getContextMenuItems?: (params: ContextMenuParams<TData>) => MenuItem[];
    getHeaderMenuItems?: (params: ContextMenuParams<TData>) => MenuItem[];
    multiSort?: boolean;
    quickFilter?: string;
    mac?: boolean;
};

export type RangeDrag = { anchor: CellPosition; end: CellPosition; additive: boolean; previous: CellRange[] };

/**
 * A fill handle drag. The source rows are kept by identity and resolved again, because rows can change
 * mid-drag; the source columns are the ones selected when the drag started.
 */
export type FillDrag = { source: CellRange; colIds: string[]; target: ResolvedCellRange | null };

const DEFAULT_PAGE_SIZE = 10;
/** Copies up to this many cells also carry an HTML table. */
const HTML_COPY_CELL_LIMIT = 50_000;

export class GridStore<TData> {
    readonly events = new EventBus<GridEventMap<TData>>();
    readonly columns: ColumnModel<TData>;
    readonly editing: EditController<TData>;

    #options: GridStoreOptions<TData>;
    /** The query the model last received, to report sort and group changes as query changes. */
    #lastQuery: QueryState | null = null;
    /** Column definitions as given (registry keys resolved), without the generated group column. */
    #baseDefinitions: ColumnDefinition<TData>[] = [];
    #model: GridRowModel<TData>;
    #query: { filterModel: FilterModel; search: string; externalFilters: ExternalFilters } = {
        filterModel: {},
        search: '',
        externalFilters: {},
    };
    #unknownFilterKinds = new Set<string>();
    #snapshot: GridSnapshot<TData> | null = null;
    #version = 0;
    #rowsVersion = 0;
    #columnsVersion = 0;
    #listeners = new Set<() => void>();
    #misses: UnresolvedRegistryKey[] = [];

    #selection: RowSelection = emptySelection();
    #clickState: { anchorId: RowId | null; rangeEndId: RowId | null } = { anchorId: null, rangeEndId: null };
    #activeRowId: RowId | null = null;
    #focused: CellPosition | null = null;
    #focusedAt: { index: number; columnIndex: number } | null = null;
    #preferredColId: string | undefined;
    #ranges: CellRange[] = [];
    #resolvedRanges: ResolvedCellRange[] | null = null;
    #rangeDrag: RangeDrag | null = null;
    #fillDrag: FillDrag | null = null;
    #menu: MenuState | null = null;
    #rowVersions = new Map<RowId, number>();
    #writes = new WriteTracker();
    #isDestroyed = false;
    #pendingVersion = 0;
    #filterPanel: { colId: string; anchor: AnchorRect } | null = null;
    #overlay: 'loading' | 'empty' | null = null;
    #cellErrors = new Map<string, string>();
    #cellErrorsVersion = 0;
    #rectangles: {
        resolved: ResolvedCellRange[];
        snapshot: GridSnapshot<TData>;
        value: { top: number; bottom: number; left: number; right: number }[];
    } | null = null;
    #pageSize = DEFAULT_PAGE_SIZE;
    #rowDrag: { rowIds: RowId[]; over: { rowId: RowId; position: 'before' | 'after' } | null } | null = null;

    constructor(options: GridStoreOptions<TData>) {
        this.#options = options;
        this.#baseDefinitions = this.#resolveDefinitions(options.columns, options.registry);
        this.columns = new ColumnModel<TData>(this.#baseDefinitions);
        this.#model = options.serverSource
            ? new ServerRowModel<TData>(
                  {
                      source: options.serverSource,
                      ...(options.isMaster ? { isMaster: options.isMaster } : {}),
                      column: (colId) => this.columns.getResolved(colId),
                      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
                      ...(options.paginateChildren !== undefined ? { paginateChildren: options.paginateChildren } : {}),
                      onBlockLoaded: (event) => this.events.emit('blockLoaded', event),
                      onStatus: (status) => this.events.emit('statusChanged', { status }),
                  },
                  (source) => this.#modelChanged(source)
              )
            : new LocalRowModel<TData>(
                  this.#modelOptions(options),
                  {
                      getResolved: (colId) => this.columns.getResolved(colId),
                      displayedColIds: () => this.columns.getDisplayedLeaves().map((leaf) => leaf.colId),
                  },
                  (source) => this.#modelChanged(source)
              );
        this.editing = new EditController<TData>({
            getRow: (rowId) => {
                const row = this.#model.getRow(rowId);

                return row?.kind === 'data' && hasData(row) ? (row as DataRow<TData>) : undefined;
            },
            getColumn: (colId) => this.columns.getResolved(colId),
            isColumnDisplayed: (colId) => this.snapshot.columnIndexOf(colId) !== undefined,
            onChange: () => this.#notify(),
            onStarted: (event) => this.events.emit('editStarted', event),
            onStopped: (event) => {
                if (event.row) {
                    this.events.emit('editStopped', {
                        cell: event.cell,
                        row: event.row,
                        committed: event.committed,
                        reason: event.reason,
                    });
                }
            },
            onValueChanged: (event) => {
                this.#cellErrorsVersion++;
                this.#cellErrors.delete(cellKey(event.cell));
                this.events.emit('cellValueChanged', { ...event, source: 'edit' });
                this.#editCommitted(event);
            },
            canEditCell: (cell, row) => this.#options.canWrite?.(cell, row) ?? true,
        });
        const initial = options.initialQuery;
        if (initial) {
            this.#query = {
                filterModel: initial.filterModel ?? {},
                search: initial.search ?? '',
                externalFilters: initial.externalFilters ?? {},
            };
            if (initial.sortModel) {
                this.columns.setSortModel(initial.sortModel);
            }
            if (initial.rowGroupColIds) {
                this.columns.setRowGroupColumns(initial.rowGroupColIds);
            }
        }
        if (this.#wantsGroupColumn()) {
            this.columns.setDefinitions(this.#definitionsWithGroupColumn());
        }
        // The first query goes to the model once everything it notifies exists (a server model loads now).
        this.#lastQuery = this.query;
        this.#model.setQuery(this.query);
        this.#model.setColumnState(this.columns.getColumnState());
    }

    // Subscription (useSyncExternalStore)

    subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    };

    getVersion = (): number => this.#version;

    /** Changes whenever the displayed rows change; the virtualizer's source version. */
    get rowsVersion(): number {
        return this.#rowsVersion;
    }

    #pinnedVersion = 0;

    /** Changes whenever column definitions or state change; the horizontal virtualizer's columns version. */
    get columnsVersion(): number {
        return this.#columnsVersion;
    }

    get options(): GridStoreOptions<TData> {
        return this.#options;
    }

    /** The displayed rows. */
    get projection(): LocalProjection<TData> {
        if (!(this.#model instanceof LocalRowModel)) {
            throw new Error('GridStore.projection is for local rows; use rowModel.');
        }

        return this.#model.projection;
    }

    get rowModel(): GridRowModel<TData> {
        return this.#model;
    }

    /** The layout's view of the displayed rows; a new object whenever they change. */
    get rowSource(): RowSource<TData> {
        return this.#model.rowSource;
    }

    // Query

    get query(): QueryState {
        return {
            sortModel: this.columns.getSortModel(),
            filterModel: this.#query.filterModel,
            search: this.#query.search,
            externalFilters: this.#query.externalFilters,
            rowGroupColIds: this.columns.getRowGroupColumnIds(),
        };
    }

    setFilterModel(filterModel: FilterModel, source: ChangeSource = 'api'): void {
        if (JSON.stringify(filterModel) === JSON.stringify(this.#query.filterModel)) {
            return;
        }
        const previous = this.query;
        this.#query = { ...this.#query, filterModel };
        this.events.emit('filterChanged', { filterModel, source });
        this.#queryChanged(previous, source);
    }

    setSearch(search: string, source: ChangeSource = 'api'): void {
        if (search === this.#query.search) {
            return;
        }
        const previous = this.query;
        this.#query = { ...this.#query, search };
        this.#queryChanged(previous, source);
    }

    setExternalFilters(externalFilters: ExternalFilters, source: ChangeSource = 'api'): void {
        const previous = this.query;
        this.#query = { ...this.#query, externalFilters };
        this.#queryChanged(previous, source);
    }

    // Data

    applyTransaction(transaction: RowTransaction<TData>): void {
        this.#model.applyTransaction(transaction);
    }

    patchRows(updates: { id: RowId; data: TData }[]): void {
        this.#model.patchRows(updates);
    }

    setPinnedRows(section: 'top' | 'bottom', rows: readonly TData[]): void {
        this.#model.setPinnedRows(section, rows);
        this.#pinnedVersion++;
        this.events.emit('pinnedRowsChanged', { section });
        this.#notify();
    }

    getPinnedRows(section: 'top' | 'bottom'): readonly GridRow<TData>[] {
        return this.#model.getPinnedRows(section);
    }

    /** Changes whenever pinned rows are set, so renderers can memoise on it. */
    get pinnedVersion(): number {
        return this.#pinnedVersion;
    }

    /** Re-runs sorting, filtering and grouping after data changed in place. */
    /**
     * Re-renders cells after their data changed in place: the given rows, or every row.
     * Sorting, filtering and grouping are not re-run; `refresh()` does that. Data written in place also
     * drops the quick filter's cached text for those rows.
     */
    refreshCells(rowIds?: readonly RowId[]): void {
        this.#model.markDataChanged();
        if (rowIds === undefined) {
            this.#rowsVersion++;
        } else {
            for (const rowId of rowIds) {
                this.#rowVersions.set(rowId, (this.#rowVersions.get(rowId) ?? 0) + 1);
            }
        }
        this.#notify();
    }

    /** Changes whenever `refreshCells` names the row, so a memoised row knows to render again. */
    rowVersion(rowId: RowId): number {
        return this.#rowVersions.get(rowId) ?? 0;
    }

    /** Registry keys that did not resolve when the definitions were last set. */
    get unresolvedKeys(): readonly UnresolvedRegistryKey[] {
        return this.#misses;
    }

    // Options and data

    /** Applies new options. Rows, columns, registry and quick filter changes rebuild what depends on them. */
    setOptions(next: GridStoreOptions<TData>): void {
        const previous = this.#options;
        const fill = this.#fillDrag;
        const rangeSignature = (range: ResolvedCellRange | null) =>
            range ? JSON.stringify([range.startIndex, range.endIndex, range.rowIds, range.colIds]) : null;
        const sourceBefore = fill ? rangeSignature(this.#fillSource(fill)) : null;
        const targetBefore = fill?.target ? rangeSignature(fill.target) : null;
        const columnStateBefore = fill ? JSON.stringify(this.columns.getColumnState()) : null;
        const queryBefore = fill ? JSON.stringify(this.query) : null;
        const rangesBefore = fill ? JSON.stringify(this.#ranges) : null;
        this.#options = next;
        if (
            next.columns !== previous.columns ||
            next.registry !== previous.registry ||
            next.groupColumn !== previous.groupColumn
        ) {
            this.#baseDefinitions = this.#resolveDefinitions(next.columns, next.registry);
            this.columns.setDefinitions(
                this.#wantsGroupColumn() ? this.#definitionsWithGroupColumn() : this.#baseDefinitions
            );
            this.#columnsChanged('definitions', [], 'data');
        } else if (
            next.groupDisplay !== previous.groupDisplay ||
            next.getDataPath !== previous.getDataPath ||
            Boolean(next.isMaster) !== Boolean(previous.isMaster)
        ) {
            this.#syncGroupColumn('data');
        }
        if (this.#model instanceof LocalRowModel) {
            this.#model.setOptions(this.#modelOptions(next));
        } else if (this.#model instanceof ServerRowModel && next.serverSource) {
            this.#model.setOptions({
                source: next.serverSource,
                column: (colId) => this.columns.getResolved(colId),
                ...(next.isMaster ? { isMaster: next.isMaster } : {}),
                ...(next.pageSize ? { pageSize: next.pageSize } : {}),
                ...(next.paginateChildren !== undefined ? { paginateChildren: next.paginateChildren } : {}),
                onBlockLoaded: (event) => this.events.emit('blockLoaded', event),
                onStatus: (status) => this.events.emit('statusChanged', { status }),
            });
        }
        // React can replace callback definitions during a gesture without changing its rows or columns.
        // Keep that gesture; real data, query, column-state or selection changes still cancel it.
        if (
            fill &&
            !this.#fillDrag &&
            next.rows === previous.rows &&
            next.serverSource === previous.serverSource &&
            next.getRowId === previous.getRowId &&
            next.sortRows === previous.sortRows &&
            next.getDataPath === previous.getDataPath &&
            next.isMaster === previous.isMaster &&
            next.isFullWidthRow === previous.isFullWidthRow &&
            JSON.stringify(this.columns.getColumnState()) === columnStateBefore &&
            JSON.stringify(this.query) === queryBefore &&
            JSON.stringify(this.#ranges) === rangesBefore &&
            sourceBefore !== null &&
            rangeSignature(this.#fillSource(fill)) === sourceBefore
        ) {
            const target =
                fill.target &&
                resolveRange(
                    rangeFromCells(
                        { rowId: fill.target.rowIds[0]!, colId: fill.target.colIds[0]! },
                        {
                            rowId: fill.target.rowIds[fill.target.rowIds.length - 1]!,
                            colId: fill.target.colIds[fill.target.colIds.length - 1]!,
                        }
                    ),
                    this.snapshot
                );
            if (rangeSignature(target) === targetBefore) {
                this.#fillDrag = fill;
            }
        }
        this.#notify();
    }

    /** Rows per Page Up and Page Down; the React layer sets it from the viewport height. */
    setPageSize(rows: number): void {
        this.#pageSize = Math.max(1, Math.floor(rows));
    }

    getRow(rowId: RowId): GridRow<TData> | undefined {
        return this.#model.getRow(rowId);
    }

    setExpanded(rowId: RowId, expanded: boolean): void {
        this.#model.setExpanded(rowId, expanded);
    }

    // Snapshot

    get snapshot(): GridSnapshot<TData> {
        if (this.#snapshot) {
            return this.#snapshot;
        }
        const model = this.#model;
        const leaves = this.columns.getDisplayedLeaves();
        const columns: SnapshotColumn<TData>[] = leaves.map((leaf) => {
            const resolved = this.columns.getResolved(leaf.colId)!;

            return {
                colId: leaf.colId,
                focusable: leaf.def.focusable !== false,
                getValue: (row) => (hasData(row) ? resolved.getValue(row) : undefined),
                formatValue: (row) => (hasData(row) ? resolved.formatValue(row, resolved.getValue(row)) : ''),
                isEditable: (row) => Boolean(resolved.setValue) && resolved.isEditable(row),
            };
        });
        const columnIndex = new Map(columns.map((column, index) => [column.colId, index]));
        this.#snapshot = {
            // Displayed rows including loading placeholders, which can be focused.
            rowCount: model.rowSource.count,
            rowAt: (index) => model.getRowAtIndex(index)?.row,
            indexOf: (id) => model.getIndexOf(id),
            columns,
            columnIndexOf: (colId) => columnIndex.get(colId),
            isFullWidth: (row) => this.isFullWidth(row),
        };

        return this.#snapshot;
    }

    /**
     * Rows that render as one cell: full-width and detail rows, group rows (unless a group column displays
     * them), and rows the app marks with `isFullWidthRow`.
     */
    isFullWidth(row: GridRow<TData>): boolean {
        return (
            row.kind === 'fullWidth' ||
            row.kind === 'detail' ||
            (row.kind === 'group' && this.#options.groupDisplay === 'fullWidthRow') ||
            (this.#options.isFullWidthRow?.(row) ?? false)
        );
    }

    /** The generated group column's id while it is shown, otherwise null. */
    get groupColumnId(): string | null {
        const colId = this.#groupColumnColId();

        return this.columns.getLeaf(colId) && this.#wantsGroupColumn() ? colId : null;
    }

    // Columns

    toggleSort(colId: string, multi: boolean): void {
        this.columns.toggleSort(colId, multi && this.#options.multiSort !== false);
        this.#sortChanged('user');
    }

    setSortModel(model: SortModel, source: ChangeSource = 'api'): void {
        this.columns.setSortModel(model);
        this.#sortChanged(source);
    }

    resizeColumn(colId: string, width: number, finished: boolean): void {
        this.columns.setWidth(colId, width);
        this.#columnsChanged('resized', [colId], 'user', finished);
        this.#notify();
    }

    moveColumn(colId: string, toIndex: number): void {
        if (this.columns.moveColumn(colId, toIndex)) {
            this.#columnsChanged('moved', [colId], 'user');
            this.#notify();
        }
    }

    applyColumnState(
        state: readonly ColumnState[],
        options: { applyOrder?: boolean; defaultState?: Partial<ColumnState> } = {},
        source: ChangeSource = 'api'
    ): void {
        const sortBefore = JSON.stringify(this.columns.getSortModel());
        if (this.columns.applyColumnState(state, options)) {
            this.#columnsChanged(
                'definitions',
                state.map((entry) => entry.colId),
                source
            );
            if (JSON.stringify(this.columns.getSortModel()) !== sortBefore) {
                this.#sortChanged(source);
            }
            this.#notify();
        }
    }

    resetColumnState(source: ChangeSource = 'api'): void {
        this.columns.resetColumnState();
        this.#columnsChanged('definitions', [], source);
        this.#sortChanged(source);
    }

    setColumnsVisible(colIds: readonly string[], visible: boolean, source: ChangeSource = 'api'): void {
        this.columns.setColumnsVisible(colIds, visible);
        this.#columnsChanged('visible', [...colIds], source);
        this.#notify();
    }

    /** Groups rows by these columns, outermost first; an empty list ungroups. */
    setRowGroupColumns(colIds: readonly string[], source: ChangeSource = 'api'): void {
        const before = this.columns.getRowGroupColumnIds().join('\u0000');
        this.columns.setRowGroupColumns(colIds);
        if (this.columns.getRowGroupColumnIds().join('\u0000') !== before) {
            this.#columnsChanged('rowGroup', [...colIds], source);
            this.#notify();
        }
    }

    setColumnGroupState(state: readonly ColumnGroupState[], source: ChangeSource = 'api'): void {
        this.columns.setColumnGroupState(state);
        for (const entry of state) {
            this.events.emit('columnGroupStateChanged', {
                columnGroupState: this.columns.getColumnGroupState(),
                groupId: entry.groupId,
                source,
            });
        }
        this.#columnsChanged('visible', [], source);
        this.#notify();
    }

    // Focus and navigation

    get focusedCell(): CellPosition | null {
        return this.#focused;
    }

    focusCell(cell: CellPosition | null, source: ChangeSource = 'user'): void {
        if (sameCell(cell, this.#focused)) {
            return;
        }
        if (this.#focused && this.#focused.colId !== FULL_WIDTH_COLUMN && cell?.colId === FULL_WIDTH_COLUMN) {
            this.#preferredColId = this.#focused.colId;
        }
        this.#focused = cell;
        this.#rememberFocusPosition();
        this.events.emit('focusChanged', { cell, source });
        this.#notify();
    }

    /**
     * Moves focus for a navigation key. With `extend`, the last range grows instead (Shift plus arrows).
     * Returns the new focus, or null when focus leaves the grid (Tab past the end).
     */
    navigate(key: NavigationKey, options: { extend?: boolean } = {}): CellPosition | null {
        if (options.extend && this.#options.enableRanges && this.#focused) {
            const last = this.#ranges[this.#ranges.length - 1] ?? rangeFromCells(this.#focused, this.#focused);
            const next = extendRange(last, this.snapshot, key, { pageSize: this.#pageSize });
            this.setRanges([...this.#ranges.slice(0, -1), next], 'user');

            return this.#focused;
        }
        const next = nextFocus(this.snapshot, this.#focused, key, {
            pageSize: this.#pageSize,
            ...(this.#preferredColId ? { preferredColId: this.#preferredColId } : {}),
        });
        if (next === null) {
            return null;
        }
        this.focusCell(next);
        if (this.#ranges.length > 0) {
            this.setRanges([], 'user');
        }

        return next;
    }

    // Row selection and active row

    get selection(): RowSelection {
        return this.#selection;
    }

    get activeRowId(): RowId | null {
        return this.#activeRowId;
    }

    isRowSelected(rowId: RowId): boolean {
        const row = this.#model.getRow(rowId);
        if (!row) {
            // A data row not loaded yet keeps its selection; loading, failed and pinned rows are never selected.
            return !isSyntheticRowId(rowId) && isSelected(this.#selection, rowId);
        }

        return isSelected(this.#selection, rowId) && this.#isSelectable(row);
    }

    setSelection(selection: RowSelection, source: ChangeSource = 'api'): void {
        if (selection === this.#selection) {
            return;
        }
        this.#selection = selection;
        this.events.emit('selectionChanged', { selection, source });
        this.#notify();
    }

    setSelected(rowIds: readonly RowId[], selected: boolean, options: { clearOthers?: boolean } = {}): void {
        const mode = this.#options.rowSelection;
        if (!mode || mode === 'none') {
            return;
        }
        this.setSelection(
            select(this.#selection, rowIds, selected, {
                mode,
                ...(options.clearOthers !== undefined ? { clearOthers: options.clearOthers } : {}),
                isSelectable: (id) => {
                    const row = this.#model.getRow(id);

                    return !row || this.#isSelectable(row);
                },
            })
        );
    }

    selectAllRows(): void {
        if (this.#options.rowSelection === 'multiple') {
            this.setSelection(selectAll());
        }
    }

    deselectAllRows(): void {
        this.setSelection(emptySelection());
    }

    /** What the select-all checkbox shows: none, some or all of the selectable rows that pass the filters. */
    headerSelectionState(): 'none' | 'some' | 'all' {
        const selection = this.#selection;
        if (selection.mode === 'all') {
            return selection.excludedIds.size === 0 ? 'all' : 'some';
        }
        if (selection.ids.size === 0) {
            return 'none';
        }
        let selectable = 0;
        let selected = 0;
        this.#model.forEachRow(
            (row) => {
                if (this.#isSelectable(row)) {
                    selectable += 1;
                    selected += selection.ids.has(row.id) ? 1 : 0;
                }
            },
            { includeCollapsed: true, includeFiltered: false }
        );

        return selected === 0 ? 'none' : selected === selectable ? 'all' : 'some';
    }

    getSelectedRows(): GridRow<TData>[] {
        const rows: GridRow<TData>[] = [];
        this.#model.forEachRow((row) => rows.push(row), {
            includeCollapsed: true,
            includeFiltered: this.#selection.mode === 'ids',
        });

        return selectedLoadedRows(this.#selection, rows).filter((row) => this.#isSelectable(row));
    }

    /** A row click: selection by the click rules, and the active row. */
    clickRow(rowId: RowId, modifiers: ClickModifiers): void {
        const mode = this.#options.rowSelection;
        if (mode && mode !== 'none') {
            const result = clickSelection(this.#selection, this.snapshot, rowId, modifiers, this.#clickState, {
                mode,
                isSelectable: (id) => {
                    const row = this.#model.getRow(id);

                    return Boolean(row && this.#isSelectable(row));
                },
            });
            this.#clickState = { anchorId: result.anchorId, rangeEndId: result.rangeEndId };
            this.setSelection(result.selection, 'user');
        }
        this.setActiveRow(rowId, 'user');
    }

    setActiveRow(rowId: RowId | null, source: ChangeSource = 'api'): void {
        if (rowId === this.#activeRowId) {
            return;
        }
        if (this.#options.activeRowControlled && source === 'user') {
            this.events.emit('activeRowChanged', { rowId, source });

            return;
        }
        this.#activeRowId = rowId;
        this.events.emit('activeRowChanged', { rowId, source });
        this.#notify();
    }

    // Ranges

    get ranges(): readonly CellRange[] {
        return this.#ranges;
    }

    get resolvedRanges(): ResolvedCellRange[] {
        this.#resolvedRanges ??= this.#ranges
            .map((range) => resolveRange(range, this.snapshot))
            .filter((range): range is ResolvedCellRange => range !== null);

        return this.#resolvedRanges;
    }

    setRanges(ranges: CellRange[], source: ChangeSource = 'api', finished = true): void {
        this.#ranges = ranges;
        this.#resolvedRanges = null;
        this.events.emit('rangesChanged', { ranges, finished, source });
        this.#notify();
    }

    /**
     * The ranges as rectangles of displayed row and column indexes, computed once per model and range
     * change. Rendering reads these instead of resolving each cell against each range.
     */
    get rangeRectangles(): readonly { top: number; bottom: number; left: number; right: number }[] {
        const resolved = this.resolvedRanges;
        const snapshot = this.snapshot;
        if (this.#rectangles?.resolved === resolved && this.#rectangles.snapshot === snapshot) {
            return this.#rectangles.value;
        }
        const value = resolved.flatMap((range) => {
            const indexes = range.colIds
                .map((colId) => snapshot.columnIndexOf(colId))
                .filter((index): index is number => index !== undefined);
            if (indexes.length === 0) {
                return [];
            }

            return [
                {
                    top: range.startIndex,
                    bottom: range.endIndex,
                    left: Math.min(...indexes),
                    right: Math.max(...indexes),
                },
            ];
        });
        this.#rectangles = { resolved, snapshot, value };

        return value;
    }

    /** Changes whenever a cell's validation error is set or cleared, so rows showing errors re-render. */
    get cellErrorsVersion(): number {
        return this.#cellErrorsVersion;
    }

    rangeEdges(rowId: RowId, colId: string): CellRangeEdges | null {
        if (this.#ranges.length === 0) {
            return null;
        }
        const edges = cellRangeEdges(this.resolvedRanges, rowId, colId, this.snapshot);

        return edges.inRange ? edges : null;
    }

    /** Pointer down on a cell: focus it and start a range drag. Shift extends from the focus; Ctrl or Cmd adds a range. */
    pointerDownCell(cell: CellPosition, modifiers: { shift: boolean; toggle: boolean }): void {
        if (!this.#options.enableRanges || cell.colId === FULL_WIDTH_COLUMN) {
            this.focusCell(cell);
            if (this.#ranges.length > 0) {
                this.setRanges([], 'user');
            }

            return;
        }
        if (modifiers.shift && this.#focused && this.#focused.colId !== FULL_WIDTH_COLUMN) {
            const anchor = this.#ranges[this.#ranges.length - 1]?.anchor ?? this.#focused;
            this.#rangeDrag = { anchor, end: cell, additive: false, previous: this.#ranges.slice(0, -1) };
            this.setRanges([...this.#rangeDrag.previous, rangeFromCells(anchor, cell)], 'user', false);

            return;
        }
        this.focusCell(cell);
        const previous = modifiers.toggle ? [...this.#ranges] : [];
        this.#rangeDrag = { anchor: cell, end: cell, additive: modifiers.toggle, previous };
        this.setRanges(modifiers.toggle ? [...previous, rangeFromCells(cell, cell)] : [], 'user', false);
    }

    /** Pointer moved over a cell during a drag. */
    dragOverCell(cell: CellPosition): void {
        const drag = this.#rangeDrag;
        if (drag && !sameCell(drag.end, cell) && cell.colId !== FULL_WIDTH_COLUMN) {
            drag.end = cell;
            this.setRanges([...drag.previous, rangeFromCells(drag.anchor, cell)], 'user', false);
        }
        const fill = this.#fillDrag;
        if (fill) {
            this.#updateFill(cell);
        }
    }

    /** Pointer released: ends a range or fill drag. A one-cell range from a plain click is dropped. */
    pointerUp(): void {
        const drag = this.#rangeDrag;
        if (drag) {
            this.#rangeDrag = null;
            const last = this.#ranges[this.#ranges.length - 1];
            if (!drag.additive && last && sameCell(last.anchor, last.end) && drag.previous.length === 0) {
                this.setRanges([], 'user', true);
            } else {
                this.setRanges([...this.#ranges], 'user', true);
            }
        }
        if (this.#fillDrag) {
            void this.#finishFill();
        }
    }

    get isDragging(): boolean {
        return this.#rangeDrag !== null || this.#fillDrag !== null;
    }

    /** Selects every cell (Ctrl or Cmd plus A) with ranges enabled. */
    selectAllCells(): void {
        const snapshot = this.snapshot;
        const columns = snapshot.columns.filter((column) => column.focusable);
        const first = snapshot.rowAt(0);
        const last = snapshot.rowAt(snapshot.rowCount - 1);
        if (!this.#options.enableRanges || !first || !last || columns.length === 0) {
            return;
        }
        this.setRanges(
            [
                rangeFromCells(
                    { rowId: first.id, colId: columns[0]!.colId },
                    { rowId: last.id, colId: columns[columns.length - 1]!.colId }
                ),
            ],
            'user'
        );
    }

    getAggregation(): AggregateResult | null {
        return this.#ranges.length === 0 ? null : aggregate(this.resolvedRanges, this.snapshot);
    }

    // Fill handle

    startFill(): void {
        const source = this.#ranges[this.#ranges.length - 1];
        if (this.#options.enableFill && source && this.#ranges.length === 1 && this.resolvedRanges.length === 1) {
            this.#fillDrag = { source, colIds: [...this.resolvedRanges[0]!.colIds], target: null };
            this.#notify();
        }
    }

    get fillTarget(): ResolvedCellRange | null {
        return this.#fillDrag?.target ?? null;
    }

    #updateFill(cell: CellPosition): void {
        const fill = this.#fillDrag!;
        const source = this.#fillSource(fill);
        if (!source) {
            // The source rows went away mid-drag (refresh, filter): the drag ends without filling.
            this.#fillDrag = null;
            this.#notify();

            return;
        }
        const index = this.snapshot.indexOf(cell.rowId);
        if (index === undefined) {
            return;
        }
        // The fill handle only fills rows: the target spans the source columns.
        const startIndex = Math.min(source.startIndex, index);
        const endIndex = Math.max(source.endIndex, index);
        const range = resolveRange(
            rangeFromCells(
                { rowId: this.snapshot.rowAt(startIndex)!.id, colId: source.colIds[0]! },
                { rowId: this.snapshot.rowAt(endIndex)!.id, colId: source.colIds[source.colIds.length - 1]! }
            ),
            this.snapshot
        );
        fill.target =
            range && (range.startIndex !== source.startIndex || range.endIndex !== source.endIndex) ? range : null;
        this.#notify();
    }

    /** The fill source at the current model version, or null when its rows or columns are gone. */
    #fillSource(fill: FillDrag): ResolvedCellRange | null {
        const resolved = resolveRange(fill.source, this.snapshot);
        const colIds = fill.colIds.filter((colId) => this.snapshot.columnIndexOf(colId) !== undefined);

        return resolved && colIds.length > 0 ? { ...resolved, colIds } : null;
    }

    async #finishFill(): Promise<void> {
        const fill = this.#fillDrag!;
        this.#fillDrag = null;
        const source = this.#fillSource(fill);
        // The target was resolved at the last pointer move; drop it if rows changed since.
        const target =
            fill.target &&
            resolveRange(
                rangeFromCells(
                    { rowId: fill.target.rowIds[0]!, colId: fill.target.colIds[0]! },
                    {
                        rowId: fill.target.rowIds[fill.target.rowIds.length - 1]!,
                        colId: fill.target.colIds[fill.target.colIds.length - 1]!,
                    }
                ),
                this.snapshot
            );
        if (!source || !target) {
            this.#notify();

            return;
        }
        const plan =
            this.#options.fillMode === 'range' ? null : planFill(source, target, this.snapshot, this.#writeOptions());
        this.setRanges(
            [
                rangeFromCells(
                    { rowId: target.rowIds[0]!, colId: target.colIds[0]! },
                    { rowId: target.rowIds[target.rowIds.length - 1]!, colId: target.colIds[target.colIds.length - 1]! }
                ),
            ],
            'user'
        );
        if (plan) {
            await this.#applyPlan(plan, 'fill');
        }
    }

    // Row drag

    /**
     * Starts dragging rows. Dragging a selected row drags the whole selection (loaded data rows, in display
     * order); any other row drags alone. Returns the dragged ids.
     */
    startRowDrag(rowId: RowId): RowId[] {
        const selected = this.isRowSelected(rowId)
            ? this.getSelectedRows()
                  .map((row) => row.id)
                  .filter((id) => this.#model.getIndexOf(id) !== undefined)
                  .sort((a, b) => this.#model.getIndexOf(a)! - this.#model.getIndexOf(b)!)
            : [rowId];
        this.#rowDrag = { rowIds: selected, over: null };
        this.#notify();

        return selected;
    }

    get rowDrag(): { rowIds: readonly RowId[]; over: { rowId: RowId; position: 'before' | 'after' } | null } | null {
        return this.#rowDrag;
    }

    /** The pointer is over a row during a row drag. Dropping onto a dragged row is no drop target. */
    rowDragOver(rowId: RowId | null, position: 'before' | 'after'): void {
        const drag = this.#rowDrag;
        if (!drag) {
            return;
        }
        const over = rowId === null || drag.rowIds.includes(rowId) ? null : { rowId, position };
        if (JSON.stringify(over) !== JSON.stringify(drag.over)) {
            this.#rowDrag = { ...drag, over };
            this.#notify();
        }
    }

    /** Ends a row drag. With `drop`, emits `rowDragEnded` for the current target; the app reorders its data. */
    endRowDrag(drop: boolean): void {
        const drag = this.#rowDrag;
        this.#rowDrag = null;
        if (drop && drag?.over) {
            const overIndex = this.#model.getIndexOf(drag.over.rowId);
            if (overIndex !== undefined) {
                this.events.emit('rowDragEnded', {
                    rowIds: drag.rowIds,
                    overRowId: drag.over.rowId,
                    position: drag.over.position,
                    targetIndex: overIndex + (drag.over.position === 'after' ? 1 : 0),
                });
            }
        }
        this.#notify();
    }

    // Clipboard

    /** What Ctrl or Cmd plus C copies: the ranges, or the focused cell. */
    copy(options: { includeHeaders?: boolean } = {}): { text: string; html: string } | null {
        const ranges = this.#copyRanges();
        if (ranges.length === 0) {
            return null;
        }
        const result = copyMatrix(ranges, this.snapshot, {
            ...(options.includeHeaders !== undefined ? { includeHeaders: options.includeHeaders } : {}),
            headerOf: (colId) => this.columns.getResolved(colId)?.headerName ?? colId,
            ...(this.#options.clipboardFormat
                ? {
                      formatCell: (row: GridRow<TData>, colId: string, formatted: string) => {
                          const column = this.columns.getResolved(colId);
                          const value = column && hasData(row) ? column.getValue(row as RowWithData<TData>) : undefined;

                          return this.#options.clipboardFormat!(value, {
                              cell: { rowId: row.id, colId },
                              row,
                              formatted,
                          });
                      },
                  }
                : {}),
        });
        if (result.matrix.length === 0) {
            return null;
        }
        const body = options.includeHeaders ? result.matrix.slice(1) : result.matrix;
        // Spreadsheets read the text; the HTML table only helps rich-text targets and grows to many times
        // the text's size, so large copies carry text only.
        const cells = result.matrix.length * (result.colIds.length || 1);

        return {
            text: serializeTsv(result.matrix),
            html:
                cells <= HTML_COPY_CELL_LIMIT
                    ? serializeHtml(body, options.includeHeaders ? { header: result.matrix[0]! } : {})
                    : '',
        };
    }

    /** Pastes clipboard text at the ranges or focus. Resolves with the cells written and rejected. */
    async paste(text: string): Promise<{ written: number; rejected: number }> {
        // An empty clipboard pastes nothing (a copied empty cell arrives as a newline, not as '').
        if (text === '' || !this.#focused || this.#focused.colId === FULL_WIDTH_COLUMN || this.editing.session) {
            return { written: 0, rejected: 0 };
        }
        const plan = planPaste(parseTsv(text), { ranges: this.resolvedRanges, focus: this.#focused }, this.snapshot, {
            ...this.#writeOptions(),
            ...(this.#options.pasteStrategy ? { strategy: this.#options.pasteStrategy } : {}),
        });
        this.events.emit('pasteStarted', {});
        const result = this.#applyPlan(plan, 'paste', (counts) => this.events.emit('pasteEnded', counts));

        return result;
    }

    /** Delete or Backspace outside an editor: clears writable cells of the ranges or the focused cell. */
    async clear(): Promise<{ written: number; rejected: number }> {
        const ranges = this.#copyRanges();

        return this.#applyPlan(planClear(ranges, this.snapshot, this.#writeOptions()), 'clear');
    }

    /** Copy, then clear what was copied. */
    cut(): { text: string; html: string } | null {
        const copied = this.copy();
        if (copied) {
            void this.clear();
        }

        return copied;
    }

    cellError(cell: CellPosition): string | undefined {
        return this.#cellErrors.get(cellKey(cell));
    }

    /** Paste needs a writable cell to land in only then. */
    canPaste(): boolean {
        return (
            this.#focused !== null && this.#focused.colId !== FULL_WIDTH_COLUMN && this.#anyWritable(this.#copyRanges())
        );
    }

    /** Cut needs something to copy that can also be cleared. */
    canCut(): boolean {
        const ranges = this.#copyRanges();

        return ranges.length > 0 && this.#anyWritable(ranges);
    }

    /** Whether any cell in the ranges is writable (column editable and `canWrite`). Stops after 5,000 cells. */
    #anyWritable(ranges: readonly ResolvedCellRange[]): boolean {
        let checked = 0;
        for (const range of ranges) {
            for (const rowId of range.rowIds) {
                const row = this.#model.getRow(rowId);
                if (!row || row.kind !== 'data') {
                    continue;
                }
                for (const colId of range.colIds) {
                    const column = this.columns.getResolved(colId);
                    if (
                        column?.setValue &&
                        column.isEditable(row) &&
                        (this.#options.canWrite?.({ rowId, colId }, row) ?? true)
                    ) {
                        return true;
                    }
                    if (++checked >= 5000) {
                        return false;
                    }
                }
            }
        }

        return false;
    }

    #copyRanges(): ResolvedCellRange[] {
        if (this.resolvedRanges.length > 0) {
            return this.resolvedRanges;
        }
        if (!this.#focused || this.#focused.colId === FULL_WIDTH_COLUMN) {
            return [];
        }
        const range = resolveRange(rangeFromCells(this.#focused, this.#focused), this.snapshot);

        return range ? [range] : [];
    }

    #writeOptions(): { canWrite?: (cell: CellPosition, row: GridRow<TData>) => boolean } {
        return this.#options.canWrite ? { canWrite: this.#options.canWrite } : {};
    }

    /** Writes a plan locally, then persists it; rejected cells are rolled back and marked invalid. */
    async #applyPlan(
        plan: CellPlan,
        source: 'paste' | 'fill' | 'clear',
        afterLocal?: (counts: { written: number; rejected: number }) => void
    ): Promise<{ written: number; rejected: number }> {
        const applied: {
            cell: CellPosition;
            text: string;
            value: unknown;
            oldValue: unknown;
            row: DataRow<TData>;
            column: ResolvedColumn<TData>;
        }[] = [];
        let rejected = 0;
        for (const write of plan.writes) {
            const outcome = this.#writeCell(write, source === 'paste' ? this.#options.clipboardParse : undefined);
            if (outcome === null) {
                continue;
            }
            if ('error' in outcome) {
                rejected++;
                this.#cellErrorsVersion++;
                this.#cellErrors.set(cellKey(write.cell), outcome.error);
                continue;
            }
            applied.push({ ...write, ...outcome });
        }
        for (const write of applied) {
            this.events.emit('cellValueChanged', {
                cell: write.cell,
                row: write.row,
                oldValue: write.oldValue,
                newValue: write.value,
                source,
            });
        }
        this.#model.markDataChanged();
        this.#rowsChanged('data');
        this.#notify();
        afterLocal?.({ written: applied.length, rejected });
        if (applied.length > 0) {
            const settled = await this.#persist(
                applied.map(({ cell, text, value, oldValue, row }) => ({ cell, text, value, oldValue, row })),
                source
            );
            rejected += settled.rejected;
        }

        return { written: applied.length, rejected };
    }

    /**
     * A committed edit: with `rangeEdit`, the same value goes to the other rows of a multi-row range in
     * that column; `propagateWrite` adds sibling writes. All of it persists as one batch.
     */
    #editCommitted(event: { cell: CellPosition; row: DataRow<TData>; oldValue: unknown; newValue: unknown }): void {
        const column = this.columns.getResolved(event.cell.colId);
        const writes: CellWriteRequest<TData>[] = [
            { cell: event.cell, value: event.newValue, oldValue: event.oldValue, text: '', row: event.row },
        ];
        const extra: { cell: CellPosition; value: unknown; derived: 'range' | 'sibling' }[] = [];
        if (this.#options.rangeEdit && column) {
            const range = this.#copyRanges().find(
                (candidate) =>
                    candidate.rowIds.length > 1 &&
                    candidate.rowIds.includes(event.cell.rowId) &&
                    candidate.colIds.includes(event.cell.colId)
            );
            for (const rowId of range?.rowIds ?? []) {
                if (rowId !== event.cell.rowId) {
                    extra.push({ cell: { rowId, colId: event.cell.colId }, value: event.newValue, derived: 'range' });
                }
            }
        }
        if (this.#options.propagateWrite) {
            const derived = this.#options.propagateWrite(event, {
                forEachRow: (visit) =>
                    this.#model.forEachRow((row) => {
                        if (row.kind === 'data') {
                            visit(row as DataRow<TData>);
                        }
                    }),
            });
            extra.push(...derived.map((write) => ({ ...write, derived: 'sibling' as const })));
        }
        for (const write of extra) {
            const row = this.#model.getRow(write.cell.rowId);
            const target = this.columns.getResolved(write.cell.colId);
            if (!row || row.kind !== 'data' || !target?.setValue) {
                continue;
            }
            if (!target.isEditable(row) || !(this.#options.canWrite?.(write.cell, row) ?? true)) {
                continue;
            }
            const oldValue = target.getValue(row);
            if (Object.is(oldValue, write.value) || !target.setValue(row as DataRow<TData>, write.value)) {
                continue;
            }
            const value = target.getValue(row);
            this.#clearCellError(write.cell);
            writes.push({
                cell: write.cell,
                value,
                oldValue,
                text: '',
                row: row as DataRow<TData>,
                derived: write.derived,
            });
            this.events.emit('cellValueChanged', { cell: write.cell, row, oldValue, newValue: value, source: 'edit' });
        }
        if (extra.length > 0) {
            this.#model.markDataChanged();
            this.#rowsChanged('data');
            this.#notify();
        }
        void this.#persist(writes, 'edit');
    }

    /**
     * Writes cells from code as one batch (bulk actions): local first, then persisted like any other write.
     * Cells that are not editable, that `canWrite` refuses, or whose value is unchanged are skipped.
     */
    async writeCells(
        cells: readonly { cell: CellPosition; value: unknown }[]
    ): Promise<{ written: number; rejected: number }> {
        const writes: CellWriteRequest<TData>[] = [];
        for (const { cell, value } of cells) {
            const row = this.#model.getRow(cell.rowId);
            const column = this.columns.getResolved(cell.colId);
            if (!row || row.kind !== 'data' || !column?.setValue) {
                continue;
            }
            if (!column.isEditable(row) || !(this.#options.canWrite?.(cell, row) ?? true)) {
                continue;
            }
            const oldValue = column.getValue(row);
            if (Object.is(oldValue, value) || !column.setValue(row as DataRow<TData>, value)) {
                continue;
            }
            const next = column.getValue(row);
            this.#clearCellError(cell);
            writes.push({ cell, value: next, oldValue, text: '', row: row as DataRow<TData> });
            this.events.emit('cellValueChanged', { cell, row, oldValue, newValue: next, source: 'api' });
        }
        if (writes.length === 0) {
            return { written: 0, rejected: 0 };
        }
        this.#model.markDataChanged();
        this.#rowsChanged('data');
        this.#notify();
        const settled = await this.#persist(writes, 'api');

        return { written: writes.length, rejected: settled.rejected };
    }

    /** Whether a write to the cell is waiting for `persist`. */
    isCellPending(cell: CellPosition): boolean {
        return this.#writes.isPending(cell);
    }

    /** Changes when cells start or stop waiting for `persist`. */
    get pendingVersion(): number {
        return this.#pendingVersion;
    }

    /**
     * Persists writes already applied locally, then settles them: rejected cells roll back (only while the
     * write is the newest for its cell and still showing) and show their error; returned rows replace local
     * rows unless a newer write to the row is pending. Without `persist`, writes simply stand.
     */
    async #persist(writes: CellWriteRequest<TData>[], source: WriteSource): Promise<{ rejected: number }> {
        const persist = this.#options.persist;
        if (!persist || writes.length === 0) {
            return { rejected: 0 };
        }
        const ops = writes.map((write) => this.#writes.begin(write.cell, write.oldValue, write.value));
        this.#pendingVersion++;
        this.#notify();
        let result: WriteResult<TData> | void = undefined;
        let failure: string | null = null;
        try {
            result = await persist({ source, writes });
        } catch (error) {
            failure = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Saving failed.';
        }
        if (this.#isDestroyed) {
            return { rejected: 0 };
        }
        const rejectedByCell = new Map<string, string>();
        for (const rejection of result?.rejected ?? []) {
            rejectedByCell.set(cellKey(rejection.cell), rejection.error);
        }
        // Server rows, matched to loaded rows (grouped rows need their parent context).
        const contexts = [
            { parentId: null, level: 0 },
            ...writes.map((write) => ({ parentId: write.row.parentId, level: write.row.level })),
        ];
        const serverRows = new Map<RowId, TData>();
        if (!failure) {
            for (const data of result?.rows ?? []) {
                const id = this.#rowIdOf(data, contexts);
                if (id !== null && this.#model.getRow(id)) {
                    serverRows.set(id, data);
                }
            }
        }
        const rejected: { cell: CellPosition; error: string }[] = [];
        let changed = false;
        writes.forEach((write, index) => {
            const error = failure ?? rejectedByCell.get(cellKey(write.cell));
            const id = ops[index]!;
            const column = this.columns.getResolved(write.cell.colId);
            if (error === undefined) {
                // What the server kept is the baseline a later rollback returns to.
                const serverData = serverRows.get(write.cell.rowId);
                const kept =
                    serverData !== undefined && column
                        ? { value: column.getValue({ ...write.row, data: serverData }) }
                        : undefined;
                if (this.#writes.succeed(write.cell, id, kept)) {
                    this.#clearCellError(write.cell);
                }

                return;
            }
            rejected.push({ cell: write.cell, error });
            const row = this.#model.getRow(write.cell.rowId);
            const outcome = this.#writes.fail(write.cell, id, (value) =>
                Boolean(row && hasData(row) && column && Object.is(column.getValue(row), value))
            );
            if (outcome.restore && row && row.kind === 'data' && column?.setValue) {
                column.setValue(row as DataRow<TData>, outcome.restore.value);
                changed = true;
            }
            // A newer write decides the cell; a superseded failure leaves no mark on it.
            if (!outcome.superseded) {
                this.#cellErrorsVersion++;
                this.#cellErrors.set(cellKey(write.cell), error);
            }
        });
        // Server rows: the newest operation on a row owns reconciliation.
        const reconciledRowIds: RowId[] = [];
        const newest = Math.max(...ops);
        const updates: { id: RowId; data: TData }[] = [];
        for (const [id, data] of serverRows) {
            if (!this.#writes.hasNewerOnRow(id, newest)) {
                updates.push({ id, data });
                reconciledRowIds.push(id);
            }
        }
        if (updates.length > 0) {
            this.#model.patchRows(updates);
            changed = true;
        }
        this.#pendingVersion++;
        if (changed) {
            this.#model.markDataChanged();
            this.#rowsChanged('data');
        }
        this.#notify();
        this.events.emit('writesSettled', {
            source,
            written: writes.length - rejected.length,
            rejected,
            reconciledRowIds,
        });

        return { rejected: rejected.length };
    }

    /** A new local write replaces a cell's old error, as an edit does. */
    #clearCellError(cell: CellPosition): void {
        if (this.#cellErrors.delete(cellKey(cell))) {
            this.#cellErrorsVersion++;
        }
    }

    /** The id of a loaded row a server row stands for, trying the contexts rows of the batch live in. */
    #rowIdOf(data: TData, contexts: { parentId: RowId | null; level: number }[]): RowId | null {
        const getRowId = this.#options.getRowId ?? this.#options.serverSource?.getRowId;
        if (!getRowId) {
            const id = (data as { id?: unknown }).id;

            return id === undefined || id === null ? null : String(id);
        }
        for (const context of contexts) {
            const id = String(getRowId(data, context));
            if (this.#model.getRow(id)) {
                return id;
            }
        }

        return null;
    }

    /** A column holds numbers when its loaded values do; null cells of a number column parse pasted text as numbers. */
    #isNumericColumn(column: ResolvedColumn<TData>): boolean {
        let numbers = 0;
        let others = 0;
        const rows: GridRow<TData>[] = [];
        this.#model.forEachRow((row) => {
            if (rows.length < 200) {
                rows.push(row);
            }
        });
        for (const row of rows) {
            if (!hasData(row)) {
                continue;
            }
            const value = column.getValue(row);
            if (typeof value === 'number') {
                numbers++;
            } else if (value !== null && value !== undefined && value !== '') {
                others++;
            }
            if (numbers + others >= 50) {
                break;
            }
        }

        return numbers > 0 && others === 0;
    }

    #writeCell(
        write: CellWrite,
        parseText?: GridStoreOptions<TData>['clipboardParse']
    ):
        | { value: unknown; oldValue: unknown; row: DataRow<TData>; column: ResolvedColumn<TData> }
        | { error: string }
        | null {
        const row = this.#model.getRow(write.cell.rowId);
        const column = this.columns.getResolved(write.cell.colId);
        if (!row || row.kind !== 'data' || !hasData(row) || !column?.setValue) {
            return null;
        }
        const parsed =
            parseText?.(write.text, { cell: write.cell, row }) ??
            parseCellText(column, row as DataRow<TData>, write.text, this.#isNumericColumn(column));
        if (!parsed.ok) {
            return { error: parsed.error };
        }
        const oldValue = column.getValue(row);
        if (Object.is(oldValue, parsed.value)) {
            return null;
        }
        column.setValue(row as DataRow<TData>, parsed.value);
        this.#cellErrorsVersion++;
        this.#cellErrors.delete(cellKey(write.cell));

        return { value: column.getValue(row), oldValue, row: row as DataRow<TData>, column };
    }

    // Editing

    /** Starts editing; synchronous unless an earlier edit has to finish an async commit first. */
    startEditing(cell: CellPosition, options: { startKey?: string | null } = {}): boolean | Promise<boolean> {
        if (!this.editing.canEdit(cell)) {
            return false;
        }
        this.focusCell(cell);

        return this.editing.start(cell, options);
    }

    /**
     * Ends the edit; with a key reason, moves focus as the editor's key policy says (Tab also opens the next
     * editable cell). Synchronous unless the editor validates asynchronously.
     */
    stopEditing(commit: boolean, reason: EditStopReason, then?: NavigationKey): boolean | Promise<boolean> {
        if (!this.editing.session) {
            return true;
        }
        const after = (stopped: boolean): boolean | Promise<boolean> => {
            if (!stopped) {
                return false;
            }
            this.#model.markDataChanged();
            this.#rowsChanged('data');
            let started: boolean | Promise<boolean> = true;
            if (then) {
                const next = this.navigate(then);
                if (reason === 'tab' && next && this.editing.canEdit(next)) {
                    started = this.editing.start(next);
                }
            }
            this.#notify();

            return started instanceof Promise ? started.then(() => true) : true;
        };
        const stopped = this.editing.stop(commit, reason);

        return stopped instanceof Promise ? stopped.then(after) : after(stopped);
    }

    get editSession(): EditSession | null {
        return this.editing.session;
    }

    // Menus

    get menu(): MenuState | null {
        return this.#menu;
    }

    /** Opens a context or header menu. Returns false when there is nothing to show. */
    openMenu(
        kind: MenuKind,
        target: { rowId: string | null; colId: string | null },
        anchor: AnchorRect,
        api: ContextMenuParams<TData>['api'],
        trigger: 'pointer' | 'keyboard' = 'pointer'
    ): boolean {
        const row = target.rowId ? (this.#model.getRow(target.rowId) ?? null) : null;
        const column = target.colId ? (this.columns.getResolved(target.colId) ?? null) : null;
        if (kind === 'context' && target.rowId && target.colId && target.colId !== FULL_WIDTH_COLUMN) {
            const cell = { rowId: target.rowId, colId: target.colId };
            const inRange = this.rangeEdges(cell.rowId, cell.colId) !== null;
            if (!inRange) {
                this.focusCell(cell);
                if (this.#ranges.length > 0) {
                    this.setRanges([], 'user');
                }
            }
        }
        const params: ContextMenuParams<TData> = {
            row,
            column,
            withinSelection: target.rowId ? this.isRowSelected(target.rowId) : false,
            api,
        };
        const items =
            kind === 'header'
                ? (this.#options.getHeaderMenuItems?.(params) ?? [...DEFAULT_HEADER_MENU])
                : (this.#options.getContextMenuItems?.(params) ??
                  (this.#options.enableRanges ? [...DEFAULT_CONTEXT_MENU] : []));
        const headerColId = kind === 'header' ? target.colId : null;
        this.#menu = openMenu({
            kind,
            target,
            anchor,
            items,
            availability: {
                canCopy: this.#copyRanges().length > 0,
                canPaste: this.canPaste(),
                canCut: this.canCut(),
                mac: this.#options.mac ?? false,
                ...(headerColId && column
                    ? {
                          sortable: column.def.sortable !== false,
                          sort: this.columns.getSortModel().find((item) => item.colId === headerColId)?.sort ?? null,
                          filterable: this.filterKindOf(headerColId) !== null,
                          filtered: headerColId in this.query.filterModel,
                      }
                    : {}),
            },
            trigger,
        });
        this.#notify();

        return this.#menu !== null;
    }

    closeMenu(): void {
        if (this.#menu) {
            this.#menu = null;
            this.#notify();
        }
    }

    // Filter panel

    /** The column whose filter panel is open, and where to anchor it. */
    get filterPanel(): { colId: string; anchor: AnchorRect } | null {
        return this.#filterPanel;
    }

    /**
     * A column's filter kind when the filter panel has an editor for it, otherwise null. `filter` names the
     * kind; `true` means text.
     */
    filterKindOf(colId: string): string | null {
        const filter = this.columns.getResolved(colId)?.def.filter as string | boolean | undefined;
        const kind = filter === true ? 'text' : typeof filter === 'string' ? filter : null;
        const kinds = this.#options.filterEditorKinds ?? BUILTIN_FILTER_EDITOR_KINDS;

        return kind !== null && kinds.includes(kind) ? kind : null;
    }

    openFilterPanel(colId: string, anchor: AnchorRect): void {
        if (this.filterKindOf(colId) === null) {
            return;
        }
        this.#menu = null;
        this.#filterPanel = { colId, anchor };
        this.#notify();
    }

    closeFilterPanel(): void {
        if (this.#filterPanel) {
            this.#filterPanel = null;
            this.#notify();
        }
    }

    /**
     * The distinct values of a column over all local rows (filters ignored), as set choices: key and
     * formatted label, blanks as one null choice first, then sorted by label. Empty for server rows.
     */
    distinctValues(colId: string): { value: string | null; label: string }[] {
        const column = this.columns.getResolved(colId);
        if (!column || this.#model.kind !== 'local') {
            return [];
        }
        const keyCreator = typeof column.def.keyCreator === 'function' ? column.def.keyCreator : null;
        const choices = new Map<string | null, string>();
        for (const data of this.#options.rows) {
            const row = { kind: 'data', id: '', section: 'body', level: 0, parentId: null, data } as RowWithData<TData>;
            const value = column.getValue(row);
            const key = keyCreator ? keyCreator({ row, data, column, context: undefined, value }) : defaultKey(value);
            if (!choices.has(key)) {
                choices.set(key, key === null ? '(Blank)' : column.formatValue(row, value) || key);
            }
        }
        const blank = choices.has(null) ? [{ value: null, label: choices.get(null)! }] : [];
        const rest = [...choices]
            .filter(([key]) => key !== null)
            .map(([value, label]) => ({ value, label }))
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

        return [...blank, ...rest];
    }

    // Overlays

    /**
     * What the grid shows over the body: a forced overlay, else the row model's status. A first server load
     * shows loading rows rather than an overlay.
     */
    get overlay(): GridOverlay {
        if (this.#overlay) {
            return this.#overlay === 'loading' ? { kind: 'loading' } : { kind: 'empty', reason: 'noResults' };
        }
        const status = this.#model.status;
        if (status.state === 'empty') {
            return { kind: 'empty', reason: status.reason };
        }
        if (status.state === 'error') {
            return { kind: 'error', error: status.error };
        }

        return this.#model.kind === 'local' && this.#model.getRowCount() === 0
            ? { kind: 'empty', reason: 'noResults' }
            : null;
    }

    // Pagination

    getPagination(): Pagination | null {
        return this.#model.getPagination();
    }

    setPage(page: number, source: ChangeSource = 'api'): void {
        const before = this.#model.getPagination()?.page;
        this.#model.setPage(page);
        const after = this.#model.getPagination()?.page;
        if (after !== undefined && after !== before) {
            this.events.emit('pageChanged', { page: after, source });
        }
    }

    /** Server models refetch; local models re-run sorting, filtering and grouping. */
    refresh(options: { route?: (string | null)[]; purge?: boolean } = {}): void {
        this.#model.refresh(options);
    }

    setOverlay(overlay: 'loading' | 'empty' | null): void {
        this.#overlay = overlay;
        this.#notify();
    }

    destroy(): void {
        this.#isDestroyed = true;
        this.#model.destroy();
        this.editing.destroy();
        this.events.emit('destroyed', {});
        this.events.destroy();
        this.#listeners.clear();
    }

    // Internals

    #groupColumnColId(): string {
        return this.#options.groupColumn?.colId ?? GROUP_COLUMN_ID;
    }

    #wantsGroupColumn(): boolean {
        if ((this.#options.groupDisplay ?? 'column') !== 'column') {
            return false;
        }

        return (
            Boolean(this.#options.getDataPath) ||
            Boolean(this.#options.isMaster) ||
            Boolean(this.#options.serverSource?.getTreeKey) ||
            this.columns.getRowGroupColumnIds().length > 0
        );
    }

    #definitionsWithGroupColumn(): ColumnDefinition<TData>[] {
        // The hierarchy reads first: when columns are pinned left, the group column joins them.
        const pinnedLeft = this.columns
            .getColumnState()
            .some((state) => state.pinned === 'left' && state.colId !== this.#groupColumnColId());
        const groupColumn: ColumnDef<TData> = {
            headerName: 'Group',
            ...(pinnedLeft ? { pinned: 'left' as const } : {}),
            width: 240,
            minWidth: 120,
            sortable: false,
            filter: false,
            editable: false,
            ...this.#options.groupColumn,
            colId: this.#groupColumnColId(),
        };

        return [groupColumn, ...this.#baseDefinitions];
    }

    /** Adds or removes the generated group column when grouping, tree data or the display mode change. */
    #syncGroupColumn(source: ChangeSource): void {
        const colId = this.#groupColumnColId();
        const wanted = this.#wantsGroupColumn();
        if (wanted === Boolean(this.columns.getLeaf(colId))) {
            return;
        }
        this.columns.setDefinitions(wanted ? this.#definitionsWithGroupColumn() : this.#baseDefinitions);
        this.#columnsChanged('definitions', [colId], source);
    }

    #resolveDefinitions(
        definitions: ColumnDefinition<TData>[],
        registry: GridRegistry<TData> | undefined
    ): ColumnDefinition<TData>[] {
        const resolver = createResolver(mergeRegistries(BUILTIN_REGISTRY as GridRegistry<TData>, registry), {
            ...(this.#options.onUnresolvedKey ? { onUnresolved: this.#options.onUnresolvedKey } : {}),
            ...(this.#options.strictRegistry ? { strict: true } : {}),
        });
        const result = resolveColumnRefs(definitions, resolver);
        this.#misses = result.misses;

        return result.columns;
    }

    #modelOptions(options: GridStoreOptions<TData>) {
        return {
            rows: options.rows,
            ...(options.getRowId ? { getRowId: options.getRowId } : {}),
            ...(options.getDataPath ? { getDataPath: options.getDataPath } : {}),
            ...(options.sortRows ? { sortRows: options.sortRows } : {}),
            ...(options.isMaster ? { isMaster: options.isMaster } : {}),
            ...(options.isFullWidthRow ? { isFullWidthRow: options.isFullWidthRow } : {}),
            ...(options.expandedByDefault !== undefined ? { expandedByDefault: options.expandedByDefault } : {}),
            ...(options.quickFilter ? { quickFilter: options.quickFilter } : {}),
            ...(options.registry?.filters
                ? { filterKinds: options.registry.filters as Record<string, FilterKind<TData>> }
                : {}),
            onUnknownFilterKind: (miss: { filterType: string; colId: string }) => {
                // Reported once per kind, through the same channel as unresolved registry keys.
                if (!this.#unknownFilterKinds.has(miss.filterType)) {
                    this.#unknownFilterKinds.add(miss.filterType);
                    this.#options.onUnresolvedKey?.({ kind: 'filters', key: miss.filterType, colId: miss.colId });
                }
            },
        };
    }

    #queryChanged(previous: QueryState, source: ChangeSource): void {
        const query = this.query;
        this.#lastQuery = query;
        this.events.emit('queryChanged', { query, previous, source });
        this.events.emit('viewStateChanged', { reason: 'query', source });
        this.#model.setQuery(query);
        this.#notify();
    }

    /** The row model rebuilt its rows: everything that depends on displayed rows follows. */
    #modelChanged(change: RowsChangeSource): void {
        const source: ChangeSource = change === 'expand' ? 'user' : change === 'query' ? 'state' : 'data';
        // Rows changed under an open fill drag (refresh, sort, filter): the drag ends without filling.
        this.#fillDrag = null;
        this.#rowsChanged(source);
        this.editing.rowsChanged();
        this.#recoverFocus();
        if (this.#activeRowId && !this.#model.getRow(this.#activeRowId)) {
            this.setActiveRow(null, source);
        }
        this.#notify();
    }

    #rowsChanged(source: ChangeSource): void {
        this.#snapshot = null;
        this.#resolvedRanges = null;
        this.#rowsVersion++;
        this.events.emit('rowsChanged', { version: this.#rowsVersion, source });
    }

    #sortChanged(source: ChangeSource): void {
        this.events.emit('sortChanged', { sortModel: this.columns.getSortModel(), source });
        this.#columnsChanged(
            'sorted',
            this.columns.getSortModel().map((item) => item.colId),
            source
        );
        this.#notify();
    }

    /**
     * Sort and row groups live in the column model, so column changes (sorting, grouping, applied column
     * state) can change the query. This reports and applies such a change once.
     */
    #syncQuery(source: ChangeSource): void {
        const previous = this.#lastQuery;
        if (previous && JSON.stringify(previous) !== JSON.stringify(this.query)) {
            this.#queryChanged(previous, source);
        }
    }

    #columnsChanged(
        kind: GridEventMap<TData>['columnStateChanged']['kind'],
        colIds: string[],
        source: ChangeSource,
        finished = true
    ): void {
        this.#snapshot = null;
        this.#resolvedRanges = null;
        this.#columnsVersion++;
        // The fill handle fills the columns it started on; any column change ends the drag without filling.
        if (this.#fillDrag && kind !== 'resized') {
            this.#fillDrag = null;
        }
        // The model is created after the first column change (inside the constructor).
        if (this.#model && kind !== 'resized') {
            this.#model.setColumnState(this.columns.getColumnState());
            this.#syncQuery(source);
            if (kind !== 'definitions') {
                this.#syncGroupColumn(source);
            }
            if (
                (kind === 'visible' || kind === 'definitions') &&
                !(this.#model instanceof ServerRowModel) &&
                this.#model.isFiltered
            ) {
                // The local quick filter searches displayed columns only. A server filters on its own columns,
                // so showing or hiding one never refetches.
                this.#model.refresh();
            }
        }
        this.events.emit('columnStateChanged', {
            columnState: this.columns.getColumnState(),
            colIds,
            kind,
            finished,
            source,
        });
        // Sort and row groups report through the query; a resize only once it finishes.
        if (finished && kind !== 'sorted' && kind !== 'rowGroup') {
            this.events.emit('viewStateChanged', { reason: 'columns', source });
        }
        if (kind !== 'resized' && kind !== 'sorted') {
            this.#recoverFocus();
        }
    }

    #rememberFocusPosition(): void {
        const cell = this.#focused;
        if (!cell) {
            this.#focusedAt = null;

            return;
        }
        const index = this.snapshot.indexOf(cell.rowId);
        const columnIndex =
            cell.colId === FULL_WIDTH_COLUMN
                ? (this.#focusedAt?.columnIndex ?? 0)
                : this.snapshot.columnIndexOf(cell.colId);
        if (index !== undefined && columnIndex !== undefined) {
            this.#focusedAt = { index, columnIndex };
        }
    }

    #recoverFocus(): void {
        if (!this.#focused || !this.#focusedAt) {
            return;
        }
        const recovered = recoverFocus(this.snapshot, { cell: this.#focused, ...this.#focusedAt });
        if (!sameCell(recovered, this.#focused)) {
            this.#focused = recovered;
            this.events.emit('focusChanged', { cell: recovered, source: 'data' });
        }
        this.#rememberFocusPosition();
    }

    #isSelectable(row: GridRow<TData>): boolean {
        return row.kind === 'data' && (this.#options.isRowSelectable?.(row) ?? true);
    }

    #notify(): void {
        this.#version++;
        for (const listener of [...this.#listeners]) {
            listener();
        }
    }
}

/** Text to value for paste, fill and clear: the editor's synchronous parse, numbers for number columns, text otherwise. */
export function parseCellText<TData>(
    column: ResolvedColumn<TData>,
    row: DataRow<TData>,
    text: string,
    numericColumn = false
): { ok: true; value: unknown } | { ok: false; error: string } {
    const parse = column.editor?.parse;
    if (parse) {
        const result = parse(text, { row, column });
        if (!(result instanceof Promise)) {
            return result;
        }
    }
    const current = column.getValue(row);
    const numeric = numericColumn || typeof current === 'number';
    if (numeric) {
        if (text.trim() === '') {
            return { ok: true, value: null };
        }
        const value = Number(text.replace(/[,\s]/g, ''));

        return Number.isFinite(value) ? { ok: true, value } : { ok: false, error: `"${text}" is not a number.` };
    }

    return { ok: true, value: text === '' && (current === null || current === undefined) ? current : text };
}

function sameCell(a: CellPosition | null, b: CellPosition | null): boolean {
    return a === b || (a !== null && b !== null && a.rowId === b.rowId && a.colId === b.colId);
}

function cellKey(cell: CellPosition): string {
    return `${cell.rowId}\u0000${cell.colId}`;
}
