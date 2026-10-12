/**
 * Randomized differential tests for `ServerProjection`.
 *
 * A small reference model keeps plain arrays per level and derives the whole displayed list by walking
 * every displayed level top to bottom on every query. Random operation sequences run against both, and
 * every read is compared after every operation.
 */
import { describe, expect, it } from 'vitest';

import type { GridRow, RowId } from '../contract/rows';
import { failedRowId, groupRowId, loadingRowId, routeKey, type GroupKey } from './ids';
import { ServerProjection, type BlockAddress } from './serverProjection';

// PRNG

/** mulberry32: tiny, seedable and good enough for test input. */
function createRandom(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    return {
        next,
        int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
        chance: (p: number): boolean => next() < p,
        pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    };
}
type Random = ReturnType<typeof createRandom>;

// Input rows

type SRow = {
    seq: number;
    id?: string;
    tk?: string | null;
    _group?: boolean;
    _groupKey?: string | number | null;
    _childCount?: number;
};

let nextSeq = 0;
const dataRow = (id: string, tk: string | null): SRow => ({ seq: nextSeq++, id, tk });
const groupData = (key: string | number | null, childCount: number | undefined): SRow => ({
    seq: nextSeq++,
    _group: true,
    _groupKey: key,
    ...(childCount === undefined ? {} : { _childCount: childCount }),
});

type Config = {
    blockSize: number;
    groupColIds: string[];
    tree: boolean;
    openByDefault: ((group: { groupColId: string; key: GroupKey; level: number }) => boolean) | undefined;
};

// Reference model

type Desc = {
    kind: 'group' | 'data';
    id: RowId;
    data: SRow;
    /** Group key, or the tree key of an expandable data row. */
    childKey: GroupKey;
    expandable: boolean;
    groupColId?: string;
    key?: GroupKey;
    keyPath?: GroupKey[];
    childCount?: number | null;
};

type RefLevel = {
    route: GroupKey[];
    key: string;
    parentId: RowId | null;
    depth: number;
    count: number | null;
    blocks: Map<number, (Desc | undefined)[]>;
    failed: Map<number, unknown>;
    /**
     * Child levels that stay anchored under a slot after the expanded row in that slot was evicted or its
     * block failed. The contract is silent here. The implementation keeps them displayed below the
     * placeholder until the block is set again or the level is cleared, and this model follows it. The one
     * exception is that a level is never shown twice: attaching it below the row elsewhere drops the orphan.
     */
    orphans: Map<number, string>;
};

type RefEntry = {
    kind: GridRow<SRow>['kind'];
    id: RowId;
    level: number;
    parentId: RowId | null;
    index?: number;
    desc?: Desc;
    levelRef: RefLevel;
    position: number;
};

class Reference {
    readonly levels = new Map<string, RefLevel>();
    readonly expansion = new Map<RowId, boolean>();

    constructor(readonly config: Config) {
        this.levels.set(routeKey([]), this.#newLevel([], null, 0, null));
    }

    #newLevel(route: GroupKey[], parentId: RowId | null, depth: number, count: number | null): RefLevel {
        return {
            route,
            key: routeKey(route),
            parentId,
            depth,
            count,
            blocks: new Map(),
            failed: new Map(),
            orphans: new Map(),
        };
    }

    get root(): RefLevel {
        return this.levels.get(routeKey([]))!;
    }

    level(route: readonly GroupKey[]): RefLevel | undefined {
        return this.levels.get(routeKey(route));
    }

    toDesc(level: RefLevel, data: SRow): Desc {
        if (level.depth < this.config.groupColIds.length && data._group) {
            const key = data._groupKey === undefined || data._groupKey === null ? null : String(data._groupKey);
            const keyPath = [...level.route, key];

            return {
                kind: 'group',
                id: groupRowId(this.config.groupColIds, keyPath),
                data,
                childKey: key,
                expandable: true,
                groupColId: this.config.groupColIds[level.depth]!,
                key,
                keyPath,
                childCount: typeof data._childCount === 'number' ? data._childCount : null,
            };
        }
        const treeKey = this.config.tree ? (data.tk ?? null) : null;

        return { kind: 'data', id: String(data.id), data, childKey: treeKey, expandable: treeKey !== null };
    }

    expanded(desc: Desc, level: RefLevel): boolean {
        if (!desc.expandable) {
            return false;
        }
        const explicit = this.expansion.get(desc.id);
        if (explicit !== undefined) {
            return explicit;
        }
        if (desc.kind === 'group') {
            return (
                this.config.openByDefault?.({ groupColId: desc.groupColId!, key: desc.key!, level: level.depth }) ??
                false
            );
        }

        return false;
    }

    childRoute(level: RefLevel, desc: Desc): GroupKey[] {
        return [...level.route, desc.childKey];
    }

    slot(level: RefLevel, position: number): Desc | undefined {
        return level.blocks.get(Math.floor(position / this.config.blockSize))?.[position % this.config.blockSize];
    }

