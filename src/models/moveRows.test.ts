import { describe, expect, it } from 'vitest';

import { moveRows } from './moveRows';

const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
const ids = (list: { id: number }[]) => list.map((row) => row.id);

describe('moveRows', () => {
    it('moves rows before or after the target, keeping their order', () => {
        expect(ids(moveRows(rows, { rowIds: ['4'], overRowId: '1', position: 'before' }))).toEqual([4, 1, 2, 3, 5]);
        expect(ids(moveRows(rows, { rowIds: ['1', '3'], overRowId: '4', position: 'after' }))).toEqual([2, 4, 1, 3, 5]);
        expect(ids(moveRows(rows, { rowIds: ['5', '2'], overRowId: '3', position: 'before' }))).toEqual([
            1, 5, 2, 3, 4,
        ]);
    });

    it('changes nothing for a drop on a dragged row or an unknown row', () => {
        expect(ids(moveRows(rows, { rowIds: ['2'], overRowId: '2', position: 'after' }))).toEqual([1, 2, 3, 4, 5]);
        expect(ids(moveRows(rows, { rowIds: ['2'], overRowId: '99', position: 'after' }))).toEqual([1, 2, 3, 4, 5]);
    });

    it('takes a getRowId', () => {
        const keyed = [{ key: 'a' }, { key: 'b' }];
        expect(moveRows(keyed, { rowIds: ['b'], overRowId: 'a', position: 'before' }, (data) => data.key)).toEqual([
            { key: 'b' },
            { key: 'a' },
        ]);
    });
});
