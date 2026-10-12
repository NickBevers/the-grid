import { describe, expect, it } from 'vitest';

import type { GridRow, ResolvedCellRange } from '../contract';
import { aggregate, cellRangeEdges, extendRange, numericValue, rangeFromCells, resolveRange } from './ranges';
import { createSnapshot, type GridSnapshot, type SnapshotColumn } from './snapshot';

type Data = Record<string, unknown>;

function dataRow(id: string, data: Data = {}): GridRow<Data> {
    return { kind: 'data', id, section: 'body', level: 0, parentId: null, data };
}

function loadingRow(id: string, index: number): GridRow<Data> {
    return { kind: 'loading', id, section: 'body', level: 0, parentId: null, index };
}

function groupRow(id: string): GridRow<Data> {
    return {
        kind: 'group',
        id,
        section: 'body',
        level: 0,
        parentId: null,
        groupColId: 'a',
        key: id,
        keyPath: [id],
        childCount: 1,
        expanded: true,
        data: { a: 1000 },
    };
}

function fullWidthRow(id: string): GridRow<Data> {
    return { kind: 'fullWidth', id, section: 'body', level: 0, parentId: null, data: { a: 1000 } };
}

function column(colId: string, focusable = true): SnapshotColumn<Data> {
    return {
        colId,
        focusable,
        getValue: (row) => ('data' in row && row.data ? row.data[colId] : undefined),
        formatValue: (row) => String(('data' in row && row.data ? row.data[colId] : '') ?? ''),
        isEditable: () => true,
    };
}

/** Columns in visual order: `pinL` pinned left, `a` to `c` center, `pinR` pinned right. */
const COLUMNS = ['pinL', 'a', 'b', 'c', 'pinR'].map((colId) => column(colId));

function grid(rows: GridRow<Data>[], columns = COLUMNS): GridSnapshot<Data> {
    return createSnapshot(rows, columns);
}

const rows5 = ['r0', 'r1', 'r2', 'r3', 'r4'].map((id) => dataRow(id));

describe('rangeFromCells', () => {
    it('copies both cells', () => {
        const anchor = { rowId: 'r0', colId: 'a' };
        const range = rangeFromCells(anchor, { rowId: 'r1', colId: 'b' });

        expect(range).toEqual({ anchor: { rowId: 'r0', colId: 'a' }, end: { rowId: 'r1', colId: 'b' } });
        expect(range.anchor).not.toBe(anchor);
    });
});

