/**
 * Local (in-memory) row projection: turns rows that are already filtered and sorted into the displayed
 * list, with grouping, tree data, master/detail and full-width rows as explicit row kinds.
 *
 * Everything is computed from data and state, never from the DOM, so lookups answer the same for mounted
 * and offscreen rows. Rows below a collapsed parent are still part of the projection (`getRow` finds them)
 * but are not displayed (`getIndexOf` returns undefined).
 *
 * Row objects are reused from `previous` when nothing about the row changed, so renderers can skip work
 * by reference equality.
 */
import type {
    DataRow,
    DetailRow,
    DisplayedRow,
    FullWidthRow,
    GetDataPath,
    GetRowId,
    GridRow,
    GroupRow,
    RowId,
} from '../contract/rows';
import { createIdResolver } from './getRowId';
import { detailRowId, groupRowId, InvalidRowIdError, routeKey, treeFillerRowId, type GroupKey } from './ids';

/** Column id used for tree ancestors that have no data row of their own. */
export const TREE_GROUP_COLUMN = '__tree';

/**
 * Which rows start expanded when the state has no entry for them. `true`/`false` for all, a number to
 * expand levels below it (-1 means every level), or a predicate.
 */
export type DefaultExpanded<TData> = boolean | number | ((row: GridRow<TData>) => boolean);

export type LocalProjectionInput<TData> = {
    /** Rows in display order: filtering and sorting have already been applied. */
    rows: readonly TData[];
    getRowId?: GetRowId<TData>;
    /** Row grouping by column values. Mutually exclusive with `getDataPath`. */
    grouping?: { colIds: readonly string[]; getKey: (data: TData, colId: string) => GroupKey };
    /** Tree data: the path of each row from the root. */
    getDataPath?: GetDataPath<TData>;
    /** Explicit expand/collapse state by row id. Rows without an entry follow `defaultExpanded`. */
    expansion?: ReadonlyMap<RowId, boolean>;
    defaultExpanded?: DefaultExpanded<TData>;
    /** Master rows get a detail row below them while expanded. Not combinable with tree data. */
    isMaster?: (data: TData) => boolean;
    isFullWidth?: (data: TData) => boolean;
    previous?: LocalProjection<TData>;
};

type Node<TData> = {
    row: GridRow<TData>;
    data: TData | null;
    children: Node<TData>[];
    leafCount: number;
    master: boolean;
};

export class LocalProjection<TData> {
    readonly #displayed: GridRow<TData>[];
    readonly #all: GridRow<TData>[];
    readonly #byId: Map<RowId, GridRow<TData>>;
    readonly #indexById: Map<RowId, number>;
    readonly #expandedIds: ReadonlySet<RowId>;

    constructor(displayed: GridRow<TData>[], all: GridRow<TData>[], expandedIds: ReadonlySet<RowId>) {
        this.#displayed = displayed;
        this.#all = all;
        this.#expandedIds = expandedIds;
        this.#byId = new Map(all.map((row) => [row.id, row]));
        this.#indexById = new Map(displayed.map((row, index) => [row.id, index]));
    }

    /** Ids of every expanded row after defaults were applied. Store this as the new expansion state. */
    get expandedIds(): ReadonlySet<RowId> {
        return this.#expandedIds;
    }

    getRowCount(): number {
        return this.#displayed.length;
    }

    getRowAtIndex(index: number): DisplayedRow<TData> | undefined {
        const row = this.#displayed[index];

        return row ? { row, index } : undefined;
    }

    /** Any row in the projection, including rows below collapsed parents. */
    getRow(id: RowId): GridRow<TData> | undefined {
        return this.#byId.get(id);
    }

    /** Displayed index, or undefined when the row is below a collapsed parent or not in the projection. */
    getIndexOf(id: RowId): number | undefined {
        return this.#indexById.get(id);
    }

