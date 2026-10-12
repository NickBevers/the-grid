import { describe, expect, it, vi } from 'vitest';

import type {
    CellEditorComponent,
    CellRendererComponent,
    ColumnDef,
    ColumnDefinition,
    ColumnGroupDef,
    GridRegistry,
    UnresolvedRegistryKey,
} from '../contract';
import {
    BUILTIN_REGISTRY,
    closestKey,
    createResolver,
    editDistance,
    isBuiltinPlaceholder,
    mergeRegistries,
    RegistryKeyError,
    resolveColumnRefs,
} from './registry';

type Row = { id: number; name?: string };

const renderer = (): CellRendererComponent<Row> => () => null;
const editor = (): CellEditorComponent<Row> => () => null;
const fn =
    <T>(value: T) =>
    () =>
        value;

function leaf(columns: ColumnDefinition<Row>[], index = 0): ColumnDef<Row> {
    return columns[index] as ColumnDef<Row>;
}

/** A full set of string keys of every kind, as server-sent column definitions name them. */
const INVENTORY = {
    renderers: [
        'statusCellRenderer',
        'ownerCellRenderer',
        'assigneeCellRenderer',
        'dueDateCellRenderer',
        'createdCellRenderer',
        'updatedCellRenderer',
        'priorityCellRenderer',
        'countryCellRenderer',
        'progressCellRenderer',
        'emailsCellRenderer',
        'ratingCellRenderer',
        'categoryCellRenderer',
        'priceCellRenderer',
        'quantityCellRenderer',
        'discountCellRenderer',
        'totalCellRenderer',
        'groupCellRenderer',
        'stockCellRenderer',
        'skuCellRenderer',
        'supplierCellRenderer',
        'warehouseCellRenderer',
        'regionCellRenderer',
        'nationalityCellRenderer',
        'cityCellRenderer',
        'postcodeCellRenderer',
        'languageCellRenderer',
        'timezoneCellRenderer',
        'companyCellRenderer',
        'contactCellRenderer',
        'phoneNumbersCellRenderer',
        'pronounsCellRenderer',
        'departmentCellRenderer',
        'richTextCellRenderer',
        'teamCellRenderer',
        'roleCellRenderer',
        'projectCellRenderer',
        'milestoneCellRenderer',
        'invoiceCellRenderer',
        'orderCellRenderer',
        'paymentCellRenderer',
        'shipmentCellRenderer',
        'productCellRenderer',
        'brandCellRenderer',
        'colourCellRenderer',
        'sizeCellRenderer',
        'tooltipCellRenderer',
        'websiteCellRenderer',
        'actionsCellRenderer',
        'checkboxRenderer',
    ],
    editors: [
        'comboboxCellEditor',
        'statusCellEditor',
        'currencyCellEditor',
        'ownerCellEditor',
        'assigneeCellEditor',
        'dueDateCellEditor',
        'createdCellEditor',
        'richTextCellEditor',
        'updatedCellEditor',
        'priorityCellEditor',
        'textEditor',
        'numberEditor',
        'dateEditor',
        'largeTextEditor',
        'checkboxEditor',
        'richSelectEditor',
    ],
    dataTypes: [
        'boolean',
        'customer',
        'coordinates',
        'country',
        'currency',
        'date',
        'address',
        'company',
        'number',
        'object',
        'contact',
        'invoice',
        'region',
        'room',
        'text',
    ],
    valueGetters: [
        'statusValueGetter',
        'ownerValueGetter',
        'countryValueGetter',
        'currencyOptionValueGetter',
        'assigneeValueGetter',
        'dueDateValueGetter',
        'createdValueGetter',
        'updatedValueGetter',
        'priorityValueGetter',
        'nationalityValueGetter',
        'progressValueGetter',
        'pronounsValueGetter',
        'ratingValueGetter',
        'categoryValueGetter',
        'priceValueGetter',
        'quantityValueGetter',
    ],
    valueSetters: [
        'statusValueSetter',
        'ownerValueSetter',
        'assigneeValueSetter',
        'dueDateValueSetter',
        'createdValueSetter',
        'updatedValueSetter',
        'priorityValueSetter',
        'progressValueSetter',
        'ratingValueSetter',
        'categoryValueSetter',
        'priceValueSetter',
        'quantityValueSetter',
    ],
    valueFormatters: [
        'statusValueFormatter',
        'countryValueFormatter',
        'ownerValueFormatter',
        'assigneeValueFormatter',
        'dueDateValueFormatter',
        'createdValueFormatter',
        'fileSizeFormatter',
        'updatedValueFormatter',
        'priorityValueFormatter',
        'progressValueFormatter',
        'ratingValueFormatter',
        'nationalityValueFormatter',
        'optionValueFormatter',
        'categoryValueFormatter',
        'priceValueFormatter',
        'pronounsValueFormatter',
        'quantityValueFormatter',
        'discountValueFormatter',
        'totalValueFormatter',
    ],
    keyCreators: ['optionKeyCreator'],
    filters: ['radiusFilter', 'searchedSetFilter', 'text', 'number', 'date', 'set'],
    editablePredicates: [
        'notLocked',
        'notLockedAndNoRoom',
        'notLockedAndNoRoomAndNoInvoiceAndNoCountry',
        'notLockedAndMultiRoom',
        'notLockedAndBeforeConfirmed',
        'notLockedWhenUnavailable',
    ],
    cellClassPredicates: [
        'nonEditableWhenRoomSet',
        'nonEditableWhenRoomInvoiceOrCountrySet',
        'nonEditableWhenNotMultiRoom',
    ],
    literalCellClasses: ['non-editable-cell'],
} as const;

