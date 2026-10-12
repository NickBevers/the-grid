import { describe, expect, it } from 'vitest';

import { buildLocalProjection } from '../rows/localProjection';
import { ColumnLayout, type ColumnSpec } from '../virtual/horizontalLayout';
import { localRowSource } from '../virtual/rowSources';
import { VerticalLayout } from '../virtual/verticalLayout';
import { EventBus } from './eventBus';
import { createGeometry, type ViewportAdapter } from './geometry';

const HEADER = 40;

function setup({
    rows = 1000,
    scrollTop = 0,
    scrollLeft = 0,
    width = 1000,
    height = 640,
    pinnedBottomHeight = undefined as number | undefined,
    pinnedBottomScrollTop = 0,
    pinnedBottom = [] as { id: string; height: number }[],
    stickyRowsAt = undefined as
        | ((scrollTop: number) => { id: string; index: number; top: number; height: number }[])
        | undefined,
} = {}) {
    const projection = buildLocalProjection({ rows: Array.from({ length: rows }, (_, id) => ({ id })) });
    const source = localRowSource(projection);
    const specs: ColumnSpec[] = [
        { colId: 'pin', width: 100, pinned: 'left' },
        ...Array.from({ length: 30 }, (_, index): ColumnSpec => ({ colId: `c${index}`, width: 100 })),
        { colId: 'act', width: 80, pinned: 'right' },
    ];
    const columns = new ColumnLayout(specs, width);
    const vertical = new VerticalLayout<{ id: number }>({ estimatedRowHeight: 30, rowHeight: 30, overscan: 0 });
    const state = { scrollTop, scrollLeft };
    const bodyHeight = height - HEADER - (pinnedBottomHeight ?? pinnedBottom.reduce((sum, row) => sum + row.height, 0));
    vertical.setViewport(0, bodyHeight);
    vertical.setSource(source);
    vertical.setViewport(scrollTop, bodyHeight);
    const viewport: ViewportAdapter = {
        rect: () => ({ top: 100, left: 50, width, height }),
        clientWidth: () => width,
        clientHeight: () => height,
        scrollTop: () => state.scrollTop,
        scrollLeft: () => state.scrollLeft,
        setScrollTop: (top) => {
            state.scrollTop = top;
            vertical.setViewport(top, bodyHeight);
        },
        setScrollLeft: (left) => {
            state.scrollLeft = left;
        },
    };
    const geometry = createGeometry({
        vertical,
        columns,
        source: () => source,
        viewport,
        headerHeight: () => HEADER,
        pinnedBottom: () => pinnedBottom,
        ...(pinnedBottomHeight !== undefined ? { pinnedBottomHeight: () => pinnedBottomHeight } : {}),
        pinnedBottomScrollTop: () => pinnedBottomScrollTop,
        isFullWidth: (id) => id === '7',
        ...(stickyRowsAt ? { stickyRowsAt } : {}),
    });

    return { geometry, state, columns };
}

describe('browser scroll timing', () => {
    it('hits and anchors rows at the browser position before its scroll event updates the layout', () => {
        const { geometry, state } = setup();
        state.scrollTop = 120;

        expect(geometry.getScroll().top).toBe(120);
        expect(geometry.hitTest(70, 155)).toMatchObject({ area: 'cell', rowIndex: 4 });
        expect(geometry.getCellAnchor({ rowId: '4', colId: 'pin' })?.top).toBe(140);
        geometry.scrollBy({ top: 30 });
        expect(state.scrollTop).toBe(150);
    });
});

