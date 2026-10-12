# Changelog

## 0.1.0

First public release.

- Virtualized rows and columns in normal document flow, with sticky headers, pinned columns and pinned rows.
- Local and server row models, with server rows loaded in blocks.
- Sorting, filtering through pluggable filter kinds, quick search and saved views.
- Row grouping in a group column or as full-width rows, tree data, master/detail rows, and sticky group rows.
- Cell ranges, keyboard navigation, clipboard copy and paste, fill handle.
- Editing with validation, popup editors and persisted writes with optimistic updates and rollback.
- A geometry API for hit testing, anchors and scrolling, so applications never query grid DOM.
- A neutral default theme in its own cascade layer, themed through `--the-grid-*` tokens and public parts.