    /** Every loaded row in every existing level, with where it sits. */
    loaded(): { desc: Desc; level: RefLevel; position: number }[] {
        const found: { desc: Desc; level: RefLevel; position: number }[] = [];
        for (const level of this.levels.values()) {
            for (const [blockIndex, rows] of level.blocks) {
                rows.forEach((desc, offset) => {
                    if (desc) {
                        found.push({ desc, level, position: blockIndex * this.config.blockSize + offset });
                    }
                });
            }
        }

        return found;
    }

    find(id: RowId): { desc: Desc; level: RefLevel; position: number } | undefined {
        return this.loaded().find((entry) => entry.desc.id === id);
    }

    /** Creates the child level below an expanded row the first time it is needed. */
    ensureChild(level: RefLevel, desc: Desc): void {
        const route = this.childRoute(level, desc);
        const key = routeKey(route);
        if (!this.levels.has(key)) {
            const lastGroupLevel = desc.kind === 'group' && level.depth + 1 === this.config.groupColIds.length;
            const count =
                lastGroupLevel && desc.childCount !== null && desc.childCount !== undefined ? desc.childCount : null;
            this.levels.set(key, this.#newLevel(route, desc.id, level.depth + 1, count));
        }
        // The child level now hangs below this row, so it no longer hangs below an evicted slot.
        for (const [position, childKey] of [...level.orphans]) {
            if (childKey === key) {
                level.orphans.delete(position);
            }
        }
    }

    baseCount(level: RefLevel): number {
        if (level.count !== null) {
            return level.count;
        }
        let extent = 0;
        for (const [blockIndex, rows] of level.blocks) {
            extent = Math.max(extent, blockIndex * this.config.blockSize + rows.length);
        }

        return extent + this.config.blockSize;
    }

    // Writes

    setRowCount(route: readonly GroupKey[], count: number | null): void {
        const level = this.level(route);
        if (level) {
            level.count = count;
        }
    }

    setBlock(route: readonly GroupKey[], blockIndex: number, data: readonly SRow[]): void {
        const level = this.level(route);
        if (!level) {
            return;
        }
        const bs = this.config.blockSize;
        const start = blockIndex * bs;
        level.failed.delete(blockIndex);
        for (let position = start; position < start + bs; position++) {
            level.orphans.delete(position);
        }
        const descs = data.map((item) => this.toDesc(level, item));
        level.blocks.set(blockIndex, descs);
        const before = this.loaded();
        descs.forEach((desc, offset) => {
            // A row that already sits in another slot moved: the old slot becomes a hole.
            for (const other of before) {
                if (other.desc.id === desc.id && (other.level !== level || other.position !== start + offset)) {
                    other.level.blocks.get(Math.floor(other.position / bs))![other.position % bs] = undefined;
                }
            }
            if (this.expanded(desc, level)) {
                this.ensureChild(level, desc);
            }
        });
        // A short block ends the level; an empty one only once the block before it is loaded (or it is first).
        if (data.length < bs && (data.length > 0 || blockIndex === 0 || level.blocks.has(blockIndex - 1))) {
            level.count = start + data.length;
        }
    }

    #dropBlock(level: RefLevel, blockIndex: number): void {
        const rows = level.blocks.get(blockIndex);
        rows?.forEach((desc, offset) => {
            if (desc && this.expanded(desc, level)) {
                level.orphans.set(blockIndex * this.config.blockSize + offset, routeKey(this.childRoute(level, desc)));
            }
        });
        level.blocks.delete(blockIndex);
    }

    setBlockFailed(route: readonly GroupKey[], blockIndex: number, error: unknown): void {
        const level = this.level(route);
        if (level) {
            this.#dropBlock(level, blockIndex);
            level.failed.set(blockIndex, error);
        }
    }

    removeBlock(route: readonly GroupKey[], blockIndex: number): void {
        const level = this.level(route);
        if (level) {
            this.#dropBlock(level, blockIndex);
            level.failed.delete(blockIndex);
        }
    }

    /** Per the contract: drops rows, counts and every child level below the route, cached or not. */
    clear(route: readonly GroupKey[]): void {
        const level = this.level(route);
        if (!level) {
            return;
        }
        level.blocks.clear();
        level.failed.clear();
        level.orphans.clear();
        level.count = null;
        for (const other of [...this.levels.values()]) {
            if (other.route.length > route.length && routeKey(other.route.slice(0, route.length)) === level.key) {
                this.levels.delete(other.key);
            }
        }
    }

    setExpanded(id: RowId, expanded: boolean): boolean {
        const entry = this.find(id);
        if (!entry || !entry.desc.expandable) {
            return false;
        }
        this.expansion.set(id, expanded);
        if (expanded) {
            this.ensureChild(entry.level, entry.desc);
        }

        return true;
    }

    // Reads, all derived from scratch

