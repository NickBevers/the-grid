import { describe, expect, it } from 'vitest';

import type { CellPosition, GridRow, ResolvedCellRange } from '../contract';
import {
    copyMatrix,
    parseTsv,
    planClear,
    planFill,
    planPaste,
    serializeHtml,
    serializeTsv,
    type CellPlan,
} from './clipboard';
import { createSnapshot, type GridSnapshot, type SnapshotColumn } from './snapshot';

type Row = Record<string, string>;

const COLS = ['a', 'b', 'c', 'd'];

function dataRow(id: string): GridRow<Row> {
    return {
        kind: 'data',
        id,
        section: 'body',
        level: 0,
        parentId: null,
        data: Object.fromEntries(COLS.map((col) => [col, `${id}${col}`])),
    };
}

function groupRow(id: string): GridRow<Row> {
    return {
        kind: 'group',
        id,
        section: 'body',
        level: 0,
        parentId: null,
        groupColId: 'a',
        key: id,
        keyPath: [id],
        childCount: null,
        expanded: true,
        data: null,
    };
}

function fullWidthRow(id: string): GridRow<Row> {
    return { kind: 'fullWidth', id, section: 'body', level: 0, parentId: null, data: {} };
}

function loadingRow(id: string, index: number): GridRow<Row> {
    return { kind: 'loading', id, section: 'body', level: 0, parentId: null, index };
}

function column(colId: string, options: { editable?: boolean; focusable?: boolean } = {}): SnapshotColumn<Row> {
    return {
        colId,
        focusable: options.focusable ?? true,
        getValue: (row) => (row.kind === 'data' ? row.data[colId] : undefined),
        formatValue: (row) => (row.kind === 'data' ? (row.data[colId] ?? '') : ''),
        isEditable: (row) => row.kind === 'data' && (options.editable ?? true),
    };
}

/** Rows r0..r(n-1) and columns a..d unless overridden. */
function grid(
    rows: GridRow<Row>[] = Array.from({ length: 6 }, (_, i) => dataRow(`r${i}`)),
    columns: SnapshotColumn<Row>[] = COLS.map((col) => column(col))
): GridSnapshot<Row> {
    return createSnapshot(rows, columns);
}

function range(snapshot: GridSnapshot<Row>, top: number, bottom: number, colIds: string[]): ResolvedCellRange {
    const rowIds: string[] = [];
    const unloadedIndexes: number[] = [];

    for (let index = top; index <= bottom; index++) {
        const row = snapshot.rowAt(index);

        if (row?.kind === 'loading' || row?.kind === 'failed') {
            unloadedIndexes.push(index);
        } else if (row) {
            rowIds.push(row.id);
        }
    }

    return { rowIds, colIds, startIndex: top, endIndex: bottom, unloadedIndexes };
}

function cell(rowId: string, colId: string): CellPosition {
    return { rowId, colId };
}

/** Writes as `rowId.colId=text` strings, for compact assertions. */
function writes(plan: CellPlan): string[] {
    return plan.writes.map(({ cell: target, text }) => `${target.rowId}.${target.colId}=${text}`);
}

function skips(plan: CellPlan): string[] {
    return plan.skipped.map(({ cell: target, reason }) => `${target.rowId}.${target.colId}:${reason}`);
}

describe('serializeTsv', () => {
    it('joins cells with tabs and rows with newlines, without a trailing newline', () => {
        expect(
            serializeTsv([
                ['a', 'b'],
                ['c', 'd'],
            ])
        ).toBe('a\tb\nc\td');
    });

    it('quotes cells with tabs, newlines, carriage returns or quotes and doubles inner quotes', () => {
        expect(serializeTsv([['x\ty', 'line1\nline2', 'say "hi"', 'cr\r', 'plain']])).toBe(
            '"x\ty"\t"line1\nline2"\t"say ""hi"""\t"cr\r"\tplain'
        );
    });

    it('keeps empty cells and a trailing single empty row', () => {
        expect(serializeTsv([['', 'a', ''], ['']])).toBe('\ta\t\n""');
        expect(parseTsv(serializeTsv([['a'], ['']]))).toEqual([['a'], ['']]);
    });
});

