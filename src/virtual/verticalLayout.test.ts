import { describe, expect, it } from 'vitest';

import type { GridRow } from '../contract';
import { detailRowId } from '../rows/ids';
import { buildLocalProjection, type LocalProjection } from '../rows/localProjection';
import { ServerProjection } from '../rows/serverProjection';
import { localRowSource, serverRowSource } from './rowSources';
import { VerticalLayout } from './verticalLayout';
import type { LayoutItem } from './window';

type Row = { id: number; tall?: boolean };

const rows = (count: number): Row[] => Array.from({ length: count }, (_, id) => ({ id }));

/** Physical top of every mounted index, walking the items like the browser lays them out. */
function positions(items: LayoutItem[], heightOf: (index: number) => number): Map<number, number> {
    const result = new Map<number, number>();
    let cursor = 0;
    for (const item of items) {
        if (item.type === 'spacer') {
            cursor += item.size;
            continue;
        }
        for (let index = item.start; index <= item.end; index++) {
            result.set(index, cursor);
            cursor += heightOf(index);
        }
    }

    return result;
}

function layoutFor(
    projection: LocalProjection<Row>,
    options: Partial<ConstructorParameters<typeof VerticalLayout<Row>>[0]> = {}
) {
    const layout = new VerticalLayout<Row>({ estimatedRowHeight: 32, overscan: 0, ...options });
    layout.setViewport(0, 640);
    layout.setSource(localRowSource(projection));

    return layout;
}

/** Where a row id sits relative to the viewport top, as the user sees it. */
function viewportOffset(layout: VerticalLayout<Row>, projection: LocalProjection<Row>, id: string): number {
    const index = projection.getIndexOf(id)!;

    return layout.getRowBounds(index)!.top - layout.getVirtualScrollTop();
}

describe('window', () => {
    it('mounts only the viewport plus overscan for 100,000 rows', () => {
        const layout = layoutFor(buildLocalProjection({ rows: rows(100_000) }), { overscan: 320 });
        layout.setViewport(1_000_000, 640);
        const window = layout.getWindow();
        const mounted = window.runs.reduce((sum, run) => sum + run.end - run.start + 1, 0);

        expect(window.totalHeight).toBe(3_200_000);
        expect(window.firstVisible).toBe(31_250);
        expect(mounted).toBeLessThanOrEqual(42);
    });

    it('places mounted rows at their offsets with measured heights', () => {
        const projection = buildLocalProjection({ rows: rows(1000) });
        const layout = layoutFor(projection);
        layout.recordHeights(
            Array.from({ length: 1000 }, (_, id) => ({ id: String(id), height: id % 3 === 0 ? 80 : 32 }))
        );
        layout.setViewport(5000, 640);
        const window = layout.getWindow();
        const placed = positions(window.items, (index) => layout.getRowBounds(index)!.height);

        for (const [index, top] of placed) {
            expect(top).toBe(layout.getRowBounds(index)!.top);
        }
    });

    it('keeps retained rows mounted outside the window', () => {
        const layout = layoutFor(buildLocalProjection({ rows: rows(10_000) }));
        layout.setRetained(['3']);
        layout.setViewport(100_000, 640);

        expect(layout.getWindow().runs[0]).toEqual({ start: 3, end: 3 });
    });
});

describe('row height rules', () => {
    it('uses a fixed height without measuring', () => {
        const projection = buildLocalProjection({ rows: rows(10) });
        const layout = layoutFor(projection, { rowHeight: 40 });

        expect(layout.recordHeights([{ id: '0', height: 99 }])).toBeNull();
        expect(layout.getRowBounds(5)).toEqual({ top: 200, height: 40 });
        expect(layout.shouldMeasure(projection.getRow('0')!)).toBe(false);
    });

    it('mixes fixed and measured heights per row', () => {
        const projection = buildLocalProjection({ rows: rows(4).map((row) => ({ ...row, tall: row.id === 2 })) });
        const layout = layoutFor(projection, {
            rowHeight: (row: GridRow<Row>) => (row.kind === 'data' && row.data.tall ? 'measure' : 30),
        });
        layout.recordHeights([
            { id: '1', height: 500 },
            { id: '2', height: 90 },
        ]);

        expect(layout.getRowBounds(3)).toEqual({ top: 150, height: 30 });
    });
});

