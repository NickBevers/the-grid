/**
 * Model-based fuzz test for the persisted-write layer of `GridStore` (and the `WriteTracker` behind it).
 *
 * Each case builds local rows (some locked through `canWrite`, one column editable per row only), an optional
 * `rangeEdit` and an optional sibling `propagateWrite` (rows of the same group share `note`). A fake server
 * keeps its own copy of the data. Every batch handed to `persist` waits until the test resolves it, in random
 * order, with a full success, a partial rejection or a thrown error. Accepted writes are applied to the server
 * copy in resolution order and normalised there (strings are uppercased). A success may return the server's
 * rows for the written rows, plus their group siblings.
 *
 * The expectations come from `src/contract/writes.ts`, the `WriteTracker` docblock and the `persist` option
 * docblocks, kept in an independent reference model:
 *
 * - a cell shows the server-kept value of its newest successful write, unless a later applied server row
 *   (the newest operation on the row owns reconciliation) replaced it; with no success, the original value;
 * - a cell is pending exactly while a write to it is unresolved;
 * - a rejected cell carries the server's error until a newer successful write to it;
 * - `writesSettled` fires once per batch with consistent counts and reconciled rows;
 * - `cellValueChanged` fires for every local write before it is persisted;
 * - non-editable cells and cells `canWrite` refuses are never written.
 *
 * A failure is shrunk (operations and option flags) and printed with its reproduction. `WRITES_FUZZ_SEEDS` sets
 * the case count and `WRITES_FUZZ_STATS=1` prints outcomes and coverage counters.
 *
 * The four bugs this fuzz found are fixed (2026-10-01). Their reproductions at the bottom run as plain
 * tests, and the loop checks every one of them strictly.
 *
 * Expectations changed after the fixes: the error a cell shows is the newest write's, not the last
 * rejection to resolve (an older rejection resolving later is superseded, like its value).
 *
 * Expectations dropped as not following from the contract:
 * - a server row skipped because a newer write to the row was pending is not used for the cells it wrote,
 *   so those cells keep the value written (the newest operation owns reconciliation);
 * - a server row returned by an older batch that resolves last, with nothing newer pending, replaces the row
 *   returned for the newest operation (it holds fresher server data);
 * - once a server row was applied, an older write whose value equals the server's (clear and fill repeat
 *   values) may still roll back, because the contract's "still showing" test compares values.
 */
import { describe, expect, it } from 'vitest';

import type { CellPosition, ColumnDefinition, WriteBatch, WriteResult } from '../contract';
import { GridStore } from './store';

// Random

/** mulberry32. */
function createRandom(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    return {
        next,
        int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
        chance: (p: number): boolean => next() < p,
        pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    };
}

// Case data

type Row = { id: number; group: string; name: string; fee: number | null; note: string };

const COLS = ['id', 'group', 'name', 'fee', 'note'] as const;

type Outcome = 'ok' | 'partial' | 'throw';

type Op =
    | { t: 'edit'; row: number; col: number; range: RangeSpec | null }
    | { t: 'writeCells'; cells: { row: number; col: number }[] }
    | { t: 'paste'; row: number; col: number; height: number; width: number; range: RangeSpec | null }
    | { t: 'clear'; row: number; col: number; range: RangeSpec | null }
    | { t: 'fill'; range: RangeSpec; to: number }
    | { t: 'resolve'; pick: number; outcome: Outcome; seed: number; rows: boolean; siblings: boolean };

/** Rows and columns as indexes into the case's rows and `COLS`. */
type RangeSpec = { r1: number; r2: number; c1: number; c2: number };

type Case = {
    rows: Row[];
    locked: number[];
    feeLocked: number[];
    rangeEdit: boolean;
    propagate: boolean;
    /** Whether `canWrite` also checks the column's `editable` (the workaround for the clipboard bug). */
    canWriteChecksEditable: boolean;
    /** Whether the server normalises strings (uppercase) when it applies them. */
    normalise: boolean;
    ops: Op[];
    drainSeed: number;
};

