import { describe, expect, it } from 'vitest';

import { hasData, type GridRow, type RowId } from '../contract/rows';
import { diffRows } from './diff';
import { detailRowId, groupRowId, InvalidRowIdError, treeFillerRowId } from './ids';
import { buildLocalProjection, TREE_GROUP_COLUMN } from './localProjection';

type Person = { id: number; name: string; country: string | null; city: string };

const people: Person[] = [
    { id: 1, name: 'Ada', country: 'BE', city: 'Ghent' },
    { id: 2, name: 'Bo', country: 'NL', city: 'Utrecht' },
    { id: 3, name: 'Cy', country: 'BE', city: 'Antwerp' },
    { id: 4, name: 'Di', country: null, city: 'Nowhere' },
    { id: 5, name: 'Ed', country: 'BE', city: 'Ghent' },
];

const ids = (rows: readonly GridRow<unknown>[]) => rows.map((row) => row.id);
const dataOf = <T>(row: GridRow<T> | undefined): T | undefined => (row && hasData(row) ? row.data : undefined);
/** Group id under the country, city grouping used by these tests. */
const gid = (keyPath: (string | null)[]) => groupRowId(['country', 'city'], keyPath);
const byCountry = { colIds: ['country'], getKey: (data: Person) => data.country };
const byCountryCity = {
    colIds: ['country', 'city'],
    getKey: (data: Person, colId: string) => (colId === 'country' ? data.country : data.city),
};

describe('flat rows', () => {
    it('uses data.id as a string and keeps input order', () => {
        const projection = buildLocalProjection({ rows: people });

        expect(ids(projection.displayedRows)).toEqual(['1', '2', '3', '4', '5']);
        expect(projection.getRowAtIndex(2)?.row).toMatchObject({ kind: 'data', id: '3', level: 0, parentId: null });
        expect(projection.getIndexOf('4')).toBe(3);
        expect(projection.getRowAtIndex(5)).toBeUndefined();
        expect(projection.getIndexOf('nope')).toBeUndefined();
    });

    it('rejects missing, duplicate and reserved ids', () => {
        expect(() => buildLocalProjection({ rows: [{ name: 'x' }] })).toThrow(InvalidRowIdError);
        expect(() => buildLocalProjection({ rows: [{ id: 1 }, { id: '1' }] })).toThrow(/duplicate row id "1"/);
        expect(() => buildLocalProjection({ rows: [{ id: 'group:x' }] })).toThrow(/reserved prefix/);
        expect(() => buildLocalProjection({ rows: [{ key: 7 }], getRowId: () => '' })).toThrow(InvalidRowIdError);
    });

    it('keeps ids stable across sorting and filtering', () => {
        const sorted = buildLocalProjection({ rows: [...people].sort((a, b) => b.name.localeCompare(a.name)) });
        const filtered = buildLocalProjection({ rows: people.filter((person) => person.country === 'BE') });

        for (const person of people) {
            expect(dataOf(sorted.getRow(String(person.id)))).toBe(person);
        }
        expect(ids(filtered.displayedRows)).toEqual(['1', '3', '5']);
        expect(filtered.getRow('2')).toBeUndefined();
    });

    it('reuses row objects that did not change and replaces those that did', () => {
        const first = buildLocalProjection({ rows: people });
        const edited = people.map((person) => (person.id === 2 ? { ...person, name: 'Bob' } : person));
        const second = buildLocalProjection({ rows: [...edited].reverse(), previous: first });

        expect(second.getRow('1')).toBe(first.getRow('1'));
        expect(second.getRow('2')).not.toBe(first.getRow('2'));
        expect(dataOf(second.getRow('2'))).toMatchObject({ name: 'Bob' });
    });

    it('marks full-width rows as their own kind', () => {
        const projection = buildLocalProjection({ rows: people, isFullWidth: (data) => data.id === 3 });

        expect(projection.getRow('3')?.kind).toBe('fullWidth');
        expect(projection.getRow('2')?.kind).toBe('data');
    });
});

