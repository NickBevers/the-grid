import { describe, expect, it } from 'vitest';

import type { ColumnDefinition, DataRow } from '../contract';
import { ColumnModel, defaultComparator, defaultFormat, readField } from './columns';

type Person = { id: number; name: string; location?: { city?: { name: string } }; fee?: number };

const definitions = (): ColumnDefinition<Person>[] => [
    { field: 'id', pinned: 'left', width: 80, lockPosition: 'left' },
    { field: 'name', width: 200 },
    {
        groupId: 'details',
        headerName: 'Details',
        children: [
            { field: 'location.city.name', colId: 'city' },
            { field: 'fee', showWhen: 'open' },
            { colId: 'summary', showWhen: 'closed', valueGetter: ({ data }) => `${data.name} (${data.id})` },
        ],
    },
    { colId: 'actions', pinned: 'right', width: 60 },
];

const row = (data: Person): DataRow<Person> => ({ kind: 'data', id: String(data.id), data }) as DataRow<Person>;
const displayed = (model: ColumnModel<Person>): string[] => model.getDisplayedLeaves().map((leaf) => leaf.colId);

describe('ColumnModel definitions', () => {
    it('flattens nested groups, uses field as colId, and orders sections left, center, right', () => {
        const model = new ColumnModel(definitions());

        expect(displayed(model)).toEqual(['id', 'name', 'city', 'summary', 'actions']);
        expect(model.getLeaf('city')!.groupPath).toEqual(['details']);
        expect(model.getGroupLabel('details')).toBe('Details');
        expect(model.isGroupExpandable('details')).toBe(true);
    });

    it('rejects duplicate ids and columns without an id', () => {
        expect(() => new ColumnModel<Person>([{ field: 'name' }, { field: 'name' }])).toThrow(
            /Duplicate column id "name"/
        );
        expect(() => new ColumnModel<Person>([{ headerName: 'Nothing' }])).toThrow(/colId or a field/);
    });

    it('shows open or closed children by group state', () => {
        const model = new ColumnModel(definitions());
        model.setGroupOpen('details', true);

        expect(displayed(model)).toEqual(['id', 'name', 'city', 'fee', 'actions']);
        expect(model.getColumnGroupState()).toEqual([{ groupId: 'details', open: true }]);
        model.resetColumnGroupState();
        expect(displayed(model)).toContain('summary');
    });

    it('keeps user state across new definitions and slots new columns in at their definition position', () => {
        const model = new ColumnModel(definitions());
        model.setColumnsVisible(['name'], false);
        model.setWidth('city', 300);
        model.setDefinitions([
            ...definitions().slice(0, 1),
            { field: 'email' as keyof Person & string },
            ...definitions().slice(1),
        ]);

        const state = Object.fromEntries(model.getColumnState().map((entry) => [entry.colId, entry]));
        expect(state.name!.hide).toBe(true);
        expect(state.city!.width).toBe(300);
        expect(model.getAllLeaves().map((leaf) => leaf.colId)).toEqual([
            'id',
            'email',
            'name',
            'city',
            'fee',
            'summary',
            'actions',
        ]);
    });
});