describe('resolveRange', () => {
    const snapshot = grid(rows5);

    it('resolves a top left to bottom right drag', () => {
        expect(
            resolveRange(rangeFromCells({ rowId: 'r1', colId: 'a' }, { rowId: 'r3', colId: 'b' }), snapshot)
        ).toEqual({
            rowIds: ['r1', 'r2', 'r3'],
            colIds: ['a', 'b'],
            startIndex: 1,
            endIndex: 3,
            unloadedIndexes: [],
        });
    });

    it('resolves the same rectangle when dragged the other way', () => {
        const forward = resolveRange(
            rangeFromCells({ rowId: 'r1', colId: 'a' }, { rowId: 'r3', colId: 'b' }),
            snapshot
        );
        const backward = resolveRange(
            rangeFromCells({ rowId: 'r3', colId: 'b' }, { rowId: 'r1', colId: 'a' }),
            snapshot
        );
        const crossed = resolveRange(
            rangeFromCells({ rowId: 'r3', colId: 'a' }, { rowId: 'r1', colId: 'b' }),
            snapshot
        );

        expect(backward).toEqual(forward);
        expect(crossed).toEqual(forward);
    });

    it('spans pinned sections in visual order', () => {
        const resolved = resolveRange(
            rangeFromCells({ rowId: 'r0', colId: 'pinR' }, { rowId: 'r0', colId: 'pinL' }),
            snapshot
        );

        expect(resolved?.colIds).toEqual(['pinL', 'a', 'b', 'c', 'pinR']);
    });

    it('lists placeholder rows as unloaded', () => {
        const withPlaceholders = grid([
            dataRow('r0'),
            loadingRow('load-1', 1),
            dataRow('r2'),
            { ...loadingRow('fail-3', 3), kind: 'failed', error: null } as GridRow<Data>,
            dataRow('r4'),
        ]);
        const resolved = resolveRange(
            rangeFromCells({ rowId: 'r0', colId: 'a' }, { rowId: 'r4', colId: 'a' }),
            withPlaceholders
        );

        expect(resolved?.rowIds).toEqual(['r0', 'r2', 'r4']);
        expect(resolved?.unloadedIndexes).toEqual([1, 3]);
        expect(resolved?.startIndex).toBe(0);
        expect(resolved?.endIndex).toBe(4);
    });

    it('keeps group and full width rows in rowIds', () => {
        const mixed = grid([groupRow('g'), dataRow('r1'), fullWidthRow('f')]);

        expect(
            resolveRange(rangeFromCells({ rowId: 'g', colId: 'a' }, { rowId: 'f', colId: 'a' }), mixed)?.rowIds
        ).toEqual(['g', 'r1', 'f']);
    });

    it('returns null when the anchor row or column is gone', () => {
        expect(
            resolveRange(rangeFromCells({ rowId: 'gone', colId: 'a' }, { rowId: 'r1', colId: 'a' }), snapshot)
        ).toBeNull();
        expect(
            resolveRange(rangeFromCells({ rowId: 'r0', colId: 'hidden' }, { rowId: 'r1', colId: 'a' }), snapshot)
        ).toBeNull();
    });

    it('collapses to the anchor cell when the end is gone', () => {
        const resolved = resolveRange(
            rangeFromCells({ rowId: 'r2', colId: 'b' }, { rowId: 'gone', colId: 'hidden' }),
            snapshot
        );

        expect(resolved).toEqual({ rowIds: ['r2'], colIds: ['b'], startIndex: 2, endIndex: 2, unloadedIndexes: [] });
    });

    it('shrinks when rows between the corners leave the display', () => {
        const filtered = grid([rows5[0]!, rows5[2]!, rows5[4]!]);

        expect(
            resolveRange(rangeFromCells({ rowId: 'r0', colId: 'a' }, { rowId: 'r4', colId: 'a' }), filtered)?.rowIds
        ).toEqual(['r0', 'r2', 'r4']);
    });
});

describe('cellRangeEdges', () => {
    const snapshot = grid(rows5);
    const resolve = (anchor: [string, string], end: [string, string]): ResolvedCellRange =>
        resolveRange(
            rangeFromCells({ rowId: anchor[0], colId: anchor[1] }, { rowId: end[0], colId: end[1] }),
            snapshot
        )!;

    it('marks the outline of a single range', () => {
        const ranges = [resolve(['r1', 'a'], ['r3', 'c'])];

        expect(cellRangeEdges(ranges, 'r1', 'a', snapshot)).toEqual({
            inRange: true,
            top: true,
            bottom: false,
            left: true,
            right: false,
            count: 1,
        });
        expect(cellRangeEdges(ranges, 'r2', 'b', snapshot)).toEqual({
            inRange: true,
            top: false,
            bottom: false,
            left: false,
            right: false,
            count: 1,
        });
        expect(cellRangeEdges(ranges, 'r3', 'c', snapshot)).toEqual({
            inRange: true,
            top: false,
            bottom: true,
            left: false,
            right: true,
            count: 1,
        });
        expect(cellRangeEdges(ranges, 'r0', 'a', snapshot).inRange).toBe(false);
        expect(cellRangeEdges(ranges, 'r2', 'pinR', snapshot).inRange).toBe(false);
    });

    it('marks all four edges for a single cell range', () => {
        expect(cellRangeEdges([resolve(['r2', 'b'], ['r2', 'b'])], 'r2', 'b', snapshot)).toEqual({
            inRange: true,
            top: true,
            bottom: true,
            left: true,
            right: true,
            count: 1,
        });
    });

    it('keeps both outlines and counts overlapping ranges', () => {
        const ranges = [resolve(['r0', 'a'], ['r2', 'b']), resolve(['r1', 'b'], ['r3', 'c'])];

        expect(cellRangeEdges(ranges, 'r1', 'b', snapshot)).toEqual({
            inRange: true,
            top: true,
            bottom: false,
            left: true,
            right: true,
            count: 2,
        });
        expect(cellRangeEdges(ranges, 'r2', 'b', snapshot)).toEqual({
            inRange: true,
            top: false,
            bottom: true,
            left: true,
            right: true,
            count: 2,
        });
        expect(cellRangeEdges(ranges, 'r0', 'a', snapshot).count).toBe(1);
    });

    it('returns no edges for unknown cells', () => {
        expect(cellRangeEdges([resolve(['r0', 'a'], ['r4', 'c'])], 'gone', 'a', snapshot).inRange).toBe(false);
    });
});

