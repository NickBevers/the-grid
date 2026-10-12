/**
 * Registry merging and string key resolution.
 *
 * Column definitions from a server name renderers, editors, getters, setters, formatters, key creators,
 * predicates and data types by string key. This module turns those keys into the functions and components a grid
 * registry holds. A missing key is never passed on as a string, since a grid that evaluates such strings
 * as expressions throws on them. Every miss is reported, and in
 * strict mode it throws a `RegistryKeyError` that names the closest registered key.
 */
import type { ComponentType } from 'react';

import type {
    CellEditorComponent,
    CellRendererComponent,
    ColumnDef,
    ColumnDefinition,
    ColumnGroupDef,
    DataTypeDefinition,
    EditorKeyPolicy,
    EditorPresentation,
    GridRegistry,
    UnresolvedRegistryKey,
} from '../contract';
import { isColumnGroupDef } from '../contract';

/** One kind of registry entry, such as `renderers` or `valueGetters`. */
export type RegistryKind = keyof GridRegistry;

/** The entry type a registry holds for one kind. */
export type RegistryEntry<TData, K extends RegistryKind> = NonNullable<GridRegistry<TData>[K]>[string];

/** Every kind a registry can hold, in a fixed order. */
export const REGISTRY_KINDS: readonly RegistryKind[] = [
    'renderers',
    'editors',
    'headers',
    'fullWidthRenderers',
    'valueGetters',
    'valueSetters',
    'valueFormatters',
    'keyCreators',
    'editablePredicates',
    'cellClassRules',
    'comparators',
    'filters',
    'dataTypes',
];

/** Options for `createResolver`. */
export type ResolverOptions = {
    /** Called once for every key that has no entry. */
    onUnresolved?: (miss: UnresolvedRegistryKey) => void;
    /** Throw a `RegistryKeyError` on the first miss, after `onUnresolved` has run. Use in development and tests. */
    strict?: boolean;
};

/** Looks up registry keys and reports misses. */
export type RegistryResolver<TData> = {
    readonly registry: GridRegistry<TData>;
    /** Returns the entry, or undefined after reporting the miss (and throwing in strict mode). */
    resolve<K extends RegistryKind>(kind: K, key: string, colId: string | null): RegistryEntry<TData, K> | undefined;
    /** Returns the entry or undefined without reporting anything. */
    lookup<K extends RegistryKind>(kind: K, key: string): RegistryEntry<TData, K> | undefined;
    /** Reports a miss: calls `onUnresolved`, then throws in strict mode. */
    report(miss: UnresolvedRegistryKey): void;
};

/** Thrown in strict mode when a key has no registry entry. */
export class RegistryKeyError extends Error {
    readonly kind: RegistryKind;
    readonly key: string;
    readonly colId: string | null;
    /** Closest registered key, or null when the registry holds no keys at all. */
    readonly suggestion: string | null;

    constructor(miss: UnresolvedRegistryKey, suggestion: string | null, suggestionKind: RegistryKind | null) {
        super(registryKeyMessage(miss, suggestion, suggestionKind));
        this.name = 'RegistryKeyError';
        this.kind = miss.kind;
        this.key = miss.key;
        this.colId = miss.colId;
        this.suggestion = suggestion;
    }
}

/**
 * Merges registries kind by kind. A later registry wins for a key it also defines, so screen-local
 * entries passed after the global registry override it.
 */
export function mergeRegistries<TData>(...registries: (GridRegistry<TData> | undefined)[]): GridRegistry<TData> {
    const merged: Partial<Record<RegistryKind, Record<string, unknown>>> = {};

    for (const registry of registries) {
        if (!registry) {
            continue;
        }

        for (const kind of REGISTRY_KINDS) {
            const entries = registry[kind];

            if (entries) {
                merged[kind] = { ...merged[kind], ...entries };
            }
        }
    }

    return merged as GridRegistry<TData>;
}

