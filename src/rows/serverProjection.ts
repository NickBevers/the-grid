/**
 * Server (remote) row projection: a sparse displayed index over rows that arrive in blocks.
 *
 * The projection is a tree of levels. The root level holds top-level rows; each expanded server group or
 * server tree row owns a child level with its own row count and blocks. Displayed indexes cover every
 * level that is currently expanded:
 *
 * - An index inside a known count whose block has not loaded resolves to a `LoadingRow` (or `FailedRow`
 *   when the block's request failed). Placeholders have stable ids per slot.
 * - `getRow` answers only for loaded rows, including rows inside collapsed levels that are still cached.
 * - `getIndexOf` answers only for loaded rows whose level is currently displayed.
 * - Nothing here fetches. `missingBlocks` tells the data source what to request.
 *
 * Group rows come from the backend's `_group`, `_groupKey`, `_groupField` and `_childCount` fields and
 * are identified by their key path, so expansion survives refreshes and block evictions.
 */
import type { DataRow, DisplayedRow, GetRowId, GridRow, GroupRow, RowId } from '../contract/rows';
import { defaultGetRowId } from './getRowId';
import { assertDataRowId, failedRowId, groupRowId, loadingRowId, routeKey, type GroupKey } from './ids';

/** Fields a server adds to the group rows it returns. */
export type ServerGroupFields = {
    _group?: boolean;
    _groupKey?: string | number | null;
    _groupField?: string;
    _childCount?: number;
};

export type ServerProjectionOptions<TData> = {
    /** Loading rows past the loaded rows while a level's count is unknown. Default: one block. */
    unknownCountRows?: number;
    blockSize?: number;
    getRowId?: GetRowId<TData>;
    /** Active row group columns, outermost first. Rows at these depths with `_group` become group rows. */
    groupColIds?: readonly string[];
    /** Server tree data: a child route key for rows that have children, or null for leaves. */
    getTreeKey?: (data: TData) => string | null;
    isGroupOpenByDefault?: (group: { groupColId: string; key: GroupKey; level: number }) => boolean;
};

export type BlockAddress = { route: GroupKey[]; blockIndex: number };

type Level<TData> = {
    route: GroupKey[];
    key: string;
    parentId: RowId | null;
    depth: number;
    count: number | null;
    blocks: Map<number, (GridRow<TData> | undefined)[]>;
    failed: Map<number, unknown>;
    children: Map<number, Level<TData>>;
    parent: Level<TData> | null;
    parentPosition: number;
    attached: boolean;
};

type Location<TData> = { level: Level<TData>; position: number };

export class ServerProjection<TData> {
    readonly blockSize: number;
    readonly #getRowId: GetRowId<TData>;
    readonly #groupColIds: readonly string[];
    readonly #getTreeKey: ((data: TData) => string | null) | undefined;
    readonly #isGroupOpenByDefault: ServerProjectionOptions<TData>['isGroupOpenByDefault'];
    readonly #root: Level<TData>;
    readonly #levels = new Map<string, Level<TData>>();
    readonly #locations = new Map<RowId, Location<TData>>();
    readonly #expansion = new Map<RowId, boolean>();
    #countCache = new Map<Level<TData>, number>();
    #version = 0;

    #unknownCountRows: number;

    constructor(options: ServerProjectionOptions<TData> = {}) {
        this.blockSize = options.blockSize ?? 100;
        this.#unknownCountRows = Math.max(1, options.unknownCountRows ?? this.blockSize);
        this.#getRowId = options.getRowId ?? (defaultGetRowId as GetRowId<TData>);
        this.#groupColIds = options.groupColIds ?? [];
        this.#getTreeKey = options.getTreeKey;
        this.#isGroupOpenByDefault = options.isGroupOpenByDefault;
        this.#root = this.#createLevel([], null, 0, null, -1);
        this.#root.attached = true;
    }

    get version(): number {
        return this.#version;
    }

