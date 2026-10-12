/**
 * Menu state for context and header menus. The grid decides what is open, where, and with which items; the
 * app renders the menu (with the shared `Dropdown` family) from that state and the anchor. No grid DOM
 * portals: the anchor is a client rect from the geometry api or the pointer.
 *
 * Built-in items (`copy`, `copyWithHeaders`, `cut`, `paste`) are resolved to concrete items with labels,
 * shortcuts and availability, so the app renders every item the same way.
 */
import type { AnchorRect, BuiltinMenuItem, CellPosition, MenuItem, ResolvedMenuItem } from '../contract';

export type { ResolvedMenuItem } from '../contract';

export type MenuKind = 'context' | 'header';

export type MenuState = {
    kind: MenuKind;
    /** The cell or header the menu was opened on. `rowId` is null for header menus and empty space. */
    target: { rowId: string | null; colId: string | null };
    /** Where to anchor the menu: a pointer position (zero size) or an element rect, in client coordinates. */
    anchor: AnchorRect;
    items: ResolvedMenuItem[];
    /** How it was opened, so keyboard opening can focus the first item. */
    trigger: 'pointer' | 'keyboard';
};

export type BuiltinAvailability = {
    /** A focused cell or a range exists, so there is something to copy. */
    canCopy: boolean;
    /** Clipboard writes are allowed and at least one target cell is writable. */
    canPaste: boolean;
    /** Copy is allowed and the copied cells can be cleared. */
    canCut: boolean;
    /** Platform for shortcut labels. */
    mac: boolean;
    /** Header menus: the column can be sorted, and how it is sorted now. */
    sortable?: boolean;
    sort?: 'asc' | 'desc' | null;
    /** Header menus: the column has a filter editor, and a filter is active on it. */
    filterable?: boolean;
    filtered?: boolean;
};

const BUILTIN_LABELS: Record<BuiltinMenuItem, string> = {
    copy: 'Copy',
    copyWithHeaders: 'Copy with headers',
    cut: 'Cut',
    paste: 'Paste',
    sortAscending: 'Sort ascending',
    sortDescending: 'Sort descending',
    clearSort: 'Clear sort',
    filter: 'Filter…',
    clearFilter: 'Clear filter',
};

function builtinEnabled(item: BuiltinMenuItem, availability: BuiltinAvailability): boolean {
    switch (item) {
        case 'paste':
            return availability.canPaste;
        case 'cut':
            return availability.canCut;
        case 'copy':
        case 'copyWithHeaders':
            return availability.canCopy;
        case 'sortAscending':
        case 'sortDescending':
            return availability.sortable ?? false;
        case 'clearSort':
            return (availability.sortable ?? false) && Boolean(availability.sort);
        case 'filter':
            return availability.filterable ?? false;
        case 'clearFilter':
            return availability.filtered ?? false;
    }
}

/** Header built-ins that do not apply to the column are left out rather than shown disabled. */
const HIDDEN_WHEN_DISABLED = new Set<BuiltinMenuItem>(['sortAscending', 'sortDescending', 'filter']);

const BUILTIN_SHORTCUTS = { copy: 'C', cut: 'X', paste: 'V' } as const;

/**
 * Turns menu items into resolved items: built-ins get labels, shortcuts and availability; separators at the
 * start, the end, or next to each other are dropped; submenus are resolved the same way and dropped when empty.
 */
