import { describe, expect, it, vi } from 'vitest';

import type { CellEditorComponent, ColumnDefinition, GridApi } from '../contract';
import { GridStore, type GridStoreOptions } from './store';

type Item = { id: number; name: string; fee: number | null; group?: string };

const items = (): Item[] => [
    { id: 1, name: 'Bravo', fee: 30 },
    { id: 2, name: 'alpha', fee: 10 },
    { id: 3, name: 'Charlie', fee: null },
    { id: 4, name: 'delta', fee: 20 },
];

const columns: ColumnDefinition<Item>[] = [
    { field: 'id', pinned: 'left', width: 60 },
    { field: 'name', editable: true },
    { field: 'fee', editable: true },
];

const api = {} as GridApi<Item>;

function store(overrides: Partial<GridStoreOptions<Item>> = {}) {
    return new GridStore<Item>({
        rows: items(),
        getRowId: (data) => String(data.id),
        columns,
        interaction: 'cell',
        enableRanges: true,
        enableFill: true,
        ...overrides,
    });
}

const dataOf = (s: GridStore<Item>, rowId: string): Item => (s.getRow(rowId) as { data: Item }).data;
const order = (s: GridStore<Item>): string[] => s.projection.displayedRows.map((row) => row.id);
const at = (rowId: string, colId: string) => ({ rowId, colId });

describe('GridStore rows and columns', () => {
    it('sorts locally through the header cycle, empty values last in both directions', () => {
        const s = store();
        s.toggleSort('fee', false);
        expect(order(s)).toEqual(['2', '4', '1', '3']);
        s.toggleSort('fee', false);
        expect(order(s)).toEqual(['1', '4', '2', '3']);
        s.toggleSort('fee', false);
        expect(order(s)).toEqual(['1', '2', '3', '4']);
        s.toggleSort('name', false);
        expect(order(s)).toEqual(['2', '1', '3', '4']);
    });

    it('filters by the quick filter over formatted values', () => {
        const s = store();
        s.setOptions({ ...s.options, quickFilter: 'ar' });

        expect(order(s)).toEqual(['3']);
    });

    it('emits column state on resize with finished flags', () => {
        const s = store();
        const listener = vi.fn();
        s.events.on('columnStateChanged', listener);
        s.resizeColumn('name', 220, false);
        s.resizeColumn('name', 240, true);

        expect(listener.mock.calls.map(([event]) => [event.kind, event.finished])).toEqual([
            ['resized', false],
            ['resized', true],
        ]);
        expect(s.columns.getColumnState().find((entry) => entry.colId === 'name')!.width).toBe(240);
    });

    it('reports unresolved registry keys instead of passing strings on', () => {
        const misses: string[] = [];
        const s = store({
            columns: [{ field: 'name', cellRenderer: 'nationalityCellRenderer' }],
            onUnresolvedKey: (miss) => misses.push(miss.key),
        });

        expect(misses).toEqual(['nationalityCellRenderer']);
        expect(s.columns.getResolved('name')!.renderer).toBeUndefined();
    });
});

describe('GridStore focus', () => {
    it('navigates with keys and Tab leaves the grid at the end', () => {
        const s = store();
        expect(s.navigate('next')).toEqual(at('1', 'id'));
        s.navigate('right');
        s.navigate('down');
        expect(s.focusedCell).toEqual(at('2', 'name'));
        s.focusCell(at('4', 'fee'));
        expect(s.navigate('next')).toBeNull();
        expect(s.focusedCell).toEqual(at('4', 'fee'));
    });

    it('keeps focus on the same row after a sort, and recovers when the column is hidden', () => {
        const s = store();
        s.focusCell(at('3', 'fee'));
        s.toggleSort('name', false);
        expect(s.focusedCell).toEqual(at('3', 'fee'));
        s.setColumnsVisible(['fee'], false);
        expect(s.focusedCell).toEqual(at('3', 'name'));
    });

    it('recovers to the row at the same index when the focused row is removed', () => {
        const s = store();
        s.focusCell(at('2', 'name'));
        s.setOptions({ ...s.options, rows: items().filter((item) => item.id !== 2) });

        expect(s.focusedCell).toEqual(at('3', 'name'));
    });
});

