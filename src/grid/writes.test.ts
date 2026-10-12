import { describe, expect, it } from 'vitest';

import { WriteTracker } from './writes';

const cell = { rowId: '1', colId: 'name' };

describe('WriteTracker', () => {
    it('confirms successes and rolls a failure back to the confirmed value', () => {
        const tracker = new WriteTracker();
        const first = tracker.begin(cell, 'a', 'b');
        tracker.succeed(cell, first);
        const second = tracker.begin(cell, 'b', 'c');

        expect(tracker.isPending(cell)).toBe(true);
        expect(tracker.fail(cell, second, (value) => value === 'c')).toEqual({
            restore: { value: 'b' },
            superseded: false,
        });
        expect(tracker.isPending(cell)).toBe(false);
    });

    it('an older failure changes nothing while a newer write shows', () => {
        const tracker = new WriteTracker();
        const older = tracker.begin(cell, 'a', 'b');
        tracker.begin(cell, 'b', 'c');

        expect(tracker.fail(cell, older, () => false)).toEqual({ superseded: true });
    });

    it('a newer failure restores the older write still pending, then its success confirms it', () => {
        const tracker = new WriteTracker();
        const older = tracker.begin(cell, 'a', 'b');
        const newer = tracker.begin(cell, 'b', 'c');

        expect(tracker.fail(cell, newer, (value) => value === 'c')).toEqual({
            restore: { value: 'b' },
            superseded: false,
        });
        tracker.succeed(cell, older);
        const third = tracker.begin(cell, 'b', 'd');
        expect(tracker.fail(cell, third, () => true)).toEqual({ restore: { value: 'b' }, superseded: false });
    });

    it('a late older success does not override a newer confirmed value', () => {
        const tracker = new WriteTracker();
        const older = tracker.begin(cell, 'a', 'b');
        const newer = tracker.begin(cell, 'b', 'c');
        tracker.succeed(cell, newer);
        tracker.succeed(cell, older);
        const next = tracker.begin(cell, 'c', 'd');

        expect(tracker.fail(cell, next, () => true)).toEqual({ restore: { value: 'c' }, superseded: false });
    });

    it('leaves the cell alone when the failed value is no longer showing', () => {
        const tracker = new WriteTracker();
        const id = tracker.begin(cell, 'a', 'b');

        expect(tracker.fail(cell, id, () => false)).toEqual({ superseded: false });
    });

    it('tracks pending rows and newer writes per row', () => {
        const tracker = new WriteTracker();
        const first = tracker.begin(cell, 'a', 'b');
        tracker.begin({ rowId: '1', colId: 'fee' }, 1, 2);

        expect(tracker.isRowPending('1')).toBe(true);
        expect(tracker.hasNewerOnRow('1', first)).toBe(true);
        expect(tracker.hasNewerOnRow('2', first)).toBe(false);
    });
});
