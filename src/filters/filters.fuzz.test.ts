/**
 * Differential fuzz test of the built-in filter kinds (`createFilterPredicate`) against a reference model of a
 * server's filter rules: how it validates conditions, builds each filter kind for Typesense, combines column
 * filters with AND and OR, and decides what blank means.
 *
 * The reference answers, for one condition and one cell value, what rows the server would return:
 * - 'reject': the server validates every column condition at depth 0 and throws, so the
 *   request fails. Nothing to compare.
 * - 'undefined': the server sends Typesense a filter whose meaning we cannot model (an empty value after
 *   trimming, an empty string inside a set). Nothing to compare.
 * - 'none': the condition is dropped (isValid false, or the builder returns ''). Every row passes.
 * - a boolean: whether the row passes.
 *
 * Typesense matching is modelled as: text `contains` a case-insensitive substring, `equals` an exact
 * case-insensitive match, set values an exact case-insensitive match on the key, ranges `[a..b]` inclusive.
 * Assumption A: an exclusion (`:!=`, `:!`, `:![...]`) also returns documents where the field is missing or
 * blank. The local text and set kinds assume the same; see the 'negation of a blank number/date' divergence.
 *
 * Known differences are labelled (`divergence()`), counted, and pinned by the deterministic tests below. Any
 * other difference fails the fuzz with a shrunk reproduction.
 */
import { describe, expect, it } from 'vitest';

import type { ColumnDefinition, DataRow, FilterModel } from '../contract';
import { ColumnModel } from '../grid/columns';
import { createFilterPredicate } from './evaluate';

// Seeded PRNG (mulberry32)

function createRandom(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
    const chance = (probability: number): boolean => next() < probability;
    const subset = <T>(items: readonly T[], max = items.length): T[] => {
        const copy = [...items];
        const result: T[] = [];
        const count = int(0, Math.min(max, copy.length));
        for (let i = 0; i < count; i++) {
            result.push(copy.splice(int(0, copy.length - 1), 1)[0]!);
        }

        return result;
    };

    return { next, int, pick, chance, subset };
}

type Random = ReturnType<typeof createRandom>;
type Condition = Record<string, any>;

// The implementation, through a real column

type Row = { id: number; value: unknown };

function localPasses(condition: Condition, value: unknown, filterParams?: Record<string, unknown>): boolean {
    const definition = { field: 'value', ...(filterParams ? { filterParams } : {}) } as ColumnDefinition<Row>;
    const columns = new ColumnModel<Row>([definition]);
    const predicate = createFilterPredicate<Row>({ value: condition } as unknown as FilterModel, {
        column: (colId) => columns.getResolved(colId),
    });

    return predicate
        ? predicate({ kind: 'data', id: '1', level: 0, parentId: null, data: { id: 1, value } } as DataRow<Row>)
        : true;
}

// Reference helpers, written from the server-side filter rules

type Outcome = 'reject' | 'undefined' | 'none' | boolean;
type Compiled =
    | { kind: 'reject' }
    | { kind: 'undefined' }
    | { kind: 'none' }
    | { kind: 'test'; test: (value: unknown) => boolean };

const REJECT: Compiled = { kind: 'reject' };
const UNDEFINED: Compiled = { kind: 'undefined' };
const NONE: Compiled = { kind: 'none' };
const test = (fn: (value: unknown) => boolean): Compiled => ({ kind: 'test', test: fn });

/** The server's blank check: null or '' (not whitespace), or an array/object whose items are all empty. */
function serverBlank(value: unknown): boolean {
    if (value === null || value === undefined) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(serverBlank);
    }
    if (typeof value === 'object') {
        return Object.values(value as object).every(serverBlank);
    }

    return value === '';
}

/** A server's numeric check for the inputs generated here: numbers, and decimal strings with optional whitespace. */
function phpIsNumeric(value: unknown): boolean {
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }

    return typeof value === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(value);
}

/** A server's emptiness check: null, '', '0', 0, false. */
function phpEmpty(value: unknown): boolean {
    return value === null || value === undefined || value === '' || value === '0' || value === 0 || value === false;
}

/** The text a document holds for a cell value: strings, numbers, an object's label; arrays per element. */
function serverTexts(value: unknown): string[] {
    const one = (entry: unknown): string => {
        if (entry === null || entry === undefined) {
            return '';
        }
        if (typeof entry === 'object') {
            const label = (entry as Record<string, unknown>).label ?? (entry as Record<string, unknown>).name;

            return typeof label === 'string' ? label : '';
        }

        return String(entry);
    };

    return Array.isArray(value) ? value.map(one) : [one(value)];
}

function serverNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        return phpIsNumeric(value) ? Number(value) : null;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && 'amount' in value) {
        return serverNumber((value as { amount: unknown }).amount);
    }

    return null;
}

const VALID_DATE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/;

/** strtotime for `YYYY-MM-DD[ HH:mm:ss]` in the (shared) local time zone; null where strtotime is false. */
function serverInstant(value: unknown): number | null {
    if (typeof value !== 'string') {
        return null;
    }
    const match = value.match(VALID_DATE);
    if (!match) {
        return null;
    }
    const [, y, m, d, h = '0', mi = '0', s = '0'] = match;
    if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) {
        return null;
    }

    return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
}

const TEXT_OPERATORS = ['equals', 'notEqual', 'contains', 'notContains', 'startsWith', 'endsWith', 'blank', 'notBlank'];
const NUMBER_OPERATORS = [
    'equals',
    'notEqual',
    'lessThan',
    'lessThanOrEqual',
    'greaterThan',
    'greaterThanOrEqual',
    'inRange',
    'blank',
    'notBlank',
];
// The server's date operators have no lessThanOrEqual or greaterThanOrEqual.
const DATE_OPERATORS = ['equals', 'notEqual', 'lessThan', 'greaterThan', 'inRange', 'blank', 'notBlank'];