describe('GridStore selection', () => {
    it('selects with plain, toggle and range clicks and tracks the active row', () => {
        const s = store({ interaction: 'row', rowSelection: 'multiple' });
        s.clickRow('1', { toggle: false, range: false });
        s.clickRow('3', { toggle: false, range: true });
        expect([...(s.selection as { mode: 'ids'; ids: ReadonlySet<string> }).ids].sort()).toEqual(['1', '2', '3']);
        s.clickRow('2', { toggle: true, range: false });
        expect(s.isRowSelected('2')).toBe(false);
        expect(s.activeRowId).toBe('2');
        expect(s.getSelectedRows().map((row) => row.id)).toEqual(['1', '3']);
    });

    it('keeps ids of rows that are not loaded and never reports unselectable rows', () => {
        const s = store({ rowSelection: 'multiple', isRowSelectable: (row) => row.id !== '4' });
        s.setSelected(['1', '4', 'not-loaded'], true);

        expect(s.isRowSelected('not-loaded')).toBe(true);
        expect(s.isRowSelected('4')).toBe(false);
        expect(s.getSelectedRows().map((row) => row.id)).toEqual(['1']);
    });

    it('reports explicitly selected local rows hidden by a search and can deselect them', () => {
        const s = store({ rowSelection: 'multiple' });
        s.setSelected(['1'], true);
        s.setOptions({ ...s.options, quickFilter: 'alpha' });
        s.setSelected(['2'], true);

        expect(
            s
                .getSelectedRows()
                .map((row) => row.id)
                .sort()
        ).toEqual(['1', '2']);
        expect(s.isRowSelected('1')).toBe(true);

        s.setSelected(['1'], false);
        s.setOptions({ ...s.options, quickFilter: '' });

        expect(s.getSelectedRows().map((row) => row.id)).toEqual(['2']);
        expect(s.isRowSelected('1')).toBe(false);
    });

    it('limits select-all to the current query while retaining explicitly selected hidden rows', () => {
        const s = store({ rowSelection: 'multiple' });
        s.setSelected(['1'], true);
        s.setFilterModel({ name: { filterType: 'text', type: 'equals', filter: 'alpha' } });

        expect(s.getSelectedRows().map((row) => row.id)).toEqual(['1']);

        s.selectAllRows();

        expect(s.getSelectedRows().map((row) => row.id)).toEqual(['2']);
    });

    it('tells the select-all checkbox whether none, some or all of the rows that pass the filters are selected', () => {
        const s = store({ rowSelection: 'multiple', isRowSelectable: (row) => row.id !== '3' });
        expect(s.headerSelectionState()).toBe('none');

        s.setSelected(['1'], true);
        expect(s.headerSelectionState()).toBe('some');

        s.setSelected(['2', '4'], true);
        expect(s.headerSelectionState()).toBe('all');

        s.setSelected(['4'], false);
        s.setFilterModel({ name: { filterType: 'text', type: 'notEqual', filter: 'delta' } });
        expect(s.headerSelectionState()).toBe('all');

        s.selectAllRows();
        expect(s.headerSelectionState()).toBe('all');
        s.setSelected(['2'], false);
        expect(s.headerSelectionState()).toBe('some');
    });

    it('moves focus, not the active row, with the arrow keys in row grids', () => {
        const s = store({ interaction: 'row', rowSelection: 'single' });
        s.setActiveRow('1');
        s.focusCell(at('1', 'name'));
        s.navigate('down');

        expect(s.focusedCell).toEqual(at('2', 'name'));
        expect(s.activeRowId).toBe('1');
    });
});

describe('GridStore ranges', () => {
    it('drags a range, extends with Shift, and drops a plain click range', () => {
        const s = store();
        s.pointerDownCell(at('1', 'name'), { shift: false, toggle: false });
        s.dragOverCell(at('3', 'fee'));
        s.pointerUp();
        expect(s.resolvedRanges[0]).toMatchObject({ rowIds: ['1', '2', '3'], colIds: ['name', 'fee'] });
        expect(s.rangeEdges('2', 'fee')).toMatchObject({ right: true, top: false, bottom: false });

        s.pointerDownCell(at('2', 'name'), { shift: false, toggle: false });
        s.pointerUp();
        expect(s.ranges).toEqual([]);

        s.navigate('down', { extend: true });
        expect(s.resolvedRanges[0]).toMatchObject({ rowIds: ['2', '3'], colIds: ['name'] });
    });

    it('adds ranges with Ctrl or Cmd and aggregates each cell once', () => {
        const s = store();
        s.pointerDownCell(at('1', 'fee'), { shift: false, toggle: false });
        s.dragOverCell(at('2', 'fee'));
        s.pointerUp();
        s.pointerDownCell(at('2', 'fee'), { shift: false, toggle: true });
        s.dragOverCell(at('4', 'fee'));
        s.pointerUp();

        expect(s.ranges).toHaveLength(2);
        expect(s.getAggregation()).toMatchObject({ sum: 60, count: 3, numericCount: 3, mixed: false });
    });
});