describe('ColumnModel state', () => {
    it('exports every column, hidden included, in the stored shape', () => {
        const model = new ColumnModel(definitions());
        const state = model.getColumnState();

        expect(state.map((entry) => entry.colId)).toEqual(['id', 'name', 'city', 'fee', 'summary', 'actions']);
        expect(state[0]).toEqual({
            colId: 'id',
            width: 80,
            hide: false,
            pinned: 'left',
            sort: null,
            sortIndex: null,
            flex: null,
            rowGroup: false,
            rowGroupIndex: null,
            aggFunc: null,
            pivot: false,
            pivotIndex: null,
        });
    });

    it('round trips: export, change everything, apply the export, and get the same state back', () => {
        const model = new ColumnModel(definitions());
        model.setColumnsVisible(['fee'], true);
        model.setWidth('name', 250);
        model.moveColumn('city', 1);
        model.setPinned('name', 'right');
        model.setSortModel([
            { colId: 'name', sort: 'desc' },
            { colId: 'city', sort: 'asc' },
        ]);
        model.setRowGroupColumns(['city']);
        const saved = model.getColumnState();

        model.resetColumnState();
        expect(model.getColumnState()).not.toEqual(saved);
        model.applyColumnState(saved, { applyOrder: true });

        expect(model.getColumnState()).toEqual(saved);
        expect(model.getSortModel()).toEqual([
            { colId: 'name', sort: 'desc' },
            { colId: 'city', sort: 'asc' },
        ]);
        expect(model.getRowGroupColumnIds()).toEqual(['city']);
    });

    it('applyOrder puts mentioned columns first and the rest after, in their current order', () => {
        const model = new ColumnModel(definitions());
        model.applyColumnState([{ colId: 'actions' }, { colId: 'city' }], { applyOrder: true });

        // id is locked to the start, so it stays first.
        expect(model.getAllLeaves().map((leaf) => leaf.colId)).toEqual([
            'id',
            'actions',
            'city',
            'name',
            'fee',
            'summary',
        ]);
    });

    it('fills properties a mentioned entry leaves out from defaultState', () => {
        const model = new ColumnModel(definitions());
        model.setColumnsVisible(['fee'], true);
        model.applyColumnState([{ colId: 'name', width: 210 }], { defaultState: { hide: true } });
        const state = Object.fromEntries(model.getColumnState().map((entry) => [entry.colId, entry]));

        expect(state.name).toMatchObject({ width: 210, hide: true });
        expect(state.fee!.hide).toBe(true);
    });

    it('ignores an applied order that would split a marryChildren group', () => {
        const model = new ColumnModel<Person>([
            { field: 'id' },
            { groupId: 'g', marryChildren: true, children: [{ field: 'name' }, { field: 'fee' }] },
        ]);
        model.applyColumnState([{ colId: 'fee' }, { colId: 'id' }, { colId: 'name' }], { applyOrder: true });

        expect(model.getAllLeaves().map((leaf) => leaf.colId)).toEqual(['id', 'name', 'fee']);
    });

    it('counts a nested group as showing in both states', () => {
        const model = new ColumnModel<Person>([
            {
                groupId: 'outer',
                children: [
                    { groupId: 'inner', children: [{ field: 'id' }] },
                    { field: 'fee', showWhen: 'open' },
                ],
            },
        ]);

        expect(model.isGroupExpandable('outer')).toBe(true);
        expect(displayed(model)).toEqual(['id']);
    });

    it('leaves properties an entry omits alone, and applies defaultState to columns without an entry', () => {
        const model = new ColumnModel(definitions());
        model.setSortModel([
            { colId: 'name', sort: 'asc' },
            { colId: 'city', sort: 'desc' },
        ]);
        model.applyColumnState([{ colId: 'city', sort: 'asc' }], { defaultState: { sort: null } });

        expect(model.getSortModel()).toEqual([{ colId: 'city', sort: 'asc' }]);
        expect(model.getColumnState().find((entry) => entry.colId === 'name')!.width).toBe(200);
    });

    it('keeps state for unknown columns, re-exports it, and applies it when the column appears', () => {
        const model = new ColumnModel(definitions());
        const changed = model.applyColumnState([{ colId: 'later', hide: true, width: 123 }]);

        expect(changed).toBe(true);
        expect(model.getColumnState().at(-1)).toEqual({ colId: 'later', hide: true, width: 123 });
        model.setDefinitions([...definitions(), { colId: 'later' }]);
        const later = model.getColumnState().find((entry) => entry.colId === 'later')!;
        expect(later.hide).toBe(true);
        expect(later.width).toBe(123);
        expect(model.getColumnState().filter((entry) => entry.colId === 'later')).toHaveLength(1);
    });

    it('treats pinned true as left and flex 0 as no flex', () => {
        const model = new ColumnModel(definitions());
        model.applyColumnState([{ colId: 'name', pinned: true as never, flex: 0 }]);
        const name = model.getColumnState().find((entry) => entry.colId === 'name')!;

        expect(name.pinned).toBe('left');
        expect(name.flex).toBeNull();
    });

    it('reports whether anything changed', () => {
        const model = new ColumnModel(definitions());

        expect(model.applyColumnState(model.getColumnState(), { applyOrder: true })).toBe(false);
        expect(model.applyColumnState([{ colId: 'name', hide: true }])).toBe(true);
    });

    it('reports measured widths when given them', () => {
        const model = new ColumnModel<Person>([{ field: 'name', flex: 1 }]);

        expect(model.getColumnState(new Map([['name', 412.5]]))[0]).toMatchObject({ width: 412.5, flex: 1 });
    });
});

