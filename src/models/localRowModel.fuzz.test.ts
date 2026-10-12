/**
 * Differential fuzz test of LocalRowModel against a plain reference model written from the specs in
 * localRowModel.ts, src/rows/localProjection.ts and src/contract/data-source.ts.
 *
 * The reference keeps an array of row data and recomputes the displayed list from scratch after every
 * operation: rows, then the filter (filter model AND quick filter words AND search words), then a stable
 * sort, then `sortRows`, then grouping by the rowGroup columns. Groups appear in first-appearance order of
 * the sorted rows, with their leaves below them in that same order.
 *
 * A seeded PRNG drives everything. On failure the operation list is shrunk to a minimal case, which is
 * printed in the assertion message.
 */
import { describe, expect, it } from 'vitest';

import type { ColumnDefinition, ColumnState, FilterModel, GridRow, QueryState, SortModel } from '../contract';
import { ColumnModel } from '../grid/columns';
import { LocalRowModel, type LocalRowModelOptions } from './localRowModel';

// Seeded PRNG (mulberry32)

function createRandom(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
    const chance = (probability: number): boolean => next() < probability;
    const subset = <T>(items: readonly T[], max = items.length): T[] => {
        const copy = [...items];
        const result: T[] = [];
        const count = int(0, Math.min(max, copy.length));
        for (let i = 0; i < count; i++) {
            result.push(copy.splice(int(0, copy.length - 1), 1)[0]!);
        }

        return result;
    };

    return { next, int, pick, chance, subset };
}

type Random = ReturnType<typeof createRandom>;

// Data and columns

type Item = { id: number; a?: string | null; b?: number | null; c?: string | null };

const A_VALUES = ['alpha', 'Bravo', 'charlie', 'alp', 'delta 2', 'delta 10', 'ALPHA', '', null, undefined];
const B_VALUES = [1, 2, 2, 10, -3, 0, 2.5, null, undefined];
const C_VALUES = ['red', 'Red', 'blue', 'green', '', null, undefined];

/** Plain descriptions of the columns, so the reference reads values without going through ColumnModel. */
type ColumnSpec = {
    colId: string;
    field?: keyof Item;
    getter?: (data: Item) => unknown;
    formatter?: (value: unknown) => string;
    comparator?: (a: unknown, b: unknown) => number;
};

const COLUMN_POOL: ColumnSpec[] = [
    { colId: 'id', field: 'id' },
    { colId: 'a', field: 'a' },
    { colId: 'b', field: 'b' },
    { colId: 'c', field: 'c' },
    { colId: 'calc', getter: (data) => (data.b === null || data.b === undefined ? null : data.b * 2) },
    { colId: 'label', getter: (data) => `${data.a ?? ''}${data.c ?? ''}` },
    {
        colId: 'bfmt',
        field: 'b',
        formatter: (value) => (value === null || value === undefined ? '' : `n${String(value)}x`),
    },
    {
        colId: 'alen',
        field: 'a',
        comparator: (x, y) => String(x).length - String(y).length,
    },
    { colId: 'cblank', field: 'c', formatter: () => '' },
];

function toDefinition(spec: ColumnSpec, hide: boolean): ColumnDefinition<Item> {
    const definition: Record<string, unknown> = { colId: spec.colId, hide };
    if (spec.field) {
        definition.field = spec.field;
    }
    if (spec.getter) {
        const getter = spec.getter;
        definition.valueGetter = (params: { data: Item }) => getter(params.data);
    }
    if (spec.formatter) {
        const formatter = spec.formatter;
        definition.valueFormatter = (params: { value: unknown }) => formatter(params.value);
    }
    if (spec.comparator) {
        definition.comparator = spec.comparator;
    }

    return definition as ColumnDefinition<Item>;
}

function refValue(spec: ColumnSpec, data: Item): unknown {
    if (spec.getter) {
        return spec.getter(data);
    }

    return spec.field ? data[spec.field] : undefined;
}

function refFormat(spec: ColumnSpec, value: unknown): string {
    if (spec.formatter) {
        return spec.formatter(value);
    }

    return value === null || value === undefined ? '' : String(value);
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === '';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function refCompare(spec: ColumnSpec, a: unknown, b: unknown): number {
    if (spec.comparator) {
        return spec.comparator(a, b);
    }
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }

    return collator.compare(refFormat({ colId: '' }, a), refFormat({ colId: '' }, b));
}

