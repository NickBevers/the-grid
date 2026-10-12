import { describe, expect, it } from 'vitest';

import type { CellPosition, GridRow } from '../contract';
import {
    FULL_WIDTH_COLUMN,
    keyToNavigation,
    type NavigationKey,
    type NavigationKeyEvent,
    nextFocus,
    recoverFocus,
} from './navigation';
import { createSnapshot, type GridSnapshot, type SnapshotColumn } from './snapshot';

type Data = { id: string };

function data(id: string): GridRow<Data> {
    return { id, kind: 'data', section: 'body', level: 0, parentId: null, data: { id } };
}

function fullWidth(id: string): GridRow<Data> {
    return { id, kind: 'fullWidth', section: 'body', level: 0, parentId: null, data: { id } };
}

function loading(id: string, index: number): GridRow<Data> {
    return { id, kind: 'loading', section: 'body', level: 0, parentId: null, index };
}

function failed(id: string, index: number): GridRow<Data> {
    return { id, kind: 'failed', section: 'body', level: 0, parentId: null, index, error: new Error('x') };
}

function column(colId: string, focusable = true): SnapshotColumn<Data> {
    return {
        colId,
        focusable,
        getValue: () => undefined,
        formatValue: () => '',
        isEditable: () => false,
    };
}

function rows(count: number, prefix = 'r'): GridRow<Data>[] {
    return Array.from({ length: count }, (_, index) => data(`${prefix}${index}`));
}

/** Columns a, b (not focusable), c, d. */
const COLUMNS = [column('a'), column('b', false), column('c'), column('d')];

function grid(rowList: GridRow<Data>[] = rows(5), columns = COLUMNS): GridSnapshot<Data> {
    return createSnapshot(rowList, columns);
}

function at(rowId: string, colId: string): CellPosition {
    return { rowId, colId };
}

function key(overrides: Partial<NavigationKeyEvent> & { key: string }): NavigationKeyEvent {
    return { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...overrides };
}

const PAGE = { pageSize: 3 };

describe('keyToNavigation', () => {
    it.each([
        ['ArrowUp', 'up'],
        ['ArrowDown', 'down'],
        ['ArrowLeft', 'left'],
        ['ArrowRight', 'right'],
        ['Tab', 'next'],
        ['Home', 'rowStart'],
        ['End', 'rowEnd'],
        ['PageUp', 'pageUp'],
        ['PageDown', 'pageDown'],
    ])('maps plain %s to %s', (name, expected) => {
        expect(keyToNavigation(key({ key: name }))).toBe(expected);
    });

    it('maps Shift+Tab to previous', () => {
        expect(keyToNavigation(key({ key: 'Tab', shiftKey: true }))).toBe('previous');
    });

    it.each(['ctrlKey', 'metaKey'] as const)(
        'maps %s with Home, End and vertical arrows to the grid edges',
        (modifier) => {
            expect(keyToNavigation(key({ key: 'Home', [modifier]: true }))).toBe('gridStart');
            expect(keyToNavigation(key({ key: 'End', [modifier]: true }))).toBe('gridEnd');
            expect(keyToNavigation(key({ key: 'ArrowUp', [modifier]: true }))).toBe('columnTop');
            expect(keyToNavigation(key({ key: 'ArrowDown', [modifier]: true }))).toBe('columnBottom');
        }
    );

    it.each(['ctrlKey', 'metaKey'] as const)('maps %s with horizontal arrows to the row ends', (modifier) => {
        expect(keyToNavigation(key({ key: 'ArrowLeft', [modifier]: true }))).toBe('rowStart');
        expect(keyToNavigation(key({ key: 'ArrowRight', [modifier]: true }))).toBe('rowEnd');
    });

    it('leaves Shift with arrows, Home and End to range extension', () => {
        for (const name of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp']) {
            expect(keyToNavigation(key({ key: name, shiftKey: true }))).toBeNull();
        }
    });

    it('ignores Alt combinations, Ctrl+Tab, modified paging and other keys', () => {
        expect(keyToNavigation(key({ key: 'ArrowUp', altKey: true }))).toBeNull();
        expect(keyToNavigation(key({ key: 'Tab', ctrlKey: true }))).toBeNull();
        expect(keyToNavigation(key({ key: 'PageDown', metaKey: true }))).toBeNull();
        expect(keyToNavigation(key({ key: 'Enter' }))).toBeNull();
        expect(keyToNavigation(key({ key: 'a' }))).toBeNull();
    });
});