describe('ColumnModel edits', () => {
    it('lock flags restrict the UI only: state and api calls still apply', () => {
        const model = new ColumnModel<Person>([
            { field: 'id', lockVisible: true, lockPinned: true },
            { field: 'name' },
        ]);
        model.setColumnsVisible(['id'], false);
        expect(displayed(model)).toEqual(['name']);
        model.applyColumnState([{ colId: 'id', hide: false, pinned: 'right' }]);

        expect(displayed(model)).toEqual(['name', 'id']);
        expect(model.getColumnState().find((entry) => entry.colId === 'id')!.pinned).toBe('right');
    });

    it('places lockPosition columns from the start, and again after a reset', () => {
        const model = new ColumnModel<Person>([
            { field: 'name' },
            { field: 'id', lockPosition: 'left' },
            { field: 'fee' },
        ]);
        expect(model.getAllLeaves().map((leaf) => leaf.colId)).toEqual(['id', 'name', 'fee']);
        model.resetColumnState();

        expect(model.getAllLeaves().map((leaf) => leaf.colId)).toEqual(['id', 'name', 'fee']);
    });

    it('applies open and closed visibility only when the group can show something both ways', () => {
        const model = new ColumnModel<Person>([
            {
                groupId: 'geo',
                children: [
                    { field: 'name', showWhen: 'closed' },
                    { field: 'fee', showWhen: 'open' },
                ],
            },
        ]);
        expect(displayed(model)).toEqual(['name']);
        expect(model.isGroupExpandable('geo')).toBe(true);
        // Hiding the closed-state column leaves a group that cannot toggle: its open-state column shows.
        model.setColumnsVisible(['name'], false);

        expect(model.isGroupExpandable('geo')).toBe(false);
        expect(displayed(model)).toEqual(['fee']);
    });

    it('a resize stops a flex column flexing', () => {
        const model = new ColumnModel<Person>([{ field: 'name', flex: 2 }]);
        expect(model.getColumnSpecs()[0]).toMatchObject({ flex: 2 });
        model.setWidth('name', 180);

        expect(model.getColumnSpecs()[0]).toMatchObject({ width: 180 });
        expect(model.getColumnSpecs()[0]!.flex).toBeUndefined();
    });

    it('does not move locked or unmovable columns, nor anything past a locked one', () => {
        const model = new ColumnModel<Person>([
            { field: 'id', lockPosition: 'left' },
            { field: 'name' },
            { field: 'fee', movable: false },
            { colId: 'actions', lockPosition: 'right' },
        ]);

        expect(model.moveColumn('id', 2)).toBe(false);
        expect(model.moveColumn('fee', 0)).toBe(false);
        expect(model.moveColumn('name', 0)).toBe(false);
        expect(model.moveColumn('name', 10)).toBe(false);
        expect(model.getAllLeaves().map((leaf) => leaf.colId)).toEqual(['id', 'name', 'fee', 'actions']);
        expect(model.moveColumn('name', 2)).toBe(true);
        expect(model.getAllLeaves().map((leaf) => leaf.colId)).toEqual(['id', 'fee', 'name', 'actions']);
    });

    it('keeps married group children together', () => {
        const model = new ColumnModel<Person>([
            { field: 'id' },
            { groupId: 'g', marryChildren: true, children: [{ field: 'name' }, { field: 'fee' }] },
        ]);

        expect(model.moveColumn('id', 1)).toBe(false);
        expect(model.moveColumn('id', 2)).toBe(true);
        expect(model.getAllLeaves().map((leaf) => leaf.colId)).toEqual(['name', 'fee', 'id']);
    });

    it('cycles sort none, asc, desc, none, and multi sort keeps priority', () => {
        const model = new ColumnModel(definitions());

        expect(model.toggleSort('name', false)).toEqual([{ colId: 'name', sort: 'asc' }]);
        expect(model.toggleSort('name', false)).toEqual([{ colId: 'name', sort: 'desc' }]);
        expect(model.toggleSort('name', false)).toEqual([]);
        model.toggleSort('name', false);
        expect(model.toggleSort('city', true)).toEqual([
            { colId: 'name', sort: 'asc' },
            { colId: 'city', sort: 'asc' },
        ]);
        expect(model.toggleSort('name', true)).toEqual([
            { colId: 'name', sort: 'desc' },
            { colId: 'city', sort: 'asc' },
        ]);
        expect(model.toggleSort('city', false)).toEqual([{ colId: 'city', sort: 'desc' }]);
    });

    it('does not sort unsortable columns', () => {
        const model = new ColumnModel<Person>([{ field: 'name', sortable: false }]);

        expect(model.toggleSort('name', false)).toEqual([]);
    });
});