describe('extendRange', () => {
    const columns = [column('pinL'), column('a'), column('skip', false), column('b'), column('pinR')];
    const snapshot = grid(rows5, columns);
    const start = rangeFromCells({ rowId: 'r2', colId: 'a' }, { rowId: 'r2', colId: 'a' });

    it('moves the end with arrows and keeps the anchor', () => {
        const down = extendRange(start, snapshot, 'down');

        expect(down).toEqual({ anchor: { rowId: 'r2', colId: 'a' }, end: { rowId: 'r3', colId: 'a' } });
        expect(extendRange(down, snapshot, 'right').end).toEqual({ rowId: 'r3', colId: 'b' });
        expect(extendRange(start, snapshot, 'up').end).toEqual({ rowId: 'r1', colId: 'a' });
        expect(extendRange(start, snapshot, 'left').end).toEqual({ rowId: 'r2', colId: 'pinL' });
    });

    it('skips non focusable columns', () => {
        expect(extendRange(start, snapshot, 'right').end.colId).toBe('b');
    });

    it('clamps at the grid edges', () => {
        const corner = rangeFromCells({ rowId: 'r0', colId: 'pinL' }, { rowId: 'r0', colId: 'pinL' });
        const farCorner = rangeFromCells({ rowId: 'r4', colId: 'pinR' }, { rowId: 'r4', colId: 'pinR' });

        expect(extendRange(corner, snapshot, 'up').end).toEqual({ rowId: 'r0', colId: 'pinL' });
        expect(extendRange(corner, snapshot, 'left').end).toEqual({ rowId: 'r0', colId: 'pinL' });
        expect(extendRange(farCorner, snapshot, 'down').end).toEqual({ rowId: 'r4', colId: 'pinR' });
        expect(extendRange(farCorner, snapshot, 'right').end).toEqual({ rowId: 'r4', colId: 'pinR' });
    });

    it('goes to the row and grid edges with Home and End', () => {
        expect(extendRange(start, snapshot, 'rowStart').end).toEqual({ rowId: 'r2', colId: 'pinL' });
        expect(extendRange(start, snapshot, 'rowEnd').end).toEqual({ rowId: 'r2', colId: 'pinR' });
        expect(extendRange(start, snapshot, 'gridStart').end).toEqual({ rowId: 'r0', colId: 'pinL' });
        expect(extendRange(start, snapshot, 'gridEnd').end).toEqual({ rowId: 'r4', colId: 'pinR' });
    });

    it('pages only with a page size, clamped', () => {
        expect(extendRange(start, snapshot, 'pageDown')).toBe(start);
        expect(extendRange(start, snapshot, 'pageDown', { pageSize: 10 }).end.rowId).toBe('r4');
        expect(extendRange(start, snapshot, 'pageUp', { pageSize: 1 }).end.rowId).toBe('r1');
    });

    it('ignores Tab and a gone anchor', () => {
        expect(extendRange(start, snapshot, 'next')).toBe(start);
        expect(extendRange(start, snapshot, 'previous')).toBe(start);

        const orphan = rangeFromCells({ rowId: 'gone', colId: 'a' }, { rowId: 'r1', colId: 'a' });

        expect(extendRange(orphan, snapshot, 'down')).toBe(orphan);
    });

    it('extends from the anchor when the end is gone', () => {
        const range = rangeFromCells({ rowId: 'r2', colId: 'a' }, { rowId: 'gone', colId: 'a' });

        expect(extendRange(range, snapshot, 'down').end).toEqual({ rowId: 'r3', colId: 'a' });
    });
});

describe('numericValue', () => {
    it('accepts numbers, numeric strings and money objects', () => {
        expect(numericValue(12.5)).toBe(12.5);
        expect(numericValue(' 140360.27 ')).toBe(140360.27);
        expect(numericValue('-3')).toBe(-3);
        expect(numericValue({ amount: 17457.42, currency: 'EUR' })).toBe(17457.42);
        expect(numericValue({ amount: '10' })).toBe(10);
    });

    it('rejects text, blanks, booleans and non finite values', () => {
        for (const value of [
            'abc',
            '',
            '  ',
            '£140,360.27',
            true,
            null,
            undefined,
            NaN,
            Infinity,
            {},
            { amount: null },
            [1],
        ]) {
            expect(numericValue(value)).toBeNull();
        }
    });
});

