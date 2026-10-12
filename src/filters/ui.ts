/**
 * Headless building blocks for filter UIs: a filter bar, a column menu's filter section, or anything else.
 * The grid renders no filter UI of its own. These helpers give that UI the operators a column offers, a
 * fresh condition, which conditions apply, how the UI's conditions merge into the grid's filter model,
 * set choices (static or searched on a server), dates in the backend's format, and filters from the URL.
 *
 * Everything works on plain filter models, so a saved view restores the same conditions it saved.
 */
import type { FilterOptionDef } from '../contract/filters';
import type { FilterKind } from '../contract/filters';
import type { CustomFilterCondition, FilterCondition, FilterModel, QueryState } from '../contract/state';
import { isConditionActive } from './evaluate';

type AnyCondition = FilterCondition | CustomFilterCondition;

/** One operator a filter UI offers: stored in the condition's `type` as `key`. */
export type FilterOperator = {
    key: string;
    label: string;
    /** Inputs the operator takes: 0 for blank and not blank, 2 for in range. */
    inputs: 0 | 1 | 2;
};

/** Each built-in kind's operators, in the order a UI offers them by default. */
export const KIND_OPERATORS: Readonly<Record<string, readonly string[]>> = {
    text: ['contains', 'notContains', 'equals', 'notEqual', 'startsWith', 'endsWith', 'blank', 'notBlank'],
    number: [
        'equals',
        'notEqual',
        'lessThan',
        'lessThanOrEqual',
        'greaterThan',
        'greaterThanOrEqual',
        'inRange',
        'blank',
        'notBlank',
    ],
    date: ['equals', 'notEqual', 'lessThan', 'greaterThan', 'inRange', 'blank', 'notBlank'],
    set: ['anyOf', 'noneOf'],
    boolean: ['equals'],
    coordinates: ['withinRadius'],
};

/** English labels; pass your own to `filterOperators` to translate or rename ("is before" for dates). */
export const DEFAULT_OPERATOR_LABELS: Readonly<Record<string, string>> = {
    equals: 'Equals',
    notEqual: 'Does not equal',
    contains: 'Contains',
    notContains: 'Does not contain',
    startsWith: 'Starts with',
    endsWith: 'Ends with',
    blank: 'Blank',
    notBlank: 'Not blank',
    lessThan: 'Less than',
    lessThanOrEqual: 'Less than or equal to',
    greaterThan: 'Greater than',
    greaterThanOrEqual: 'Greater than or equal to',
    inRange: 'Between',
    anyOf: 'Is any of',
    noneOf: 'Is none of',
    withinRadius: 'Within radius',
};

const inputsOf = (key: string): 0 | 1 | 2 => (key === 'blank' || key === 'notBlank' ? 0 : key === 'inRange' ? 2 : 1);

/**
 * The operators a column offers: its `filterParams.filterOptions` (names and custom operators, in order)
 * or every operator of its kind. `labels` override per operator key, and per kind with `"<kind>.<key>"`.
 */
export function filterOperators(
    kind: string,
    filterParams: Readonly<Record<string, unknown>> = {},
    labels: Readonly<Record<string, string>> = {}
): FilterOperator[] {
    const label = (key: string) => labels[`${kind}.${key}`] ?? labels[key] ?? DEFAULT_OPERATOR_LABELS[key] ?? key;
    const options = filterParams.filterOptions as (string | FilterOptionDef)[] | undefined;
    if (!Array.isArray(options) || options.length === 0) {
        return (KIND_OPERATORS[kind] ?? []).map((key) => ({ key, label: label(key), inputs: inputsOf(key) }));
    }

    return options.map((option) =>
        typeof option === 'string'
            ? { key: option, label: label(option), inputs: inputsOf(option) }
            : {
                  key: option.displayKey,
                  label: labels[option.displayKey] ?? option.displayName,
                  inputs: option.numberOfInputs ?? 1,
              }
    );
}

/**
 * A fresh condition for a column, before the user fills it in: the `defaultOption` operator, or the first
 * one offered. It does not apply until it is complete (`isConditionActive`).
 */
export function defaultCondition(kind: string, filterParams: Readonly<Record<string, unknown>> = {}): AnyCondition {
    const operators = filterOperators(kind, filterParams);
    const preferred = filterParams.defaultOption as string | undefined;
    const type = operators.find((operator) => operator.key === preferred)?.key ?? operators[0]?.key;
    switch (kind) {
        case 'set':
            return { filterType: 'set', type: (type as 'anyOf' | 'noneOf' | undefined) ?? 'anyOf', values: [] };
        case 'boolean':
            return { filterType: 'boolean', type: 'equals', filter: null };
        case 'date':
            return { filterType: 'date', type: type ?? 'equals', dateFrom: null, dateTo: null } as AnyCondition;
        case 'number':
            return { filterType: 'number', type: type ?? 'equals', filter: null, filterTo: null } as AnyCondition;
        default:
            return type ? { filterType: kind, type, filter: null } : { filterType: kind };
    }
}

