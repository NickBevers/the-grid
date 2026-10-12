/**
 * Row id conventions.
 *
 * Data rows use the id from `getRowId`. Every other row kind gets a synthetic id built here, in a fixed
 * format, so the same logical row gets the same id in every projection: a group keeps its id across
 * refreshes, a detail row follows its master, and a placeholder keeps its id until real data replaces it.
 * Synthetic ids start with a kind prefix and a colon; `getRowId` values that could collide with these
 * prefixes are rejected by `assertDataRowId`.
 */
import type { RowId } from '../contract/rows';

export type GroupKey = string | null;

const PREFIXES = ['group:', 'tree:', 'detail:', 'pinned:', 'loading:', 'failed:'] as const;

/** Serializes a key path so different paths never produce the same string (null and "null" differ). */
export function routeKey(keyPath: readonly GroupKey[]): string {
    return JSON.stringify(keyPath);
}

/**
 * A group, identified by the grouping columns down to its level and its key path. Both are needed:
 * group "BE" by country and group "BE" by city are different groups and must not share expansion or
 * selection state after the user regroups.
 */
export function groupRowId(colIds: readonly string[], keyPath: readonly GroupKey[]): RowId {
    return `group:${routeKey(colIds.slice(0, keyPath.length))}:${routeKey(keyPath)}`;
}

/** A tree ancestor that has no data row of its own (local tree data). */
export function treeFillerRowId(path: readonly string[]): RowId {
    return `tree:${routeKey(path)}`;
}

export function detailRowId(masterId: RowId): RowId {
    return `detail:${masterId}`;
}

/** Pinned rows can repeat body ids (a totals row for the same record), so the section is part of the id. */
export function pinnedRowId(section: 'top' | 'bottom', id: RowId): RowId {
    return `pinned:${section}:${id}`;
}

/** A slot at `position` within the level at `route`. Stable while that slot is unloaded. */
export function loadingRowId(route: readonly GroupKey[], position: number): RowId {
    return `loading:${routeKey(route)}:${position}`;
}

export function failedRowId(route: readonly GroupKey[], position: number): RowId {
    return `failed:${routeKey(route)}:${position}`;
}

export function isSyntheticRowId(id: RowId): boolean {
    return PREFIXES.some((prefix) => id.startsWith(prefix));
}

export class InvalidRowIdError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidRowIdError';
    }
}

/** Data row ids must be non-empty strings that cannot be mistaken for a synthetic id. */
export function assertDataRowId(id: unknown, context: string): asserts id is RowId {
    if (typeof id !== 'string' || id === '') {
        throw new InvalidRowIdError(`${context}: getRowId must return a non-empty string, got ${JSON.stringify(id)}`);
    }
    if (isSyntheticRowId(id)) {
        throw new InvalidRowIdError(`${context}: row id "${id}" uses a reserved prefix (${PREFIXES.join(', ')})`);
    }
}