describe('aggregate', () => {
    function range(snapshot: GridSnapshot<Data>, anchor: [string, string], end: [string, string]): ResolvedCellRange {
        return resolveRange(
            rangeFromCells({ rowId: anchor[0], colId: anchor[1] }, { rowId: end[0], colId: end[1] }),
            snapshot
        )!;
    }

    it('sums numbers and numeric strings, skipping nulls and text', () => {
        const snapshot = grid([
            dataRow('r0', { a: 10 }),
            dataRow('r1', { a: '20.5' }),
            dataRow('r2', { a: null }),
            dataRow('r3', { a: 'TBC' }),
            dataRow('r4', { a: -0.5 }),
        ]);

        expect(aggregate([range(snapshot, ['r0', 'a'], ['r4', 'a'])], snapshot)).toEqual({
            sum: 30,
            avg: 10,
            min: -0.5,
            max: 20.5,
            count: 4,
            numericCount: 3,
            groups: [{ key: null, sum: 30, avg: 10, min: -0.5, max: 20.5, numericCount: 3 }],
            mixed: false,
        });
    });

    it('counts each cell once when ranges overlap', () => {
        const snapshot = grid(['r0', 'r1', 'r2'].map((id, index) => dataRow(id, { a: index + 1, b: 10 })));
        const result = aggregate(
            [range(snapshot, ['r0', 'a'], ['r1', 'b']), range(snapshot, ['r1', 'a'], ['r2', 'a'])],
            snapshot
        );

        expect(result.sum).toBe(1 + 2 + 3 + 10 + 10);
        expect(result.numericCount).toBe(5);
    });

    it('skips placeholder, group and full width rows', () => {
        const snapshot = grid([
            groupRow('g'),
            dataRow('r1', { a: 5 }),
            loadingRow('l', 2),
            fullWidthRow('f'),
            dataRow('r4', { a: 7 }),
        ]);

        expect(aggregate([range(snapshot, ['g', 'a'], ['r4', 'a'])], snapshot)).toMatchObject({
            sum: 12,
            count: 2,
            numericCount: 2,
        });
    });

    it('returns nulls when nothing is numeric', () => {
        const snapshot = grid([dataRow('r0', { a: 'x' }), dataRow('r1', {})]);

        expect(aggregate([range(snapshot, ['r0', 'a'], ['r1', 'a'])], snapshot)).toEqual({
            sum: null,
            avg: null,
            min: null,
            max: null,
            count: 1,
            numericCount: 0,
            groups: [],
            mixed: false,
        });
        expect(aggregate([], snapshot).count).toBe(0);
    });

    it('sums money objects in one currency', () => {
        const snapshot = grid([
            dataRow('r0', { a: { amount: 100, currency: 'GBP' } }),
            dataRow('r1', { a: { amount: '40.27', currency: { code: 'GBP' } } }),
        ]);
        const result = aggregate([range(snapshot, ['r0', 'a'], ['r1', 'a'])], snapshot);

        expect(result.sum).toBeCloseTo(140.27);
        expect(result.mixed).toBe(false);
        expect(result.groups.map((group) => group.key)).toEqual(['GBP']);
    });

    it('never adds different currencies together', () => {
        const snapshot = grid([
            dataRow('r0', { a: { amount: 140000, currency: 'GBP' } }),
            dataRow('r1', { a: { amount: 17457.42, currencyCode: 'EUR' } }),
            dataRow('r2', { a: { amount: 360.27, currency: 'GBP' } }),
        ]);
        const result = aggregate([range(snapshot, ['r0', 'a'], ['r2', 'a'])], snapshot);

        expect(result.mixed).toBe(true);
        expect(result).toMatchObject({ sum: null, avg: null, min: null, max: null, count: 3, numericCount: 3 });
        expect(result.groups).toHaveLength(2);
        expect(result.groups[0]).toMatchObject({ key: 'GBP', numericCount: 2, min: 360.27, max: 140000 });
        expect(result.groups[0]?.sum).toBeCloseTo(140360.27);
        expect(result.groups[1]).toEqual({
            key: 'EUR',
            sum: 17457.42,
            avg: 17457.42,
            min: 17457.42,
            max: 17457.42,
            numericCount: 1,
        });
    });

    it('groups by a row field such as a currency kept on the row', () => {
        const snapshot = grid([
            dataRow('r0', { a: 100, currency: { code: 'GBP', symbol: '£' } }),
            dataRow('r1', { a: 50, currency: { code: 'EUR', symbol: '€' } }),
            dataRow('r2', { a: 25, currency: { code: 'GBP', symbol: '£' } }),
        ]);
        const result = aggregate([range(snapshot, ['r0', 'a'], ['r2', 'a'])], snapshot, {
            groupKeyOf: (row) => (row.data.currency as { code: string } | undefined)?.code ?? null,
        });

        expect(result.groups.map(({ key, sum }) => [key, sum])).toEqual([
            ['GBP', 125],
            ['EUR', 50],
        ]);
    });
});