describe('nextFocus', () => {
    describe('arrows', () => {
        it('moves one cell in each direction', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r2', 'c'), 'up', PAGE)).toEqual(at('r1', 'c'));
            expect(nextFocus(snapshot, at('r2', 'c'), 'down', PAGE)).toEqual(at('r3', 'c'));
            expect(nextFocus(snapshot, at('r2', 'c'), 'right', PAGE)).toEqual(at('r2', 'd'));
        });

        it('skips non-focusable columns horizontally', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r2', 'c'), 'left', PAGE)).toEqual(at('r2', 'a'));
            expect(nextFocus(snapshot, at('r2', 'a'), 'right', PAGE)).toEqual(at('r2', 'c'));
        });

        it('stays put at the grid edges', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r0', 'c'), 'up', PAGE)).toEqual(at('r0', 'c'));
            expect(nextFocus(snapshot, at('r4', 'c'), 'down', PAGE)).toEqual(at('r4', 'c'));
            expect(nextFocus(snapshot, at('r2', 'a'), 'left', PAGE)).toEqual(at('r2', 'a'));
            expect(nextFocus(snapshot, at('r2', 'd'), 'right', PAGE)).toEqual(at('r2', 'd'));
        });

        it('stays inside the focusable columns when the edge columns are not focusable', () => {
            const snapshot = grid(rows(2), [column('x', false), column('a'), column('c'), column('y', false)]);
            expect(nextFocus(snapshot, at('r0', 'a'), 'left', PAGE)).toEqual(at('r0', 'a'));
            expect(nextFocus(snapshot, at('r0', 'c'), 'right', PAGE)).toEqual(at('r0', 'c'));
        });

        it('snaps to the nearest focusable column when starting from a non-focusable one', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r1', 'b'), 'down', PAGE)).toEqual(at('r2', 'c'));
            expect(nextFocus(snapshot, at('r1', 'b'), 'right', PAGE)).toEqual(at('r1', 'c'));
            expect(nextFocus(snapshot, at('r1', 'b'), 'left', PAGE)).toEqual(at('r1', 'a'));
        });
    });

    describe('row and grid edges', () => {
        it('goes to the first and last focusable cell of the row', () => {
            const snapshot = grid(rows(3), [column('x', false), column('a'), column('c'), column('y', false)]);
            expect(nextFocus(snapshot, at('r1', 'c'), 'rowStart', PAGE)).toEqual(at('r1', 'a'));
            expect(nextFocus(snapshot, at('r1', 'a'), 'rowEnd', PAGE)).toEqual(at('r1', 'c'));
        });

        it('goes to the first and last row in the same column', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r2', 'c'), 'columnTop', PAGE)).toEqual(at('r0', 'c'));
            expect(nextFocus(snapshot, at('r2', 'c'), 'columnBottom', PAGE)).toEqual(at('r4', 'c'));
        });

        it('goes to the first and last cell of the grid', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r2', 'c'), 'gridStart', PAGE)).toEqual(at('r0', 'a'));
            expect(nextFocus(snapshot, at('r2', 'c'), 'gridEnd', PAGE)).toEqual(at('r4', 'd'));
        });

        it('focuses a full-width row as a whole at the grid edges', () => {
            const snapshot = grid([fullWidth('f0'), data('r1'), fullWidth('f2')]);
            expect(nextFocus(snapshot, at('r1', 'c'), 'gridStart', PAGE)).toEqual(at('f0', FULL_WIDTH_COLUMN));
            expect(nextFocus(snapshot, at('r1', 'c'), 'gridEnd', PAGE)).toEqual(at('f2', FULL_WIDTH_COLUMN));
        });
    });

    describe('paging', () => {
        it('moves by pageSize rows and keeps the column', () => {
            const snapshot = grid(rows(10));
            expect(nextFocus(snapshot, at('r1', 'c'), 'pageDown', PAGE)).toEqual(at('r4', 'c'));
            expect(nextFocus(snapshot, at('r5', 'c'), 'pageUp', PAGE)).toEqual(at('r2', 'c'));
        });

        it('clamps at the first and last row', () => {
            const snapshot = grid(rows(10));
            expect(nextFocus(snapshot, at('r8', 'c'), 'pageDown', PAGE)).toEqual(at('r9', 'c'));
            expect(nextFocus(snapshot, at('r1', 'c'), 'pageUp', PAGE)).toEqual(at('r0', 'c'));
            expect(nextFocus(snapshot, at('r9', 'c'), 'pageDown', PAGE)).toEqual(at('r9', 'c'));
            expect(nextFocus(snapshot, at('r0', 'c'), 'pageUp', PAGE)).toEqual(at('r0', 'c'));
        });

        it('treats a page size below one as one row', () => {
            const snapshot = grid(rows(10));
            expect(nextFocus(snapshot, at('r4', 'c'), 'pageDown', { pageSize: 0 })).toEqual(at('r5', 'c'));
        });

        it('lands on a full-width row as a whole and leaves it for the preferred column', () => {
            const snapshot = grid([data('r0'), data('r1'), fullWidth('f2'), data('r3'), data('r4')]);
            expect(nextFocus(snapshot, at('r0', 'c'), 'pageDown', { pageSize: 2 })).toEqual(
                at('f2', FULL_WIDTH_COLUMN)
            );
            expect(
                nextFocus(snapshot, at('f2', FULL_WIDTH_COLUMN), 'pageDown', { pageSize: 2, preferredColId: 'c' })
            ).toEqual(at('r4', 'c'));
        });
    });

    describe('Tab', () => {
        it('moves right across focusable cells', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r0', 'a'), 'next', PAGE)).toEqual(at('r0', 'c'));
            expect(nextFocus(snapshot, at('r0', 'c'), 'previous', PAGE)).toEqual(at('r0', 'a'));
        });

        it('wraps to the next and previous row', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r0', 'd'), 'next', PAGE)).toEqual(at('r1', 'a'));
            expect(nextFocus(snapshot, at('r1', 'a'), 'previous', PAGE)).toEqual(at('r0', 'd'));
        });

        it('leaves the grid past the last and before the first cell', () => {
            const snapshot = grid();
            expect(nextFocus(snapshot, at('r4', 'd'), 'next', PAGE)).toBeNull();
            expect(nextFocus(snapshot, at('r0', 'a'), 'previous', PAGE)).toBeNull();
        });

        it('stops on a full-width row once', () => {
            const snapshot = grid([data('r0'), fullWidth('f1'), data('r2')]);
            expect(nextFocus(snapshot, at('r0', 'd'), 'next', PAGE)).toEqual(at('f1', FULL_WIDTH_COLUMN));
            expect(nextFocus(snapshot, at('f1', FULL_WIDTH_COLUMN), 'next', PAGE)).toEqual(at('r2', 'a'));
            expect(nextFocus(snapshot, at('r2', 'a'), 'previous', PAGE)).toEqual(at('f1', FULL_WIDTH_COLUMN));
            expect(nextFocus(snapshot, at('f1', FULL_WIDTH_COLUMN), 'previous', PAGE)).toEqual(at('r0', 'd'));
        });

        it('leaves the grid from a full-width row at either end', () => {
            const snapshot = grid([fullWidth('f0'), data('r1'), fullWidth('f2')]);
            expect(nextFocus(snapshot, at('f2', FULL_WIDTH_COLUMN), 'next', PAGE)).toBeNull();
            expect(nextFocus(snapshot, at('f0', FULL_WIDTH_COLUMN), 'previous', PAGE)).toBeNull();
        });
    });

    describe('full-width rows', () => {
        const snapshot = grid([data('r0'), fullWidth('f1'), data('r2')]);

        it('focuses them as a whole when moving onto them', () => {
            expect(nextFocus(snapshot, at('r0', 'c'), 'down', PAGE)).toEqual(at('f1', FULL_WIDTH_COLUMN));
            expect(nextFocus(snapshot, at('r2', 'c'), 'up', PAGE)).toEqual(at('f1', FULL_WIDTH_COLUMN));
        });

        it('restores the preferred column when moving off them', () => {
            const options = { ...PAGE, preferredColId: 'd' };
            expect(nextFocus(snapshot, at('f1', FULL_WIDTH_COLUMN), 'down', options)).toEqual(at('r2', 'd'));
            expect(nextFocus(snapshot, at('f1', FULL_WIDTH_COLUMN), 'up', options)).toEqual(at('r0', 'd'));
        });

        it('falls back to the first focusable column without a usable preferred column', () => {
            expect(nextFocus(snapshot, at('f1', FULL_WIDTH_COLUMN), 'down', PAGE)).toEqual(at('r2', 'a'));
            expect(nextFocus(snapshot, at('f1', FULL_WIDTH_COLUMN), 'down', { ...PAGE, preferredColId: 'b' })).toEqual(
                at('r2', 'a')
            );
            expect(
                nextFocus(snapshot, at('f1', FULL_WIDTH_COLUMN), 'down', { ...PAGE, preferredColId: 'gone' })
            ).toEqual(at('r2', 'a'));
        });

        it('ignores horizontal keys on them', () => {
            for (const navigation of ['left', 'right', 'rowStart', 'rowEnd'] as const) {
                expect(nextFocus(snapshot, at('f1', FULL_WIDTH_COLUMN), navigation, PAGE)).toEqual(
                    at('f1', FULL_WIDTH_COLUMN)
                );
            }
        });

        it('moves between adjacent full-width rows', () => {
            const stacked = grid([fullWidth('f0'), fullWidth('f1')]);
            expect(nextFocus(stacked, at('f0', FULL_WIDTH_COLUMN), 'down', PAGE)).toEqual(at('f1', FULL_WIDTH_COLUMN));
        });

        it('treats detail rows as full-width by default', () => {
            const detail: GridRow<Data> = {
                id: 'd1',
                kind: 'detail',
                section: 'body',
                level: 1,
                parentId: 'r0',
                masterId: 'r0',
                data: { id: 'd1' },
            };
            expect(nextFocus(grid([data('r0'), detail]), at('r0', 'a'), 'down', PAGE)).toEqual(
                at('d1', FULL_WIDTH_COLUMN)
            );
        });
    });

    describe('placeholder rows', () => {
        it('can be focused like any other row', () => {
            const snapshot = grid([data('r0'), loading('l1', 1), failed('x2', 2)]);
            expect(nextFocus(snapshot, at('r0', 'c'), 'down', PAGE)).toEqual(at('l1', 'c'));
            expect(nextFocus(snapshot, at('l1', 'c'), 'right', PAGE)).toEqual(at('l1', 'd'));
            expect(nextFocus(snapshot, at('l1', 'd'), 'next', PAGE)).toEqual(at('x2', 'a'));
        });
    });

    describe('without focus', () => {
        const snapshot = grid();

        it('goes to the first cell on next and down', () => {
            expect(nextFocus(snapshot, null, 'next', PAGE)).toEqual(at('r0', 'a'));
            expect(nextFocus(snapshot, null, 'down', PAGE)).toEqual(at('r0', 'a'));
        });

        it('goes to the last row on previous and up', () => {
            expect(nextFocus(snapshot, null, 'previous', PAGE)).toEqual(at('r4', 'd'));
            expect(nextFocus(snapshot, null, 'up', PAGE)).toEqual(at('r4', 'a'));
        });

        it('goes to the grid corners on the grid edge keys', () => {
            expect(nextFocus(snapshot, null, 'gridStart', PAGE)).toEqual(at('r0', 'a'));
            expect(nextFocus(snapshot, null, 'gridEnd', PAGE)).toEqual(at('r4', 'd'));
        });

        it('does nothing on other keys', () => {
            for (const navigation of ['left', 'right', 'rowStart', 'rowEnd', 'pageUp', 'pageDown'] as const) {
                expect(nextFocus(snapshot, null, navigation, PAGE)).toBeNull();
            }
        });

        it('treats a cell that is no longer displayed as no focus', () => {
            expect(nextFocus(snapshot, at('gone', 'a'), 'down', PAGE)).toEqual(at('r0', 'a'));
            expect(nextFocus(snapshot, at('r1', 'gone'), 'right', PAGE)).toBeNull();
        });

        it('focuses a full-width first row as a whole', () => {
            expect(nextFocus(grid([fullWidth('f0'), data('r1')]), null, 'next', PAGE)).toEqual(
                at('f0', FULL_WIDTH_COLUMN)
            );
        });
    });

    describe('empty grids', () => {
        it('returns null without rows', () => {
            expect(nextFocus(grid([]), null, 'next', PAGE)).toBeNull();
            expect(nextFocus(grid([]), at('r0', 'a'), 'down', PAGE)).toBeNull();
        });

        it('returns null without focusable columns', () => {
            const snapshot = grid(rows(3), [column('a', false), column('b', false)]);
            expect(nextFocus(snapshot, null, 'next', PAGE)).toBeNull();
            expect(nextFocus(snapshot, at('r0', 'a'), 'down', PAGE)).toBeNull();
        });

        it('returns null without columns at all', () => {
            expect(nextFocus(grid(rows(3), []), null, 'down', PAGE)).toBeNull();
        });
    });
});