describe('parseTsv', () => {
    it('parses Excel output: CRLF line ends and one trailing CRLF', () => {
        expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([
            ['a', 'b'],
            ['c', 'd'],
        ]);
    });

    it('parses Google Sheets output: LF and no trailing newline', () => {
        expect(parseTsv('a\tb\nc\td')).toEqual([
            ['a', 'b'],
            ['c', 'd'],
        ]);
    });

    it('reads quoted cells with embedded newlines, tabs and doubled quotes', () => {
        expect(parseTsv('"multi\nline"\t"tab\there"\t"say ""hi"""\r\nnext\t\t')).toEqual([
            ['multi\nline', 'tab\there', 'say "hi"'],
            ['next', '', ''],
        ]);
    });

    it('keeps a CRLF inside a quoted cell', () => {
        expect(parseTsv('"a\r\nb"\tc\r\n')).toEqual([['a\r\nb', 'c']]);
    });

    it('treats a quote inside an unquoted cell as a literal', () => {
        expect(parseTsv('5" screen\tx')).toEqual([['5" screen', 'x']]);
    });

    it('ignores only one trailing newline, keeping a blank last row before it', () => {
        expect(parseTsv('a\n\n')).toEqual([['a'], ['']]);
        expect(parseTsv('a\n')).toEqual([['a']]);
    });

    it('keeps ragged rows ragged', () => {
        expect(parseTsv('a\tb\tc\nd\ne\tf')).toEqual([['a', 'b', 'c'], ['d'], ['e', 'f']]);
    });

    it('returns one empty cell for empty text', () => {
        expect(parseTsv('')).toEqual([['']]);
        expect(parseTsv('\n')).toEqual([['']]);
    });

    it('accepts a lone CR as a line end', () => {
        expect(parseTsv('a\rb')).toEqual([['a'], ['b']]);
    });

    it('round trips random matrices with tabs, newlines and quotes', () => {
        let seed = 42;
        const random = (): number => {
            seed = (seed * 1103515245 + 12345) % 2147483648;

            return seed / 2147483648;
        };
        const alphabet = ['a', 'B', ' ', '\t', '\n', '\r', '\r\n', '"', '""', '1', 'é', ',', ''];
        const randomCell = (): string =>
            Array.from(
                { length: Math.floor(random() * 6) },
                () => alphabet[Math.floor(random() * alphabet.length)]
            ).join('');

        for (let run = 0; run < 500; run++) {
            const rowCount = 1 + Math.floor(random() * 5);
            const ragged = random() < 0.3;
            const width = 1 + Math.floor(random() * 4);
            const matrix = Array.from({ length: rowCount }, () =>
                Array.from({ length: ragged ? 1 + Math.floor(random() * 4) : width }, randomCell)
            );

            expect(parseTsv(serializeTsv(matrix))).toEqual(matrix);
        }
    });
});

describe('serializeHtml', () => {
    it('escapes HTML and renders empty cells as nbsp', () => {
        const html = serializeHtml([['<b>&"\'', '']]);

        expect(html).toContain('>&lt;b&gt;&amp;&quot;&#39;</td>');
        expect(html).toContain('>&nbsp;</td>');
        expect(html.startsWith('<table')).toBe(true);
        expect(html).not.toContain('<thead>');
    });

    it('writes an escaped header row', () => {
        const html = serializeHtml([['1']], { header: ['A & B'] });

        expect(html).toMatch(/<thead><tr[^>]*><th[^>]*>A &amp; B<\/th><\/tr><\/thead><tbody><tr[^>]*><td[^>]*>1<\/td>/);
    });

    it('returns an empty string for an empty matrix', () => {
        expect(serializeHtml([])).toBe('');
    });
});

describe('copyMatrix', () => {
    it('copies formatted values of one range', () => {
        const snapshot = grid();

        expect(copyMatrix([range(snapshot, 1, 2, ['b', 'c'])], snapshot)).toEqual({
            matrix: [
                ['r1b', 'r1c'],
                ['r2b', 'r2c'],
            ],
            rowIds: ['r1', 'r2'],
            colIds: ['b', 'c'],
        });
    });

    it('stacks ranges with the same columns and copies each row once', () => {
        const snapshot = grid();
        const result = copyMatrix(
            [range(snapshot, 0, 1, ['a']), range(snapshot, 4, 4, ['a']), range(snapshot, 1, 1, ['a'])],
            snapshot
        );

        expect(result.matrix).toEqual([['r0a'], ['r1a'], ['r4a']]);
        expect(result.rowIds).toEqual(['r0', 'r1', 'r4']);
    });

    it('takes the union of columns across ranges in order of first appearance', () => {
        const snapshot = grid();
        const result = copyMatrix([range(snapshot, 0, 0, ['c']), range(snapshot, 2, 2, ['a', 'c'])], snapshot);

        expect(result.colIds).toEqual(['c', 'a']);
        expect(result.matrix).toEqual([
            ['r0c', 'r0a'],
            ['r2c', 'r2a'],
        ]);
    });

    it('leaves out group and full-width rows', () => {
        const snapshot = grid([dataRow('r0'), groupRow('g1'), fullWidthRow('f2'), dataRow('r3')]);

        expect(copyMatrix([range(snapshot, 0, 3, ['a'])], snapshot).matrix).toEqual([['r0a'], ['r3a']]);
    });

    it('adds a header row when asked', () => {
        const snapshot = grid();

        expect(copyMatrix([range(snapshot, 0, 0, ['a', 'b'])], snapshot, { includeHeaders: true }).matrix[0]).toEqual([
            'a',
            'b',
        ]);
        expect(
            copyMatrix([range(snapshot, 0, 0, ['a', 'b'])], snapshot, {
                includeHeaders: true,
                headerOf: (id) => id.toUpperCase(),
            }).matrix
        ).toEqual([
            ['A', 'B'],
            ['r0a', 'r0b'],
        ]);
    });
});

