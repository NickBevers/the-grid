/**
 * The server row model: rows arrive in blocks from a `ServerDataSource`, on demand, for the rows the
 * viewport shows. Built on `ServerProjection`, which places blocks, groups and placeholders.
 *
 * Requests:
 * - Only blocks covering the requested range that are neither loaded nor in flight are requested, at most
 *   `maxConcurrentRequests` at a time (two). A slot that frees takes the next block still
 *   wanted by the latest `ensureRange`, so fast scrolling never queues a storm of blocks no longer in view.
 * - A query change starts a new generation: in-flight requests are aborted (their `signal`), responses of
 *   older generations are dropped, rows are cleared, and the first block is requested.
 * - With `loadWithoutQuery: false`, nothing loads until the query has search text, a filter (an empty set
 *   filter does not count), an external filter or a group key; until then the status is
 *   `empty / noQuery`. A sort alone only reloads a grid that already shows rows (today's rule).
 * - Blocks beyond `maxBlocksInCache` per level are evicted least recently used first, never ones in view.
 * - `refresh({ purge: false })` keeps the current rows on screen and replaces each block as it reloads;
 *   `purge: true` clears first.
 *
 * Pagination (`pageSize`) pages over displayed rows; indexes in every read are page relative.
 */
import type {
    DataRow,
    DetailRow,
    DisplayedRow,
    FilterModel,
    GridRow,
    QueryState,
    ResolvedColumn,
    RowId,
    RowModelStatus,
    ServerDataSource,
    ServerRowsRequest,
} from '../contract';
import { detailRowId, type GroupKey } from '../rows/ids';
import { buildPinnedRows } from '../rows/pinned';
import { ServerProjection, type BlockAddress } from '../rows/serverProjection';
import type { RowSource } from '../virtual/verticalLayout';
import type { GridRowModel, Pagination, RowsChangeSource } from './rowModel';

export type ServerRowModelOptions<TData> = {
    source: ServerDataSource<TData>;
    /** Leaf event rows can open a local detail without requesting a remote child route. */
    isMaster?: (data: TData) => boolean;
    /** Column access, for the `rowGroupCols` the backend expects (`{ id, field, displayName }`). */
    column(colId: string): ResolvedColumn<TData> | undefined;
    /** Rows per page; null or undefined for continuous scrolling. */
    pageSize?: number | null;
    /** False pages root rows, keeping expanded descendants and local details on their parent's page. */
    paginateChildren?: boolean;
    /** Default 2. */
    maxConcurrentRequests?: number;
    onBlockLoaded?(event: { route: GroupKey[]; startRow: number; endRow: number }): void;
    onStatus?(status: RowModelStatus): void;
};

const EMPTY_QUERY: QueryState = { sortModel: [], filterModel: {}, search: '', externalFilters: {}, rowGroupColIds: [] };

type Request = { controller: AbortController; generation: number; address: BlockAddress };

export class ServerRowModel<TData> implements GridRowModel<TData> {
    readonly kind = 'server' as const;

    #options: ServerRowModelOptions<TData>;
    #projection: ServerProjection<TData>;
    #query: QueryState = EMPTY_QUERY;
    #initialised = false;
    #generation = 0;
    #requests = new Map<string, Request>();
    #wanted: BlockAddress[] = [];
    #visible = new Set<string>();
    #stale = new Set<string>();
    #failed = new Set<string>();
    /** Loaded blocks per level, with the tick they were last in view, for eviction. */
    #loaded = new Map<string, Map<number, number>>();
    #tick = 0;
    #status: RowModelStatus = { state: 'idle' };
    #populated = false;
    #page = 0;
    #version = 0;
    #source: RowSource<TData> | null = null;
    #pinned: { top: GridRow<TData>[]; bottom: GridRow<TData>[] } = { top: [], bottom: [] };
    #destroyed = false;
    #detailExpanded = new Set<RowId>();
    #masterRows = new WeakMap<DataRow<TData>, DataRow<TData>>();
    #detailsVersion = -1;
    #details: { baseIndex: number; index: number; row: DetailRow<TData> }[] | null = null;