function compileText(condition: Condition): Compiled {
    const type = condition.type;
    // Server validation of a text condition.
    if (!TEXT_OPERATORS.includes(type)) {
        return REJECT;
    }
    if (type === 'blank') {
        return test((value) => serverBlank(value));
    }
    if (type === 'notBlank') {
        return test((value) => !serverBlank(value));
    }
    if (condition.filter === '' || !('filter' in condition) || condition.filter === undefined) {
        return REJECT;
    }
    // The server keeps a condition only when its filter value is not empty.
    if (phpEmpty(condition.filter)) {
        return NONE;
    }
    // The server trims a text value after escaping it.
    const filter = String(condition.filter).trim().toLowerCase();
    if (filter === '') {
        return UNDEFINED;
    }
    const negated = type === 'notEqual' || type === 'notContains';
    const matchOne = (text: string): boolean => {
        const normalised = text.trim().toLowerCase();
        switch (type) {
            case 'equals':
            case 'notEqual':
                return normalised === filter;
            case 'contains':
            case 'notContains':
                return normalised.includes(filter);
            case 'startsWith':
                return normalised.startsWith(filter);
            default:
                return normalised.endsWith(filter);
        }
    };

    return test((value) => {
        const hit = serverTexts(value).some(matchOne);

        return negated ? !hit : hit;
    });
}

function compileScalar(
    type: string,
    from: number,
    to: number | null,
    read: (value: unknown) => number | null
): Compiled {
    if (type === 'inRange' && to !== null && from > to) {
        // Typesense `[10..5]`: not modelled (the local kind swaps the bounds).
        return UNDEFINED;
    }

    return test((value) => {
        const actual = read(value);
        if (actual === null) {
            // A missing field matches no comparison; only an exclusion returns it (assumption A).
            return type === 'notEqual';
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
            default:
                return to === null ? actual >= from : actual >= from && actual <= to;
        }
    });
}

function compileNumber(condition: Condition): Compiled {
    const type = condition.type;
    // Server validation of a number condition.
    if (!NUMBER_OPERATORS.includes(type)) {
        return REJECT;
    }
    if (type === 'blank') {
        return test((value) => serverBlank(value));
    }
    if (type === 'notBlank') {
        return test((value) => !serverBlank(value));
    }
    const filter = condition.filter ?? null;
    const filterTo = condition.filterTo ?? null;
    if ((filter !== null && !phpIsNumeric(filter)) || (filterTo !== null && !phpIsNumeric(filterTo))) {
        return REJECT;
    }
    if (type === 'inRange' && (filter === null || filterTo === null)) {
        return REJECT;
    }
    // The server keeps a number condition only when its filter value is set.
    if (filter === null) {
        return NONE;
    }

    return compileScalar(type, Number(filter), filterTo === null ? null : Number(filterTo), serverNumber);
}

function compileDate(condition: Condition): Compiled {
    const type = condition.type;
    // Server validation of a date condition.
    if (!DATE_OPERATORS.includes(type)) {
        return REJECT;
    }
    if (type === 'blank') {
        return test((value) => serverBlank(value));
    }
    if (type === 'notBlank') {
        return test((value) => !serverBlank(value));
    }
    if (phpEmpty(condition.dateFrom)) {
        return REJECT;
    }
    const from = serverInstant(condition.dateFrom);
    if (from === null) {
        return REJECT;
    }
    let to: number | null = null;
    if (!phpEmpty(condition.dateTo)) {
        to = serverInstant(condition.dateTo);
        if (to === null) {
            return REJECT;
        }
    }

    // A date range with no end means `>= from` on the server.
    return compileScalar(type, from, type === 'inRange' ? to : null, (value) =>
        serverBlank(value) ? null : serverInstant(value)
    );
}

function setKey(entry: unknown): string | null {
    if (entry === null || entry === undefined || entry === '') {
        return null;
    }
    if (typeof entry === 'object') {
        const id = (entry as Record<string, unknown>).id;

        return id === null || id === undefined ? null : String(id);
    }

    return String(entry);
}

function compileSet(condition: Condition): Compiled {
    if (!Array.isArray(condition.values)) {
        return REJECT;
    }
    const includesBlank = condition.values.includes(null);
    const wanted = condition.values.filter((entry: unknown) => entry !== null).map((entry: unknown) => String(entry));
    if (wanted.includes('')) {
        // `field:[]` or a list with an empty item: not modelled.
        return UNDEFINED;
    }
    const noneOf = condition.type === 'noneOf';
    const lowered = new Set(wanted.map((entry: string) => entry.toLowerCase()));
    const inValues = (value: unknown): boolean =>
        (Array.isArray(value) ? value : [value]).some((entry) => {
            const key = setKey(entry);

            return key !== null && lowered.has(key.toLowerCase());
        });
    // How the server builds set filters, empty ones included.
    if (wanted.length === 0) {
        if (includesBlank) {
            return test((value) => (noneOf ? !serverBlank(value) : serverBlank(value)));
        }

        return noneOf ? NONE : test(() => false);
    }
    if (!includesBlank) {
        return test((value) => (noneOf ? !inValues(value) : inValues(value)));
    }

    return noneOf
        ? test((value) => !serverBlank(value) && !inValues(value))
        : test((value) => serverBlank(value) || inValues(value));
}

function serverBoolean(value: unknown): boolean | null {
    if (value === true || value === 'true' || value === 1 || value === '1') {
        return true;
    }
    if (value === false || value === 'false' || value === 0 || value === '0') {
        return false;
    }

    return null;
}

