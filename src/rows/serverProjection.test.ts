import { describe, expect, it } from 'vitest';

import { groupRowId, loadingRowId, failedRowId } from './ids';
import { ServerProjection } from './serverProjection';

type Row = {
    id?: number;
    name?: string;
    _group?: boolean;
    _groupKey?: string | null;
    _childCount?: number;
    activity?: string | null;
};

const people = (from: number, count: number): Row[] =>
    Array.from({ length: count }, (_, offset) => ({ id: from + offset, name: `Person ${from + offset}` }));
/** Group id under the country grouping used by these tests. */
const gid = (keyPath: (string | null)[]) => groupRowId(['country'], keyPath);
const group = (key: string | null, childCount: number): Row => ({
    _group: true,
    _groupKey: key,
    _childCount: childCount,
});

describe('flat remote rows', () => {
    it('shows loading placeholders with stable ids for unloaded slots', () => {
        const projection = new ServerProjection<Row>({ blockSize: 10 });
        projection.setRowCount([], 35);

        const slot = projection.getRowAtIndex(12);
        expect(projection.getDisplayCount()).toBe(35);
        expect(projection.getRowCount()).toBe(35);
        expect(slot?.row).toMatchObject({ kind: 'loading', id: loadingRowId([], 12), index: 12, level: 0 });
        expect(projection.getRowAtIndex(12)?.row.id).toBe(slot?.row.id);
        expect(projection.getRowAtIndex(35)).toBeUndefined();
        expect(projection.missingBlocks(8, 21)).toEqual([
            { route: [], blockIndex: 0 },
            { route: [], blockIndex: 1 },
            { route: [], blockIndex: 2 },
        ]);
    });

    it('resolves loaded rows by index and id, and reports only loaded rows from getRow', () => {
        const projection = new ServerProjection<Row>({ blockSize: 10 });
        projection.setRowCount([], 35);
        projection.setBlock([], 1, people(10, 10));

        expect(projection.getRowAtIndex(13)?.row).toMatchObject({ kind: 'data', id: '13' });
        expect(projection.getIndexOf('13')).toBe(13);
        expect(projection.getRow('3')).toBeUndefined();
        expect(projection.getIndexOf('3')).toBeUndefined();
        expect(projection.missingBlocks(0, 34).map((block) => block.blockIndex)).toEqual([0, 2, 3]);
    });

    it('estimates an unknown count as loaded rows plus one block, and fixes it on a short block', () => {
        const projection = new ServerProjection<Row>({ blockSize: 10 });

        expect(projection.getRowCount()).toBeNull();
        expect(projection.getDisplayCount()).toBe(10);
        projection.setBlock([], 0, people(0, 10));
        expect(projection.getDisplayCount()).toBe(20);
        projection.setBlock([], 1, people(10, 4));
        expect(projection.getRowCount()).toBe(14);
    });

    it('turns failed blocks into failed rows that are not requested again until retried', () => {
        const projection = new ServerProjection<Row>({ blockSize: 10 });
        projection.setRowCount([], 20);
        projection.setBlockFailed([], 1, new Error('500'));

        expect(projection.getRowAtIndex(15)?.row).toMatchObject({ kind: 'failed', id: failedRowId([], 15) });
        expect(projection.missingBlocks(0, 19)).toEqual([{ route: [], blockIndex: 0 }]);

        projection.removeBlock([], 1);
        expect(projection.getRowAtIndex(15)?.row.kind).toBe('loading');
        projection.setBlock([], 1, people(10, 10));
        expect(projection.getRowAtIndex(15)?.row.kind).toBe('data');
    });

    it('evicts a block back to placeholders and forgets its ids', () => {
        const projection = new ServerProjection<Row>({ blockSize: 10 });
        projection.setRowCount([], 20);
        projection.setBlock([], 0, people(0, 10));
        projection.removeBlock([], 0);

        expect(projection.getRow('5')).toBeUndefined();
        expect(projection.getRowAtIndex(5)?.row.kind).toBe('loading');
    });

    it('turns a row that moved between blocks into a hole that is refetched, never shown twice', () => {
        const projection = new ServerProjection<Row>({ blockSize: 10 });
        projection.setRowCount([], 20);
        projection.setBlock([], 0, people(0, 10));
        projection.setBlock([], 1, [{ id: 3, name: 'moved' }, ...people(11, 9)]);

        expect(projection.getIndexOf('3')).toBe(10);
        expect(projection.getRowAtIndex(3)?.row.kind).toBe('loading');
        expect(projection.missingBlocks(0, 19)).toEqual([{ route: [], blockIndex: 0 }]);
    });

    it('handles a million rows without loading them', () => {
        const projection = new ServerProjection<Row>({ blockSize: 100 });
        projection.setRowCount([], 1_000_000);
        projection.setBlock([], 9999, people(999_900, 100));

        expect(projection.getRowAtIndex(999_999)?.row.id).toBe('999999');
        expect(projection.getRowAtIndex(500_000)?.row.kind).toBe('loading');
        expect(projection.getIndexOf('999950')).toBe(999_950);
        expect(projection.missingBlocks(499_950, 500_049)).toHaveLength(2);
    });
});

