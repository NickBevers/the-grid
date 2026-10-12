/**
 * Defaults the grid uses when the app does not supply its own: a text editor, a native popover menu and a
 * native popover for popup editors. The app replaces the menu and popup with its own components
 * (`renderMenu`, `renderPopup`); these exist so the grid works on its own and in the playground.
 *
 * Popovers sit in the browser's top layer, so nothing here positions itself inside the grid. Placement
 * only sets the popover's inset from the anchor.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type {
    AnchorRect,
    CellEditorComponent,
    GridColumnChooserRenderProps,
    GridFilterPanelRenderProps,
    GridMenuRenderProps,
    GridPopupRenderProps,
    ResolvedMenuItem,
} from '../contract';

/** A plain text input. A typed start key replaces the value; Enter, F2 or a double click keep it. */
export const TextCellEditor: CellEditorComponent<unknown> = ({ draft, setDraft, startKey, error }) => {
    const inputRef = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
        if (startKey !== null) {
            setDraft(startKey);
        }
        const input = inputRef.current;
        if (input) {
            input.focus({ preventScroll: true });
            const end = input.value.length;
            input.setSelectionRange(startKey !== null ? end : 0, end);
        }
        // Runs once per mount: the grid clears startKey after the first draft change.
    }, []);

    return (
        <input
            ref={inputRef}
            data-grid-part="editor-input"
            aria-invalid={error ? true : undefined}
            title={error ?? undefined}
            value={draft === null || draft === undefined ? '' : String(draft)}
            onChange={(event) => setDraft(event.target.value)}
        />
    );
};

function popoverInset(anchor: AnchorRect, below: boolean): CSSProperties {
    return {
        margin: 0,
        inset: 'auto',
        top: below ? anchor.top + anchor.height : anchor.top,
        left: anchor.left,
    };
}

/**
 * Shows a manual popover once mounted and dismisses it on a pointer down outside it, and on Escape when
 * asked (a popup editor leaves Escape to the editor, which cancels). Manual, because the browser's own
 * light dismiss would close a menu opened by a right click on that click's pointer up.
 */
function usePopover(onDismiss: () => void, options: { closeOnEscape: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const dismiss = useRef(onDismiss);
    dismiss.current = onDismiss;
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) {
            return;
        }
        element.showPopover?.();
        const onPointerDown = (event: PointerEvent) => {
            if (!element.contains(event.target as Node)) {
                dismiss.current();
            }
        };
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (options.closeOnEscape && event.key === 'Escape' && element.contains(document.activeElement)) {
                event.preventDefault();
                event.stopPropagation();
                dismiss.current();
            }
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);

        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            if (element.isConnected && element.matches(':popover-open')) {
                element.hidePopover();
            }
        };
        // The options are fixed per component.
    }, []);

    return ref;
}

/** Default popup editor host: a popover below the cell. */
export function DefaultPopup({ anchor, children, onDismiss }: GridPopupRenderProps) {
    const ref = usePopover(onDismiss, { closeOnEscape: false });

    return (
        <div
            ref={ref}
            popover="manual"
            data-grid-part="popup"
            data-grid-editor-popup=""
            style={popoverInset(anchor, true)}
        >
            {children}
        </div>
    );
}

/** Default menu: a popover list with arrow key navigation. */
export function DefaultMenu({ anchor, items, trigger, onSelect, onClose }: GridMenuRenderProps) {
    const ref = usePopover(onClose, { closeOnEscape: true });
    useEffect(() => {
        const first = ref.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not([disabled])');
        if (first) {
            first.focus({ preventScroll: true });
        } else {
            ref.current?.focus({ preventScroll: true });
        }
    }, [ref, trigger]);
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const buttons = [
            ...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []),
        ];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            buttons[(index + step + buttons.length) % buttons.length]?.focus();
        }
    };

    return (
        <div
            ref={ref}
            popover="manual"
            role="menu"
            tabIndex={-1}
            data-grid-part="menu"
            style={popoverInset(anchor, anchor.height > 0)}
            onKeyDown={onKeyDown}
        >
            <MenuItems items={items} onSelect={onSelect} />
        </div>
    );
}