function compileBoolean(condition: Condition): Compiled {
    // Server validation of a boolean condition.
    if (!['equals', 'notEquals'].includes(condition.type)) {
        return REJECT;
    }
    if (condition.filter === null || condition.filter === undefined) {
        return REJECT;
    }
    const wanted = serverBoolean(condition.filter);
    if (wanted === null) {
        return REJECT;
    }

    // The server's boolean filter ignores the type: notEquals also builds `field:=value`.
    return test((value) => serverBoolean(value) === wanted);
}

const EARTH_RADIUS_KM = 6371.0088;

function point(value: unknown): { latitude: number; longitude: number } | null {
    if (Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === 'number')) {
        return { latitude: value[0] as number, longitude: value[1] as number };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const latitude = record.latitude ?? record.lat;
        const longitude = record.longitude ?? record.lng;
        if (typeof latitude === 'number' && typeof longitude === 'number') {
            return { latitude, longitude };
        }
    }

    return null;
}

function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
    const rad = (degrees: number) => (degrees * Math.PI) / 180;
    const h =
        Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
        Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;

    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Within this distance of the radius the result depends on Typesense's earth model: not compared. */
function nearBoundary(center: { latitude: number; longitude: number }, radiusKm: number, value: unknown): boolean {
    const target = point(value);

    return target !== null && Math.abs(distanceKm(center, target) - radiusKm) < radiusKm * 0.01 + 0.5;
}

function coordinatesCircle(filter: unknown): { latitude: number; longitude: number; radiusKm: number } | null {
    if (!filter || typeof filter !== 'object') {
        return null;
    }
    const record = filter as Record<string, any>;
    const radius = record.radius;
    const radiusValue = radius && typeof radius === 'object' ? radius.value : radius;
    const unit = radius && typeof radius === 'object' ? String(radius.unit ?? 'km').toLowerCase() : 'km';
    const factor = unit === 'mi' ? 1.60934 : unit === 'm' ? 0.001 : 1;

    return {
        latitude: Number(record.latitude),
        longitude: Number(record.longitude),
        radiusKm: Number(radiusValue) * factor,
    };
}

function compileCoordinates(condition: Condition): Compiled {
    const filter = condition.filter;
    // Server validation of a coordinates condition.
    if (filter === null || filter === undefined) {
        return REJECT;
    }
    if (typeof filter === 'string') {
        if (filter.trim() === '') {
            return REJECT;
        }
        const match = filter.trim().match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*),\s*(\d+\.?\d*)\s*(km|mi|m)?$/i);
        if (!match) {
            return NONE;
        }
        const circle = coordinatesCircle({
            latitude: match[1],
            longitude: match[2],
            radius: { value: match[3], unit: match[4] ?? 'km' },
        })!;
        if (Math.abs(circle.latitude) > 90 || Math.abs(circle.longitude) > 180) {
            return NONE;
        }

        return circleTest(circle);
    }
    if (typeof filter !== 'object') {
        return REJECT;
    }
    const radius = filter.radius;
    const radiusValue = radius && typeof radius === 'object' ? radius.value : radius;
    const unit = radius && typeof radius === 'object' ? (radius.unit ?? 'km') : 'km';
    if (!phpIsNumeric(filter.latitude) || !phpIsNumeric(filter.longitude) || !phpIsNumeric(radiusValue)) {
        return REJECT;
    }
    if (Number(radiusValue) <= 0 || !['km', 'mi', 'm'].includes(unit)) {
        return REJECT;
    }
    // The server rejects invalid coordinates inside the filter build, which then filters nothing.
    if (Math.abs(Number(filter.latitude)) > 90 || Math.abs(Number(filter.longitude)) > 180) {
        return NONE;
    }
    if (filter.metadata?.bounds?.southWest && filter.metadata?.bounds?.northEast) {
        // A polygon from the bounds: not modelled.
        return UNDEFINED;
    }

    return circleTest(coordinatesCircle(filter)!);
}

function circleTest(circle: { latitude: number; longitude: number; radiusKm: number }): Compiled {
    return test((value) => {
        const target = point(value);
        if (target === null) {
            return false;
        }
        if (nearBoundary(circle, circle.radiusKm, value)) {
            throw new BoundaryError();
        }

        return distanceKm(circle, target) <= circle.radiusKm;
    });
}

class BoundaryError extends Error {}

function compileLeaf(condition: Condition): Compiled {
    switch (condition.filterType) {
        case 'text':
            return compileText(condition);
        case 'number':
            return compileNumber(condition);
        case 'date':
            return compileDate(condition);
        case 'set':
            return compileSet(condition);
        case 'boolean':
            return compileBoolean(condition);
        case 'coordinates':
            return compileCoordinates(condition);
        default:
            // An unknown filter type is rejected: "Invalid filter type".
            return REJECT;
    }
}

const isCombined = (condition: Condition) => 'operator' in condition && Array.isArray(condition.conditions);

/**
 * A combined column condition, as the server reads it: an unknown operator means AND, every child is
 * validated at depth 0 (one invalid child rejects the request), children that build to '' are dropped, and no children left means no
 * filter. A combined child has no `type`, so the server rejects it ("Filter operation type is required"),
 * except for the set kind, which needs no type: it becomes an empty anyOf set and matches nothing.
 */
function compile(condition: Condition): Compiled {
    if (!isCombined(condition)) {
        return compileLeaf(condition);
    }
    const children: Compiled[] = condition.conditions.map((child: Condition) => {
        if (!isCombined(child)) {
            return compileLeaf(child);
        }
        if (
            child.filterType !== 'set' ||
            child.conditions.some((grandchild: Condition) => !('type' in grandchild) && grandchild.filterType !== 'set')
        ) {
            return REJECT;
        }

        return test(() => false);
    });
    if (children.some((child) => child.kind === 'reject')) {
        return REJECT;
    }
    if (children.some((child) => child.kind === 'undefined')) {
        return UNDEFINED;
    }
    const tests = children.flatMap((child) => (child.kind === 'test' ? [child.test] : []));
    if (tests.length === 0) {
        return NONE;
    }
    const or = condition.operator === 'OR';

    return test((value) => (or ? tests.some((fn) => fn(value)) : tests.every((fn) => fn(value))));
}