describe('recoverFocus', () => {
    it('keeps a cell that still exists, at its new index', () => {
        const snapshot = grid([data('r9'), ...rows(3)]);
        expect(recoverFocus(snapshot, { cell: at('r1', 'c'), index: 1, columnIndex: 2 })).toEqual(at('r1', 'c'));
    });

    it('takes the row now at the same index when the row is gone', () => {
        const snapshot = grid([data('r0'), data('r2'), data('r3')]);
        expect(recoverFocus(snapshot, { cell: at('r1', 'c'), index: 1, columnIndex: 2 })).toEqual(at('r2', 'c'));
    });

    it('clamps the index when the removed row was at the end', () => {
        const snapshot = grid(rows(3));
        expect(recoverFocus(snapshot, { cell: at('r7', 'c'), index: 7, columnIndex: 2 })).toEqual(at('r2', 'c'));
    });

    it('focuses a full-width row now at the index as a whole', () => {
        const snapshot = grid([data('r0'), fullWidth('f1')]);
        expect(recoverFocus(snapshot, { cell: at('r1', 'c'), index: 1, columnIndex: 2 })).toEqual(
            at('f1', FULL_WIDTH_COLUMN)
        );
    });

    it('takes the nearest focusable column when the column is gone', () => {
        const snapshot = grid(rows(2), [column('a'), column('b', false), column('d')]);
        expect(recoverFocus(snapshot, { cell: at('r0', 'c'), index: 0, columnIndex: 2 })).toEqual(at('r0', 'd'));
    });

    it('takes the nearest focusable column when the column is hidden from the end', () => {
        const snapshot = grid(rows(2), [column('a'), column('b', false), column('c')]);
        expect(recoverFocus(snapshot, { cell: at('r0', 'd'), index: 0, columnIndex: 3 })).toEqual(at('r0', 'c'));
    });

    it('moves off a column that is no longer focusable, preferring the right on a tie', () => {
        const snapshot = grid(rows(2), [column('a'), column('b'), column('c', false), column('d')]);
        expect(recoverFocus(snapshot, { cell: at('r0', 'c'), index: 0, columnIndex: 2 })).toEqual(at('r0', 'd'));
    });

    it('recovers both row and column at once', () => {
        const snapshot = grid([data('r0'), data('r5')], [column('a'), column('d')]);
        expect(recoverFocus(snapshot, { cell: at('r1', 'c'), index: 1, columnIndex: 2 })).toEqual(at('r5', 'd'));
    });

    it('picks a column when leaving a full-width row that became a data row', () => {
        const snapshot = grid(rows(2));
        expect(recoverFocus(snapshot, { cell: at('f1', FULL_WIDTH_COLUMN), index: 1, columnIndex: 0 })).toEqual(
            at('r1', 'a')
        );
    });

    it('returns null when the grid is empty', () => {
        expect(recoverFocus(grid([]), { cell: at('r0', 'a'), index: 0, columnIndex: 0 })).toBeNull();
        expect(
            recoverFocus(grid(rows(2), [column('a', false)]), { cell: at('r0', 'a'), index: 0, columnIndex: 0 })
        ).toBeNull();
    });
});

