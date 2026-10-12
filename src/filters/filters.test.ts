import { describe, expect, it } from 'vitest';

import type {
    ColumnDefinition,
    CustomFilterCondition,
    DataRow,
    FilterCondition,
    FilterKind,
    FilterModel,
} from '../contract';
import { ColumnModel } from '../grid/columns';
import { BUILTIN_FILTER_KINDS, isBlank, toInstant } from './builtinKinds';
import { createFilterPredicate, isConditionActive } from './evaluate';

type Row = { id: number; value: unknown; other?: unknown };

/** Rows whose `value` passes the condition, through the real evaluator and a real column. */
function passes(
    condition: FilterCondition | CustomFilterCondition,
    values: unknown[],
    column: Partial<ColumnDefinition<Row>> = {},
    kinds?: Record<string, FilterKind>
) {
    const model = new ColumnModel<Row>([{ field: 'value', ...column } as ColumnDefinition<Row>]);
    const predicate = createFilterPredicate<Row>({ value: condition } as FilterModel, {
        column: (colId) => model.getResolved(colId),
        ...(kinds ? { kinds } : {}),
    });

    return values.filter((value, id) =>
        predicate ? predicate({ kind: 'data', id: String(id), data: { id, value } } as DataRow<Row>) : true
    );
}

describe('text', () => {
    const values = ['Alpha', 'alphabet', ' beta ', null, '', ['Gamma', 'delta']];

    it('matches case-insensitively and trimmed by default, like the server', () => {
        expect(passes({ filterType: 'text', type: 'contains', filter: 'ALPHA' }, values)).toEqual([
            'Alpha',
            'alphabet',
        ]);
        expect(passes({ filterType: 'text', type: 'equals', filter: 'beta' }, values)).toEqual([' beta ']);
        expect(passes({ filterType: 'text', type: 'startsWith', filter: 'gam' }, values)).toEqual([['Gamma', 'delta']]);
        expect(passes({ filterType: 'text', type: 'endsWith', filter: 'bet' }, values)).toEqual(['alphabet']);
    });

    it('negations pass blanks, like a server exclusion', () => {
        expect(passes({ filterType: 'text', type: 'notContains', filter: 'alpha' }, values)).toEqual([
            ' beta ',
            null,
            '',
            ['Gamma', 'delta'],
        ]);
    });

    it('blank, notBlank, and an empty input that filters nothing', () => {
        expect(passes({ filterType: 'text', type: 'blank' }, values)).toEqual([null, '']);
        expect(passes({ filterType: 'text', type: 'notBlank' }, values)).toHaveLength(4);
        expect(passes({ filterType: 'text', type: 'contains', filter: '' }, values)).toEqual(values);
    });

    it('honours caseSensitive, trimInput, textFormatter and textMatcher', () => {
        expect(
            passes({ filterType: 'text', type: 'contains', filter: 'Alpha' }, values, {
                filterParams: { caseSensitive: true },
            })
        ).toEqual(['Alpha']);
        expect(
            passes({ filterType: 'text', type: 'equals', filter: 'beta' }, values, {
                filterParams: { trimInput: false },
            })
        ).toEqual([]);
        const unaccent = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
        expect(
            passes({ filterType: 'text', type: 'equals', filter: 'arger' }, ['Ärger'], {
                filterParams: { textFormatter: unaccent },
            })
        ).toEqual(['Ärger']);
        expect(
            passes({ filterType: 'text', type: 'contains', filter: 'x' }, ['ab', 'abc'], {
                filterParams: { textMatcher: ({ value }: { value: string }) => value.length === 3 },
            })
        ).toEqual(['abc']);
    });
});