describe('GridStore clipboard and fill', () => {
    it('copies TSV and HTML with headers', () => {
        const s = store();
        s.pointerDownCell(at('1', 'name'), { shift: false, toggle: false });
        s.dragOverCell(at('2', 'fee'));
        s.pointerUp();

        expect(s.copy()!.text).toBe('Bravo\t30\nalpha\t10');
        expect(s.copy({ includeHeaders: true })!.text).toBe('Name\tFee\nBravo\t30\nalpha\t10');
        expect(s.copy({ includeHeaders: true })!.html).toMatch(/<th[^>]*>Name<\/th>/);
    });

    it('pastes a matrix from the focus, parses numbers, and marks invalid cells', async () => {
        const s = store();
        const changes = vi.fn();
        s.events.on('cellValueChanged', changes);
        s.focusCell(at('1', 'name'));
        const result = await s.paste('Echo\t5\nFoxtrot\tlots');

        expect(result).toEqual({ written: 3, rejected: 1 });
        expect(dataOf(s, '1')).toMatchObject({ name: 'Echo', fee: 5 });
        expect(dataOf(s, '2')).toMatchObject({ name: 'Foxtrot', fee: 10 });
        expect(s.cellError(at('2', 'fee'))).toMatch(/not a number/);
        expect(changes.mock.calls.every(([event]) => event.source === 'paste')).toBe(true);
    });

    it('copies through clipboardFormat, with the raw value and the formatted text', () => {
        const s = store({
            clipboardFormat: (value, { cell, formatted }) =>
                cell.colId === 'fee' ? `${value}€` : formatted.toUpperCase(),
        });
        s.pointerDownCell(at('1', 'name'), { shift: false, toggle: false });
        s.dragOverCell(at('2', 'fee'));
        s.pointerUp();

        expect(s.copy()!.text).toBe('BRAVO\t30€\nALPHA\t10€');
    });

    it('pastes through clipboardParse first, falling back to the editor parser, and reports start and end', async () => {
        const events: string[] = [];
        const s = store({
            clipboardParse: (text, { cell }) =>
                cell.colId === 'name'
                    ? text === 'bad'
                        ? { ok: false, error: 'No.' }
                        : { ok: true, value: text.toLowerCase() }
                    : undefined,
        });
        s.events.on('pasteStarted', () => events.push('start'));
        s.events.on('cellValueChanged', () => events.push('change'));
        s.events.on('pasteEnded', (counts) => events.push(`end ${counts.written}/${counts.rejected}`));
        s.focusCell(at('1', 'name'));
        const result = await s.paste('ECHO\t5\nbad\t7');

        expect(result).toEqual({ written: 3, rejected: 1 });
        expect(dataOf(s, '1')).toMatchObject({ name: 'echo', fee: 5 });
        expect(dataOf(s, '2')).toMatchObject({ name: 'alpha', fee: 7 });
        expect(s.cellError(at('2', 'name'))).toBe('No.');
        expect(events).toEqual(['start', 'change', 'change', 'change', 'end 3/1']);
    });

    it('an empty clipboard pastes nothing', async () => {
        const s = store();
        s.focusCell(at('1', 'name'));

        expect(await s.paste('')).toEqual({ written: 0, rejected: 0 });
        expect(dataOf(s, '1').name).toBe('Bravo');
    });

    it('rolls back cells the server rejects', async () => {
        const persist = vi.fn(async () => ({ rejected: [{ cell: at('2', 'name'), error: 'Name taken' }] }));
        const s = store({ persist });
        s.focusCell(at('1', 'name'));
        await s.paste('Echo\nFoxtrot');

        expect(persist).toHaveBeenCalledWith({
            source: 'paste',
            writes: [
                expect.objectContaining({ cell: at('1', 'name'), text: 'Echo', value: 'Echo', oldValue: 'Bravo' }),
                expect.objectContaining({
                    cell: at('2', 'name'),
                    text: 'Foxtrot',
                    value: 'Foxtrot',
                    oldValue: 'alpha',
                }),
            ],
        });
        expect(dataOf(s, '1').name).toBe('Echo');
        expect(dataOf(s, '2').name).toBe('alpha');
        expect(s.cellError(at('2', 'name'))).toBe('Name taken');
    });

    it('clears writable cells and skips read-only ones', async () => {
        const s = store();
        s.pointerDownCell(at('1', 'id'), { shift: false, toggle: false });
        s.dragOverCell(at('1', 'fee'));
        s.pointerUp();
        await s.clear();

        expect(dataOf(s, '1')).toEqual({ id: 1, name: '', fee: null });
    });

    it('extends the range without writes when the application owns fill persistence', async () => {
        const s = store({ fillMode: 'range' });
        const changes = vi.fn();
        s.events.on('cellValueChanged', changes);
        s.pointerDownCell(at('1', 'fee'), { shift: false, toggle: false });
        s.dragOverCell(at('2', 'fee'));
        s.pointerUp();
        s.startFill();
        s.dragOverCell(at('4', 'fee'));
        s.pointerUp();
        await Promise.resolve();

        expect(s.projection.displayedRows.map((row) => (row as { data: Item }).data.fee)).toEqual([30, 10, null, 20]);
        expect(s.resolvedRanges[0]).toMatchObject({ startIndex: 0, endIndex: 3 });
        expect(changes).not.toHaveBeenCalled();
    });

    it('continues range fill across callback definitions with the same row and column state', () => {
        const s = store({ fillMode: 'range' });
        s.setRanges([{ anchor: at('1', 'fee'), end: at('2', 'fee') }]);
        s.startFill();
        s.setOptions({ ...s.options, columns: columns.map((column) => ({ ...column })) });
        expect(s.isDragging).toBe(true);
        s.dragOverCell(at('4', 'fee'));
        s.pointerUp();
        expect(s.resolvedRanges[0]).toMatchObject({ startIndex: 0, endIndex: 3 });
        expect(dataOf(s, '4').fee).toBe(20);
    });

    it('cancels range fill when its column disappears or data refreshes', () => {
        for (const change of ['column', 'data']) {
            const s = store({ fillMode: 'range' });
            s.setRanges([{ anchor: at('1', 'fee'), end: at('2', 'fee') }]);
            s.startFill();
            s.setOptions(
                change === 'column'
                    ? { ...s.options, columns: columns.filter((column) => 'field' in column && column.field !== 'fee') }
                    : { ...s.options, rows: [...s.options.rows] }
            );
            expect(s.isDragging).toBe(false);
            expect(dataOf(s, '4').fee).toBe(20);
        }
    });

    it('fills rows by repeating the source', async () => {
        const s = store();
        s.pointerDownCell(at('1', 'fee'), { shift: false, toggle: false });
        s.dragOverCell(at('2', 'fee'));
        s.pointerUp();
        s.startFill();
        s.dragOverCell(at('4', 'fee'));
        expect(s.fillTarget).toMatchObject({ startIndex: 0, endIndex: 3 });
        s.pointerUp();
        await Promise.resolve();

        expect(s.projection.displayedRows.map((row) => (row as { data: Item }).data.fee)).toEqual([30, 10, 30, 10]);
        expect(s.resolvedRanges[0]).toMatchObject({ startIndex: 0, endIndex: 3 });
    });
});