    forEachRow(
        callback: (row: GridRow<TData>, index: number | undefined) => void,
        options?: { includeCollapsed?: boolean }
    ): void {
        if (options?.includeCollapsed) {
            for (const row of this.#all) {
                callback(row, this.#indexById.get(row.id));
            }
            return;
        }
        this.#displayed.forEach((row, index) => callback(row, index));
    }

    /** Displayed rows in order. Read only. */
    get displayedRows(): readonly GridRow<TData>[] {
        return this.#displayed;
    }
}

export function buildLocalProjection<TData>(input: LocalProjectionInput<TData>): LocalProjection<TData> {
    if (input.grouping && input.getDataPath) {
        throw new Error('Local projection: grouping and tree data (getDataPath) cannot be combined.');
    }
    if (input.isMaster && input.getDataPath) {
        throw new Error('Local projection: master/detail and tree data (getDataPath) cannot be combined.');
    }

    const roots = input.getDataPath
        ? buildTree(input, input.getDataPath)
        : input.grouping && input.grouping.colIds.length > 0
          ? buildGroups(input, input.grouping)
          : buildFlat(input);

    return emit(roots, input);
}

function leafRow<TData>(
    input: LocalProjectionInput<TData>,
    id: RowId,
    data: TData,
    level: number,
    parentId: RowId | null
): Node<TData> {
    if (input.isFullWidth?.(data)) {
        const row: FullWidthRow<TData> = { kind: 'fullWidth', id, section: 'body', level, parentId, data };

        return { row, data, children: [], leafCount: 1, master: false };
    }
    const row: DataRow<TData> = { kind: 'data', id, section: 'body', level, parentId, data };

    return { row, data, children: [], leafCount: 1, master: input.isMaster?.(data) ?? false };
}

function buildFlat<TData>(input: LocalProjectionInput<TData>): Node<TData>[] {
    const ids = createIdResolver(input.getRowId, 'Local projection');

    return input.rows.map((data) => leafRow(input, ids.resolve(data, null, 0), data, 0, null));
}

function buildGroups<TData>(
    input: LocalProjectionInput<TData>,
    grouping: NonNullable<LocalProjectionInput<TData>['grouping']>
): Node<TData>[] {
    const ids = createIdResolver(input.getRowId, 'Local projection');
    const roots: Node<TData>[] = [];
    const childMaps = new Map<Node<TData> | null, Map<string, Node<TData>>>([[null, new Map()]]);
    const depth = grouping.colIds.length;

    for (const data of input.rows) {
        let parent: Node<TData> | null = null;
        let siblings = roots;
        const keyPath: GroupKey[] = [];
        for (let level = 0; level < depth; level++) {
            const colId = grouping.colIds[level]!;
            const key = grouping.getKey(data, colId);
            keyPath.push(key);
            const map: Map<string, Node<TData>> = childMaps.get(parent)!;
            const mapKey = routeKey([key]);
            let node: Node<TData> | undefined = map.get(mapKey);
            if (!node) {
                const row: GroupRow<TData> = {
                    kind: 'group',
                    id: groupRowId(grouping.colIds, keyPath),
                    section: 'body',
                    level,
                    parentId: parent?.row.id ?? null,
                    groupColId: colId,
                    key,
                    keyPath: [...keyPath],
                    childCount: 0,
                    expanded: false,
                    data: null,
                };
                node = { row, data: null, children: [], leafCount: 0, master: false };
                map.set(mapKey, node);
                childMaps.set(node, new Map());
                siblings.push(node);
            }
            node.leafCount++;
            parent = node;
            siblings = node.children;
        }
        siblings.push(leafRow(input, ids.resolve(data, parent!.row.id, depth), data, depth, parent!.row.id));
    }

    return roots;
}

function buildTree<TData>(input: LocalProjectionInput<TData>, getDataPath: GetDataPath<TData>): Node<TData>[] {
    const ids = createIdResolver(input.getRowId, 'Local projection');
    const roots: Node<TData>[] = [];
    const byPath = new Map<string, Node<TData>>();

    const ensure = (path: string[]): Node<TData> => {
        const key = routeKey(path);
        const existing = byPath.get(key);
        if (existing) {
            return existing;
        }
        const parent = path.length > 1 ? ensure(path.slice(0, -1)) : null;
        const row: GroupRow<TData> = {
            kind: 'group',
            id: treeFillerRowId(path),
            section: 'body',
            level: path.length - 1,
            parentId: parent?.row.id ?? null,
            groupColId: TREE_GROUP_COLUMN,
            key: path[path.length - 1]!,
            keyPath: [...path],
            childCount: 0,
            expanded: false,
            data: null,
        };
        const node: Node<TData> = { row, data: null, children: [], leafCount: 0, master: false };
        byPath.set(key, node);
        (parent ? parent.children : roots).push(node);

        return node;
    };

    for (const data of input.rows) {
        const path = getDataPath(data);
        if (path.length === 0) {
            throw new InvalidRowIdError('Local projection: getDataPath returned an empty path.');
        }
        const key = routeKey(path);
        const parent = path.length > 1 ? ensure(path.slice(0, -1)) : null;
        const level = path.length - 1;
        const parentId = parent?.row.id ?? null;
        const existing = byPath.get(key);
        if (existing && existing.data !== null) {
            throw new InvalidRowIdError(`Local projection: two rows share the tree path ${key}.`);
        }
        const leaf = leafRow(input, ids.resolve(data, parentId, level), data, level, parentId);
        if (existing) {
            // A filler created for an earlier descendant becomes this data row; its children move over.
            leaf.children = existing.children;
            for (const child of leaf.children) {
                child.row = { ...child.row, parentId: leaf.row.id };
            }
            const siblings = parent ? parent.children : roots;
            siblings[siblings.indexOf(existing)] = leaf;
        } else {
            (parent ? parent.children : roots).push(leaf);
        }
        byPath.set(key, leaf);
    }

    const countLeaves = (node: Node<TData>): number => {
        const below = node.children.reduce((sum, child) => sum + countLeaves(child), 0);
        node.leafCount = node.data === null ? below : 1 + below;

        return node.leafCount;
    };
    roots.forEach(countLeaves);

    return roots;
}

function isExpanded<TData>(input: LocalProjectionInput<TData>, row: GridRow<TData>): boolean {
    const explicit = input.expansion?.get(row.id);
    if (explicit !== undefined) {
        return explicit;
    }
    const rule = input.defaultExpanded ?? false;
    if (typeof rule === 'boolean') {
        return rule;
    }
    if (typeof rule === 'number') {
        return rule < 0 || row.level < rule;
    }

    return rule(row);
}

/** Returns the previous row object when it is equivalent, so unchanged rows keep their identity. */
function reuse<TData>(previous: LocalProjection<TData> | undefined, next: GridRow<TData>): GridRow<TData> {
    const old = previous?.getRow(next.id);
    if (!old || old.kind !== next.kind || old.level !== next.level || old.parentId !== next.parentId) {
        return next;
    }
    switch (next.kind) {
        case 'group': {
            const prior = old as GroupRow<TData>;

            return prior.expanded === next.expanded &&
                prior.childCount === next.childCount &&
                prior.data === next.data &&
                prior.groupColId === next.groupColId &&
                prior.key === next.key
                ? prior
                : next;
        }
        case 'data': {
            const prior = old as DataRow<TData>;

            return prior.data === next.data && prior.expandable?.expanded === next.expandable?.expanded ? prior : next;
        }
        case 'detail':
        case 'fullWidth':
            return (old as DetailRow<TData> | FullWidthRow<TData>).data === next.data ? old : next;
        default:
            return next;
    }
}

function emit<TData>(roots: Node<TData>[], input: LocalProjectionInput<TData>): LocalProjection<TData> {
    const displayed: GridRow<TData>[] = [];
    const all: GridRow<TData>[] = [];
    const expandedIds = new Set<RowId>();

    const visit = (node: Node<TData>, visible: boolean): void => {
        let row = node.row;
        const expandable = node.children.length > 0 || node.master;
        let expanded = false;
        // The default-expansion predicate sees the finished row (child count filled in), not a draft.
        if (row.kind === 'group') {
            row = { ...row, childCount: node.leafCount };
            expanded = isExpanded(input, row);
            row = { ...row, expanded };
        } else if (row.kind === 'data' && expandable) {
            row = { ...row, expandable: { expanded: false } };
            expanded = isExpanded(input, row);
            row = { ...row, expandable: { expanded } };
        }
        if (expanded) {
            expandedIds.add(row.id);
        }
        row = reuse(input.previous, row);
        all.push(row);
        if (visible) {
            displayed.push(row);
        }

        const childrenVisible = visible && expanded;
        if (node.master && node.data !== null) {
            const detail: DetailRow<TData> = {
                kind: 'detail',
                id: detailRowId(row.id),
                section: 'body',
                level: row.level + 1,
                parentId: row.id,
                masterId: row.id,
                data: node.data,
            };
            const detailRow = reuse(input.previous, detail);
            // A collapsed master has no detail row at all; details are created on expand.
            if (expanded) {
                all.push(detailRow);
                if (childrenVisible) {
                    displayed.push(detailRow);
                }
            }
        }
        for (const child of node.children) {
            visit(child, childrenVisible);
        }
    };
    roots.forEach((root) => visit(root, true));

    return new LocalProjection(displayed, all, expandedIds);
}
