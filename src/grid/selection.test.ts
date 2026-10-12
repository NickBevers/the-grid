import { describe, expect, it } from 'vitest';

import type { GridRow, RowId, RowSelection } from '../contract';
import {
    clickSelection,
    deselectAll,
    emptySelection,
    isSelected,
    pruneSelection,
    select,
    selectAll,
    selectedLoadedRows,
    selectionCount,
    type ClickState,
    type SelectionOptions,
} from './selection';
import { createSnapshot, type GridSnapshot } from './snapshot';

type Row = { name: string };

function dataRow(id: string): GridRow<Row> {
    return { kind: 'data', id, section: 'body', level: 0, parentId: null, data: { name: id } };
}

function groupRow(id: string): GridRow<Row> {
    return {
        kind: 'group',
        id,
        section: 'body',
        level: 0,
        parentId: null,
        groupColId: 'client',
        key: id,
        keyPath: [id],
        childCount: null,
        expanded: true,
        data: null,
    };
}

function loadingRow(id: string, index: number): GridRow<Row> {
    return { kind: 'loading', id, section: 'body', level: 0, parentId: null, index };
}

function snapshotOf(rows: GridRow<Row>[]): GridSnapshot<Row> {
    return createSnapshot(rows, []);
}

function ids(selection: RowSelection): RowId[] {
    expect(selection.mode).toBe('ids');

    return selection.mode === 'ids' ? [...selection.ids].sort() : [];
}

const multiple: SelectionOptions = { mode: 'multiple' };
const single: SelectionOptions = { mode: 'single' };
const plain = { toggle: false, range: false };
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };

/** Applies a sequence of clicks, threading the click state through. */
function clicks(
    snapshot: GridSnapshot<Row>,
    sequence: [RowId, { toggle: boolean; range: boolean }][],
    options: SelectionOptions = multiple,
    start: RowSelection = emptySelection()
): { selection: RowSelection; state: ClickState } {
    let selection = start;
    let state: ClickState = { anchorId: null };

    for (const [id, modifiers] of sequence) {
        const result = clickSelection(selection, snapshot, id, modifiers, state, options);
        selection = result.selection;
        state = { anchorId: result.anchorId, rangeEndId: result.rangeEndId };
    }

    return { selection, state };
}

const five = snapshotOf(['a', 'b', 'c', 'd', 'e'].map(dataRow));

describe('basic selection', () => {
    it('starts empty, selects all and deselects all', () => {
        expect(isSelected(emptySelection(), 'a')).toBe(false);
        expect(isSelected(selectAll(), 'anything')).toBe(true);
        expect(ids(deselectAll())).toEqual([]);
    });

    it('adds and removes ids in multiple mode', () => {
        let selection = select(emptySelection(), ['a', 'b'], true, multiple);
        expect(ids(selection)).toEqual(['a', 'b']);

        selection = select(selection, ['c'], true, multiple);
        expect(ids(selection)).toEqual(['a', 'b', 'c']);

        selection = select(selection, ['b'], false, multiple);
        expect(ids(selection)).toEqual(['a', 'c']);

        selection = select(selection, ['d'], true, { ...multiple, clearOthers: true });
        expect(ids(selection)).toEqual(['d']);
    });

    it('keeps at most one id in single mode', () => {
        let selection = select(emptySelection(), ['a', 'b', 'c'], true, single);
        expect(ids(selection)).toEqual(['c']);

        selection = select(selection, ['d'], true, single);
        expect(ids(selection)).toEqual(['d']);

        expect(ids(select(selectAll(), ['a'], true, single))).toEqual(['a']);
    });

    it('ignores unselectable ids when selecting, but still deselects them', () => {
        const isSelectable = (id: RowId): boolean => id !== 'locked';

        expect(ids(select(emptySelection(), ['a', 'locked'], true, { ...multiple, isSelectable }))).toEqual(['a']);
        expect(ids(select(emptySelection(), ['a', 'locked'], true, { ...single, isSelectable }))).toEqual(['a']);

        const unchanged = emptySelection();
        expect(select(unchanged, ['locked'], true, { ...single, isSelectable })).toBe(unchanged);

        const stale: RowSelection = { mode: 'ids', ids: new Set(['locked']) };
        expect(ids(select(stale, ['locked'], false, { ...multiple, isSelectable }))).toEqual([]);
    });

    it('keeps ids of rows that are not loaded (preselection before the rows arrive)', () => {
        const selection = select(emptySelection(), ['42', '43'], true, multiple);

        expect(isSelected(selection, '42')).toBe(true);
        expect(selectedLoadedRows(selection, [])).toEqual([]);
    });

    it('returns the same object when nothing changes', () => {
        const selection = select(emptySelection(), ['a'], true, multiple);

        expect(select(selection, ['a'], true, multiple)).toBe(selection);
        expect(select(selection, ['z'], false, multiple)).toBe(selection);
    });

    it('clears everything when deselecting with clearOthers', () => {
        const selection = select(emptySelection(), ['a', 'b'], true, multiple);

        expect(ids(select(selection, ['a'], false, { ...multiple, clearOthers: true }))).toEqual([]);
    });
});

