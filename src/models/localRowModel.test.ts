import { describe, expect, it, vi } from 'vitest';

import type { ColumnDefinition, QueryState } from '../contract';
import { ColumnModel } from '../grid/columns';
import { LocalRowModel, type LocalRowModelOptions } from './localRowModel';

type Item = { id: number; name: string; fee: number | null; team: string };

const items = (): Item[] => [
    { id: 1, name: 'Bravo', fee: 30, team: 'red' },
    { id: 2, name: 'alpha', fee: 10, team: 'blue' },
    { id: 3, name: 'Charlie', fee: null, team: 'red' },
    { id: 4, name: 'delta', fee: 20, team: 'blue' },
];

const definitions: ColumnDefinition<Item>[] = [{ field: 'id' }, { field: 'name' }, { field: 'fee' }, { field: 'team' }];

function setup(options: Partial<LocalRowModelOptions<Item>> = {}) {
    const columns = new ColumnModel<Item>(definitions);
    const onChange = vi.fn();
    const model = new LocalRowModel<Item>(
        { rows: items(), ...options },
        {
            getResolved: (colId) => columns.getResolved(colId),
            displayedColIds: () => columns.getDisplayedLeaves().map((leaf) => leaf.colId),
        },
        onChange
    );

    return { model, columns, onChange };
}

const query = (partial: Partial<QueryState>): QueryState => ({
    sortModel: [],
    filterModel: {},
    search: '',
    externalFilters: {},
    rowGroupColIds: [],
    ...partial,
});
const ids = (model: LocalRowModel<Item>) => {
    const result: string[] = [];
    model.forEachRow((row) => result.push(row.id));

    return result;
};

describe('LocalRowModel query', () => {
    it('sorts with empty values last in both directions, stable for ties', () => {
        const { model } = setup();
        model.setQuery(query({ sortModel: [{ colId: 'fee', sort: 'asc' }] }));
        expect(ids(model)).toEqual(['2', '4', '1', '3']);
        model.setQuery(query({ sortModel: [{ colId: 'fee', sort: 'desc' }] }));
        expect(ids(model)).toEqual(['1', '4', '2', '3']);
        model.setQuery(query({ sortModel: [{ colId: 'team', sort: 'asc' }] }));
        expect(ids(model)).toEqual(['2', '4', '1', '3']);
    });

    it('filters with the filter model, and reports filtered state and status', () => {
        const { model } = setup();
        model.setQuery(query({ filterModel: { fee: { filterType: 'number', type: 'greaterThan', filter: 15 } } }));
        expect(ids(model)).toEqual(['1', '4']);
        expect(model.isFiltered).toBe(true);
        model.setQuery(query({ filterModel: { fee: { filterType: 'number', type: 'greaterThan', filter: 99 } } }));
        expect(model.status).toEqual({ state: 'empty', reason: 'noResults' });
    });

    it('quick filter and search: every word must appear in a displayed column', () => {
        const { model, columns } = setup({ quickFilter: 'red ch' });
        expect(ids(model)).toEqual(['3']);
        model.setOptions({ rows: model.rows, quickFilter: '' });
        model.setQuery(query({ search: 'blue' }));
        expect(ids(model)).toEqual(['2', '4']);
        // Hidden columns are not searched.
        columns.setColumnsVisible(['team'], false);
        model.refresh();
        expect(ids(model)).toEqual([]);
    });

    it('does not rebuild for an unchanged query', () => {
        const { model, onChange } = setup();
        model.setQuery(query({ sortModel: [{ colId: 'name', sort: 'asc' }] }));
        model.setQuery(query({ sortModel: [{ colId: 'name', sort: 'asc' }] }));

        expect(onChange).toHaveBeenCalledTimes(1);
    });
});

describe('LocalRowModel data', () => {
    it('applies transactions by id: add at an index, update, remove', () => {
        const { model, onChange } = setup();
        model.applyTransaction({
            add: { rows: [{ id: 9, name: 'Echo', fee: 5, team: 'red' }], index: 1 },
            update: [{ id: 2, name: 'ALPHA', fee: 11, team: 'blue' }],
            remove: ['3'],
        });

        expect(ids(model)).toEqual(['1', '9', '2', '4']);
        expect((model.getRow('2') as { data: Item }).data.name).toBe('ALPHA');
        expect(onChange).toHaveBeenLastCalledWith('transaction');
    });

    it('a new rows array replaces transaction changes (the parent owns the data)', () => {
        const { model } = setup();
        model.applyTransaction({ remove: ['1'] });
        model.setOptions({ rows: items() });

        expect(ids(model)).toEqual(['1', '2', '3', '4']);
    });

    it('patches rows by id and reuses unchanged row objects', () => {
        const { model } = setup();
        const before = model.getRow('1');
        model.patchRows([{ id: '2', data: { id: 2, name: 'patched', fee: 1, team: 'blue' } }]);

        expect((model.getRow('2') as { data: Item }).data.name).toBe('patched');
        expect(model.getRow('1')).toBe(before);
    });

    it('keeps a custom order after sorting (sortRows), with the same rows', () => {
        const { model } = setup({
            sortRows: (rows) => [...rows].sort((a, b) => (a.team === b.team ? 0 : a.team === 'red' ? -1 : 1)),
        });
        model.setQuery(query({ sortModel: [{ colId: 'name', sort: 'asc' }] }));

        expect(ids(model)).toEqual(['1', '3', '2', '4']);
    });

    it('groups by rowGroup columns from the column state, with expansion', () => {
        const { model, columns } = setup({ expandedByDefault: true });
        columns.setRowGroupColumns(['team']);
        model.setColumnState(columns.getColumnState());
        const kinds = () => {
            const result: string[] = [];
            model.forEachRow((row) => result.push(row.kind === 'group' ? `group:${row.key}` : row.id));

            return result;
        };
        expect(kinds()).toEqual(['group:red', '1', '3', 'group:blue', '2', '4']);
        const red = model.getRowAtIndex(0)!.row;
        model.setExpanded(red.id, false);
        expect(kinds()).toEqual(['group:red', 'group:blue', '2', '4']);
    });

    it('visits rows the filter hides when asked, with index undefined', () => {
        const { model } = setup();
        model.setQuery(query({ filterModel: { team: { filterType: 'text', type: 'equals', filter: 'red' } } }));
        const visited: [string, number | undefined][] = [];
        model.forEachRow((row, index) => visited.push([row.id, index]), { includeFiltered: true });

        expect(visited).toEqual([
            ['1', 0],
            ['3', 1],
            ['2', undefined],
            ['4', undefined],
        ]);
    });

    it('holds pinned rows outside the displayed index', () => {
        const { model } = setup();
        model.setPinnedRows('bottom', [{ id: 100, name: 'Total', fee: 60, team: '' }]);

        expect(model.getPinnedRows('bottom').map((row) => row.id)).toEqual(['pinned:bottom:100']);
        expect(model.getRowCount()).toBe(4);
        expect(model.getRow('pinned:bottom:100')).toBeDefined();
    });

    it('builds a fresh row source after each change', () => {
        const { model } = setup();
        const first = model.rowSource;
        expect(model.rowSource).toBe(first);
        model.applyTransaction({ remove: ['1'] });

        expect(model.rowSource).not.toBe(first);
        expect(model.rowSource.count).toBe(3);
    });
});
