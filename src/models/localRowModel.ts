/**
 * The local row model: rows held in memory, with sorting, filtering, quick filter, grouping or tree data,
 * expansion, transactions and pinned rows, all computed in the browser.
 *
 * Rows given through `setOptions({ rows })` are the source of truth: a new array replaces the model's rows,
 * including changes made by transactions since (the form-value pattern: the parent owns the data). Without a
 * new array, `applyTransaction` and `patchRows` change the model's own copy (the transaction pattern).
 * Row objects are reused when their data did not change, so renderers can skip work by identity.
 *
 * Every read answers from model state; nothing here touches the DOM.
 */
import type {
    ColumnState,
    DataRow,
    DisplayedRow,
    FilterKind,
    FilterModel,
    GetDataPath,
    GetRowId,
    GridRow,
    QueryState,
    ResolvedColumn,
    RowId,
    RowModelStatus,
    RowTransaction,
    RowWithData,
    SortModel,
} from '../contract';
import { createFilterPredicate } from '../filters/evaluate';
import { defaultGetRowId } from '../rows/getRowId';
import type { GroupKey } from '../rows/ids';
import { buildLocalProjection, type DefaultExpanded, type LocalProjection } from '../rows/localProjection';
import { buildPinnedRows } from '../rows/pinned';
import type { GridRowModel, Pagination, RowsChangeSource } from './rowModel';

export type { RowsChangeSource } from './rowModel';
import type { RowSource } from '../virtual/verticalLayout';

/** What the model needs to know about columns: value access for sorting, filtering and quick filter. */
export type LocalRowModelColumns<TData> = {
    getResolved(colId: string): ResolvedColumn<TData> | undefined;
    /** Columns the quick filter searches: the displayed ones. */
    displayedColIds(): readonly string[];
};

export type LocalRowModelOptions<TData> = {
    rows: readonly TData[];
    getRowId?: GetRowId<TData>;
    getDataPath?: GetDataPath<TData>;
    /** Runs after sorting with the filtered rows; must return the same rows, reordered (pinned-first orders). */
    sortRows?: (rows: readonly TData[]) => readonly TData[];
    isMaster?: (data: TData) => boolean;
    isFullWidthRow?: (row: GridRow<TData>) => boolean;
    expandedByDefault?: DefaultExpanded<TData>;
    quickFilter?: string;
    filterKinds?: Readonly<Record<string, FilterKind<TData>>>;
    onUnknownFilterKind?: (miss: { filterType: string; colId: string }) => void;
};

const EMPTY_QUERY: QueryState = { sortModel: [], filterModel: {}, search: '', externalFilters: {}, rowGroupColIds: [] };

export class LocalRowModel<TData> implements GridRowModel<TData> {
    readonly kind = 'local' as const;

    #options: LocalRowModelOptions<TData>;
    #rows: TData[];
    #query: QueryState = EMPTY_QUERY;
    #groupColIds: string[] = [];
    #expansion = new Map<RowId, boolean>();
    #projection: LocalProjection<TData>;
    #pinned: { top: GridRow<TData>[]; bottom: GridRow<TData>[] } = { top: [], bottom: [] };
    #version = 0;
    #filtered = false;
    #source: RowSource<TData> | null = null;
    #searchText = new WeakMap<object, string>();
    #searchColumnsKey = '';

    constructor(
        options: LocalRowModelOptions<TData>,
        private readonly columns: LocalRowModelColumns<TData>,
        private readonly onChange: (source: RowsChangeSource) => void = () => {}
    ) {
        this.#options = options;
        this.#rows = [...options.rows];
        this.#projection = this.#build();
    }

    // Read side

    get version(): number {
        return this.#version;
    }

    get status(): RowModelStatus {
        return this.#projection.getRowCount() === 0 ? { state: 'empty', reason: 'noResults' } : { state: 'ready' };
    }

    /** Whether a filter, quick filter or search currently hides rows. */
    get isFiltered(): boolean {
        return this.#filtered;
    }

    get projection(): LocalProjection<TData> {
        return this.#projection;
    }

    /** The current rows in source order, including transaction changes. */
    get rows(): readonly TData[] {
        return this.#rows;
    }