describe('select all', () => {
    it('excludes rows deselected inside it and reselects them', () => {
        let selection = select(selectAll(), ['b'], false, multiple);
        expect(selection.mode).toBe('all');
        expect(isSelected(selection, 'a')).toBe(true);
        expect(isSelected(selection, 'b')).toBe(false);

        selection = select(selection, ['b'], true, multiple);
        expect(selection).toEqual({ mode: 'all', excludedIds: new Set() });
    });

    it('toggles inside select all with Ctrl clicks', () => {
        let state: ClickState = { anchorId: null };
        let result = clickSelection(selectAll(), five, 'c', toggle, state, multiple);
        expect(result.selection.mode).toBe('all');
        expect(isSelected(result.selection, 'c')).toBe(false);
        expect(isSelected(result.selection, 'd')).toBe(true);

        state = { anchorId: result.anchorId };
        result = clickSelection(result.selection, five, 'c', toggle, state, multiple);
        expect(isSelected(result.selection, 'c')).toBe(true);
    });

    it('a plain click leaves select all for a single row', () => {
        const result = clickSelection(selectAll(), five, 'b', plain, { anchorId: null }, multiple);

        expect(ids(result.selection)).toEqual(['b']);
    });

    it('a range inside select all removes exclusions', () => {
        const start: RowSelection = { mode: 'all', excludedIds: new Set(['b', 'c', 'e']) };
        const result = clickSelection(start, five, 'c', range, { anchorId: 'a' }, multiple);

        expect(result.selection).toEqual({ mode: 'all', excludedIds: new Set(['e']) });
    });
});