describe('anchoring', () => {
    it('keeps the first visible row still when a row above grows', () => {
        const projection = buildLocalProjection({ rows: rows(1000) });
        const layout = layoutFor(projection);
        layout.setViewport(3200, 640);
        const before = viewportOffset(layout, projection, '100');

        const correction = layout.recordHeights([{ id: '50', height: 132 }]);

        expect(correction).toEqual({ scrollTop: 3300 });
        expect(viewportOffset(layout, projection, '100')).toBe(before);
    });

    it('does not move the view when rows below the anchor change', () => {
        const projection = buildLocalProjection({ rows: rows(1000) });
        const layout = layoutFor(projection);
        layout.setViewport(3200, 640);

        expect(layout.recordHeights([{ id: '105', height: 200 }])).toBeNull();
    });

    it('keeps measured heights by id when rows are inserted above', () => {
        const first = buildLocalProjection({ rows: rows(1000) });
        const layout = layoutFor(first);
        layout.recordHeights([{ id: '500', height: 100 }]);
        layout.setViewport(15_000, 640);
        const anchorBefore = viewportOffset(
            layout,
            first,
            String(layout.getIndexAtOffset(layout.getVirtualScrollTop()))
        );

        const inserted = buildLocalProjection({
            rows: [...rows(20).map((row) => ({ id: row.id + 5000 })), ...rows(1000)],
            previous: first,
        });
        const correction = layout.setSource(localRowSource(inserted));

        expect(correction).not.toBeNull();
        expect(layout.getRowBounds(inserted.getIndexOf('500')!)!.height).toBe(100);
        expect(viewportOffset(layout, inserted, '468')).toBeCloseTo(anchorBefore + (468 - 468), 6);
    });

    it('keeps the anchor row in place when a detail row expands above it', () => {
        const master = (id: number) => id === 10;
        const collapsed = buildLocalProjection({ rows: rows(500), isMaster: (row) => master(row.id) });
        const layout = layoutFor(collapsed);
        layout.setViewport(3205, 640);
        const anchorId = String(layout.getIndexAtOffset(layout.getVirtualScrollTop()));
        const before = viewportOffset(layout, collapsed, anchorId);

        const expanded = buildLocalProjection({
            rows: rows(500),
            isMaster: (row) => master(row.id),
            expansion: new Map([['10', true]]),
            previous: collapsed,
        });
        layout.setSource(localRowSource(expanded));
        layout.recordHeights([{ id: detailRowId('10'), height: 240 }]);

        expect(viewportOffset(layout, expanded, anchorId)).toBeCloseTo(before, 6);
    });

    it('falls back to the next surviving row when the anchor disappears', () => {
        const first = buildLocalProjection({ rows: rows(1000) });
        const layout = layoutFor(first);
        layout.setViewport(3200, 640);
        const followerBefore = viewportOffset(layout, first, '101');

        const without = buildLocalProjection({ rows: rows(1000).filter((row) => row.id !== 100), previous: first });
        layout.setSource(localRowSource(without));

        expect(viewportOffset(layout, without, '101')).toBe(followerBefore - 32);
    });

    it('does not anchor at the very top, so rows inserted above push content down', () => {
        const first = buildLocalProjection({ rows: rows(100) });
        const layout = layoutFor(first);
        const inserted = buildLocalProjection({ rows: [{ id: 999 }, ...rows(100)] });

        expect(layout.setSource(localRowSource(inserted))).toBeNull();
        expect(layout.scrollTop).toBe(0);
    });

    it('keeps the view still across resetHeights', () => {
        const projection = buildLocalProjection({ rows: rows(1000) });
        const layout = layoutFor(projection);
        layout.recordHeights(Array.from({ length: 200 }, (_, id) => ({ id: String(id), height: 64 })));
        layout.setViewport(6400, 640);
        const before = viewportOffset(layout, projection, '100');

        layout.resetHeights();

        expect(viewportOffset(layout, projection, '100')).toBe(before);
        expect(layout.getRowBounds(0)!.height).toBe(32);
    });

    it('anchors in scaled mode for a million rows', () => {
        const projection = new ServerProjection<Row>({ blockSize: 100 });
        projection.setRowCount([], 1_000_000);
        const layout = new VerticalLayout<Row>({ estimatedRowHeight: 32, overscan: 0, rowHeight: 'measure' });
        layout.setViewport(0, 640);
        layout.setSource(serverRowSource(projection));
        expect(layout.mapping.scaled).toBe(true);

        layout.setViewport(5_000_000, 640);
        const anchorIndex = layout.getIndexAtOffset(layout.getVirtualScrollTop())!;
        const blockIndex = Math.floor((anchorIndex - 150) / 100);
        projection.setBlock(
            [],
            blockIndex,
            rows(100).map((row) => ({ id: blockIndex * 100 + row.id }))
        );
        layout.setSource(serverRowSource(projection));
        const before = layout.getRowBounds(anchorIndex)!.top - layout.getVirtualScrollTop();

        layout.recordHeights(rows(100).map((row) => ({ id: String(blockIndex * 100 + row.id), height: 50 })));

        expect(layout.getRowBounds(anchorIndex)!.top - layout.getVirtualScrollTop()).toBeCloseTo(before, 3);
    });
});

describe('placeholders', () => {
    const million = () => {
        const projection = new ServerProjection<Row>({ blockSize: 100 });
        projection.setRowCount([], 1_000_000);
        const layout = new VerticalLayout<Row>({ estimatedRowHeight: 32, overscan: 0, rowHeight: 'measure' });
        layout.setViewport(0, 640);
        layout.setSource(serverRowSource(projection));
        layout.setViewport(5_000_000, 640);

        return { projection, layout };
    };

    it('does not jump when only placeholders are visible and a block above loads', () => {
        const { projection, layout } = million();
        const before = layout.scrollTop;
        const first = layout.getIndexAtOffset(layout.getVirtualScrollTop())!;
        const blockIndex = Math.floor((first - 150) / 100);
        projection.setBlock(
            [],
            blockIndex,
            rows(100).map((row) => ({ id: blockIndex * 100 + row.id }))
        );

        expect(layout.setSource(serverRowSource(projection))).toBeNull();
        expect(layout.scrollTop).toBe(before);
    });

    it('captures the anchor cheaply over a million sparse rows', () => {
        const { projection, layout } = million();
        const started = performance.now();
        for (let i = 0; i < 20; i++) {
            layout.setSource(serverRowSource(projection));
        }

        expect((performance.now() - started) / 20).toBeLessThan(100);
    });
});

describe('scrollTopForIndex', () => {
    it('scrolls only as far as needed in auto mode', () => {
        const layout = layoutFor(buildLocalProjection({ rows: rows(1000) }));
        layout.setViewport(3200, 640);

        expect(layout.scrollTopForIndex(105)).toBe(3200);
        expect(layout.scrollTopForIndex(90)).toBe(2880);
        expect(layout.scrollTopForIndex(130)).toBe(130 * 32 + 32 - 640);
        expect(layout.scrollTopForIndex(130, 'start')).toBe(4160);
        expect(layout.scrollTopForIndex(130, 'center')).toBe(4160 - (640 - 32) / 2);
    });
});