describe('GridStore editing', () => {
    it('Enter commits and moves down; Tab commits and starts editing the next editable cell', async () => {
        const s = store();
        await s.startEditing(at('1', 'name'));
        s.editing.setDraft('Renamed');
        await s.stopEditing(true, 'enter', 'down');
        expect(dataOf(s, '1').name).toBe('Renamed');
        expect(s.focusedCell).toEqual(at('2', 'name'));
        expect(s.editSession).toBeNull();

        await s.startEditing(at('2', 'name'));
        await s.stopEditing(true, 'tab', 'next');
        expect(s.editSession?.cell).toEqual(at('2', 'fee'));
    });

    it('a rejected commit keeps the editor open and focus in place', async () => {
        const editor: CellEditorComponent<Item> = Object.assign(() => null, {
            parse: (draft: unknown) =>
                draft === '' ? { ok: false as const, error: 'Required' } : { ok: true as const, value: draft },
        });
        const s = store({ columns: [{ field: 'name', editable: true, cellEditor: editor }, { field: 'fee' }] });
        await s.startEditing(at('1', 'name'));
        s.editing.setDraft('');

        expect(await s.stopEditing(true, 'enter', 'down')).toBe(false);
        expect(s.focusedCell).toEqual(at('1', 'name'));
        expect(s.editSession?.error).toBe('Required');
    });

    it('does not start on read-only cells', async () => {
        const s = store();

        expect(await s.startEditing(at('1', 'id'))).toBe(false);
    });
});

describe('GridStore menus and overlays', () => {
    it('opens the default clipboard menu on a cell and focuses it', () => {
        const s = store();
        const opened = s.openMenu(
            'context',
            { rowId: '2', colId: 'name' },
            { top: 0, left: 0, width: 0, height: 0, visible: true },
            api
        );

        expect(opened).toBe(true);
        expect(s.focusedCell).toEqual(at('2', 'name'));
        expect(s.menu!.items.map((item) => item.id)).toEqual(['copy', 'copyWithHeaders', 'paste']);
    });

    it('passes the clicked row, column and selection to custom items, and opens nothing without items', () => {
        const getContextMenuItems = vi.fn(() => [{ id: 'open', label: 'Open' }]);
        const s = store({ rowSelection: 'multiple', getContextMenuItems });
        s.setSelected(['2'], true);
        s.openMenu(
            'context',
            { rowId: '2', colId: 'name' },
            { top: 0, left: 0, width: 0, height: 0, visible: true },
            api
        );

        expect(getContextMenuItems).toHaveBeenCalledWith(
            expect.objectContaining({ withinSelection: true, row: expect.objectContaining({ id: '2' }) })
        );
        // Without header items the default header menu offers sorting (the column has no filter kind).
        expect(
            s.openMenu(
                'header',
                { rowId: null, colId: 'name' },
                { top: 0, left: 0, width: 0, height: 0, visible: true },
                api
            )
        ).toBe(true);
        expect(
            s.menu?.items.map((item) => (item.type === 'item' ? `${item.id}${item.disabled ? ':off' : ''}` : '|'))
        ).toEqual(['sortAscending', 'sortDescending', 'clearSort:off']);
        s.closeMenu();
        const empty = store({ getHeaderMenuItems: () => [] });
        expect(
            empty.openMenu(
                'header',
                { rowId: null, colId: 'name' },
                { top: 0, left: 0, width: 0, height: 0, visible: true },
                api
            )
        ).toBe(false);
    });

    it('shows the empty overlay without rows and honours a forced overlay', () => {
        const s = store({ rows: [] });
        expect(s.overlay).toEqual({ kind: 'empty', reason: 'noResults' });
        s.setOverlay('loading');
        expect(s.overlay).toEqual({ kind: 'loading' });
    });
});

