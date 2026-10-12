#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Horizontal browser checks: both virtualizers together on the playground's grid fixture (100,000 rows,
 * 100 columns, two header group levels, pinned left and right, an autoHeight Notes column, resizing).
 * Runs on a production build. Writes playground/results/horizontal-results[-browser].json; exits non-zero on failure.
 *
 * Usage: node playground/checks/horizontal.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5192;
const browserName = process.argv.find((arg) => arg.startsWith('--browser='))?.split('=')[1] ?? 'chromium';
const results = { date: new Date().toISOString(), environment: {}, checks: [] };

function record(name, pass, details) {
    results.checks.push({ name, pass, ...details });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
}

const settle = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function scroll(page, left, top) {
    await page.evaluate(
        ({ left: x, top: y }) => {
            const viewport = document.querySelector('.pg-viewport');
            if (x !== null) {
                viewport.scrollLeft = x;
            }
            if (y !== null) {
                viewport.scrollTop = y;
            }
        },
        { left, top }
    );
    await settle(page);
    await settle(page);
}

/**
 * Alignment of everything that shares the width model, measured on screen: header cells against the cells
 * of a visible body row, group cells against the header cells they span, and the pinned sections against
 * the viewport edges.
 */
const alignment = () => {
    const viewport = document.querySelector('.pg-viewport');
    const box = viewport.getBoundingClientRect();
    const rectOf = (element) => element.getBoundingClientRect();
    const headerCells = new Map(
        [...document.querySelectorAll('[data-grid-part="header-cell"]')].map((cell) => [
            cell.dataset.colId,
            rectOf(cell),
        ])
    );
    const headerBottom = rectOf(document.querySelector('.pg-grid-header')).bottom;
    const row = [...document.querySelectorAll('[data-row-id]')].find(
        (candidate) => rectOf(candidate).top >= headerBottom
    );
    let bodyOffset = 0;
    let compared = 0;
    for (const cell of row.querySelectorAll('[data-grid-part="cell"]')) {
        const header = headerCells.get(cell.dataset.colId);
        if (header) {
            const rect = rectOf(cell);
            bodyOffset = Math.max(bodyOffset, Math.abs(rect.left - header.left), Math.abs(rect.width - header.width));
            compared++;
        }
    }
    let groupOffset = 0;
    let groups = 0;
    for (const row of document.querySelectorAll('[data-grid-part="group-header-row"]')) {
        // A group cell spans the header cells under it: walk the header row in screen order within each section.
        for (const groupCell of row.querySelectorAll('[data-grid-part="group-header-cell"]')) {
            const rect = rectOf(groupCell);
            const inside = [...headerCells.values()].filter(
                (header) =>
                    header.left >= rect.left - 0.5 &&
                    header.right <= rect.right + 0.5 &&
                    Math.abs(header.top - rect.top) < 200
            );
            if (inside.length === 0) {
                continue;
            }
            const left = Math.min(...inside.map((header) => header.left));
            const right = Math.max(...inside.map((header) => header.right));
            groupOffset = Math.max(groupOffset, Math.abs(left - rect.left), Math.abs(right - rect.right));
            groups++;
        }
    }
    const pinnedLeft = rectOf(row.querySelector('[data-grid-part="pinned-left"]'));
    const pinnedRight = rectOf(row.querySelector('[data-grid-part="pinned-right"]'));

    return {
        bodyOffset: Math.round(bodyOffset * 100) / 100,
        compared,
        groupOffset: Math.round(groupOffset * 100) / 100,
        groups,
        pinnedLeftOffset: Math.round(Math.abs(pinnedLeft.left - box.left) * 100) / 100,
        pinnedRightOffset: Math.round(Math.abs(box.left + viewport.clientWidth - pinnedRight.right) * 100) / 100,
    };
};

const counts = () => {
    const rows = [...document.querySelectorAll('[data-row-id]')];

    return {
        rows: rows.length,
        cellsPerRow: Math.max(...rows.map((row) => row.querySelectorAll('[data-grid-part="cell"]').length)),
        headerCells: document.querySelectorAll('[data-grid-part="header-cell"]').length,
    };
};

const violations = () =>
    [...document.querySelector('.pg-viewport').querySelectorAll('*')]
        .map((element) => ({ element, style: getComputedStyle(element) }))
        .filter(
            ({ element, style }) =>
                style.position === 'absolute' ||
                style.position === 'fixed' ||
                (element.matches('[data-row-id], [data-grid-part="cell"]') && style.transform !== 'none')
        )
        .map(({ element, style }) => `${element.className} ${style.position}`)
        .slice(0, 5);