    /** Levels reachable from the root through expanded rows and orphan anchors, at any position. */
    anchoredLevels(): Set<string> {
        const reached = new Set<string>();
        const visit = (level: RefLevel): void => {
            reached.add(level.key);
            const children = new Set<string>(level.orphans.values());
            for (const rows of level.blocks.values()) {
                rows.forEach((desc) => {
                    if (desc && this.expanded(desc, level)) {
                        children.add(routeKey(this.childRoute(level, desc)));
                    }
                });
            }
            for (const key of children) {
                const child = this.levels.get(key);
                if (child && !reached.has(key)) {
                    visit(child);
                }
            }
        };
        visit(this.root);

        return reached;
    }

    flatten(): { entries: RefEntry[]; displayedLevels: RefLevel[] } {
        const entries: RefEntry[] = [];
        const displayedLevels: RefLevel[] = [];
        const walk = (level: RefLevel): void => {
            displayedLevels.push(level);
            const count = this.baseCount(level);
            for (let position = 0; position < count; position++) {
                const desc = this.slot(level, position);
                const index = entries.length;
                let childKey: string | undefined;
                if (desc) {
                    entries.push({
                        kind: desc.kind,
                        id: desc.id,
                        level: level.depth,
                        parentId: level.parentId,
                        desc,
                        levelRef: level,
                        position,
                    });
                    if (this.expanded(desc, level)) {
                        childKey = routeKey(this.childRoute(level, desc));
                    }
                } else {
                    const blockIndex = Math.floor(position / this.config.blockSize);
                    const failed = level.failed.has(blockIndex);
                    entries.push({
                        kind: failed ? 'failed' : 'loading',
                        id: failed ? failedRowId(level.route, position) : loadingRowId(level.route, position),
                        level: level.depth,
                        parentId: level.parentId,
                        index,
                        levelRef: level,
                        position,
                    });
                    childKey = level.orphans.get(position);
                }
                if (childKey !== undefined) {
                    const child = this.levels.get(childKey);
                    if (!child) {
                        throw new Error(`reference: expanded row without a child level ${childKey}`);
                    }
                    walk(child);
                }
            }
        };
        walk(this.root);

        return { entries, displayedLevels };
    }