describe('GridStore row model', () => {
    it('owns the query: filter model and search filter local rows and emit events', () => {
        const s = store();
        const events: string[] = [];
        s.events.on('filterChanged', () => events.push('filter'));
        s.events.on('queryChanged', (event) => events.push(`query:${event.source}`));
        s.setFilterModel({ fee: { filterType: 'number', type: 'greaterThan', filter: 15 } });

        expect(order(s)).toEqual(['1', '4']);
        expect(events).toEqual(['filter', 'query:api']);
        s.setSearch('delta');
        expect(order(s)).toEqual(['4']);
        expect(s.query).toMatchObject({ search: 'delta', filterModel: { fee: { filter: 15 } } });
        s.setFilterModel({ fee: { filterType: 'number', type: 'greaterThan', filter: 15 } });
        expect(events).toHaveLength(3);
    });

    it('applies transactions and recovers focus when the focused row is removed', () => {
        const s = store();
        s.focusCell(at('2', 'name'));
        s.applyTransaction({ remove: ['2'], add: { rows: [{ id: 9, name: 'Echo', fee: 1 }] } });

        expect(order(s)).toEqual(['1', '3', '4', '9']);
        expect(s.focusedCell).toEqual(at('3', 'name'));
    });

    it('keeps an open edit and its draft when the parent replaces the rows (form values)', () => {
        const s = store();
        s.startEditing(at('2', 'name'));
        s.editing.setDraft('Typing');
        s.setOptions({ ...s.options, rows: items().map((item) => (item.id === 4 ? { ...item, fee: 99 } : item)) });

        expect(s.editSession).toMatchObject({ draft: 'Typing', cell: at('2', 'name') });
        expect(dataOf(s, '4').fee).toBe(99);
    });

    it('reports unknown filter kinds once, through onUnresolvedKey', () => {
        const misses: string[] = [];
        const s = store({ onUnresolvedKey: (miss) => misses.push(`${miss.kind}:${miss.key}`) });
        s.setFilterModel({ name: { filterType: 'mystery' } });
        s.setSearch('a');

        expect(misses).toEqual(['filters:mystery']);
    });

    it('uses registered filter kinds', () => {
        const s = store({
            registry: {
                filters: { odd: { isValid: () => true, matches: (_condition, value) => Number(value) % 2 === 1 } },
            },
        });
        s.setFilterModel({ id: { filterType: 'odd' } });

        expect(order(s)).toEqual(['1', '3']);
    });
});

describe('GridStore row drag', () => {
    it('drags one row, or the whole selection in display order, and reports the drop', () => {
        const s = store({ rowSelection: 'multiple' });
        const drops: unknown[] = [];
        s.events.on('rowDragEnded', (event) => drops.push(event));

        expect(s.startRowDrag('3')).toEqual(['3']);
        s.rowDragOver('1', 'before');
        s.endRowDrag(true);
        s.setSelected(['4', '2'], true);
        expect(s.startRowDrag('4')).toEqual(['2', '4']);
        s.rowDragOver('1', 'after');
        s.endRowDrag(true);

        expect(drops).toEqual([
            { rowIds: ['3'], overRowId: '1', position: 'before', targetIndex: 0 },
            { rowIds: ['2', '4'], overRowId: '1', position: 'after', targetIndex: 1 },
        ]);
    });

    it('a dragged row is no drop target, and a cancelled drag reports nothing', () => {
        const s = store();
        const drops = vi.fn();
        s.events.on('rowDragEnded', drops);
        s.startRowDrag('2');
        s.rowDragOver('2', 'after');
        expect(s.rowDrag?.over).toBeNull();
        s.endRowDrag(true);
        s.startRowDrag('2');
        s.rowDragOver('3', 'after');
        s.endRowDrag(false);

        expect(drops).not.toHaveBeenCalled();
        expect(s.rowDrag).toBeNull();
    });
});

describe('GridStore quick filter cache', () => {
    it('sees values changed by an edit or a paste on the next quick filter', async () => {
        const s = store();
        s.setOptions({ ...s.options, quickFilter: 'bra' });
        expect(order(s)).toEqual(['1']);
        s.setOptions({ ...s.options, quickFilter: '' });
        s.startEditing(at('2', 'name'));
        s.editing.setDraft('Bramble');
        s.stopEditing(true, 'enter');
        s.focusCell(at('3', 'name'));
        await s.paste('Brazil');
        s.setOptions({ ...s.options, quickFilter: 'bra' });

        expect(order(s)).toEqual(['1', '2', '3']);
    });
});

describe('GridStore row grouping', () => {
    it('groups and ungroups through setRowGroupColumns, with a column state event', () => {
        const s = store();
        const kinds = vi.fn();
        s.events.on('columnStateChanged', (event) => kinds(event.kind));
        s.setRowGroupColumns(['name']);

        expect(s.rowModel.getRowAtIndex(0)?.row.kind).toBe('group');
        expect(kinds).toHaveBeenCalledWith('rowGroup');
        s.setRowGroupColumns([]);
        expect(s.rowModel.getRowAtIndex(0)?.row.kind).toBe('data');
    });
});

