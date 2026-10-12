/**
 * The column model: column definitions (nested groups, field or colId, sizing, visibility, pinning, locks,
 * sort, row grouping) plus the user's column state, producing the displayed leaf columns, the specs for the
 * column layout, header group labels, and column state in the format saved views store.
 *
 * Column state follows the stored `ColumnState` shape exactly, because saved views store it: an array of
 * every column (hidden ones included) in display order with `colId`, `width`, `hide`, `pinned`, `sort`,
 * `sortIndex`, `flex`, `rowGroup`, `rowGroupIndex`, `aggFunc`, `pivot`, `pivotIndex`. Applying state follows
 * the `applyColumnState` semantics saved views rely on, including `applyOrder` and `defaultState`, and entries for unknown
 * columns are kept and re-exported so a saved view never loses information.
 *
 * Definitions here are already resolved by the registry: function members are functions.
 */
import type {
    ApplyColumnStateOptions,
    ColumnDef,
    ColumnDefinition,
    ColumnGroupDef,
    ColumnGroupState,
    ColumnState,
    DataRow,
    GridRow,
    PinnedSide,
    ResolvedColumn,
    RowWithData,
    SortDirection,
    SortModel,
} from '../contract';
import { hasData, isColumnGroupDef } from '../contract';
import type { ColumnSpec } from '../virtual/horizontalLayout';

/** A leaf definition with its place in the header group tree. */
export type LeafColumn<TData> = {
    colId: string;
    def: ColumnDef<TData>;
    /** Group ids from the outermost group to the innermost. */
    groupPath: string[];
    /** Open/closed visibility within its group, from the definition's `showWhen`. */
    showWhen: 'open' | 'closed' | undefined;
    /** Definition order, used for reset and for placing columns a saved state does not mention. */
    definitionIndex: number;
};

type LiveState = {
    hide: boolean;
    pinned: PinnedSide | null;
    width: number | null;
    flex: number | null;
    sort: SortDirection | null;
    sortIndex: number | null;
    rowGroup: boolean;
    rowGroupIndex: number | null;
    aggFunc: string | null;
    pivot: boolean;
    pivotIndex: number | null;
};

export class ColumnModel<TData> {
    #leaves: LeafColumn<TData>[] = [];
    #groups = new Map<string, ColumnGroupDef<TData>>();
    /** Group ids children first (post-order), the order stored views list group state in. */
    #groupOrder: string[] = [];
    #order: string[] = [];
    #state = new Map<string, LiveState>();
    #groupOpen = new Map<string, boolean>();
    /** Entries of applied state for columns that do not exist (yet); re-exported unchanged. */
    #unknown = new Map<string, ColumnState>();
    #resolved = new Map<string, ResolvedColumn<TData>>();

    constructor(definitions: readonly ColumnDefinition<TData>[] = []) {
        this.setDefinitions(definitions);
    }