describe('navigation properties', () => {
    const KEYS: NavigationKey[] = [
        'up',
        'down',
        'left',
        'right',
        'next',
        'previous',
        'rowStart',
        'rowEnd',
        'columnTop',
        'columnBottom',
        'gridStart',
        'gridEnd',
        'pageUp',
        'pageDown',
    ];

    /** Small deterministic PRNG (mulberry32) so failures reproduce. */
    function random(seed: number): () => number {
        let state = seed;
        return () => {
            state = (state + 0x6d2b79f5) | 0;
            let value = Math.imul(state ^ (state >>> 15), 1 | state);
            value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    }

    function randomSnapshot(next: () => number): GridSnapshot<Data> {
        const rowCount = Math.floor(next() * 12);
        const rowList = Array.from({ length: rowCount }, (_, index) => {
            const roll = next();
            if (roll < 0.15) {
                return fullWidth(`f${index}`);
            }
            if (roll < 0.25) {
                return loading(`l${index}`, index);
            }
            return data(`r${index}`);
        });
        const columnCount = Math.floor(next() * 6);
        const columns = Array.from({ length: columnCount }, (_, index) => column(`c${index}`, next() < 0.7));

        return grid(rowList, columns);
    }

    function assertInside(snapshot: GridSnapshot<Data>, cell: CellPosition): void {
        const rowIndex = snapshot.indexOf(cell.rowId);
        expect(rowIndex).toBeDefined();
        const row = snapshot.rowAt(rowIndex as number) as GridRow<Data>;
        if (snapshot.isFullWidth(row)) {
            expect(cell.colId).toBe(FULL_WIDTH_COLUMN);
            return;
        }
        const columnIndex = snapshot.columnIndexOf(cell.colId);
        expect(columnIndex).toBeDefined();
        expect(snapshot.columns[columnIndex as number]?.focusable).toBe(true);
    }

    it('never leaves the grid or lands on a non-focusable column', () => {
        for (let seed = 1; seed <= 300; seed++) {
            const next = random(seed);
            const snapshot = randomSnapshot(next);
            let focus: CellPosition | null = null;
            let preferredColId: string | undefined;

            for (let step = 0; step < 40; step++) {
                const navigation = KEYS[Math.floor(next() * KEYS.length)] as NavigationKey;
                const moved: CellPosition | null = nextFocus(snapshot, focus, navigation, {
                    pageSize: 1 + Math.floor(next() * 5),
                    preferredColId,
                });
                if (moved !== null) {
                    assertInside(snapshot, moved);
                    if (moved.colId !== FULL_WIDTH_COLUMN) {
                        preferredColId = moved.colId;
                    }
                }
                focus = moved;
            }
        }
    });

    it('returns to the start after up then down away from edges and full-width rows', () => {
        let checked = 0;

        for (let seed = 1; seed <= 300; seed++) {
            const next = random(seed);
            const snapshot = randomSnapshot(next);
            const focusable = snapshot.columns.filter((candidate) => candidate.focusable);
            if (snapshot.rowCount < 2 || focusable.length === 0) {
                continue;
            }

            const rowIndex = 1 + Math.floor(next() * (snapshot.rowCount - 1));
            const row = snapshot.rowAt(rowIndex) as GridRow<Data>;
            const above = snapshot.rowAt(rowIndex - 1) as GridRow<Data>;
            if (snapshot.isFullWidth(row) || snapshot.isFullWidth(above)) {
                continue;
            }

            const start = at(row.id, (focusable[Math.floor(next() * focusable.length)] as SnapshotColumn<Data>).colId);
            const up = nextFocus(snapshot, start, 'up', { pageSize: 1 });
            expect(nextFocus(snapshot, up, 'down', { pageSize: 1 })).toEqual(start);
            checked++;
        }

        expect(checked).toBeGreaterThan(50);
    });
});