function serverOutcome(condition: Condition, value: unknown): Outcome | 'boundary' {
    const compiled = compile(condition);
    if (compiled.kind !== 'test') {
        return compiled.kind;
    }
    try {
        return compiled.test(value);
    } catch (error) {
        if (error instanceof BoundaryError) {
            return 'boundary';
        }
        throw error;
    }
}

// Known differences between the implementation and the backend, each pinned by a test below.

function leaves(condition: Condition): Condition[] {
    return isCombined(condition) ? condition.conditions.flatMap(leaves) : [condition];
}

function divergence(condition: Condition, value: unknown): string | null {
    if (
        isCombined(condition) &&
        condition.conditions.some((child: Condition) => isCombined(child) && child.filterType === 'set')
    ) {
        return 'a nested combined set condition matches nothing on the server';
    }
    for (const leaf of leaves(condition)) {
        if (
            leaf.filterType === 'text' &&
            TEXT_OPERATORS.includes(leaf.type) &&
            (leaf.filter === '0' || leaf.filter === 0)
        ) {
            return 'text filter "0" is dropped by the server';
        }
        const unreadable =
            leaf.filterType === 'number'
                ? serverNumber(value) === null
                : serverBlank(value) || serverInstant(value) === null;
        if ((leaf.filterType === 'number' || leaf.filterType === 'date') && leaf.type === 'notEqual' && unreadable) {
            return 'negation of a blank number/date';
        }
        if (
            (leaf.filterType === 'number' || leaf.filterType === 'date') &&
            Array.isArray(value) &&
            !serverBlank(value)
        ) {
            return 'arrays in number/date columns';
        }
        if (leaf.filterType === 'coordinates') {
            const filter = leaf.filter;
            if (typeof filter === 'string') {
                return 'coordinates as a string';
            }
            if (filter && typeof filter === 'object' && typeof filter.radius !== 'object') {
                return 'coordinates with a plain radius';
            }
        }
    }

    return null;
}

// Generators

const TEXT_VALUES: unknown[] = [
    'Alpha',
    'alphabet',
    ' beta ',
    'BETA',
    'gamma ray',
    '0',
    'a,b',
    '',
    '   ',
    null,
    undefined,
    5,
    0,
    ['Gamma', 'delta'],
    [],
    [null],
    ['', null],
    ['  '],
    ['beta', null],
    { id: 3, label: 'Alpha' },
    { id: 4, label: '' },
];
const TEXT_FILTERS: unknown[] = [
    'al',
    'ALPHA',
    ' beta ',
    'beta',
    'ga',
    'ray',
    'pha',
    'a,b',
    'x',
    '0',
    0,
    5,
    '',
    '   ',
    null,
    undefined,
];
const NUMBER_VALUES: unknown[] = [
    0,
    1,
    2.5,
    -3,
    10,
    100,
    '5',
    ' 7 ',
    '1e1',
    '',
    '  ',
    null,
    undefined,
    { amount: 10 },
    { amount: '2.5' },
    { amount: null },
    [1, 2],
    [],
    [null],
];
const NUMBER_INPUTS: unknown[] = [0, 1, 2.5, 10, -3, 100, '5', 'abc', '', null, undefined];
const DATES = [
    '2024-01-01',
    '2024-01-02',
    '2024-01-02 00:00:00',
    '2024-01-02 10:30:00',
    '2024-02-15',
    '2023-12-31 23:59:59',
];
const DATE_VALUES: unknown[] = [...DATES, '', '  ', null, undefined, [], ['2024-01-02']];
const DATE_INPUTS: unknown[] = [
    '2024-01-01',
    '2024-01-02',
    '2024-01-02 10:30:00',
    '2024-02-15',
    '',
    null,
    undefined,
    'garbage',
    '2024-99-99',
];
const SET_VALUES: unknown[] = [
    'red',
    'Red',
    'blue',
    'a,b',
    'RED ',
    3,
    { id: 3, label: 'Three' },
    { id: 'BLUE', label: 'Blue' },
    ['red', 'green'],
    ['blue', null],
    [],
    [null],
    '',
    '  ',
    null,
    undefined,
];
const SET_ENTRIES: unknown[] = ['red', 'BLUE', '3', 'a,b', 'green', null, '', 5];
const BOOLEAN_VALUES: unknown[] = [true, false, 'true', 'false', 1, 0, '1', '0', null, undefined, 'yes'];
const BOOLEAN_INPUTS: unknown[] = [true, false, 'true', '0', 1, null, undefined, 'yes'];

function randomPoint(random: Random) {
    return { latitude: random.int(-1000, 1000) / 100, longitude: random.int(-1000, 1000) / 100 };
}

function randomCoordinateValue(random: Random): unknown {
    const p = randomPoint(random);

    return random.pick([
        p,
        [p.latitude, p.longitude],
        { lat: p.latitude, lng: p.longitude },
        null,
        undefined,
        'x',
        { latitude: 'a', longitude: 1 },
    ]);
}