    constructor(
        options: ServerRowModelOptions<TData>,
        private readonly onChange: (source: RowsChangeSource) => void = () => {}
    ) {
        this.#options = options;
        this.#projection = this.#createProjection([]);
    }

    // Read side

    get version(): number {
        return this.#version;
    }

    get status(): RowModelStatus {
        return this.#status;
    }

    get isFiltered(): boolean {
        return hasFilter(this.#query.filterModel) || this.#query.search.trim() !== '';
    }

    get blockSize(): number {
        return this.#projection.blockSize;
    }

    /** Requests in flight, for tests and diagnostics. */
    get pendingRequests(): number {
        return this.#requests.size;
    }

    get rowSource(): RowSource<TData> {
        if (!this.#source) {
            this.#source = {
                count: this.#displayCount(),
                rowAt: (index) => this.getRowAtIndex(index)?.row,
                indexOf: (id) => this.getIndexOf(id),
                forEachKnown: (callback) =>
                    this.forEachRow((row, index) => index !== undefined && callback(row, index)),
            };
        }

        return this.#source;
    }

    /** The known displayed count (page relative with pagination), or null while a count is unknown. */
    getRowCount(): number | null {
        const count = this.#projection.getRowCount();
        const known = count === null ? null : count + this.#detailRows().length;
        if (known === null) {
            return null;
        }

        if (this.#topLevelPagination) {
            return this.#displayCount();
        }

        return this.#pageSize ? Math.max(0, Math.min(this.#pageSize, known - this.#offset)) : known;
    }

    getRowAtIndex(index: number): DisplayedRow<TData> | undefined {
        if (index < 0 || index >= this.#displayCount()) {
            return undefined;
        }
        const absolute = index + this.#offset;
        const detail = this.#detailRows().find((entry) => entry.index === absolute);
        if (detail) {
            return { row: detail.row, index };
        }
        const displayed = this.#projection.getRowAtIndex(this.#baseIndex(absolute));

        return displayed ? { row: this.#withMaster(displayed.row), index } : undefined;
    }

    getRow(id: RowId): GridRow<TData> | undefined {
        const detail = this.#detailRows().find((entry) => entry.row.id === id)?.row;
        const row = this.#projection.getRow(id);

        return (
            detail ??
            (row ? this.#withMaster(row) : undefined) ??
            this.#pinned.top.find((entry) => entry.id === id) ??
            this.#pinned.bottom.find((entry) => entry.id === id)
        );
    }

    getIndexOf(id: RowId): number | undefined {
        const detailIndex = this.#detailRows().find((entry) => entry.row.id === id)?.index;
        const baseIndex = this.#projection.getIndexOf(id);
        const index = detailIndex ?? (baseIndex === undefined ? undefined : this.#displayIndex(baseIndex));
        if (index === undefined) {
            return undefined;
        }
        const relative = index - this.#offset;

        return relative >= 0 && relative < this.#displayCount() ? relative : undefined;
    }

    /** Loaded rows of displayed levels, in display order. Never requests anything. */
    forEachRow(callback: (row: GridRow<TData>, index: number | undefined) => void): void {
        const count = this.#displayCount();
        this.#projection.forEachLoaded((row, index) => {
            const relative = this.#displayIndex(index) - this.#offset;
            if (relative >= 0 && relative < count) {
                callback(this.#withMaster(row), relative);
            }
            const detail = this.#detailRows().find((entry) => entry.baseIndex === index);
            if (detail) {
                const detailIndex = detail.index - this.#offset;
                if (detailIndex >= 0 && detailIndex < count) {
                    callback(detail.row, detailIndex);
                }
            }
        });
    }

    getPinnedRows(section: 'top' | 'bottom'): readonly GridRow<TData>[] {
        return this.#pinned[section];
    }

    get expandedIds(): ReadonlySet<RowId> {
        const ids = new Set<RowId>();
        this.#projection.forEachLoaded((row) => {
            if (this.isExpanded(row.id)) {
                ids.add(row.id);
            }
        });

        return ids;
    }

    isExpanded(id: RowId): boolean {
        const row = this.#projection.getRow(id);

        return row && this.#isMaster(row) ? this.#detailExpanded.has(id) : this.#projection.isExpanded(id);
    }

