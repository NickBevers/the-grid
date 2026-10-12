/**
 * Randomized differential tests for `buildLocalProjection`.
 *
 * A brute-force reference builds the row tree straight from the definitions (groups and tree siblings in
 * order of first appearance, leaves in input order), flattens it top to bottom, and is compared with the
 * projection. Each sequence rebuilds several times with `previous`, so row object reuse is checked too.
 */
import { describe, expect, it } from 'vitest';

import type { GridRow, RowId } from '../contract/rows';
import { detailRowId, groupRowId, treeFillerRowId, type GroupKey } from './ids';
import {
    buildLocalProjection,
    TREE_GROUP_COLUMN,
    type DefaultExpanded,
    type LocalProjection,
    type LocalProjectionInput,
} from './localProjection';

/** mulberry32: tiny, seedable and good enough for test input. */
function createRandom(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    return {
        int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
        chance: (p: number): boolean => next() < p,
        pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
        shuffle: <T>(items: T[]): T[] => {
            for (let i = items.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [items[i], items[j]] = [items[j]!, items[i]!];
            }

            return items;
        },
    };
}
type Random = ReturnType<typeof createRandom>;

type LRow = {
    seq: number;
    id: number | string;
    c0: string | null;
    c1: string | null;
    c2: string | null;
    path: string[];
    master: boolean;
    fullWidth: boolean;
};

let nextSeq = 0;
const KEYS: (string | null)[] = ['x', 'y', null, 'null'];
const SEGMENTS = ['A', 'B', 'C'];
const COLUMNS = ['c0', 'c1', 'c2'] as const;

// Reference

type RNode = {
    id: RowId;
    kind: 'group' | 'data' | 'fullWidth';
    level: number;
    parentId: RowId | null;
    data: LRow | null;
    groupColId?: string;
    key?: GroupKey;
    keyPath?: GroupKey[];
    childCount?: number;
    master: boolean;
    children: RNode[];
};

type Summary = Record<string, unknown>;

type Setup = {
    mode: 'flat' | 'grouping' | 'tree';
    colIds: string[];
    master: boolean;
    fullWidth: boolean;
    expansion: Map<RowId, boolean>;
    defaultExpanded: DefaultExpanded<LRow> | undefined;
    describeDefault: string;
};

const keyId = (key: GroupKey): string => (key === null ? 'null value' : `string ${key}`);
const isStrictPrefix = (prefix: readonly string[], path: readonly string[]): boolean =>
    path.length > prefix.length && prefix.every((segment, index) => path[index] === segment);
const samePath = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((segment, index) => b[index] === segment);

function isFullWidthIn(setup: Setup, rows: readonly LRow[]) {
    return (data: LRow): boolean => {
        if (!setup.fullWidth || !data.fullWidth) {
            return false;
        }
        // A full-width tree row with children hides them for good (it cannot expand), so only leaves are full width.
        return setup.mode !== 'tree' || !rows.some((other) => isStrictPrefix(data.path, other.path));
    };
}

function referenceTree(rows: readonly LRow[], setup: Setup): RNode[] {
    const isFullWidth = isFullWidthIn(setup, rows);
    const leaf = (data: LRow, level: number, parentId: RowId | null): RNode => {
        const fullWidth = isFullWidth(data);

        return {
            id: String(data.id),
            kind: fullWidth ? 'fullWidth' : 'data',
            level,
            parentId,
            data,
            master: !fullWidth && setup.master && data.master,
            children: [],
        };
    };

    if (setup.mode === 'grouping' && setup.colIds.length > 0) {
        const group = (
            members: readonly LRow[],
            depth: number,
            keyPath: GroupKey[],
            parentId: RowId | null
        ): RNode[] => {
            if (depth === setup.colIds.length) {
                return members.map((data) => leaf(data, depth, parentId));
            }
            const colId = setup.colIds[depth]! as (typeof COLUMNS)[number];
            const keys: GroupKey[] = [];
            for (const data of members) {
                if (!keys.some((key) => keyId(key) === keyId(data[colId]))) {
                    keys.push(data[colId]);
                }
            }

            return keys.map((key) => {
                const inGroup = members.filter((data) => keyId(data[colId]) === keyId(key));
                const path = [...keyPath, key];
                const id = groupRowId(setup.colIds, path);

                return {
                    id,
                    kind: 'group',
                    level: depth,
                    parentId,
                    data: null,
                    groupColId: colId,
                    key,
                    keyPath: path,
                    childCount: inGroup.length,
                    master: false,
                    children: group(inGroup, depth + 1, path, id),
                };
            });
        };

        return group(rows, 0, [], null);
    }

    if (setup.mode === 'tree') {
        const firstIndex = (prefix: string[]): number =>
            rows.findIndex((data) => samePath(data.path, prefix) || isStrictPrefix(prefix, data.path));
        const nodesBelow = (prefix: string[], parentId: RowId | null): RNode[] => {
            const segments: string[] = [];
            for (const data of rows) {
                if (isStrictPrefix(prefix, data.path) && !segments.includes(data.path[prefix.length]!)) {
                    segments.push(data.path[prefix.length]!);
                }
            }
            segments.sort((a, b) => firstIndex([...prefix, a]) - firstIndex([...prefix, b]));

            return segments.map((segment) => {
                const path = [...prefix, segment];
                const own = rows.find((data) => samePath(data.path, path));
                const node: RNode = own
                    ? leaf(own, path.length - 1, parentId)
                    : {
                          id: treeFillerRowId(path),
                          kind: 'group',
                          level: path.length - 1,
                          parentId,
                          data: null,
                          groupColId: TREE_GROUP_COLUMN,
                          key: segment,
                          keyPath: path,
                          childCount: rows.filter((data) => isStrictPrefix(path, data.path)).length,
                          master: false,
                          children: [],
                      };
                node.children = nodesBelow(path, node.id);

                return node;
            });
        };

        return nodesBelow([], null);
    }

    return rows.map((data) => leaf(data, 0, null));
}