function randomLeaf(random: Random, filterType: string): Condition {
    const maybe = <T>(value: T): T | undefined => (random.chance(0.9) ? value : undefined);
    switch (filterType) {
        case 'text':
            return withoutUndefined({
                filterType,
                type: maybe(random.chance(0.95) ? random.pick(TEXT_OPERATORS) : 'bogus'),
                filter: random.pick(TEXT_FILTERS),
            });
        case 'number':
            return withoutUndefined({
                filterType,
                type: maybe(random.chance(0.95) ? random.pick(NUMBER_OPERATORS) : 'between'),
                filter: random.pick(NUMBER_INPUTS),
                filterTo: random.chance(0.5) ? random.pick(NUMBER_INPUTS) : undefined,
            });
        case 'date':
            return withoutUndefined({
                filterType,
                type: maybe(random.pick(NUMBER_OPERATORS)),
                dateFrom: random.pick(DATE_INPUTS),
                dateTo: random.chance(0.5) ? random.pick(DATE_INPUTS) : undefined,
            });
        case 'set':
            return withoutUndefined({
                filterType,
                type: random.pick(['anyOf', 'noneOf', undefined, 'weird']),
                values: random.chance(0.95) ? random.subset(SET_ENTRIES, 4) : 'red',
            });
        case 'boolean':
            return withoutUndefined({
                filterType,
                type: random.pick(['equals', 'equals', 'notEquals', 'bogus']),
                filter: random.pick(BOOLEAN_INPUTS),
            });
        default: {
            const center = randomPoint(random);
            const structured: Condition = {
                latitude: random.chance(0.9) ? center.latitude : random.pick([95, '1.5', null]),
                longitude: center.longitude,
                radius: random.chance(0.9)
                    ? {
                          value: random.pick([50, 300, 800, 1500, 0, -5, '200']),
                          unit: random.pick(['km', 'km', 'mi', 'm', 'furlong']),
                      }
                    : random.pick([300, '300']),
            };
            if (random.chance(0.05)) {
                structured.metadata = {
                    bounds: { southWest: { latitude: -1, longitude: -1 }, northEast: { latitude: 1, longitude: 1 } },
                };
            }

            return {
                filterType: 'coordinates',
                type: 'withinRadius',
                filter: random.chance(0.9)
                    ? structured
                    : random.pick([
                          null,
                          '',
                          `${center.latitude},${center.longitude},500km`,
                          `${center.latitude},${center.longitude}`,
                          'garbage',
                      ]),
            };
        }
    }
}

function withoutUndefined(condition: Condition): Condition {
    return Object.fromEntries(Object.entries(condition).filter(([, value]) => value !== undefined));
}

function randomValue(random: Random, filterType: string): unknown {
    switch (filterType) {
        case 'text':
            return random.pick(TEXT_VALUES);
        case 'number':
            return random.pick(NUMBER_VALUES);
        case 'date':
            return random.pick(DATE_VALUES);
        case 'set':
            return random.pick(SET_VALUES);
        case 'boolean':
            return random.pick(BOOLEAN_VALUES);
        default:
            return randomCoordinateValue(random);
    }
}

function randomCondition(random: Random, filterType: string, depth = 0): Condition {
    // A combined condition at the top, and now and then one nested inside it (dropped locally, as below).
    if (depth < 2 && random.chance(depth === 0 ? 0.35 : 0.1)) {
        return {
            filterType,
            operator: random.pick(['AND', 'OR', 'OR', 'and']),
            conditions: Array.from({ length: random.int(depth === 0 ? 0 : 1, 3) }, () =>
                randomCondition(random, filterType, depth + 1)
            ),
        };
    }

    return randomLeaf(random, filterType);
}

const KINDS = ['text', 'number', 'date', 'set', 'boolean', 'coordinates'];

// Shrinking

function smallerConditions(condition: Condition): Condition[] {
    if (!isCombined(condition)) {
        return [];
    }
    const children: Condition[] = condition.conditions ?? [];

    return [
        ...children,
        ...children.map((_, i) => ({ ...condition, conditions: children.filter((__, j) => j !== i) })),
        ...children.flatMap((child, i) =>
            smallerConditions(child).map((smaller) => ({
                ...condition,
                conditions: children.map((c, j) => (j === i ? smaller : c)),
            }))
        ),
    ];
}

function mismatch(condition: Condition, value: unknown): boolean {
    const server = serverOutcome(condition, value);
    if (server === 'reject' || server === 'undefined' || server === 'boundary' || divergence(condition, value)) {
        return false;
    }
    let local: boolean;
    try {
        local = localPasses(condition, value);
    } catch {
        return true;
    }

    return local !== (server === 'none' ? true : server);
}

function shrinkCase(condition: Condition, value: unknown): { condition: Condition; value: unknown } {
    let current = { condition, value };
    let progress = true;
    while (progress) {
        progress = false;
        for (const smaller of smallerConditions(current.condition)) {
            if (mismatch(smaller, current.value)) {
                current = { condition: smaller, value: current.value };
                progress = true;
                break;
            }
        }
        if (!progress && Array.isArray(current.value)) {
            for (let i = 0; i < current.value.length; i++) {
                const smaller = (current.value as unknown[]).filter((_, j) => j !== i);
                if (mismatch(current.condition, smaller)) {
                    current = { condition: current.condition, value: smaller };
                    progress = true;
                    break;
                }
            }
        }
    }

    return current;
}

const show = (value: unknown) => JSON.stringify(value, (_, v) => (v === undefined ? '<undefined>' : v));

// Tests

const CONDITIONS_PER_KIND = 10000;
const VALUES_PER_CONDITION = 8;

