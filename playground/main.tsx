import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { GridPlayground } from './GridPlayground';
import { GroupsPlayground } from './GroupsPlayground';
import { InteractivePlayground } from './InteractivePlayground';
import { ServerPlayground } from './ServerPlayground';
import { VerticalPlayground } from './VerticalPlayground';
import { WritesPlayground } from './WritesPlayground';
import './playground.css';

const fixture = new URLSearchParams(location.search).get('fixture');

/** The fixtures, newest first. The checks open each one by its `fixture` parameter. */
const FIXTURES = [
    {
        id: 'interactive',
        title: 'The full grid',
        description:
            'The <Grid> component: editing and validation, popup editors, ranges, clipboard, fill, selection, menus, column groups, theming.',
    },
    {
        id: 'server',
        title: 'The full grid on server rows',
        description:
            '100,000 people from a fake backend with latency: blocks on demand, search, filters, grouping, errors and refresh. Add &paged=1 for pages of 100, &noQuery=1 for the "search to show rows" mode.',
    },
    {
        id: 'writes',
        title: 'Persisted writes',
        description:
            'Edits, range edits, sibling propagation, paste and bulk writes saved to a fake server with latency: pending state, rollback with errors, and authoritative rows.',
    },
    {
        id: 'groups',
        title: 'Group and tree rows',
        description:
            'Row grouping in the group column or as full-width rows, tree data from paths, and master/detail with detail rows that grow. Switch with &mode=group, rows, tree or detail.',
    },
    {
        id: 'grid',
        title: 'Both virtualizers',
        description: '100,000 rows by 100 columns, pinned columns, header groups and resize handles.',
    },
    { id: 'local', title: 'Vertical: measured rows', description: '100,000 rows sized to their content.' },
    {
        id: 'detail',
        title: 'Vertical: master and detail',
        description: 'Every tenth row expands a detail row.',
    },
    {
        id: 'remote',
        title: 'Vertical: server blocks',
        description: '1,000,000 rows in 100-row blocks with scaled scrolling.',
    },
];

function Index() {
    return (
        <main className="pg-index">
            <h1>@nord-forge/the-grid playground</h1>
            <ul>
                {FIXTURES.map((item) => (
                    <li key={item.id}>
                        <a href={`?fixture=${item.id}`}>{item.title}</a>
                        <p>{item.description}</p>
                    </li>
                ))}
            </ul>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {fixture === null ? (
            <Index />
        ) : fixture === 'grid' ? (
            <GridPlayground />
        ) : fixture === 'interactive' ? (
            <InteractivePlayground />
        ) : fixture === 'server' ? (
            <ServerPlayground />
        ) : fixture === 'groups' ? (
            <GroupsPlayground />
        ) : fixture === 'writes' ? (
            <WritesPlayground />
        ) : (
            <VerticalPlayground />
        )}
    </StrictMode>
);