describe('planPaste', () => {
    it('pastes from the focused cell when there is no range', () => {
        const snapshot = grid();
        const plan = planPaste(
            [
                ['1', '2'],
                ['3', '4'],
            ],
            { ranges: [], focus: cell('r1', 'b') },
            snapshot
        );

        expect(writes(plan)).toEqual(['r1.b=1', 'r1.c=2', 'r2.b=3', 'r2.c=4']);
    });

    it('anchors at a single-cell range and clips at the right and bottom edges', () => {
        const snapshot = grid();
        const plan = planPaste(
            [
                ['1', '2', '3'],
                ['4', '5', '6'],
                ['7', '8', '9'],
            ],
            { ranges: [range(snapshot, 4, 4, ['c'])], focus: cell('r4', 'c') },
            snapshot
        );

        expect(writes(plan)).toEqual(['r4.c=1', 'r4.d=2', 'r5.c=4', 'r5.d=5']);
    });

    it('fills a whole range, and every range, with a one-cell matrix', () => {
        const snapshot = grid();
        const plan = planPaste(
            [['x']],
            { ranges: [range(snapshot, 0, 1, ['a', 'b']), range(snapshot, 3, 3, ['d'])], focus: cell('r0', 'a') },
            snapshot
        );

        expect(writes(plan)).toEqual(['r0.a=x', 'r0.b=x', 'r1.a=x', 'r1.b=x', 'r3.d=x']);
    });

    it('tiles the matrix over a range that is an exact multiple in both directions', () => {
        const snapshot = grid();
        const plan = planPaste(
            [
                ['1', '2'],
                ['3', '4'],
            ],
            { ranges: [range(snapshot, 0, 3, ['a', 'b', 'c', 'd'])], focus: cell('r0', 'a') },
            snapshot
        );

        expect(writes(plan)).toEqual([
            'r0.a=1',
            'r0.b=2',
            'r0.c=1',
            'r0.d=2',
            'r1.a=3',
            'r1.b=4',
            'r1.c=3',
            'r1.d=4',
            'r2.a=1',
            'r2.b=2',
            'r2.c=1',
            'r2.d=2',
            'r3.a=3',
            'r3.b=4',
            'r3.c=3',
            'r3.d=4',
        ]);
    });

    it('pastes once from the range top left when the range is not an exact multiple', () => {
        const snapshot = grid();
        const plan = planPaste(
            [
                ['1', '2'],
                ['3', '4'],
            ],
            { ranges: [range(snapshot, 1, 3, ['a', 'b', 'c'])], focus: cell('r3', 'c') },
            snapshot
        );

        expect(writes(plan)).toEqual(['r1.a=1', 'r1.b=2', 'r2.a=3', 'r2.b=4']);
    });

    it('grows a range smaller than the matrix from its top left, clipped at the grid edges', () => {
        const snapshot = grid();
        const plan = planPaste(
            [
                ['1', '2', '3'],
                ['4', '5', '6'],
                ['7', '8', '9'],
            ],
            { ranges: [range(snapshot, 4, 5, ['c', 'd'])], focus: cell('r4', 'c') },
            snapshot
        );

        expect(writes(plan)).toEqual(['r4.c=1', 'r4.d=2', 'r5.c=4', 'r5.d=5']);
    });

    it('tiles rows but not columns when only the rows are a multiple', () => {
        const snapshot = grid();
        const plan = planPaste(
            [['1', '2']],
            { ranges: [range(snapshot, 0, 1, ['a', 'b', 'c'])], focus: cell('r0', 'a') },
            snapshot
        );

        expect(writes(plan)).toEqual(['r0.a=1', 'r0.b=2', 'r1.a=1', 'r1.b=2']);
    });

    it('skips group, full-width and placeholder rows without using up matrix rows, as copy leaves them out', () => {
        const snapshot = grid([dataRow('r0'), groupRow('g1'), fullWidthRow('f2'), loadingRow('l3', 3), dataRow('r4')]);
        const plan = planPaste([['0'], ['1'], ['2'], ['3'], ['4']], { ranges: [], focus: cell('r0', 'a') }, snapshot);

        expect(writes(plan)).toEqual(['r0.a=0', 'r4.a=1']);
        expect(skips(plan)).toEqual(['g1.a:group', 'f2.a:group', 'l3.a:placeholder']);
    });

    it('skips read-only cells while keeping the matrix aligned', () => {
        const snapshot = grid(undefined, [column('a'), column('b', { editable: false }), column('c'), column('d')]);
        const plan = planPaste([['1', '2', '3']], { ranges: [], focus: cell('r0', 'a') }, snapshot);

        expect(writes(plan)).toEqual(['r0.a=1', 'r0.c=3']);
        expect(skips(plan)).toEqual(['r0.b:readOnly']);
    });

    it('uses canWrite instead of isEditable when given', () => {
        const snapshot = grid();
        const plan = planPaste([['1', '2']], { ranges: [], focus: cell('r0', 'a') }, snapshot, {
            canWrite: (target) => target.colId !== 'a',
        });

        expect(writes(plan)).toEqual(['r0.b=2']);
        expect(skips(plan)).toEqual(['r0.a:readOnly']);
    });

    it('pastes over non-focusable columns from the focus, as copy includes them', () => {
        const snapshot = grid(undefined, [column('a'), column('sel', { focusable: false }), column('c')]);
        const plan = planPaste([['1', '2']], { ranges: [], focus: cell('r0', 'a') }, snapshot);

        expect(writes(plan)).toEqual(['r0.a=1', 'r0.sel=2']);
    });

    it('skips placeholder rows inside a range without using up matrix rows, and wraps ragged rows', () => {
        const snapshot = grid([dataRow('r0'), loadingRow('l1', 1), dataRow('r2'), dataRow('r3')]);
        const plan = planPaste(
            [['1', '2'], ['3']],
            { ranges: [range(snapshot, 0, 3, ['a', 'b'])], focus: cell('r0', 'a') },
            snapshot
        );

        expect(writes(plan)).toEqual(['r0.a=1', 'r0.b=2', 'r2.a=3', 'r2.b=3']);
        expect(skips(plan)).toEqual(['l1.a:placeholder', 'l1.b:placeholder']);
    });

    it('reports a focus that is no longer displayed as outside', () => {
        const snapshot = grid();
        const plan = planPaste([['1', '2']], { ranges: [], focus: cell('gone', 'a') }, snapshot);

        expect(plan.writes).toEqual([]);
        expect(skips(plan)).toEqual(['gone.a:outside']);
    });
});