describe('grouping', () => {
    it('builds groups in first-appearance order with leaf counts and key paths', () => {
        const projection = buildLocalProjection({ rows: people, grouping: byCountry, defaultExpanded: true });
        const be = projection.getRow(gid(['BE']));

        expect(ids(projection.displayedRows)).toEqual([gid(['BE']), '1', '3', '5', gid(['NL']), '2', gid([null]), '4']);
        expect(be).toMatchObject({
            kind: 'group',
            groupColId: 'country',
            key: 'BE',
            keyPath: ['BE'],
            childCount: 3,
            expanded: true,
            level: 0,
        });
        expect(projection.getRow('3')).toMatchObject({ level: 1, parentId: gid(['BE']) });
    });

    it('distinguishes a null group key from the string "null"', () => {
        const rows = [
            { id: 1, country: null },
            { id: 2, country: 'null' },
        ];
        const projection = buildLocalProjection({
            rows,
            grouping: { colIds: ['country'], getKey: (data) => data.country },
        });

        expect(projection.getRowCount()).toBe(2);
        expect(gid([null])).not.toBe(gid(['null']));
    });

    it('hides children of collapsed groups but still finds them by id', () => {
        const projection = buildLocalProjection({
            rows: people,
            grouping: byCountry,
            defaultExpanded: true,
            expansion: new Map([[gid(['BE']), false]]),
        });

        expect(ids(projection.displayedRows)).toEqual([gid(['BE']), gid(['NL']), '2', gid([null]), '4']);
        expect(projection.getRow('3')?.id).toBe('3');
        expect(projection.getIndexOf('3')).toBeUndefined();

        const all: [RowId, number | undefined][] = [];
        projection.forEachRow((row, index) => all.push([row.id, index]), { includeCollapsed: true });
        expect(all).toContainEqual(['3', undefined]);
        expect(all).toContainEqual([gid(['NL']), 1]);
    });

    it('applies default expansion by level and reports the resolved expanded ids', () => {
        const projection = buildLocalProjection({ rows: people, grouping: byCountryCity, defaultExpanded: 1 });

        expect(projection.getRow(gid(['BE']))).toMatchObject({ expanded: true });
        expect(projection.getRow(gid(['BE', 'Ghent']))).toMatchObject({ expanded: false, childCount: 2, level: 1 });
        expect(projection.expandedIds.has(gid(['BE']))).toBe(true);
        expect(projection.expandedIds.has(gid(['BE', 'Ghent']))).toBe(false);
        expect(projection.getIndexOf('1')).toBeUndefined();
    });

    it('keeps group ids stable when the leaf order changes', () => {
        const first = buildLocalProjection({ rows: people, grouping: byCountry, defaultExpanded: true });
        const second = buildLocalProjection({
            rows: [...people].reverse(),
            grouping: byCountry,
            defaultExpanded: true,
            previous: first,
        });

        const groupOrder = second.displayedRows.filter((row) => row.kind === 'group').map((row) => row.id);
        expect(groupOrder).toEqual([gid(['BE']), gid([null]), gid(['NL'])]);
        expect(second.getRow(gid(['BE']))).toBe(first.getRow(gid(['BE'])));
    });
});

