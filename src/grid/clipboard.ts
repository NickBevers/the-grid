/**
 * Pure clipboard planning: TSV and HTML serialization, TSV parsing, and the plans for copy, paste, fill
 * and clear. Nothing here touches the DOM or the server. The Grid reads the clipboard, calls these
 * functions, and hands the planned writes to the app through `ClipboardHooks`.
 *
 * Paste uses range paste by default (`strategy: 'range'`); row paste, which repeats the copied rows over the
 * selected rows, is available as `strategy: 'rows'`.
 */
import type { CellPosition, GridRow, ResolvedCellRange, RowId } from '../contract';
import type { GridSnapshot, SnapshotColumn } from './snapshot';

/** Why a target cell received no value. */
export type ClipboardSkipReason = 'group' | 'placeholder' | 'readOnly' | 'outside';

/** One planned cell write. */
export type CellWrite = { cell: CellPosition; text: string };

/** One target cell that was left alone, with the reason. */
export type SkippedCell = { cell: CellPosition; reason: ClipboardSkipReason };

/** The outcome of a paste, fill or clear plan. Writes are unique per cell, in row then column order. */
export type CellPlan<TText extends string = string> = {
    writes: { cell: CellPosition; text: TText }[];
    skipped: SkippedCell[];
};

/** Options shared by the plans that write cells. */
export type WriteOptions<TData> = {
    /** Whether a cell may receive a value. Default: the column's `isEditable(row)`. */
    canWrite?(cell: CellPosition, row: GridRow<TData>): boolean;
};

/**
 * Paste options. `range` (default) is range paste. `rows` is row paste: columns from the focused column,
 * rows from the selected ranges, matrix rows repeated.
 */
export type PasteOptions<TData> = WriteOptions<TData> & {
    strategy?: 'range' | 'rows';
};

/** Options for `copyMatrix`. */
export type CopyOptions = {
    includeHeaders?: boolean;
    /** Header text for a column. Default: the colId. */
    headerOf?(colId: string): string;
    /** The text copied for a cell. Default: its formatted value. */
    formatCell?(row: GridRow<any>, colId: string, formatted: string): string;
};

/** The copied cells, plus the rows and columns they came from (header row not counted in `rowIds`). */
export type CopyResult = { matrix: string[][]; rowIds: RowId[]; colIds: string[] };

