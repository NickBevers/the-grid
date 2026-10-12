/**
 * 100,000 rows x 100 columns, grouped in blocks of 50, with variable-height notes.
 * Cell values are derived from (row, column) on demand, so the fixture never holds 10 million cells.
 */
import type { PrototypeRow } from './types';

export const LOCAL_ROW_COUNT = 100_000;
export const LOCAL_COLUMN_COUNT = 100;
export const GROUP_SIZE = 50;

export function hash(value: number): number {
    let x = value | 0;
    x = ((x >>> 16) ^ x) * 0x45d9f3b;
    x = ((x >>> 16) ^ x) * 0x45d9f3b;

    return ((x >>> 16) ^ x) >>> 0;
}

const WORDS = [
    'order',
    'task',
    'billing',
    'quote',
    'completed',
    'supplier',
    'quantity',
    'accounting',
    'region',
    'budget',
];

export function noteFor(row: number, extra: boolean): string {
    const sentences = (hash(row) % 5) + (extra ? 8 : 0);
    const parts: string[] = [];
    for (let i = 0; i < sentences; i++) {
        parts.push(
            `${WORDS[hash(row * 31 + i) % WORDS.length]} ${WORDS[hash(row * 17 + i) % WORDS.length]} note ${i + 1}.`
        );
    }

    return parts.join(' ');
}

export type DisplayedEntry = { type: 'group'; group: number } | { type: 'row'; row: number };

/**
 * Displayed projection of the grouped rows. Encoded as numbers: a negative value -(g + 1) is group g,
 * a non-negative value is data row r.
 */
export function buildProjection(collapsed: ReadonlySet<number>): Int32Array {
    const groups = Math.ceil(LOCAL_ROW_COUNT / GROUP_SIZE);
    let size = groups;
    for (let group = 0; group < groups; group++) {
        if (!collapsed.has(group)) {
            size += Math.min(GROUP_SIZE, LOCAL_ROW_COUNT - group * GROUP_SIZE);
        }
    }
    const projection = new Int32Array(size);
    let cursor = 0;
    for (let group = 0; group < groups; group++) {
        projection[cursor++] = -(group + 1);
        if (collapsed.has(group)) {
            continue;
        }
        const end = Math.min((group + 1) * GROUP_SIZE, LOCAL_ROW_COUNT);
        for (let row = group * GROUP_SIZE; row < end; row++) {
            projection[cursor++] = row;
        }
    }

    return projection;
}

/** Reverse lookup from row id (`g12`, `r345`) to displayed index. Undefined when collapsed away. */
export function createIndexLookup(projection: Int32Array): (id: string) => number | undefined {
    const groups = Math.ceil(LOCAL_ROW_COUNT / GROUP_SIZE);
    const rowIndex = new Int32Array(LOCAL_ROW_COUNT).fill(-1);
    const groupIndex = new Int32Array(groups).fill(-1);
    projection.forEach((value, index) => {
        if (value < 0) {
            groupIndex[-value - 1] = index;
        } else {
            rowIndex[value] = index;
        }
    });

    return (id) => {
        const number = Number(id.slice(1));
        const index = id.startsWith('g') ? groupIndex[number] : rowIndex[number];

        return index === undefined || index < 0 ? undefined : index;
    };
}

export function decode(value: number): DisplayedEntry {
    return value < 0 ? { type: 'group', group: -value - 1 } : { type: 'row', row: value };
}

export function localRow(projection: Int32Array, index: number, collapsed: ReadonlySet<number>): PrototypeRow {
    const entry = decode(projection[index]!);
    if (entry.type === 'group') {
        return {
            kind: 'group',
            id: `g${entry.group}`,
            label: `Client group ${entry.group + 1}`,
            expanded: !collapsed.has(entry.group),
            childCount: Math.min(GROUP_SIZE, LOCAL_ROW_COUNT - entry.group * GROUP_SIZE),
        };
    }

    return { kind: 'data', id: `r${entry.row}` };
}