describe('resolved columns', () => {
    const model = new ColumnModel<Person>([
        { field: 'location.city.name', colId: 'city' },
        { field: 'fee', editable: true, valueFormatter: ({ value }) => `£${value}`, cellClass: 'num right' },
        { colId: 'label', valueGetter: ({ data }) => data.name.toUpperCase(), editable: ({ data }) => data.id > 1 },
    ]);
    const ada = row({ id: 1, name: 'Ada', fee: 10 });

    it('reads dotted fields, value getters and formatters', () => {
        expect(
            model.getResolved('city')!.getValue(row({ id: 1, name: 'Ada', location: { city: { name: 'Ghent' } } }))
        ).toBe('Ghent');
        expect(model.getResolved('city')!.getValue(ada)).toBeUndefined();
        expect(model.getResolved('label')!.getValue(ada)).toBe('ADA');
        expect(model.getResolved('fee')!.formatValue(ada, 10)).toBe('£10');
    });

    it('derives header names', () => {
        expect(model.getResolved('city')!.headerName).toBe('Location City Name');
        expect(model.getResolved('label')!.headerName).toBe('label');
    });

    it('resolves editability per row and never for rows without data', () => {
        expect(model.getResolved('fee')!.isEditable(ada)).toBe(true);
        expect(model.getResolved('label')!.isEditable(ada)).toBe(false);
        expect(model.getResolved('label')!.isEditable(row({ id: 2, name: 'Bo' }))).toBe(true);
        expect(model.getResolved('fee')!.isEditable({ kind: 'loading', id: 'loading:0' } as never)).toBe(false);
    });

    it('writes dotted fields and splits class strings', () => {
        const data: Person = { id: 3, name: 'Cy' };
        expect(model.getResolved('city')!.setValue!(row(data), 'Paris')).toBe(true);
        expect(data.location?.city?.name).toBe('Paris');
        expect(model.getResolved('fee')!.cellClasses(ada, 10)).toEqual(['num', 'right']);
    });

    it('formats and compares defaults sensibly', () => {
        expect(defaultFormat(null)).toBe('');
        expect(defaultFormat([{ name: 'A' }, { label: 'B' }])).toBe('A, B');
        expect(['b10', 'b9', null, 'a'].sort(defaultComparator)).toEqual(['a', 'b9', 'b10', null]);
        expect(readField({ a: null }, 'a.b')).toBeUndefined();
    });
});