const BUILTIN_KEYS = new Set([
    'checkboxRenderer',
    'textEditor',
    'numberEditor',
    'dateEditor',
    'largeTextEditor',
    'checkboxEditor',
    'richSelectEditor',
    'boolean',
    'date',
    'number',
    'object',
    'text',
]);

/** An application registry: every inventory key that is not a built-in. */
function inventoryRegistry(): GridRegistry<Row> {
    const own = (keys: readonly string[]) => keys.filter((key) => !BUILTIN_KEYS.has(key));

    return {
        renderers: Object.fromEntries(own(INVENTORY.renderers).map((key) => [key, renderer()])),
        editors: Object.fromEntries(own(INVENTORY.editors).map((key) => [key, editor()])),
        dataTypes: Object.fromEntries(own(INVENTORY.dataTypes).map((key) => [key, { baseType: 'object' as const }])),
        valueGetters: Object.fromEntries(INVENTORY.valueGetters.map((key) => [key, fn(key)])),
        valueSetters: Object.fromEntries(INVENTORY.valueSetters.map((key) => [key, fn(true)])),
        valueFormatters: Object.fromEntries(INVENTORY.valueFormatters.map((key) => [key, fn(key)])),
        keyCreators: Object.fromEntries(INVENTORY.keyCreators.map((key) => [key, fn(key)])),
        editablePredicates: Object.fromEntries(INVENTORY.editablePredicates.map((key) => [key, fn(true)])),
        cellClassRules: Object.fromEntries(INVENTORY.cellClassPredicates.map((key) => [key, fn('non-editable-cell')])),
    };
}

const FUNCTION_MEMBERS = [
    'cellRenderer',
    'cellEditor',
    'headerRenderer',
    'valueGetter',
    'valueSetter',
    'valueFormatter',
    'keyCreator',
    'comparator',
    'editable',
    'filterValueGetter',
    'tooltipRenderer',
] as const;

function collectStrings(columns: ColumnDefinition<Row>[]): string[] {
    return columns.flatMap((column) => {
        if ('children' in column) {
            return [
                ...(typeof column.headerRenderer === 'string' ? [column.headerRenderer] : []),
                ...collectStrings(column.children),
            ];
        }

        const record = column as Record<string, unknown>;
        const params = (column.filterParams ?? {}) as Record<string, unknown>;

        return [
            ...FUNCTION_MEMBERS.map((member) => record[member]),
            params.keyCreator,
            params.valueFormatter,
            record.editablePredicate,
            record.cellClassPredicate,
        ].filter((value): value is string => typeof value === 'string');
    });
}