type ReferenceProjection = { displayed: Summary[]; all: Summary[]; expandedIds: Set<RowId> };

function referenceProjection(rows: readonly LRow[], setup: Setup): ReferenceProjection {
    const displayed: Summary[] = [];
    const all: Summary[] = [];
    const expandedIds = new Set<RowId>();
    const visit = (node: RNode, visible: boolean): void => {
        const expandable = node.kind === 'group' || (node.kind === 'data' && (node.children.length > 0 || node.master));
        let expanded = false;
        if (expandable) {
            const base = baseSummary(node);
            const explicit = setup.expansion.get(node.id);
            const rule = setup.defaultExpanded ?? false;
            expanded =
                explicit ??
                (typeof rule === 'boolean'
                    ? rule
                    : typeof rule === 'number'
                      ? rule < 0 || node.level < rule
                      : rule(base as unknown as GridRow<LRow>));
        }
        if (expanded) {
            expandedIds.add(node.id);
        }
        const summary: Summary = { ...baseSummary(node) };
        if (node.kind === 'group') {
            summary.expanded = expanded;
        } else if (node.kind === 'data' && expandable) {
            summary.expandable = { expanded };
        }
        all.push(summary);
        if (visible) {
            displayed.push(summary);
        }
        if (node.master && expanded) {
            const detail = {
                id: detailRowId(node.id),
                kind: 'detail',
                level: node.level + 1,
                parentId: node.id,
                section: 'body',
                masterId: node.id,
                seq: node.data!.seq,
            };
            all.push(detail);
            if (visible) {
                displayed.push(detail);
            }
        }
        for (const child of node.children) {
            visit(child, visible && expanded);
        }
    };
    referenceTree(rows, setup).forEach((node) => visit(node, true));

    return { displayed, all, expandedIds };
}

/** The row as a predicate should see it: everything but the expansion that is being decided. */
function baseSummary(node: RNode): Summary {
    const base: Summary = { id: node.id, kind: node.kind, level: node.level, parentId: node.parentId, section: 'body' };
    if (node.kind === 'group') {
        return {
            ...base,
            groupColId: node.groupColId,
            key: node.key,
            keyPath: node.keyPath,
            childCount: node.childCount,
            seq: undefined,
        };
    }

    return { ...base, seq: node.data!.seq };
}

function summarize(row: GridRow<LRow>): Summary {
    const base: Summary = {
        id: row.id,
        kind: row.kind,
        level: row.level,
        parentId: row.parentId,
        section: row.section,
    };
    switch (row.kind) {
        case 'group':
            return {
                ...base,
                groupColId: row.groupColId,
                key: row.key,
                keyPath: row.keyPath,
                childCount: row.childCount,
                seq: row.data?.seq,
                expanded: row.expanded,
            };
        case 'data':
            return row.expandable
                ? { ...base, seq: row.data.seq, expandable: { expanded: row.expandable.expanded } }
                : { ...base, seq: row.data.seq };
        case 'fullWidth':
            return { ...base, seq: row.data.seq };
        case 'detail':
            return { ...base, masterId: row.masterId, seq: row.data.seq };
        default:
            return { ...base, unexpected: true };
    }
}

