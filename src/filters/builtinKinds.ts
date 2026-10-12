/**
 * The built-in filter kinds. Their defaults give conditions the same meaning a server that filters with
 * Typesense gives them, so a grid answers the same whether its rows are local or remote; `filterParams` options (the common option names) change that per column.
 *
 * - Invalid conditions (missing input, unknown operator, an empty `noneOf`, coordinates off the globe)
 *   filter nothing, as the server drops them.
 * - Blank is the server's rule: null, undefined, an empty string, or an array or plain object whose entries
 *   are all blank. Whitespace is not blank.
 * - Text ignores case and surrounding whitespace by default; `contains` is a substring test.
 * - Number inputs may be numeric strings, as the server reads them with `is_numeric`.
 * - Number and date `inRange` include both ends by default; without an upper bound it means "at least".
 * - A blank value passes no comparison unless an `includeBlanksIn*` option says so; a value that is not
 *   blank but not a number or date never matches.
 * - Dates compare as instants; `YYYY-MM-DD` means local midnight.
 * - Set: values compare as text; `null` in `values` stands for blank. An empty `anyOf` matches nothing.
 *   Array values match when any element matches.
 * - Coordinates match points within the radius (km, mi or m), by great-circle distance.
 *
 * Custom operators (`filterOptions` entries with a `predicate`) work on every kind except set.
 */
import type {
    BooleanFilter,
    CoordinatesFilter,
    DateFilter,
    DateFilterOptions,
    FilterKind,
    FilterOptionDef,
    NumberFilter,
    ScalarFilterOptions,
    SetFilter,
    SetFilterOptions,
    TextFilter,
    TextFilterOptions,
} from '../contract';

/**
 * Blank as the server defines it: null, undefined or an empty string,
 * or an array or plain object whose entries are all blank. Whitespace is not blank.
 */
export function isBlank(value: unknown): boolean {
    if (value === null || value === undefined || value === '') {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isBlank);
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.values(value as Record<string, unknown>).every(isBlank);
    }

    return false;
}

/** The custom operator a condition uses, if `filterOptions` defines one with a predicate. */
function customOperator(type: unknown, options: Readonly<Record<string, unknown>>): FilterOptionDef | undefined {
    const defs = (options as { filterOptions?: (string | FilterOptionDef)[] }).filterOptions ?? [];

    return defs.find(
        (def): def is FilterOptionDef =>
            typeof def === 'object' && def.displayKey === type && typeof def.predicate === 'function'
    );
}

const TEXT_OPERATORS = new Set([
    'equals',
    'notEqual',
    'contains',
    'notContains',
    'startsWith',
    'endsWith',
    'blank',
    'notBlank',
]);
const SCALAR_OPERATORS = new Set([
    'equals',
    'notEqual',
    'lessThan',
    'lessThanOrEqual',
    'greaterThan',
    'greaterThanOrEqual',
    'inRange',
    'blank',
    'notBlank',
]);
const isBlankOperator = (type: string) => type === 'blank' || type === 'notBlank';
const hasText = (value: unknown) => value !== null && value !== undefined && value !== '';

export const textFilterKind: FilterKind<unknown, TextFilter> = {
    isValid(condition, options) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.numberOfInputs === 0 || hasText(condition.filter);
        }

        return TEXT_OPERATORS.has(condition.type) && (isBlankOperator(condition.type) || hasText(condition.filter));
    },
    matches(condition, value, { options }) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.predicate!([condition.filter], value);
        }
        if (condition.type === 'blank') {
            return isBlank(value);
        }
        if (condition.type === 'notBlank') {
            return !isBlank(value);
        }
        const textOptions = options as TextFilterOptions;
        const normalise = (input: unknown): string => {
            let text = toText(input);
            if (textOptions.trimInput !== false) {
                text = text.trim();
            }
            if (!textOptions.caseSensitive) {
                text = text.toLowerCase();
            }

            return textOptions.textFormatter ? textOptions.textFormatter(text) : text;
        };
        const filterText = normalise(condition.filter);
        const values = (Array.isArray(value) ? value : [value]).map(normalise);
        if (textOptions.textMatcher) {
            // A text matcher replaces the matching altogether, negations included.
            return values.some((text) =>
                textOptions.textMatcher!({ operator: condition.type, value: text, filterText })
            );
        }
        const test = (text: string): boolean => {
            switch (condition.type) {
                case 'equals':
                case 'notEqual':
                    return text === filterText;
                case 'contains':
                case 'notContains':
                    return text.includes(filterText);
                case 'startsWith':
                    return text.startsWith(filterText);
                case 'endsWith':
                    return text.endsWith(filterText);
                default:
                    return true;
            }
        };
        const hit = values.some(test);

        return condition.type === 'notEqual' || condition.type === 'notContains' ? !hit : hit;
    },
};