describe('built-in filter kinds versus the backend', () => {
    it(`agree on ${CONDITIONS_PER_KIND * KINDS.length} random conditions x ${VALUES_PER_CONDITION} values, apart from labelled divergences`, () => {
        const counts: Record<string, number> = { compared: 0, reject: 0, undefined: 0, boundary: 0 };
        const labelled: Record<string, number> = {};
        const random = createRandom(20261001);
        for (const filterType of KINDS) {
            for (let i = 0; i < CONDITIONS_PER_KIND; i++) {
                const condition = randomCondition(random, filterType);
                for (let j = 0; j < VALUES_PER_CONDITION; j++) {
                    const value = randomValue(random, filterType);
                    const server = serverOutcome(condition, value);
                    if (server === 'reject' || server === 'undefined' || server === 'boundary') {
                        counts[server]!++;
                        continue;
                    }
                    let local: boolean | string;
                    try {
                        local = localPasses(condition, value);
                    } catch (error) {
                        local = `threw ${(error as Error).message}`;
                    }
                    const expected = server === 'none' ? true : server;
                    if (local === expected) {
                        counts.compared!++;
                        continue;
                    }
                    const label = divergence(condition, value);
                    if (label) {
                        labelled[label] = (labelled[label] ?? 0) + 1;
                        continue;
                    }
                    const minimal = shrinkCase(condition, value);
                    throw new Error(
                        `local ${String(local)}, server ${String(expected)} for ${show(condition)} on ${show(value)}\n` +
                            `minimal: ${show(minimal.condition)} on ${show(minimal.value)} ` +
                            `(server ${String(serverOutcome(minimal.condition, minimal.value))})`
                    );
                }
            }
        }
        // Enough comparable cases of every kind, and every divergence label actually seen.
        expect(counts.compared).toBeGreaterThan(CONDITIONS_PER_KIND * KINDS.length * 2);
        expect(Object.keys(labelled).sort()).toEqual(
            [
                'a nested combined set condition matches nothing on the server',
                'arrays in number/date columns',
                'coordinates as a string',
                'coordinates with a plain radius',
                'negation of a blank number/date',
                'text filter "0" is dropped by the server',
            ].sort()
        );
    }, 60_000);
});

/**
 * Each labelled divergence, pinned with its minimal case and asserting both sides, then regression tests for
 * the bugs this fuzz found earlier (now fixed), where local and server agree.
 */
describe('divergences from the backend', () => {
    it('a text filter of "0" is dropped by the server (a backend bug), and applied locally', () => {
        // The server keeps a text condition only with a non-empty value, and it treats '0' as empty.
        expect(serverOutcome({ filterType: 'text', type: 'equals', filter: '0' }, 'x')).toBe('none');
        expect(localPasses({ filterType: 'text', type: 'equals', filter: '0' }, 'x')).toBe(false);
    });

    it('notEqual on a blank number or date: excluded locally, returned by a Typesense exclusion', () => {
        // builtinKinds.ts compareScalar says a document without the field matches no equality filter, yet the
        // text kind and set noneOf return blanks for their exclusions. The server's number and date
        // filters build `field:!=value`; under assumption A that returns blank documents.
        expect(localPasses({ filterType: 'text', type: 'notEqual', filter: 'x' }, null)).toBe(true);
        expect(localPasses({ filterType: 'number', type: 'notEqual', filter: 5 }, null)).toBe(false);
        expect(serverOutcome({ filterType: 'number', type: 'notEqual', filter: 5 }, null)).toBe(true);
    });

    it('arrays in number columns: the server matches any element, the local kind matches none', () => {
        expect(localPasses({ filterType: 'number', type: 'equals', filter: 1 }, [1, 2])).toBe(false);
    });

    it('coordinates as a string or with a plain radius: filtered by the server, ignored locally', () => {
        // The server parses the coordinates input and requires a numeric radius.
        const far = { latitude: 40, longitude: 40 };
        const asString = { filterType: 'coordinates', type: 'withinRadius', filter: '0,0,100km' };
        expect(serverOutcome(asString, far)).toBe(false);
        expect(localPasses(asString, far)).toBe(true);
        const plainRadius = { filterType: 'coordinates', filter: { latitude: 0, longitude: 0, radius: 100 } };
        expect(serverOutcome(plainRadius, far)).toBe(false);
        expect(localPasses(plainRadius, far)).toBe(true);
    });

    it('a combined set condition nested in another: matches nothing on the server, dropped locally', () => {
        // The server validates the nested entry as a column condition, which needs no `type` for a set, so it becomes an empty anyOf (`field:[]`). Other kinds are rejected.
        const condition = {
            filterType: 'set',
            operator: 'AND',
            conditions: [
                { filterType: 'set', type: 'anyOf', values: ['red'] },
                { filterType: 'set', operator: 'AND', conditions: [{ filterType: 'set', values: ['blue'] }] },
            ],
        };
        expect(serverOutcome(condition, 'red')).toBe(false);
        expect(localPasses(condition, 'red')).toBe(true);
        const text = {
            filterType: 'text',
            operator: 'AND',
            conditions: [{ filterType: 'text', operator: 'AND', conditions: [] }],
        };
        expect(serverOutcome(text, 'x')).toBe('reject');
    });
});

describe('fixed bugs agree with the backend', () => {
    it('a whitespace-only value is not blank', () => {
        // The server's blank check: null or an empty string.
        expect(localPasses({ filterType: 'text', type: 'blank' }, '   ')).toBe(false);
        expect(serverOutcome({ filterType: 'text', type: 'blank' }, '   ')).toBe(false);
    });

    it('arrays and objects whose items are all empty are blank', () => {
        for (const value of [[null], ['', null], { amount: null }]) {
            expect(localPasses({ filterType: 'number', type: 'blank' }, value)).toBe(true);
            expect(serverOutcome({ filterType: 'number', type: 'blank' }, value)).toBe(true);
        }
    });

    it('an empty noneOf takes no part in an OR', () => {
        const condition = {
            filterType: 'set',
            operator: 'OR',
            conditions: [
                { filterType: 'set', type: 'noneOf', values: [] },
                { filterType: 'set', type: 'anyOf', values: [] },
            ],
        };
        expect(serverOutcome(condition, 'red')).toBe(false);
        expect(localPasses(condition, 'red')).toBe(false);
    });

    it('numeric strings are valid number inputs', () => {
        expect(serverOutcome({ filterType: 'number', type: 'equals', filter: '5' }, 7)).toBe(false);
        expect(localPasses({ filterType: 'number', type: 'equals', filter: '5' }, 7)).toBe(false);
        expect(localPasses({ filterType: 'number', type: 'equals', filter: '5' }, 5)).toBe(true);
    });

    it('a number in set values matches like its string', () => {
        expect(localPasses({ filterType: 'set', values: [5] }, '5')).toBe(true);
        expect(serverOutcome({ filterType: 'set', values: [5] }, '5')).toBe(true);
    });

    it('a radius in metres is metres', () => {
        const condition = {
            filterType: 'coordinates',
            type: 'withinRadius',
            filter: { latitude: 0, longitude: 0, radius: { value: 500, unit: 'm' } },
        };
        expect(localPasses(condition, { latitude: 0, longitude: 1 })).toBe(false);
        expect(localPasses(condition, { latitude: 0, longitude: 0.001 })).toBe(true);
    });

    it('an out-of-range centre filters nothing', () => {
        const condition = {
            filterType: 'coordinates',
            type: 'withinRadius',
            filter: { latitude: 95, longitude: 0, radius: { value: 10, unit: 'km' } },
        };
        expect(serverOutcome(condition, { latitude: 0, longitude: 0 })).toBe('none');
        expect(localPasses(condition, { latitude: 0, longitude: 0 })).toBe(true);
    });
});