const NEEDS_QUOTES = /[\t\n\r"]/;

/**
 * Serializes a matrix as tab separated text that Excel and Google Sheets paste cell for cell. Cells with a
 * tab, newline or quote are quoted with doubled inner quotes. Rows are joined with `\n` and there is no
 * trailing newline. A last row holding one empty cell is written as `""` so it survives a round trip.
 */
export function serializeTsv(matrix: readonly (readonly string[])[]): string {
    return matrix
        .map((row, rowIndex) => {
            if (rowIndex > 0 && rowIndex === matrix.length - 1 && row.length === 1 && row[0] === '') {
                return '""';
            }

            return row.map(quoteTsvCell).join('\t');
        })
        .join('\n');
}

function quoteTsvCell(cell: string): string {
    return NEEDS_QUOTES.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * Parses tab separated clipboard text from Excel, Google Sheets or `serializeTsv`. Handles quoted cells
 * with embedded tabs, newlines and doubled quotes, CRLF, LF or lone CR line ends, and ignores one trailing
 * line end. Ragged rows stay ragged. Empty text gives one empty cell.
 */
export function parseTsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    let atCellStart = true;
    let endedWithNewline = false;

    for (let position = 0; position < text.length; position++) {
        const char = text[position] as string;
        endedWithNewline = false;

        if (inQuotes) {
            if (char !== '"') {
                cell += char;
            } else if (text[position + 1] === '"') {
                cell += '"';
                position++;
            } else {
                inQuotes = false;
            }

            continue;
        }

        if (char === '"' && atCellStart) {
            inQuotes = true;
            atCellStart = false;

            continue;
        }

        if (char === '\t') {
            row.push(cell);
            cell = '';
            atCellStart = true;

            continue;
        }

        if (char === '\n' || char === '\r') {
            if (char === '\r' && text[position + 1] === '\n') {
                position++;
            }

            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            atCellStart = true;
            endedWithNewline = true;

            continue;
        }

        cell += char;
        atCellStart = false;
    }

    if (!endedWithNewline || rows.length === 0) {
        row.push(cell);
        rows.push(row);
    }

    return rows;
}

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

const TABLE_STYLE = 'border-collapse:collapse;border:1px solid #ccc';
const CELL_STYLE = 'font-family:Arial,sans-serif;font-size:13px;padding:2px 4px;vertical-align:middle';
const ROW_STYLE = 'height:22px';

const HTML_SPECIAL = /[&<>"']/;

function escapeHtml(value: string): string {
    return HTML_SPECIAL.test(value) ? value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char) : value;
}

/**
 * Serializes a matrix as the HTML table the app writes next to the TSV (`buildHtmlTable`), so Google
 * Sheets and Excel keep cell boundaries. Values are escaped; an empty cell becomes `&nbsp;`. An optional
 * header row is written as `<thead>`. An empty matrix with no header gives an empty string.
 */
export function serializeHtml(
    matrix: readonly (readonly string[])[],
    options: { header?: readonly string[] } = {}
): string {
    const { header } = options;

    if (matrix.length === 0 && !header) {
        return '';
    }

    const cell = (tag: 'td' | 'th', value: string): string =>
        `<${tag} style="${CELL_STYLE}">${escapeHtml(value) || '&nbsp;'}</${tag}>`;
    const head = header
        ? `<thead><tr style="${ROW_STYLE}">${header.map((value) => cell('th', value)).join('')}</tr></thead>`
        : '';
    const body = matrix
        .map((row) => `<tr style="${ROW_STYLE}">${row.map((value) => cell('td', value)).join('')}</tr>`)
        .join('');

    return `<table border="1" cellspacing="0" style="${TABLE_STYLE}">${head}<tbody>${body}</tbody></table>`;
}

/**
 * Builds the copied matrix from formatted values. Rows come from
 * every range in range order, each row once; columns are the union of the ranges' columns in order of
 * first appearance. Group and full-width rows are left out. Unloaded rows are not in `rowIds` of a
 * resolved range and so are not copied; the server `serialize` hook covers them.
 */
export function copyMatrix<TData>(
    ranges: readonly ResolvedCellRange[],
    snapshot: GridSnapshot<TData>,
    options: CopyOptions = {}
): CopyResult {
    const colIds = [...new Set(ranges.flatMap((range) => range.colIds))].filter(
        (colId) => snapshot.columnIndexOf(colId) !== undefined
    );
    const columns = colIds.map(
        (colId) => snapshot.columns[snapshot.columnIndexOf(colId) as number] as SnapshotColumn<TData>
    );
    const seen = new Set<RowId>();
    const rows: GridRow<TData>[] = [];

    for (const range of ranges) {
        for (const rowId of range.rowIds) {
            if (seen.has(rowId)) {
                continue;
            }

            seen.add(rowId);
            const index = snapshot.indexOf(rowId);
            const row = index === undefined ? undefined : snapshot.rowAt(index);

            if (row && rowSkipReason(row, snapshot) === null) {
                rows.push(row);
            }
        }
    }

    const matrix = rows.map((row) =>
        columns.map((column, index) => {
            const formatted = column.formatValue(row);

            return options.formatCell ? options.formatCell(row, colIds[index]!, formatted) : formatted;
        })
    );

    if (options.includeHeaders) {
        matrix.unshift(colIds.map((colId) => options.headerOf?.(colId) ?? colId));
    }

    return { matrix, rowIds: rows.map((row) => row.id), colIds };
}

/**
 * Plans a paste. With the default `range` strategy:
 * - a one-cell matrix fills every cell of every target range;
 * - with a range of more than one cell, each range is filled from its top left. When the range is at
 *   least as large as the matrix and an exact multiple of it in a direction, the matrix tiles in that
 *   direction; otherwise the range takes the matrix's size, clipped at the grid's edges;
 * - otherwise the matrix is pasted from the focused cell, clipped at the grid's edges.
 * Group, full-width and placeholder rows and read-only cells are skipped, and a skipped row still uses up
 * its matrix row so the rest stays aligned.
 *
 * The `rows` strategy is row paste: see `planRowsPaste`.
 */
export function planPaste<TData>(
    matrix: readonly (readonly string[])[],
    target: { ranges: readonly ResolvedCellRange[]; focus: CellPosition },
    snapshot: GridSnapshot<TData>,
    options: PasteOptions<TData> = {}
): CellPlan {
    const plan = new PlanBuilder(snapshot, options);

    if (matrix.length === 0 || matrix.every((row) => row.length === 0)) {
        return plan.result();
    }

    if (options.strategy === 'rows') {
        planRowsPaste(plan, matrix, target, snapshot);

        return plan.result();
    }

    const { ranges, focus } = target;
    const isSingleValue = matrix.length === 1 && matrix[0]?.length === 1;

    if (isSingleValue && ranges.length > 0) {
        const text = matrix[0]?.[0] ?? '';

        for (const range of ranges) {
            forEachRangeCell(range, snapshot, plan, (row, columnIndex) => plan.add(row, columnIndex, text));
        }

        return plan.result();
    }

    if (isMoreThanOneCell(ranges)) {
        for (const range of ranges) {
            pasteIntoRange(plan, matrix, range, snapshot);
        }

        return plan.result();
    }

    pasteFromFocus(plan, matrix, focus, snapshot);

    return plan.result();
}

/**
 * Plans a fill handle drag. Only rows are filled: the target rows
 * are the rows of `target` outside `source`, in displayed order whether the drag went up or down, and the
 * columns are the source columns. Source rows repeat in order (no number series), starting from the
 * first source row at the first target row. Group and full-width source rows are left out of the pattern;
 * a skipped target row still uses up its source row. A drag that adds no rows plans nothing.
 */
export function planFill<TData>(
    source: ResolvedCellRange,
    target: ResolvedCellRange,
    snapshot: GridSnapshot<TData>,
    options: WriteOptions<TData> = {}
): CellPlan {
    const plan = new PlanBuilder(snapshot, options);
    const columnIndexes = source.colIds
        .map((colId) => snapshot.columnIndexOf(colId))
        .filter((index): index is number => index !== undefined);
    const pattern: string[][] = [];

    for (const rowId of source.rowIds) {
        const index = snapshot.indexOf(rowId);
        const row = index === undefined ? undefined : snapshot.rowAt(index);

        if (row && rowSkipReason(row, snapshot) === null) {
            pattern.push(
                columnIndexes.map((columnIndex) =>
                    (snapshot.columns[columnIndex] as SnapshotColumn<TData>).formatValue(row)
                )
            );
        }
    }

    if (pattern.length === 0 || columnIndexes.length === 0) {
        return plan.result();
    }

    let position = 0;

    for (let index = target.startIndex; index <= target.endIndex; index++) {
        if (index >= source.startIndex && index <= source.endIndex) {
            continue;
        }

        const row = snapshot.rowAt(index);
        const values = pattern[position % pattern.length] as string[];
        position++;

        if (!row) {
            continue;
        }

        columnIndexes.forEach((columnIndex, offset) => plan.add(row, columnIndex, values[offset] ?? ''));
    }

    return plan.result();
}

/**
 * Plans Delete and Backspace over the ranges, as `useGridKeyboardDelete` does: every writable cell in
 * every range is set to an empty string, each cell once. Rows without data are skipped. With no range the
 * Grid passes a one-cell range for the focused cell.
 */
export function planClear<TData>(
    ranges: readonly ResolvedCellRange[],
    snapshot: GridSnapshot<TData>,
    options: WriteOptions<TData> = {}
): CellPlan<''> {
    const plan = new PlanBuilder(snapshot, options);

    for (const range of ranges) {
        forEachRangeCell(range, snapshot, plan, (row, columnIndex) => plan.add(row, columnIndex, ''));
    }

    return plan.result() as CellPlan<''>;
}

function rowSkipReason<TData>(row: GridRow<TData>, snapshot: GridSnapshot<TData>): ClipboardSkipReason | null {
    if (row.kind === 'loading' || row.kind === 'failed') {
        return 'placeholder';
    }

    if (row.kind === 'group' || snapshot.isFullWidth(row)) {
        return 'group';
    }

    return null;
}

/** Collects writes and skips, once per cell. */
class PlanBuilder<TData> {
    private readonly writes: CellWrite[] = [];
    private readonly skipped: SkippedCell[] = [];
    private readonly seen = new Set<string>();

    constructor(
        private readonly snapshot: GridSnapshot<TData>,
        private readonly options: WriteOptions<TData>
    ) {}

    add(row: GridRow<TData>, columnIndex: number, text: string): void {
        const column = this.snapshot.columns[columnIndex];

        if (!column) {
            return;
        }

        const cell: CellPosition = { rowId: row.id, colId: column.colId };
        const key = `${row.id}\u0000${column.colId}`;

        if (this.seen.has(key)) {
            return;
        }

        this.seen.add(key);
        const reason = rowSkipReason(row, this.snapshot);

        if (reason) {
            this.skipped.push({ cell, reason });

            return;
        }

        // `canWrite` adds permission rules (locked rows) to the column's own `editable`; it never widens it.
        const writable = column.isEditable(row) && (this.options.canWrite?.(cell, row) ?? true);

        if (!writable) {
            this.skipped.push({ cell, reason: 'readOnly' });

            return;
        }

        this.writes.push({ cell, text });
    }

    outside(cell: CellPosition): void {
        this.skipped.push({ cell, reason: 'outside' });
    }

    result(): CellPlan {
        return { writes: this.writes, skipped: this.skipped };
    }
}

function forEachRangeCell<TData>(
    range: ResolvedCellRange,
    snapshot: GridSnapshot<TData>,
    plan: PlanBuilder<TData>,
    visit: (row: GridRow<TData>, columnIndex: number) => void
): void {
    for (let index = range.startIndex; index <= range.endIndex; index++) {
        const row = snapshot.rowAt(index);

        if (!row) {
            continue;
        }

        for (const colId of range.colIds) {
            const columnIndex = snapshot.columnIndexOf(colId);

            if (columnIndex === undefined) {
                plan.outside({ rowId: row.id, colId });
            } else {
                visit(row, columnIndex);
            }
        }
    }
}

function isMoreThanOneCell(ranges: readonly ResolvedCellRange[]): boolean {
    if (ranges.length > 1) {
        return true;
    }

    const range = ranges[0];

    return range !== undefined && (range.endIndex - range.startIndex + 1) * range.colIds.length > 1;
}

/**
 * Paste target rows from `start` on, in display order. Rows that copy leaves out (group, full-width and
 * placeholder rows) are reported as skipped and do not use up a matrix row, so copying a range and pasting
 * it back in place changes nothing. Collects `count` rows, or every row up to `endIndex`.
 */
function takeRows<TData>(
    plan: PlanBuilder<TData>,
    snapshot: GridSnapshot<TData>,
    columnIndexes: readonly number[],
    start: number,
    limit: { count: number } | { endIndex: number }
): GridRow<TData>[] {
    const rows: GridRow<TData>[] = [];
    for (let index = start; index < snapshot.rowCount; index++) {
        if ('endIndex' in limit ? index > limit.endIndex : rows.length >= limit.count) {
            break;
        }
        const row = snapshot.rowAt(index);
        if (!row) {
            continue;
        }
        if (rowSkipReason(row, snapshot)) {
            columnIndexes.forEach((columnIndex) => plan.add(row, columnIndex, ''));
            continue;
        }
        rows.push(row);
    }

    return rows;
}

/** Pastes into the active range, resized to the matrix unless it is an exact multiple. */
function pasteIntoRange<TData>(
    plan: PlanBuilder<TData>,
    matrix: readonly (readonly string[])[],
    range: ResolvedCellRange,
    snapshot: GridSnapshot<TData>
): void {
    const columnIndexes = range.colIds
        .map((colId) => snapshot.columnIndexOf(colId))
        .filter((index): index is number => index !== undefined);

    if (columnIndexes.length === 0) {
        return;
    }

    const columnCount = columnIndexes.length;
    const matrixWidth = matrix[0]?.length ?? 0;
    const isColumnMultiple = matrixWidth > 0 && columnCount >= matrixWidth && columnCount % matrixWidth === 0;
    const targetColumns = isColumnMultiple ? columnCount : matrixWidth;
    const left = Math.min(...columnIndexes);
    const targetColumnIndexes = Array.from({ length: targetColumns }, (_, column) => left + column).filter(
        (index) => index < snapshot.columns.length
    );
    const rangeRows = takeRows(plan, snapshot, targetColumnIndexes, range.startIndex, { endIndex: range.endIndex });
    const isRowMultiple = rangeRows.length >= matrix.length && rangeRows.length % matrix.length === 0;
    const targetRows = isRowMultiple
        ? rangeRows
        : takeRows(plan, snapshot, targetColumnIndexes, range.startIndex, { count: matrix.length });

    targetRows.forEach((row, offset) => {
        const values = matrix[offset % matrix.length] as readonly string[];

        if (values.length === 0) {
            return;
        }

        targetColumnIndexes.forEach((columnIndex, column) =>
            plan.add(row, columnIndex, values[column % values.length] as string)
        );
    });
}

/**
 * Pastes several values from the focused cell over the displayed columns to its right. Every
 * displayed column counts, focusable or not, because copy includes them too.
 */
function pasteFromFocus<TData>(
    plan: PlanBuilder<TData>,
    matrix: readonly (readonly string[])[],
    focus: CellPosition,
    snapshot: GridSnapshot<TData>
): void {
    const rowIndex = snapshot.indexOf(focus.rowId);
    const columnIndex = snapshot.columnIndexOf(focus.colId);

    if (rowIndex === undefined || columnIndex === undefined) {
        plan.outside(focus);

        return;
    }

    const width = Math.max(...matrix.map((values) => values.length));
    const columnIndexes = Array.from({ length: width }, (_, column) => columnIndex + column).filter(
        (index) => index < snapshot.columns.length
    );

    takeRows(plan, snapshot, columnIndexes, rowIndex, { count: matrix.length }).forEach((row, offset) => {
        const values = matrix[offset] as readonly string[];

        values.forEach((text, column) => {
            const target = columnIndexes[column];

            if (target !== undefined) {
                plan.add(row, target, text);
            }
        });
    });
}

/**
 * Row paste. Columns start at the focused column and span the widest matrix
 * row, clipped at the grid's edge. Target rows are every row index covered by the ranges, sorted, carried
 * on below the last one when the matrix is taller; with no range they start at the focused row. Matrix
 * rows repeat to cover all target rows, and short rows leave their trailing cells untouched. Nothing is
 * pasted when the focused row is missing or is a group row.
 */
function planRowsPaste<TData>(
    plan: PlanBuilder<TData>,
    matrix: readonly (readonly string[])[],
    target: { ranges: readonly ResolvedCellRange[]; focus: CellPosition },
    snapshot: GridSnapshot<TData>
): void {
    const focusIndex = snapshot.indexOf(target.focus.rowId);
    const focusColumn = snapshot.columnIndexOf(target.focus.colId);
    const focusRow = focusIndex === undefined ? undefined : snapshot.rowAt(focusIndex);

    if (focusIndex === undefined || focusColumn === undefined || !focusRow) {
        plan.outside(target.focus);

        return;
    }

    if (focusRow.kind === 'group') {
        return;
    }

    const width = Math.max(...matrix.map((row) => row.length));
    const columnIndexes: number[] = [];

    for (let index = focusColumn; index < Math.min(focusColumn + width, snapshot.columns.length); index++) {
        columnIndexes.push(index);
    }

    const selectedIndexes = [
        ...new Set(
            target.ranges.flatMap((range) =>
                Array.from({ length: range.endIndex - range.startIndex + 1 }, (_, i) => range.startIndex + i)
            )
        ),
    ].sort((a, b) => a - b);
    // Rows copy leaves out do not use up a matrix row (see `takeRows`).
    const selected = selectedIndexes.flatMap((index) =>
        takeRows(plan, snapshot, columnIndexes, index, { endIndex: index })
    );
    const last = selectedIndexes[selectedIndexes.length - 1];
    const rows =
        last === undefined
            ? takeRows(plan, snapshot, columnIndexes, focusIndex, { count: matrix.length })
            : [
                  ...selected,
                  ...takeRows(plan, snapshot, columnIndexes, last + 1, {
                      count: Math.max(0, matrix.length - selected.length),
                  }),
              ];

    rows.forEach((row, position) => {
        const values = matrix[position % matrix.length] as readonly string[];

        columnIndexes.forEach((columnIndex, column) => {
            const text = values[column];

            if (text !== undefined) {
                plan.add(row, columnIndex, text);
            }
        });
    });
}