function generateCase(seed: number): Case {
    const random = createRandom(seed);
    const count = random.int(3, 7);
    const rows: Row[] = [];
    for (let i = 0; i < count; i++) {
        rows.push({ id: i + 1, group: `g${random.int(1, 3)}`, name: `Name${i}`, fee: 100 + i, note: `note${i}` });
    }
    const locked = rows.filter(() => random.chance(0.2)).map((row) => row.id);
    const feeLocked = rows.filter(() => random.chance(0.2)).map((row) => row.id);
    const range = (): RangeSpec => ({
        r1: random.int(0, count - 1),
        r2: random.int(0, count - 1),
        c1: random.int(0, COLS.length - 1),
        c2: random.int(0, COLS.length - 1),
    });
    const maybeRange = (): RangeSpec | null => (random.chance(0.5) ? range() : null);
    const ops: Op[] = [];
    const length = random.int(5, 40);
    for (let i = 0; i < length; i++) {
        const roll = random.next();
        const row = random.int(0, count - 1);
        const col = random.int(0, COLS.length - 1);
        if (roll < 0.25) {
            ops.push({ t: 'edit', row, col, range: maybeRange() });
        } else if (roll < 0.35) {
            const cells = Array.from({ length: random.int(1, 4) }, () => ({
                row: random.int(0, count - 1),
                col: random.int(0, COLS.length - 1),
            }));
            ops.push({ t: 'writeCells', cells });
        } else if (roll < 0.43) {
            ops.push({ t: 'paste', row, col, height: random.int(1, 2), width: random.int(1, 2), range: maybeRange() });
        } else if (roll < 0.47) {
            ops.push({ t: 'clear', row, col, range: maybeRange() });
        } else if (roll < 0.51) {
            ops.push({ t: 'fill', range: range(), to: random.int(0, count - 1) });
        } else {
            ops.push({
                t: 'resolve',
                pick: random.next(),
                outcome: random.pick<Outcome>(['ok', 'ok', 'partial', 'throw']),
                seed: random.int(1, 1e9),
                rows: random.chance(0.5),
                siblings: random.chance(0.5),
            });
        }
    }

    return {
        rows,
        locked,
        feeLocked,
        rangeEdit: random.chance(0.6),
        propagate: random.chance(0.6),
        canWriteChecksEditable: false,
        normalise: random.chance(0.5),
        ops,
        drainSeed: random.int(1, 1e9),
    };
}

// Running a case

class Violation extends Error {
    constructor(
        public code: string,
        message: string
    ) {
        super(`[${code}] ${message}`);
    }
}

function check(condition: boolean, code: string, message: () => string): asserts condition {
    if (!condition) {
        throw new Violation(code, message());
    }
}

type ModelOp = {
    id: number;
    rowId: string;
    colId: string;
    value: unknown;
    batch: ModelBatch;
    status: 'pending' | 'ok' | 'rejected';
    error?: string;
    /** Batches resolved before this write was issued. */
    issuedAt: number;
    derived?: string;
};

type ModelBatch = {
    seq: number;
    source: string;
    ops: ModelOp[];
    maxId: number;
    batch: WriteBatch<Row>;
    resolve: (result?: WriteResult<Row>) => void;
    reject: (error: unknown) => void;
    /** Server rows returned on success, by row id. */
    returned: Map<string, Row>;
    /** Returned rows the grid should apply (no newer write to the row pending at resolution). */
    applied: Set<string>;
    /** Position in resolution order. */
    resolvedAt: number;
    /** The newest operation id issued when the batch resolved: applied rows win over every write up to it. */
    watermark: number;
};

const key = (rowId: string, colId: string) => `${rowId}\u0000${colId}`;
const flush = async () => {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
    }
};

/** What the cases exercised, so a passing run can show it was not vacuous. */
const coverage = {
    batches: 0,
    writes: 0,
    overlapping: 0,
    rejected: 0,
    thrown: 0,
    rollbacks: 0,
    appliedRows: 0,
    derived: 0,
};