describe('number and date', () => {
    const numbers = [1, 5, 10, '7', null, { amount: 3 }, 'x'];

    it('compares numbers, numeric strings and money; inRange is inclusive, open-ended without filterTo', () => {
        expect(passes({ filterType: 'number', type: 'greaterThan', filter: 4 }, numbers)).toEqual([5, 10, '7']);
        expect(passes({ filterType: 'number', type: 'lessThanOrEqual', filter: 3 }, numbers)).toEqual([
            1,
            { amount: 3 },
        ]);
        expect(passes({ filterType: 'number', type: 'inRange', filter: 5, filterTo: 10 }, numbers)).toEqual([
            5,
            10,
            '7',
        ]);
        expect(passes({ filterType: 'number', type: 'inRange', filter: 7 }, numbers)).toEqual([10, '7']);
    });

    it('honours inRangeInclusive and includeBlanksIn*', () => {
        expect(
            passes({ filterType: 'number', type: 'inRange', filter: 5, filterTo: 10 }, numbers, {
                filterParams: { inRangeInclusive: false },
            })
        ).toEqual(['7']);
        expect(
            passes({ filterType: 'number', type: 'equals', filter: 5 }, numbers, {
                filterParams: { includeBlanksInEquals: true },
            })
        ).toEqual([5, null]);
        expect(
            passes({ filterType: 'number', type: 'greaterThan', filter: 8 }, numbers, {
                filterParams: { includeBlanksInGreaterThan: true },
            })
        ).toEqual([10, null]);
        expect(passes({ filterType: 'number', type: 'notEqual', filter: 5 }, numbers)).toEqual([
            1,
            10,
            '7',
            { amount: 3 },
        ]);
    });

    it('dates compare as local instants', () => {
        const dates = ['2026-01-01', '2026-03-15 10:00:00', '2026-06-30', null];
        expect(
            passes({ filterType: 'date', type: 'inRange', dateFrom: '2026-01-01', dateTo: '2026-06-30' }, dates)
        ).toEqual(dates.slice(0, 3));
        expect(passes({ filterType: 'date', type: 'greaterThan', dateFrom: '2026-03-15' }, dates)).toEqual([
            '2026-03-15 10:00:00',
            '2026-06-30',
        ]);
        expect(passes({ filterType: 'date', type: 'equals', dateFrom: '2026-01-01' }, dates)).toEqual(['2026-01-01']);
        expect(toInstant('2026-01-02 03:04:05')).toBe(new Date(2026, 0, 2, 3, 4, 5).getTime());
    });

    it('a date comparator decides the cell position', () => {
        // Cells hold "DD/MM/YYYY"; the comparator compares them with the filter date.
        const comparator = (filterDate: Date, cell: unknown) => {
            const [day, month, year] = String(cell).split('/').map(Number);

            return new Date(year!, month! - 1, day!).getTime() - filterDate.getTime();
        };
        const cells = ['01/01/2026', '15/03/2026', '30/06/2026'];
        expect(
            passes({ filterType: 'date', type: 'lessThan', dateFrom: '2026-03-15' }, cells, {
                filterParams: { comparator },
            })
        ).toEqual(['01/01/2026']);
        expect(
            passes({ filterType: 'date', type: 'inRange', dateFrom: '2026-03-15', dateTo: '2026-06-30' }, cells, {
                filterParams: { comparator },
            })
        ).toEqual(['15/03/2026', '30/06/2026']);
        expect(
            passes({ filterType: 'date', type: 'inRange', dateFrom: '2026-03-15', dateTo: '2026-06-30' }, cells, {
                filterParams: { comparator, inRangeInclusive: false },
            })
        ).toEqual([]);
    });
});

describe('set, boolean and coordinates', () => {
    const values = ['a', 'b', null, '', ['a', 'c'], { id: 7, label: 'Seven' }];

    it('anyOf and noneOf, null standing for blank, empty sets like the server', () => {
        expect(passes({ filterType: 'set', values: ['a'] }, values)).toEqual(['a', ['a', 'c']]);
        expect(passes({ filterType: 'set', type: 'noneOf', values: ['a'] }, values)).toEqual([
            'b',
            null,
            '',
            { id: 7, label: 'Seven' },
        ]);
        expect(passes({ filterType: 'set', values: ['b', null] }, values)).toEqual(['b', null, '']);
        expect(passes({ filterType: 'set', values: ['7'] }, values)).toEqual([{ id: 7, label: 'Seven' }]);
        expect(passes({ filterType: 'set', values: [] }, values)).toEqual([]);
        expect(passes({ filterType: 'set', type: 'noneOf', values: [] }, values)).toEqual(values);
    });

    it('uses the column keyCreator and caseSensitive', () => {
        const keyCreator = ({ value }: { value: unknown }) => String((value as { label?: string })?.label ?? value);
        expect(passes({ filterType: 'set', values: ['seven'] }, values, { keyCreator })).toEqual([
            { id: 7, label: 'Seven' },
        ]);
        expect(
            passes({ filterType: 'set', values: ['seven'] }, values, {
                keyCreator,
                filterParams: { caseSensitive: true },
            })
        ).toEqual([]);
    });

    it('booleans accept the wire forms; coordinates match within the radius', () => {
        expect(
            passes({ filterType: 'boolean', type: 'equals', filter: true }, [true, 'true', 1, '1', false, 0, null])
        ).toEqual([true, 'true', 1, '1']);
        const london = { latitude: 51.5074, longitude: -0.1278 };
        const near: FilterCondition = {
            filterType: 'coordinates',
            type: 'withinRadius',
            filter: { ...london, radius: { value: 50, unit: 'km' } },
        };
        expect(passes(near, [{ lat: 51.4543, lng: -0.9781 }, [48.8566, 2.3522], london, null])).toEqual([london]);
    });
});

