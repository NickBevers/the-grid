import { describe, expect, it } from 'vitest';

import {
    ColumnLayout,
    DEFAULT_COLUMN_WIDTH,
    DEFAULT_MIN_WIDTH,
    type ColumnSpec,
    type HorizontalWindow,
} from './horizontalLayout';

const hundred = (): ColumnSpec[] =>
    Array.from({ length: 100 }, (_, index) => ({
        colId: `c${index}`,
        width: 100 + (index % 4) * 20,
        pinned: index < 2 ? 'left' : index === 99 ? 'right' : null,
        groupPath: index < 2 || index === 99 ? [] : [`g${Math.floor(index / 10)}`, `s${Math.floor(index / 5)}`],
    }));

const mountedCenter = (layout: ColumnLayout, window: HorizontalWindow) =>
    window.centerRuns.flatMap((run) => layout.centerColumns(run).map((column) => column.colId));

describe('widths', () => {
    it('uses width, default width and min/max clamping', () => {
        const layout = new ColumnLayout([
            { colId: 'a', width: 120 },
            { colId: 'b' },
            { colId: 'c', width: 5 },
            { colId: 'd', width: 900, maxWidth: 300 },
        ]);

        expect(layout.getColumns().map((column) => column.width)).toEqual([
            120,
            DEFAULT_COLUMN_WIDTH,
            DEFAULT_MIN_WIDTH,
            300,
        ]);
        expect(layout.totalWidth).toBe(120 + DEFAULT_COLUMN_WIDTH + DEFAULT_MIN_WIDTH + 300);
    });

    it('shares the leftover width between flex columns and fills it exactly', () => {
        const layout = new ColumnLayout(
            [
                { colId: 'fixed', width: 100 },
                { colId: 'one', flex: 1 },
                { colId: 'two', flex: 2 },
            ],
            1000
        );

        expect(layout.getColumn('one')?.width).toBe(300);
        expect(layout.getColumn('two')?.width).toBe(600);
        layout.setViewportWidth(1001);
        expect(layout.totalWidth).toBe(1001);
    });

    it('freezes flex columns at their min or max and shares the rest again', () => {
        const layout = new ColumnLayout(
            [
                { colId: 'a', flex: 1, maxWidth: 150 },
                { colId: 'b', flex: 1 },
                { colId: 'c', flex: 1, minWidth: 500 },
            ],
            900
        );

        expect(layout.getColumn('a')?.width).toBe(150);
        expect(layout.getColumn('c')?.width).toBe(500);
        expect(layout.getColumn('b')?.width).toBe(250);
    });

    it('keeps a resized width, stops flexing, survives setColumns, and resets', () => {
        const layout = new ColumnLayout(
            [
                { colId: 'a', flex: 1 },
                { colId: 'b', width: 100, minWidth: 80 },
            ],
            1000
        );

        expect(layout.resize('a', 250)).toBe(250);
        expect(layout.resize('b', 10)).toBe(80);
        layout.setViewportWidth(2000);
        expect(layout.getColumn('a')?.width).toBe(250);

        layout.setColumns([
            { colId: 'b', width: 100, minWidth: 80 },
            { colId: 'a', flex: 1 },
            { colId: 'new', width: 50 },
        ]);
        expect(layout.getColumns().map((column) => [column.colId, column.width])).toEqual([
            ['b', 80],
            ['a', 250],
            ['new', 50],
        ]);

        layout.resetWidths(['a']);
        expect(layout.getColumn('a')?.width).toBe(2000 - 80 - 50);
    });
});

describe('sections and positions', () => {
    it('splits pinned sections and computes content and viewport positions', () => {
        const layout = new ColumnLayout(hundred(), 1440);
        const c50 = layout.getColumn('c50')!;

        expect(layout.getColumn('c0')?.section).toBe('left');
        expect(layout.getColumn('c99')?.section).toBe('right');
        expect(layout.getContentLeft('c50')).toBe(layout.leftWidth + c50.left);
        expect(layout.getViewportLeft('c0', 5000)).toBe(0);
        expect(layout.getViewportLeft('c50', 2000)).toBe(layout.leftWidth + c50.left - 2000);
        expect(layout.getViewportLeft('c99', 2000)).toBe(1440 - layout.rightWidth);
    });

    it('scrolls a center column fully into view between the pinned sections', () => {
        const layout = new ColumnLayout(hundred(), 1440);
        const column = layout.getColumn('c60')!;
        const visible = 1440 - layout.leftWidth - layout.rightWidth;

        expect(layout.scrollLeftForColumn('c60', 0)).toBe(column.left + column.width - visible);
        expect(layout.scrollLeftForColumn('c60', column.left + 10)).toBe(column.left);
        expect(layout.scrollLeftForColumn('c0', 777)).toBe(777);
    });
});