/** Creates a resolver over one registry. */
export function createResolver<TData>(
    registry: GridRegistry<TData>,
    options: ResolverOptions = {}
): RegistryResolver<TData> {
    const lookup = <K extends RegistryKind>(kind: K, key: string): RegistryEntry<TData, K> | undefined => {
        const entries = registry[kind] as Record<string, RegistryEntry<TData, K>> | undefined;

        if (!entries || !Object.hasOwn(entries, key)) {
            return undefined;
        }

        return entries[key];
    };

    const report = (miss: UnresolvedRegistryKey): void => {
        options.onUnresolved?.(miss);

        if (options.strict) {
            const suggestion = closestRegisteredKey(registry, miss.kind, miss.key);

            throw new RegistryKeyError(miss, suggestion?.key ?? null, suggestion?.kind ?? null);
        }
    };

    return {
        registry,
        lookup,
        report,
        resolve(kind, key, colId) {
            const entry = lookup(kind, key);

            if (entry === undefined) {
                report({ kind, key, colId });
            }

            return entry;
        },
    };
}

/** Levenshtein distance between two strings. */
export function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];

        for (let j = 1; j <= b.length; j++) {
            const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);

            current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
        }

        previous = current;
    }

    return previous[b.length] ?? 0;
}

/** The candidate with the smallest edit distance to `key`, or null when there are none. Ties keep the first. */
export function closestKey(key: string, candidates: Iterable<string>): string | null {
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
        const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());

        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }

    return best;
}

/**
 * The closest key of the same kind. When that kind is empty, the closest key of any kind, because a
 * key sent under the wrong kind is a common mistake.
 */
function closestRegisteredKey<TData>(
    registry: GridRegistry<TData>,
    kind: RegistryKind,
    key: string
): { kind: RegistryKind; key: string } | null {
    const sameKind = closestKey(key, Object.keys(registry[kind] ?? {}));

    if (sameKind !== null) {
        return { kind, key: sameKind };
    }

    const all = REGISTRY_KINDS.flatMap((other) =>
        Object.keys(registry[other] ?? {}).map((name) => ({ kind: other, key: name }))
    );
    const closest = closestKey(
        key,
        all.map((entry) => entry.key)
    );

    return all.find((entry) => entry.key === closest) ?? null;
}

function registryKeyMessage(
    miss: UnresolvedRegistryKey,
    suggestion: string | null,
    suggestionKind: RegistryKind | null
): string {
    const column = miss.colId === null ? 'no column' : `column "${miss.colId}"`;
    const base = `Unresolved ${miss.kind} key "${miss.key}" on ${column}.`;

    if (suggestion === null) {
        return `${base} The registry has no keys.`;
    }

    if (suggestionKind !== miss.kind) {
        return `${base} No ${miss.kind} are registered. Closest registered key: "${suggestion}" (${suggestionKind}).`;
    }

    return `${base} Closest registered key: "${suggestion}".`;
}

/* Built-ins */

const placeholders = new WeakSet<object>();

/** True for the placeholder components `BUILTIN_REGISTRY` holds until the real UI replaces them. */
export function isBuiltinPlaceholder(component: unknown): boolean {
    return (
        (typeof component === 'function' || typeof component === 'object') &&
        component !== null &&
        placeholders.has(component)
    );
}

function placeholderRenderer(name: string): CellRendererComponent<any> {
    const component: CellRendererComponent<any> = () => null;

    component.displayName = `Builtin(${name})`;
    placeholders.add(component);

    return component;
}

function placeholderEditor(
    name: string,
    presentation: EditorPresentation,
    keyPolicy: Partial<EditorKeyPolicy> = {}
): CellEditorComponent<any> {
    const component: CellEditorComponent<any> = Object.assign(() => null, { presentation, keyPolicy });

    (component as ComponentType).displayName = `Builtin(${name})`;
    placeholders.add(component);

    return component;
}

function compareNullsFirst(a: unknown, b: unknown, compare: (a: never, b: never) => number): number {
    const aEmpty = a === null || a === undefined;
    const bEmpty = b === null || b === undefined;

    if (aEmpty || bEmpty) {
        return aEmpty === bEmpty ? 0 : aEmpty ? -1 : 1;
    }

    return compare(a as never, b as never);
}