async function wheel(page, deltaX, deltaY, steps) {
    await page.evaluate(() => {
        window.__frames = [];
        window.__gaps = 0;
        window.__on = true;
        const viewport = document.querySelector('.pg-viewport');
        let last = performance.now();
        const tick = (now) => {
            window.__frames.push(now - last);
            last = now;
            const box = viewport.getBoundingClientRect();
            // Probe the middle of the center section: a blank (spacer) there means cells were missing.
            const probe = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (!probe?.closest('[data-grid-part="cell"]')) {
                window.__gaps++;
            }
            if (window.__on) {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    });
    const box = await page.locator('.pg-viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < steps; step++) {
        await page.mouse.wheel(deltaX, deltaY);
        await page.waitForTimeout(8);
    }
    await page.waitForTimeout(100);
    const { frames, gaps } = await page.evaluate(() => {
        window.__on = false;

        return { frames: window.__frames.slice(2), gaps: window.__gaps };
    });
    const sorted = [...frames].sort((a, b) => a - b);

    return {
        p50: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: Math.max(...frames),
        over50: frames.filter((frame) => frame > 50).length,
        gaps,
        frames: frames.length,
    };
}

async function checks(page) {
    await page.goto(`http://localhost:${port}/?fixture=grid`);
    await page.waitForSelector('[data-row-id]');
    await settle(page);

    // Bounded mounting and alignment across horizontal and vertical positions.
    const samples = [];
    for (const [left, top] of [
        [0, 0],
        [1500, 0],
        [4000, 300_000],
        [8000, 1_000_000],
        [100_000, 2_000_000],
    ]) {
        await scroll(page, left, top);
        samples.push({ left, top, ...(await page.evaluate(counts)), ...(await page.evaluate(alignment)) });
    }
    record(
        '100 columns: mounted cells bounded',
        samples.every((sample) => sample.cellsPerRow <= 24 && sample.rows <= 80),
        { cellsPerRow: samples.map((s) => s.cellsPerRow), rows: samples.map((s) => s.rows) }
    );
    record(
        'header, header groups, body and pinned columns aligned at every position',
        samples.every(
            (s) =>
                s.bodyOffset < 0.5 &&
                s.groupOffset < 0.5 &&
                s.pinnedLeftOffset < 0.5 &&
                s.pinnedRightOffset < 0.5 &&
                s.compared >= 10
        ),
        {
            samples: samples.map(
                ({ left, top, bodyOffset, groupOffset, pinnedLeftOffset, pinnedRightOffset, compared, groups }) => ({
                    left,
                    top,
                    bodyOffset,
                    groupOffset,
                    pinnedLeftOffset,
                    pinnedRightOffset,
                    compared,
                    groups,
                })
            ),
        }
    );
    record('no absolute, fixed or transformed layout (computed)', (await page.evaluate(violations)).length === 0, {});

    // Resizing a center column, a pinned column and a grouped column keeps everything aligned.
    await scroll(page, 2000, 50_000);
    const widthBefore = await page.evaluate(() => window.__pg.totalWidth());
    const applied = await page.evaluate(() => [
        window.__pg.resize('c24', 333),
        window.__pg.resize('name', 240),
        window.__pg.resize('c30', 5),
        window.__pg.resize('c31', 9999),
    ]);
    await settle(page);
    const afterResize = await page.evaluate(alignment);
    const widthAfter = await page.evaluate(() => window.__pg.totalWidth());
    record(
        'resize keeps alignment and respects min and max',
        afterResize.bodyOffset < 0.5 &&
            afterResize.groupOffset < 0.5 &&
            afterResize.pinnedLeftOffset < 0.5 &&
            applied[2] === 60 &&
            applied[3] === 400,
        { applied, widthBefore, widthAfter, ...afterResize }
    );

    // A real pointer drag on a resize handle.
    // The first fully visible center column, whatever the scroll position.
    const target = await page.evaluate(() => {
        const pinned = document
            .querySelector('.pg-grid-header [data-grid-part="pinned-left"]')
            .getBoundingClientRect().right;
        const cell = [...document.querySelectorAll('[data-grid-part="header-cell"]')].find(
            (candidate) => /^c\d+$/.test(candidate.dataset.colId) && candidate.getBoundingClientRect().left >= pinned
        );

        return cell.dataset.colId;
    });
    const handle = page.locator(`[data-resize="${target}"]`);
    const handleBox = await handle.boundingBox();
    const before = await page.evaluate((colId) => window.__pg.columnWidth(colId), target);
    await page.mouse.move(handleBox.x + 3, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 83, handleBox.y + handleBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    const after = await page.evaluate((colId) => window.__pg.columnWidth(colId), target);
    const dragAlignment = await page.evaluate(alignment);
    record(
        'drag resize changes the width and keeps alignment',
        Math.abs(after - before - 80) <= 1 && dragAlignment.bodyOffset < 0.5 && dragAlignment.groupOffset < 0.5,
        { column: target, before, after, ...dragAlignment }
    );

    // Variable row heights survive horizontal scrolling: the autoHeight column stays mounted, so rows keep
    // their height and the first visible row does not move vertically.
    await scroll(page, 0, 400_000);
    const firstRow = () => {
        const header = document.querySelector('.pg-grid-header').getBoundingClientRect().bottom;
        const row = [...document.querySelectorAll('[data-row-id]')].find(
            (candidate) => candidate.getBoundingClientRect().bottom > header + 1
        );
        const heights = [...document.querySelectorAll('[data-row-id]')]
            .slice(0, 30)
            .map((candidate) => [
                candidate.dataset.rowId,
                Math.round(candidate.getBoundingClientRect().height * 100) / 100,
            ]);

        return {
            id: row.dataset.rowId,
            top: row.getBoundingClientRect().top - header,
            heights,
            notesMounted: Boolean(row.querySelector('[data-col-id="notes"]')),
        };
    };
    const start = await page.evaluate(firstRow);
    await scroll(page, 9000, null);
    const far = await page.evaluate(firstRow);
    const sameHeights = start.heights.every(([id, height]) => {
        const match = far.heights.find(([farId]) => farId === id);

        return !match || Math.abs(match[1] - height) < 0.5;
    });
    record(
        'variable row heights stay put while scrolling horizontally',
        far.id === start.id && Math.abs(far.top - start.top) < 1 && sameHeights && far.notesMounted,
        {
            anchor: start.id,
            topBefore: start.top,
            topAfter: far.top,
            sameHeights,
            notesMountedWhileScrolledAway: far.notesMounted,
        }
    );

    // Retained column stays mounted when scrolled away.
    await page.evaluate(() => window.__pg.retainColumns(['c10']));
    await scroll(page, 10_000, null);
    record(
        'retained column stays mounted',
        await page.evaluate(() => Boolean(document.querySelector('[data-row-id] [data-col-id="c10"]'))),
        {}
    );
    await page.evaluate(() => window.__pg.retainColumns([]));

    // scrollToColumn brings a column fully into view between the pinned sections.
    await page.evaluate(() => window.__pg.scrollToColumn('c60'));
    await settle(page);
    const visible = await page.evaluate(() => {
        const viewport = document.querySelector('.pg-viewport');
        const box = viewport.getBoundingClientRect();
        const header = document
            .querySelector('[data-grid-part="header-cell"][data-col-id="c60"]')
            .getBoundingClientRect();
        const pinnedLeft = document
            .querySelector('.pg-grid-header [data-grid-part="pinned-left"]')
            .getBoundingClientRect();
        const pinnedRight = document
            .querySelector('.pg-grid-header [data-grid-part="pinned-right"]')
            .getBoundingClientRect();

        return {
            left: header.left - pinnedLeft.right,
            right: pinnedRight.left - header.right,
            inside: header.left >= pinnedLeft.right - 0.5 && header.right <= pinnedRight.left + 0.5,
            viewportLeft: box.left,
        };
    });
    record('scrollToColumn shows the column between the pinned sections', visible.inside, visible);

    // Scrolling performance: horizontal and diagonal wheel input.
    await scroll(page, 0, 100_000);
    const horizontal = await wheel(page, 200, 0, 80);
    // Blank frames are budgeted relative to the frame count: a 120 Hz display renders twice the frames.
    record(
        'horizontal wheel scroll',
        horizontal.p95 <= 34 && horizontal.gaps <= Math.max(2, horizontal.frames * 0.02),
        horizontal
    );
    const diagonal = await wheel(page, 150, 200, 80);
    record(
        'diagonal wheel scroll',
        diagonal.p95 <= 34 && diagonal.gaps <= Math.max(2, diagonal.frames * 0.02),
        diagonal
    );
}

const configFile = join(root, 'playground/vite.config.ts');
const outDir = join(root, 'playground/dist');
await build({ configFile, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
const server = await preview({ configFile, build: { outDir }, preview: { port, strictPort: true } });
const browser = await { chromium, firefox, webkit }[browserName].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
results.environment = {
    browser: `${browserName} ${browser.version()}`,
    viewport: '1440x900',
    build: 'vite production',
};

try {
    await checks(page);
    record('no page errors', errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
}

mkdirSync(join(root, 'playground/results'), { recursive: true });
writeFileSync(
    join(root, `playground/results/horizontal-results${browserName === 'chromium' ? '' : `-${browserName}`}.json`),
    JSON.stringify(results, null, 2) + '\n'
);
const failed = results.checks.filter((check) => !check.pass);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