// Comparison

class Mismatch extends Error {}

function check(label: string, actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        return;
    }
    if (Array.isArray(actual) && Array.isArray(expected)) {
        const at = actual.findIndex((item, index) => JSON.stringify(item) !== JSON.stringify(expected[index]));
        const index = at < 0 ? expected.length : at;
        throw new Mismatch(
            `${label}: first difference at ${index}\nactual   ${JSON.stringify(actual[index])}\nexpected ${JSON.stringify(expected[index])}`
        );
    }
    try {
        expect(actual).toEqual(expected);
    } catch (error) {
        throw new Mismatch(`${label}\n${(error as Error).message}`);
    }
    throw new Mismatch(`${label}: ${JSON.stringify(actual)} versus ${JSON.stringify(expected)}`);
}

function assertEquivalent(
    projection: LocalProjection<LRow>,
    reference: ReferenceProjection,
    previous: LocalProjection<LRow> | undefined,
    knownIds: readonly RowId[]
): void {
    check('displayedRows', projection.displayedRows.map(summarize), reference.displayed);
    check('getRowCount', projection.getRowCount(), reference.displayed.length);
    reference.displayed.forEach((summary, index) => {
        const displayed = projection.getRowAtIndex(index);
        check(`getRowAtIndex(${index})`, displayed && { index: displayed.index, row: summarize(displayed.row) }, {
            index,
            row: summary,
        });
    });
    check('getRowAtIndex(count)', projection.getRowAtIndex(reference.displayed.length), undefined);

    const indexById = new Map(reference.displayed.map((summary, index) => [summary.id as RowId, index]));
    const allById = new Map(reference.all.map((summary) => [summary.id as RowId, summary]));
    for (const id of new Set([...knownIds, ...allById.keys(), 'nope', groupRowId(['country'], ['nope'])])) {
        const row = projection.getRow(id);
        check(`getRow(${id})`, row && summarize(row), allById.get(id));
        check(`getIndexOf(${id})`, projection.getIndexOf(id), indexById.get(id));
        if (row && indexById.has(id)) {
            // The displayed object and the looked-up object are the same row.
            check(`displayed object for ${id}`, projection.getRowAtIndex(indexById.get(id)!)?.row === row, true);
        }
    }
    check('expandedIds', [...projection.expandedIds].sort(), [...reference.expandedIds].sort());

    const withCollapsed: [RowId, number | undefined][] = [];
    projection.forEachRow((row, index) => withCollapsed.push([row.id, index]), { includeCollapsed: true });
    check(
        'forEachRow includeCollapsed',
        withCollapsed,
        reference.all.map((summary) => [summary.id, indexById.get(summary.id as RowId)])
    );
    const visible: [RowId, number | undefined][] = [];
    projection.forEachRow((row, index) => visible.push([row.id, index]));
    check(
        'forEachRow',
        visible,
        reference.displayed.map((summary, index) => [summary.id, index])
    );

    if (previous) {
        for (const summary of reference.all) {
            const prior = previous.getRow(summary.id as RowId);
            if (prior && JSON.stringify(summarize(prior)) === JSON.stringify(summary)) {
                check(
                    `reuses the row object for ${summary.id as string}`,
                    projection.getRow(summary.id as RowId) === prior,
                    true
                );
            }
        }
    }
}

// Generator

function randomPath(random: Random): string[] {
    return Array.from({ length: random.int(1, 3) }, () => random.pick(SEGMENTS));
}

function newRow(random: Random, id: number | string, taken: readonly LRow[]): LRow | undefined {
    for (let attempt = 0; attempt < 6; attempt++) {
        const path = randomPath(random);
        if (!taken.some((other) => samePath(other.path, path))) {
            return {
                seq: nextSeq++,
                id,
                c0: random.pick(KEYS),
                c1: random.pick(KEYS),
                c2: random.pick(KEYS),
                path,
                master: random.chance(0.3),
                fullWidth: random.chance(0.15),
            };
        }
    }

    return undefined;
}

function randomId(random: Random, used: ReadonlySet<string>): number | string | undefined {
    for (let attempt = 0; attempt < 6; attempt++) {
        const n = random.int(0, 39);
        const id = random.chance(0.5) ? n : `row-${n}`;
        if (!used.has(String(id))) {
            return id;
        }
    }

    return undefined;
}