    /** The layout's view of the displayed rows. A new object after every change. */
    get rowSource(): RowSource<TData> {
        if (!this.#source) {
            const projection = this.#projection;
            this.#source = {
                count: projection.getRowCount(),
                rowAt: (index) => projection.getRowAtIndex(index)?.row,
                indexOf: (id) => projection.getIndexOf(id),
                forEachKnown: (callback) => projection.forEachRow((row, index) => callback(row, index!)),
            };
        }

        return this.#source;
    }

    getRowCount(): number {
        return this.#projection.getRowCount();
    }

    getRowAtIndex(index: number): DisplayedRow<TData> | undefined {
        return this.#projection.getRowAtIndex(index);
    }

    getRow(id: RowId): GridRow<TData> | undefined {
        return (
            this.#projection.getRow(id) ??
            this.#pinned.top.find((row) => row.id === id) ??
            this.#pinned.bottom.find((row) => row.id === id)
        );
    }

    getIndexOf(id: RowId): number | undefined {
        return this.#projection.getIndexOf(id);
    }

    forEachRow(
        callback: (row: GridRow<TData>, index: number | undefined) => void,
        options: { includeCollapsed?: boolean; includeFiltered?: boolean } = {}
    ): void {
        if (!options.includeFiltered || !this.#filtered) {
            this.#projection.forEachRow(callback, options.includeCollapsed ? { includeCollapsed: true } : undefined);

            return;
        }
        // Rows the filter hides are visited too, with index undefined, in source order after the displayed ones.
        // Rows below collapsed groups stay out unless `includeCollapsed` asks for them.
        const inProjection = new Set<RowId>();
        this.#projection.forEachRow(
            (row, index) => {
                inProjection.add(row.id);
                if (index !== undefined || options.includeCollapsed) {
                    callback(row, index);
                }
            },
            { includeCollapsed: true }
        );
        const resolve = (this.#options.getRowId ?? defaultGetRowId) as GetRowId<TData>;
        for (const data of this.#rows) {
            const id = resolve(data, { parentId: null, level: 0 });
            if (!inProjection.has(id)) {
                callback({ kind: 'data', id, level: 0, parentId: null, data } as DataRow<TData>, undefined);
            }
        }
    }

    getPinnedRows(section: 'top' | 'bottom'): readonly GridRow<TData>[] {
        return this.#pinned[section];
    }

    get expandedIds(): ReadonlySet<RowId> {
        return this.#projection.expandedIds;
    }

    isExpanded(id: RowId): boolean {
        return this.#projection.expandedIds.has(id);
    }

    /** Local grids show every row; pagination is a server feature here. */
    getPagination(): Pagination | null {
        return null;
    }

    setPage(): void {}

    destroy(): void {}

    // Write side

    /** New options. A new `rows` array replaces the model's rows. Returns whether the rows changed. */
    setOptions(next: LocalRowModelOptions<TData>): boolean {
        const previous = this.#options;
        this.#options = next;
        const dataChanged =
            next.rows !== previous.rows ||
            next.getRowId !== previous.getRowId ||
            next.getDataPath !== previous.getDataPath ||
            next.sortRows !== previous.sortRows ||
            next.isMaster !== previous.isMaster ||
            next.isFullWidthRow !== previous.isFullWidthRow ||
            next.expandedByDefault !== previous.expandedByDefault;
        const filterChanged = next.quickFilter !== previous.quickFilter || next.filterKinds !== previous.filterKinds;
        if (next.rows !== previous.rows) {
            this.#rows = [...next.rows];
        }
        if (dataChanged) {
            this.#rebuild('data');
        } else if (filterChanged) {
            // Same data: the cached search text stays valid, so typing in a quick filter stays fast.
            this.#rebuild('query');
        }

        return dataChanged || filterChanged;
    }

    setQuery(query: QueryState): void {
        const previous = this.#query;
        this.#query = query;
        if (
            !sameJson(previous.sortModel, query.sortModel) ||
            !sameJson(previous.filterModel, query.filterModel) ||
            previous.search !== query.search
        ) {
            this.#rebuild('query');
        }
    }

    /** Row grouping follows the column state's `rowGroup` columns. */
    setColumnState(columnState: ColumnState[]): void {
        const groupColIds = columnState
            .filter((entry) => entry.rowGroup)
            .sort((a, b) => (a.rowGroupIndex ?? 0) - (b.rowGroupIndex ?? 0))
            .map((entry) => entry.colId);
        if (groupColIds.join('\u0000') !== this.#groupColIds.join('\u0000')) {
            this.#groupColIds = groupColIds;
            this.#rebuild('query');
        }
    }

    setExpanded(id: RowId, expanded: boolean): void {
        if (this.#projection.expandedIds.has(id) === expanded && this.#expansion.get(id) === expanded) {
            return;
        }
        this.#expansion.set(id, expanded);
        this.#rebuild('expand');
    }

    /**
     * Adds, updates and removes rows by id. Updates replace the data of rows with the same id (unknown ids
     * are ignored); removes drop rows by id; adds insert at `index` in source order, or append.
     */
    applyTransaction(transaction: RowTransaction<TData>): void {
        const resolve = (this.#options.getRowId ?? defaultGetRowId) as GetRowId<TData>;
        const idOf = (data: TData) => resolve(data, { parentId: null, level: 0 });
        let rows = this.#rows;
        if (transaction.remove?.length) {
            const removed = new Set(transaction.remove);
            rows = rows.filter((data) => !removed.has(idOf(data)));
        }
        if (transaction.update?.length) {
            const updates = new Map(transaction.update.map((data) => [idOf(data), data]));
            rows = rows.map((data) => updates.get(idOf(data)) ?? data);
        }
        if (transaction.add?.rows.length) {
            const index =
                transaction.add.index === undefined
                    ? rows.length
                    : Math.max(0, Math.min(transaction.add.index, rows.length));
            rows = [...rows.slice(0, index), ...transaction.add.rows, ...rows.slice(index)];
        }
        this.#rows = rows;
        this.#rebuild('transaction');
    }

    patchRows(updates: { id: RowId; data: TData }[]): void {
        if (updates.length === 0) {
            return;
        }
        const resolve = (this.#options.getRowId ?? defaultGetRowId) as GetRowId<TData>;
        const byId = new Map(updates.map((update) => [update.id, update.data]));
        this.#rows = this.#rows.map((data) => byId.get(resolve(data, { parentId: null, level: 0 })) ?? data);
        this.#rebuild('patch');
    }

    /** Re-runs sorting, filtering and grouping, for data changed in place (cell edits, `refreshCells`). */
    refresh(): void {
        this.#rebuild('refresh');
    }

    /** Local rows are always loaded. */
    ensureRange(): void {}

    setPinnedRows(section: 'top' | 'bottom', rows: readonly TData[]): void {
        this.#pinned = {
            ...this.#pinned,
            [section]: buildPinnedRows(section, rows, this.#options.getRowId, this.#pinned[section]),
        };
        this.#version++;
        this.#source = null;
        this.onChange('data');
    }

    // Internals

    /**
     * Rows changed in place (an edit, a paste, a fill): drops cached search text without rebuilding, so the
     * next quick filter reads the new values.
     */
    markDataChanged(): void {
        this.#searchText = new WeakMap();
    }

    /** The lower-cased text the quick filter searches for one row, cached while data and columns stay. */
    #searchTextOf(data: TData, row: RowWithData<TData>, columns: readonly ResolvedColumn<TData>[]): string {
        const cacheable = typeof data === 'object' && data !== null;
        if (cacheable) {
            const cached = this.#searchText.get(data as object);
            if (cached !== undefined) {
                return cached;
            }
        }
        const text = columns.map((column) => column.formatValue(row, column.getValue(row)).toLowerCase()).join('\n');
        if (cacheable) {
            this.#searchText.set(data as object, text);
        }

        return text;
    }

    #rebuild(source: RowsChangeSource): void {
        if (source !== 'query' && source !== 'expand') {
            // New or patched data, or a refresh after changes in place.
            this.#searchText = new WeakMap();
        }
        this.#projection = this.#build();
        this.#version++;
        this.#source = null;
        this.onChange(source);
    }

    #build(): LocalProjection<TData> {
        const options = this.#options;
        const rows = this.#sort(this.#filter(this.#rows));
        const ordered = options.sortRows ? options.sortRows(rows) : rows;
        const isFullWidthRow = options.isFullWidthRow;
        const grouping =
            !options.getDataPath && this.#groupColIds.length > 0
                ? { colIds: this.#groupColIds, getKey: (data: TData, colId: string) => this.#groupKey(data, colId) }
                : undefined;

        return buildLocalProjection<TData>({
            rows: ordered,
            ...(options.getRowId ? { getRowId: options.getRowId } : {}),
            ...(options.getDataPath ? { getDataPath: options.getDataPath } : {}),
            ...(grouping ? { grouping } : {}),
            expansion: this.#expansion,
            ...(options.expandedByDefault !== undefined ? { defaultExpanded: options.expandedByDefault } : {}),
            ...(options.isMaster ? { isMaster: options.isMaster } : {}),
            ...(isFullWidthRow ? { isFullWidth: (data: TData) => isFullWidthRow(asRow(data)) } : {}),
            // Absent on the first build, inside the constructor.
            ...(this.#projection ? { previous: this.#projection } : {}),
        });
    }

    #filter(rows: readonly TData[]): readonly TData[] {
        const predicate = createFilterPredicate<TData>(this.#query.filterModel as FilterModel, {
            column: (colId) => this.columns.getResolved(colId),
            ...(this.#options.filterKinds ? { kinds: this.#options.filterKinds } : {}),
            ...(this.#options.onUnknownFilterKind ? { onUnknownKind: this.#options.onUnknownFilterKind } : {}),
        });
        const words = [this.#options.quickFilter, this.#query.search]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
        this.#filtered = predicate !== null || words.length > 0;
        if (!this.#filtered) {
            return rows;
        }
        const columns = this.columns
            .displayedColIds()
            .map((colId) => this.columns.getResolved(colId))
            .filter((column): column is ResolvedColumn<TData> => column !== undefined);
        const columnsKey = columns.map((column) => column.colId).join('\u0000');
        if (columnsKey !== this.#searchColumnsKey) {
            this.#searchColumnsKey = columnsKey;
            this.#searchText = new WeakMap();
        }

        return rows.filter((data) => {
            const row = asRow(data);
            if (predicate && !predicate(row)) {
                return false;
            }
            if (words.length === 0) {
                return true;
            }
            // Quick filter: every word must appear in some displayed column's formatted value.
            const text = this.#searchTextOf(data, row, columns);

            return words.every((word) => text.includes(word));
        });
    }

    #sort(rows: readonly TData[]): readonly TData[] {
        const model: SortModel = this.#query.sortModel;
        if (model.length === 0) {
            return rows;
        }
        const sorters = model
            .map((item) => ({ column: this.columns.getResolved(item.colId), direction: item.sort === 'desc' ? -1 : 1 }))
            .filter(
                (sorter): sorter is { column: ResolvedColumn<TData>; direction: number } => sorter.column !== undefined
            );
        if (sorters.length === 0) {
            return rows;
        }
        const decorated = rows.map((data, index) => {
            const row = asRow(data);

            return { data, index, values: sorters.map((sorter) => sorter.column.getValue(row)) };
        });
        decorated.sort((a, b) => {
            for (let position = 0; position < sorters.length; position++) {
                const sorter = sorters[position]!;
                const valueA = a.values[position];
                const valueB = b.values[position];
                const emptyA = valueA === null || valueA === undefined || valueA === '';
                const emptyB = valueB === null || valueB === undefined || valueB === '';
                // Empty values stay last in both directions.
                if (emptyA !== emptyB) {
                    return emptyA ? 1 : -1;
                }
                const result = emptyA ? 0 : sorter.column.comparator(valueA, valueB);
                if (result !== 0) {
                    return result * sorter.direction;
                }
            }

            return a.index - b.index;
        });

        return decorated.map((item) => item.data);
    }

    #groupKey(data: TData, colId: string): GroupKey {
        const column = this.columns.getResolved(colId);
        if (!column) {
            return null;
        }
        const row = asRow(data);
        const value = column.getValue(row);
        if (value === null || value === undefined || value === '') {
            return null;
        }
        const keyCreator = column.def.keyCreator;
        if (typeof keyCreator === 'function') {
            return keyCreator({ row, data, column, context: undefined, value });
        }

        return column.formatValue(row, value) || String(value);
    }
}

/** A data row wrapper for value access on raw data (ids are not needed there). */
function asRow<TData>(data: TData): RowWithData<TData> {
    return { kind: 'data', id: '', level: 0, parentId: null, data } as DataRow<TData>;
}

function sameJson(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}