async function runCase(spec: Case): Promise<void> {
    const original = new Map(spec.rows.map((row) => [String(row.id), { ...row }]));
    const server = new Map(spec.rows.map((row) => [String(row.id), { ...row }]));
    const locked = new Set(spec.locked.map(String));
    const feeLocked = new Set(spec.feeLocked.map(String));
    const rowIds = spec.rows.map((row) => String(row.id));
    const groupOf = (rowId: string) => original.get(rowId)!.group;

    const isEditableCol = (rowId: string, colId: string) =>
        colId === 'name' || colId === 'fee' || (colId === 'note' && Number(rowId) % 3 !== 0);
    const isUnlocked = (cell: CellPosition) =>
        !locked.has(cell.rowId) && !(cell.colId === 'fee' && feeLocked.has(cell.rowId));
    // See the pinned bug below: paste, fill and clear only check `canWrite` once one is given, so the main
    // run repeats the editable check inside it, as an app has to until that is fixed.
    const canWrite = (cell: CellPosition) =>
        isUnlocked(cell) && (!spec.canWriteChecksEditable || isEditableCol(cell.rowId, cell.colId));
    const writable = (rowId: string, colId: string) => isEditableCol(rowId, colId) && isUnlocked({ rowId, colId });

    const columns: ColumnDefinition<Row>[] = [
        { field: 'id' },
        { field: 'group' },
        { field: 'name', editable: true },
        { field: 'fee', editable: true },
        { field: 'note', editable: (params) => (params.data as Row).id % 3 !== 0 },
    ];

    const ops: ModelOp[] = [];
    const batches: ModelBatch[] = [];
    const pending: ModelBatch[] = [];
    const changes: { cell: CellPosition; newValue: unknown }[] = [];
    const settled: {
        source: string;
        written: number;
        rejected: { cell: CellPosition; error: string }[];
        reconciledRowIds: string[];
    }[] = [];
    const asyncErrors: unknown[] = [];
    /** Violations seen inside `persist`, which must not throw there (the store would read it as a failed save). */
    const violations: Violation[] = [];

    /*
     * The reference model of what each cell shows, built from the contract rules in `writes.ts`:
     * a local write shows at once; a success makes the value the server kept the cell's confirmed value
     * (unless a newer operation was already confirmed); a failure rolls back only when it is the newest
     * operation and its value still shows, to the newest pending write or else the confirmed value; server
     * rows replace a row unless a write newer than the batch is pending on it.
     */
    const screen = new Map<string, unknown>();
    for (const row of spec.rows) {
        for (const colId of COLS) {
            screen.set(key(String(row.id), colId), (row as Record<string, unknown>)[colId]);
        }
    }
    /** When a rollback last changed a cell of the row, as a position in resolution order. */
    const lastRollbackAt = new Map<string, number>();
    const entries = new Map<string, { confirmed: unknown; confirmedOp: number; pending: ModelOp[] }>();
    const modelWrite = (op: ModelOp, oldValue: unknown) => {
        const cellKey = key(op.rowId, op.colId);
        const shown = screen.get(cellKey);
        if (!Object.is(shown, oldValue)) {
            violations.push(
                new Violation(
                    'write.oldValue',
                    `${op.rowId}/${op.colId} oldValue ${String(oldValue)}, showing ${String(shown)}`
                )
            );
        }
        const entry = entries.get(cellKey) ?? { confirmed: shown, confirmedOp: 0, pending: [] };
        entry.pending.push(op);
        entries.set(cellKey, entry);
        screen.set(cellKey, op.value);
    };
    /** The value the server kept for a successful write: its returned row's value, else the value written. */
    const serverKept = (op: ModelOp): unknown => {
        const returned = op.batch.returned.get(op.rowId);

        return returned ? (returned as Record<string, unknown>)[op.colId] : op.value;
    };
    const modelSettle = (batch: ModelBatch) => {
        for (const op of batch.ops) {
            const cellKey = key(op.rowId, op.colId);
            const entry = entries.get(cellKey)!;
            entry.pending = entry.pending.filter((candidate) => candidate !== op);
            if (op.status === 'ok') {
                if (op.id > entry.confirmedOp) {
                    entry.confirmed = serverKept(op);
                    entry.confirmedOp = op.id;
                }
            } else if (
                !entry.pending.some((candidate) => candidate.id > op.id) &&
                Object.is(screen.get(cellKey), op.value)
            ) {
                const latest = entry.pending.reduce<ModelOp | null>((a, b) => (a && a.id > b.id ? a : b), null);
                screen.set(cellKey, latest && latest.id > entry.confirmedOp ? latest.value : entry.confirmed);
                coverage.rollbacks++;
                lastRollbackAt.set(op.rowId, batch.resolvedAt);
            }
            if (entry.pending.length === 0) {
                entries.delete(cellKey);
            }
        }
        coverage.appliedRows += batch.applied.size;
        coverage.rejected += batch.ops.filter((op) => op.status === 'rejected').length;
        for (const rowId of batch.applied) {
            const row = batch.returned.get(rowId) as Record<string, unknown>;
            for (const colId of COLS) {
                screen.set(key(rowId, colId), row[colId]);
            }
        }
    };
    let nextOp = 1;
    let resolvedCount = 0;

    const persist = (batch: WriteBatch<Row>): Promise<WriteResult<Row> | void> => {
        // Writes to non-editable or refused cells never happen.
        for (const write of batch.writes) {
            if (!writable(write.cell.rowId, write.cell.colId)) {
                violations.push(
                    new Violation(
                        'write.forbidden',
                        `${batch.source} persisted a write to ${write.cell.rowId}/${write.cell.colId}`
                    )
                );
            }
            // cellValueChanged fired for every local write before it is persisted.
            const index = changes.findIndex(
                (change) =>
                    change.cell.rowId === write.cell.rowId &&
                    change.cell.colId === write.cell.colId &&
                    Object.is(change.newValue, write.value)
            );
            if (index < 0) {
                violations.push(
                    new Violation(
                        'event.cellValueChanged',
                        `no cellValueChanged for ${write.cell.rowId}/${write.cell.colId} = ${String(write.value)}`
                    )
                );
            }
            if (index >= 0) {
                changes.splice(index, 1);
            }
        }
        changes.length = 0;

        return new Promise((resolve, reject) => {
            const model: ModelBatch = {
                seq: batches.length + 1,
                source: batch.source,
                ops: [],
                maxId: 0,
                batch,
                resolve,
                reject,
                returned: new Map(),
                applied: new Set(),
                resolvedAt: 0,
                watermark: 0,
            };
            for (const write of batch.writes) {
                const op: ModelOp = {
                    id: nextOp++,
                    rowId: write.cell.rowId,
                    colId: write.cell.colId,
                    value: write.value,
                    batch: model,
                    status: 'pending',
                    issuedAt: resolvedCount,
                    ...(write.derived ? { derived: write.derived } : {}),
                };
                model.ops.push(op);
                ops.push(op);
                modelWrite(op, write.oldValue);
            }
            model.maxId = Math.max(...model.ops.map((op) => op.id));
            coverage.batches++;
            coverage.writes += model.ops.length;
            coverage.derived += batch.writes.filter((write) => write.derived).length;
            coverage.overlapping += model.ops.filter(
                (op) => (entries.get(key(op.rowId, op.colId))?.pending.length ?? 0) > 1
            ).length;
            batches.push(model);
            pending.push(model);
        });
    };

    const store = new GridStore<Row>({
        rows: spec.rows.map((row) => ({ ...row })),
        getRowId: (data) => String(data.id),
        columns,
        interaction: 'cell',
        enableRanges: true,
        enableFill: true,
        canWrite,
        persist,
        ...(spec.rangeEdit ? { rangeEdit: true } : {}),
        ...(spec.propagate
            ? {
                  propagateWrite: (write, { forEachRow }) => {
                      const siblings: { cell: CellPosition; value: unknown }[] = [];
                      if (write.cell.colId !== 'note') {
                          return siblings;
                      }
                      forEachRow((row) => {
                          if (row.id !== write.cell.rowId && row.data.group === write.row.data.group) {
                              siblings.push({ cell: { rowId: row.id, colId: 'note' }, value: write.newValue });
                          }
                      });

                      return siblings;
                  },
              }
            : {}),
    });
    store.events.on('cellValueChanged', (event) => changes.push({ cell: event.cell, newValue: event.newValue }));
    store.events.on('writesSettled', (event) =>
        settled.push({ ...event, rejected: [...event.rejected], reconciledRowIds: [...event.reconciledRowIds] })
    );

    const valueOf = (rowId: string, colId: string): unknown =>
        (store.getRow(rowId) as { data: Record<string, unknown> }).data[colId];
    const cellAt = (row: number, col: number): CellPosition => ({
        rowId: rowIds[row % rowIds.length]!,
        colId: COLS[col % COLS.length]!,
    });
    const toRange = (range: RangeSpec) => ({ anchor: cellAt(range.r1, range.c1), end: cellAt(range.r2, range.c2) });
    let unique = 0;
    const freshValue = (colId: string): unknown =>
        colId === 'fee' ? 5000 + ++unique : `${colId === 'note' ? 't' : 'n'}${++unique}`;
    const track = (promise: Promise<unknown>) => promise.catch((error: unknown) => asyncErrors.push(error));

    /** The server applies accepted writes in resolution order, normalising strings. */
    const normalise = (value: unknown) => (spec.normalise && typeof value === 'string' ? value.toUpperCase() : value);

    const resolveBatch = async (
        batch: ModelBatch,
        outcome: Outcome,
        seed: number,
        withRows: boolean,
        withSiblings: boolean
    ) => {
        const random = createRandom(seed);
        pending.splice(pending.indexOf(batch), 1);
        batch.resolvedAt = ++resolvedCount;
        batch.watermark = nextOp - 1;
        const rejected: { cell: CellPosition; error: string }[] = [];
        if (outcome === 'throw') {
            for (const op of batch.ops) {
                op.status = 'rejected';
                op.error = `Down${batch.seq}`;
            }
        } else {
            // Rejections are keyed by cell, so a rejected cell rejects every write to it in the batch.
            const rejectedCells = new Set<string>();
            if (outcome === 'partial') {
                batch.ops.forEach((op) => random.chance(0.5) && rejectedCells.add(key(op.rowId, op.colId)));
                if (rejectedCells.size === 0) {
                    const op = batch.ops[random.int(0, batch.ops.length - 1)]!;
                    rejectedCells.add(key(op.rowId, op.colId));
                }
            }
            batch.ops.forEach((op) => {
                if (rejectedCells.has(key(op.rowId, op.colId))) {
                    op.status = 'rejected';
                    op.error = `Err${batch.seq}:${op.rowId}:${op.colId}`;
                    if (
                        !rejected.some((entry) => key(entry.cell.rowId, entry.cell.colId) === key(op.rowId, op.colId))
                    ) {
                        rejected.push({ cell: { rowId: op.rowId, colId: op.colId }, error: op.error });
                    }
                } else {
                    op.status = 'ok';
                    (server.get(op.rowId) as Record<string, unknown>)[op.colId] = normalise(op.value);
                }
            });
            if (withRows) {
                const ids = new Set(batch.ops.map((op) => op.rowId));
                if (withSiblings) {
                    const groups = new Set([...ids].map(groupOf));
                    for (const rowId of rowIds) {
                        if (groups.has(groupOf(rowId))) {
                            ids.add(rowId);
                        }
                    }
                }
                for (const rowId of ids) {
                    batch.returned.set(rowId, { ...server.get(rowId)! });
                    const newerPending = ops.some(
                        (op) => op.rowId === rowId && op.status === 'pending' && op.id > batch.maxId
                    );
                    if (!newerPending) {
                        batch.applied.add(rowId);
                    }
                }
            }
        }
        modelSettle(batch);
        const before = settled.length;
        if (outcome === 'throw') {
            coverage.thrown++;
            batch.reject(new Error(`Down${batch.seq}`));
        } else if (rejected.length === 0 && batch.returned.size === 0 && random.chance(0.5)) {
            batch.resolve();
        } else {
            batch.resolve({
                ...(rejected.length > 0 ? { rejected } : {}),
                ...(batch.returned.size > 0 ? { rows: [...batch.returned.values()].map((row) => ({ ...row })) } : {}),
            });
        }
        await flush();

        // writesSettled fires once per batch with consistent counts.
        check(
            settled.length === before + 1,
            'event.writesSettled.count',
            () => `batch ${batch.seq} fired writesSettled ${settled.length - before} times`
        );
        const event = settled[settled.length - 1]!;
        const expectedRejected = batch.ops
            .filter((op) => op.status === 'rejected')
            .map((op) => `${op.rowId}/${op.colId}:${op.error}`)
            .sort();
        const actualRejected = event.rejected
            .map((entry) => `${entry.cell.rowId}/${entry.cell.colId}:${entry.error}`)
            .sort();
        check(
            event.source === batch.source &&
                event.written === batch.ops.length - expectedRejected.length &&
                JSON.stringify(actualRejected) === JSON.stringify(expectedRejected),
            'event.writesSettled.payload',
            () =>
                `batch ${batch.seq}: got ${JSON.stringify(event)}, expected source ${batch.source}, written ${
                    batch.ops.length - expectedRejected.length
                }, rejected ${JSON.stringify(expectedRejected)}`
        );
        check(
            JSON.stringify([...event.reconciledRowIds].sort()) === JSON.stringify([...batch.applied].sort()),
            'event.writesSettled.reconciled',
            () =>
                `batch ${batch.seq}: reconciled ${JSON.stringify(event.reconciledRowIds)}, expected ${JSON.stringify([...batch.applied])}`
        );
    };

    /**
     * The final value once everything is resolved, for rows no server row was applied to: the value the server
     * kept for the newest successful write, else the original value. `null` when server rows decide instead.
     * The step-by-step model above is stricter; this is the plain end-state statement of the contract.
     */
    const finalExpected = (rowId: string, colId: string): { value: unknown } | null => {
        if (batches.some((batch) => batch.applied.has(rowId))) {
            return null;
        }
        const succeeded = ops.filter((op) => op.rowId === rowId && op.colId === colId && op.status === 'ok').at(-1);
        if (succeeded && succeeded.batch.returned.has(rowId)) {
            // Its server row was skipped because a newer write to the row was pending. The contract lets the
            // newest operation own reconciliation, so the cell may keep the value written; no prediction.
            return null;
        }

        return { value: succeeded ? serverKept(succeeded) : (original.get(rowId) as Record<string, unknown>)[colId] };
    };

    /**
     * The row the server returned for the newest operation on the row, when that batch returned it and no
     * later resolved batch replaced the row again with fresher server data (an older write resolving last
     * with nothing newer pending may do so).
     */
    const newestOpRow = (rowId: string): Record<string, unknown> | null => {
        const newest = ops.filter((op) => op.rowId === rowId).at(-1);
        const lastApplied = batches
            .filter((batch) => batch.applied.has(rowId))
            .sort((a, b) => a.resolvedAt - b.resolvedAt)
            .at(-1);
        // A rollback after the row was applied only happens when an older write's value equals the server's
        // (clear and fill repeat values): the "still showing" test of the contract cannot tell them apart.
        const rolledBackSince = lastApplied !== undefined && (lastRollbackAt.get(rowId) ?? 0) >= lastApplied.resolvedAt;
        const returned =
            newest && newest.batch === lastApplied && !rolledBackSince ? newest.batch.returned.get(rowId) : undefined;

        return returned ? (returned as Record<string, unknown>) : null;
    };

    const invariants = (final: boolean) => {
        if (violations.length > 0) {
            throw violations[0]!;
        }
        check(asyncErrors.length === 0, 'exception.async', () => String(asyncErrors[0]));
        for (const rowId of rowIds) {
            for (const colId of COLS) {
                const cellOps = ops.filter((op) => op.rowId === rowId && op.colId === colId);
                const cellPending = cellOps.some((op) => op.status === 'pending');
                const cell = { rowId, colId };
                const value = valueOf(rowId, colId);
                if (!writable(rowId, colId)) {
                    check(
                        Object.is(value, (original.get(rowId) as Record<string, unknown>)[colId]),
                        'write.forbidden.value',
                        () => `non-writable ${rowId}/${colId} changed to ${String(value)}`
                    );
                    continue;
                }
                check(
                    store.isCellPending(cell) === cellPending,
                    'pending',
                    () => `${rowId}/${colId} isCellPending=${store.isCellPending(cell)}, expected ${cellPending}`
                );
                const expected = screen.get(key(rowId, colId));
                {
                    if (!Object.is(value, expected)) {
                        // Pinned below: a rollback restores the raw value of an older success, not what the server kept.
                        const known =
                            typeof value === 'string' && value !== expected && value.toUpperCase() === expected;
                        throw new Violation(
                            known ? 'bug.rollbackIgnoresServerValue' : 'value',
                            `${rowId}/${colId} = ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`
                        );
                    }
                }
                if (final) {
                    const simple = finalExpected(rowId, colId);
                    check(
                        !simple || Object.is(value, simple.value),
                        'value.final',
                        () => `${rowId}/${colId} = ${JSON.stringify(value)}, expected ${JSON.stringify(simple?.value)}`
                    );
                    const serverRow = newestOpRow(rowId);
                    check(
                        !serverRow || Object.is(value, serverRow[colId]),
                        'value.serverRow',
                        () =>
                            `${rowId}/${colId} = ${JSON.stringify(value)}, server row has ${JSON.stringify(serverRow?.[colId])}`
                    );
                }
                if (!cellPending) {
                    const resolved = cellOps.filter((op) => op.status !== 'pending');
                    const newest = resolved.at(-1);
                    const error = store.cellError(cell);
                    if (newest?.status === 'ok') {
                        if (error !== undefined) {
                            // Pinned below. Errors do not change values, so the case goes on and the hit is counted.
                            const from = resolved.find((op) => op.error === error);
                            const superseded = from !== undefined && from.batch.resolvedAt > newest.issuedAt;
                            const code = superseded
                                ? 'bug.staleError.supersededRejection'
                                : `bug.staleError.notClearedBy.${newest.batch.source}${newest.derived ? `.${newest.derived}` : ''}`;
                            knownBugHits[code] = (knownBugHits[code] ?? 0) + 1;
                            throw new Violation(
                                code,
                                `cell ${cell.rowId}/${cell.colId} shows error "${error}" after a newer success`
                            );
                        }
                    } else if (newest?.status === 'rejected') {
                        // The newest write decides the cell, its error included: an older rejection that
                        // resolves later leaves no mark.
                        check(
                            error === newest.error,
                            'error.shown',
                            () => `${rowId}/${colId} error ${String(error)}, expected ${newest.error}`
                        );
                    }
                }
            }
        }
    };

    const setRange = (range: RangeSpec | null) => store.setRanges(range ? [toRange(range)] : []);

    const apply = async (op: Op) => {
        switch (op.t) {
            case 'edit': {
                setRange(op.range);
                const cell = cellAt(op.row, op.col);
                const started = store.startEditing(cell);
                check(typeof started === 'boolean', 'edit.sync', () => 'startEditing returned a promise');
                check(
                    started === writable(cell.rowId, cell.colId),
                    'edit.canEdit',
                    () => `startEditing ${cell.rowId}/${cell.colId} returned ${started}`
                );
                if (started) {
                    store.editing.setDraft(freshValue(cell.colId));
                    store.stopEditing(true, 'api');
                }
                break;
            }
            case 'writeCells':
                track(
                    store.writeCells(
                        op.cells.map(({ row, col }) => {
                            const cell = cellAt(row, col);

                            return { cell, value: freshValue(cell.colId) };
                        })
                    )
                );
                break;
            case 'paste': {
                setRange(op.range);
                store.focusCell(cellAt(op.row, op.col));
                const lines = Array.from({ length: op.height }, () =>
                    Array.from({ length: op.width }, () => String(7000 + ++unique)).join('\t')
                );
                track(store.paste(lines.join('\n')));
                break;
            }
            case 'clear':
                setRange(op.range);
                store.focusCell(cellAt(op.row, op.col));
                track(store.clear());
                break;
            case 'fill': {
                setRange(op.range);
                store.startFill();
                store.dragOverCell(cellAt(op.to, op.range.c1));
                store.pointerUp();
                break;
            }
            case 'resolve': {
                if (pending.length === 0) {
                    return;
                }
                const batch = pending[Math.floor(op.pick * pending.length)]!;
                await resolveBatch(batch, op.outcome, op.seed, op.rows, op.siblings);
                break;
            }
        }
        await flush();
    };

    for (const op of spec.ops) {
        await apply(op);
        invariants(false);
    }
    const drain = createRandom(spec.drainSeed);
    while (pending.length > 0) {
        await resolveBatch(
            drain.pick(pending),
            drain.pick<Outcome>(['ok', 'ok', 'partial', 'throw']),
            drain.int(1, 1e9),
            drain.chance(0.5),
            drain.chance(0.5)
        );
        invariants(false);
    }
    invariants(true);
    store.destroy();
}

