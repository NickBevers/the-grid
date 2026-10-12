/**
 * Persisted writes playground. An order sheet where several lines share an order. The price is shared
 * (sibling propagation), notes are per row, locked rows refuse edits,
 * and a fake server validates, answers with authoritative rows (it stamps a revision), and can be slowed
 * down or made to fail per request.
 *
 *   ?fixture=writes
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import '../src/styles/grid.css';
import './themes/app-theme.css';
import {
    Grid,
    type ColumnDefinition,
    type GridApi,
    type PropagateWrite,
    type WriteBatch,
    type WriteResult,
    type WritesSettledEvent,
} from '../src';

type OrderLine = {
    id: number;
    orderId: number;
    date: string;
    product: string;
    price: number;
    notes: string;
    locked: boolean;
    revision: number;
};

const PRODUCTS = ['Desk', 'Chair', 'Lamp', 'Shelf', 'Cabinet', 'Table'];
const initialOrderLines = (): OrderLine[] =>
    Array.from({ length: 60 }, (_, index) => ({
        id: index + 1,
        orderId: 100 + Math.floor(index / 3),
        date: `2026-11-${String((index % 28) + 1).padStart(2, '0')}`,
        product: PRODUCTS[index % PRODUCTS.length]!,
        price: 1000 * (1 + (Math.floor(index / 3) % 9)),
        notes: '',
        locked: index % 10 === 9,
        revision: 1,
    }));

/** The fake server's copy of the data, the source of truth for authoritative rows. */
const server = {
    rows: initialOrderLines(),
    requests: [] as { source: string; cells: string[]; at: number; done?: number }[],
    latency: [] as number[],
    fail: [] as string[],
};

async function fakePersist(batch: WriteBatch<OrderLine>): Promise<WriteResult<OrderLine>> {
    const entry = {
        source: batch.source,
        cells: batch.writes.map(
            (write) => `${write.cell.rowId}.${write.cell.colId}${write.derived ? `(${write.derived})` : ''}`
        ),
        at: performance.now(),
    } as (typeof server.requests)[number];
    server.requests.push(entry);
    const delay = server.latency.shift() ?? 300;
    const failure = server.fail.shift();
    await new Promise((resolve) => setTimeout(resolve, delay));
    entry.done = performance.now();
    if (failure === 'network') {
        throw new Error('The server could not be reached.');
    }
    const rejected: { cell: { rowId: string; colId: string }; error: string }[] = [];
    const touched = new Set<number>();
    for (const write of batch.writes) {
        const row = server.rows.find((candidate) => String(candidate.id) === write.cell.rowId)!;
        if (row.locked) {
            rejected.push({ cell: write.cell, error: 'This order line is locked.' });
            continue;
        }
        if (write.cell.colId === 'price' && (typeof write.value !== 'number' || write.value > 100_000)) {
            rejected.push({ cell: write.cell, error: 'The price must be at most 100,000.' });
            continue;
        }
        (row as Record<string, unknown>)[write.cell.colId] =
            write.cell.colId === 'notes' ? String(write.value).trim() : write.value;
        touched.add(row.id);
    }
    // Shared fields reach every line of the order on the server too.
    for (const id of [...touched]) {
        const row = server.rows.find((candidate) => candidate.id === id)!;
        for (const sibling of server.rows) {
            if (sibling.orderId === row.orderId && sibling.price !== row.price && !sibling.locked) {
                sibling.price = row.price;
                touched.add(sibling.id);
            }
        }
    }
    const rows = [...touched].map((id) => {
        const row = server.rows.find((candidate) => candidate.id === id)!;
        row.revision++;

        return { ...row };
    });

    return { rejected, rows };
}

const columns: ColumnDefinition<OrderLine>[] = [
    { field: 'id', headerName: 'ID', width: 70, pinned: 'left' },
    { field: 'orderId', headerName: 'Order', width: 110 },
    { field: 'date', headerName: 'Date', width: 120 },
    { field: 'product', headerName: 'Product', width: 140, editable: true },
    {
        field: 'price',
        headerName: 'Price',
        width: 130,
        editable: true,
        cellEditor: {
            parse: (draft: unknown) => {
                const number = Number(String(draft).replace(/[^\d.-]/g, ''));

                return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, error: 'Enter a number.' };
            },
        } as never,
    },
    { field: 'notes', headerName: 'Notes', width: 220, editable: true },
    { field: 'locked', headerName: 'Locked', width: 90, valueFormatter: ({ value }) => (value ? 'Locked' : '') },
    { field: 'revision', headerName: 'Rev', width: 70 },
];

/** Shared fields: the price goes to the order's other lines that still had the old value. */
const propagatePrice: PropagateWrite<OrderLine> = (write, { forEachRow }) => {
    if (write.cell.colId !== 'price') {
        return [];
    }
    const siblings: { cell: { rowId: string; colId: string }; value: unknown }[] = [];
    forEachRow((row) => {
        if (
            row.id !== write.cell.rowId &&
            row.data.orderId === write.row.data.orderId &&
            row.data.price === write.oldValue
        ) {
            siblings.push({ cell: { rowId: row.id, colId: 'price' }, value: write.newValue });
        }
    });

    return siblings;
};

declare global {
    interface Window {
        __wr?: { api: GridApi<OrderLine> | null; server: typeof server; toasts: WritesSettledEvent[] };
    }
}

export function WritesPlayground() {
    const apiRef = useRef<GridApi<OrderLine> | null>(null);
    const rows = useMemo(() => server.rows.map((row) => ({ ...row })), []);
    const [toasts, setToasts] = useState<WritesSettledEvent[]>([]);
    useEffect(() => {
        window.__wr = {
            get api() {
                return apiRef.current;
            },
            server,
            toasts: [],
        };
    }, []);

    return (
        <div className="ig-page">
            <div className="ig-bar">
                <strong>Persisted writes</strong>
                <span>The price is shared per order. Over 100,000 is rejected. Every tenth row is locked.</span>
                <button type="button" data-test="fail-next" onClick={() => server.fail.push('network')}>
                    Fail next save
                </button>
                <button type="button" data-test="slow-next" onClick={() => server.latency.push(2000)}>
                    Slow next save
                </button>
            </div>
            <div className="ig-frame">
                <Grid<OrderLine>
                    className="ig app-theme"
                    data={{ type: 'local', rows, getRowId: (row) => String(row.id) }}
                    columns={columns}
                    apiRef={apiRef}
                    ariaLabel="Order lines"
                    enableRanges
                    enableFill
                    rangeEdit
                    persist={fakePersist}
                    propagateWrite={propagatePrice}
                    clipboard={{ canWrite: (_cell, row) => !(row as { data: OrderLine }).data.locked }}
                    on={{
                        writesSettled: (event) => {
                            window.__wr?.toasts.push(event);
                            setToasts((current) => [...current.slice(-2), event]);
                        },
                    }}
                    footer={
                        <div data-test="toasts">
                            {toasts.map((toast, index) => (
                                <span key={index} data-test="toast" data-rejected={toast.rejected.length || undefined}>
                                    {toast.source}: {toast.written} saved
                                    {toast.rejected.length
                                        ? `, ${toast.rejected.length} failed (${toast.rejected[0]!.error})`
                                        : ''}
                                    .{' '}
                                </span>
                            ))}
                        </div>
                    }
                />
            </div>
        </div>
    );
}