/**
 * Compares a cell with the condition's bounds. `actual` is null when the cell has no number (or date);
 * `blank` says whether that is because the cell is blank, which `includeBlanksIn*` can let through, or
 * because it holds something else, which never matches.
 */
function compareScalar(
    type: string,
    actual: number | null,
    from: number,
    to: number | null,
    options: ScalarFilterOptions,
    blank: boolean
): boolean {
    if (actual === null) {
        if (!blank) {
            return false;
        }
        // A blank value passes no comparison, as a document without the field matches no range or equality
        // filter on the server, unless the column asks for blanks.
        switch (type) {
            case 'equals':
                return options.includeBlanksInEquals === true;
            case 'notEqual':
                return options.includeBlanksInNotEqual === true;
            case 'lessThan':
            case 'lessThanOrEqual':
                return options.includeBlanksInLessThan === true;
            case 'greaterThan':
            case 'greaterThanOrEqual':
                return options.includeBlanksInGreaterThan === true;
            case 'inRange':
                return options.includeBlanksInRange === true;
            default:
                return false;
        }
    }
    switch (type) {
        case 'equals':
            return actual === from;
        case 'notEqual':
            return actual !== from;
        case 'lessThan':
            return actual < from;
        case 'lessThanOrEqual':
            return actual <= from;
        case 'greaterThan':
            return actual > from;
        case 'greaterThanOrEqual':
            return actual >= from;
        case 'inRange': {
            if (to === null) {
                return actual >= from;
            }
            const low = Math.min(from, to);
            const high = Math.max(from, to);

            return options.inRangeInclusive === false ? actual > low && actual < high : actual >= low && actual <= high;
        }
        default:
            return true;
    }
}

export const numberFilterKind: FilterKind<unknown, NumberFilter> = {
    isValid(condition, options) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.numberOfInputs === 0 || toNumber(condition.filter) !== null;
        }

        return (
            SCALAR_OPERATORS.has(condition.type) &&
            (isBlankOperator(condition.type) || toNumber(condition.filter) !== null)
        );
    },
    matches(condition, value, { options }) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.predicate!([condition.filter, condition.filterTo], value);
        }
        if (condition.type === 'blank') {
            return isBlank(value);
        }
        if (condition.type === 'notBlank') {
            return !isBlank(value);
        }

        return compareScalar(
            condition.type,
            toNumber(value),
            toNumber(condition.filter)!,
            toNumber(condition.filterTo),
            options as ScalarFilterOptions,
            isBlank(value)
        );
    },
};

export const dateFilterKind: FilterKind<unknown, DateFilter> = {
    isValid(condition, options) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.numberOfInputs === 0 || toInstant(condition.dateFrom) !== null;
        }

        return (
            SCALAR_OPERATORS.has(condition.type) &&
            (isBlankOperator(condition.type) || toInstant(condition.dateFrom) !== null)
        );
    },
    matches(condition, value, { options }) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.predicate!([condition.dateFrom, condition.dateTo], value);
        }
        if (condition.type === 'blank') {
            return isBlank(value);
        }
        if (condition.type === 'notBlank') {
            return !isBlank(value);
        }
        const dateOptions = options as DateFilterOptions;
        const from = toInstant(condition.dateFrom)!;
        const to = toInstant(condition.dateTo);
        if (dateOptions.comparator) {
            if (isBlank(value)) {
                return compareScalar(condition.type, null, 0, null, dateOptions, true);
            }
            // The comparator gives the cell's position relative to a filter date: negative before, positive after.
            const fromPosition = dateOptions.comparator(new Date(from), value);
            const toPosition = to === null ? null : dateOptions.comparator(new Date(to), value);
            const inclusive = dateOptions.inRangeInclusive !== false;
            switch (condition.type) {
                case 'equals':
                    return fromPosition === 0;
                case 'notEqual':
                    return fromPosition !== 0;
                case 'lessThan':
                    return fromPosition < 0;
                case 'lessThanOrEqual':
                    return fromPosition <= 0;
                case 'greaterThan':
                    return fromPosition > 0;
                case 'greaterThanOrEqual':
                    return fromPosition >= 0;
                case 'inRange':
                    return (
                        (inclusive ? fromPosition >= 0 : fromPosition > 0) &&
                        (toPosition === null || (inclusive ? toPosition <= 0 : toPosition < 0))
                    );
                default:
                    return true;
            }
        }

        return compareScalar(condition.type, toInstant(value), from, to, dateOptions, isBlank(value));
    },
};

