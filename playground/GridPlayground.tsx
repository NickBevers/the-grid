/**
 * Playground for both virtualizers together. 100,000 rows x 100 columns, two levels of header groups,
 * two columns pinned left and one right, a wrapping Notes column that sets the row height (autoHeight, so
 * it stays mounted), and a resize handle on every header cell.
 *
 *   ?fixture=grid
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import {
    buildLocalProjection,
    hasData,
    HeaderRows,
    localRowSource,
    RowCells,
    rowLineStyle,
    useGridGeometry,
    useHorizontalVirtualizer,
    useVerticalVirtualizer,
    VirtualRows,
    type ColumnSpec,
    type HorizontalVirtualizer,
    type LaidOutColumn,
} from '../src';
import { hash, noteFor } from './fixtures/localFixture';

type Row = { id: number };

const params = new URLSearchParams(location.search);
/** `rows=1000000` gives a scaled grid; with more than 100,000 rows heights are fixed so it stays cheap. */
const ROWS = Number(params.get('rows') ?? 100_000);
const FIXED_HEIGHT = ROWS > 100_000;
const HEADER_ROW_HEIGHT = 32;

const COLUMNS: ColumnSpec[] = Array.from({ length: 100 }, (_, index): ColumnSpec => {
    if (index === 0) {
        return { colId: 'id', width: 80, pinned: 'left' };
    }
    if (index === 1) {
        return { colId: 'name', width: 170, minWidth: 100, pinned: 'left' };
    }
    if (index === 2) {
        return { colId: 'notes', width: 280, minWidth: 120, keepMounted: true, groupPath: ['details'] };
    }
    if (index === 99) {
        return { colId: 'actions', width: 110, pinned: 'right' };
    }

    return {
        colId: `c${index}`,
        width: 100 + (index % 4) * 20,
        minWidth: 60,
        maxWidth: 400,
        groupPath: [`group-${Math.floor(index / 12)}`, `sub-${Math.floor(index / 4)}`],
    };
});

const LABELS: Record<string, string> = { id: 'ID', name: 'Name', notes: 'Notes', actions: 'Actions' };

function cellText(row: Row, colId: string): string {
    if (colId === 'id') {
        return String(row.id);
    }
    if (colId === 'name') {
        return `Person ${row.id}`;
    }
    if (colId === 'notes') {
        return noteFor(row.id, false);
    }
    if (colId === 'actions') {
        return 'Open';
    }

    return String(hash(row.id * 131 + Number(colId.slice(1))) % 100_000);
}

function ResizeHandle({ column, horizontal }: { column: LaidOutColumn; horizontal: HorizontalVirtualizer }) {
    const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = column.width;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) =>
            horizontal.resize(column.colId, startWidth + moveEvent.clientX - startX);
        const up = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    };

    return <span className="pg-resize" data-resize={column.colId} onPointerDown={onPointerDown} />;
}

export function GridPlayground() {
    const scrollRef = useRef<HTMLDivElement>(null);
    const projection = useMemo(
        () => buildLocalProjection<Row>({ rows: Array.from({ length: ROWS }, (_, id) => ({ id })) }),
        []
    );
    const source = useMemo(() => localRowSource(projection), [projection]);
    const [retainedColIds, setRetainedColIds] = useState<string[]>([]);
    const horizontal = useHorizontalVirtualizer({
        scrollRef,
        columns: COLUMNS,
        columnsVersion: COLUMNS,
        retainedColIds,
    });
    const headerHeight = (horizontal.layout.groupDepth + 1) * HEADER_ROW_HEIGHT;
    const vertical = useVerticalVirtualizer<Row>({
        scrollRef,
        source,
        sourceVersion: projection,
        estimatedRowHeight: 32,
        rowHeight: FIXED_HEIGHT ? 32 : 'measure',
        insetTop: headerHeight,
    });
    const { geometry, events } = useGridGeometry<Row>({ scrollRef, vertical, horizontal, source, headerHeight });
    const eventLog = useRef<{ scroll: number; visibleRangeChanged: number }>({ scroll: 0, visibleRangeChanged: 0 });
    useEffect(() => {
        const offScroll = events.on('scroll', () => eventLog.current.scroll++);
        const offRange = events.on('visibleRangeChanged', () => eventLog.current.visibleRangeChanged++);

        return () => {
            offScroll();
            offRange();
        };
    }, [events]);

    useEffect(() => {
        window.__pg = {
            fixture: 'grid',
            resize: (colId: string, width: number) => horizontal.resize(colId, width),
            scrollToColumn: (colId: string) => horizontal.scrollToColumn(colId),
            retainColumns: (colIds: string[]) => setRetainedColIds(colIds),
            totalWidth: () => horizontal.layout.totalWidth,
            columnWidth: (colId: string) => horizontal.layout.getColumn(colId)?.width,
            geometry,
            rowCount: ROWS,
            eventLog: () => ({ ...eventLog.current }),
        };
    });

    return (
        <div ref={scrollRef} className="pg-viewport" data-grid-part="viewport">
            <div className="pg-grid-header" style={{ width: horizontal.window.totalWidth }}>
                <HeaderRows
                    horizontal={horizontal}
                    rowHeight={HEADER_ROW_HEIGHT}
                    renderGroupCell={(cell) => (
                        <div className="pg-group-cell">
                            <span className="pg-group-label" style={{ left: horizontal.window.leftWidth }}>
                                {cell.groupId ?? ''}
                            </span>
                        </div>
                    )}
                    renderHeaderCell={(column) => (
                        <div className="pg-header-cell">
                            <span className="pg-header-label">
                                {LABELS[column.colId] ?? `Column ${column.colId.slice(1)}`}
                            </span>
                            <ResizeHandle column={column} horizontal={horizontal} />
                        </div>
                    )}
                />
            </div>
            <VirtualRows
                virtualizer={vertical}
                renderRow={(row, _index, rowProps) => (
                    <div
                        {...rowProps}
                        className="pg-grid-row"
                        style={{ ...rowProps.style, ...rowLineStyle(horizontal.window) }}
                    >
                        <RowCells
                            horizontal={horizontal}
                            renderCell={(column) => (
                                <div
                                    className={
                                        column.colId === 'notes' && !FIXED_HEIGHT
                                            ? 'pg-grid-cell pg-wrap'
                                            : 'pg-grid-cell'
                                    }
                                >
                                    {hasData(row) ? cellText(row.data, column.colId) : ''}
                                </div>
                            )}
                        />
                    </div>
                )}
            />
        </div>
    );
}
