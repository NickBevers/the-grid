/**
 * Renders the vertical window: spacer divs and rows in normal document flow, top to bottom.
 *
 * The consumer renders each row. It must put `rowProps` on the row's outer element: they carry the row id
 * the measurer reads, the measuring ref for rows sized by content, and the fixed height otherwise.
 */
import { Fragment, type CSSProperties, type ReactNode } from 'react';

import type { GridRow } from '../contract';
import type { VerticalVirtualizer } from './useVerticalVirtualizer';

export type RowRenderProps = {
    'data-row-id': string;
    'data-row-index': number;
    'ref': ((element: HTMLElement | null) => (() => void) | undefined) | undefined;
    'style': CSSProperties | undefined;
};

export type VirtualRowsProps<TData> = {
    virtualizer: VerticalVirtualizer<TData>;
    renderRow: (row: GridRow<TData>, index: number, rowProps: RowRenderProps) => ReactNode;
};

export function VirtualRows<TData>({ virtualizer, renderRow }: VirtualRowsProps<TData>) {
    const { window, rowAt, measureRef, fixedHeight } = virtualizer;

    // One flat list: rows keyed by row id, spacers by their position between runs. Rows keep their React
    // identity while scrolling, so moving the window never remounts a row that stays in view.
    const children: ReactNode[] = [];
    window.items.forEach((item, itemIndex) => {
        if (item.type === 'spacer') {
            const next = window.items[itemIndex + 1];
            const key =
                next && next.type === 'run' ? `spacer-before-${itemIndex === 0 ? 'first' : next.start}` : 'spacer-end';
            children.push(
                <div key={key} aria-hidden="true" data-grid-part="row-spacer" style={{ height: item.size }} />
            );
            return;
        }
        for (let index = item.start; index <= item.end; index++) {
            const row = rowAt(index);
            if (!row) {
                continue;
            }
            const height = fixedHeight(row);
            children.push(
                <Fragment key={row.id}>
                    {renderRow(row, index, {
                        'data-row-id': row.id,
                        'data-row-index': index,
                        'ref': height === undefined ? measureRef : undefined,
                        'style': height === undefined ? undefined : { height },
                    })}
                </Fragment>
            );
        }
    });

    return <>{children}</>;
}