describe('window', () => {
    it('mounts pinned columns always and only nearby center columns', () => {
        const layout = new ColumnLayout(hundred(), 1440);
        const window = layout.getWindow(3000, 1440, 200);
        const mounted = mountedCenter(layout, window);

        expect(window.left.map((column) => column.colId)).toEqual(['c0', 'c1']);
        expect(window.right.map((column) => column.colId)).toEqual(['c99']);
        expect(mounted.length).toBeLessThanOrEqual(16);
        expect(window.totalWidth).toBe(layout.totalWidth);
    });

    it('keeps retained and keepMounted columns mounted as their own runs', () => {
        const specs = hundred().map((spec) => (spec.colId === 'c5' ? { ...spec, keepMounted: true } : spec));
        const layout = new ColumnLayout(specs, 1440);
        const window = layout.getWindow(6000, 1440, 0, ['c3']);
        const mounted = mountedCenter(layout, window);

        expect(mounted).toContain('c3');
        expect(mounted).toContain('c5');
        expect(window.centerRuns[0]).toEqual({ start: 1, end: 1 });
    });

    it('lays center items out to the exact center width', () => {
        const layout = new ColumnLayout(hundred(), 1440);
        for (const scroll of [0, 1234, 5000, layout.centerWidth]) {
            const window = layout.getWindow(scroll, 1440, 300, ['c10']);
            const total = window.centerItems.reduce(
                (sum, item) =>
                    sum +
                    (item.type === 'spacer'
                        ? item.size
                        : layout.centerColumns(item).reduce((width, column) => width + column.width, 0)),
                0
            );

            expect(total).toBe(layout.centerWidth);
        }
    });
});

describe('group header rows', () => {
    it('makes every group cell exactly as wide as the columns below it, at every scroll position', () => {
        const layout = new ColumnLayout(hundred(), 1440);
        expect(layout.groupDepth).toBe(2);
        for (const scroll of [0, 777, 4321, 9000]) {
            const window = layout.getWindow(scroll, 1440, 200, ['c40']);
            for (const row of layout.getGroupHeaderRows(window)) {
                const cells = [
                    ...row.left,
                    ...row.right,
                    ...row.center.flatMap((section) => (section.type === 'cells' ? section.cells : [])),
                ];
                for (const cell of cells) {
                    expect(cell.width).toBe(
                        cell.colIds.reduce((sum, colId) => sum + layout.getColumn(colId)!.width, 0)
                    );
                }
                // Spacers in the group rows are the body's spacers.
                const spacers = row.center
                    .filter((section) => section.type === 'spacer')
                    .map((section) => (section as { size: number }).size);
                expect(spacers).toEqual(
                    window.centerItems
                        .filter((item) => item.type === 'spacer')
                        .map((item) => (item as { size: number }).size)
                );
            }
        }
    });

    it('merges consecutive columns of one group and never across an outer group change', () => {
        const layout = new ColumnLayout(
            [
                { colId: 'a', groupPath: ['x', 'inner'] },
                { colId: 'b', groupPath: ['x', 'inner'] },
                { colId: 'c', groupPath: ['x'] },
                { colId: 'd', groupPath: ['y'] },
                { colId: 'e', groupPath: [] },
            ],
            2000
        );
        const [outer, inner] = layout.getGroupHeaderRows(layout.getWindow(0, 2000, 10_000));
        const cellsOf = (row: typeof outer) =>
            row!.center.flatMap((section) =>
                section.type === 'cells' ? section.cells.map((cell) => [cell.groupId, cell.colIds]) : []
            );

        expect(cellsOf(outer)).toEqual([
            ['x', ['a', 'b', 'c']],
            ['y', ['d']],
            [null, ['e']],
        ]);
        expect(cellsOf(inner)).toEqual([
            ['inner', ['a', 'b']],
            [null, ['c']],
            [null, ['d']],
            [null, ['e']],
        ]);
    });
});
