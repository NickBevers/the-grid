import { describe, expect, it } from 'vitest';

import { pinnedRowId } from './ids';
import { buildPinnedRows } from './pinned';

describe('buildPinnedRows', () => {
    it('prefixes ids with the section so a totals row can share a body id', () => {
        const rows = buildPinnedRows('bottom', [{ id: 7, total: 10 }]);

        expect(rows[0]).toMatchObject({
            kind: 'data',
            id: pinnedRowId('bottom', '7'),
            section: 'bottom',
            level: 0,
            parentId: null,
        });
        expect(buildPinnedRows('top', [{ id: 7 }])[0]?.id).not.toBe(rows[0]?.id);
    });

    it('reuses unchanged row objects and rejects duplicates', () => {
        const data = { id: 1 };
        const first = buildPinnedRows('bottom', [data]);

        expect(buildPinnedRows('bottom', [data], undefined, first)[0]).toBe(first[0]);
        expect(buildPinnedRows('bottom', [{ id: 1 }], undefined, first)[0]).not.toBe(first[0]);
        expect(() => buildPinnedRows('bottom', [{ id: 1 }, { id: 1 }])).toThrow(/duplicate/);
    });
});