/**
 * Splits a filter model into the conditions a UI owns (`owns(colId)`) and the rest, which it must leave
 * alone: conditions set by the map, by code, or on columns the UI does not show.
 */
export function partitionFilterModel(
    model: FilterModel,
    owns: (colId: string) => boolean
): { owned: FilterModel; others: FilterModel } {
    const owned: FilterModel = {};
    const others: FilterModel = {};
    for (const [colId, condition] of Object.entries(model)) {
        (owns(colId) ? owned : others)[colId] = condition;
    }

    return { owned, others };
}

/**
 * The model a UI applies: its own conditions that are complete, merged over the conditions it does not
 * own. Incomplete conditions (a pill still being filled in) stay in the UI and out of the grid.
 * `filterParams(colId)` gives each column's options for custom operators; `kinds` adds registered kinds.
 */
export function mergeFilterModel(
    owned: FilterModel,
    others: FilterModel,
    options: {
        filterParams?: (colId: string) => Readonly<Record<string, unknown>> | undefined;
        kinds?: Readonly<Record<string, FilterKind>>;
    } = {}
): FilterModel {
    const merged: FilterModel = { ...others };
    for (const [colId, condition] of Object.entries(owned)) {
        if (isConditionApplicable(condition, options.filterParams?.(colId) ?? {}, options.kinds)) {
            merged[colId] = condition;
        } else {
            delete merged[colId];
        }
    }

    return merged;
}

/**
 * Whether a UI should apply a condition: it is active (`isConditionActive`), is not an empty set
 * selection (the server reads an empty `anyOf` as "match nothing"), and a range has both ends.
 */
export function isConditionApplicable(
    condition: AnyCondition,
    filterParams: Readonly<Record<string, unknown>> = {},
    kinds?: Readonly<Record<string, FilterKind>>
): boolean {
    const children = (condition as { conditions?: AnyCondition[] }).conditions;
    if (Array.isArray(children)) {
        return children.some((child) => isConditionApplicable(child, filterParams, kinds));
    }
    if (condition.filterType === 'set' && ((condition as { values?: unknown[] }).values ?? []).length === 0) {
        return false;
    }
    // A range needs both ends in a filter UI (the kinds read a missing end as open).
    const value = condition as { type?: string; filterTo?: unknown; dateTo?: unknown };
    if (value.type === 'inRange') {
        const to = condition.filterType === 'date' ? value.dateTo : value.filterTo;
        if (to === null || to === undefined || to === '') {
            return false;
        }
    }

    return isConditionActive(condition as FilterCondition, filterParams, kinds);
}

/** Whether two filter models ask for the same rows, ignoring key order. */
export function sameFilterModel(a: FilterModel, b: FilterModel): boolean {
    return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
    }

    return JSON.stringify(value);
}