describe('clicks', () => {
    it('plain click selects only that row in both modes', () => {
        expect(
            ids(
                clicks(five, [
                    ['a', plain],
                    ['c', plain],
                ]).selection
            )
        ).toEqual(['c']);
        expect(
            ids(
                clicks(
                    five,
                    [
                        ['a', plain],
                        ['c', plain],
                    ],
                    single
                ).selection
            )
        ).toEqual(['c']);
    });

    it('plain click on an already selected row keeps it selected', () => {
        expect(
            ids(
                clicks(five, [
                    ['a', plain],
                    ['a', plain],
                ]).selection
            )
        ).toEqual(['a']);
        expect(
            ids(
                clicks(
                    five,
                    [
                        ['a', plain],
                        ['a', plain],
                    ],
                    single
                ).selection
            )
        ).toEqual(['a']);
    });

    it('toggle adds and removes in multiple mode and moves the anchor', () => {
        const { selection, state } = clicks(five, [
            ['a', plain],
            ['c', toggle],
            ['e', toggle],
            ['a', toggle],
        ]);

        expect(ids(selection)).toEqual(['c', 'e']);
        expect(state.anchorId).toBe('a');
    });

    it('toggle in single mode deselects the selected row or replaces it', () => {
        expect(
            ids(
                clicks(
                    five,
                    [
                        ['a', plain],
                        ['a', toggle],
                    ],
                    single
                ).selection
            )
        ).toEqual([]);
        expect(
            ids(
                clicks(
                    five,
                    [
                        ['a', plain],
                        ['b', toggle],
                    ],
                    single
                ).selection
            )
        ).toEqual(['b']);
    });

    it('range selects every row between the anchor and the row, in either direction', () => {
        expect(
            ids(
                clicks(five, [
                    ['b', plain],
                    ['d', range],
                ]).selection
            )
        ).toEqual(['b', 'c', 'd']);
        expect(
            ids(
                clicks(five, [
                    ['d', plain],
                    ['b', range],
                ]).selection
            )
        ).toEqual(['b', 'c', 'd']);
    });

    it('range replaces the previous range from the same anchor and keeps the anchor', () => {
        const { selection, state } = clicks(five, [
            ['c', plain],
            ['e', range],
            ['a', range],
        ]);

        expect(ids(selection)).toEqual(['a', 'b', 'c']);
        expect(state.anchorId).toBe('c');
    });

    it('range keeps rows selected by earlier toggles', () => {
        const { selection } = clicks(five, [
            ['a', plain],
            ['c', toggle],
            ['e', range],
            ['d', range],
        ]);

        expect(ids(selection)).toEqual(['a', 'c', 'd']);
    });

    it('range in single mode acts as a plain click', () => {
        expect(
            ids(
                clicks(
                    five,
                    [
                        ['a', plain],
                        ['d', range],
                    ],
                    single
                ).selection
            )
        ).toEqual(['d']);
    });

    it('range without an anchor selects the row, keeps the rest and sets the anchor', () => {
        const start = select(emptySelection(), ['a'], true, multiple);
        const result = clickSelection(start, five, 'c', range, { anchorId: null }, multiple);

        expect(ids(result.selection)).toEqual(['a', 'c']);
        expect(result.anchorId).toBe('c');
    });

    it('range works from an anchor far outside the rendered window', () => {
        const rows = Array.from({ length: 1000 }, (_, index) => dataRow(`r${index}`));
        const snapshot = snapshotOf(rows);
        const { selection } = clicks(snapshot, [
            ['r2', plain],
            ['r900', range],
        ]);

        expect(selection.mode === 'ids' && selection.ids.size).toBe(899);
        expect(isSelected(selection, 'r2')).toBe(true);
        expect(isSelected(selection, 'r900')).toBe(true);
        expect(isSelected(selection, 'r901')).toBe(false);
    });

    it('range from an anchor that left the model falls back to selecting the row', () => {
        const before = clicks(five, [['a', plain]]);
        const after = snapshotOf(['b', 'c', 'd'].map(dataRow));
        const result = clickSelection(before.selection, after, 'c', range, before.state, multiple);

        expect(ids(result.selection)).toEqual(['a', 'c']);
        expect(result.anchorId).toBe('c');
    });

    it('range skips group and placeholder rows', () => {
        const snapshot = snapshotOf([
            groupRow('g1'),
            dataRow('a'),
            dataRow('b'),
            groupRow('g2'),
            loadingRow('loading-4', 4),
            dataRow('c'),
            { kind: 'failed', id: 'failed-6', section: 'body', level: 0, parentId: null, index: 6, error: null },
            dataRow('d'),
        ]);

        expect(
            ids(
                clicks(snapshot, [
                    ['a', plain],
                    ['d', range],
                ]).selection
            )
        ).toEqual(['a', 'b', 'c', 'd']);
    });

    it('range skips unselectable rows', () => {
        const options = { ...multiple, isSelectable: (id: RowId): boolean => id !== 'c' };

        expect(
            ids(
                clicks(
                    five,
                    [
                        ['a', plain],
                        ['e', range],
                    ],
                    options
                ).selection
            )
        ).toEqual(['a', 'b', 'd', 'e']);
    });

    it('clicks on group, placeholder, missing or unselectable rows change nothing', () => {
        const snapshot = snapshotOf([groupRow('g'), dataRow('a'), loadingRow('loading-2', 2), dataRow('locked')]);
        const options = { ...multiple, isSelectable: (id: RowId): boolean => id !== 'locked' };
        const start = select(emptySelection(), ['a'], true, multiple);
        const state: ClickState = { anchorId: 'a' };

        for (const id of ['g', 'loading-2', 'missing', 'locked']) {
            for (const modifiers of [plain, toggle, range]) {
                const result = clickSelection(start, snapshot, id, modifiers, state, options);

                expect(result.selection).toBe(start);
                expect(result.anchorId).toBe('a');
            }
        }
    });

    it('selection survives a search that returns no rows', () => {
        const { selection, state } = clicks(five, [
            ['a', plain],
            ['c', toggle],
        ]);
        const empty = snapshotOf([]);
        const result = clickSelection(selection, empty, 'a', plain, state, multiple);

        expect(result.selection).toBe(selection);
        expect(ids(selection)).toEqual(['a', 'c']);
        expect(selectedLoadedRows(selection, [])).toEqual([]);
        expect(selectionCount(selection, 0)).toBe(2);
    });
});