// Reference filter model: a small subset of the built-in kinds (the filter engine has its own fuzz test).

type RefCondition =
    | { filterType: 'text'; type: 'contains'; filter: string }
    | { filterType: 'number'; type: 'greaterThan'; filter: number }
    | { filterType: 'set'; values: (string | null)[] };

function refConditionMatches(condition: RefCondition, value: unknown): boolean {
    switch (condition.filterType) {
        case 'text':
            return (value === null || value === undefined ? '' : String(value))
                .trim()
                .toLowerCase()
                .includes(condition.filter.toLowerCase());
        case 'number':
            return typeof value === 'number' && value > condition.filter;
        case 'set': {
            const blank = value === null || value === undefined || value === '';
            if (condition.values.length === 0) {
                return false;
            }
            if (blank) {
                return condition.values.includes(null);
            }

            return condition.values.some(
                (entry) => entry !== null && entry.toLowerCase() === String(value).toLowerCase()
            );
        }
    }
}

// Reference model

type SortRowsName = 'none' | 'blueFirst' | 'reverse';
const SORT_ROWS: Record<Exclude<SortRowsName, 'none'>, (rows: readonly Item[]) => readonly Item[]> = {
    blueFirst: (rows) => [...rows.filter((row) => row.c === 'blue'), ...rows.filter((row) => row.c !== 'blue')],
    reverse: (rows) => [...rows].reverse(),
};

type DefaultExpanded = boolean | number | undefined;

type RefRow = {
    id: string;
    kind: 'data' | 'group';
    level: number;
    parentId: string | null;
    data?: Item;
    key?: string | null;
    childCount?: number;
    expanded?: boolean;
};

type RefState = {
    rows: Item[];
    lastGivenRows: readonly Item[];
    quickFilter: string;
    sortRows: SortRowsName;
    query: { sortModel: SortModel; filterModel: Record<string, RefCondition>; search: string };
    groupColIds: string[];
    expansion: Map<string, boolean>;
};

function groupId(colIds: readonly string[], keyPath: readonly (string | null)[]): string {
    return `group:${JSON.stringify(colIds.slice(0, keyPath.length))}:${JSON.stringify(keyPath)}`;
}

