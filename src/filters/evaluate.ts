/**
 * Turns a filter model into a row predicate for local data. Each condition goes to the filter kind named by
 * its `filterType`, with the column's `filterParams` as options. Entries for columns the grid does not know
 * stay in the model but cannot be evaluated locally, so they are skipped; a condition whose kind is not
 * registered is reported through `onUnknownKind` and skipped, never guessed.
 */
import type {
    CombinedFilter,
    CustomFilterCondition,
    FilterCondition,
    FilterKind,
    FilterModel,
    ResolvedColumn,
    RowWithData,
} from '../contract';
import { BUILTIN_FILTER_KINDS } from './builtinKinds';

export type FilterEvaluatorOptions<TData> = {
    /** Registered kinds, merged over the built-ins. */
    kinds?: Readonly<Record<string, FilterKind<TData>>>;
    column(colId: string): ResolvedColumn<TData> | undefined;
    onUnknownKind?(miss: { filterType: string; colId: string }): void;
};

type AnyCondition = FilterCondition | CustomFilterCondition;

/** A predicate for the model, or null when no condition is active (nothing to filter). */
export function createFilterPredicate<TData>(
    model: FilterModel,
    options: FilterEvaluatorOptions<TData>
): ((row: RowWithData<TData>) => boolean) | null {
    const kinds = { ...BUILTIN_FILTER_KINDS, ...options.kinds } as Record<string, FilterKind<TData>>;
    const tests: ((row: RowWithData<TData>) => boolean)[] = [];
    for (const [colId, condition] of Object.entries(model)) {
        const column = options.column(colId);
        if (!column) {
            continue;
        }
        const filterOptions = column.def.filterParams ?? {};
        const test = compile(condition, colId, column, filterOptions, kinds, options);
        if (test) {
            tests.push(test);
        }
    }

    return tests.length === 0 ? null : (row) => tests.every((test) => test(row));
}

/** A combined condition (several conditions joined by AND or OR), recognised as the server does. */
export function isCombinedFilter(condition: AnyCondition): condition is CombinedFilter {
    return (
        'operator' in condition && 'conditions' in condition && Array.isArray((condition as CombinedFilter).conditions)
    );
}

/** Whether a condition takes part at all: its kind is known and it is valid. */
export function isConditionActive<TData>(
    condition: AnyCondition,
    filterOptions: Readonly<Record<string, unknown>> = {},
    kinds: Readonly<Record<string, FilterKind<TData>>> = {}
): boolean {
    const all = { ...BUILTIN_FILTER_KINDS, ...kinds } as Record<string, FilterKind<TData>>;
    if (isCombinedFilter(condition)) {
        return condition.conditions.some(
            (child) => !isCombinedFilter(child) && isConditionActive(child, filterOptions, kinds)
        );
    }
    const kind = all[condition.filterType];

    return Boolean(kind && kind.isValid(condition, filterOptions));
}

function compile<TData>(
    condition: AnyCondition,
    colId: string,
    column: ResolvedColumn<TData>,
    filterOptions: Readonly<Record<string, unknown>>,
    kinds: Record<string, FilterKind<TData>>,
    options: FilterEvaluatorOptions<TData>
): ((row: RowWithData<TData>) => boolean) | null {
    if (isCombinedFilter(condition)) {
        // One level, as on the server: a combined condition nested inside another is dropped.
        const children = condition.conditions
            .filter((child) => !isCombinedFilter(child))
            .map((child) => compile(child, colId, column, filterOptions, kinds, options))
            .filter((test): test is (row: RowWithData<TData>) => boolean => test !== null);
        if (children.length === 0) {
            return null;
        }

        return condition.operator === 'OR'
            ? (row) => children.some((test) => test(row))
            : (row) => children.every((test) => test(row));
    }
    const kind = kinds[condition.filterType];
    if (!kind) {
        options.onUnknownKind?.({ filterType: condition.filterType, colId });

        return null;
    }
    if (!kind.isValid(condition, filterOptions)) {
        return null;
    }
    const filterValueGetter = typeof column.def.filterValueGetter === 'function' ? column.def.filterValueGetter : null;
    const keyCreator = typeof column.def.keyCreator === 'function' ? column.def.keyCreator : null;

    return (row) => {
        const value = filterValueGetter
            ? filterValueGetter({ row, data: row.data, column, context: undefined })
            : column.getValue(row);

        return kind.matches(condition, value, {
            colId,
            row,
            options: filterOptions,
            key: (entry) =>
                keyCreator
                    ? keyCreator({ row, data: row.data, column, context: undefined, value: entry })
                    : defaultKey(entry),
        });
    };
}

/** A set-style key: the id, value or key of an object, or the value as text. */
export function defaultKey(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const id = record.id ?? record.value ?? record.key;
        if (id !== undefined && id !== null) {
            return String(id);
        }
    }

    return String(value);
}