function MenuItems({ items, onSelect }: { items: ResolvedMenuItem[]; onSelect: GridMenuRenderProps['onSelect'] }) {
    return items.map((item) =>
        item.type === 'separator' ? (
            <div key={item.id} role="separator" data-grid-part="menu-separator" />
        ) : item.children ? (
            <SubMenu key={item.id} item={item} onSelect={onSelect} />
        ) : (
            <button
                key={item.id}
                type="button"
                role={isRadio(item) ? 'menuitemradio' : 'menuitem'}
                aria-checked={isRadio(item) ? Boolean(item.checked) : undefined}
                data-grid-part="menu-item"
                data-menu-item={item.id}
                data-checked={item.checked || undefined}
                data-destructive={item.destructive || undefined}
                disabled={item.disabled}
                onClick={() => onSelect(item)}
            >
                <span data-grid-part="menu-label">{item.label}</span>
                {item.shortcut ? <span data-grid-part="menu-shortcut">{item.shortcut}</span> : null}
            </button>
        )
    );
}

/**
 * A submenu: the item opens its children below it on hover, click, Enter or ArrowRight. Leaving it with
 * the pointer or ArrowLeft closes them.
 */
function SubMenu({
    item,
    onSelect,
}: {
    item: ResolvedMenuItem & { type: 'item' };
    onSelect: GridMenuRenderProps['onSelect'];
}) {
    const [open, setOpen] = useState(false);

    return (
        <div
            data-grid-part="menu-submenu"
            data-open={open || undefined}
            onPointerEnter={(event) => event.pointerType === 'mouse' && setOpen(true)}
            onPointerLeave={(event) => event.pointerType === 'mouse' && setOpen(false)}
        >
            <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                data-grid-part="menu-item"
                data-menu-item={item.id}
                disabled={item.disabled}
                onClick={(event) => (event.detail === 0 ? setOpen((value) => !value) : setOpen(true))}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') {
                        setOpen(true);
                    } else if (event.key === 'ArrowLeft') {
                        setOpen(false);
                    }
                }}
            >
                <span data-grid-part="menu-label">{item.label}</span>
                <span data-grid-part="menu-shortcut" aria-hidden="true">
                    ›
                </span>
            </button>
            {open ? (
                <div role="menu" data-grid-part="menu-children">
                    <MenuItems items={item.children!} onSelect={onSelect} />
                </div>
            ) : null}
        </div>
    );
}

const isRadio = (item: ResolvedMenuItem & { type: 'item' }) =>
    item.builtin === 'sortAscending' || item.builtin === 'sortDescending';

/** Default filter panel host: a popover below the header cell, closed by Escape or a click outside. */
export function DefaultFilterPanel<TData>({ anchor, children, onClose, column }: GridFilterPanelRenderProps<TData>) {
    const ref = usePopover(onClose, { closeOnEscape: true });
    useEffect(() => {
        ref.current?.querySelector<HTMLElement>('select, input, button')?.focus({ preventScroll: true });
    }, [ref]);

    return (
        <div
            ref={ref}
            popover="manual"
            role="dialog"
            aria-label={`Filter ${column.headerName}`}
            data-grid-part="filter-panel"
            style={popoverInset(anchor, true)}
        >
            {children}
        </div>
    );
}

/** Default column chooser: a popover with a checkbox per column; locked columns cannot be hidden. */
export function DefaultColumnChooser<TData>({
    anchor,
    columns,
    setVisible,
    onClose,
}: GridColumnChooserRenderProps<TData>) {
    const ref = usePopover(onClose, { closeOnEscape: true });
    useEffect(() => {
        ref.current?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
    }, [ref]);

    return (
        <div
            ref={ref}
            popover="manual"
            role="dialog"
            aria-label="Choose columns"
            data-grid-part="column-chooser"
            style={popoverInset(anchor, true)}
        >
            {columns.map((column) => (
                <label key={column.colId} data-grid-part="column-chooser-item" data-col-id={column.colId}>
                    <input
                        type="checkbox"
                        checked={column.visible}
                        disabled={column.locked}
                        onChange={(event) => setVisible(column.colId, event.target.checked)}
                    />
                    {column.label}
                </label>
            ))}
        </div>
    );
}