function computeReference(
    state: RefState,
    columns: ColumnSpec[],
    hidden: Set<string>,
    defaultExpanded: DefaultExpanded
) {
    const byId = new Map(columns.map((spec) => [spec.colId, spec]));
    const displayed = columns.filter((spec) => !hidden.has(spec.colId));
    const words = [
        ...state.quickFilter.toLowerCase().split(/\s+/),
        ...state.query.search.toLowerCase().split(/\s+/),
    ].filter((word) => word !== '');
    const conditions = Object.entries(state.query.filterModel).filter(([colId]) => byId.has(colId));
    const isFiltered = conditions.length > 0 || words.length > 0;

    const passes = (data: Item): boolean => {
        for (const [colId, condition] of conditions) {
            if (!refConditionMatches(condition, refValue(byId.get(colId)!, data))) {
                return false;
            }
        }
        for (const word of words) {
            const found = displayed.some((spec) => refFormat(spec, refValue(spec, data)).toLowerCase().includes(word));
            if (!found) {
                return false;
            }
        }

        return true;
    };
    const filtered = state.rows.filter(passes);
    const filteredOut = state.rows.filter((data) => !passes(data));

    // Stable sort: insertion sort by the sort columns in priority order, ties keep the filtered order.
    const sorters = state.query.sortModel
        .filter((item) => byId.has(item.colId))
        .map((item) => ({ spec: byId.get(item.colId)!, direction: item.sort === 'desc' ? -1 : 1 }));
    const sorted: Item[] = [];
    const before = (x: Item, y: Item): boolean => {
        for (const sorter of sorters) {
            const vx = refValue(sorter.spec, x);
            const vy = refValue(sorter.spec, y);
            if (isEmpty(vx) && isEmpty(vy)) {
                continue;
            }
            if (isEmpty(vx) !== isEmpty(vy)) {
                return isEmpty(vy);
            }
            const result = refCompare(sorter.spec, vx, vy) * sorter.direction;
            if (result !== 0) {
                return result < 0;
            }
        }

        return false;
    };
    for (const data of filtered) {
        let position = sorted.length;
        while (position > 0 && before(data, sorted[position - 1]!)) {
            position--;
        }
        sorted.splice(position, 0, data);
    }
    const ordered = state.sortRows === 'none' ? sorted : [...SORT_ROWS[state.sortRows](sorted)];

    const isExpanded = (row: RefRow): boolean => {
        const explicit = state.expansion.get(row.id);
        if (explicit !== undefined) {
            return explicit;
        }
        if (typeof defaultExpanded === 'number') {
            return defaultExpanded < 0 || row.level < defaultExpanded;
        }

        return defaultExpanded ?? false;
    };

    const visible: RefRow[] = [];
    const all: RefRow[] = [];
    const groupColIds = state.groupColIds.filter(() => true);
    if (groupColIds.length === 0) {
        for (const data of ordered) {
            const row: RefRow = { id: String(data.id), kind: 'data', level: 0, parentId: null, data };
            visible.push(row);
            all.push(row);
        }
    } else {
        type Group = { row: RefRow; groups: Group[]; leaves: Item[]; byKey: Map<string, Group>; count: number };
        const root: Group = { row: undefined as never, groups: [], leaves: [], byKey: new Map(), count: 0 };
        for (const data of ordered) {
            let parent = root;
            const keyPath: (string | null)[] = [];
            groupColIds.forEach((colId, level) => {
                const spec = byId.get(colId);
                let key: string | null = null;
                if (spec) {
                    const value = refValue(spec, data);
                    key = isEmpty(value) ? null : refFormat(spec, value) || String(value);
                }
                keyPath.push(key);
                const mapKey = JSON.stringify(key);
                let group = parent.byKey.get(mapKey);
                if (!group) {
                    group = {
                        row: {
                            id: groupId(groupColIds, keyPath),
                            kind: 'group',
                            level,
                            parentId: parent === root ? null : parent.row.id,
                            key,
                        },
                        groups: [],
                        leaves: [],
                        byKey: new Map(),
                        count: 0,
                    };
                    parent.byKey.set(mapKey, group);
                    parent.groups.push(group);
                }
                group.count++;
                parent = group;
            });
            parent.leaves.push(data);
        }
        const visit = (group: Group, shown: boolean): void => {
            const row: RefRow = { ...group.row, childCount: group.count };
            row.expanded = isExpanded(row);
            all.push(row);
            if (shown) {
                visible.push(row);
            }
            for (const child of group.groups) {
                visit(child, shown && row.expanded);
            }
            for (const data of group.leaves) {
                const leaf: RefRow = {
                    id: String(data.id),
                    kind: 'data',
                    level: groupColIds.length,
                    parentId: row.id,
                    data,
                };
                all.push(leaf);
                if (shown && row.expanded) {
                    visible.push(leaf);
                }
            }
        };
        root.groups.forEach((group) => visit(group, true));
    }

    return { visible, all, filteredOut, isFiltered };
}

// Operations, as plain data so a failing sequence can be replayed and shrunk.

type Operation =
    | { op: 'transaction'; add?: { rows: Item[]; index?: number }; update?: Item[]; remove?: string[] }
    | { op: 'patch'; updates: { id: string; data: Item }[] }
    | { op: 'setRows'; rows: Item[] }
    | { op: 'sameOptions' }
    | { op: 'quickFilter'; quickFilter: string }
    | { op: 'sortRows'; sortRows: SortRowsName }
    | { op: 'query'; sortModel: SortModel; filterModel: Record<string, RefCondition>; search: string }
    | { op: 'group'; colIds: string[] }
    | { op: 'expand'; id: string; expanded: boolean }
    | { op: 'refresh' };

type Case = {
    initialRows: Item[];
    columns: { spec: ColumnSpec; hide: boolean }[];
    defaultExpanded: DefaultExpanded;
    quickFilter: string;
    sortRows: SortRowsName;
    operations: Operation[];
};

let nextId = 1;