export const setFilterKind: FilterKind<unknown, SetFilter> = {
    // An empty "none of" excludes nothing, so the server drops it.
    isValid: (condition) =>
        Array.isArray(condition.values) && !(condition.type === 'noneOf' && condition.values.length === 0),
    matches(condition, value, { key, options }) {
        const caseSensitive = (options as SetFilterOptions).caseSensitive === true;
        const fold = (text: string) => (caseSensitive ? text : text.toLowerCase());
        const noneOf = condition.type === 'noneOf';
        // The server reads every value as text.
        const wanted = new Set(condition.values.filter((entry) => entry !== null).map((entry) => fold(String(entry))));
        const includesBlank = condition.values.includes(null);
        if (wanted.size === 0 && !includesBlank) {
            return noneOf;
        }
        const keys = (Array.isArray(value) ? value : [value]).filter((entry) => !isBlank(entry)).map(key);
        const hit =
            (includesBlank && isBlank(value)) || keys.some((entry) => entry !== null && wanted.has(fold(entry)));

        return noneOf ? !hit : hit;
    },
};

export const booleanFilterKind: FilterKind<unknown, BooleanFilter> = {
    isValid(condition, options) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.numberOfInputs === 0 || toBoolean(condition.filter) !== null;
        }

        return toBoolean(condition.filter) !== null;
    },
    matches(condition, value, { options }) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.predicate!([condition.filter], value);
        }

        return toBoolean(value) === toBoolean(condition.filter);
    },
};

const EARTH_RADIUS_KM = 6371.0088;

export const coordinatesFilterKind: FilterKind<unknown, CoordinatesFilter> = {
    isValid(condition, options) {
        if (customOperator(condition.type, options)) {
            return true;
        }
        const filter = condition.filter;
        const latitude = Number(filter?.latitude);
        const longitude = Number(filter?.longitude);

        // The server rejects coordinates outside the globe (`validateCoordinates`), which drops the filter.
        return (
            Number.isFinite(latitude) &&
            Number.isFinite(longitude) &&
            Math.abs(latitude) <= 90 &&
            Math.abs(longitude) <= 180 &&
            Number.isFinite(Number(filter?.radius?.value))
        );
    },
    matches(condition, value, { options }) {
        const custom = customOperator(condition.type, options);
        if (custom) {
            return custom.predicate!([condition.filter], value);
        }
        const point = toPoint(value);
        if (!point) {
            return false;
        }
        const latitude = Number(condition.filter.latitude);
        const longitude = Number(condition.filter.longitude);
        const radius = Number(condition.filter.radius.value);
        const unit = condition.filter.radius.unit;
        // The server's coordinate conversions.
        const limitKm = unit === 'mi' ? radius * 1.60934 : unit === 'm' ? radius / 1000 : radius;
        const rad = (degrees: number) => (degrees * Math.PI) / 180;
        const dLat = rad(point.latitude - latitude);
        const dLon = rad(point.longitude - longitude);
        const a =
            Math.sin(dLat / 2) ** 2 + Math.cos(rad(latitude)) * Math.cos(rad(point.latitude)) * Math.sin(dLon / 2) ** 2;

        return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a))) <= limitKm;
    },
};

/** The built-in kinds by `filterType`. Applications override or extend them through `registry.filters`. */
export const BUILTIN_FILTER_KINDS: Readonly<Record<string, FilterKind>> = {
    text: textFilterKind,
    number: numberFilterKind,
    date: dateFilterKind,
    set: setFilterKind,
    boolean: booleanFilterKind,
    coordinates: coordinatesFilterKind,
};

function toText(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const label = record.label ?? record.name ?? record.title;

        return typeof label === 'string' ? label : '';
    }

    return String(value);
}

function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : null;
    }
    if (value && typeof value === 'object' && 'amount' in value) {
        return toNumber((value as { amount: unknown }).amount);
    }

    return null;
}

/** `YYYY-MM-DD` and `YYYY-MM-DD HH:mm:ss` as local instants, like the server's `strtotime`. */
export function toInstant(value: unknown): number | null {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.getTime();
    }
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) {
        const parsed = Date.parse(value);

        return Number.isNaN(parsed) ? null : parsed;
    }
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;

    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
    ).getTime();
}

function toBoolean(value: unknown): boolean | null {
    if (value === true || value === 'true' || value === 1 || value === '1') {
        return true;
    }
    if (value === false || value === 'false' || value === 0 || value === '0') {
        return false;
    }

    return null;
}

function toPoint(value: unknown): { latitude: number; longitude: number } | null {
    if (Array.isArray(value) && value.length === 2) {
        const [latitude, longitude] = value.map(Number);

        return Number.isFinite(latitude) && Number.isFinite(longitude)
            ? { latitude: latitude!, longitude: longitude! }
            : null;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const latitude = Number(record.latitude ?? record.lat);
        const longitude = Number(record.longitude ?? record.lng ?? record.lon);

        return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
    }

    return null;
}