describe('mergeRegistries', () => {
    it('merges kind by kind and lets later registries win', () => {
        const globalRenderer = renderer();
        const screenRenderer = renderer();
        const formatter = fn('x');

        const merged = mergeRegistries<Row>(
            { renderers: { a: globalRenderer, b: globalRenderer }, valueFormatters: { f: formatter } },
            undefined,
            { renderers: { b: screenRenderer, c: screenRenderer } }
        );

        expect(merged.renderers).toEqual({ a: globalRenderer, b: screenRenderer, c: screenRenderer });
        expect(merged.valueFormatters).toEqual({ f: formatter });
        expect(merged.editors).toBeUndefined();
    });

    it('does not mutate its inputs', () => {
        const first: GridRegistry<Row> = { valueGetters: { a: fn(1) } };

        mergeRegistries(first, { valueGetters: { b: fn(2) } });

        expect(Object.keys(first.valueGetters!)).toEqual(['a']);
    });
});

describe('createResolver', () => {
    const registry: GridRegistry<Row> = {
        valueGetters: { countryValueGetter: fn('NL'), regionValueGetter: fn('EU') },
    };

    it('resolves registered keys and ignores prototype names', () => {
        const resolver = createResolver(registry);

        expect(resolver.resolve('valueGetters', 'countryValueGetter', 'country')).toBe(
            registry.valueGetters!.countryValueGetter
        );
        expect(resolver.lookup('valueGetters', 'toString')).toBeUndefined();
    });

    it('reports a miss without throwing in reporting mode', () => {
        const onUnresolved = vi.fn();
        const resolver = createResolver(registry, { onUnresolved });

        expect(resolver.resolve('valueGetters', 'missing', 'col')).toBeUndefined();
        expect(onUnresolved).toHaveBeenCalledWith({ kind: 'valueGetters', key: 'missing', colId: 'col' });
    });

    it('throws a RegistryKeyError naming kind, key, column and closest key in strict mode', () => {
        const onUnresolved = vi.fn();
        const resolver = createResolver(registry, { strict: true, onUnresolved });

        let error: unknown;

        try {
            resolver.resolve('valueGetters', 'countyValueGetter', 'country');
        } catch (thrown) {
            error = thrown;
        }

        expect(error).toBeInstanceOf(RegistryKeyError);
        expect((error as RegistryKeyError).message).toBe(
            'Unresolved valueGetters key "countyValueGetter" on column "country". Closest registered key: "countryValueGetter".'
        );
        expect((error as RegistryKeyError).suggestion).toBe('countryValueGetter');
        expect(onUnresolved).toHaveBeenCalledOnce();
    });

    it('suggests a key of another kind when the kind is empty', () => {
        const resolver = createResolver<Row>({ valueFormatters: { countryValueFormatter: fn('') } }, { strict: true });

        expect(() => resolver.resolve('valueGetters', 'countryValueGetter', null)).toThrow(
            'Unresolved valueGetters key "countryValueGetter" on no column. No valueGetters are registered. Closest registered key: "countryValueFormatter" (valueFormatters).'
        );
    });

    it('says so when the registry is empty', () => {
        expect(() => createResolver<Row>({}, { strict: true }).resolve('renderers', 'x', 'c')).toThrow(
            'The registry has no keys.'
        );
    });
});

describe('edit distance', () => {
    it('computes Levenshtein distance', () => {
        expect(editDistance('kitten', 'sitting')).toBe(3);
        expect(editDistance('', 'abc')).toBe(3);
        expect(editDistance('same', 'same')).toBe(0);
    });

    it('picks the closest candidate', () => {
        expect(
            closestKey('invoiceValuGetter', ['invoiceValueFormatter', 'invoiceValueGetter', 'regionValueGetter'])
        ).toBe('invoiceValueGetter');
        expect(closestKey('COUNTRYVALUEGETTER', ['regionValueGetter', 'countryValueGetter'])).toBe(
            'countryValueGetter'
        );
        expect(closestKey('x', [])).toBeNull();
    });
});