/** A date in the format date filters send: `YYYY-MM-DD 00:00:00`, from the date's local calendar day. */
export function formatFilterDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 00:00:00`;
}

/** The local calendar day of a filter date string (`YYYY-MM-DD` with an optional time), or null. */
export function parseFilterDate(value: string | null | undefined): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.exec(value ?? '');
    if (!match) {
        return null;
    }
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

    return date.getMonth() === Number(match[2]) - 1 ? date : null;
}

/**
 * Filters and search from a URL: `q` becomes the search, and each `filter[colId]=value` a condition
 * (by default text contains; a repeated parameter keeps all its values). `toCondition` maps them
 * differently; return null to skip one.
 */
export function queryFromUrl(
    params: URLSearchParams,
    options: {
        searchParam?: string;
        toCondition?: (colId: string, value: string | string[]) => AnyCondition | null;
    } = {}
): Partial<QueryState> {
    const searchParam = options.searchParam ?? 'q';
    const values = new Map<string, string[]>();
    for (const [key, value] of params) {
        const match = /^filter\[(.+)\]$/.exec(key);
        if (match) {
            values.set(match[1]!, [...(values.get(match[1]!) ?? []), value]);
        }
    }
    const toCondition =
        options.toCondition ??
        ((_colId: string, value: string | string[]) =>
            ({ filterType: 'text', type: 'contains', filter: value }) as unknown as AnyCondition);
    const filterModel: FilterModel = {};
    for (const [colId, entries] of values) {
        const condition = toCondition(colId, entries.length === 1 ? entries[0]! : entries);
        if (condition) {
            filterModel[colId] = condition;
        }
    }
    const search = params.get(searchParam);

    return {
        ...(Object.keys(filterModel).length > 0 ? { filterModel } : {}),
        ...(search !== null ? { search } : {}),
    };
}

/** One choice of a set filter. `value` null is the blank choice. */
export type SetChoice = { value: string | null; label: string };

/**
 * Where a set filter's choices come from. `search` returns the choices matching the typed text (all of
 * them, or the first page, for an empty text). `resolve` returns the choices for selected values that a
 * search has not returned, so their labels can show.
 */
export type SetChoicesSource = {
    search(text: string, signal: AbortSignal): Promise<SetChoice[]>;
    resolve?(values: string[], signal: AbortSignal): Promise<SetChoice[]>;
};

/**
 * Choices from a fixed list: strings, or `{ id, label }` (ids become text; entries without an id are
 * skipped). A blank choice comes first unless `blankLabel` is false. Search matches labels, ignoring case.
 */
export function staticSetChoices(
    values: readonly (string | { id: string | number | null; label: string } | null)[],
    options: { blankLabel?: string | false } = {}
): SetChoicesSource {
    const choices: SetChoice[] = [];
    if (options.blankLabel !== false) {
        choices.push({ value: null, label: options.blankLabel ?? '(Blank)' });
    }
    for (const entry of values) {
        // A blank entry in the values (a backend sends `null`) is the blank choice added above.
        if (entry === null || entry === undefined) {
            continue;
        }
        if (typeof entry === 'string') {
            choices.push({ value: entry, label: entry });
        } else if (entry.id !== null && entry.id !== undefined) {
            choices.push({ value: String(entry.id), label: entry.label });
        }
    }

    return {
        search: async (text) => {
            const needle = text.trim().toLowerCase();

            return needle === '' ? choices : choices.filter((choice) => choice.label.toLowerCase().includes(needle));
        },
        resolve: async (wanted) => choices.filter((choice) => choice.value !== null && wanted.includes(choice.value)),
    };
}

/**
 * Choices searched on a grid endpoint: `GET url?startRow=0&endRow=<pageSize>&fields=id,<labelField>&q=`,
 * read as `{ data: [{ id, [labelField] }] }`. Selected values resolve by asking the same endpoint for
 * `filterModel={"id":{"filterType":"set","values":[...]}}`.
 */
export function httpSetChoices(options: {
    url: string;
    labelField: string;
    valueField?: string;
    pageSize?: number;
    fetch?: typeof fetch;
    init?: RequestInit;
}): SetChoicesSource {
    const valueField = options.valueField ?? 'id';
    const request = async (params: URLSearchParams, signal: AbortSignal): Promise<SetChoice[]> => {
        const separator = options.url.includes('?') ? '&' : '?';
        const response = await (options.fetch ?? fetch)(`${options.url}${separator}${params}`, {
            ...options.init,
            headers: { Accept: 'application/json', ...options.init?.headers },
            signal,
        });
        if (!response.ok) {
            throw new Error(`Choices request failed: ${response.status} ${response.statusText}`);
        }
        const body = (await response.json()) as { data?: Record<string, unknown>[] };

        return (body.data ?? []).map((row) => ({
            value: String(row[valueField]),
            label: String(row[options.labelField] ?? ''),
        }));
    };
    const base = (count: number) => {
        const params = new URLSearchParams();
        params.set('startRow', '0');
        params.set('endRow', String(count));
        params.set('fields', `${valueField},${options.labelField}`);

        return params;
    };

    return {
        search: (text, signal) => {
            const params = base(options.pageSize ?? 20);
            if (text.trim() !== '') {
                params.set('q', text.trim());
            }

            return request(params, signal);
        },
        resolve: (values, signal) => {
            const params = base(values.length);
            params.set('filterModel', JSON.stringify({ [valueField]: { filterType: 'set', values } }));

            return request(params, signal);
        },
    };
}

/** Choices with the selected ones first, in their selection order, then the rest. */
export function selectedFirst(choices: readonly SetChoice[], selected: readonly (string | null)[]): SetChoice[] {
    const chosen = new Set(selected);
    const byValue = new Map(choices.map((choice) => [choice.value, choice]));
    const first = selected.map((value) => byValue.get(value)).filter((choice): choice is SetChoice => Boolean(choice));

    return [...first, ...choices.filter((choice) => !chosen.has(choice.value))];
}