    /**
     * Replaces the definitions. Columns that still exist keep their state (order, width, visibility,
     * pinning, sort); new columns take their definition defaults and slot in at their definition position.
     */
    setDefinitions(definitions: readonly ColumnDefinition<TData>[]): void {
        const leaves: LeafColumn<TData>[] = [];
        const groupOrder: string[] = [];
        const groups = new Map<string, ColumnGroupDef<TData>>();
        const seen = new Set<string>();
        const walk = (items: readonly ColumnDefinition<TData>[], path: string[]) => {
            for (const item of items) {
                if (isColumnGroupDef(item)) {
                    groups.set(item.groupId, item);
                    if (!this.#groupOpen.has(item.groupId)) {
                        this.#groupOpen.set(item.groupId, item.openByDefault ?? false);
                    }
                    walk(item.children, [...path, item.groupId]);
                    groupOrder.push(item.groupId);
                    continue;
                }
                const colId = item.colId ?? item.field;
                if (!colId) {
                    throw new Error('Column definitions need a colId or a field.');
                }
                if (seen.has(colId)) {
                    throw new Error(`Duplicate column id "${colId}". Give columns that share a field their own colId.`);
                }
                seen.add(colId);
                leaves.push({
                    colId,
                    def: item,
                    groupPath: path,
                    showWhen: item.showWhen,
                    definitionIndex: leaves.length,
                });
            }
        };
        walk(definitions, []);

        const previousOrder = this.#order.filter((colId) => seen.has(colId));
        for (const leaf of leaves) {
            if (!this.#state.has(leaf.colId)) {
                this.#state.set(leaf.colId, defaultsFor(leaf.def));
            }
        }
        for (const colId of [...this.#state.keys()]) {
            if (!seen.has(colId)) {
                this.#state.delete(colId);
            }
        }
        // Keep the user's order for existing columns; insert new ones at their definition position.
        const order = [...previousOrder];
        leaves.forEach((leaf, index) => {
            if (!order.includes(leaf.colId)) {
                order.splice(Math.min(index, order.length), 0, leaf.colId);
            }
        });
        this.#leaves = leaves;
        this.#groups = groups;
        this.#groupOrder = groupOrder;
        this.#order = this.#respectLocks(order);
        this.#resolved.clear();
        // State applied earlier for columns that now exist takes effect.
        const pending = [...this.#unknown.values()].filter((entry) => seen.has(entry.colId));
        if (pending.length > 0) {
            pending.forEach((entry) => this.#unknown.delete(entry.colId));
            this.applyColumnState(pending);
        }
    }

    getLeaf(colId: string): LeafColumn<TData> | undefined {
        return this.#leaves.find((leaf) => leaf.colId === colId);
    }

    /** Every leaf column in the current order, hidden ones included. */
    getAllLeaves(): LeafColumn<TData>[] {
        const byId = new Map(this.#leaves.map((leaf) => [leaf.colId, leaf]));

        return this.#order.map((colId) => byId.get(colId)!).filter(Boolean);
    }

    /**
     * Displayed leaf columns: visible, shown for their group's open state, in display order (left pinned,
     * center, right pinned, each in the current order).
     */
    getDisplayedLeaves(): LeafColumn<TData>[] {
        const visible = this.getAllLeaves().filter(
            (leaf) => !this.#state.get(leaf.colId)!.hide && this.#shownForGroup(leaf)
        );
        const section = (side: PinnedSide | null) =>
            visible.filter((leaf) => (this.#state.get(leaf.colId)!.pinned ?? null) === side);

        return [...section('left'), ...section(null), ...section('right')];
    }

    /** Specs for the column layout, in display order. */
    getColumnSpecs(): ColumnSpec[] {
        return this.getDisplayedLeaves().map((leaf) => {
            const state = this.#state.get(leaf.colId)!;
            const spec: ColumnSpec = {
                colId: leaf.colId,
                pinned: state.pinned,
                groupPath: leaf.groupPath,
                keepMounted: leaf.def.autoHeight ?? false,
            };
            if (leaf.def.minWidth !== undefined) {
                spec.minWidth = leaf.def.minWidth;
            }
            if (leaf.def.maxWidth !== undefined) {
                spec.maxWidth = leaf.def.maxWidth;
            }
            if (state.flex !== null && state.flex > 0) {
                spec.flex = state.flex;
            } else if (state.width !== null) {
                spec.width = state.width;
            } else if (leaf.def.width !== undefined) {
                spec.width = leaf.def.width;
            }

            return spec;
        });
    }

    /** Header label of a group, or the id when it has none. */
    getGroupLabel(groupId: string): string {
        return this.#groups.get(groupId)?.headerName ?? groupId;
    }

    getGroup(groupId: string): ColumnGroupDef<TData> | undefined {
        return this.#groups.get(groupId);
    }

    /**
     * Whether a group can be toggled: among its visible direct leaf children, something shows when it is
     * open and something shows when it is closed, and at least one child depends on the state.
     * `columnGroupShow` is ignored otherwise, so a group whose closed-state columns are hidden keeps showing
     * its open-state columns.
     */
    isGroupExpandable(groupId: string): boolean {
        // Direct leaf children with their own showWhen; a nested group with a visible column shows either way.
        const visible = this.#leaves.filter(
            (leaf) => leaf.groupPath.includes(groupId) && !this.#state.get(leaf.colId)!.hide
        );
        const states = visible.map((leaf) =>
            leaf.groupPath[leaf.groupPath.length - 1] === groupId ? leaf.showWhen : undefined
        );
        const showsOpen = states.some((state) => state !== 'closed');
        const showsClosed = states.some((state) => state !== 'open');

        return showsOpen && showsClosed && states.some((state) => state !== undefined);
    }

    // State: saved view format

    /** Every column in display order, hidden ones included, then entries for unknown columns. */
    getColumnState(actualWidths?: ReadonlyMap<string, number>): ColumnState[] {
        // The column order itself, pinned and hidden columns in place, as stored views list it. Sorting by pinned
        // section here would split married groups and make the state refuse to apply again.
        const ordered = this.#order.filter((colId) => this.#state.has(colId));

        return [
            ...ordered.map((colId) => {
                const state = this.#state.get(colId)!;
                const leaf = this.getLeaf(colId)!;

                return {
                    colId,
                    width: actualWidths?.get(colId) ?? state.width ?? leaf.def.width ?? null,
                    hide: state.hide,
                    pinned: state.pinned,
                    sort: state.sort,
                    sortIndex: state.sortIndex,
                    flex: state.flex,
                    rowGroup: state.rowGroup,
                    rowGroupIndex: state.rowGroupIndex,
                    aggFunc: state.aggFunc,
                    pivot: state.pivot,
                    pivotIndex: state.pivotIndex,
                };
            }),
            ...this.#unknown.values(),
        ];
    }

    /**
     * Applies column state's `applyColumnState`. Properties absent from an entry are left as they
     * are, unless `defaultState` gives them; columns without an entry get `defaultState` too. Lock flags only
     * restrict the UI: state and api calls still apply. With `applyOrder`,
     * columns follow the order of `state`, and columns it does not mention follow after them in their current
     * order; an order that would split a `marryChildren` group is ignored. Locked columns
     * (`lockPosition`) keep their position. Returns true when anything changed.
     */
    applyColumnState(state: readonly ColumnState[], options: ApplyColumnStateOptions = {}): boolean {
        const before = JSON.stringify(this.getColumnState());
        const mentioned = new Set<string>();
        for (const entry of state) {
            if (!this.#state.has(entry.colId)) {
                // Kept for when the column appears; a partial entry (a sort) adds to what is kept.
                const kept = this.#unknown.get(entry.colId);
                this.#unknown.set(
                    entry.colId,
                    kept ? { ...kept, ...withoutUndefined(entry), colId: entry.colId } : entry
                );
                continue;
            }
            mentioned.add(entry.colId);
            this.#patch(
                entry.colId,
                options.defaultState ? { ...options.defaultState, ...withoutUndefined(entry) } : entry
            );
        }
        if (options.defaultState) {
            for (const colId of this.#state.keys()) {
                if (!mentioned.has(colId)) {
                    this.#patch(colId, options.defaultState);
                }
            }
        }
        if (options.applyOrder) {
            // A full state (a view) replaces the kept entries for unknown columns, so they never leak from
            // one view into the next.
            const named = new Set(state.map((entry) => entry.colId));
            for (const colId of [...this.#unknown.keys()]) {
                if (!named.has(colId)) {
                    this.#unknown.delete(colId);
                }
            }
            const inState = state.map((entry) => entry.colId).filter((colId) => this.#state.has(colId));
            const rest = this.#order.filter((colId) => !inState.includes(colId));
            const proposed = this.#respectLocks([...inState, ...rest]);
            // An order that would split a marryChildren group is ignored.
            if (this.#marriedGroupsIntact(proposed)) {
                this.#order = proposed;
            }
        }
        this.#resolved.clear();

        return JSON.stringify(this.getColumnState()) !== before;
    }

    /** Back to the definitions: order, widths, visibility, pinning, sort and grouping. */
    resetColumnState(): void {
        this.#order = this.#respectLocks(this.#leaves.map((leaf) => leaf.colId));
        for (const leaf of this.#leaves) {
            this.#state.set(leaf.colId, defaultsFor(leaf.def));
        }
        this.#unknown.clear();
        this.#resolved.clear();
    }

    /** Open state per header group, children before their parent, as stored views list it. */
    getColumnGroupState(): ColumnGroupState[] {
        return this.#groupOrder.map((groupId) => ({ groupId, open: this.#groupOpen.get(groupId) ?? false }));
    }

    setColumnGroupState(state: readonly ColumnGroupState[]): void {
        for (const entry of state) {
            this.#groupOpen.set(entry.groupId, entry.open);
        }
    }

    resetColumnGroupState(): void {
        for (const [groupId, group] of this.#groups) {
            this.#groupOpen.set(groupId, group.openByDefault ?? false);
        }
    }

    setGroupOpen(groupId: string, open: boolean): void {
        this.#groupOpen.set(groupId, open);
    }

    // Common edits

    setColumnsVisible(colIds: readonly string[], visible: boolean): void {
        for (const colId of colIds) {
            const leaf = this.getLeaf(colId);
            if (leaf) {
                this.#state.get(colId)!.hide = !visible;
            }
        }
        this.#resolved.clear();
    }

    setPinned(colId: string, pinned: PinnedSide | null): void {
        if (this.getLeaf(colId)) {
            this.#state.get(colId)!.pinned = pinned;
        }
    }

    /** A user resize: the column keeps this width and stops flexing (flex becomes null). */
    setWidth(colId: string, width: number): void {
        const state = this.#state.get(colId);
        if (state) {
            state.width = width;
            state.flex = null;
        }
    }

    /**
     * Moves a column to a position in the full order (hidden columns included). Nothing moves past a locked
     * column, locked columns only move within their locked block, and columns of a group with
     * `marryChildren` stay together. `movable: false` columns do not move.
     */
    moveColumn(colId: string, toIndex: number): boolean {
        const leaf = this.getLeaf(colId);
        // A locked column may still move within its locked block; the lock check below refuses anything else.
        // An index past the end is refused.
        if (!leaf || leaf.def.movable === false || toIndex < 0 || toIndex > this.#order.length - 1) {
            return false;
        }
        const without = this.#order.filter((id) => id !== colId);
        const target = Math.min(Math.max(toIndex, 0), without.length);
        const proposed = [...without.slice(0, target), colId, ...without.slice(target)];
        const respected = this.#respectLocks(proposed);
        // A move past a locked column, or one that splits a married group, is refused.
        if (respected.join() !== proposed.join() || !this.#marriedGroupsIntact(respected)) {
            return false;
        }
        const changed = respected.join() !== this.#order.join();
        this.#order = respected;

        return changed;
    }

    // Sort and grouping

    /** The sort model in priority order, derived from column state. */
    getSortModel(): SortModel {
        const position = new Map(this.#order.map((colId, index) => [colId, index]));
        const rank = (index: number | null) => index ?? Number.NEGATIVE_INFINITY;

        // Sorts without an index (column definition sorts) rank first, in column order.
        return [...this.#state.entries()]
            .filter(([, state]) => state.sort)
            .sort(
                ([colA, a], [colB, b]) =>
                    rank(a.sortIndex) - rank(b.sortIndex) || position.get(colA)! - position.get(colB)!
            )
            .map(([colId, state]) => ({ colId, sort: state.sort! }));
    }

    /** Replaces the sort; columns not in the model become unsorted. */
    setSortModel(model: SortModel): void {
        for (const state of this.#state.values()) {
            state.sort = null;
            state.sortIndex = null;
        }
        model.forEach((item, index) => {
            const state = this.#state.get(item.colId);
            if (state) {
                state.sort = item.sort;
                state.sortIndex = index;
            }
        });
    }

    /**
     * The header click cycle: none, asc, desc, none. With `multi` the column is added to (or cycled within)
     * the existing sort; otherwise it replaces it.
     */
    toggleSort(colId: string, multi: boolean): SortModel {
        const leaf = this.getLeaf(colId);
        if (!leaf || leaf.def.sortable === false) {
            return this.getSortModel();
        }
        const current = this.getSortModel();
        const existing = current.find((item) => item.colId === colId);
        const next: SortDirection | null = !existing ? 'asc' : existing.sort === 'asc' ? 'desc' : null;
        let model = multi ? current.filter((item) => item.colId !== colId) : [];
        if (next) {
            const position = multi && existing ? current.findIndex((item) => item.colId === colId) : model.length;
            model = [...model.slice(0, position), { colId, sort: next }, ...model.slice(position)];
        }
        this.setSortModel(model);

        return model;
    }

    getRowGroupColumnIds(): string[] {
        return [...this.#state.entries()]
            .filter(([, state]) => state.rowGroup)
            .sort(([, a], [, b]) => (a.rowGroupIndex ?? 0) - (b.rowGroupIndex ?? 0))
            .map(([colId]) => colId);
    }

    setRowGroupColumns(colIds: readonly string[]): void {
        for (const state of this.#state.values()) {
            state.rowGroup = false;
            state.rowGroupIndex = null;
        }
        colIds.forEach((colId, index) => {
            const state = this.#state.get(colId);
            if (state) {
                state.rowGroup = true;
                state.rowGroupIndex = index;
            }
        });
    }

    // Resolved columns

    /** The resolved column: value access, formatting, editability, classes and comparator as functions. */
    getResolved(colId: string): ResolvedColumn<TData> | undefined {
        const cached = this.#resolved.get(colId);
        if (cached) {
            return cached;
        }
        const leaf = this.getLeaf(colId);
        if (!leaf) {
            return undefined;
        }
        const resolved = resolveColumn(leaf, (groupId) => this.getGroupLabel(groupId));
        this.#resolved.set(colId, resolved);

        return resolved;
    }

    // Internals

    #patch(colId: string, entry: Partial<ColumnState>): void {
        const state = this.#state.get(colId)!;
        if (entry.hide !== undefined) {
            state.hide = Boolean(entry.hide);
        }
        if (entry.pinned !== undefined) {
            state.pinned = normalisePinned(entry.pinned);
        }
        if (entry.width !== undefined && entry.width !== null) {
            state.width = entry.width;
        }
        if (entry.flex !== undefined) {
            state.flex = entry.flex && entry.flex > 0 ? entry.flex : null;
        }
        if (entry.sort !== undefined) {
            // A cleared sort keeps its old sortIndex; it only matters once sorted again.
            state.sort = entry.sort ?? null;
        }
        if (entry.sortIndex !== undefined) {
            state.sortIndex = entry.sortIndex ?? null;
        }
        if (entry.rowGroup !== undefined) {
            state.rowGroup = Boolean(entry.rowGroup);
        }
        if (entry.rowGroupIndex !== undefined) {
            state.rowGroupIndex = entry.rowGroupIndex ?? null;
        }
        if (entry.aggFunc !== undefined) {
            state.aggFunc = entry.aggFunc ?? null;
        }
        if (entry.pivot !== undefined) {
            state.pivot = Boolean(entry.pivot);
        }
        if (entry.pivotIndex !== undefined) {
            state.pivotIndex = entry.pivotIndex ?? null;
        }
    }

    #shownForGroup(leaf: LeafColumn<TData>): boolean {
        if (!leaf.showWhen || leaf.groupPath.length === 0) {
            return true;
        }
        const groupId = leaf.groupPath[leaf.groupPath.length - 1]!;
        if (!this.isGroupExpandable(groupId)) {
            return true;
        }
        const open = this.#groupOpen.get(groupId) ?? false;

        return leaf.showWhen === 'open' ? open : !open;
    }

    /** Locked columns stay at their current index (`left` locks to the start, `right` to the end). */
    #respectLocks(proposed: string[]): string[] {
        const locked = proposed.filter((colId) => this.getLeaf(colId)?.def.lockPosition);
        if (locked.length === 0) {
            return proposed;
        }
        const free = proposed.filter((colId) => !locked.includes(colId));
        const result: string[] = [];
        const start = locked.filter(
            (colId) =>
                this.getLeaf(colId)!.def.lockPosition === 'left' || this.getLeaf(colId)!.def.lockPosition === true
        );
        const end = locked.filter((colId) => this.getLeaf(colId)!.def.lockPosition === 'right');
        result.push(...start, ...free, ...end);

        return result;
    }

    #marriedGroupsIntact(order: string[]): boolean {
        for (const [groupId, group] of this.#groups) {
            if (!group.marryChildren) {
                continue;
            }
            const positions = order
                .map((colId, index) => (this.getLeaf(colId)?.groupPath.includes(groupId) ? index : -1))
                .filter((index) => index >= 0);
            if (positions.length > 0 && positions[positions.length - 1]! - positions[0]! !== positions.length - 1) {
                return false;
            }
        }

        return true;
    }
}

function withoutUndefined<T extends object>(entry: T): Partial<T> {
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function normalisePinned(pinned: ColumnState['pinned']): PinnedSide | null {
    if (pinned === true) {
        return 'left';
    }

    return pinned === 'left' || pinned === 'right' ? pinned : null;
}

function defaultsFor<TData>(def: ColumnDef<TData>): LiveState {
    return {
        hide: def.hide ?? false,
        pinned: def.pinned ?? null,
        width: null,
        flex: def.flex && def.flex > 0 ? def.flex : null,
        sort: def.sort ?? null,
        sortIndex: null,
        rowGroup: def.rowGroup ?? false,
        rowGroupIndex: def.rowGroup ? (def.rowGroupIndex ?? 0) : null,
        aggFunc: def.aggFunc ?? null,
        pivot: false,
        pivotIndex: null,
    };
}

/** Reads a dotted field path ("location.city.name"). */
export function readField(data: unknown, field: string): unknown {
    let current: unknown = data;
    for (const part of field.split('.')) {
        if (current === null || current === undefined) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }

    return current;
}

/** Writes a dotted field path in place, creating intermediate objects. Returns false when unchanged. */
export function writeField(data: unknown, field: string, value: unknown): boolean {
    const parts = field.split('.');
    let current = data as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
        if (current[part] === null || typeof current[part] !== 'object') {
            current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1]!;
    if (Object.is(current[last], value)) {
        return false;
    }
    current[last] = value;

    return true;
}

/** Default display text: empty for null and undefined, joined arrays, labels or names of objects. */
export function defaultFormat(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (Array.isArray(value)) {
        return value.map(defaultFormat).filter(Boolean).join(', ');
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const key of ['label', 'name', 'title']) {
            if (typeof record[key] === 'string') {
                return record[key] as string;
            }
        }

        return '';
    }

    return String(value);
}

/** One collator for every text comparison: `localeCompare` with options re-parses them on each call. */
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Nulls last; numbers numerically; strings with locale and numeric collation; everything else as text. */
export function defaultComparator(a: unknown, b: unknown): number {
    const emptyA = a === null || a === undefined || a === '';
    const emptyB = b === null || b === undefined || b === '';
    if (emptyA || emptyB) {
        return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
    }
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() - b.getTime();
    }

    return TEXT_COLLATOR.compare(
        typeof a === 'string' ? a : defaultFormat(a),
        typeof b === 'string' ? b : defaultFormat(b)
    );
}

function resolveColumn<TData>(leaf: LeafColumn<TData>, groupLabel: (groupId: string) => string): ResolvedColumn<TData> {
    const { def } = leaf;
    const field = def.field;
    const column = {} as ResolvedColumn<TData>;
    const params = (row: RowWithData<TData>) => ({ row, data: row.data, column, context: undefined });

    const getValue = (row: RowWithData<TData>): unknown => {
        if (typeof def.valueGetter === 'function') {
            return def.valueGetter(params(row));
        }

        return field ? readField(row.data, field) : undefined;
    };
    const formatValue = (row: RowWithData<TData>, value: unknown): string =>
        typeof def.valueFormatter === 'function' ? def.valueFormatter({ ...params(row), value }) : defaultFormat(value);
    const setValue =
        typeof def.valueSetter === 'function' || field
            ? (row: DataRow<TData>, value: unknown): boolean => {
                  if (typeof def.valueSetter === 'function') {
                      const oldValue = getValue(row);

                      return def.valueSetter({ ...params(row), oldValue, newValue: value });
                  }

                  return writeField(row.data, field!, value);
              }
            : undefined;
    const isEditable = (row: GridRow<TData>): boolean => {
        if (row.kind !== 'data' || !hasData(row)) {
            return false;
        }
        if (typeof def.editable === 'function') {
            return def.editable(params(row));
        }

        return def.editable === true;
    };
    const cellClasses = (row: RowWithData<TData>, value: unknown): string[] => {
        const classes: string[] = [];
        const add = (entry: string | string[] | undefined) => {
            if (Array.isArray(entry)) {
                classes.push(...entry);
            } else if (entry) {
                classes.push(...entry.split(/\s+/).filter(Boolean));
            }
        };
        if (typeof def.cellClass === 'function') {
            add(def.cellClass({ ...params(row), value }));
        } else {
            add(def.cellClass);
        }

        return classes;
    };

    Object.assign(column, {
        colId: leaf.colId,
        def,
        field,
        headerName: def.headerName ?? (field ? startCase(field) : leaf.colId),
        groupPath: leaf.groupPath,
        getValue,
        formatValue,
        setValue,
        isEditable,
        cellClasses,
        renderer: typeof def.cellRenderer === 'function' ? def.cellRenderer : undefined,
        editor: typeof def.cellEditor === 'function' ? def.cellEditor : undefined,
        comparator: typeof def.comparator === 'function' ? def.comparator : defaultComparator,
    } satisfies Partial<ResolvedColumn<TData>>);
    void groupLabel;

    return column;
}

/** "location.cityName" to "Location City Name"'s default header names. */
function startCase(field: string): string {
    return field
        .split('.')
        .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/))
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}