describe('selectedLoadedRows', () => {
    const rows = [groupRow('g'), dataRow('a'), loadingRow('loading-2', 2), dataRow('b'), dataRow('c')];

    it('returns selected data rows in the given order', () => {
        const selection = select(emptySelection(), ['c', 'a', 'g', 'loading-2', 'unloaded'], true, multiple);

        expect(selectedLoadedRows(selection, rows).map((row) => row.id)).toEqual(['a', 'c']);
    });

    it('returns every loaded data row in all mode, minus exclusions and unselectable rows', () => {
        const selection = select(selectAll(), ['b'], false, multiple);

        expect(selectedLoadedRows(selection, rows).map((row) => row.id)).toEqual(['a', 'c']);
        expect(
            selectedLoadedRows(selectAll(), rows, { isSelectable: (id) => id !== 'c' }).map((row) => row.id)
        ).toEqual(['a', 'b']);
    });
});

describe('selectionCount', () => {
    it('counts ids regardless of the total', () => {
        const selection = select(emptySelection(), ['a', 'b'], true, multiple);

        expect(selectionCount(selection, null)).toBe(2);
        expect(selectionCount(selection, 100)).toBe(2);
    });

    it('subtracts exclusions from a known total in all mode', () => {
        expect(selectionCount(selectAll(), 100)).toBe(100);
        expect(selectionCount(select(selectAll(), ['a', 'b'], false, multiple), 100)).toBe(98);
        expect(selectionCount(select(selectAll(), ['a', 'b'], false, multiple), 1)).toBe(0);
    });

    it('is null in all mode with an unknown total', () => {
        expect(selectionCount(selectAll(), null)).toBeNull();
    });
});

describe('pruneSelection', () => {
    const exists = (id: RowId): boolean => id !== 'deleted';

    it('drops ids that no longer exist', () => {
        const selection = select(emptySelection(), ['a', 'deleted'], true, multiple);

        expect(ids(pruneSelection(selection, exists))).toEqual(['a']);
    });

    it('drops stale exclusions in all mode', () => {
        const selection = select(selectAll(), ['a', 'deleted'], false, multiple);

        expect(pruneSelection(selection, exists)).toEqual({ mode: 'all', excludedIds: new Set(['a']) });
    });

    it('returns the same object when nothing was deleted', () => {
        const selection = select(emptySelection(), ['a'], true, multiple);

        expect(pruneSelection(selection, exists)).toBe(selection);
    });
});

describe('property: random click sequences', () => {
    /** Small deterministic PRNG so failures reproduce. */
    function mulberry32(seed: number): () => number {
        let state = seed;

        return () => {
            state = (state + 0x6d2b79f5) | 0;
            let value = Math.imul(state ^ (state >>> 15), 1 | state);
            value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    }

    const rows: GridRow<Row>[] = [];
    for (let index = 0; index < 30; index++) {
        if (index % 7 === 0) {
            rows.push(groupRow(`g${index}`));
        } else if (index % 11 === 0) {
            rows.push(loadingRow(`loading-${index}`, index));
        } else {
            rows.push(dataRow(`r${index}`));
        }
    }
    const snapshot = snapshotOf(rows);
    const isSelectable = (id: RowId): boolean => !id.endsWith('3');
    const selectableDataIds = new Set(
        rows.filter((row) => row.kind === 'data' && isSelectable(row.id)).map((row) => row.id)
    );
    const candidates = [...rows.map((row) => row.id), 'missing'];

    for (const mode of ['single', 'multiple'] as const) {
        it(`never selects an unselectable or non-data row in ${mode} mode`, () => {
            for (let seed = 1; seed <= 200; seed++) {
                const random = mulberry32(seed);
                let selection = emptySelection();
                let state: ClickState = { anchorId: null };

                for (let step = 0; step < 40; step++) {
                    const id = candidates[Math.floor(random() * candidates.length)]!;
                    const modifiers = { toggle: random() < 0.3, range: random() < 0.3 };
                    const result = clickSelection(selection, snapshot, id, modifiers, state, { mode, isSelectable });
                    selection = result.selection;
                    state = { anchorId: result.anchorId, rangeEndId: result.rangeEndId };

                    expect(selection.mode).toBe('ids');
                    const selected = selection.mode === 'ids' ? [...selection.ids] : [];

                    for (const selectedId of selected) {
                        expect(selectableDataIds.has(selectedId), `seed ${seed} step ${step}: ${selectedId}`).toBe(
                            true
                        );
                    }

                    if (mode === 'single') {
                        expect(selected.length, `seed ${seed} step ${step}`).toBeLessThanOrEqual(1);
                    }
                }
            }
        });
    }
});