describe('server groups', () => {
    const setup = (options: ConstructorParameters<typeof ServerProjection<Row>>[0] = {}) => {
        const projection = new ServerProjection<Row>({ blockSize: 10, groupColIds: ['country'], ...options });
        projection.setRowCount([], 3);
        projection.setBlock([], 0, [group('BE', 12), group('NL', 2), group(null, 1)]);

        return projection;
    };

    it('turns backend group rows into group rows identified by key path', () => {
        const projection = setup();

        expect(projection.getRowAtIndex(0)?.row).toMatchObject({
            kind: 'group',
            id: gid(['BE']),
            groupColId: 'country',
            key: 'BE',
            keyPath: ['BE'],
            childCount: 12,
            expanded: false,
        });
        expect(projection.getRowAtIndex(2)?.row.id).toBe(gid([null]));
    });

    it('expands a group into a child level sized by its child count, shifting later rows', () => {
        const projection = setup();

        expect(projection.setExpanded(gid(['BE']), true)).toBe(true);
        expect(projection.getDisplayCount()).toBe(15);
        expect(projection.getRowAtIndex(1)?.row).toMatchObject({
            kind: 'loading',
            id: loadingRowId(['BE'], 0),
            level: 1,
            parentId: gid(['BE']),
        });
        expect(projection.getIndexOf(gid(['NL']))).toBe(13);
        expect(projection.missingBlocks(1, 12)).toEqual([
            { route: ['BE'], blockIndex: 0 },
            { route: ['BE'], blockIndex: 1 },
        ]);

        projection.setBlock(['BE'], 0, people(100, 10));
        expect(projection.getRowAtIndex(1)?.row).toMatchObject({
            kind: 'data',
            id: '100',
            level: 1,
            parentId: gid(['BE']),
        });
        expect(projection.getIndexOf('105')).toBe(6);
    });

    it('keeps collapsed children cached: findable by id, not displayed, and back on re-expand', () => {
        const projection = setup();
        projection.setExpanded(gid(['BE']), true);
        projection.setBlock(['BE'], 0, people(100, 10));
        projection.setExpanded(gid(['BE']), false);

        expect(projection.getDisplayCount()).toBe(3);
        expect(projection.getRow('100')?.id).toBe('100');
        expect(projection.getIndexOf('100')).toBeUndefined();

        projection.setExpanded(gid(['BE']), true);
        expect(projection.getIndexOf('100')).toBe(1);
    });

    it('reopens expanded groups after a refresh once their rows arrive again', () => {
        const projection = setup();
        projection.setExpanded(gid(['NL']), true);
        projection.clear();

        expect(projection.getDisplayCount()).toBe(10);
        projection.setRowCount([], 3);
        projection.setBlock([], 0, [group('BE', 12), group('NL', 2), group(null, 1)]);

        expect(projection.isExpanded(gid(['NL']))).toBe(true);
        expect(projection.getDisplayCount()).toBe(5);
    });

    it('detaches a child level when the row above it changes on reload', () => {
        const projection = setup();
        projection.setExpanded(gid(['BE']), true);
        projection.setBlock([], 0, [group('DE', 4), group('NL', 2), group(null, 1)]);

        expect(projection.getDisplayCount()).toBe(3);
        expect(projection.getRowAtIndex(1)?.row.id).toBe(gid(['NL']));
    });

    it('opens groups by default when asked', () => {
        const projection = setup({ isGroupOpenByDefault: ({ key }) => key === 'NL' });

        expect(projection.isExpanded(gid(['NL']))).toBe(true);
        expect(projection.getDisplayCount()).toBe(5);
    });

    it('iterates loaded rows of displayed levels in display order', () => {
        const projection = setup();
        projection.setExpanded(gid(['NL']), true);
        projection.setBlock(['NL'], 0, people(200, 2));
        const seen: [string, number][] = [];
        projection.forEachLoaded((row, index) => seen.push([row.id, index]));

        expect(seen).toEqual([
            [gid(['BE']), 0],
            [gid(['NL']), 1],
            ['200', 2],
            ['201', 3],
            [gid([null]), 4],
        ]);
    });
});

