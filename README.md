# @nord-forge/the-grid

A virtualized React data grid. Rows and cells are laid out in normal document flow (nothing in this package uses `position: absolute`); pinned columns and headers use `position: sticky`. It has no runtime dependencies besides React.

Status: early release (0.x). Local and server row models, sorting, filtering, grouping and tree rows with sticky group rows, pinned rows and columns, ranges, clipboard, editing with persisted writes, saved views and export queries work. The API may still change before 1.0.

## Install

```sh
npm install @nord-forge/the-grid
```

React 19 is a peer dependency. The package has no runtime dependencies of its own.

## Use

```tsx
import { Grid, type ColumnDefinition } from '@nord-forge/the-grid';
import '@nord-forge/the-grid/styles.css';

type Person = { id: number; name: string; team: string };

const columns: ColumnDefinition<Person>[] = [
    { field: 'name', headerName: 'Name', sortable: true },
    { field: 'team', headerName: 'Team', filter: 'set' },
];

export function People({ people }: { people: Person[] }) {
    return (
        <div style={{ height: 480 }}>
            <Grid<Person>
                data={{ type: 'local', rows: people, getRowId: (person) => String(person.id) }}
                columns={columns}
                ariaLabel="People"
            />
        </div>
    );
}
```

## Styling

`@nord-forge/the-grid/styles.css` is a neutral default theme. Every rule sits in the `the-grid` cascade layer with zero specificity, so any rule the application writes outside that layer wins, without `!important`. Theme the grid by overriding `--the-grid-*` tokens on the grid's `className` or an ancestor, and style states through the public parts (`data-grid-part`) and state attributes. `colorScheme` picks light, dark or system colours; `density` picks comfortable or compact spacing. `GRID_PARTS` and `GRID_STATES` export the full list of parts and states at runtime; the tokens are declared at the top of `styles.css`.

```css
.my-grid {
    --the-grid-accent: #0f766e;
    --the-grid-header-background: #f8fafc;
}

.my-grid [data-grid-part='row'][data-selected] [data-grid-part='cell'] {
    font-weight: 600;
}
```

## Development

| Command | What it does |
| --- | --- |
| `npm run tsc` | Type check the library and the playground |
| `npm test` | Unit tests (Vitest) for `src/` |
| `npm run build` | Build `dist/` (ESM, type declarations and `styles.css`), then guard it: the styling API rules (`check-styles`), no absolute positioning, React peers only |
| `npm run check` | All of the above plus the browser checks |
| `npm run playground` | Development fixtures; `?fixture=interactive` is the full grid with a theme, colour scheme and density switcher |
| `npm run playground:check` | Browser checks for the playground fixtures (add `-- --browser=firefox` or `webkit`); results go to `playground/results/` |
| `npm run format` | Format with oxfmt |

`npm install` needs `legacy-peer-deps`, which `.npmrc` sets, because of an npm 10 peer resolution bug.

## Layout

| Path | Ships | Purpose |
| --- | --- | --- |
| `src/` | yes | The library |
| `playground/` | no | Development fixtures and their browser checks |
| `scripts/` | no | The styling and `dist` guards |

## Rules

- No `position: absolute` or `position: fixed` in library code or CSS. Use normal flow, flex or grid, `position: sticky`, and portals for transient UI. The build guard enforces this for shipped code; the playground checks enforce it for computed layout.
- No third-party grid imports, names or copied internals in `src/`.
- Consumer code never needs to query grid DOM: rows, geometry and state come from the api (`src/contract/api.ts`).

## License

MIT. See [LICENSE](LICENSE).