function textComparator(a: unknown, b: unknown): number {
    return compareNullsFirst(a, b, (x: unknown, y: unknown) => String(x).localeCompare(String(y)));
}

function numberComparator(a: unknown, b: unknown): number {
    return compareNullsFirst(a, b, (x: unknown, y: unknown) => Number(x) - Number(y));
}

function booleanComparator(a: unknown, b: unknown): number {
    return compareNullsFirst(a, b, (x: unknown, y: unknown) => Number(Boolean(x)) - Number(Boolean(y)));
}

function dateComparator(a: unknown, b: unknown): number {
    const time = (value: unknown): number =>
        value instanceof Date ? value.getTime() : new Date(String(value)).getTime();

    return compareNullsFirst(a, b, (x: unknown, y: unknown) => time(x) - time(y));
}

function plainText(value: unknown): string {
    return value === null || value === undefined ? '' : String(value);
}

const builtinEditors = {
    textEditor: placeholderEditor('textEditor', 'inline'),
    largeTextEditor: placeholderEditor('largeTextEditor', 'popup', {
        enter: 'newline',
        arrowsNavigateGrid: false,
    }),
    numberEditor: placeholderEditor('numberEditor', 'inline'),
    selectEditor: placeholderEditor('selectEditor', 'popup', { arrowsNavigateGrid: false }),
    richSelectEditor: placeholderEditor('richSelectEditor', 'popup', { arrowsNavigateGrid: false }),
    dateEditor: placeholderEditor('dateEditor', 'popup'),
    dateStringEditor: placeholderEditor('dateStringEditor', 'popup'),
    checkboxEditor: placeholderEditor('checkboxEditor', 'inline'),
} satisfies Record<string, CellEditorComponent<any>>;

const builtinDataTypes = {
    text: {
        baseType: 'text',
        valueFormatter: ({ value }) => plainText(value),
        editor: builtinEditors.textEditor,
        comparator: textComparator,
        filter: 'text',
    },
    number: {
        baseType: 'number',
        valueFormatter: ({ value }) => plainText(value),
        valueParser: (text) => (text.trim() === '' ? null : Number(text)),
        editor: builtinEditors.numberEditor,
        comparator: numberComparator,
        filter: 'number',
    },
    boolean: {
        baseType: 'boolean',
        valueFormatter: ({ value }) => plainText(value),
        editor: builtinEditors.checkboxEditor,
        comparator: booleanComparator,
        filter: 'set',
    },
    date: {
        baseType: 'date',
        valueFormatter: ({ value }) => (value instanceof Date ? value.toISOString().slice(0, 10) : plainText(value)),
        editor: builtinEditors.dateEditor,
        comparator: dateComparator,
        filter: 'date',
    },
    dateString: {
        baseType: 'date',
        valueFormatter: ({ value }) => plainText(value),
        editor: builtinEditors.dateStringEditor,
        comparator: dateComparator,
        filter: 'date',
    },
    object: {
        baseType: 'object',
        valueFormatter: ({ value }) => plainText(value),
        comparator: textComparator,
        filter: 'text',
    },
} satisfies Record<string, DataTypeDefinition<any>>;

/**
 * Built-in renderers, editors and data types, as placeholders an application replaces with its own
 * components. Merge it first; the app registry and screen registries override it (an app's own `date`
 * data type replaces the built-in one). An application that receives other names from its backend maps
 * them onto these in its own registry.
 */
export const BUILTIN_REGISTRY: GridRegistry<any> = {
    renderers: {
        checkboxRenderer: placeholderRenderer('checkboxRenderer'),
        groupRenderer: placeholderRenderer('groupRenderer'),
    },
    editors: builtinEditors,
    dataTypes: builtinDataTypes,
};

/* Column resolution */

/**
 * Server extension fields. They are not in the contract's `ColumnDef`; a server sends them next to
 * `editable` and `cellClass` and `resolveColumnRefs` folds them in.
 */