describe('BUILTIN_REGISTRY', () => {
    it('holds the built-in renderers and editors', () => {
        expect(Object.keys(BUILTIN_REGISTRY.renderers!)).toEqual(
            expect.arrayContaining(['checkboxRenderer', 'groupRenderer'])
        );
        expect(Object.keys(BUILTIN_REGISTRY.editors!)).toEqual(
            expect.arrayContaining([
                'textEditor',
                'largeTextEditor',
                'selectEditor',
                'richSelectEditor',
                'numberEditor',
                'dateEditor',
                'dateStringEditor',
                'checkboxEditor',
            ])
        );
        expect(Object.keys(BUILTIN_REGISTRY.dataTypes!)).toEqual(
            expect.arrayContaining(['text', 'number', 'boolean', 'date', 'object'])
        );
    });

    it('marks its components as placeholders with editor policies', () => {
        const largeText = BUILTIN_REGISTRY.editors!.largeTextEditor!;

        expect(isBuiltinPlaceholder(largeText)).toBe(true);
        expect(isBuiltinPlaceholder(renderer())).toBe(false);
        expect(largeText.presentation).toBe('popup');
        expect(largeText.keyPolicy?.enter).toBe('newline');
    });

    it('lets the application override a built-in data type', () => {
        const appDate = { baseType: 'date' as const };
        const merged = mergeRegistries<Row>(BUILTIN_REGISTRY, { dataTypes: { date: appDate } });

        expect(merged.dataTypes!.date).toBe(appDate);
        expect(merged.dataTypes!.number).toBe(BUILTIN_REGISTRY.dataTypes!.number);
    });
});