    getPagination(): Pagination | null {
        const pageSize = this.#pageSize;
        if (!pageSize) {
            return null;
        }
        const count = this.#topLevelPagination ? this.#projection.getLevelCount([]) : this.#projection.getRowCount();
        const rowCount = count === null ? null : count + (this.#topLevelPagination ? 0 : this.#detailRows().length);

        return {
            page: this.#page,
            pageSize,
            rowCount,
            pageCount: rowCount === null ? null : Math.max(1, Math.ceil(rowCount / pageSize)),
        };
    }

    // Write side

    setOptions(options: ServerRowModelOptions<TData>): void {
        const previous = this.#options;
        this.#options = options;
        const rebuild =
            previous.source.getTreeKey !== options.source.getTreeKey ||
            previous.source.getRowId !== options.source.getRowId ||
            previous.source.blockSize !== options.source.blockSize ||
            previous.source.isGroupOpenByDefault !== options.source.isGroupOpenByDefault;
        if (rebuild && this.#initialised) {
            this.#restart(true);
            if (this.#mayLoad(false)) {
                this.#setStatus({ state: 'loading' });
                this.#want([{ route: [], blockIndex: Math.floor(this.#requestOffset / this.blockSize) }]);
            } else {
                this.#projection.setRowCount([], 0);
                this.#setStatus({ state: 'empty', reason: 'noQuery' });
            }
            this.#changed('query');
        } else if (
            previous.isMaster !== options.isMaster ||
            previous.pageSize !== options.pageSize ||
            previous.paginateChildren !== options.paginateChildren
        ) {
            this.#masterRows = new WeakMap();
            this.#changed('data');
        }
    }

    setQuery(query: QueryState): void {
        const previous = this.#query;
        this.#query = query;
        const same =
            this.#initialised &&
            sameJson(previous.sortModel, query.sortModel) &&
            sameJson(previous.filterModel, query.filterModel) &&
            previous.search.trim() === query.search.trim() &&
            sameJson(previous.externalFilters, query.externalFilters) &&
            sameJson(previous.rowGroupColIds, query.rowGroupColIds);
        if (same) {
            return;
        }
        const regrouped = !this.#initialised || !sameJson(previous.rowGroupColIds, query.rowGroupColIds);
        const sortOnly =
            this.#initialised &&
            !regrouped &&
            sameJson(previous.filterModel, query.filterModel) &&
            previous.search.trim() === query.search.trim() &&
            sameJson(previous.externalFilters, query.externalFilters);
        this.#initialised = true;
        this.#restart(regrouped);
        this.#page = 0;
        if (!this.#mayLoad(sortOnly)) {
            this.#projection.setRowCount([], 0);
            this.#populated = false;
            this.#setStatus({ state: 'empty', reason: 'noQuery' });
        } else {
            this.#setStatus({ state: 'loading' });
            this.#want([{ route: [], blockIndex: Math.floor(this.#requestOffset / this.blockSize) }]);
        }
        this.#changed('query');
    }

    /** Row grouping follows the column state's `rowGroup` columns, through the query. */
    setColumnState(columnState: { colId: string; rowGroup?: boolean | null; rowGroupIndex?: number | null }[]): void {
        const rowGroupColIds = columnState
            .filter((entry) => entry.rowGroup)
            .sort((a, b) => (a.rowGroupIndex ?? 0) - (b.rowGroupIndex ?? 0))
            .map((entry) => entry.colId);
        if (!sameJson(rowGroupColIds, this.#query.rowGroupColIds)) {
            this.setQuery({ ...this.#query, rowGroupColIds });
        }
    }

    setExpanded(id: RowId, expanded: boolean): void {
        const row = this.#projection.getRow(id);
        if (row && this.#isMaster(row)) {
            if (this.#detailExpanded.has(id) !== expanded) {
                if (expanded) {
                    this.#detailExpanded.add(id);
                } else {
                    this.#detailExpanded.delete(id);
                }
                this.#changed('expand');
            }

            return;
        }
        if (this.#projection.setExpanded(id, expanded)) {
            this.#changed('expand');
        }
    }

    /** Requests the blocks covering a displayed (page relative) range. Called by the viewport. */
    ensureRange(firstIndex: number, lastIndex: number): void {
        if (this.#destroyed || (this.#status.state === 'empty' && this.#status.reason === 'noQuery')) {
            return;
        }
        const first = Math.max(0, firstIndex) + this.#offset;
        const last = Math.min(lastIndex, this.#displayCount() - 1) + this.#offset;
        if (last < first) {
            return;
        }
        const covering = this.#projection.blocksCovering(this.#baseIndex(first), this.#baseIndex(last));
        this.#tick++;
        this.#visible = new Set(covering.map(blockKey));
        for (const address of covering) {
            this.#loaded.get(routeKeyOf(address.route))?.set(address.blockIndex, this.#tick);
        }
        this.#wanted = covering.filter((address) => this.#needsLoad(address) && !this.#requests.has(blockKey(address)));
        this.#pump();
    }

    refresh(options: { route?: (string | null)[]; purge?: boolean } = {}): void {
        // Nothing to reload while the grid waits for a query.
        if (this.#destroyed || (this.#status.state === 'empty' && this.#status.reason === 'noQuery')) {
            return;
        }
        const route = options.route ?? [];
        this.#generation++;
        for (const request of this.#requests.values()) {
            request.controller.abort();
        }
        this.#requests.clear();
        // Failed blocks under the route are retried.
        for (const key of [...this.#failed]) {
            if (isUnder(key.slice(0, key.lastIndexOf('#')), route)) {
                this.#failed.delete(key);
                const [levelKey, blockIndex] = [
                    key.slice(0, key.lastIndexOf('#')),
                    Number(key.slice(key.lastIndexOf('#') + 1)),
                ];
                this.#projection.removeBlock(JSON.parse(levelKey) as GroupKey[], blockIndex);
            }
        }
        if (options.purge !== false) {
            this.#projection.clear(route);
            for (const key of [...this.#loaded.keys()]) {
                if (isUnder(key, route)) {
                    this.#loaded.delete(key);
                }
            }
            for (const key of [...this.#stale]) {
                if (isUnder(key.slice(0, key.lastIndexOf('#')), route)) {
                    this.#stale.delete(key);
                }
            }
            if (route.length === 0) {
                this.#setStatus({ state: 'loading' });
                this.#want([{ route: [], blockIndex: Math.floor(this.#requestOffset / this.blockSize) }]);
            }
        } else {
            // Keep the rows on screen; every loaded block under the route reloads and is replaced on arrival.
            for (const [levelKey, blocks] of this.#loaded) {
                if (isUnder(levelKey, route)) {
                    for (const blockIndex of blocks.keys()) {
                        this.#stale.add(`${levelKey}#${blockIndex}`);
                    }
                }
            }
        }
        this.#changed('refresh');
    }

    patchRows(updates: { id: RowId; data: TData }[]): void {
        let changed = false;
        for (const update of updates) {
            changed = this.#projection.patchRow(update.id, update.data) || changed;
        }
        if (changed) {
            this.#changed('patch');
        }
    }

    applyTransaction(): void {
        throw new Error('applyTransaction is for local rows. Server grids use patchRows for loaded rows, or refresh.');
    }

    setPinnedRows(section: 'top' | 'bottom', rows: readonly TData[]): void {
        this.#pinned = {
            ...this.#pinned,
            [section]: buildPinnedRows(section, rows, this.#options.source.getRowId, this.#pinned[section]),
        };
        this.#changed('data');
    }

    setPage(page: number): void {
        const pagination = this.getPagination();
        if (!pagination) {
            return;
        }
        const next = Math.max(0, pagination.pageCount === null ? page : Math.min(page, pagination.pageCount - 1));
        if (next !== this.#page) {
            this.#page = next;
            this.#changed('data');
        }
    }

    markDataChanged(): void {}

    destroy(): void {
        this.#destroyed = true;
        this.#generation++;
        for (const request of this.#requests.values()) {
            request.controller.abort();
        }
        this.#requests.clear();
    }

    // Internals

    get #pageSize(): number | null {
        return this.#options.pageSize ?? null;
    }

    get #topLevelPagination(): boolean {
        return Boolean(this.#pageSize && this.#options.paginateChildren === false);
    }

    get #requestOffset(): number {
        return this.#topLevelPagination ? this.#page * this.#pageSize! : this.#baseIndex(this.#offset);
    }

    get #offset(): number {
        if (this.#topLevelPagination) {
            return this.#displayIndex(
                this.#projection.rootPageSpan(this.#page * this.#pageSize!, this.#pageSize!).start
            );
        }

        return this.#pageSize ? this.#page * this.#pageSize : 0;
    }

    #displayCount(): number {
        if (this.#topLevelPagination) {
            const span = this.#projection.rootPageSpan(this.#page * this.#pageSize!, this.#pageSize!);

            return this.#displayIndex(span.end) - this.#displayIndex(span.start);
        }
        const total = this.#projection.getDisplayCount() + this.#detailRows().length;

        return this.#pageSize ? Math.max(0, Math.min(this.#pageSize, total - this.#offset)) : total;
    }

    #isMaster(row: GridRow<TData>): row is DataRow<TData> {
        return row.kind === 'data' && row.expandable === undefined && Boolean(this.#options.isMaster?.(row.data));
    }

    #withMaster(row: GridRow<TData>): GridRow<TData> {
        if (!this.#isMaster(row)) {
            return row;
        }
        const expanded = this.#detailExpanded.has(row.id);
        const previous = this.#masterRows.get(row);
        if (previous?.expandable?.expanded === expanded) {
            return previous;
        }
        const master = { ...row, expandable: { expanded } };
        this.#masterRows.set(row, master);

        return master;
    }

    #detailRows(): { baseIndex: number; index: number; row: DetailRow<TData> }[] {
        if (!this.#options.isMaster) {
            return [];
        }
        if (this.#details === null || this.#detailsVersion !== this.#projection.version) {
            this.#detailsVersion = this.#projection.version;
            const details: { baseIndex: number; index: number; row: DetailRow<TData> }[] = [];
            this.#projection.forEachLoaded((row, baseIndex) => {
                if (this.#isMaster(row) && this.#detailExpanded.has(row.id)) {
                    details.push({
                        baseIndex,
                        index: baseIndex + details.length + 1,
                        row: {
                            kind: 'detail',
                            id: detailRowId(row.id),
                            section: 'body',
                            level: row.level + 1,
                            parentId: row.id,
                            masterId: row.id,
                            data: row.data,
                        },
                    });
                }
            });
            this.#details = details;
        }