function randomItem(random: Random, id = nextId++): Item {
    const item: Item = { id };
    if (random.chance(0.9)) {
        item.a = random.pick(A_VALUES) as string | null;
    }
    if (random.chance(0.9)) {
        item.b = random.pick(B_VALUES) as number | null;
    }
    if (random.chance(0.9)) {
        item.c = random.pick(C_VALUES) as string | null;
    }

    return item;
}

const WORDS = ['al', 'ALP', 'red', 'n2', 'delta', '1', 'e', 'x', 'Bravo', 'blue'];

function randomWords(random: Random): string {
    if (random.chance(0.5)) {
        return '';
    }

    return random
        .subset(WORDS, 2)
        .map((word) => (random.chance(0.3) ? ` ${word} ` : word))
        .join(random.pick([' ', '  ', '\t']));
}

function randomQuery(random: Random, colIds: string[]): Extract<Operation, { op: 'query' }> {
    const sortCols = random.subset([...colIds, 'unknown'], 3);
    const sortModel: SortModel = sortCols.map((colId) => ({ colId, sort: random.chance(0.5) ? 'asc' : 'desc' }));
    const filterModel: Record<string, RefCondition> = {};
    if (random.chance(0.4)) {
        filterModel[random.pick(['a', 'label', 'c', 'unknown'])] = {
            filterType: 'text',
            type: 'contains',
            filter: random.pick(['a', 'red', 'ALP', 'e', 'zz']),
        };
    }
    if (random.chance(0.3)) {
        filterModel[random.pick(['b', 'calc'])] = {
            filterType: 'number',
            type: 'greaterThan',
            filter: random.pick([0, 1, 2, 5]),
        };
    }
    if (random.chance(0.3)) {
        filterModel.c = { filterType: 'set', values: random.subset(['red', 'BLUE', 'green', null], 3) };
    }

    return { op: 'query', sortModel, filterModel, search: randomWords(random) };
}

function generateCase(random: Random): Case {
    nextId = 1;
    const columns = random.subset(COLUMN_POOL).map((spec) => ({ spec, hide: random.chance(0.25) }));
    if (columns.length === 0) {
        columns.push({ spec: COLUMN_POOL[1]!, hide: false });
    }
    const colIds = columns.map((column) => column.spec.colId);
    const initialRows = Array.from({ length: random.int(0, 14) }, () => randomItem(random));
    const defaultExpanded = random.pick<DefaultExpanded>([undefined, true, false, 0, 1, -1]);
    const quickFilter = random.chance(0.2) ? randomWords(random) : '';
    const sortRows = random.pick<SortRowsName>(['none', 'none', 'blueFirst', 'reverse']);

    // Track ids and group ids loosely so operations mostly hit existing rows.
    let ids = initialRows.map((row) => String(row.id));
    let currentRows = [...initialRows];
    const operations: Operation[] = [];
    const count = random.int(1, 25);
    for (let i = 0; i < count; i++) {
        const kind = random.pick([
            'transaction',
            'transaction',
            'patch',
            'setRows',
            'sameOptions',
            'quickFilter',
            'sortRows',
            'query',
            'query',
            'group',
            'expand',
            'expand',
            'refresh',
        ]);
        switch (kind) {
            case 'transaction': {
                const remove = random.subset(ids, 2);
                const remaining = ids.filter((id) => !remove.includes(id));
                const update = random.subset(remaining, 2).map((id) => randomItem(random, Number(id)));
                if (random.chance(0.2)) {
                    update.push(randomItem(random, 9000 + random.int(0, 50)));
                }
                const addRows = random.chance(0.6)
                    ? Array.from({ length: random.int(1, 3) }, () => randomItem(random))
                    : [];
                const operation: Operation = { op: 'transaction' };
                if (remove.length || random.chance(0.5)) {
                    operation.remove = remove;
                }
                if (update.length) {
                    operation.update = update;
                }
                if (addRows.length) {
                    operation.add = random.chance(0.6)
                        ? { rows: addRows, index: random.int(0, remaining.length + 2) }
                        : { rows: addRows };
                }
                operations.push(operation);
                currentRows = currentRows.filter((row) => !remove.includes(String(row.id)));
                const updates = new Map(update.map((row) => [String(row.id), row]));
                currentRows = currentRows.map((row) => updates.get(String(row.id)) ?? row);
                currentRows.push(...addRows);
                ids = currentRows.map((row) => String(row.id));
                break;
            }
            case 'patch': {
                const targets = random.subset(ids, 2);
                if (random.chance(0.2)) {
                    targets.push('8888');
                }
                const updates = targets.map((id) => ({ id, data: randomItem(random, Number(id)) }));
                operations.push({ op: 'patch', updates });
                const byId = new Map(updates.map((update) => [update.id, update.data]));
                currentRows = currentRows.map((row) => byId.get(String(row.id)) ?? row);
                break;
            }
            case 'setRows': {
                const kept = random.subset(currentRows);
                const fresh = Array.from({ length: random.int(0, 5) }, () => randomItem(random));
                const rows = [...kept, ...fresh];
                // Shuffle a little.
                for (let j = rows.length - 1; j > 0; j--) {
                    if (random.chance(0.3)) {
                        const k = random.int(0, j);
                        [rows[j], rows[k]] = [rows[k]!, rows[j]!];
                    }
                }
                operations.push({ op: 'setRows', rows });
                currentRows = [...rows];
                ids = currentRows.map((row) => String(row.id));
                break;
            }
            case 'sameOptions':
                operations.push({ op: 'sameOptions' });
                break;
            case 'quickFilter':
                operations.push({ op: 'quickFilter', quickFilter: randomWords(random) });
                break;
            case 'sortRows':
                operations.push({ op: 'sortRows', sortRows: random.pick(['none', 'blueFirst', 'reverse']) });
                break;
            case 'query':
                operations.push(randomQuery(random, colIds));
                break;
            case 'group':
                operations.push({ op: 'group', colIds: random.subset([...colIds, 'unknown'], 2) });
                break;
            case 'expand': {
                // Group ids are not tracked here; expand by an id taken from the model at run time.
                operations.push({
                    op: 'expand',
                    id: random.chance(0.8) ? `@${random.int(0, 30)}` : random.pick(ids.length ? ids : ['1']),
                    expanded: random.chance(0.5),
                });
                break;
            }
            case 'refresh':
                operations.push({ op: 'refresh' });
                break;
        }
    }

    return { initialRows, columns, defaultExpanded, quickFilter, sortRows, operations };
}