describe('bounds', () => {
    it('reports row and cell bounds for rows that are far from the viewport', () => {
        const { geometry } = setup({ scrollTop: 0 });

        expect(geometry.getRowBounds('900')).toEqual({ top: 27_000, left: 0, width: 100 + 3000 + 80, height: 30 });
        expect(geometry.getCellBounds({ rowId: '900', colId: 'c5' })).toEqual({
            top: 27_000,
            left: 100 + 500,
            width: 100,
            height: 30,
        });
        expect(geometry.getRowBounds('nope')).toBeUndefined();
    });

    it('reports pinned columns at their sticky position', () => {
        const { geometry } = setup({ scrollLeft: 1234 });

        expect(geometry.getCellBounds({ rowId: '0', colId: 'pin' })?.left).toBe(1234);
        expect(geometry.getCellBounds({ rowId: '0', colId: 'act' })?.left).toBe(1234 + 1000 - 80);
    });

    it('gives a full-width row the whole row as its cell', () => {
        const { geometry } = setup();

        expect(geometry.getCellBounds({ rowId: '7', colId: 'c3' })).toEqual(geometry.getRowBounds('7'));
    });
});

describe('anchors', () => {
    it('converts to client coordinates below the header and marks visibility', () => {
        const { geometry } = setup({ scrollTop: 300, scrollLeft: 200 });
        const anchor = geometry.getCellAnchor({ rowId: '12', colId: 'c4' })!;

        expect(anchor).toMatchObject({
            top: 100 + HEADER + 12 * 30 - 300,
            left: 50 + 100 + 400 - 200,
            width: 100,
            height: 30,
            visible: true,
        });
        expect(geometry.getCellAnchor({ rowId: '500', colId: 'c4' })?.visible).toBe(false);
        // Scrolled under the pinned left column.
        expect(geometry.getCellAnchor({ rowId: '12', colId: 'c0' })?.visible).toBe(false);
    });
});

describe('hit testing', () => {
    it('finds header, cells in every section, full-width rows, pinned rows, empty and outside', () => {
        const { geometry } = setup({ rows: 10, scrollLeft: 150, pinnedBottom: [{ id: 'total', height: 30 }] });
        const at = (x: number, y: number) => geometry.hitTest(50 + x, 100 + y);

        expect(at(10, 10)).toEqual({ area: 'header', colId: 'pin', groupId: null });
        expect(at(10, HEADER + 5)).toMatchObject({ area: 'cell', cell: { rowId: '0', colId: 'pin' }, section: 'left' });
        expect(at(120, HEADER + 35)).toMatchObject({
            area: 'cell',
            cell: { rowId: '1', colId: 'c1' },
            section: 'center',
        });
        expect(at(990, HEADER + 35)).toMatchObject({
            area: 'cell',
            cell: { rowId: '1', colId: 'act' },
            section: 'right',
        });
        expect(at(500, HEADER + 7 * 30 + 5)).toEqual({ area: 'fullWidthRow', rowId: '7', rowIndex: 7 });
        expect(at(500, 640 - 10)).toMatchObject({ area: 'pinnedRow', rowId: 'total', section: 'bottom' });
        expect(at(500, HEADER + 10 * 30 + 5)).toEqual({ area: 'empty' });
        expect(at(-1, 10)).toEqual({ area: 'outside' });
    });

    it('measures distance to the body edges for drag autoscroll', () => {
        const { geometry } = setup();
        const proximity = geometry.edgeProximity(50 + 110, 100 + HEADER + 3);

        expect(proximity).toEqual({ top: 3, bottom: 640 - HEADER - 3, left: 10, right: 1000 - 80 - 110 });
    });
});

describe('scrolling', () => {
    it('ensures cells visible on both axes and reports the visible range', () => {
        const { geometry, state } = setup();
        geometry.ensureCellVisible({ rowId: '200', colId: 'c20' });

        expect(state.scrollTop).toBe(200 * 30 + 30 - (640 - HEADER));
        expect(state.scrollLeft).toBe(20 * 100 + 100 - (1000 - 100 - 80));
        const range = geometry.getVisibleRange();
        expect(range.lastRow).toBe(200);
        expect(range.lastColumn).toBe(20);
    });

    it('scrolls in content coordinates', () => {
        const { geometry } = setup();
        geometry.setScroll({ top: 900, left: 30 });
        geometry.scrollBy({ top: 30 });

        expect(geometry.getScroll()).toEqual({ top: 930, left: 30 });
        expect(geometry.getContentSize()).toEqual({ width: 3180, height: 30_000 });
    });
});