        return this.#details;
    }

    #displayIndex(baseIndex: number): number {
        return baseIndex + this.#detailRows().filter((entry) => entry.baseIndex < baseIndex).length;
    }

    #baseIndex(displayIndex: number): number {
        return displayIndex - this.#detailRows().filter((entry) => entry.index <= displayIndex).length;
    }

    #createProjection(groupColIds: readonly string[]): ServerProjection<TData> {
        const source = this.#options.source;

        return new ServerProjection<TData>({
            ...(source.blockSize !== undefined ? { blockSize: source.blockSize } : {}),
            ...(source.unknownCountRows !== undefined ? { unknownCountRows: source.unknownCountRows } : {}),
            ...(source.getRowId ? { getRowId: source.getRowId } : {}),
            groupColIds,
            ...(source.getTreeKey ? { getTreeKey: source.getTreeKey } : {}),
            ...(source.isGroupOpenByDefault ? { isGroupOpenByDefault: source.isGroupOpenByDefault } : {}),
        });
    }

    /** Drops every request, block and cache for a new query. */
    #restart(regroup: boolean): void {
        this.#generation++;
        for (const request of this.#requests.values()) {
            request.controller.abort();
        }
        this.#requests.clear();
        this.#wanted = [];
        this.#loaded.clear();
        this.#stale.clear();
        this.#failed.clear();
        if (regroup) {
            this.#projection = this.#createProjection(this.#query.rowGroupColIds);
        } else {
            this.#projection.clear();
        }
    }

    /** Whether the query may load: always, unless `loadWithoutQuery` is false and nothing triggers a load. */
    #mayLoad(sortOnly: boolean): boolean {
        if (this.#options.source.loadWithoutQuery !== false) {
            return true;
        }
        const query = this.#query;
        const triggered =
            hasFilter(query.filterModel) ||
            query.search.trim() !== '' ||
            Object.keys(query.externalFilters).length > 0 ||
            query.rowGroupColIds.length > 0;

        // A sort alone reloads only a grid that already shows rows.
        return triggered || (sortOnly && this.#populated && query.sortModel.length > 0);
    }

    /**
     * Without a server count, an empty block past the end only says the rows stop at or before it. This
     * bisects between the highest loaded block with rows and the lowest empty one until a short block gives
     * the real end: a handful of requests even after a jump far past the end.
     */
    #probeEnd(route: readonly GroupKey[]): void {
        if (this.#projection.getLevelCount(route) !== null) {
            return;
        }
        const lengths = this.#projection.loadedBlockLengths(route);
        const empty = [...lengths].filter(([, length]) => length === 0).map(([blockIndex]) => blockIndex);
        if (empty.length === 0) {
            return;
        }
        const lowestEmpty = Math.min(...empty);
        const below = [...lengths.keys()].filter((blockIndex) => blockIndex < lowestEmpty);
        const highestWithRows = below.length > 0 ? Math.max(...below) : -1;
        if (highestWithRows === lowestEmpty - 1) {
            return;
        }
        const probe = Math.floor((highestWithRows + lowestEmpty) / 2);
        const address = { route: [...route], blockIndex: Math.max(0, probe) };
        if (!this.#requests.has(blockKey(address)) && this.#needsLoad(address)) {
            this.#want([address]);
        }
    }

    /** Not loaded (or loaded but stale) and not failed. */
    #needsLoad(address: BlockAddress): boolean {
        return (
            (!this.#projection.isBlockLoaded(address.route, address.blockIndex) ||
                this.#stale.has(blockKey(address))) &&
            !this.#isFailed(address)
        );
    }

    #want(addresses: BlockAddress[]): void {
        const keys = new Set(this.#wanted.map(blockKey));
        this.#wanted = [...addresses.filter((address) => !keys.has(blockKey(address))), ...this.#wanted];
        this.#pump();
    }

    #pump(): void {
        const limit = this.#options.maxConcurrentRequests ?? 2;
        while (this.#requests.size < limit) {
            // Blocks may have loaded or failed since they were wanted.
            this.#wanted = this.#wanted.filter((address) => this.#needsLoad(address));
            const next = this.#wanted.find((address) => !this.#requests.has(blockKey(address)));
            if (!next) {
                return;
            }
            this.#wanted = this.#wanted.filter((address) => blockKey(address) !== blockKey(next));
            this.#start(next);
        }
    }

    #start(address: BlockAddress): void {
        const key = blockKey(address);
        const controller = new AbortController();
        const generation = this.#generation;
        const entry: Request = { controller, generation, address };
        this.#requests.set(key, entry);
        const size = this.blockSize;
        const request: ServerRowsRequest = {
            startRow: address.blockIndex * size,
            endRow: (address.blockIndex + 1) * size,
            sortModel: this.#query.sortModel,
            filterModel: this.#query.filterModel,
            groupKeys: address.route,
            rowGroupCols: this.#query.rowGroupColIds.map((colId) => {
                const column = this.#options.column(colId);

                return { id: colId, field: column?.field ?? colId, displayName: column?.headerName ?? colId };
            }),
            q: this.#query.search.trim(),
            externalFilters: this.#query.externalFilters,
            signal: controller.signal,
        };
        const current = () => !this.#destroyed && generation === this.#generation && !controller.signal.aborted;
        let promise: Promise<{ rows: TData[]; rowCount: number | null }>;
        try {
            promise = this.#options.source.getRows(request);
        } catch (error) {
            promise = Promise.reject(error);
        }
        promise
            .then(
                (response) => {
                    if (!current()) {
                        return;
                    }
                    this.#projection.setBlock(address.route, address.blockIndex, response.rows);
                    // The server's count is authoritative: applied after the block, so a short or empty block
                    // (which ends the level where it stops) cannot override it.
                    if (response.rowCount !== null && response.rowCount !== undefined) {
                        this.#projection.setRowCount(address.route, response.rowCount);
                    }
                    this.#stale.delete(key);
                    this.#failed.delete(key);
                    const levelKey = routeKeyOf(address.route);
                    if (!this.#loaded.has(levelKey)) {
                        this.#loaded.set(levelKey, new Map());
                    }
                    this.#loaded.get(levelKey)!.set(address.blockIndex, ++this.#tick);
                    this.#evict(levelKey, address.route);
                    this.#probeEnd(address.route);
                    if (address.route.length === 0) {
                        const total = this.#projection.getRowCount();
                        this.#populated = (total ?? response.rows.length) > 0;
                        this.#setStatus(total === 0 ? { state: 'empty', reason: 'noResults' } : { state: 'ready' });
                    }
                    this.#options.onBlockLoaded?.({
                        route: [...address.route],
                        startRow: request.startRow,
                        endRow: request.startRow + response.rows.length,
                    });
                    this.#changed('load');
                },
                (error: unknown) => {
                    if (!current()) {
                        return;
                    }
                    this.#projection.setBlockFailed(address.route, address.blockIndex, error);
                    this.#failed.add(key);
                    if (address.route.length === 0 && this.#status.state !== 'ready') {
                        this.#setStatus({ state: 'error', error });
                    }
                    this.#changed('load');
                }
            )
            .finally(() => {
                if (this.#requests.get(key) === entry) {
                    this.#requests.delete(key);
                }
                if (!this.#destroyed) {
                    this.#pump();
                }
            });
    }

    #evict(levelKey: string, route: readonly GroupKey[]): void {
        const max = this.#options.source.maxBlocksInCache;
        const blocks = this.#loaded.get(levelKey);
        if (!max || !blocks || blocks.size <= max) {
            return;
        }
        // Empty blocks hold no rows and mark where a level without a count ends, so they stay.
        const lengths = this.#projection.loadedBlockLengths(route);
        const candidates = [...blocks]
            .filter(([blockIndex]) => !this.#visible.has(`${levelKey}#${blockIndex}`) && lengths.get(blockIndex) !== 0)
            .sort((a, b) => a[1] - b[1]);
        while (blocks.size > max && candidates.length > 0) {
            const [blockIndex] = candidates.shift()!;
            blocks.delete(blockIndex);
            this.#projection.removeBlock(route, blockIndex);
        }
    }

    /** A block whose request failed is not retried by scrolling, only by `refresh` (no error storms). */
    #isFailed(address: BlockAddress): boolean {
        return this.#failed.has(blockKey(address));
    }

    #setStatus(status: RowModelStatus): void {
        if (JSON.stringify(status) === JSON.stringify(this.#status)) {
            return;
        }
        this.#status = status;
        this.#options.onStatus?.(status);
    }

    #changed(source: RowsChangeSource): void {
        this.#version++;
        this.#source = null;
        this.#details = null;
        const pagination = this.getPagination();
        if (pagination?.pageCount !== null && pagination?.pageCount !== undefined) {
            this.#page = Math.min(this.#page, pagination.pageCount - 1);
        }
        this.onChange(source);
    }
}

function routeKeyOf(route: readonly GroupKey[]): string {
    return JSON.stringify(route);
}

/** Whether a level (by its route key) is the route itself or below it. */
function isUnder(levelKey: string, route: readonly GroupKey[]): boolean {
    const levelRoute = JSON.parse(levelKey) as GroupKey[];

    return route.every((key, index) => levelRoute[index] === key);
}

function blockKey(address: BlockAddress): string {
    return `${routeKeyOf(address.route)}#${address.blockIndex}`;
}

/** A filter model with at least one condition that counts: an empty set filter does not (today's rule). */
function hasFilter(model: FilterModel): boolean {
    const counts = (condition: unknown): boolean => {
        if (!condition || typeof condition !== 'object') {
            return false;
        }
        const record = condition as Record<string, unknown>;
        if (Array.isArray(record.conditions)) {
            return record.conditions.some(counts);
        }
        if (record.filterType === 'set') {
            return Array.isArray(record.values) && record.values.length > 0;
        }

        return true;
    };

    return Object.values(model).some(counts);
}

function sameJson(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}