    missingBlocks(entries: RefEntry[], first: number, last: number): BlockAddress[] {
        const seen = new Set<string>();
        const missing: BlockAddress[] = [];
        const bs = this.config.blockSize;
        for (let index = Math.max(first, 0); index <= Math.min(last, entries.length - 1); index++) {
            const { levelRef: level, position } = entries[index]!;
            const blockIndex = Math.floor(position / bs);
            const key = `${level.key}|${blockIndex}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const block = level.blocks.get(blockIndex);
            // Complete means every slot of the block that the level displays holds a row.
            const end = Math.min((blockIndex + 1) * bs, this.baseCount(level));
            const start = blockIndex * bs;
            const complete =
                block !== undefined &&
                Array.from({ length: Math.max(end - start, 0) }, (_, offset) => block[offset]).every(
                    (row) => row !== undefined
                );
            if (!complete && !level.failed.has(blockIndex)) {
                missing.push({ route: [...level.route], blockIndex });
            }
        }

        return missing;
    }
}

// Comparison

const summarizeRow = (row: GridRow<SRow>) => {
    const base = { id: row.id, kind: row.kind, level: row.level, parentId: row.parentId, section: row.section };
    switch (row.kind) {
        case 'group':
            return {
                ...base,
                groupColId: row.groupColId,
                key: row.key,
                keyPath: row.keyPath,
                childCount: row.childCount,
                expanded: row.expanded,
                seq: row.data?.seq,
            };
        case 'data':
            return {
                ...base,
                expandable: row.expandable ? { expanded: row.expandable.expanded } : undefined,
                seq: row.data.seq,
            };
        case 'loading':
            return { ...base, index: row.index };
        case 'failed':
            return { ...base, index: row.index, error: row.error };
        default:
            return { ...base, unexpected: true };
    }
};

const summarizeEntry = (reference: Reference, entry: RefEntry) => {
    const base = {
        id: entry.id,
        kind: entry.kind,
        level: entry.level,
        parentId: entry.parentId,
        section: 'body' as const,
    };
    const desc = entry.desc;
    if (!desc) {
        const blockIndex = Math.floor(entry.position / reference.config.blockSize);

        return entry.kind === 'failed'
            ? { ...base, index: entry.index, error: entry.levelRef.failed.get(blockIndex) }
            : { ...base, index: entry.index };
    }

    return summarizeDesc(reference, desc, entry.levelRef);
};

const summarizeDesc = (reference: Reference, desc: Desc, level: RefLevel) => {
    const base = {
        id: desc.id,
        kind: desc.kind,
        level: level.depth,
        parentId: level.parentId,
        section: 'body' as const,
    };
    if (desc.kind === 'group') {
        return {
            ...base,
            groupColId: desc.groupColId,
            key: desc.key,
            keyPath: desc.keyPath,
            childCount: desc.childCount,
            expanded: reference.expanded(desc, level),
            seq: desc.data.seq,
        };
    }

    return {
        ...base,
        expandable: desc.expandable ? { expanded: reference.expanded(desc, level) } : undefined,
        seq: desc.data.seq,
    };
};

class Mismatch extends Error {}

function assertEquivalent(
    projection: ServerProjection<SRow>,
    reference: Reference,
    random: Random,
    seenIds: ReadonlySet<RowId>
): void {
    const check = (label: string, actual: unknown, expected: unknown): void => {
        if (JSON.stringify(actual) === JSON.stringify(expected)) {
            return;
        }
        try {
            expect(actual).toEqual(expected);
        } catch (error) {
            throw new Mismatch(`${label}\n${(error as Error).message}`);
        }
    };
    const { entries, displayedLevels } = reference.flatten();

    check('getDisplayCount', projection.getDisplayCount(), entries.length);
    const allKnown = displayedLevels.every((level) => level.count !== null);
    check('getRowCount', projection.getRowCount(), allKnown ? entries.length : null);

    entries.forEach((entry, index) => {
        const displayed = projection.getRowAtIndex(index);
        check(
            `getRowAtIndex(${index})`,
            displayed ? { index: displayed.index, row: summarizeRow(displayed.row) } : undefined,
            {
                index,
                row: summarizeEntry(reference, entry),
            }
        );
    });
    check('getRowAtIndex(count)', projection.getRowAtIndex(entries.length), undefined);
    check('getRowAtIndex(-1)', projection.getRowAtIndex(-1), undefined);

    const indexById = new Map<RowId, number>();
    entries.forEach((entry, index) => entry.desc && indexById.set(entry.id, index));
    const loaded = reference.loaded();
    const loadedIds = new Set<RowId>();
    for (const { desc, level } of loaded) {
        loadedIds.add(desc.id);
        const row = projection.getRow(desc.id);
        check(`getRow(${desc.id})`, row ? summarizeRow(row) : undefined, summarizeDesc(reference, desc, level));
        check(`getIndexOf(${desc.id})`, projection.getIndexOf(desc.id), indexById.get(desc.id));
        check(`isExpanded(${desc.id})`, projection.isExpanded(desc.id), reference.expanded(desc, level));
    }
    const unknownIds = [...seenIds].filter((id) => !loadedIds.has(id));
    unknownIds.push('nope', groupRowId(['country'], ['zz']));
    const placeholder = entries.find((entry) => !entry.desc);
    if (placeholder) {
        unknownIds.push(placeholder.id);
    }
    for (const id of unknownIds) {
        check(`getRow(${id}) unloaded`, projection.getRow(id), undefined);
        check(`getIndexOf(${id}) unloaded`, projection.getIndexOf(id), undefined);
        check(`isExpanded(${id}) unloaded`, projection.isExpanded(id), false);
    }

    const visited: [RowId, number][] = [];
    projection.forEachLoaded((row, index) => visited.push([row.id, index]));
    check(
        'forEachLoaded',
        visited,
        entries.flatMap((entry, index): [RowId, number][] => (entry.desc ? [[entry.id, index]] : []))
    );

    const ranges: [number, number][] = [[0, entries.length - 1]];
    for (let i = 0; i < 3; i++) {
        const first = random.int(-2, entries.length + 1);
        ranges.push([first, first + random.int(0, 12)]);
    }
    for (const [first, last] of ranges) {
        check(
            `missingBlocks(${first}, ${last})`,
            projection.missingBlocks(first, last),
            reference.missingBlocks(entries, first, last)
        );
    }
}

// Operations

type Op = {
    describe: string;
    apply: (projection: ServerProjection<SRow>, reference: Reference) => void;
    /** The block a `setBlock` replaces. */
    target?: { routeKey: string; blockIndex: number };
};

const GROUP_KEYS: (string | number | null)[] = ['a', 'b', 'null', null, 7];
const DATA_IDS = Array.from({ length: 16 }, (_, index) => `r${index}`);

/** Triggers of implementation bugs that have their own focused failing test below. */
type KnownBugs = {
    /** A clear keeps collapsed child levels cached (test "clear drops collapsed child levels, not only expanded ones"). */
    clearWithCachedChildren: boolean;
    /** A moved row leaves its child level anchored at the old slot too (tests "an expanded group that moves to another block" and "an evicted expanded group that returns"). */
    movedExpandedRow: boolean;
    /** Anchors and rows past the known count still count (tests "rows past the known count" and "an expanded row past the known count"). */
    anchorsPastCount: boolean;
    /** A short block whose slots are displayed again is never requested (test "requests a short block again when its unfilled slots become displayed"). */
    shortBlockRegrown: boolean;
};

const describeData = (data: readonly SRow[]): string =>
    `[${data.map((row) => (row._group ? `group(${JSON.stringify(row._groupKey)}${row._childCount === undefined ? '' : `,${row._childCount}`})` : `${row.id}${row.tk ? `/${row.tk}` : ''}`)).join(', ')}]`;

function randomBlockData(
    random: Random,
    reference: Reference,
    level: RefLevel,
    length: number,
    include?: SRow[]
): SRow[] {
    const usedKeys = new Set<string>();
    const usedIds = new Set<string>();
    const rows: SRow[] = [];
    for (const row of include ?? []) {
        if (row._group) {
            usedKeys.add(JSON.stringify(row._groupKey === null ? null : String(row._groupKey)));
        } else {
            usedIds.add(row.id!);
        }
    }
    const sameLevelIds = reference
        .loaded()
        .filter((entry) => entry.level === level && entry.desc.kind === 'data')
        .map((entry) => entry.desc.id);
    const groupDepth = reference.config.groupColIds.length;
    for (let i = 0; rows.length < length && i < length * 4; i++) {
        if (level.depth < groupDepth && random.chance(0.85)) {
            const key = random.pick(GROUP_KEYS);
            const keyId = JSON.stringify(key === null ? null : String(key));
            if (!usedKeys.has(keyId)) {
                usedKeys.add(keyId);
                rows.push(
                    groupData(key, random.chance(0.8) ? random.int(0, 3 * reference.config.blockSize) : undefined)
                );
            }
            continue;
        }
        const id = sameLevelIds.length > 0 && random.chance(0.3) ? random.pick(sameLevelIds) : random.pick(DATA_IDS);
        if (!usedIds.has(id)) {
            usedIds.add(id);
            rows.push(dataRow(id, random.chance(0.5) ? `k${id}` : null));
        }
    }
    for (const row of include ?? []) {
        rows.splice(random.int(0, rows.length), 0, row);
    }

    return rows.slice(0, Math.max(length, include?.length ?? 0));
}

function randomOp(random: Random, reference: Reference, avoid: KnownBugs): Op | undefined {
    const bs = reference.config.blockSize;
    const { entries } = reference.flatten();
    const displayedRoutes = [...new Set(entries.map((entry) => entry.levelRef.key))].map((key) =>
        reference.levels.get(key)!
    );
    const allLevels = [...reference.levels.values()];
    const pickLevel = (): RefLevel =>
        random.chance(0.75) && displayedRoutes.length > 0 ? random.pick(displayedRoutes) : random.pick(allLevels);
    const routeText = (route: readonly GroupKey[]) => JSON.stringify(route);
    const roll = random.int(0, 99);

    if (roll < 10) {
        const route = random.chance(0.05) ? ['zz'] : pickLevel().route;
        const count = random.chance(0.2) ? null : random.int(0, 3 * bs + 2);

        return {
            describe: `setRowCount(${routeText(route)}, ${count})`,
            apply: (projection, ref) => {
                projection.setRowCount(route, count);
                ref.setRowCount(route, count);
            },
        };
    }
    if (roll < 40) {
        const level = pickLevel();
        let blockIndex = random.int(0, 3);
        let length = random.chance(0.7) ? bs : random.int(0, bs - 1);
        if (level.count !== null && random.chance(0.7)) {
            // A server that agrees with the count it reported earlier.
            blockIndex = random.int(0, Math.min(3, Math.floor(level.count / bs)));
            length = Math.max(0, Math.min(bs, level.count - blockIndex * bs));
        }
        const data = randomBlockData(random, reference, level, length);

        return blockOp(level.route, blockIndex, data);
    }
    if (roll < 46) {
        const level = pickLevel();
        const blockIndex = random.int(0, 3);
        const error = `error ${random.int(0, 9)}`;

        return {
            describe: `setBlockFailed(${routeText(level.route)}, ${blockIndex}, ${error})`,
            apply: (projection, ref) => {
                projection.setBlockFailed(level.route, blockIndex, error);
                ref.setBlockFailed(level.route, blockIndex, error);
            },
        };
    }
    if (roll < 54) {
        const level = pickLevel();
        const blockIndex = random.int(0, 3);

        return {
            describe: `removeBlock(${routeText(level.route)}, ${blockIndex})`,
            apply: (projection, ref) => {
                projection.removeBlock(level.route, blockIndex);
                ref.removeBlock(level.route, blockIndex);
            },
        };
    }
    if (roll < 59) {
        const route = random.chance(0.4) ? [] : pickLevel().route;
        if (avoid.clearWithCachedChildren) {
            const anchored = reference.anchoredLevels();
            const prefix = routeKey(route);
            const cached = allLevels.some(
                (level) =>
                    level.route.length > route.length &&
                    routeKey(level.route.slice(0, route.length)) === prefix &&
                    !anchored.has(level.key)
            );
            if (cached) {
                return undefined;
            }
        }

        return {
            describe: `clear(${routeText(route)})`,
            apply: (projection, ref) => {
                projection.clear(route);
                ref.clear(route);
            },
        };
    }
    if (roll < 84) {
        const loaded = reference.loaded();
        let id: RowId;
        const expandable = loaded.filter((entry) => entry.desc.expandable);
        if (expandable.length > 0 && random.chance(0.6)) {
            id = random.pick(expandable).desc.id;
        } else if (loaded.length > 0 && random.chance(0.7)) {
            id = random.pick(loaded).desc.id;
        } else {
            id = random.pick([
                'nope',
                'r99',
                entries.find((entry) => !entry.desc)?.id ?? 'nope',
                groupRowId(['country'], ['zz']),
            ]);
        }
        const expanded = random.chance(0.6);

        return {
            describe: `setExpanded(${JSON.stringify(id)}, ${expanded})`,
            apply: (projection, ref) => {
                const actual = projection.setExpanded(id, expanded);
                const expected = ref.setExpanded(id, expanded);
                if (projection !== noopProjection && actual !== expected) {
                    throw new Mismatch(`setExpanded(${id}) returned ${actual}, reference ${expected}`);
                }
            },
        };
    }
    if (roll < 93) {
        // Reload another block of the same level with a row that already sits in a different block.
        const loaded = reference.loaded();
        if (loaded.length === 0) {
            return undefined;
        }
        const moved = random.pick(loaded);
        const level = moved.level;
        const from = Math.floor(moved.position / bs);
        const blockIndex = random.pick([0, 1, 2, 3].filter((index) => index !== from));
        const copy =
            moved.desc.kind === 'group'
                ? groupData(moved.desc.data._groupKey ?? null, moved.desc.data._childCount)
                : dataRow(moved.desc.id, moved.desc.data.tk ?? null);
        const data = randomBlockData(random, reference, level, random.chance(0.7) ? bs : random.int(1, bs), [copy]);

        return blockOp(level.route, blockIndex, data);
    }
    // Reload the block of an expanded row with a different row in its slot.
    const expandedRows = reference.loaded().filter((entry) => reference.expanded(entry.desc, entry.level));
    if (expandedRows.length === 0) {
        return undefined;
    }
    const target = random.pick(expandedRows);
    const blockIndex = Math.floor(target.position / bs);
    const offset = target.position % bs;
    const data = randomBlockData(random, reference, target.level, bs).filter(
        (row) =>
            (row._group
                ? groupRowId(reference.config.groupColIds, [
                      ...target.level.route,
                      row._groupKey === null ? null : String(row._groupKey),
                  ])
                : row.id) !== target.desc.id
    );
    const replacement =
        target.desc.kind === 'group'
            ? groupData(target.desc.key === 'a' ? 'b' : 'a', random.int(0, 6))
            : dataRow(target.desc.id === 'r0' ? 'r1' : 'r0', target.desc.id === 'r0' ? 'kr1' : 'kr0');
    const clash = data.findIndex((row) =>
        row._group ? row._groupKey === replacement._groupKey : row.id === replacement.id
    );
    if (clash >= 0) {
        data.splice(clash, 1);
    }
    data.splice(Math.min(offset, data.length), 0, replacement);

    return blockOp(target.level.route, blockIndex, data.slice(0, bs));
}

function blockOp(route: GroupKey[], blockIndex: number, data: SRow[]): Op {
    return {
        describe: `setBlock(${JSON.stringify(route)}, ${blockIndex}, ${describeData(data)})`,
        target: { routeKey: routeKey(route), blockIndex },
        apply: (projection, ref) => {
            projection.setBlock(route, blockIndex, data);
            ref.setBlock(route, blockIndex, data);
        },
    };
}

/** Rejects an operation that would trigger a known bug, judged on a scratch copy of the reference. */
function triggersKnownBug(reference: Reference, op: Op, avoid: KnownBugs): boolean {
    const scratch = cloneReference(reference);
    op.apply(noopProjection, scratch);
    const bs = scratch.config.blockSize;
    const anchored = scratch.anchoredLevels();
    for (const level of scratch.levels.values()) {
        if (!anchored.has(level.key)) {
            continue;
        }
        const count = scratch.baseCount(level);
        if (avoid.anchorsPastCount) {
            for (const [blockIndex, rows] of level.blocks) {
                if (blockIndex * bs + rows.length > count) {
                    return true;
                }
            }
            for (const position of level.orphans.keys()) {
                if (position >= count) {
                    return true;
                }
            }
        }
        if (avoid.shortBlockRegrown) {
            for (const [blockIndex, rows] of level.blocks) {
                if (rows.length < bs && blockIndex * bs + rows.length < Math.min((blockIndex + 1) * bs, count)) {
                    return true;
                }
            }
        }
    }
    if (avoid.movedExpandedRow) {
        // An expanded row that moves out of a block other than the one being replaced leaves a hole.
        for (const entry of reference.loaded()) {
            const after = scratch.find(entry.desc.id);
            const replaced =
                op.target?.routeKey === entry.level.key && op.target.blockIndex === Math.floor(entry.position / bs);
            if (
                after &&
                (after.level.key !== entry.level.key || after.position !== entry.position) &&
                !replaced &&
                reference.expanded(entry.desc, entry.level)
            ) {
                return true;
            }
        }
        // A row that reappears while its child level still hangs below an evicted slot.
        for (const level of reference.levels.values()) {
            for (const [position, childKey] of level.orphans) {
                for (const entry of scratch.loaded()) {
                    if (
                        entry.level.key === level.key &&
                        entry.position !== position &&
                        scratch.expanded(entry.desc, entry.level) &&
                        routeKey(scratch.childRoute(entry.level, entry.desc)) === childKey
                    ) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}

const noopProjection = {
    setRowCount: () => {},
    setBlock: () => {},
    setBlockFailed: () => {},
    removeBlock: () => {},
    clear: () => {},
    setExpanded: () => false,
} as unknown as ServerProjection<SRow>;

function cloneReference(reference: Reference): Reference {
    const copy = new Reference(reference.config);
    copy.levels.clear();
    for (const [key, level] of reference.levels) {
        copy.levels.set(key, {
            ...level,
            blocks: new Map([...level.blocks].map(([index, rows]) => [index, [...rows]])),
            failed: new Map(level.failed),
            orphans: new Map(level.orphans),
        });
    }
    for (const [id, expanded] of reference.expansion) {
        copy.expansion.set(id, expanded);
    }

    return copy;
}

function randomConfig(random: Random): Config {
    const groupDepth = random.int(0, 2);
    const openMode = random.int(0, 3);

    return {
        blockSize: random.int(2, 5),
        groupColIds: ['country', 'city'].slice(0, groupDepth),
        tree: random.chance(0.6),
        openByDefault:
            openMode === 0
                ? ({ key }) => key === 'a' || key === null
                : openMode === 1
                  ? ({ level }) => level === 0
                  : undefined,
    };
}

function runSequence(seed: number, length: number, avoid: KnownBugs): { operations: number } {
    const random = createRandom(seed);
    const config = randomConfig(random);
    const projection = new ServerProjection<SRow>({
        blockSize: config.blockSize,
        groupColIds: config.groupColIds,
        ...(config.tree ? { getTreeKey: (row: SRow) => row.tk ?? null } : {}),
        ...(config.openByDefault ? { isGroupOpenByDefault: config.openByDefault } : {}),
    });
    const reference = new Reference(config);
    const seenIds = new Set<RowId>();
    const log: string[] = [
        `config: blockSize ${config.blockSize}, groupColIds ${JSON.stringify(config.groupColIds)}, tree ${config.tree}, openByDefault ${config.openByDefault ? 'yes' : 'no'}`,
    ];
    let operations = 0;
    for (let attempt = 0; operations < length && attempt < length * 4; attempt++) {
        const op = randomOp(random, reference, avoid);
        if (!op || triggersKnownBug(reference, op, avoid)) {
            continue;
        }
        log.push(op.describe);
        operations++;
        try {
            op.apply(projection, reference);
            for (const { desc } of reference.loaded()) {
                seenIds.add(desc.id);
            }
            assertEquivalent(projection, reference, random, seenIds);
        } catch (error) {
            throw new Error(
                `seed ${seed}, after ${operations} operations:\n${log.join('\n')}\n\n${(error as Error).message}`
            );
        }
    }

    return { operations };
}

/** Environment knobs for exploring by hand; the project has no Node types, so read them untyped. */
const env: Record<string, string | undefined> =
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const AVOID_ALL: KnownBugs = {
    clearWithCachedChildren: true,
    movedExpandedRow: true,
    anchorsPastCount: true,
    shortBlockRegrown: true,
};
/**
 * Knobs for exploring by hand: FUZZ_SEED and FUZZ_SEQUENCES pick the seed range, FUZZ_LENGTH the
 * operations per sequence, and FUZZ_ALLOW a comma separated list of known bugs to stop avoiding (or "all").
 */
const avoidFromEnv = (): KnownBugs => {
    // All former bug triggers run by default now that they are fixed; FUZZ_ALLOW=none avoids them again.
    const allowed = (env.FUZZ_ALLOW ?? 'all').split(',');

    return Object.fromEntries(
        Object.entries(AVOID_ALL).map(([name]) => [name, !allowed.includes(name) && !allowed.includes('all')])
    ) as KnownBugs;
};

describe('ServerProjection differential fuzz', () => {
    it('matches the reference model over random operation sequences', () => {
        let operations = 0;
        const sequences = Number(env.FUZZ_SEQUENCES ?? 2000);
        const offset = Number(env.FUZZ_SEED ?? 1);
        for (let seed = offset; seed < offset + sequences; seed++) {
            operations += runSequence(seed, Number(env.FUZZ_LENGTH ?? 20), avoidFromEnv()).operations;
        }
        expect(operations).toBeGreaterThan(sequences * 15);
    }, 60_000);
});

/**
 * Regression tests: minimal reproductions of the bugs the fuzz found while the projections were built. All fixed;
 * the fuzz above now exercises their triggers too.
 */
describe('ServerProjection regressions', () => {
    const groupOf = (key: string, childCount: number) => groupData(key, childCount);
    const people = (...ids: string[]) => ids.map((id) => dataRow(id, null));

    // clear() only walks the children map, which holds attached levels. A collapsed group's cached child
    // level stays in the level index with its rows, ids and count, although the contract says clear drops
    // every child level below the route. After a refresh, reopening the group shows the stale rows.
    it('clear drops collapsed child levels, not only expanded ones', () => {
        const projection = new ServerProjection<SRow>({ blockSize: 4, groupColIds: ['country'] });
        projection.setBlock([], 0, [groupOf('a', 2)]);
        projection.setExpanded(groupRowId(['country'], ['a']), true);
        projection.setBlock(['a'], 0, people('r1', 'r2'));
        projection.setExpanded(groupRowId(['country'], ['a']), false);
        projection.clear();

        expect(projection.getRow('r1')).toBeUndefined();

        projection.setBlock([], 0, [groupOf('a', 5)]);
        projection.setExpanded(groupRowId(['country'], ['a']), true);
        expect(projection.getRowAtIndex(1)?.row.kind).toBe('loading');
        expect(projection.getDisplayCount()).toBe(6);
    });

    // When an expanded row moves to another block, #register turns the old slot into a hole but leaves the
    // child level in the parent's children map at the old position. The child level is then attached at
    // both positions and its rows are displayed twice.
    it('an expanded group that moves to another block shows its children once', () => {
        const projection = new ServerProjection<SRow>({ blockSize: 2, groupColIds: ['country'] });
        projection.setRowCount([], 3);
        projection.setBlock([], 0, [groupOf('a', 2), groupOf('b', 1)]);
        projection.setExpanded(groupRowId(['country'], ['a']), true);
        projection.setBlock([], 1, [groupOf('a', 2)]);

        expect(projection.getDisplayCount()).toBe(5);
        expect(projection.getRowAtIndex(1)?.row.id).toBe(groupRowId(['country'], ['b']));
    });

    // Same root cause through eviction: the evicted slot keeps the child level anchored, and when the group
    // arrives in another block the level is attached there as well.
    it('an evicted expanded group that returns in another block shows its children once', () => {
        const projection = new ServerProjection<SRow>({ blockSize: 2, groupColIds: ['country'] });
        projection.setRowCount([], 3);
        projection.setBlock([], 0, [groupOf('a', 2), groupOf('b', 1)]);
        projection.setExpanded(groupRowId(['country'], ['a']), true);
        projection.removeBlock([], 0);
        projection.setBlock([], 1, [groupOf('a', 2)]);

        expect(projection.getDisplayCount()).toBe(5);
    });

    // A full block may hold rows past the level's known count (the count shrank, or a group's
    // `_childCount` is smaller than its first block). #locate, #indexWithin and forEachLoaded ignore the
    // count, so getIndexOf returns an index that getRowAtIndex does not answer for.
    it('rows past the known count are not given a displayed index', () => {
        const projection = new ServerProjection<SRow>({ blockSize: 4 });
        projection.setRowCount([], 2);
        projection.setBlock([], 0, people('r0', 'r1', 'r2', 'r3'));

        expect(projection.getDisplayCount()).toBe(2);
        expect(projection.getRowAtIndex(3)).toBeUndefined();
        expect(projection.getIndexOf('r3')).toBeUndefined();
    });

    // The same with an expanded tree row past the count: its child level is added to the display count, so
    // the rows after the real last row are the hidden row's children.
    it('an expanded row past the known count does not add its children to the display', () => {
        const projection = new ServerProjection<SRow>({ blockSize: 4, getTreeKey: (row) => row.tk ?? null });
        projection.setBlock([], 0, [
            dataRow('r0', null),
            dataRow('r1', null),
            dataRow('r2', 'k2'),
            dataRow('r3', null),
        ]);
        projection.setExpanded('r2', true);
        projection.setRowCount(['k2'], 3);
        projection.setRowCount([], 2);

        expect(projection.getDisplayCount()).toBe(2);
    });

    // missingBlocks treats a stored short block as complete. When the level later displays slots past its
    // end (a later block or setRowCount raised the count), those slots stay loading rows forever because
    // their block is never requested.
    it('requests a short block again when its unfilled slots become displayed', () => {
        const projection = new ServerProjection<SRow>({ blockSize: 4 });
        projection.setBlock([], 0, people('r0'));
        projection.setRowCount([], 4);

        expect(projection.getRowAtIndex(2)?.row.kind).toBe('loading');
        expect(projection.missingBlocks(0, 3)).toEqual([{ route: [], blockIndex: 0 }]);
    });
});