// Runner

const fullQuery = (operation: Extract<Operation, { op: 'query' }>): QueryState => ({
    sortModel: operation.sortModel,
    filterModel: operation.filterModel as unknown as FilterModel,
    search: operation.search,
    externalFilters: {},
    rowGroupColIds: [],
});

function describeRow(row: GridRow<Item>) {
    return { id: row.id, kind: row.kind, level: row.level, parentId: row.parentId };
}

/** Runs one case and throws on the first difference. Returns the number of comparisons made. */
function runCase(testCase: Case, checks: { includeFilteredAlone: boolean }): number {
    const columnModel = new ColumnModel<Item>(testCase.columns.map((column) => toDefinition(column.spec, column.hide)));
    const specs = testCase.columns.map((column) => column.spec);
    const hidden = new Set(testCase.columns.filter((column) => column.hide).map((column) => column.spec.colId));
    let options: LocalRowModelOptions<Item> = {
        rows: testCase.initialRows,
        quickFilter: testCase.quickFilter,
        ...(testCase.sortRows !== 'none' ? { sortRows: SORT_ROWS[testCase.sortRows] } : {}),
        ...(testCase.defaultExpanded !== undefined ? { expandedByDefault: testCase.defaultExpanded } : {}),
    };
    const model = new LocalRowModel<Item>(options, {
        getResolved: (colId) => columnModel.getResolved(colId),
        displayedColIds: () => columnModel.getDisplayedLeaves().map((leaf) => leaf.colId),
    });
    const state: RefState = {
        rows: [...testCase.initialRows],
        lastGivenRows: testCase.initialRows,
        quickFilter: testCase.quickFilter,
        sortRows: testCase.sortRows,
        query: { sortModel: [], filterModel: {}, search: '' },
        groupColIds: [],
        expansion: new Map(),
    };

    let comparisons = 0;
    let previous: {
        version: number;
        source: unknown;
        signature: string;
        rows: Map<string, GridRow<Item>>;
    } | null = null;

    const compare = (step: string) => {
        const reference = computeReference(state, specs, hidden, testCase.defaultExpanded);
        const where = (what: string) => `${step}: ${what}`;

        // Displayed rows, in order, with kind, level, parent and data identity.
        const actual: GridRow<Item>[] = [];
        model.forEachRow((row, index) => {
            expect(index, where('forEachRow index')).toBe(actual.length);
            actual.push(row);
        });
        expect(actual.map(describeRow), where('displayed rows')).toEqual(
            reference.visible.map((row) => ({ id: row.id, kind: row.kind, level: row.level, parentId: row.parentId }))
        );
        reference.visible.forEach((row, index) => {
            const got = actual[index]!;
            if (row.kind === 'data') {
                expect((got as { data: Item }).data, where(`data identity of ${row.id}`)).toBe(row.data);
            } else {
                expect((got as { key: unknown }).key, where(`group key of ${row.id}`)).toBe(row.key);
                expect((got as { childCount: number }).childCount, where(`childCount of ${row.id}`)).toBe(
                    row.childCount
                );
                expect((got as { expanded: boolean }).expanded, where(`expanded of ${row.id}`)).toBe(row.expanded);
            }
            expect(model.getRowAtIndex(index)?.row.id, where(`getRowAtIndex(${index})`)).toBe(row.id);
        });
        expect(model.getRowAtIndex(reference.visible.length), where('getRowAtIndex past the end')).toBeUndefined();
        expect(model.getRowCount(), where('getRowCount')).toBe(reference.visible.length);
        expect(model.rowSource.count, where('rowSource.count')).toBe(reference.visible.length);
        expect(model.status, where('status')).toEqual(
            reference.visible.length === 0 ? { state: 'empty', reason: 'noResults' } : { state: 'ready' }
        );
        expect(model.isFiltered, where('isFiltered')).toBe(reference.isFiltered);

        // getIndexOf and getRow for every id the reference knows, including collapsed and filtered rows.
        const visibleIndex = new Map(reference.visible.map((row, index) => [row.id, index]));
        for (const row of reference.all) {
            expect(model.getIndexOf(row.id), where(`getIndexOf(${row.id})`)).toBe(visibleIndex.get(row.id));
            const got = model.getRow(row.id);
            expect(got?.id, where(`getRow(${row.id})`)).toBe(row.id);
            if (row.kind === 'data') {
                expect((got as { data: Item }).data, where(`getRow(${row.id}).data`)).toBe(row.data);
            }
        }
        for (const data of reference.filteredOut) {
            expect(model.getIndexOf(String(data.id)), where(`getIndexOf(filtered ${data.id})`)).toBeUndefined();
            expect(model.getRow(String(data.id)), where(`getRow(filtered ${data.id})`)).toBeUndefined();
        }

        // forEachRow with includeCollapsed, and with includeFiltered (filtered rows last, index undefined).
        const collect = (opts: { includeCollapsed?: boolean; includeFiltered?: boolean }) => {
            const visited: [string, number | undefined][] = [];
            model.forEachRow((row, index) => visited.push([row.id, index]), opts);

            return visited;
        };
        const expectedCollapsed = reference.all.map(
            (row) => [row.id, visibleIndex.get(row.id)] as [string, number | undefined]
        );
        const filteredTail = reference.filteredOut.map((data) => [String(data.id), undefined] as [string, undefined]);
        expect(collect({ includeCollapsed: true }), where('forEachRow includeCollapsed')).toEqual(expectedCollapsed);
        expect(
            collect({ includeCollapsed: true, includeFiltered: true }),
            where('forEachRow includeCollapsed+includeFiltered')
        ).toEqual([...expectedCollapsed, ...filteredTail]);
        if (checks.includeFilteredAlone || state.groupColIds.length === 0) {
            expect(collect({ includeFiltered: true }), where('forEachRow includeFiltered')).toEqual([
                ...reference.visible.map((row, index) => [row.id, index] as [string, number]),
                ...filteredTail,
            ]);
        }

        // version, rowSource and row identity across rebuilds.
        const signature = JSON.stringify(
            reference.all.map((row) => [
                row.id,
                row.kind,
                row.level,
                row.parentId,
                row.key,
                row.childCount,
                row.expanded,
                visibleIndex.get(row.id),
            ])
        );
        const rows = new Map<string, GridRow<Item>>();
        model.forEachRow((row) => rows.set(row.id, row), { includeCollapsed: true });
        if (previous) {
            expect(model.version, where('version never decreases')).toBeGreaterThanOrEqual(previous.version);
            const dataChanged = reference.all.some(
                (row) =>
                    row.kind === 'data' &&
                    (previous!.rows.get(row.id) as { data?: Item } | undefined)?.data !== row.data
            );
            if (signature !== previous.signature || dataChanged) {
                expect(model.version, where('version increases on a change')).toBeGreaterThan(previous.version);
                expect(model.rowSource, where('rowSource is new after a change')).not.toBe(previous.source);
            }
            for (const row of reference.all) {
                if (row.kind !== 'data') {
                    continue;
                }
                const before = previous.rows.get(row.id) as (GridRow<Item> & { data: Item }) | undefined;
                if (
                    before &&
                    before.data === row.data &&
                    before.level === row.level &&
                    before.parentId === row.parentId
                ) {
                    expect(rows.get(row.id), where(`row object reused for unchanged ${row.id}`)).toBe(before);
                }
            }
        }
        previous = { version: model.version, source: model.rowSource, signature, rows };
        comparisons++;
    };

    compare('initial');
    testCase.operations.forEach((operation, step) => {
        const label = `step ${step} ${operation.op}`;
        switch (operation.op) {
            case 'transaction': {
                model.applyTransaction({
                    ...(operation.add ? { add: operation.add } : {}),
                    ...(operation.update ? { update: operation.update } : {}),
                    ...(operation.remove ? { remove: operation.remove } : {}),
                });
                // Reference: remove by id, then update by id (unknown ids ignored), then add at index or append.
                let rows = state.rows.filter((row) => !(operation.remove ?? []).includes(String(row.id)));
                for (const update of operation.update ?? []) {
                    const at = rows.findIndex((row) => row.id === update.id);
                    if (at >= 0) {
                        rows = [...rows.slice(0, at), update, ...rows.slice(at + 1)];
                    }
                }
                if (operation.add) {
                    const index =
                        operation.add.index === undefined ? rows.length : Math.min(operation.add.index, rows.length);
                    rows = [...rows.slice(0, index), ...operation.add.rows, ...rows.slice(index)];
                }
                state.rows = rows;
                break;
            }
            case 'patch':
                model.patchRows(operation.updates);
                for (const update of operation.updates) {
                    const at = state.rows.findIndex((row) => String(row.id) === update.id);
                    if (at >= 0) {
                        state.rows = [...state.rows.slice(0, at), update.data, ...state.rows.slice(at + 1)];
                    }
                }
                break;
            case 'setRows':
                options = { ...options, rows: operation.rows };
                model.setOptions(options);
                state.rows = [...operation.rows];
                state.lastGivenRows = operation.rows;
                break;
            case 'sameOptions':
                options = { ...options };
                expect(model.setOptions(options), `${label}: unchanged options report no change`).toBe(false);
                break;
            case 'quickFilter':
                options = { ...options, quickFilter: operation.quickFilter };
                model.setOptions(options);
                state.quickFilter = operation.quickFilter;
                break;
            case 'sortRows': {
                const { sortRows: _drop, ...rest } = options;
                options = operation.sortRows === 'none' ? rest : { ...rest, sortRows: SORT_ROWS[operation.sortRows] };
                model.setOptions(options);
                state.sortRows = operation.sortRows;
                break;
            }
            case 'query':
                model.setQuery(fullQuery(operation));
                state.query = {
                    sortModel: operation.sortModel,
                    filterModel: operation.filterModel,
                    search: operation.search,
                };
                break;
            case 'group': {
                const columnState = [
                    ...operation.colIds.map((colId, index) => ({ colId, rowGroup: true, rowGroupIndex: index })),
                    ...specs
                        .filter((spec) => !operation.colIds.includes(spec.colId))
                        .map((spec) => ({ colId: spec.colId, rowGroup: false, rowGroupIndex: null })),
                ];
                // Shuffle entry order: rowGroupIndex, not array order, decides the grouping order.
                columnState.reverse();
                model.setColumnState(columnState as ColumnState[]);
                state.groupColIds = [...operation.colIds];
                break;
            }
            case 'expand': {
                let id = operation.id;
                if (id.startsWith('@')) {
                    const all: string[] = [];
                    model.forEachRow((row) => all.push(row.id), { includeCollapsed: true });
                    id = all.length ? all[Number(id.slice(1)) % all.length]! : 'none';
                }
                model.setExpanded(id, operation.expanded);
                state.expansion.set(id, operation.expanded);
                break;
            }
            case 'refresh':
                model.refresh();
                break;
        }
        compare(label);
    });

    return comparisons;
}