function nextRows(random: Random, rows: readonly LRow[]): LRow[] {
    const next: LRow[] = [];
    for (const row of rows) {
        const roll = random.int(0, 99);
        if (roll < 10) {
            continue;
        }
        if (roll < 25) {
            // Same id, new data object, possibly moved to another group or tree path.
            const moved = random.chance(0.4) ? randomPath(random) : row.path;
            const path =
                next.some((other) => samePath(other.path, moved)) ||
                rows.some((other) => other !== row && samePath(other.path, moved))
                    ? row.path
                    : moved;
            next.push({
                ...row,
                seq: nextSeq++,
                path,
                c0: random.chance(0.5) ? random.pick(KEYS) : row.c0,
                master: random.chance(0.8) ? row.master : !row.master,
            });
            continue;
        }
        next.push(row);
    }
    const used = new Set(next.map((row) => String(row.id)));
    for (let added = random.int(0, 3); added > 0; added--) {
        const id = randomId(random, used);
        const row = id === undefined ? undefined : newRow(random, id, [...next, ...rows]);
        if (row) {
            used.add(String(row.id));
            next.push(row);
        }
    }

    return random.chance(0.5) ? random.shuffle(next) : next;
}

function randomDefault(
    random: Random,
    avoidKnownBugs: boolean
): { rule: DefaultExpanded<LRow> | undefined; text: string } {
    switch (random.int(0, avoidKnownBugs ? 7 : 8)) {
        case 0:
            return { rule: undefined, text: 'none' };
        case 1:
            return { rule: true, text: 'true' };
        case 2:
            return { rule: false, text: 'false' };
        case 3:
            return { rule: -1, text: '-1' };
        case 4: {
            const level = random.int(0, 2);

            return { rule: level, text: String(level) };
        }
        case 5:
            return { rule: (row) => row.level % 2 === 0, text: 'even levels' };
        case 6:
            return {
                rule: (row) => row.kind === 'group' || row.id.length % 2 === 0,
                text: 'groups and even id lengths',
            };
        case 7:
            return {
                rule: (row) => (row.kind === 'group' ? row.key !== 'x' : row.kind === 'data'),
                text: 'all but key x',
            };
        default:
            // Known bug, see "passes the defaultExpanded predicate the finished row": groups arrive with childCount 0.
            return {
                rule: (row) => row.kind === 'group' && (row.childCount ?? 0) > 1,
                text: 'groups with more than one leaf',
            };
    }
}

function randomSetup(
    random: Random,
    mode: Setup['mode'],
    previous: LocalProjection<LRow> | undefined,
    colIds: string[],
    avoidKnownBugs: boolean
): Setup {
    const expansion = new Map<RowId, boolean>();
    if (previous && random.chance(0.6)) {
        // What the grid does: store the resolved expanded ids as the next explicit state.
        for (const id of previous.expandedIds) {
            expansion.set(id, true);
        }
    }
    if (previous) {
        const ids: RowId[] = [];
        previous.forEachRow((row) => ids.push(row.id), { includeCollapsed: true });
        for (let toggles = random.int(0, 4); toggles > 0 && ids.length > 0; toggles--) {
            expansion.set(random.pick(ids), random.chance(0.5));
        }
    }
    const { rule, text } = randomDefault(random, avoidKnownBugs);

    return {
        mode,
        colIds,
        master: mode !== 'tree' && random.chance(0.5),
        fullWidth: random.chance(0.4),
        expansion,
        defaultExpanded: rule,
        describeDefault: text,
    };
}

function toInput(rows: LRow[], setup: Setup, previous: LocalProjection<LRow> | undefined): LocalProjectionInput<LRow> {
    return {
        rows,
        ...(setup.mode === 'grouping'
            ? {
                  grouping: {
                      colIds: setup.colIds,
                      getKey: (data: LRow, colId: string) => data[colId as (typeof COLUMNS)[number]],
                  },
              }
            : {}),
        ...(setup.mode === 'tree' ? { getDataPath: (data: LRow) => data.path } : {}),
        ...(setup.master ? { isMaster: (data: LRow) => data.master } : {}),
        isFullWidth: isFullWidthIn(setup, rows),
        expansion: setup.expansion,
        ...(setup.defaultExpanded === undefined ? {} : { defaultExpanded: setup.defaultExpanded }),
        ...(previous ? { previous } : {}),
    };
}