    // Writes

    /** Sets the known row count of a level (the backend's `metadata.found`), or null when unknown. */
    setRowCount(route: readonly GroupKey[], count: number | null): void {
        const level = this.#levelAt(route);
        if (!level) {
            return;
        }
        level.count = count;
        this.#changed();
    }

    /**
     * Stores one block of backend rows for a level. A block shorter than the block size fixes the level's
     * count at the end of that block.
     */
    setBlock(route: readonly GroupKey[], blockIndex: number, data: readonly TData[]): void {
        const level = this.#levelAt(route);
        if (!level) {
            return;
        }
        this.#dropBlock(level, blockIndex);
        level.failed.delete(blockIndex);
        const start = blockIndex * this.blockSize;
        const rows: (GridRow<TData> | undefined)[] = data.map((item) => this.#toRow(level, item));
        level.blocks.set(blockIndex, rows);
        // A child level only stays attached while the same expanded row still sits above it.
        for (let offset = 0; offset < this.blockSize; offset++) {
            const child = level.children.get(start + offset);
            const row = rows[offset];
            if (child && (!row || child.parentId !== row.id || !this.#expandedState(row))) {
                this.#detachChild(level, start + offset);
            }
        }
        rows.forEach((row, offset) => {
            if (row) {
                this.#register(row, level, start + offset);
            }
        });
        // A short block ends the level. An empty one only does when the block before it is loaded (or it is
        // the first): otherwise the rows may stop earlier, and the count stays as it was until that is known.
        if (data.length < this.blockSize && (data.length > 0 || blockIndex === 0 || level.blocks.has(blockIndex - 1))) {
            level.count = start + data.length;
        }
        this.#changed();
    }

    setBlockFailed(route: readonly GroupKey[], blockIndex: number, error: unknown): void {
        const level = this.#levelAt(route);
        if (!level) {
            return;
        }
        this.#dropBlock(level, blockIndex);
        level.failed.set(blockIndex, error);
        this.#changed();
    }

    /**
     * Replaces the data of a loaded data row by id, without reloading (optimistic edits, reconciliation).
     * The row keeps its id, position and expansion. Returns false when the row is not loaded or not a data row.
     */
    patchRow(id: RowId, data: TData): boolean {
        const location = this.#locations.get(id);
        const row = location ? this.#rowAt(location.level, location.position) : undefined;
        if (!location || !row || row.kind !== 'data') {
            return false;
        }
        this.#replaceRow(location.level, location.position, { ...row, data } as DataRow<TData>);
        this.#changed();

        return true;
    }

    /** Forgets one block (cache eviction). Its slots become loading placeholders again. */
    removeBlock(route: readonly GroupKey[], blockIndex: number): void {
        const level = this.#levelAt(route);
        if (!level) {
            return;
        }
        this.#dropBlock(level, blockIndex);
        level.failed.delete(blockIndex);
        this.#changed();
    }

    /**
     * Drops all rows, counts and child levels below `route` (the whole projection when omitted), for a
     * refresh. Expansion state is kept, so groups reopen when their rows arrive again.
     */
    clear(route: readonly GroupKey[] = []): void {
        const level = this.#levelAt(route);
        if (!level) {
            return;
        }
        this.#clearLevel(level);
        this.#changed();
    }

    /** Expands or collapses a loaded group or server tree row. Returns false when the row is not expandable. */
    setExpanded(id: RowId, expanded: boolean): boolean {
        const location = this.#locations.get(id);
        const row = location ? this.#rowAt(location.level, location.position) : undefined;
        if (!location || !row || !this.#isExpandable(row)) {
            return false;
        }
        this.#expansion.set(id, expanded);
        this.#replaceRow(location.level, location.position, withExpanded(row, expanded));
        if (expanded) {
            this.#attachChild(location.level, location.position, row);
        } else {
            this.#detachChild(location.level, location.position);
        }
        this.#changed();

        return true;
    }

    // Reads

    /** Displayed row count including loading slots. Uses estimates where a count is still unknown. */
    getDisplayCount(): number {
        return this.#displayCount(this.#root);
    }

    /** Known displayed count, or null while any displayed level's count is unknown. */
    getRowCount(): number | null {
        return this.#allCountsKnown(this.#root) ? this.#displayCount(this.#root) : null;
    }

    /** Displayed span of a page of root rows, including every expanded descendant. */
    rootPageSpan(first: number, size: number): { start: number; end: number } {
        const count = this.#baseCount(this.#root);

        return {
            start: this.#indexWithin(this.#root, Math.min(first, count)),
            end: this.#indexWithin(this.#root, Math.min(first + size, count)),
        };
    }

    getRowAtIndex(index: number): DisplayedRow<TData> | undefined {
        const location = this.#locate(this.#root, index);
        if (!location) {
            return undefined;
        }

        return { row: this.#rowOrPlaceholder(location.level, location.position, index), index };
    }

    /** A loaded row by id. Rows in collapsed but cached levels are included. */
    getRow(id: RowId): GridRow<TData> | undefined {
        const location = this.#locations.get(id);

        return location ? this.#rowAt(location.level, location.position) : undefined;
    }

    /** Displayed index of a loaded row, or undefined when it is not loaded or sits under a collapsed row. */
    getIndexOf(id: RowId): number | undefined {
        const location = this.#locations.get(id);
        if (!location || !this.#isDisplayed(location.level) || location.position >= this.#baseCount(location.level)) {
            return undefined;
        }

        return this.#startOf(location.level) + this.#indexWithin(location.level, location.position);
    }

    isExpanded(id: RowId): boolean {
        const row = this.getRow(id);

        return row?.kind === 'group'
            ? row.expanded
            : row?.kind === 'data'
              ? (row.expandable?.expanded ?? false)
              : false;
    }

    /** Loaded rows of displayed levels in display order. Never triggers loading. */
    forEachLoaded(callback: (row: GridRow<TData>, index: number) => void): void {
        const walk = (level: Level<TData>): void => {
            const positions = new Set<number>(level.children.keys());
            for (const [blockIndex, rows] of level.blocks) {
                rows.forEach((row, offset) => row && positions.add(blockIndex * this.blockSize + offset));
            }
            const base = this.#baseCount(level);
            for (const position of [...positions].filter((candidate) => candidate < base).sort((a, b) => a - b)) {
                const row = this.#rowAt(level, position);
                if (row) {
                    callback(row, this.#startOf(level) + this.#indexWithin(level, position));
                }
                const child = level.children.get(position);
                if (child) {
                    walk(child);
                }
            }
        };
        walk(this.#root);
    }

    /** Every block covering displayed indexes `first` to `last`, loaded or not, in display order. */
    blocksCovering(first: number, last: number): BlockAddress[] {
        const seen = new Set<string>();
        const blocks: BlockAddress[] = [];
        const end = Math.min(last, this.getDisplayCount() - 1);
        for (let index = Math.max(first, 0); index <= end; index++) {
            const location = this.#locate(this.#root, index);
            if (!location) {
                continue;
            }
            const blockIndex = Math.floor(location.position / this.blockSize);
            const key = `${location.level.key}|${blockIndex}`;
            if (!seen.has(key)) {
                seen.add(key);
                blocks.push({ route: [...location.level.route], blockIndex });
            }
        }

        return blocks;
    }

    /** A level's own row count, or null while unknown (or the level does not exist). */
    getLevelCount(route: readonly GroupKey[]): number | null {
        return this.#levelAt(route)?.count ?? null;
    }

    /** Row counts of the loaded blocks at a level, by block index (empty blocks included). */
    loadedBlockLengths(route: readonly GroupKey[]): Map<number, number> {
        const level = this.#levelAt(route);

        return new Map([...(level?.blocks ?? [])].map(([blockIndex, rows]) => [blockIndex, rows.length]));
    }

    /** Whether a block is fully loaded. */
    isBlockLoaded(route: readonly GroupKey[], blockIndex: number): boolean {
        const level = this.#levelAt(route);

        return level ? this.#isBlockComplete(level, blockIndex) : false;
    }

    /** Blocks that cover displayed indexes `first` to `last` and are neither loaded nor failed. */
    missingBlocks(first: number, last: number): BlockAddress[] {
        const seen = new Set<string>();
        const missing: BlockAddress[] = [];
        const end = Math.min(last, this.getDisplayCount() - 1);
        for (let index = Math.max(first, 0); index <= end; index++) {
            const location = this.#locate(this.#root, index);
            if (!location) {
                continue;
            }
            const blockIndex = Math.floor(location.position / this.blockSize);
            const key = `${location.level.key}|${blockIndex}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            if (!this.#isBlockComplete(location.level, blockIndex) && !location.level.failed.has(blockIndex)) {
                missing.push({ route: [...location.level.route], blockIndex });
            }
        }

        return missing;
    }

    // Internals

    #createLevel(
        route: GroupKey[],
        parentId: RowId | null,
        depth: number,
        parent: Level<TData> | null,
        parentPosition: number
    ): Level<TData> {
        const level: Level<TData> = {
            route,
            key: routeKey(route),
            parentId,
            depth,
            count: null,
            blocks: new Map(),
            failed: new Map(),
            children: new Map(),
            parent,
            parentPosition,
            attached: false,
        };
        this.#levels.set(level.key, level);

        return level;
    }

    #levelAt(route: readonly GroupKey[]): Level<TData> | undefined {
        return this.#levels.get(routeKey(route));
    }

    #changed(): void {
        this.#version++;
        this.#countCache = new Map();
    }

    #toRow(level: Level<TData>, data: TData): GridRow<TData> {
        const fields = data as ServerGroupFields;
        if (level.depth < this.#groupColIds.length && fields._group) {
            const key: GroupKey =
                fields._groupKey === undefined || fields._groupKey === null ? null : String(fields._groupKey);
            const keyPath = [...level.route, key];
            const id = groupRowId(this.#groupColIds, keyPath);
            const groupColId = this.#groupColIds[level.depth]!;
            const row: GroupRow<TData> = {
                kind: 'group',
                id,
                section: 'body',
                level: level.depth,
                parentId: level.parentId,
                groupColId,
                key,
                keyPath,
                childCount: typeof fields._childCount === 'number' ? fields._childCount : null,
                expanded:
                    this.#expansion.get(id) ??
                    this.#isGroupOpenByDefault?.({ groupColId, key, level: level.depth }) ??
                    false,
                data,
            };

            return row;
        }
        const id = this.#getRowId(data, { parentId: level.parentId, level: level.depth });
        assertDataRowId(id, 'Server projection');
        const treeKey = this.#getTreeKey?.(data) ?? null;
        const row: DataRow<TData> = {
            kind: 'data',
            id,
            section: 'body',
            level: level.depth,
            parentId: level.parentId,
            data,
        };
        if (treeKey !== null) {
            row.expandable = { expanded: this.#expansion.get(id) ?? false };
        }

        return row;
    }

    #register(row: GridRow<TData>, level: Level<TData>, position: number): void {
        const previous = this.#locations.get(row.id);
        if (previous && (previous.level !== level || previous.position !== position)) {
            // The backend moved this row between blocks (data changed while paging). The old slot becomes a
            // hole, so its block is reported as missing and refetched instead of showing the row twice.
            const block = previous.level.blocks.get(Math.floor(previous.position / this.blockSize));
            if (block) {
                block[previous.position % this.blockSize] = undefined;
            }
            // Its children follow the row; they are re-attached below if the row is still expanded.
            if (previous.level.children.get(previous.position)?.parentId === row.id) {
                this.#detachChild(previous.level, previous.position);
            }
        }
        this.#locations.set(row.id, { level, position });
        if (this.#isExpandable(row) && this.#expandedState(row)) {
            this.#attachChild(level, position, row);
        }
    }

    #dropBlock(level: Level<TData>, blockIndex: number): void {
        const rows = level.blocks.get(blockIndex);
        if (!rows) {
            return;
        }
        rows.forEach((row, offset) => {
            if (
                row &&
                this.#locations.get(row.id)?.level === level &&
                this.#locations.get(row.id)?.position === blockIndex * this.blockSize + offset
            ) {
                this.#locations.delete(row.id);
            }
        });
        level.blocks.delete(blockIndex);
    }

    #clearLevel(level: Level<TData>): void {
        // Every cached level below this one goes, including collapsed levels that are not in `children`.
        for (const descendant of [...this.#levels.values()]) {
            if (descendant !== level && isBelow(descendant.route, level.route)) {
                this.#resetLevel(descendant);
                descendant.attached = false;
                this.#levels.delete(descendant.key);
            }
        }
        this.#resetLevel(level);
        level.children.clear();
    }

    #resetLevel(level: Level<TData>): void {
        for (const blockIndex of [...level.blocks.keys()]) {
            this.#dropBlock(level, blockIndex);
        }
        level.failed.clear();
        level.count = null;
    }

    /** Complete when every slot of the block that lies inside the level's count holds a row. */
    #isBlockComplete(level: Level<TData>, blockIndex: number): boolean {
        const block = level.blocks.get(blockIndex);
        if (!block) {
            return false;
        }
        const start = blockIndex * this.blockSize;
        const end = Math.min(start + this.blockSize, this.#baseCount(level));
        for (let position = start; position < end; position++) {
            if (!block[position - start]) {
                return false;
            }
        }

        return true;
    }

    #rowAt(level: Level<TData>, position: number): GridRow<TData> | undefined {
        return level.blocks.get(Math.floor(position / this.blockSize))?.[position % this.blockSize];
    }

    #replaceRow(level: Level<TData>, position: number, row: GridRow<TData>): void {
        const block = level.blocks.get(Math.floor(position / this.blockSize));
        if (block) {
            block[position % this.blockSize] = row;
        }
    }

    #rowOrPlaceholder(level: Level<TData>, position: number, index: number): GridRow<TData> {
        const row = this.#rowAt(level, position);
        if (row) {
            return row;
        }
        const blockIndex = Math.floor(position / this.blockSize);
        const base = { section: 'body' as const, level: level.depth, parentId: level.parentId, index };
        if (level.failed.has(blockIndex)) {
            return {
                ...base,
                kind: 'failed',
                id: failedRowId(level.route, position),
                error: level.failed.get(blockIndex),
            };
        }

        return { ...base, kind: 'loading', id: loadingRowId(level.route, position) };
    }

    #isExpandable(row: GridRow<TData>): boolean {
        return row.kind === 'group' || (row.kind === 'data' && row.expandable !== undefined);
    }

    #expandedState(row: GridRow<TData>): boolean {
        return row.kind === 'group' ? row.expanded : row.kind === 'data' ? (row.expandable?.expanded ?? false) : false;
    }

    #attachChild(level: Level<TData>, position: number, row: GridRow<TData>): void {
        const childKey = row.kind === 'group' ? row.key : this.#getTreeKey!((row as DataRow<TData>).data);
        const route = [...level.route, childKey];
        let child = this.#levelAt(route);
        if (!child) {
            child = this.#createLevel(route, row.id, level.depth + 1, level, position);
            // The last group level's children are leaves, so the group's child count is their count.
            if (row.kind === 'group' && row.childCount !== null && level.depth + 1 === this.#groupColIds.length) {
                child.count = row.childCount;
            }
        }
        // A row that moved (reload, eviction and return) takes its child level along: detach it from the
        // old position first, so the level is never displayed twice.
        if (child.attached && child.parent && child.parent.children.get(child.parentPosition) === child) {
            child.parent.children.delete(child.parentPosition);
        }
        child.parent = level;
        child.parentPosition = position;
        child.attached = true;
        level.children.set(position, child);
    }

    #detachChild(level: Level<TData>, position: number): void {
        const child = level.children.get(position);
        if (child) {
            child.attached = false;
            level.children.delete(position);
        }
    }

    #baseCount(level: Level<TData>): number {
        if (level.count !== null) {
            return level.count;
        }
        let extent = 0;
        for (const [blockIndex, rows] of level.blocks) {
            extent = Math.max(extent, blockIndex * this.blockSize + rows.length);
        }

        // Unknown count: what is loaded plus loading rows to scroll into (one block unless configured).
        return extent + this.#unknownCountRows;
    }

    #displayCount(level: Level<TData>): number {
        const cached = this.#countCache.get(level);
        if (cached !== undefined) {
            return cached;
        }
        const base = this.#baseCount(level);
        let count = base;
        for (const [position, child] of level.children) {
            if (position < base) {
                count += this.#displayCount(child);
            }
        }
        this.#countCache.set(level, count);

        return count;
    }

    /** Only displayed child levels matter; a level past its parent's count is not shown. */
    #allCountsKnown(level: Level<TData>): boolean {
        return (
            level.count !== null &&
            this.#sortedChildPositions(level).every((position) => this.#allCountsKnown(level.children.get(position)!))
        );
    }

    /** Positions of displayed child levels. Rows past the level's count are not displayed, nor their children. */
    #sortedChildPositions(level: Level<TData>): number[] {
        const base = this.#baseCount(level);

        return [...level.children.keys()].filter((position) => position < base).sort((a, b) => a - b);
    }

    #locate(level: Level<TData>, index: number): Location<TData> | undefined {
        if (index < 0) {
            return undefined;
        }
        let consumed = 0;
        let next = 0;
        for (const position of this.#sortedChildPositions(level)) {
            const plain = position - next + 1;
            if (index < consumed + plain) {
                return { level, position: next + index - consumed };
            }
            consumed += plain;
            const child = level.children.get(position)!;
            const size = this.#displayCount(child);
            if (index < consumed + size) {
                return this.#locate(child, index - consumed);
            }
            consumed += size;
            next = position + 1;
        }
        const position = next + index - consumed;

        return position < this.#baseCount(level) ? { level, position } : undefined;
    }

    #indexWithin(level: Level<TData>, position: number): number {
        let index = position;
        for (const childPosition of this.#sortedChildPositions(level)) {
            const child = level.children.get(childPosition)!;
            if (childPosition < position) {
                index += this.#displayCount(child);
            }
        }

        return index;
    }

    #startOf(level: Level<TData>): number {
        if (!level.parent) {
            return 0;
        }

        return this.#startOf(level.parent) + this.#indexWithin(level.parent, level.parentPosition) + 1;
    }

    /** A level is displayed when it and every ancestor is attached and sits inside its parent's count. */
    #isDisplayed(level: Level<TData>): boolean {
        for (let current: Level<TData> | null = level; current; current = current.parent) {
            if (!current.attached) {
                return false;
            }
            if (current.parent && current.parentPosition >= this.#baseCount(current.parent)) {
                return false;
            }
        }

        return true;
    }
}

/** True when `route` is a strict descendant of `ancestor`. */
function isBelow(route: readonly GroupKey[], ancestor: readonly GroupKey[]): boolean {
    return route.length > ancestor.length && ancestor.every((key, index) => route[index] === key);
}

function withExpanded<TData>(row: GridRow<TData>, expanded: boolean): GridRow<TData> {
    if (row.kind === 'group') {
        return { ...row, expanded };
    }
    if (row.kind === 'data' && row.expandable) {
        return { ...row, expandable: { expanded } };
    }

    return row;
}