/** Removes operations (and initial rows) while the case still fails with an assertion error. */
function shrink(testCase: Case, checks: { includeFilteredAlone: boolean }): Case {
    const fails = (candidate: Case): boolean => {
        try {
            runCase(candidate, checks);

            return false;
        } catch (error) {
            return !(error instanceof Error && error.name === 'InvalidRowIdError');
        }
    };
    let current = testCase;
    let progress = true;
    while (progress) {
        progress = false;
        for (let i = current.operations.length - 1; i >= 0; i--) {
            const candidate = { ...current, operations: current.operations.filter((_, j) => j !== i) };
            if (fails(candidate)) {
                current = candidate;
                progress = true;
            }
        }
        for (let i = current.initialRows.length - 1; i >= 0; i--) {
            const candidate = { ...current, initialRows: current.initialRows.filter((_, j) => j !== i) };
            if (fails(candidate)) {
                current = candidate;
                progress = true;
            }
        }
        for (let i = current.columns.length - 1; i >= 0; i--) {
            const candidate = { ...current, columns: current.columns.filter((_, j) => j !== i) };
            if (candidate.columns.length > 0 && fails(candidate)) {
                current = candidate;
                progress = true;
            }
        }
    }

    return current;
}

function printable(testCase: Case): string {
    return JSON.stringify(
        { ...testCase, columns: testCase.columns.map((column) => ({ colId: column.spec.colId, hide: column.hide })) },
        (_, value) => (value === undefined ? '<undefined>' : value),
        1
    );
}

