/**
 * Playground for the library's vertical virtualizer (`useVerticalVirtualizer`, `VirtualRows`) with
 * library projections. Rows here have a fixed set of cells. The grid fixture adds horizontal
 * virtualization.
 *
 *   ?fixture=local   100,000 rows, content-measured heights (wrapping notes)
 *   ?fixture=detail  100,000 rows, every tenth row a master with an expandable detail row
 *   ?fixture=remote  1,000,000 rows from a fake backend in 100-row blocks, fixed height, scaled scrolling
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
    buildLocalProjection,
    hasData,
    localRowSource,
    ServerProjection,
    serverRowSource,
    useVerticalVirtualizer,
    VirtualRows,
    type GridRow,
    type RowRenderProps,
} from '../src';
import { hash, noteFor } from './fixtures/localFixture';
import { fakeBackend, REMOTE_ROW_COUNT } from './fixtures/remoteFixture';

type Row = { id: number; name: string };

declare global {
    interface Window {
        __pg?: Record<string, unknown>;
    }
}

const HEADER_HEIGHT = 36;
const LOCAL_COUNT = 100_000;

function Cells({ row, grown }: { row: Row; grown: boolean }) {
    return (
        <>
            <div className="pg-cell pg-id">{row.id}</div>
            <div className="pg-cell pg-name">{row.name}</div>
            <div className="pg-cell pg-notes">{noteFor(row.id, grown)}</div>
            {[3, 4, 5, 6].map((col) => (
                <div key={col} className="pg-cell">
                    {hash(row.id * 131 + col) % 100_000}
                </div>
            ))}
        </>
    );
}

function Header() {
    return (
        <div className="pg-header" style={{ height: HEADER_HEIGHT }}>
            <span className="pg-toggle" />
            <div className="pg-cell pg-id">ID</div>
            <div className="pg-cell pg-name">Name</div>
            <div className="pg-cell pg-notes">Notes</div>
            {[3, 4, 5, 6].map((col) => (
                <div key={col} className="pg-cell">
                    Column {col}
                </div>
            ))}
        </div>
    );
}

function LocalPlayground({ withDetail }: { withDetail: boolean }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const data = useMemo(() => Array.from({ length: LOCAL_COUNT }, (_, id): Row => ({ id, name: `Person ${id}` })), []);
    const [expansion, setExpansion] = useState<ReadonlyMap<string, boolean>>(new Map());
    const [grown, setGrown] = useState<ReadonlySet<number>>(new Set());
    const [retained, setRetained] = useState<string[]>([]);
    const previous = useRef<ReturnType<typeof buildLocalProjection<Row>> | undefined>(undefined);
    const projection = useMemo(() => {
        const next = buildLocalProjection<Row>({
            rows: data,
            expansion,
            ...(withDetail ? { isMaster: (row: Row) => row.id % 10 === 0 } : {}),
            ...(previous.current ? { previous: previous.current } : {}),
        });
        previous.current = next;

        return next;
    }, [data, expansion, withDetail]);
    const source = useMemo(() => localRowSource(projection), [projection]);
    const virtualizer = useVerticalVirtualizer<Row>({
        scrollRef,
        source,
        sourceVersion: projection,
        estimatedRowHeight: 32,
        rowHeight: 'measure',
        insetTop: HEADER_HEIGHT,
        retainedIds: retained,
    });

    const toggle = useCallback(
        (id: number) => setExpansion((current) => new Map(current).set(String(id), !current.get(String(id)))),
        []
    );

    useEffect(() => {
        window.__pg = {
            fixture: withDetail ? 'detail' : 'local',
            toggleDetail: (id: number) => toggle(id),
            growRow: (id: number) => setGrown((current) => new Set(current).add(id)),
            resetHeights: () => virtualizer.resetHeights(),
            retain: (ids: string[]) => setRetained(ids),
            scrollToIndex: (index: number, align?: 'auto' | 'start' | 'center' | 'end') =>
                virtualizer.scrollToIndex(index, align),
            indexOf: (id: string) => projection.getIndexOf(id),
            rowCount: projection.getRowCount(),
        };
    });

    const renderRow = (row: GridRow<Row>, index: number, rowProps: RowRenderProps) => {
        if (row.kind === 'detail') {
            return (
                <div {...rowProps} className="pg-row pg-detail">
                    <div className="pg-detail-body">
                        Detail for person {row.data.id}. {noteFor(row.data.id * 7, true)}{' '}
                        {noteFor(row.data.id * 13, row.data.id % 20 === 0)}
                    </div>
                </div>
            );
        }
        if (!hasData(row)) {
            return <div {...rowProps} className="pg-row pg-loading" />;
        }
        const expandable = row.kind === 'data' && row.expandable;

        return (
            <div {...rowProps} className="pg-row" data-kind={row.kind}>
                {expandable ? (
                    <button type="button" className="pg-toggle" onClick={() => toggle(row.data.id)}>
                        {row.expandable?.expanded ? '▾' : '▸'}
                    </button>
                ) : (
                    <span className="pg-toggle" />
                )}
                <Cells row={row.data} grown={grown.has(row.data.id)} />
                <span hidden>{index}</span>
            </div>
        );
    };

    return (
        <div ref={scrollRef} className="pg-viewport" data-grid-part="viewport">
            <Header />
            <VirtualRows virtualizer={virtualizer} renderRow={renderRow} />
        </div>
    );
}

function RemotePlayground() {
    const scrollRef = useRef<HTMLDivElement>(null);
    const projection = useMemo(() => {
        const created = new ServerProjection<Row>({ blockSize: 100 });
        created.setRowCount([], REMOTE_ROW_COUNT);

        return created;
    }, []);
    const [version, bump] = useReducer((value: number) => value + 1, 0);
    const pending = useRef(new Set<number>());
    const source = useMemo(() => serverRowSource(projection), [projection, version]);
    const virtualizer = useVerticalVirtualizer<Row>({
        scrollRef,
        source,
        sourceVersion: version,
        estimatedRowHeight: 32,
        rowHeight: 32,
        insetTop: HEADER_HEIGHT,
    });
    const { firstVisible, lastVisible } = virtualizer.window;

    // A minimal loader for the playground only. The grid's server row model has the real request manager.
    useEffect(() => {
        for (const { blockIndex } of projection.missingBlocks(firstVisible - 20, lastVisible + 20)) {
            if (pending.current.has(blockIndex)) {
                continue;
            }
            pending.current.add(blockIndex);
            void fakeBackend.fetchRows(blockIndex * 100, blockIndex * 100 + 100, '').then((rows) => {
                pending.current.delete(blockIndex);
                projection.setBlock(
                    [],
                    blockIndex,
                    rows.map((row) => ({ id: Number(row.id.split(':')[1]), name: row.label }))
                );
                bump();
            });
        }
    }, [projection, firstVisible, lastVisible, version]);

    useEffect(() => {
        window.__pg = {
            fixture: 'remote',
            requests: () => fakeBackend.requests,
            scrollToIndex: (index: number, align?: 'auto' | 'start' | 'center' | 'end') =>
                virtualizer.scrollToIndex(index, align),
            rowCount: REMOTE_ROW_COUNT,
        };
    });

    return (
        <div ref={scrollRef} className="pg-viewport" data-grid-part="viewport">
            <Header />
            <VirtualRows
                virtualizer={virtualizer}
                renderRow={(row, _index, rowProps) =>
                    hasData(row) ? (
                        <div {...rowProps} className="pg-row pg-fixed">
                            <span className="pg-toggle" />
                            <Cells row={row.data} grown={false} />
                        </div>
                    ) : (
                        <div {...rowProps} className="pg-row pg-loading" data-kind={row.kind}>
                            <span className="pg-skeleton" />
                        </div>
                    )
                }
            />
        </div>
    );
}

export function VerticalPlayground() {
    const fixture = new URLSearchParams(location.search).get('fixture') ?? 'local';

    return fixture === 'remote' ? <RemotePlayground /> : <LocalPlayground withDetail={fixture === 'detail'} />;
}