describe('GridStore group column', () => {
    type Task = { id: number; team: string; path: string[] };
    const rows: Task[] = [
        { id: 1, team: 'red', path: ['Plan'] },
        { id: 2, team: 'red', path: ['Plan', 'Book'] },
        { id: 3, team: 'blue', path: ['Ship'] },
    ];
    const make = (extra: Partial<ConstructorParameters<typeof GridStore<Task>>[0]> = {}) =>
        new GridStore<Task>({
            columns: [{ field: 'id' }, { field: 'team' }],
            rows,
            getRowId: (row) => String(row.id),
            ...extra,
        });
    const colIds = (store: GridStore<Task>) => store.columns.getDisplayedLeaves().map((leaf) => leaf.colId);

    it('appears first while rows are grouped and goes away when they are not', () => {
        const store = make();
        expect(store.groupColumnId).toBeNull();
        store.setRowGroupColumns(['team']);

        expect(colIds(store)).toEqual(['__group__', 'id', 'team']);
        expect(store.groupColumnId).toBe('__group__');
        expect(store.isFullWidth(store.rowModel.getRowAtIndex(0)!.row)).toBe(false);
        store.setRowGroupColumns([]);
        expect(colIds(store)).toEqual(['id', 'team']);
    });

    it('shows for tree data from the start, with overrides, and keeps state applied to it', () => {
        const store = make({
            getDataPath: (row) => row.path,
            groupColumn: { colId: 'task', headerName: 'Task', pinned: 'left' },
        });
        store.applyColumnState([{ colId: 'task', width: 333 }]);

        expect(colIds(store)).toEqual(['task', 'id', 'team']);
        expect(store.columns.getColumnState().find((state) => state.colId === 'task')).toMatchObject({
            width: 333,
            pinned: 'left',
        });
        expect(store.columns.getResolved('task')?.def.headerName).toBe('Task');
    });

    it('is not generated for full-width group rows, which span the grid', () => {
        const store = make({ groupDisplay: 'fullWidthRow' });
        store.setRowGroupColumns(['team']);

        expect(colIds(store)).toEqual(['id', 'team']);
        expect(store.isFullWidth(store.rowModel.getRowAtIndex(0)!.row)).toBe(true);
    });

    it('joins columns pinned left, so the hierarchy still reads first', () => {
        const store = new GridStore<Task>({
            columns: [{ field: 'id', pinned: 'left' }, { field: 'team' }],
            rows,
            getRowId: (row) => String(row.id),
        });
        store.setRowGroupColumns(['team']);

        expect(colIds(store)).toEqual(['__group__', 'id', 'team']);
    });
});

describe('GridStore header menu and filter panel', () => {
    type Deal = { id: number; city: string | null; fee: number };
    const rows: Deal[] = [
        { id: 1, city: 'Paris', fee: 10 },
        { id: 2, city: null, fee: 20 },
        { id: 3, city: 'Amsterdam', fee: 30 },
        { id: 4, city: 'Paris', fee: 40 },
    ];
    const make = () =>
        new GridStore<Deal>({
            columns: [
                { field: 'id', sortable: false },
                { field: 'city', filter: 'set' },
                { field: 'fee', filter: true },
                { field: 'x' as never, filter: 'coordinates' },
            ],
            rows,
            getRowId: (row) => String(row.id),
        });
    const anchor = { top: 0, left: 0, width: 0, height: 0, visible: true };
    const items = (s: GridStore<Deal>, colId: string) => {
        s.openMenu('header', { rowId: null, colId }, anchor, {} as never);

        return (
            s.menu?.items.map((item) =>
                item.type === 'item' ? `${item.id}${item.disabled ? ':off' : ''}${item.checked ? ':on' : ''}` : '|'
            ) ?? []
        );
    };

    it('offers sort and filter items that apply to the column, marking the current sort', () => {
        const s = make();
        s.setSortModel([{ colId: 'city', sort: 'desc' }]);
        s.setFilterModel({ city: { filterType: 'set', values: ['Paris'] } });

        expect(items(s, 'city')).toEqual([
            'sortAscending',
            'sortDescending:on',
            'clearSort',
            '|',
            'filter',
            'clearFilter',
        ]);
        // Neither sortable nor filterable: no header menu at all.
        expect(items(s, 'id')).toEqual([]);
        expect(items(s, 'fee')).toEqual([
            'sortAscending',
            'sortDescending',
            'clearSort:off',
            '|',
            'filter',
            'clearFilter:off',
        ]);
    });

    it('knows which columns the panel can filter, opens and closes it, and lists local values', () => {
        const s = make();

        expect([s.filterKindOf('city'), s.filterKindOf('fee'), s.filterKindOf('x'), s.filterKindOf('id')]).toEqual([
            'set',
            'text',
            null,
            null,
        ]);
        s.openFilterPanel('x', anchor);
        expect(s.filterPanel).toBeNull();
        s.openFilterPanel('city', anchor);
        expect(s.filterPanel?.colId).toBe('city');
        s.closeFilterPanel();
        expect(s.filterPanel).toBeNull();
        expect(s.distinctValues('city')).toEqual([
            { value: null, label: '(Blank)' },
            { value: 'Amsterdam', label: 'Amsterdam' },
            { value: 'Paris', label: 'Paris' },
        ]);
    });
});