type PhpPredicateFields = {
    editablePredicate?: string;
    cellClassPredicate?: string;
};

type LeafDefinition<TData> = ColumnDef<TData> & { showWhen?: 'open' | 'closed' };

/** Result of `resolveColumnRefs`. */
export type ResolvedColumnRefs<TData> = {
    columns: ColumnDefinition<TData>[];
    misses: UnresolvedRegistryKey[];
};

/**
 * Replaces string keys in column definitions with registry entries and applies data type defaults
 * under explicit column values. Recurses into groups. Functions and components already in place are
 * left alone. Inputs are not mutated.
 *
 * What a miss leaves behind (in reporting mode; strict mode throws instead):
 * - renderers, editors, headers, getters, formatters, key creators and comparators are removed, so the
 *   grid's default applies (a getter miss reads `field`) or the data type default fills in;
 * - an editable predicate miss, or a setter miss, makes the column read only, because guessing could
 *   write the wrong data;
 * - a data type miss drops `dataType`.
 *
 * A string `cellClass` is a class rule when one is registered under that name and a literal class name
 * otherwise, because servers send static classes that way (`non-editable-cell`). It is never a miss.
 */
export function resolveColumnRefs<TData>(
    definitions: ColumnDefinition<TData>[],
    resolver: RegistryResolver<TData>
): ResolvedColumnRefs<TData> {
    const misses: UnresolvedRegistryKey[] = [];
    const columns = definitions.map((definition) => resolveDefinition(definition, resolver, misses));

    return { columns, misses };
}

function resolveDefinition<TData>(
    definition: ColumnDefinition<TData>,
    resolver: RegistryResolver<TData>,
    misses: UnresolvedRegistryKey[]
): ColumnDefinition<TData> {
    if (isColumnGroupDef(definition)) {
        return resolveGroup(definition, resolver, misses);
    }

    return resolveLeaf(definition, resolver, misses);
}

function resolveGroup<TData>(
    group: ColumnGroupDef<TData>,
    resolver: RegistryResolver<TData>,
    misses: UnresolvedRegistryKey[]
): ColumnGroupDef<TData> {
    const find = finder(resolver, misses, group.groupId);
    const resolved: ColumnGroupDef<TData> = {
        ...group,
        children: group.children.map((child) => resolveDefinition(child, resolver, misses)),
    };

    if (typeof group.headerRenderer === 'string') {
        setOrDelete(resolved, 'headerRenderer', find('headers', group.headerRenderer));
    }

    return resolved;
}

function finder<TData>(
    resolver: RegistryResolver<TData>,
    misses: UnresolvedRegistryKey[],
    colId: string | null
): <K extends RegistryKind>(kind: K, key: string) => RegistryEntry<TData, K> | undefined {
    return (kind, key) => {
        const entry = resolver.lookup(kind, key);

        if (entry === undefined) {
            const miss = { kind, key, colId };

            misses.push(miss);
            resolver.report(miss);
        }

        return entry;
    };
}

function setOrDelete<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
    if (value === undefined) {
        delete target[key];
    } else {
        target[key] = value;
    }
}

