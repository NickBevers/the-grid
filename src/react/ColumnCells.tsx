/**
 * Renders columns of the horizontal window into a row (body, pinned or header): a sticky left section,
 * the mounted center cells between column spacers, and a sticky right section, all in normal flow.
 *
 * The consumer renders cell contents; these components own each cell's width and placement, so header,
 * header groups and every row use exactly the same widths.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

import type { GroupHeaderCell, HorizontalWindow, LaidOutColumn } from '../virtual/horizontalLayout';
import type { HorizontalVirtualizer } from './useHorizontalVirtualizer';

const pinnedStyle = (side: 'left' | 'right', width: number): CSSProperties => ({
    position: 'sticky',
    [side]: 0,
    zIndex: 1,
    display: 'flex',
    flex: 'none',
    width,
    // Covers the center cells scrolling underneath; the row's background shows through `inherit`.
    background: 'inherit',
});

/** A spacer is keyed by the run it precedes, so it keeps its identity while the window moves. */
function spacerKey(window: HorizontalWindow, itemIndex: number): string {
    const next = window.centerItems[itemIndex + 1];

    return next?.type === 'run' ? `spacer-before-${itemIndex === 0 ? 'first' : next.start}` : 'spacer-end';
}

/** Style for the row element that hosts `RowCells`: a flex line as wide as all columns together. */
export function rowLineStyle(window: HorizontalWindow): CSSProperties {
    return { display: 'flex', width: window.totalWidth, minWidth: '100%' };
}

/** Extra attributes for a cell element: state data attributes, classes, ids and ARIA. */
export type CellAttributes = HTMLAttributes<HTMLDivElement> & {
    [dataAttribute: `data-${string}`]: string | number | boolean | undefined;
};

type CellsProps = {
    horizontal: HorizontalVirtualizer;
    renderCell: (column: LaidOutColumn) => ReactNode;
    /** Marks the cells' part name: 'cell' in body rows, 'header-cell' in the header. */
    part?: string;
    cellAttributes?: (column: LaidOutColumn) => CellAttributes | undefined;
};

type CellProps = {
    column: LaidOutColumn;
    part: string;
    attributes: CellAttributes | undefined;
    children: ReactNode;
};

function Cell({ column, part, attributes, children }: CellProps) {
    return (
        <div
            {...attributes}
            data-grid-part={part}
            data-col-id={column.colId}
            style={{ ...attributes?.style, width: column.width, flex: 'none', minWidth: 0 }}
        >
            {children}
        </div>
    );
}

export function RowCells({ horizontal, renderCell, part = 'cell', cellAttributes }: CellsProps) {
    const { window, layout } = horizontal;

    return (
        <>
            {window.left.length > 0 ? (
                <div data-grid-part="pinned-left" style={pinnedStyle('left', window.leftWidth)}>
                    {window.left.map((column) => (
                        <Cell key={column.colId} column={column} part={part} attributes={cellAttributes?.(column)}>
                            {renderCell(column)}
                        </Cell>
                    ))}
                </div>
            ) : null}
            {window.centerItems.flatMap((item, itemIndex) =>
                item.type === 'spacer'
                    ? [
                          <div
                              key={spacerKey(window, itemIndex)}
                              aria-hidden="true"
                              data-grid-part="col-spacer"
                              style={{ width: item.size, flex: 'none' }}
                          />,
                      ]
                    : layout.centerColumns(item).map((column) => (
                          <Cell key={column.colId} column={column} part={part} attributes={cellAttributes?.(column)}>
                              {renderCell(column)}
                          </Cell>
                      ))
            )}
            {window.right.length > 0 ? (
                <div data-grid-part="pinned-right" style={pinnedStyle('right', window.rightWidth)}>
                    {window.right.map((column) => (
                        <Cell key={column.colId} column={column} part={part} attributes={cellAttributes?.(column)}>
                            {renderCell(column)}
                        </Cell>
                    ))}
                </div>
            ) : null}
        </>
    );
}

type HeaderRowsProps = {
    horizontal: HorizontalVirtualizer;
    renderHeaderCell: (column: LaidOutColumn) => ReactNode;
    renderGroupCell: (cell: GroupHeaderCell) => ReactNode;
    /** Height of each group row and of the column header row. */
    rowHeight: number;
    headerCellAttributes?: (column: LaidOutColumn) => CellAttributes | undefined;
};

function GroupCells({
    cells,
    renderGroupCell,
}: {
    cells: GroupHeaderCell[];
    renderGroupCell: (cell: GroupHeaderCell) => ReactNode;
}) {
    return cells.map((cell) => (
        <div
            key={cell.key}
            data-grid-part="group-header-cell"
            data-group-id={cell.groupId ?? undefined}
            style={{ width: cell.width, flex: 'none', minWidth: 0 }}
        >
            {renderGroupCell(cell)}
        </div>
    ));
}

/** Header group rows (outermost first) followed by the column header row. */
export function HeaderRows({
    horizontal,
    renderHeaderCell,
    renderGroupCell,
    rowHeight,
    headerCellAttributes,
}: HeaderRowsProps) {
    const { window, groupRows } = horizontal;

    return (
        <>
            {groupRows.map((row) => (
                <div
                    key={row.depth}
                    data-grid-part="group-header-row"
                    style={{ ...rowLineStyle(window), height: rowHeight }}
                >
                    {window.left.length > 0 ? (
                        <div data-grid-part="pinned-left" style={pinnedStyle('left', window.leftWidth)}>
                            <GroupCells cells={row.left} renderGroupCell={renderGroupCell} />
                        </div>
                    ) : null}
                    {row.center.flatMap((section, index) =>
                        section.type === 'spacer'
                            ? [
                                  <div
                                      key={`spacer-${index}`}
                                      aria-hidden="true"
                                      data-grid-part="col-spacer"
                                      style={{ width: section.size, flex: 'none' }}
                                  />,
                              ]
                            : [
                                  <GroupCells
                                      key={`cells-${index}`}
                                      cells={section.cells}
                                      renderGroupCell={renderGroupCell}
                                  />,
                              ]
                    )}
                    {window.right.length > 0 ? (
                        <div data-grid-part="pinned-right" style={pinnedStyle('right', window.rightWidth)}>
                            <GroupCells cells={row.right} renderGroupCell={renderGroupCell} />
                        </div>
                    ) : null}
                </div>
            ))}
            <div data-grid-part="header-row" style={{ ...rowLineStyle(window), height: rowHeight }}>
                <RowCells
                    horizontal={horizontal}
                    renderCell={renderHeaderCell}
                    part="header-cell"
                    {...(headerCellAttributes ? { cellAttributes: headerCellAttributes } : {})}
                />
            </div>
        </>
    );
}