describe('EventBus', () => {
    type Events = { ping: { n: number } };

    it('delivers in order and applies changes made during a dispatch from the next one', () => {
        const bus = new EventBus<Events>();
        const seen: string[] = [];
        const late = () => seen.push('late');
        bus.on('ping', () => {
            seen.push('first');
            bus.on('ping', late);
        });
        const removeSecond = bus.on('ping', () => {
            seen.push('second');
            removeSecond();
        });
        bus.emit('ping', { n: 1 });
        bus.emit('ping', { n: 2 });

        expect(seen).toEqual(['first', 'second', 'first', 'late']);
    });

    it('runs every listener even when one throws, and is inert after destroy', () => {
        const bus = new EventBus<Events>();
        const seen: number[] = [];
        bus.on('ping', () => {
            throw new Error('boom');
        });
        const off = bus.on('ping', (event) => seen.push(event.n));

        expect(() => bus.emit('ping', { n: 1 })).toThrow('boom');
        expect(seen).toEqual([1]);
        bus.destroy();
        bus.emit('ping', { n: 2 });
        off();
        expect(seen).toEqual([1]);
    });
});

describe('capped pinned rows', () => {
    it('reserves only the visible pinned height and hits the row at its scrolled offset', () => {
        const { geometry } = setup({
            pinnedBottom: [
                { id: 'summary-header', height: 40 },
                { id: 'summary-1', height: 32 },
                { id: 'summary-2', height: 32 },
                { id: 'summary-3', height: 32 },
                { id: 'summary-4', height: 32 },
            ],
            pinnedBottomHeight: 80,
            pinnedBottomScrollTop: 72,
        });
        expect(geometry.getViewportSize().height).toBe(520);
        expect(geometry.hitTest(100, 675)).toEqual({
            area: 'pinnedRow',
            rowId: 'summary-2',
            colId: 'pin',
            section: 'bottom',
        });
        expect(geometry.getCellAnchor({ rowId: 'summary-2', colId: 'pin' })).toEqual({
            top: 660,
            left: 50,
            width: 100,
            height: 32,
            visible: true,
        });
        expect(geometry.getCellAnchor({ rowId: 'summary-header', colId: 'pin' })?.visible).toBe(false);
        expect(geometry.hitTest(100, 650).area).toBe('cell');
    });
});

describe('sticky group rows', () => {
    // Row 2 sticks below the header once the grid scrolls past it.
    const stickyRowsAt = (scrollTop: number) => (scrollTop > 60 ? [{ id: '2', index: 2, top: 0, height: 30 }] : []);

    it('hits and anchors the stuck row where it sticks, and treats rows beneath it as hidden', () => {
        const { geometry } = setup({ scrollTop: 300, stickyRowsAt });

        expect(geometry.hitTest(70, 145)).toMatchObject({ area: 'cell', rowIndex: 2, cell: { rowId: '2' } });
        expect(geometry.hitTest(70, 175)).toMatchObject({ area: 'cell', rowIndex: 11 });
        expect(geometry.getCellAnchor({ rowId: '2', colId: 'pin' })).toMatchObject({ top: 140, visible: true });
        expect(geometry.getCellAnchor({ rowId: '10', colId: 'pin' })?.visible).toBe(false);
        expect(geometry.getCellAnchor({ rowId: '11', colId: 'pin' })?.visible).toBe(true);
    });

    it('scrolls a row into view below the stuck rows, not under them', () => {
        const { geometry, state } = setup({ scrollTop: 300, stickyRowsAt });
        geometry.ensureIndexVisible(5, 'start');

        expect(state.scrollTop).toBe(120);
    });
});