export function resolveMenuItems(
    items: readonly MenuItem[],
    availability: BuiltinAvailability,
    path = ''
): ResolvedMenuItem[] {
    const resolved: ResolvedMenuItem[] = [];
    items.forEach((item, index) => {
        if (item === 'separator') {
            resolved.push({ type: 'separator', id: `${path}separator-${index}` });

            return;
        }
        if (typeof item === 'string') {
            const shortcutKey =
                item in BUILTIN_SHORTCUTS ? BUILTIN_SHORTCUTS[item as keyof typeof BUILTIN_SHORTCUTS] : undefined;
            const enabled = builtinEnabled(item, availability);
            if (
                (!enabled && HIDDEN_WHEN_DISABLED.has(item)) ||
                (item === 'clearSort' && !availability.sortable) ||
                (item === 'clearFilter' && !availability.filterable)
            ) {
                return;
            }
            const checked =
                (item === 'sortAscending' && availability.sort === 'asc') ||
                (item === 'sortDescending' && availability.sort === 'desc');
            resolved.push({
                type: 'item',
                id: `${path}${item}`,
                label: BUILTIN_LABELS[item],
                ...(shortcutKey ? { shortcut: `${availability.mac ? '⌘' : 'Ctrl+'}${shortcutKey}` } : {}),
                disabled: !enabled,
                destructive: false,
                builtin: item,
                ...(checked ? { checked: true } : {}),
            });

            return;
        }
        const children = item.children
            ? resolveMenuItems(item.children, availability, `${path}${item.id}/`)
            : undefined;
        if (item.children && children!.every((child) => child.type === 'separator')) {
            return;
        }
        const builtinKey =
            item.builtin && item.builtin in BUILTIN_SHORTCUTS
                ? BUILTIN_SHORTCUTS[item.builtin as keyof typeof BUILTIN_SHORTCUTS]
                : undefined;
        const shortcut = item.shortcut ?? (builtinKey ? `${availability.mac ? '⌘' : 'Ctrl+'}${builtinKey}` : undefined);
        resolved.push({
            type: 'item',
            id: `${path}${item.id}`,
            label: item.label,
            ...(shortcut ? { shortcut } : {}),
            ...(item.icon !== undefined ? { icon: item.icon } : {}),
            disabled: item.disabled ?? (item.builtin ? !builtinEnabled(item.builtin, availability) : false),
            destructive: item.destructive ?? false,
            ...(item.onSelect ? { onSelect: item.onSelect } : {}),
            ...(item.builtin ? { builtin: item.builtin } : {}),
            ...(children ? { children } : {}),
        });
    });

    return tidySeparators(resolved);
}

function tidySeparators(items: ResolvedMenuItem[]): ResolvedMenuItem[] {
    const result: ResolvedMenuItem[] = [];
    for (const item of items) {
        if (item.type === 'separator' && (result.length === 0 || result[result.length - 1]!.type === 'separator')) {
            continue;
        }
        result.push(item);
    }
    while (result.length > 0 && result[result.length - 1]!.type === 'separator') {
        result.pop();
    }

    return result;
}

/**
 * The default header menu when the app gives no `getHeaderMenuItems`: sorting and filtering for the column.
 * Items that do not apply (an unsortable column, no filter) are left out.
 */
export const DEFAULT_HEADER_MENU: readonly MenuItem[] = [
    'sortAscending',
    'sortDescending',
    'clearSort',
    'separator',
    'filter',
    'clearFilter',
];

/** The default context menu when the app gives no `getContextMenuItems`: the clipboard items. */
export const DEFAULT_CONTEXT_MENU: readonly MenuItem[] = ['copy', 'copyWithHeaders', 'paste'];

/**
 * Opens a menu. Returns null when there is nothing to show (no items, or every item a separator), so the
 * browser's own context menu is not suppressed for nothing.
 */
export function openMenu(input: {
    kind: MenuKind;
    target: { rowId: string | null; colId: string | null };
    anchor: AnchorRect;
    items: readonly MenuItem[];
    availability: BuiltinAvailability;
    trigger?: 'pointer' | 'keyboard';
}): MenuState | null {
    const items = resolveMenuItems(input.items, input.availability);
    if (items.length === 0) {
        return null;
    }

    return { kind: input.kind, target: input.target, anchor: input.anchor, items, trigger: input.trigger ?? 'pointer' };
}

/** A zero-size anchor at a pointer position. */
export function pointAnchor(clientX: number, clientY: number): AnchorRect {
    return { top: clientY, left: clientX, width: 0, height: 0, visible: true };
}

/**
 * Whether a right click on a cell keeps the current selection or ranges as the menu's subject (
 * keeps a range when the click lands inside it, and row actions apply to the selection when the clicked
 * row is selected).
 */
export function isWithinSubject(
    cell: CellPosition,
    subject: { selectedRowIds: ReadonlySet<string> | null; inRange: boolean }
): boolean {
    return subject.inRange || (subject.selectedRowIds?.has(cell.rowId) ?? false);
}
