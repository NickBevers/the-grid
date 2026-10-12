/**
 * Filter kinds: what a filter condition means, so rows can be filtered locally. A column picks its kind with
 * `filter` and tunes it with `filterParams`. The built-in kinds (text, number, date, set, boolean,
 * coordinates) are registered the same way an application's own kinds are, so any of them can be replaced.
 *
 * Server grids send the model to the backend unchanged; kinds matter there only for the filter UI.
 */
import type { RowWithData } from './rows';

/** Context for evaluating one condition against one row. */
export type FilterMatchContext<TData> = {
    colId: string;
    row: RowWithData<TData>;
    /** The column's `filterParams`. */
    options: Readonly<Record<string, unknown>>;
    /** The comparable key of a value, for set-style filters: the column's `keyCreator`, or the value as text. */
    key(value: unknown): string | null;
};

/**
 * A filter kind. `isValid` mirrors the server: a condition that is not valid (missing input, unknown
 * operator) filters nothing. `matches` decides whether a value passes a valid condition.
 */
export type FilterKind<TData = any, TCondition extends { filterType: string } = any> = {
    isValid(condition: TCondition, options: Readonly<Record<string, unknown>>): boolean;
    matches(condition: TCondition, value: unknown, context: FilterMatchContext<TData>): boolean;
};

/**
 * A custom operator, in the common shape so existing definitions carry over: shown as `displayName`, stored
 * in the condition's `type` as `displayKey`. `predicate` receives the condition's inputs (`filter`, then
 * `filterTo`, or `dateFrom`, `dateTo`) and the cell value.
 */
export type FilterOptionDef = {
    displayKey: string;
    displayName: string;
    numberOfInputs?: 0 | 1 | 2;
    predicate?: (filterValues: unknown[], cellValue: unknown) => boolean;
};

/** Options every built-in kind reads from `filterParams`. */
export type FilterOptionsBase = {
    /** Operators offered, in order, and custom operators. Default: all of the kind's operators. */
    filterOptions?: (string | FilterOptionDef)[];
    defaultOption?: string;
    /** How many conditions the filter UI allows (joined by AND or OR). Default 2. */
    maxNumConditions?: number;
};

export type TextFilterOptions = FilterOptionsBase & {
    /** Default false: matching ignores case, as the server does. */
    caseSensitive?: boolean;
    /** Default true: surrounding whitespace in the input and the value is ignored. */
    trimInput?: boolean;
    /** Normalises both sides before matching, for example to strip accents. */
    textFormatter?: (text: string) => string;
    /** Replaces the matching altogether. */
    textMatcher?: (params: { operator: string; value: string; filterText: string }) => boolean;
};

export type ScalarFilterOptions = FilterOptionsBase & {
    /** Default true, as the server compares ranges inclusively (a common default elsewhere is false). */
    inRangeInclusive?: boolean;
    includeBlanksInEquals?: boolean;
    includeBlanksInNotEqual?: boolean;
    includeBlanksInLessThan?: boolean;
    includeBlanksInGreaterThan?: boolean;
    includeBlanksInRange?: boolean;
};

export type NumberFilterOptions = ScalarFilterOptions;

export type DateFilterOptions = ScalarFilterOptions & {
    /**
     * Compares the filter date (local midnight) with a cell value: negative when the cell is before it,
     * positive after, 0 the same. Default: the cell parsed as `YYYY-MM-DD[ HH:mm:ss]` in local time.
     */
    comparator?: (filterDate: Date, cellValue: unknown) => number;
};

export type SetFilterOptions = FilterOptionsBase & {
    /** Default false. */
    caseSensitive?: boolean;
};