// filterParams, against the meanings documented in src/contract/filters.ts

function documentedText(condition: Condition, value: unknown, params: Record<string, any>): boolean {
    const text = (input: unknown): string => {
        let result = input === null || input === undefined ? '' : String(input);
        if (params.trimInput !== false) {
            result = result.trim();
        }
        if (!params.caseSensitive) {
            result = result.toLowerCase();
        }

        return result;
    };
    if (condition.type === 'blank') {
        return value === null || value === undefined || value === '';
    }
    if (condition.type === 'notBlank') {
        return !(value === null || value === undefined || value === '');
    }
    const filter = text(condition.filter);
    const cell = text(value);
    switch (condition.type) {
        case 'equals':
            return cell === filter;
        case 'notEqual':
            return cell !== filter;
        case 'contains':
            return cell.includes(filter);
        case 'notContains':
            return !cell.includes(filter);
        case 'startsWith':
            return cell.startsWith(filter);
        default:
            return cell.endsWith(filter);
    }
}

function documentedNumber(condition: Condition, value: number | null, params: Record<string, any>): boolean {
    const from = condition.filter as number;
    const to = condition.filterTo as number | undefined;
    if (condition.type === 'blank') {
        return value === null;
    }
    if (condition.type === 'notBlank') {
        return value !== null;
    }
    if (value === null) {
        const option = {
            equals: 'includeBlanksInEquals',
            notEqual: 'includeBlanksInNotEqual',
            lessThan: 'includeBlanksInLessThan',
            lessThanOrEqual: 'includeBlanksInLessThan',
            greaterThan: 'includeBlanksInGreaterThan',
            greaterThanOrEqual: 'includeBlanksInGreaterThan',
            inRange: 'includeBlanksInRange',
        }[condition.type as string]!;

        return params[option] === true;
    }
    switch (condition.type) {
        case 'equals':
            return value === from;
        case 'notEqual':
            return value !== from;
        case 'lessThan':
            return value < from;
        case 'lessThanOrEqual':
            return value <= from;
        case 'greaterThan':
            return value > from;
        case 'greaterThanOrEqual':
            return value >= from;
        default:
            if (to === undefined) {
                return value >= from;
            }

            return params.inRangeInclusive === false ? value > from && value < to : value >= from && value <= to;
    }
}