describe('GridStore persisted writes', () => {
    /** A persist the test settles by hand. */
    function deferredPersist() {
        const calls: {
            batch: {
                source: string;
                writes: { cell: { rowId: string; colId: string }; value: unknown; derived?: string }[];
            };
            resolve: (result?: unknown) => void;
            reject: (error: unknown) => void;
        }[] = [];
        const persist = vi.fn(
            (batch: never) =>
                new Promise((resolve, reject) => {
                    calls.push({ batch, resolve, reject });
                })
        );

        return { persist, calls };
    }
    const edit = (s: GridStore<Item>, rowId: string, colId: string, value: unknown) => {
        s.startEditing(at(rowId, colId));
        s.editing.setDraft(value);
        s.stopEditing(true, 'api');
    };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('persists an edit, shows it pending, and keeps it when the server accepts', async () => {
        const { persist, calls } = deferredPersist();
        const s = store({ persist: persist as never });
        const settled = vi.fn();
        s.events.on('writesSettled', settled);
        edit(s, '1', 'name', 'Zulu');

        expect(dataOf(s, '1').name).toBe('Zulu');
        expect(calls[0]!.batch).toMatchObject({
            source: 'edit',
            writes: [{ cell: at('1', 'name'), value: 'Zulu', oldValue: 'Bravo' }],
        });
        expect(s.isCellPending(at('1', 'name'))).toBe(true);
        calls[0]!.resolve();
        await flush();
        expect(s.isCellPending(at('1', 'name'))).toBe(false);
        expect(dataOf(s, '1').name).toBe('Zulu');
        expect(settled).toHaveBeenCalledWith({ source: 'edit', written: 1, rejected: [], reconciledRowIds: [] });
    });

    it('rolls a rejected edit back and shows the error; a thrown error rejects the batch', async () => {
        const { persist, calls } = deferredPersist();
        const s = store({ persist: persist as never });
        edit(s, '1', 'name', 'Zulu');
        calls[0]!.resolve({ rejected: [{ cell: at('1', 'name'), error: 'Name taken' }] });
        await flush();

        expect(dataOf(s, '1').name).toBe('Bravo');
        expect(s.cellError(at('1', 'name'))).toBe('Name taken');
        edit(s, '2', 'fee', 99);
        calls[1]!.reject(new Error('Network down'));
        await flush();
        expect(dataOf(s, '2').fee).toBe(10);
        expect(s.cellError(at('2', 'fee'))).toBe('Network down');
    });

    it('overlapping edits: a newer failure falls back to the older value, an older failure leaves the newer one', async () => {
        const { persist, calls } = deferredPersist();
        const s = store({ persist: persist as never });
        edit(s, '1', 'name', 'One');
        edit(s, '1', 'name', 'Two');
        calls[1]!.resolve({ rejected: [{ cell: at('1', 'name'), error: 'No' }] });
        await flush();
        expect(dataOf(s, '1').name).toBe('One');
        calls[0]!.resolve();
        await flush();
        expect(dataOf(s, '1').name).toBe('One');

        edit(s, '2', 'name', 'A');
        edit(s, '2', 'name', 'B');
        calls[2]!.resolve({ rejected: [{ cell: at('2', 'name'), error: 'No' }] });
        await flush();
        expect(dataOf(s, '2').name).toBe('B');
    });

    it('replaces rows with server rows, unless a newer write to the row is pending', async () => {
        const { persist, calls } = deferredPersist();
        const s = store({ persist: persist as never });
        edit(s, '1', 'name', 'Zulu');
        edit(s, '1', 'fee', 31);
        calls[0]!.resolve({ rows: [{ id: 1, name: 'ZULU', fee: 0 }] });
        await flush();
        expect(dataOf(s, '1')).toMatchObject({ name: 'Zulu', fee: 31 });
        calls[1]!.resolve({
            rows: [
                { id: 1, name: 'ZULU', fee: 31 },
                { id: 4, name: 'Sibling', fee: 20 },
            ],
        });
        await flush();

        expect(dataOf(s, '1')).toMatchObject({ name: 'ZULU', fee: 31 });
        expect(dataOf(s, '4').name).toBe('Sibling');
    });

    it('a range edit writes the value to the other rows of the range in that column', async () => {
        const { persist, calls } = deferredPersist();
        const s = store({ persist: persist as never, rangeEdit: true });
        s.setRanges([{ anchor: at('1', 'fee'), end: at('3', 'fee') }]);
        edit(s, '2', 'fee', 7);

        expect([dataOf(s, '1').fee, dataOf(s, '2').fee, dataOf(s, '3').fee, dataOf(s, '4').fee]).toEqual([7, 7, 7, 20]);
        expect(calls[0]!.batch.writes.map((write) => `${write.cell.rowId}:${write.derived ?? 'edit'}`)).toEqual([
            '2:edit',
            '1:range',
            '3:range',
        ]);
    });

    it('propagates an edit to sibling rows and persists them in the same batch', () => {
        const { persist, calls } = deferredPersist();
        const s = store({
            persist: persist as never,
            propagateWrite: (write, { forEachRow }) => {
                const siblings: { cell: { rowId: string; colId: string }; value: unknown }[] = [];
                forEachRow((row) => {
                    if (row.id !== write.cell.rowId && row.data.fee === 20) {
                        siblings.push({ cell: { rowId: row.id, colId: 'name' }, value: write.newValue });
                    }
                });

                return siblings;
            },
        });
        edit(s, '1', 'name', 'Shared');

        expect(dataOf(s, '4').name).toBe('Shared');
        expect(calls[0]!.batch.writes.map((write) => `${write.cell.rowId}:${write.derived ?? 'edit'}`)).toEqual([
            '1:edit',
            '4:sibling',
        ]);
    });

    it('canWrite also decides whether a cell can be edited (locked rows)', () => {
        const s = store({ canWrite: (cell) => cell.rowId !== '2' });

        expect(s.editing.canEdit(at('1', 'name'))).toBe(true);
        expect(s.editing.canEdit(at('2', 'name'))).toBe(false);
    });

    it('writes cells in bulk from code as one batch', async () => {
        const { persist, calls } = deferredPersist();
        const s = store({ persist: persist as never });
        const done = s.writeCells([
            { cell: at('1', 'fee'), value: 1 },
            { cell: at('2', 'fee'), value: 2 },
            { cell: at('3', 'id'), value: 9 },
        ]);
        expect(calls[0]!.batch.source).toBe('api');
        expect(calls[0]!.batch.writes).toHaveLength(2);
        calls[0]!.resolve({ rejected: [{ cell: at('2', 'fee'), error: 'Locked' }] });

        expect(await done).toEqual({ written: 2, rejected: 1 });
        expect([dataOf(s, '1').fee, dataOf(s, '2').fee]).toEqual([1, 10]);
    });
});