/** Small seeded generator so property failures reproduce. */
function random(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('cellRangeEdges property', () => {
    it('marks exactly the cells inside the resolved rectangles, with closed outlines', () => {
        for (let seed = 1; seed <= 200; seed++) {
            const next = random(seed);
            const pick = (max: number): number => Math.floor(next() * max);
            const rowCount = 1 + pick(8);
            const columnCount = 1 + pick(6);
            const rows = Array.from({ length: rowCount }, (_, index) =>
                next() < 0.2 ? loadingRow(`l${index}`, index) : dataRow(`r${index}`)
            );
            const columns = Array.from({ length: columnCount }, (_, index) => column(`c${index}`));
            const snapshot = grid(rows, columns);
            const cellAt = (rowIndex: number, columnIndex: number) => ({
                rowId: rows[rowIndex]!.id,
                colId: columns[columnIndex]!.colId,
            });

            const rectangles: { top: number; bottom: number; left: number; right: number }[] = [];
            const resolved: ResolvedCellRange[] = [];
            const rangeCount = 1 + pick(3);

            for (let index = 0; index < rangeCount; index++) {
                const [r1, r2, c1, c2] = [pick(rowCount), pick(rowCount), pick(columnCount), pick(columnCount)];
                const result = resolveRange(rangeFromCells(cellAt(r1, c1), cellAt(r2, c2)), snapshot);

                expect(result).not.toBeNull();
                resolved.push(result!);
                rectangles.push({
                    top: Math.min(r1, r2),
                    bottom: Math.max(r1, r2),
                    left: Math.min(c1, c2),
                    right: Math.max(c1, c2),
                });
            }

            for (let row = 0; row < rowCount; row++) {
                for (let col = 0; col < columnCount; col++) {
                    const cell = cellAt(row, col);
                    const edges = cellRangeEdges(resolved, cell.rowId, cell.colId, snapshot);
                    const containing = rectangles.filter(
                        (r) => row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
                    );
                    const context = `seed ${seed} cell ${row},${col}`;

                    expect(edges.inRange, context).toBe(containing.length > 0);
                    expect(edges.count, context).toBe(containing.length);
                    expect(edges.top, context).toBe(containing.some((r) => r.top === row));
                    expect(edges.bottom, context).toBe(containing.some((r) => r.bottom === row));
                    expect(edges.left, context).toBe(containing.some((r) => r.left === col));
                    expect(edges.right, context).toBe(containing.some((r) => r.right === col));
                }
            }

            for (const r of rectangles) {
                for (let col = r.left; col <= r.right; col++) {
                    expect(
                        cellRangeEdges(resolved, cellAt(r.top, col).rowId, cellAt(r.top, col).colId, snapshot).top
                    ).toBe(true);
                    expect(
                        cellRangeEdges(resolved, cellAt(r.bottom, col).rowId, cellAt(r.bottom, col).colId, snapshot)
                            .bottom
                    ).toBe(true);
                }
                for (let row = r.top; row <= r.bottom; row++) {
                    expect(
                        cellRangeEdges(resolved, cellAt(row, r.left).rowId, cellAt(row, r.left).colId, snapshot).left
                    ).toBe(true);
                    expect(
                        cellRangeEdges(resolved, cellAt(row, r.right).rowId, cellAt(row, r.right).colId, snapshot).right
                    ).toBe(true);
                }
            }
        }
    });
});