describe('composition and extension', () => {
    it('combined conditions (operator and conditions, as the server reads them) skip invalid children', () => {
        const join: FilterCondition = {
            filterType: 'number',
            operator: 'OR',
            conditions: [
                { filterType: 'number', type: 'lessThan', filter: 2 },
                { filterType: 'number', type: 'greaterThan', filter: 8 },
                { filterType: 'number', type: 'equals', filter: null },
            ],
        };
        expect(passes(join, [1, 5, 9])).toEqual([1, 9]);
        expect(passes({ ...join, operator: 'AND' } as FilterCondition, [1, 5, 9])).toEqual([]);
    });

    it('drops a combined condition nested in another, as the server evaluates one level', () => {
        const nested = {
            filterType: 'number',
            operator: 'OR',
            conditions: [
                {
                    filterType: 'number',
                    operator: 'AND',
                    conditions: [{ filterType: 'number', type: 'equals', filter: 1 }],
                },
            ],
        } as unknown as FilterCondition;

        expect(passes(nested, [1, 2])).toEqual([1, 2]);
    });

    it('follows the server for blanks, numeric strings, set values, empty noneOf and coordinates', () => {
        // Whitespace is not blank; arrays and objects of blanks are.
        expect(passes({ filterType: 'text', type: 'blank' }, ['  ', [null], { amount: null }, 'x'])).toEqual([
            [null],
            { amount: null },
        ]);
        // Numeric string inputs, number set values, and an empty noneOf dropped.
        expect(passes({ filterType: 'number', type: 'equals', filter: '5' as never }, [5, 6])).toEqual([5]);
        expect(passes({ filterType: 'set', values: [5 as never] }, [5, '5', 6])).toEqual([5, '5']);
        expect(passes({ filterType: 'set', type: 'noneOf', values: [] }, [1])).toEqual([1]);
        expect(isConditionActive({ filterType: 'set', type: 'noneOf', values: [] })).toBe(false);
        // Metres, and coordinates off the globe dropped.
        const point = { latitude: 51.5, longitude: 0 };
        expect(
            passes(
                {
                    filterType: 'coordinates',
                    type: 'withinRadius',
                    filter: { latitude: 51.5, longitude: 0.01, radius: { value: 500, unit: 'm' } },
                },
                [point]
            )
        ).toEqual([]);
        expect(
            passes(
                {
                    filterType: 'coordinates',
                    type: 'withinRadius',
                    filter: { latitude: 95, longitude: 0, radius: { value: 1, unit: 'km' } },
                },
                [point]
            )
        ).toEqual([point]);
        // A value that is not blank but not a number is no blank for includeBlanksInEquals.
        expect(
            passes({ filterType: 'number', type: 'equals', filter: 1 }, ['n/a', null], {
                filterParams: { includeBlanksInEquals: true },
            })
        ).toEqual([null]);
    });

    it('custom operators from filterOptions, in the common shape', () => {
        const filterParams = {
            filterOptions: [
                'equals',
                {
                    displayKey: 'even',
                    displayName: 'Even',
                    numberOfInputs: 0,
                    predicate: (_: unknown[], value: unknown) => Number(value) % 2 === 0,
                },
            ],
        };
        expect(passes({ filterType: 'number', type: 'even' as never }, [1, 2, 3, 4], { filterParams })).toEqual([2, 4]);
        // Without the definition, the unknown operator is invalid and filters nothing.
        expect(passes({ filterType: 'number', type: 'even' as never }, [1, 2], {})).toEqual([1, 2]);
    });

    it('custom kinds through the registry, and built-ins can be replaced', () => {
        const tags: FilterKind = {
            isValid: (condition: { tags?: string[] }) => Array.isArray(condition.tags) && condition.tags.length > 0,
            matches: (condition: { tags: string[] }, value) =>
                condition.tags.every((tag) => (value as string[]).includes(tag)),
        };
        expect(passes({ filterType: 'tags', tags: ['x', 'y'] }, [['x'], ['x', 'y', 'z']], {}, { tags })).toEqual([
            ['x', 'y', 'z'],
        ]);
        const exactText: FilterKind = {
            ...BUILTIN_FILTER_KINDS.text!,
            matches: (condition: { filter: string }, value) => value === condition.filter,
        };
        expect(
            passes({ filterType: 'text', type: 'contains', filter: 'Al' }, ['Al', 'Alpha'], {}, { text: exactText })
        ).toEqual(['Al']);
    });

    it('reports unknown kinds and skips them; unknown columns are skipped', () => {
        const model = new ColumnModel<Row>([{ field: 'value' }]);
        const misses: unknown[] = [];
        const predicate = createFilterPredicate<Row>(
            { value: { filterType: 'mystery' }, gone: { filterType: 'text', type: 'blank' } },
            { column: (colId) => model.getResolved(colId), onUnknownKind: (miss) => misses.push(miss) }
        );

        expect(predicate).toBeNull();
        expect(misses).toEqual([{ filterType: 'mystery', colId: 'value' }]);
    });

    it('filters on filterValueGetter when the column has one', () => {
        expect(
            passes({ filterType: 'text', type: 'equals', filter: 'yes' }, [1, 2], {
                valueGetter: () => 'no',
                filterValueGetter: ({ data }: { data: Row }) => (data.value === 2 ? 'yes' : 'no'),
            })
        ).toEqual([2]);
    });

    it('isConditionActive and isBlank', () => {
        expect(isConditionActive({ filterType: 'text', type: 'contains', filter: '' })).toBe(false);
        expect(
            isConditionActive({
                filterType: 'text',
                operator: 'AND',
                conditions: [{ filterType: 'text', type: 'blank' }],
            })
        ).toBe(true);
        expect([null, undefined, '', [], [null, ''], {}].every(isBlank)).toBe(true);
        expect(['  ', 0, false, [1]].some(isBlank)).toBe(false);
    });
});