describe('resolveColumnRefs', () => {
    const cell = renderer();
    const edit = editor();
    const header = (() => null) as NonNullable<GridRegistry<Row>['headers']>[string];
    const getter = fn('value');
    const setter = fn(true);
    const formatter = fn('formatted');
    const keyCreator = fn('key');
    const predicate = fn(true);
    const rule = fn('rule-class');
    const comparator = (a: unknown, b: unknown) => Number(a) - Number(b);
    const typeFormatter = fn('typed');
    const typeEditor = editor();
    const typeComparator = (a: unknown, b: unknown) => String(a).localeCompare(String(b));
    const typeKeyCreator = fn('typed-key');

    const registry: GridRegistry<Row> = {
        renderers: { cell },
        editors: { edit },
        headers: { header },
        valueGetters: { getter },
        valueSetters: { setter },
        valueFormatters: { formatter },
        keyCreators: { keyCreator },
        editablePredicates: { predicate },
        cellClassRules: { rule },
        comparators: { comparator },
        dataTypes: {
            typed: {
                baseType: 'object',
                valueFormatter: typeFormatter,
                editor: typeEditor,
                comparator: typeComparator,
                keyCreator: typeKeyCreator,
                filter: 'set',
            },
        },
    };

    it('resolves every kind', () => {
        const { columns, misses } = resolveColumnRefs<Row>(
            [
                {
                    colId: 'a',
                    cellRenderer: 'cell',
                    cellEditor: 'edit',
                    headerRenderer: 'header',
                    valueGetter: 'getter',
                    filterValueGetter: 'getter',
                    valueSetter: 'setter',
                    valueFormatter: 'formatter',
                    keyCreator: 'keyCreator',
                    comparator: 'comparator',
                    editable: 'predicate',
                    cellClass: 'rule',
                    tooltipRenderer: 'cell',
                    filterParams: { keyCreator: 'keyCreator', valueFormatter: 'formatter' },
                },
            ],
            createResolver(registry, { strict: true })
        );

        expect(misses).toEqual([]);
        expect(leaf(columns)).toEqual({
            colId: 'a',
            cellRenderer: cell,
            cellEditor: edit,
            headerRenderer: header,
            valueGetter: getter,
            filterValueGetter: getter,
            valueSetter: setter,
            valueFormatter: formatter,
            keyCreator,
            comparator,
            editable: predicate,
            cellClass: rule,
            tooltipRenderer: cell,
            filterParams: { keyCreator, valueFormatter: formatter },
        });
    });

    it('folds the server editablePredicate and cellClassPredicate fields in and strips them', () => {
        const { columns } = resolveColumnRefs<Row>(
            [
                {
                    colId: 'a',
                    editable: true,
                    cellClass: 'static',
                    editablePredicate: 'predicate',
                    cellClassPredicate: 'rule',
                } as ColumnDef<Row>,
            ],
            createResolver(registry, { strict: true })
        );

        expect(leaf(columns)).toEqual({ colId: 'a', editable: predicate, cellClass: rule });
    });

    it('keeps an unregistered string cellClass as a literal class name', () => {
        const onUnresolved = vi.fn();
        const { columns, misses } = resolveColumnRefs<Row>(
            [
                { colId: 'a', cellClass: 'non-editable-cell' },
                { colId: 'b', cellClass: ['x', 'y'] },
            ],
            createResolver(registry, { onUnresolved, strict: true })
        );

        expect(leaf(columns, 0).cellClass).toBe('non-editable-cell');
        expect(leaf(columns, 1).cellClass).toEqual(['x', 'y']);
        expect(misses).toEqual([]);
        expect(onUnresolved).not.toHaveBeenCalled();
    });

    it('applies data type defaults under explicit column values', () => {
        const { columns } = resolveColumnRefs<Row>(
            [
                { colId: 'defaults', dataType: 'typed' },
                {
                    colId: 'explicit',
                    dataType: 'typed',
                    valueFormatter: 'formatter',
                    cellEditor: edit,
                    comparator: 'comparator',
                    keyCreator: 'keyCreator',
                    filter: 'text',
                },
            ],
            createResolver(registry, { strict: true })
        );

        expect(leaf(columns, 0)).toEqual({
            colId: 'defaults',
            dataType: 'typed',
            valueFormatter: typeFormatter,
            cellEditor: typeEditor,
            comparator: typeComparator,
            keyCreator: typeKeyCreator,
            filter: 'set',
        });
        expect(leaf(columns, 1)).toMatchObject({
            valueFormatter: formatter,
            cellEditor: edit,
            comparator,
            keyCreator,
            filter: 'text',
        });
    });

    it('applies no defaults for dataType false', () => {
        const { columns } = resolveColumnRefs<Row>(
            [{ colId: 'a', dataType: false }],
            createResolver(registry, { strict: true })
        );

        expect(leaf(columns)).toEqual({ colId: 'a', dataType: false });
    });

    it('recurses into groups and resolves group header renderers', () => {
        const definitions: ColumnDefinition<Row>[] = [
            {
                groupId: 'outer',
                headerRenderer: 'header',
                children: [
                    { groupId: 'inner', children: [{ colId: 'deep', valueGetter: 'getter', showWhen: 'open' }] },
                ],
            },
        ];
        const { columns } = resolveColumnRefs(definitions, createResolver(registry, { strict: true }));
        const outer = columns[0] as ColumnGroupDef<Row>;
        const inner = outer.children[0] as ColumnGroupDef<Row>;

        expect(outer.headerRenderer).toBe(header);
        expect(inner.children[0]).toEqual({ colId: 'deep', valueGetter: getter, showWhen: 'open' });
        expect((definitions[0] as ColumnGroupDef<Row>).headerRenderer).toBe('header');
    });

    it('leaves functions and components already in place untouched', () => {
        const ownGetter = fn('own');
        const ownRenderer = renderer();
        const ownEditable = fn(false);
        const ownRule = fn('own-class');
        const onUnresolved = vi.fn();
        const { columns } = resolveColumnRefs<Row>(
            [
                {
                    colId: 'a',
                    valueGetter: ownGetter,
                    cellRenderer: ownRenderer,
                    editable: ownEditable,
                    cellClass: ownRule,
                },
            ],
            createResolver(registry, { onUnresolved })
        );

        expect(leaf(columns)).toEqual({
            colId: 'a',
            valueGetter: ownGetter,
            cellRenderer: ownRenderer,
            editable: ownEditable,
            cellClass: ownRule,
        });
        expect(onUnresolved).not.toHaveBeenCalled();
    });

    it('prepends a blank value to set filter values', () => {
        const { columns } = resolveColumnRefs<Row>(
            [
                { colId: 'a', filter: 'set', filterParams: { values: ['x'] } },
                { colId: 'b', filter: 'set', filterParams: { values: [null, 'x'] } },
            ],
            createResolver(registry)
        );

        expect(leaf(columns, 0).filterParams!.values).toEqual([null, 'x']);
        expect(leaf(columns, 1).filterParams!.values).toEqual([null, 'x']);
    });

    it('never passes a missing key on as a string in reporting mode', () => {
        const onUnresolved = vi.fn();
        const { columns, misses } = resolveColumnRefs<Row>(
            [
                {
                    colId: 'a',
                    cellRenderer: 'nope',
                    valueGetter: 'nope',
                    valueFormatter: 'nope',
                    valueSetter: 'nope',
                    editable: true,
                    dataType: 'nope',
                    filterParams: { valueFormatter: 'nope' },
                },
                { colId: 'b', editable: 'nope' },
            ],
            createResolver(registry, { onUnresolved })
        );

        expect(collectStrings(columns)).toEqual([]);
        expect(leaf(columns, 0)).toEqual({ colId: 'a', editable: false, filterParams: {} });
        expect(leaf(columns, 1).editable).toBe(false);
        expect(misses.map((miss) => miss.kind)).toEqual([
            'dataTypes',
            'renderers',
            'valueGetters',
            'valueSetters',
            'valueFormatters',
            'valueFormatters',
            'editablePredicates',
        ]);
        expect(onUnresolved).toHaveBeenCalledTimes(misses.length);
    });

    it('throws on the first miss in strict mode', () => {
        expect(() =>
            resolveColumnRefs<Row>(
                [{ colId: 'a', valueFormatter: 'formater' }],
                createResolver(registry, { strict: true })
            )
        ).toThrow('Unresolved valueFormatters key "formater" on column "a". Closest registered key: "formatter".');
    });

    it('uses field as the column name when colId is absent', () => {
        const { misses } = resolveColumnRefs<Row>([{ field: 'name', valueGetter: 'nope' }], createResolver(registry));

        expect(misses).toEqual([{ kind: 'valueGetters', key: 'nope', colId: 'name' }]);
    });
});