function runSequence(seed: number, builds: number, avoidKnownBugs: boolean): number {
    const random = createRandom(seed);
    const mode = random.pick(['flat', 'grouping', 'grouping', 'tree', 'tree'] as const);
    let colIds = random.shuffle([...COLUMNS]).slice(0, random.int(0, 3));
    let rows: LRow[] = [];
    const used = new Set<string>();
    for (let count = random.int(0, 14); count > 0; count--) {
        const id = randomId(random, used);
        const row = id === undefined ? undefined : newRow(random, id, rows);
        if (row) {
            used.add(String(row.id));
            rows.push(row);
        }
    }
    const knownIds = new Set<RowId>();
    const log: string[] = [];
    let previous: LocalProjection<LRow> | undefined;
    for (let build = 0; build < builds; build++) {
        let regrouped = false;
        if (build > 0) {
            rows = nextRows(random, rows);
            if (mode === 'grouping' && random.chance(0.3)) {
                const next = random.shuffle([...COLUMNS]).slice(0, random.int(0, 3));
                regrouped = JSON.stringify(next) !== JSON.stringify(colIds);
                colIds = next;
            }
        }
        // Known bug, see "keeps groupColId current when the grouping columns change": regrouping with `previous` reuses stale group rows.
        const reusable = avoidKnownBugs && regrouped ? undefined : previous;
        const setup = randomSetup(random, mode, previous, colIds, avoidKnownBugs);
        log.push(
            `build ${build}: mode ${mode}, colIds ${JSON.stringify(colIds)}, master ${setup.master}, fullWidth ${setup.fullWidth}, default ${setup.describeDefault}, ` +
                `expansion ${JSON.stringify([...setup.expansion])}\n  rows ${JSON.stringify(rows.map(({ seq, id, c0, c1, c2, path, master, fullWidth }) => ({ seq, id, c0, c1, c2, path, master, fullWidth })))}`
        );
        try {
            const projection = buildLocalProjection(toInput(rows, setup, reusable));
            const reference = referenceProjection(rows, setup);
            reference.all.forEach((summary) => knownIds.add(summary.id as RowId));
            assertEquivalent(projection, reference, reusable, [...knownIds]);
            previous = projection;
        } catch (error) {
            throw new Error(`seed ${seed}:\n${log.join('\n')}\n\n${(error as Error).message}`);
        }
    }

    return builds;
}

/** Environment knobs for exploring by hand; the project has no Node types, so read them untyped. */
const env: Record<string, string | undefined> =
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

describe('buildLocalProjection differential fuzz', () => {
    it('matches the brute-force reference and reuses unchanged row objects', () => {
        const sequences = Number(env.FUZZ_SEQUENCES ?? 3000);
        const offset = Number(env.FUZZ_SEED ?? 1);
        let builds = 0;
        for (let seed = offset; seed < offset + sequences; seed++) {
            // Former bug triggers run by default now that they are fixed; FUZZ_ALLOW=none avoids them again.
            builds += runSequence(seed, 4, env.FUZZ_ALLOW === 'none');
        }
        expect(builds).toBe(sequences * 4);
    }, 60_000);
});

/**
 * Regression tests: minimal reproductions of the bugs the fuzz found while the projections were built. All fixed;
 * the fuzz above now exercises their triggers too.
 */
describe('buildLocalProjection regressions', () => {
    type Place = { id: number; country: string; city: string };
    const getKey = (data: Place, colId: string): GroupKey => (colId === 'country' ? data.country : data.city);

    // Group ids come from the key path only, so after regrouping on another column a group can keep its
    // id. `reuse` compares expanded, childCount and data but not groupColId, and returns the old row.
    it('keeps groupColId current when the grouping columns change', () => {
        const rows: Place[] = [{ id: 1, country: 'BE', city: 'BE' }];
        const first = buildLocalProjection({ rows, grouping: { colIds: ['country'], getKey } });
        const second = buildLocalProjection({ rows, grouping: { colIds: ['city'], getKey }, previous: first });

        expect(second.getRow(groupRowId(['city'], ['BE']))).toMatchObject({ groupColId: 'city' });
    });

    // `emit` calls the defaultExpanded predicate with node.row, the row before its childCount and expanded
    // fields are filled in. Every group reaches the predicate with childCount 0.
    it('passes the defaultExpanded predicate the finished row', () => {
        const rows: Place[] = [
            { id: 1, country: 'BE', city: 'Ghent' },
            { id: 2, country: 'BE', city: 'Antwerp' },
            { id: 3, country: 'NL', city: 'Utrecht' },
        ];
        const projection = buildLocalProjection({
            rows,
            grouping: { colIds: ['country'], getKey },
            defaultExpanded: (row) => row.kind === 'group' && (row.childCount ?? 0) > 1,
        });

        expect([...projection.expandedIds]).toEqual([groupRowId(['country'], ['BE'])]);
    });
});