describe('tree data', () => {
    type Node = { id: string; path: string[] };
    const tree: Node[] = [
        { id: 'client', path: ['Client'] },
        { id: 'agent-a', path: ['Client', 'Agent A'] },
        { id: 'territory', path: ['Client', 'Agent A', 'EU'] },
        { id: 'orphan', path: ['Other', 'Leaf'] },
    ];

    it('nests rows by path, creates fillers for missing ancestors and counts leaves', () => {
        const projection = buildLocalProjection({
            rows: tree,
            getDataPath: (node) => node.path,
            defaultExpanded: true,
        });

        expect(ids(projection.displayedRows)).toEqual([
            'client',
            'agent-a',
            'territory',
            treeFillerRowId(['Other']),
            'orphan',
        ]);
        expect(projection.getRow('client')).toMatchObject({ kind: 'data', expandable: { expanded: true }, level: 0 });
        expect(projection.getRow('territory')).toMatchObject({ level: 2, parentId: 'agent-a' });
        expect(projection.getRow(treeFillerRowId(['Other']))).toMatchObject({
            kind: 'group',
            groupColId: TREE_GROUP_COLUMN,
            childCount: 1,
        });
        expect(projection.getRow('orphan')).toMatchObject({ parentId: treeFillerRowId(['Other']) });
    });

    it('turns a filler into the data row when the ancestor arrives later', () => {
        const projection = buildLocalProjection({
            rows: [tree[1]!, tree[0]!],
            getDataPath: (node) => node.path,
            defaultExpanded: true,
        });

        expect(ids(projection.displayedRows)).toEqual(['client', 'agent-a']);
        expect(projection.getRow('agent-a')).toMatchObject({ parentId: 'client' });
        expect(projection.getRow(treeFillerRowId(['Client']))).toBeUndefined();
    });

    it('rejects two rows on one path and combining tree data with grouping', () => {
        expect(() =>
            buildLocalProjection({
                rows: [tree[0]!, { id: 'dup', path: ['Client'] }],
                getDataPath: (node) => node.path,
            })
        ).toThrow(/share the tree path/);
        expect(() =>
            buildLocalProjection({
                rows: tree,
                getDataPath: (node) => node.path,
                grouping: { colIds: ['x'], getKey: () => 'x' },
            })
        ).toThrow(/cannot be combined/);
    });
});

describe('master/detail', () => {
    it('adds a detail row under an expanded master only', () => {
        const collapsed = buildLocalProjection({ rows: people, isMaster: (data) => data.id === 2 });
        const expanded = buildLocalProjection({
            rows: people,
            isMaster: (data) => data.id === 2,
            expansion: new Map([['2', true]]),
        });

        expect(collapsed.getRow('2')).toMatchObject({ expandable: { expanded: false } });
        expect(collapsed.getRow(detailRowId('2'))).toBeUndefined();
        expect(ids(expanded.displayedRows)).toEqual(['1', '2', detailRowId('2'), '3', '4', '5']);
        expect(expanded.getRow(detailRowId('2'))).toMatchObject({
            kind: 'detail',
            masterId: '2',
            level: 1,
            parentId: '2',
        });
    });
});

describe('diffRows', () => {
    it('reports removed, hidden, moved and updated ids', () => {
        const before = buildLocalProjection({ rows: people, grouping: byCountry, defaultExpanded: true });
        const nextRows = people
            .filter((person) => person.id !== 2)
            .map((person) => (person.id === 5 ? { ...person, name: 'Eve' } : person));
        const after = buildLocalProjection({
            rows: [...nextRows].reverse(),
            grouping: byCountry,
            defaultExpanded: true,
            expansion: new Map([[gid([null]), false]]),
            previous: before,
        });

        const changes = diffRows(['1', '2', '4', '5'], before, after);

        expect(changes.removed).toEqual(['2']);
        expect(changes.hidden).toEqual(['4']);
        expect(changes.updated).toContain('5');
        expect(changes.moved.map((move) => move.id)).toEqual(expect.arrayContaining(['1', '5']));
    });
});

describe('scale', () => {
    it('projects 100,000 grouped rows quickly and answers lookups', () => {
        const rows = Array.from({ length: 100_000 }, (_, id) => ({ id, group: `g${Math.floor(id / 50)}` }));
        const started = performance.now();
        const projection = buildLocalProjection({
            rows,
            grouping: { colIds: ['group'], getKey: (data) => data.group },
            defaultExpanded: true,
        });
        const elapsed = performance.now() - started;

        expect(projection.getRowCount()).toBe(102_000);
        expect(projection.getIndexOf('99999')).toBe(101_999);
        expect(projection.getRowAtIndex(51)?.row.id).toBe(groupRowId(['group'], ['g1']));
        expect(elapsed).toBeLessThan(1500);
    });
});
