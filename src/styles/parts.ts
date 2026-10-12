/**
 * The public styling surface: part names (`data-grid-part`) and state attributes. Themes may target these
 * and the `--the-grid-*` tokens, nothing else. `scripts/check-styles.mjs` fails the build when the grid
 * renders a part that is not listed here or the default stylesheet targets one that is not.
 */

/** Every value of `data-grid-part` the grid renders, with what it is. */
export const GRID_PARTS = {
    'header-menu-button': 'Opens the header menu (with headerMenuButton on).',
    'column-chooser': 'Default column chooser popover.',
    'column-chooser-item': 'One column in the column chooser, with its visibility checkbox (data-col-id).',
    'menu-submenu': 'A menu item with children, and its children while open (data-open).',
    'menu-children': 'The open children of a submenu.',
    'header-filter-button':
        'Opens the filter panel. Shown while the column is filtered, or always with headerFilterButton "always" (data-active when filtered).',
    'filter-panel': 'Default filter panel popover, below the header cell.',
    'filter-editor': 'A filter editor inside the panel (data-filter-kind).',
    'filter-condition': 'One condition of a text, number or date filter.',
    'filter-join': 'AND or OR choice between conditions.',
    'filter-operator': 'Operator select of a condition (or the value select of a boolean filter).',
    'filter-input': 'Value input of a condition.',
    'filter-search': 'Search input of a set filter.',
    'filter-choices': 'The list of set filter choices (data-loading while searching).',
    'filter-choice': 'One set filter choice (data-value; data-select-all for the select-all choice).',
    'filter-empty': 'Shown when a set filter has no choices.',
    'filter-clear': 'Clears the filter editor.',
    'root': 'The grid frame. Carries density and scroll-edge states; tokens are read from here.',
    'viewport': 'The scroll container and keyboard focus owner (role grid).',
    'header': 'The sticky header: group header rows plus the column header row.',
    'group-header-row': 'One row of column group headers.',
    'group-header-cell': 'A column group header cell.',
    'group-header-content': 'Content box of a group header cell.',
    'group-header-label': 'The sticky label of a group header.',
    'group-toggle': 'Open or close a column group (aria-expanded).',
    'header-row': 'The column header row.',
    'header-cell': 'A column header cell (role columnheader, aria-sort, plus the column headerClass).',
    'header-content': 'Content box of a header cell.',
    'header-label': 'The header text.',
    'sort-indicator': 'Sort arrow and priority.',
    'resize-handle': 'Column resize handle.',
    'header-checkbox': 'Select all checkbox.',
    'body': 'The row group holding body rows.',
    'pinned-top': 'Rows pinned below the header (inside the sticky header block).',
    'pinned-bottom': 'The sticky row group of rows pinned below the body (totals).',
    'row': 'A body row (role row, plus rowClassName).',
    'row-spacer':
        'Vertical virtualization spacer, and the place a stuck group row keeps in the body. Never style its height.',
    'sticky-rows':
        'Group rows stuck below the header (stickyGroupRows). It has no height; the rows hang over the body.',
    'col-spacer': 'Horizontal virtualization spacer. Never style its width.',
    'pinned-left': 'Sticky left pinned section of a row or header row.',
    'pinned-right': 'Sticky right pinned section of a row or header row.',
    'cell': 'A body cell (role gridcell, plus the column cellClass and cellStyle).',
    'cell-value': 'Default cell text, when the column has no renderer.',
    'cell-content': 'Wraps the row drag handle and the cell content in the drag column.',
    'row-drag-handle': 'Drag handle to reorder rows (rowDrag).',
    'cell-loading': 'Placeholder content of a loading row.',
    'row-checkbox': 'Row selection checkbox.',
    'full-width-row': 'The single cell of a full-width, detail or group row.',
    'group-row-content': 'Default content of a full-width group row: toggle, label and count, indented by level.',
    'group-cell-content': 'Default content of a group column cell: toggle, label and count, indented by level.',
    'row-expand-toggle': 'Expand and collapse button of a group, tree or master row (aria-expanded).',
    'row-expand-spacer': 'Space where a leaf has no toggle, so labels line up.',
    'row-group-label': 'Group or tree row label.',
    'row-group-count': 'Child count of a group.',
    'fill-handle': 'The fill handle on the corner cell of a range.',
    'editor-input': 'The default text editor input.',
    'editor-error': 'Validation message under an editor.',
    'overlay': 'Loading, empty or error overlay (data-overlay, data-overlay-reason).',
    'overlay-retry': 'Default retry button in the error overlay.',
    'footer': 'The footer slot.',
    'menu': 'Default context and header menu.',
    'menu-item': 'Default menu item (disabled, data-destructive).',
    'menu-label': 'Default menu item label.',
    'menu-shortcut': 'Default menu item shortcut.',
    'menu-separator': 'Default menu separator.',
    'popup': 'Default popup editor container.',
} as const;