describe('GridStore server rows', () => {
    it('does not refetch when a column is shown or hidden under a filter', async () => {
        const getRows = vi.fn(async () => ({ rows: items(), rowCount: 4 }));
        const s = new GridStore<Item>({
            rows: [],
            serverSource: { type: 'server', blockSize: 100, getRows, getRowId: (data) => String(data.id) },
            columns,
            interaction: 'cell',
        });
        s.setFilterModel({ name: { filterType: 'text', type: 'contains', filter: 'a' } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const calls = getRows.mock.calls.length;
        expect(calls).toBeGreaterThan(0);

        s.setColumnsVisible(['fee'], false);
        s.setColumnsVisible(['fee'], true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getRows).toHaveBeenCalledTimes(calls);
    });
});

describe('GridStore server master/detail', () => {
    it('forwards updated server tree and master options', async () => {
        type Event = { id: number; name: string };
        const source = {
            type: 'server' as const,
            getRows: vi.fn().mockResolvedValue({ rows: [{ id: 1, name: 'Changed' }], rowCount: 1 }),
            getRowId: (data: Event) => String(data.id),
        };
        const options = {
            rows: [] as Event[],
            columns: [{ field: 'name' }],
            serverSource: source,
            groupDisplay: 'custom' as const,
        };
        const store = new GridStore<Event>(options);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.rowModel.getRow('1')).not.toHaveProperty('expandable');
        store.setOptions({ ...options, isMaster: () => true });
        expect(store.rowModel.getRow('1')).toMatchObject({ expandable: { expanded: false } });
        store.setExpanded('1', true);
        expect(store.rowModel.getRow('detail:1')).toBeDefined();
        store.setOptions({ ...options, serverSource: { ...source, getTreeKey: () => 'transaction' } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.rowModel.getRow('1')).toMatchObject({ expandable: { expanded: false } });
        expect(store.rowModel.getRow('detail:1')).toBeUndefined();
        store.setOptions(options);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.rowModel.getRow('1')).not.toHaveProperty('expandable');
        store.destroy();
    });

    it('forwards master eligibility and keeps details local', async () => {
        const getRows = vi.fn().mockResolvedValue({ rows: [{ id: 1, name: 'Changed' }], rowCount: 1 });
        const store = new GridStore({
            rows: [],
            columns: [{ field: 'name' }],
            serverSource: {
                type: 'server',
                getRows,
                getRowId: (data: { id: number; name: string }) => String(data.id),
            },
            isMaster: () => true,
            groupDisplay: 'custom',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.rowModel.getRow('1')).toMatchObject({ expandable: { expanded: false } });
        store.setExpanded('1', true);
        expect(store.rowModel.getRowAtIndex(1)?.row).toMatchObject({ kind: 'detail', masterId: '1' });
        expect(store.isFullWidth(store.rowModel.getRow('detail:1')!)).toBe(true);
        store.rowModel.ensureRange(0, 1);
        expect(getRows).toHaveBeenCalledTimes(1);
        store.destroy();
    });
});

describe('GridStore server selection', () => {
    it('never reports a loading row as selected when every row is selected', async () => {
        let release: (() => void) | undefined;
        const getRows = vi.fn(
            () =>
                new Promise<{ rows: Item[]; rowCount: number }>((resolve) => {
                    release = () => resolve({ rows: items(), rowCount: 4 });
                })
        );
        const s = new GridStore<Item>({
            rows: [],
            serverSource: { type: 'server', blockSize: 100, getRows, getRowId: (data) => String(data.id) },
            columns,
            interaction: 'row',
            rowSelection: 'multiple',
        });
        release!();
        await new Promise((resolve) => setTimeout(resolve, 0));
        s.selectAllRows();
        expect(s.isRowSelected('1')).toBe(true);

        s.refresh({ purge: true });
        const loading = s.rowModel.getRowAtIndex(0)!.row;

        expect(loading.kind).toBe('loading');
        expect(s.isRowSelected(loading.id)).toBe(false);
    });
});

describe('GridStore controlled active row', () => {
    it('reports a clicked row but keeps the active row the application passes', () => {
        const s = store({ interaction: 'row', rowSelection: 'multiple', activeRowControlled: true });
        const reported: (string | null)[] = [];
        s.events.on('activeRowChanged', (event) => reported.push(event.rowId));

        s.clickRow('2', { toggle: false, range: false });

        expect(reported).toEqual(['2']);
        expect(s.activeRowId).toBeNull();
        expect(s.isRowSelected('2')).toBe(true);

        s.setActiveRow('2', 'state');
        expect(s.activeRowId).toBe('2');
    });
});