describe('server tree rows', () => {
    it('expands rows that have a tree key into a child level', () => {
        const projection = new ServerProjection<Row>({ blockSize: 10, getTreeKey: (row) => row.activity ?? null });
        projection.setRowCount([], 2);
        projection.setBlock([], 0, [
            { id: 1, activity: 'tx-1' },
            { id: 2, activity: null },
        ]);

        expect(projection.getRow('1')).toMatchObject({ kind: 'data', expandable: { expanded: false } });
        expect(projection.getRow('2')).not.toHaveProperty('expandable');
        expect(projection.setExpanded('2', true)).toBe(false);

        projection.setExpanded('1', true);
        projection.setBlock(['tx-1'], 0, [{ id: 11 }, { id: 12 }]);
        expect(projection.getIndexOf('12')).toBe(2);
        expect(projection.getIndexOf('2')).toBe(3);
        expect(projection.getRow('11')).toMatchObject({ parentId: '1', level: 1 });
    });
});

describe('ServerProjection patchRow', () => {
    it('replaces loaded data by id and keeps the row in place', () => {
        const projection = new ServerProjection<{ id: number; name: string }>({ blockSize: 10 });
        projection.setRowCount([], 3);
        projection.setBlock([], 0, [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
            { id: 3, name: 'c' },
        ]);
        const version = projection.version;

        expect(projection.patchRow('2', { id: 2, name: 'B' })).toBe(true);
        expect((projection.getRow('2') as { data: { name: string } }).data.name).toBe('B');
        expect(projection.getIndexOf('2')).toBe(1);
        expect(projection.version).toBeGreaterThan(version);
        expect(projection.patchRow('9', { id: 9, name: 'x' })).toBe(false);
    });
});

describe('ServerProjection unknown count placeholders', () => {
    it('shows one block of loading rows by default, or the configured number', () => {
        const blockDefault = new ServerProjection<{ id: number }>({ blockSize: 10 });
        const single = new ServerProjection<{ id: number }>({ blockSize: 10, unknownCountRows: 1 });

        expect(blockDefault.getDisplayCount()).toBe(10);
        expect(single.getDisplayCount()).toBe(1);
        single.setBlock(
            [],
            0,
            Array.from({ length: 10 }, (_, id) => ({ id }))
        );
        expect(single.getDisplayCount()).toBe(11);
        expect(single.getRowAtIndex(10)?.row.kind).toBe('loading');
    });
});