describe('inventory keys', () => {
    function inventoryColumns(): ColumnDefinition<Row>[] {
        let index = 0;
        const column = (props: Record<string, unknown>): ColumnDef<Row> =>
            ({ colId: `c${index++}`, ...props }) as ColumnDef<Row>;

        return [
            ...INVENTORY.renderers.map((key) => column({ cellRenderer: key })),
            ...INVENTORY.editors.map((key) => column({ cellEditor: key })),
            ...INVENTORY.dataTypes.map((key) => column({ dataType: key })),
            ...INVENTORY.valueGetters.map((key) => column({ valueGetter: key })),
            ...INVENTORY.valueSetters.map((key) => column({ valueSetter: key, editable: true })),
            ...INVENTORY.valueFormatters.map((key) =>
                column({ valueFormatter: key, filterParams: { valueFormatter: key } })
            ),
            ...INVENTORY.keyCreators.map((key) => column({ keyCreator: key, filterParams: { keyCreator: key } })),
            ...INVENTORY.filters.map((key) => column({ filter: key })),
            ...INVENTORY.editablePredicates.map((key) => column({ editable: true, editablePredicate: key })),
            ...INVENTORY.cellClassPredicates.map((key) => column({ cellClassPredicate: key })),
            ...INVENTORY.literalCellClasses.map((key) => column({ cellClass: key })),
        ];
    }

    it('lists the 144 keys of the inventory', () => {
        const counts = Object.fromEntries(Object.entries(INVENTORY).map(([kind, keys]) => [kind, keys.length]));

        expect(counts).toEqual({
            renderers: 49,
            editors: 16,
            dataTypes: 15,
            valueGetters: 16,
            valueSetters: 12,
            valueFormatters: 19,
            keyCreators: 1,
            filters: 6,
            editablePredicates: 6,
            cellClassPredicates: 3,
            literalCellClasses: 1,
        });
    });

    it('resolves every server key against a registry that registers them, with zero misses', () => {
        const misses: UnresolvedRegistryKey[] = [];
        const resolver = createResolver(mergeRegistries(BUILTIN_REGISTRY, inventoryRegistry()), {
            strict: true,
            onUnresolved: (miss) => misses.push(miss),
        });

        const result = resolveColumnRefs(inventoryColumns(), resolver);

        expect(misses).toEqual([]);
        expect(result.misses).toEqual([]);
        expect(collectStrings(result.columns)).toEqual([]);

        const byId = new Map(
            result.columns.map((definition) => [(definition as ColumnDef<Row>).colId, definition as ColumnDef<Row>])
        );
        const filterColumns = [...byId.values()].filter(
            (definition) => typeof definition.filter === 'string' && !('dataType' in definition)
        );

        expect(filterColumns.map((definition) => definition.filter)).toEqual(INVENTORY.filters);
        expect([...byId.values()].find((definition) => definition.cellClass === 'non-editable-cell')).toBeDefined();
    });

    it('reports keys an application registry lacks as misses', () => {
        const unresolved = [
            'nationalityValueGetter',
            'pronounsValueGetter',
            'nationalityCellRenderer',
            'pronounsCellRenderer',
        ];
        const applicationRegistry = inventoryRegistry();

        for (const key of unresolved) {
            delete applicationRegistry.valueGetters![key];
            delete applicationRegistry.renderers![key];
        }

        const onUnresolved = vi.fn();
        const resolver = createResolver(mergeRegistries(BUILTIN_REGISTRY, applicationRegistry), { onUnresolved });
        const { columns, misses } = resolveColumnRefs<Row>(
            [
                {
                    colId: 'nationality',
                    field: 'nationality',
                    valueGetter: 'nationalityValueGetter',
                    valueFormatter: 'nationalityValueFormatter',
                    cellRenderer: 'nationalityCellRenderer',
                },
                {
                    colId: 'pronouns',
                    field: 'pronouns',
                    valueGetter: 'pronounsValueGetter',
                    valueFormatter: 'pronounsValueFormatter',
                    cellRenderer: 'pronounsCellRenderer',
                },
            ],
            resolver
        );

        expect(misses).toEqual([
            { kind: 'renderers', key: 'nationalityCellRenderer', colId: 'nationality' },
            { kind: 'valueGetters', key: 'nationalityValueGetter', colId: 'nationality' },
            { kind: 'renderers', key: 'pronounsCellRenderer', colId: 'pronouns' },
            { kind: 'valueGetters', key: 'pronounsValueGetter', colId: 'pronouns' },
        ]);
        expect(onUnresolved).toHaveBeenCalledTimes(4);
        expect(collectStrings(columns)).toEqual([]);
        expect(leaf(columns, 0)).toEqual({
            colId: 'nationality',
            field: 'nationality',
            valueFormatter: applicationRegistry.valueFormatters!.nationalityValueFormatter,
        });

        expect(() =>
            resolveColumnRefs(
                columnsWithKey('pronounsValueGetter'),
                createResolver(mergeRegistries(BUILTIN_REGISTRY, applicationRegistry), { strict: true })
            )
        ).toThrow('Unresolved valueGetters key "pronounsValueGetter" on column "pronouns". Closest registered key:');
    });
});

function columnsWithKey(key: string): ColumnDefinition<Row>[] {
    return [{ colId: 'pronouns', valueGetter: key }];
}