function resolveLeaf<TData>(
    definition: LeafDefinition<TData>,
    resolver: RegistryResolver<TData>,
    misses: UnresolvedRegistryKey[]
): LeafDefinition<TData> {
    const colId = definition.colId ?? definition.field ?? null;
    const find = finder(resolver, misses, colId);
    const { editablePredicate, cellClassPredicate, ...rest } = definition as LeafDefinition<TData> & PhpPredicateFields;
    const column: LeafDefinition<TData> = { ...rest };
    let readOnly = false;

    let dataType: DataTypeDefinition<TData> | undefined;

    if (typeof definition.dataType === 'string') {
        dataType = find('dataTypes', definition.dataType);

        if (!dataType) {
            delete column.dataType;
        }
    }

    if (typeof definition.cellRenderer === 'string') {
        setOrDelete(column, 'cellRenderer', find('renderers', definition.cellRenderer));
    }

    if (typeof definition.cellEditor === 'string') {
        setOrDelete(column, 'cellEditor', find('editors', definition.cellEditor));
    }

    if (typeof definition.headerRenderer === 'string') {
        setOrDelete(column, 'headerRenderer', find('headers', definition.headerRenderer));
    }

    if (typeof definition.tooltipRenderer === 'string') {
        // The contract has no tooltip kind; tooltip components share the renderer namespace.
        const tooltip = find('renderers', definition.tooltipRenderer) as unknown as
            | ComponentType<{ value: unknown }>
            | undefined;

        setOrDelete(column, 'tooltipRenderer', tooltip);
    }

    if (typeof definition.valueGetter === 'string') {
        setOrDelete(column, 'valueGetter', find('valueGetters', definition.valueGetter));
    }

    if (typeof definition.filterValueGetter === 'string') {
        setOrDelete(column, 'filterValueGetter', find('valueGetters', definition.filterValueGetter));
    }

    if (typeof definition.valueSetter === 'string') {
        const setter = find('valueSetters', definition.valueSetter);

        setOrDelete(column, 'valueSetter', setter);
        readOnly ||= setter === undefined;
    }

    if (typeof definition.valueFormatter === 'string') {
        setOrDelete(column, 'valueFormatter', find('valueFormatters', definition.valueFormatter));
    }

    if (typeof definition.keyCreator === 'string') {
        setOrDelete(column, 'keyCreator', find('keyCreators', definition.keyCreator));
    }

    if (typeof definition.comparator === 'string') {
        setOrDelete(column, 'comparator', find('comparators', definition.comparator));
    }

    if (typeof definition.editable === 'string') {
        const predicate = find('editablePredicates', definition.editable);

        column.editable = predicate ?? false;
    }

    if (typeof editablePredicate === 'string') {
        const predicate = find('editablePredicates', editablePredicate);

        column.editable = predicate ?? false;
    }

    if (typeof definition.cellClass === 'string') {
        column.cellClass = resolver.lookup('cellClassRules', definition.cellClass) ?? definition.cellClass;
    }

    if (typeof cellClassPredicate === 'string') {
        const rule = find('cellClassRules', cellClassPredicate);

        if (rule) {
            column.cellClass = rule;
        }
    }

    if (definition.filterParams) {
        column.filterParams = resolveFilterParams(definition, find);
    }

    if (dataType) {
        applyDataTypeDefaults(column, dataType);
    }

    if (readOnly) {
        column.editable = false;
    }

    return column;
}

function resolveFilterParams<TData>(
    definition: LeafDefinition<TData>,
    find: <K extends RegistryKind>(kind: K, key: string) => RegistryEntry<TData, K> | undefined
): Record<string, unknown> {
    const params: Record<string, unknown> = { ...definition.filterParams };

    if (typeof params.keyCreator === 'string') {
        setOrDelete(params, 'keyCreator', find('keyCreators', params.keyCreator));
    }

    if (typeof params.valueFormatter === 'string') {
        setOrDelete(params, 'valueFormatter', find('valueFormatters', params.valueFormatter));
    }

    // Matches `withBlankSetFilterValue`: set filters always offer a blank choice.
    if (definition.filter === 'set' && Array.isArray(params.values) && !params.values.includes(null)) {
        params.values = [null, ...params.values];
    }

    return params;
}

function applyDataTypeDefaults<TData>(column: LeafDefinition<TData>, dataType: DataTypeDefinition<TData>): void {
    if (column.valueFormatter === undefined && dataType.valueFormatter) {
        column.valueFormatter = dataType.valueFormatter;
    }

    if (column.keyCreator === undefined && dataType.keyCreator) {
        column.keyCreator = dataType.keyCreator;
    }

    if (column.cellEditor === undefined && dataType.editor) {
        column.cellEditor = dataType.editor;
    }

    if (column.comparator === undefined && dataType.comparator) {
        column.comparator = dataType.comparator;
    }

    if (column.filter === undefined && dataType.filter) {
        column.filter = dataType.filter;
    }
}