describe('planPaste (rows strategy)', () => {
    it('repeats matrix rows over every selected row, even when not an exact multiple', () => {
        const snapshot = grid();
        const plan = planPaste(
            [
                ['1', '2'],
                ['3', '4'],
            ],
            { ranges: [range(snapshot, 0, 2, ['a'])], focus: cell('r0', 'a') },
            snapshot,
            { strategy: 'rows' }
        );

        expect(writes(plan)).toEqual(['r0.a=1', 'r0.b=2', 'r1.a=3', 'r1.b=4', 'r2.a=1', 'r2.b=2']);
    });

    it('takes columns from the focused column and the matrix width, not the range', () => {
        const snapshot = grid();
        const plan = planPaste(
            [['x']],
            { ranges: [range(snapshot, 0, 1, ['a', 'b', 'c'])], focus: cell('r0', 'b') },
            snapshot,
            {
                strategy: 'rows',
            }
        );

        expect(writes(plan)).toEqual(['r0.b=x', 'r1.b=x']);
    });

    it('carries on below the last selected row when the matrix is taller', () => {
        const snapshot = grid();
        const plan = planPaste(
            [['1'], ['2'], ['3']],
            { ranges: [range(snapshot, 1, 1, ['a']), range(snapshot, 3, 3, ['a'])], focus: cell('r1', 'a') },
            snapshot,
            { strategy: 'rows' }
        );

        expect(writes(plan)).toEqual(['r1.a=1', 'r3.a=2', 'r4.a=3']);
    });

    it('pastes from the focused row when there is no range and leaves short rows padded', () => {
        const snapshot = grid();
        const plan = planPaste([['1', '2'], ['3']], { ranges: [], focus: cell('r4', 'c') }, snapshot, {
            strategy: 'rows',
        });

        expect(writes(plan)).toEqual(['r4.c=1', 'r4.d=2', 'r5.c=3']);
    });

    it('skips group rows without using up their matrix row', () => {
        const snapshot = grid([dataRow('r0'), groupRow('g1'), dataRow('r2')]);
        const plan = planPaste([['1'], ['2'], ['3']], { ranges: [], focus: cell('r0', 'a') }, snapshot, {
            strategy: 'rows',
        });

        expect(writes(plan)).toEqual(['r0.a=1', 'r2.a=2']);
        expect(skips(plan)).toEqual(['g1.a:group']);
    });

    it('pastes nothing when the focused row is a group row', () => {
        const snapshot = grid([groupRow('g0'), dataRow('r1')]);
        const plan = planPaste([['1'], ['2']], { ranges: [], focus: cell('g0', 'a') }, snapshot, { strategy: 'rows' });

        expect(plan).toEqual({ writes: [], skipped: [] });
    });
});

