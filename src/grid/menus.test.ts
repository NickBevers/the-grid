import { describe, expect, it, vi } from 'vitest';

import type { MenuItem } from '../contract';
import {
    DEFAULT_CONTEXT_MENU,
    isWithinSubject,
    openMenu,
    pointAnchor,
    resolveMenuItems,
    type BuiltinAvailability,
} from './menus';

const all: BuiltinAvailability = { canCopy: true, canPaste: true, canCut: true, mac: true };

describe('resolveMenuItems', () => {
    it('resolves built-ins with labels, platform shortcuts and availability', () => {
        const items = resolveMenuItems(['copy', 'copyWithHeaders', 'cut', 'paste'], {
            canCopy: true,
            canPaste: false,
            canCut: false,
            mac: false,
        });

        expect(items).toEqual([
            {
                type: 'item',
                id: 'copy',
                label: 'Copy',
                shortcut: 'Ctrl+C',
                disabled: false,
                destructive: false,
                builtin: 'copy',
            },
            {
                type: 'item',
                id: 'copyWithHeaders',
                label: 'Copy with headers',
                disabled: false,
                destructive: false,
                builtin: 'copyWithHeaders',
            },
            {
                type: 'item',
                id: 'cut',
                label: 'Cut',
                shortcut: 'Ctrl+X',
                disabled: true,
                destructive: false,
                builtin: 'cut',
            },
            {
                type: 'item',
                id: 'paste',
                label: 'Paste',
                shortcut: 'Ctrl+V',
                disabled: true,
                destructive: false,
                builtin: 'paste',
            },
        ]);
        expect(resolveMenuItems(['paste'], all)[0]).toMatchObject({ shortcut: '⌘V' });
    });

    it('keeps custom items, permission flags and submenus', () => {
        const onSelect = vi.fn();
        const items = resolveMenuItems(
            [
                { id: 'open', label: 'Open', onSelect },
                { id: 'delete', label: 'Delete', destructive: true, disabled: true },
                { id: 'more', label: 'More', children: [{ id: 'archive', label: 'Archive' }] },
            ],
            all
        );

        expect(items.map((item) => item.id)).toEqual(['open', 'delete', 'more']);
        expect(items[1]).toMatchObject({ destructive: true, disabled: true });
        expect(items[2]).toMatchObject({ children: [{ id: 'more/archive', label: 'Archive' }] });
        expect(items[0]).toMatchObject({ onSelect });
    });

    it('drops leading, trailing and doubled separators, and empty submenus', () => {
        const items: MenuItem[] = [
            'separator',
            { id: 'a', label: 'A' },
            'separator',
            'separator',
            { id: 'empty', label: 'Empty', children: ['separator'] },
            { id: 'b', label: 'B' },
            'separator',
        ];

        expect(resolveMenuItems(items, all).map((item) => (item.type === 'separator' ? '|' : item.id))).toEqual([
            'a',
            '|',
            'b',
        ]);
    });
});

describe('openMenu', () => {
    const base = {
        kind: 'context' as const,
        target: { rowId: '1', colId: 'name' },
        anchor: pointAnchor(10, 20),
        availability: all,
    };

    it('returns null when nothing would show, so the native menu is not suppressed', () => {
        expect(openMenu({ ...base, items: [] })).toBeNull();
        expect(openMenu({ ...base, items: ['separator'] })).toBeNull();
    });

    it('opens with resolved items and a zero-size pointer anchor', () => {
        const menu = openMenu({ ...base, items: DEFAULT_CONTEXT_MENU });

        expect(menu).toMatchObject({
            kind: 'context',
            trigger: 'pointer',
            anchor: { top: 20, left: 10, width: 0, height: 0, visible: true },
        });
        expect(menu!.items.map((item) => item.id)).toEqual(['copy', 'copyWithHeaders', 'paste']);
    });
});

describe('isWithinSubject', () => {
    it('is true inside a range or on a selected row', () => {
        const cell = { rowId: '2', colId: 'name' };

        expect(isWithinSubject(cell, { selectedRowIds: new Set(['2']), inRange: false })).toBe(true);
        expect(isWithinSubject(cell, { selectedRowIds: null, inRange: true })).toBe(true);
        expect(isWithinSubject(cell, { selectedRowIds: new Set(['3']), inRange: false })).toBe(false);
    });
});

describe('built-in actions under a custom label', () => {
    it('keeps the built-in action and availability with the given label', () => {
        const items = resolveMenuItems(
            [
                { id: 'legacyCopy', label: 'Copy with Headers', builtin: 'copyWithHeaders' },
                { id: 'legacyCut', label: 'Cut', builtin: 'cut' },
            ],
            { canCopy: true, canPaste: false, canCut: false, mac: true }
        );

        expect(items).toMatchObject([
            { id: 'legacyCopy', label: 'Copy with Headers', builtin: 'copyWithHeaders', disabled: false },
            { id: 'legacyCut', label: 'Cut', builtin: 'cut', disabled: true, shortcut: '⌘X' },
        ]);
        expect(items[0]).not.toHaveProperty('shortcut');
    });

    it('shows a given shortcut label instead of the built-in one', () => {
        const items = resolveMenuItems([{ id: 'cut', label: 'Cut', builtin: 'cut', shortcut: 'Ctrl+X' }], {
            canCopy: true,
            canPaste: false,
            canCut: true,
            mac: true,
        });

        expect(items).toMatchObject([{ id: 'cut', shortcut: 'Ctrl+X' }]);
    });
});