export type GridPart = keyof typeof GRID_PARTS;

/** State attributes, the parts they appear on, and what they mean. Values are present or absent unless noted. */
export const GRID_STATES = {
    'data-density': 'root: "comfortable" or "compact".',
    'data-color-scheme': 'root: "light", "dark" or "system" (follows the operating system).',
    'data-scrolled-left': 'root: content sits under the left pinned section.',
    'data-scrolled-right': 'root: content sits under the right pinned section.',
    'data-scrolled-top': 'root: rows sit under the header.',
    'data-dragging': 'viewport: a range or fill drag is in progress.',
    'data-row-kind': 'row: "data", "group", "detail", "fullWidth", "loading" or "failed".',
    'data-row-pinned': 'row: "top" or "bottom" for a pinned row.',
    'data-selected': 'row: selected.',
    'data-active': 'row: the active row (its record is open elsewhere). header-filter-button: the column is filtered.',
    'data-highlight-start': 'row: first row of a run of selected or active rows, from the row model.',
    'data-highlight-end': 'row: last row of such a run.',
    'data-row-dragging': 'row: being dragged.',
    'data-drop-position': 'row: the drop target during a row drag, "before" or "after".',
    'data-focused': 'cell, full-width-row: holds keyboard focus.',
    'data-editing': 'cell: an editor is open.',
    'data-editable': 'cell: the cell can be edited.',
    'data-hover-guard':
        'cell: lines a hover ring leaves to a neighbour in a higher state ("top", "left", "corner"), so focus and selection stay on top.',
    'data-menu-open':
        "viewport: one of the grid's menus is open; the focused cell keeps its ring while the menu holds keyboard focus.",
    'data-first-row':
        'row: the first displayed row; at the top it draws the line under the header, so its rings sit on that line.',
    'data-edge':
        "resize-handle: 'end' at the column's own right edge, 'start' at the next column's left edge (resizes the previous column).",
    'data-checked': "menu-item: the current choice (the column's sort direction).",
    'data-filter-kind': 'filter-editor: the filter kind it edits.',
    'data-loading': 'filter-choices: a choice search is running.',
    'data-select-all': 'filter-choice: the choice that selects all visible values.',
    'data-value': "filter-choice: the choice's value (empty for blank).",
    'data-section-start':
        'cell: first cell of the left-pinned or center section; its rings draw their left side inside the cell.',
    'data-pending': 'cell: a write to it is waiting for `persist`.',
    'data-open': 'menu-submenu: its children are showing.',
    'data-invalid':
        'cell: the last pasted, filled or cleared value was rejected (title holds the message); editor container: the draft failed validation.',
    'data-range': 'cell: inside a range; the value is how many ranges contain it.',
    'data-range-top': 'cell: on the top edge of a range.',
    'data-range-bottom': 'cell: on the bottom edge of a range.',
    'data-range-left': 'cell: on the left edge of a range.',
    'data-range-right': 'cell: on the right edge of a range.',
    'data-fill-target': 'cell: inside the fill handle preview.',
    'data-grid-editor': 'The editor container inside an editing cell or popup.',
    'data-validating': 'editor container: an async validation is running.',
    'data-sortable': 'header-content: clicking sorts.',
    'data-sort': 'sort-indicator: "asc" or "desc".',
    'data-overlay': 'overlay: "loading", "empty" or "error".',
    'data-overlay-reason': 'overlay: why it is empty, "noQuery" (nothing asked yet) or "noResults".',
    'data-destructive': 'menu-item: a destructive action.',
} as const;

export type GridStateAttribute = keyof typeof GRID_STATES;

/** Identity attributes for targeting one row, column or group. Stable, but carry data, not state. */
export const GRID_IDENTITY_ATTRIBUTES = [
    'data-row-id',
    'data-row-index',
    'data-col-id',
    'data-group-id',
    'data-menu-item',
] as const;