describe('planFill', () => {
    it('repeats source rows downward without incrementing numbers', () => {
        const snapshot = grid([dataRow('r0'), dataRow('r1'), dataRow('r2'), dataRow('r3'), dataRow('r4')]);
        const source = range(snapshot, 0, 1, ['a']);
        const plan = planFill(source, range(snapshot, 0, 4, ['a']), snapshot);

        expect(writes(plan)).toEqual(['r2.a=r0a', 'r3.a=r1a', 'r4.a=r0a']);
    });

    it('fills upward in displayed order, starting from the first source row', () => {
        const snapshot = grid();
        const plan = planFill(range(snapshot, 3, 4, ['b']), range(snapshot, 0, 4, ['b']), snapshot);

        expect(writes(plan)).toEqual(['r0.b=r3b', 'r1.b=r4b', 'r2.b=r3b']);
    });

    it('does nothing for a sideways drag that adds no rows', () => {
        const snapshot = grid();
        const plan = planFill(range(snapshot, 0, 1, ['a']), range(snapshot, 0, 1, ['a', 'b', 'c']), snapshot);

        expect(plan).toEqual({ writes: [], skipped: [] });
    });

    it('fills every source column and skips read-only cells', () => {
        const snapshot = grid(undefined, [column('a'), column('b', { editable: false }), column('c'), column('d')]);
        const plan = planFill(range(snapshot, 0, 0, ['a', 'b']), range(snapshot, 0, 1, ['a', 'b']), snapshot);

        expect(writes(plan)).toEqual(['r1.a=r0a']);
        expect(skips(plan)).toEqual(['r1.b:readOnly']);
    });

    it('leaves group source rows out of the pattern, and skipped targets use up their source row', () => {
        const snapshot = grid([
            dataRow('r0'),
            groupRow('g1'),
            dataRow('r2'),
            groupRow('g3'),
            dataRow('r4'),
            dataRow('r5'),
        ]);
        const plan = planFill(range(snapshot, 0, 2, ['a']), range(snapshot, 0, 5, ['a']), snapshot);

        expect(writes(plan)).toEqual(['r4.a=r2a', 'r5.a=r0a']);
        expect(skips(plan)).toEqual(['g3.a:group']);
    });
});

describe('planClear', () => {
    it('clears every writable cell in every range once', () => {
        const snapshot = grid(undefined, [column('a'), column('b', { editable: false }), column('c'), column('d')]);
        const plan = planClear([range(snapshot, 0, 1, ['a', 'b']), range(snapshot, 1, 1, ['a', 'c'])], snapshot);

        expect(writes(plan)).toEqual(['r0.a=', 'r1.a=', 'r1.c=']);
        expect(skips(plan)).toEqual(['r0.b:readOnly', 'r1.b:readOnly']);
    });

    it('skips rows without data', () => {
        const snapshot = grid([dataRow('r0'), groupRow('g1'), loadingRow('l2', 2)]);
        const plan = planClear([range(snapshot, 0, 2, ['a'])], snapshot);

        expect(writes(plan)).toEqual(['r0.a=']);
        expect(skips(plan)).toEqual(['g1.a:group', 'l2.a:placeholder']);
    });

    it('clears a single focused cell passed as a one-cell range', () => {
        const snapshot = grid();

        expect(writes(planClear([range(snapshot, 2, 2, ['d'])], snapshot))).toEqual(['r2.d=']);
    });
});