const CASES = 600;

describe('LocalRowModel differential fuzz', () => {
    it(`matches the reference model over ${CASES} random operation sequences`, () => {
        let comparisons = 0;
        for (let seed = 1; seed <= CASES; seed++) {
            const testCase = generateCase(createRandom(seed));
            try {
                comparisons += runCase(testCase, { includeFilteredAlone: true });
            } catch (error) {
                const minimal = shrink(testCase, { includeFilteredAlone: true });
                throw new Error(
                    `seed ${seed} failed: ${(error as Error).message}\nminimal case: ${printable(minimal)}`
                );
            }
        }
        expect(comparisons).toBeGreaterThan(CASES);
    }, 60_000);

    // Regression: forEachRow({ includeFiltered: true }) used to add rows below collapsed groups while a filter
    // was active. The contract in data-source.ts leaves those to includeCollapsed.
    it('includeFiltered alone does not add rows below collapsed groups', () => {
        const columnModel = new ColumnModel<Item>([{ field: 'c' }, { field: 'a' }]);
        const model = new LocalRowModel<Item>(
            {
                rows: [
                    { id: 1, c: 'red', a: 'x' },
                    { id: 2, c: 'red', a: 'y' },
                ],
            },
            {
                getResolved: (colId) => columnModel.getResolved(colId),
                displayedColIds: () => columnModel.getDisplayedLeaves().map((leaf) => leaf.colId),
            }
        );
        model.setColumnState([{ colId: 'c', rowGroup: true, rowGroupIndex: 0 } as ColumnState]);
        model.setQuery({
            sortModel: [],
            filterModel: { a: { filterType: 'text', type: 'equals', filter: 'x' } },
            search: '',
            externalFilters: {},
            rowGroupColIds: [],
        });
        const visited: [string, number | undefined][] = [];
        model.forEachRow((row, index) => visited.push([row.id, index]), { includeFiltered: true });

        // The red group is collapsed: displayed is the group alone, and row 2 is the only filtered row.
        expect(visited).toEqual([
            ['group:["c"]:["red"]', 0],
            ['2', undefined],
        ]);
    });
});
