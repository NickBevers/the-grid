import { describe, expect, it } from 'vitest';

import type { GridRow } from '../contract';
import { type StickyRowsInput, stickyGroupRows } from './stickyRows';

type Spec = { id: string; level: number; parentId: string | null; group?: boolean; expanded?: boolean };

/** Rows of 30px each, in display order. */
function source(specs: Spec[], scrollTop: number): StickyRowsInput<unknown> {
    const rows = specs.map(
        (spec) =>
            (spec.group
                ? {
                      kind: 'group',
                      id: spec.id,
                      level: spec.level,
                      parentId: spec.parentId,
                      section: 'body',
                      groupColId: 'g',
                      key: spec.id,
                      keyPath: [spec.id],
                      childCount: null,
                      expanded: spec.expanded ?? true,
                      data: null,
                  }
                : {
                      kind: 'data',
                      id: spec.id,
                      level: spec.level,
                      parentId: spec.parentId,
                      section: 'body',
                      data: {},
                  }) as GridRow<unknown>
    );

    return {
        scrollTop,
        count: rows.length,
        rowAt: (index) => rows[index],
        indexOf: (id) => {
            const index = rows.findIndex((row) => row.id === id);

            return index < 0 ? undefined : index;
        },
        indexAtOffset: (offset) => (offset < 0 || offset >= rows.length * 30 ? undefined : Math.floor(offset / 30)),
        rowBounds: (index) => (index >= 0 && index < rows.length ? { top: index * 30, height: 30 } : undefined),
    };
}

const weeks: Spec[] = [
    { id: 'w1', level: 0, parentId: null, group: true },
    { id: 'mon', level: 1, parentId: 'w1' },
    { id: 'tue', level: 1, parentId: 'w1' },
    { id: 'wed', level: 1, parentId: 'w1' },
    { id: 'w2', level: 0, parentId: null, group: true },
    { id: 'thu', level: 1, parentId: 'w2' },
    { id: 'fri', level: 1, parentId: 'w2' },
];

const ids = (input: StickyRowsInput<unknown>) => stickyGroupRows(input).map((row) => `${row.id}@${row.top}`);

describe('sticky group rows', () => {
    it('sticks nothing while the group row is still in its place', () => {
        expect(ids(source(weeks, 0))).toEqual([]);
    });

    it('keeps the group row under the header while its rows scroll', () => {
        expect(ids(source(weeks, 10))).toEqual(['w1@0']);
        expect(ids(source(weeks, 65))).toEqual(['w1@0']);
    });

    it('lets the next group push the stuck row out, then sticks the next one', () => {
        // w2 starts at 120: at scrollTop 100 it is 20px below the top, so w1 is pushed up by 10px.
        expect(ids(source(weeks, 100))).toEqual(['w1@-10']);
        expect(ids(source(weeks, 125))).toEqual(['w2@0']);
    });

    it('stacks nested groups outermost first and pushes the inner one at its own end', () => {
        const nested: Spec[] = [
            { id: 'year', level: 0, parentId: null, group: true },
            { id: 'jan', level: 1, parentId: 'year', group: true },
            { id: 'a', level: 2, parentId: 'jan' },
            { id: 'b', level: 2, parentId: 'jan' },
            { id: 'c', level: 2, parentId: 'jan' },
            { id: 'feb', level: 1, parentId: 'year', group: true },
            { id: 'd', level: 2, parentId: 'feb' },
        ];

        expect(ids(source(nested, 40))).toEqual(['year@0', 'jan@30']);
        // feb starts at 150; at scrollTop 100 it is 50px down, so jan (30..60) is pushed up 10px, year stays.
        expect(ids(source(nested, 100))).toEqual(['year@0', 'jan@20']);
    });

    it('never sticks a collapsed group or rows outside groups', () => {
        const flat: Spec[] = [
            { id: 'g', level: 0, parentId: null, group: true, expanded: false },
            { id: 'x', level: 0, parentId: null },
            { id: 'y', level: 0, parentId: null },
        ];

        expect(ids(source(flat, 15))).toEqual([]);
        expect(ids(source(flat, 45))).toEqual([]);
    });
});