describe('filterParams options', () => {
    it('caseSensitive and trimInput change text matching as documented (3000 random cases)', () => {
        const random = createRandom(7);
        const cells = ['Alpha', ' alpha ', 'ALPHA', 'beta', ' Beta', 'al', null, ''];
        const filters = ['alpha', 'Alpha', ' al', 'AL ', 'beta', 'a', ' Beta'];
        for (let i = 0; i < 3000; i++) {
            const params = withoutUndefined({
                caseSensitive: random.pick([true, false, undefined]),
                trimInput: random.pick([true, false, undefined]),
            });
            const condition = { filterType: 'text', type: random.pick(TEXT_OPERATORS), filter: random.pick(filters) };
            const value = random.pick(cells);
            expect(
                localPasses(condition, value, params),
                `${show(condition)} on ${show(value)} with ${show(params)}`
            ).toBe(documentedText(condition, value, params));
        }
    });

    it('inRangeInclusive and includeBlanksIn* change number matching as documented (3000 random cases)', () => {
        const random = createRandom(8);
        for (let i = 0; i < 3000; i++) {
            const params = withoutUndefined({
                inRangeInclusive: random.pick([true, false, undefined]),
                includeBlanksInEquals: random.pick([true, false, undefined]),
                includeBlanksInNotEqual: random.pick([true, false, undefined]),
                includeBlanksInLessThan: random.pick([true, false, undefined]),
                includeBlanksInGreaterThan: random.pick([true, false, undefined]),
                includeBlanksInRange: random.pick([true, false, undefined]),
            });
            const from = random.int(0, 5);
            const condition = withoutUndefined({
                filterType: 'number',
                type: random.pick(NUMBER_OPERATORS),
                filter: from,
                filterTo: random.chance(0.8) ? from + random.int(0, 3) : undefined,
            });
            const value = random.chance(0.2) ? null : random.int(-1, 9);
            expect(
                localPasses(condition, value, params),
                `${show(condition)} on ${show(value)} with ${show(params)}`
            ).toBe(documentedNumber(condition, value, params));
        }
    });

    it('includeBlanksIn* and inRangeInclusive apply to dates the same way', () => {
        const params = { includeBlanksInGreaterThan: true, inRangeInclusive: false };
        expect(localPasses({ filterType: 'date', type: 'greaterThan', dateFrom: '2024-01-01' }, null, params)).toBe(
            true
        );
        expect(
            localPasses(
                { filterType: 'date', type: 'inRange', dateFrom: '2024-01-01', dateTo: '2024-01-03' },
                '2024-01-01',
                params
            )
        ).toBe(false);
        expect(
            localPasses(
                { filterType: 'date', type: 'inRange', dateFrom: '2024-01-01', dateTo: '2024-01-03' },
                '2024-01-02',
                params
            )
        ).toBe(true);
    });

    // Regression: includeBlanksIn* used to let any unreadable value through, not only blanks.
    it('includeBlanksInEquals does not include unreadable non-blank values', () => {
        expect(
            localPasses({ filterType: 'number', type: 'equals', filter: 5 }, 'n/a', { includeBlanksInEquals: true })
        ).toBe(false);
    });

    it('custom filterOptions predicates on text, number and date (2000 random cases)', () => {
        const random = createRandom(9);
        const calls: unknown[][] = [];
        const predicate = (inputs: unknown[], cell: unknown) => {
            calls.push(inputs);

            return String(cell).length % 2 === 0;
        };
        const filterOptions = [
            'equals',
            { displayKey: 'evenLength0', displayName: 'Even', numberOfInputs: 0 as const, predicate },
            { displayKey: 'evenLength1', displayName: 'Even 1', numberOfInputs: 1 as const, predicate },
            { displayKey: 'evenLength2', displayName: 'Even 2', numberOfInputs: 2 as const, predicate },
            { displayKey: 'noPredicate', displayName: 'Nothing' },
        ];
        for (let i = 0; i < 2000; i++) {
            const kind = random.pick(['text', 'number', 'date']);
            const type = random.pick(['evenLength0', 'evenLength1', 'evenLength2', 'noPredicate']);
            const input = random.pick(
                kind === 'text'
                    ? ['ab', '', null, undefined]
                    : kind === 'number'
                      ? [3, null, undefined, '4']
                      : ['2024-01-01', '', null, undefined]
            );
            const second = random.pick<unknown>(kind === 'date' ? ['2024-02-01', undefined] : [7, undefined]);
            const condition: Condition =
                kind === 'date'
                    ? withoutUndefined({ filterType: kind, type, dateFrom: input, dateTo: second })
                    : withoutUndefined({
                          filterType: kind,
                          type,
                          filter: input,
                          filterTo: kind === 'number' ? second : undefined,
                      });
            const value = random.pick(['abcd', 'abc', 12, 1234, null]);
            const hasInput =
                kind === 'text'
                    ? input !== null && input !== undefined && input !== ''
                    : kind === 'number'
                      ? typeof input === 'number' || input === '4'
                      : typeof input === 'string' && input !== '';
            // A custom operator needs its inputs unless numberOfInputs is 0; one without a predicate is not
            // a custom operator, and an unknown built-in operator filters nothing.
            const valid = type === 'noPredicate' ? false : type === 'evenLength0' || hasInput;
            const expected = valid ? String(value).length % 2 === 0 : true;
            calls.length = 0;
            expect(localPasses(condition, value, { filterOptions }), `${show(condition)} on ${show(value)}`).toBe(
                expected
            );
            if (valid) {
                const inputs =
                    kind === 'date'
                        ? [condition.dateFrom, condition.dateTo]
                        : kind === 'number'
                          ? [condition.filter, condition.filterTo]
                          : [condition.filter];
                expect(calls[0], 'predicate inputs').toEqual(inputs);
            }
        }
    });

    it('custom operators do not apply to set filters, as documented', () => {
        const filterOptions = [{ displayKey: 'anyOf', displayName: 'Never', predicate: () => false }];
        expect(localPasses({ filterType: 'set', type: 'anyOf', values: ['red'] }, 'red', { filterOptions })).toBe(true);
    });

    // Regression: boolean and coordinates used to ignore custom operators.
    it('custom operators apply to boolean filters', () => {
        const filterOptions = [{ displayKey: 'any', displayName: 'Any', numberOfInputs: 1, predicate: () => true }];
        expect(localPasses({ filterType: 'boolean', type: 'any', filter: true }, false, { filterOptions })).toBe(true);
    });

    it('custom operators apply to coordinates filters', () => {
        const filterOptions = [
            {
                displayKey: 'hasPoint',
                displayName: 'Has a point',
                numberOfInputs: 0,
                predicate: (_: unknown[], cell: unknown) => cell !== null,
            },
        ];
        expect(
            localPasses(
                { filterType: 'coordinates', type: 'hasPoint' },
                { latitude: 80, longitude: 80 },
                { filterOptions }
            )
        ).toBe(true);
        expect(localPasses({ filterType: 'coordinates', type: 'hasPoint' }, null, { filterOptions })).toBe(false);
    });

    // Regression: textMatcher results used to be negated again for notEqual and notContains. The contract says
    // the matcher replaces the matching altogether.
    it('textMatcher decides notContains by itself', () => {
        const textMatcher = ({
            operator,
            value,
            filterText,
        }: {
            operator: string;
            value: string;
            filterText: string;
        }) => (operator === 'notContains' ? !value.includes(filterText) : value.includes(filterText));
        expect(localPasses({ filterType: 'text', type: 'notContains', filter: 'a' }, 'abc', { textMatcher })).toBe(
            false
        );
    });

    it('textFormatter normalises both sides', () => {
        const textFormatter = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '');
        expect(localPasses({ filterType: 'text', type: 'contains', filter: 'cafe' }, 'Café', { textFormatter })).toBe(
            true
        );
        expect(localPasses({ filterType: 'text', type: 'equals', filter: 'CAFÉ' }, 'cafe', { textFormatter })).toBe(
            true
        );
    });

    it('set caseSensitive', () => {
        expect(localPasses({ filterType: 'set', values: ['Red'] }, 'red', { caseSensitive: true })).toBe(false);
        expect(localPasses({ filterType: 'set', values: ['Red'] }, 'red')).toBe(true);
    });
});