async function failureOf(spec: Case): Promise<Violation | Error | null> {
    try {
        await runCase(spec);

        return null;
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
}

const codeOf = (error: Error) => (error instanceof Violation ? error.code : `exception:${error.message}`);

/** Deletes operations, then rows, while the same violation keeps happening. */
async function shrink(spec: Case, code: string): Promise<Case> {
    let current = spec;
    let progress = true;
    while (progress) {
        progress = false;
        for (let i = current.ops.length - 1; i >= 0; i--) {
            const candidate = { ...current, ops: current.ops.filter((_, index) => index !== i) };
            const failure = await failureOf(candidate);
            if (failure && codeOf(failure) === code) {
                current = candidate;
                progress = true;
            }
        }
        for (const flag of ['rangeEdit', 'propagate'] as const) {
            if (current[flag]) {
                const candidate = { ...current, [flag]: false };
                const failure = await failureOf(candidate);
                if (failure && codeOf(failure) === code) {
                    current = candidate;
                    progress = true;
                }
            }
        }
    }

    return current;
}

/** Runs seeds; returns the first failure (shrunk) or null. `skip` lists codes pinned elsewhere as known bugs. */
const outcomes: Record<string, number> = {};
/** Known bugs that do not stop a case: code to number of cells seen. */
const knownBugHits: Record<string, number> = {};

async function fuzz(
    seeds: number,
    skip: readonly string[] = []
): Promise<{ code: string; message: string; spec: Case } | null> {
    for (let seed = 1; seed <= seeds; seed++) {
        const spec = generateCase(seed);
        const failure = await failureOf(spec);
        if (failure) {
            outcomes[codeOf(failure)] = (outcomes[codeOf(failure)] ?? 0) + 1;
        } else {
            outcomes.clean = (outcomes.clean ?? 0) + 1;
        }
        if (failure && !skip.includes(codeOf(failure))) {
            const code = codeOf(failure);
            const small = await shrink(spec, code);
            const again = await failureOf(small);

            return { code, message: `seed ${seed}: ${again?.message ?? failure.message}`, spec: small };
        }
    }

    return null;
}

const env: Record<string, string | undefined> =
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SEEDS = Number(env.WRITES_FUZZ_SEEDS ?? 20000);

describe('GridStore persisted writes (fuzz)', () => {
    it(`holds the write contract over ${SEEDS} random cases`, async () => {
        const failure = await fuzz(SEEDS);
        if (env.WRITES_FUZZ_STATS) {
            console.log(JSON.stringify({ outcomes, knownBugHits, coverage }));
        }
        expect(failure, failure ? `${failure.message}\n${JSON.stringify(failure.spec)}` : '').toBeNull();
    }, 60_000);
});

/**
 * Bugs the fuzz loop found, shrunk to minimal reproductions. Each asserts the correct behaviour and is marked
 * `it.fails` until the store is fixed; drop the `.fails` (and the matching skip or known-bug count above)
 * with the fix.
 */
/** `WRITES_FUZZ_SHOW_BUGS=1` runs the pinned bugs as plain tests, to see each one fail on its assertion. */
const knownBug = it;

describe('GridStore persisted writes (fuzz findings)', () => {
    type Item = { id: number; name: string; fee: number; group: string };
    const pinnedColumns: ColumnDefinition<Item>[] = [
        { field: 'id' },
        { field: 'group' },
        { field: 'name', editable: true },
        { field: 'fee', editable: true },
    ];
    const at = (rowId: string, colId: string) => ({ rowId, colId });

    function setup(overrides: Partial<ConstructorParameters<typeof GridStore<Item>>[0]> = {}) {
        const calls: {
            batch: WriteBatch<Item>;
            resolve: (result?: WriteResult<Item>) => void;
            reject: (error: unknown) => void;
        }[] = [];
        const store = new GridStore<Item>({
            rows: [
                { id: 1, name: 'Bravo', fee: 30, group: 'g1' },
                { id: 2, name: 'alpha', fee: 10, group: 'g1' },
            ],
            getRowId: (data) => String(data.id),
            columns: pinnedColumns,
            interaction: 'cell',
            enableRanges: true,
            enableFill: true,
            persist: (batch) =>
                new Promise((resolve, reject) => {
                    calls.push({ batch, resolve, reject });
                }),
            ...overrides,
        });
        const edit = (rowId: string, colId: string, value: unknown) => {
            store.startEditing(at(rowId, colId));
            store.editing.setDraft(value);
            store.stopEditing(true, 'api');
        };
        const dataOf = (rowId: string) => (store.getRow(rowId) as { data: Item }).data;

        return { store, calls, edit, dataOf };
    }

    /*
     * Bug: once `canWrite` is given, paste, fill and clear no longer check the column's `editable`.
     * `PlanBuilder` (clipboard.ts:415) uses `canWrite` instead of `column.isEditable(row)`, not as well, and the
     * store passes its `canWrite` (a lock rule) straight in. Edits and `writeCells` check both, and
     * `api.writeCells` documents skipping non-editable cells "as for paste" (contract/api.ts:56). The
     * `ClipboardHooks.canWrite` docblock ("Default: column.isEditable(row)") reads as a replacement; with
     * `canWrite` used for locked rows that writes ids and other read-only columns.
     */
    knownBug('paste does not write a non-editable column when canWrite is set', async () => {
        const { store, calls, dataOf } = setup({ canWrite: (cell) => cell.rowId !== '2' });
        store.focusCell(at('1', 'group'));
        void store.paste('g9');
        await Promise.resolve();

        expect(calls).toHaveLength(0);
        expect(dataOf('1').group).toBe('g1');
    });

    /*
     * Bug: an older success that returned server rows becomes the rollback baseline at the value written,
     * not the value the server kept. `#persist` calls `this.#writes.succeed(write.cell, id)` (store.ts:1304)
     * without the server row's value, though `WriteTracker.succeed` takes "what the server kept". When the
     * returned row is skipped because a newer write is pending, and that newer write fails, the cell rolls
     * back to a value the server never stored.
     */
    knownBug('a rollback restores the value the server kept for the older success', async () => {
        const { calls, edit, dataOf } = setup();
        edit('1', 'name', 'zulu');
        edit('1', 'name', 'yankee');
        calls[0]!.resolve({ rows: [{ id: 1, name: 'ZULU', fee: 30, group: 'g1' }] });
        await Promise.resolve();
        await Promise.resolve();
        calls[1]!.resolve({ rejected: [{ cell: at('1', 'name'), error: 'No' }] });
        await Promise.resolve();
        await Promise.resolve();

        expect(dataOf('1').name).toBe('ZULU');
    });

    /*
     * Bug: the rejection of a superseded write still marks the cell invalid. `#persist` sets the error for
     * every rejected write (store.ts:1319), even when a newer write to the cell exists, and a success never
     * clears an error. Here the newer write saved and the cell shows its value, with the older write's error.
     */
    knownBug('an older rejection arriving after a newer success leaves no error on the cell', async () => {
        const { store, calls } = setup();
        void store.writeCells([{ cell: at('1', 'fee'), value: 1 }]);
        void store.writeCells([{ cell: at('1', 'fee'), value: 2 }]);
        calls[1]!.resolve();
        await Promise.resolve();
        await Promise.resolve();
        calls[0]!.resolve({ rejected: [{ cell: at('1', 'fee'), error: 'Too low' }] });
        await Promise.resolve();
        await Promise.resolve();

        expect((store.getRow('1') as { data: Item }).data.fee).toBe(2);
        expect(store.cellError(at('1', 'fee'))).toBeUndefined();
    });

    /*
     * Bug: a later successful `writeCells`, range-edit or sibling write does not clear a cell's error. Only an
     * edit of the cell itself and paste, fill or clear (`#writeCell`) delete it; `writeCells` (store.ts:1248)
     * and the derived writes of `#editCommitted` (store.ts:1215) do not, and success never clears.
     */
    knownBug('a later successful writeCells clears the error of an earlier rejection', async () => {
        const { store, calls, edit } = setup();
        edit('1', 'fee', 5);
        calls[0]!.resolve({ rejected: [{ cell: at('1', 'fee'), error: 'Too low' }] });
        await Promise.resolve();
        await Promise.resolve();
        expect(store.cellError(at('1', 'fee'))).toBe('Too low');
        void store.writeCells([{ cell: at('1', 'fee'), value: 6 }]);
        calls[1]!.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(store.cellError(at('1', 'fee'))).toBeUndefined();
    });

    knownBug('a later successful range edit clears the error of an earlier rejection', async () => {
        const { store, calls, edit } = setup({ rangeEdit: true });
        edit('2', 'fee', 5);
        calls[0]!.resolve({ rejected: [{ cell: at('2', 'fee'), error: 'Too low' }] });
        await Promise.resolve();
        await Promise.resolve();
        store.setRanges([{ anchor: at('1', 'fee'), end: at('2', 'fee') }]);
        edit('1', 'fee', 7);
        expect(calls[1]!.batch.writes.map((write) => write.cell.rowId)).toEqual(['1', '2']);
        calls[1]!.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(store.cellError(at('2', 'fee'))).toBeUndefined();
    });
});
