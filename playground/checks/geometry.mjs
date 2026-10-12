#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Geometry browser checks: every answer of the grid's GeometryApi is compared with the real DOM, on the
 * 100,000-row measured grid and on a 1,000,000-row scaled grid, at several scroll positions.
 * Writes playground/results/geometry-results[-browser].json; exits non-zero on failure.
 *
 * Usage: node playground/checks/geometry.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5191;
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
            viewport.scrollLeft = x;
            viewport.scrollTop = y;
        },
        { left, top }
    );
    await settle(page);
    await waitForStableHeights(page);
}

/**
 * Newly mounted rows are measured after their first paint; until then the layout answers with estimated
 * heights, which is the documented behaviour. Wait until the mounted rows' heights stop changing.
 */
async function waitForStableHeights(page) {
    // The contract: estimates until measured, then the measured height. Wait (bounded) until the layout's
    // heights agree with the rendered rows; a layout that never converges fails the comparisons below.
    for (let attempt = 0; attempt < 60; attempt++) {
        const converged = await page.evaluate(() =>
            [...document.querySelectorAll('[data-row-id]')].every(
                (row) =>
                    Math.abs(
                        (window.__pg.geometry.getRowBounds(row.dataset.rowId)?.height ?? 0) -
                            row.getBoundingClientRect().height
                    ) < 0.5
            )
        );
        if (converged) {
            return;
        }
        await settle(page);
    }
}

/** Anchors against DOM rects for every mounted cell that is fully visible in the body. */
const compareAnchors = () => {
    const geometry = window.__pg.geometry;
    const viewport = document.querySelector('.pg-viewport');
    const box = viewport.getBoundingClientRect();
    const headerBottom = document.querySelector('.pg-grid-header').getBoundingClientRect().bottom;
    let maxDiff = 0;
    let compared = 0;
    let visibleMismatch = 0;
    for (const row of document.querySelectorAll('[data-row-id]')) {
        const rowRect = row.getBoundingClientRect();
        if (rowRect.top < headerBottom || rowRect.bottom > box.top + viewport.clientHeight) {
            continue;
        }
        for (const cell of row.querySelectorAll('[data-grid-part="cell"]')) {
            const rect = cell.getBoundingClientRect();
            const anchor = geometry.getCellAnchor({ rowId: row.dataset.rowId, colId: cell.dataset.colId });
            if (!anchor) {
                visibleMismatch++;
                continue;
            }
            // `visible` means some part of the cell can be seen. A center cell is visible only where it
            // overlaps the area between the pinned sections, inside the viewport.
            const pinnedCell = Boolean(cell.closest('[data-grid-part="pinned-left"], [data-grid-part="pinned-right"]'));
            const leftEdge = pinnedCell
                ? box.left
                : row.querySelector('[data-grid-part="pinned-left"]').getBoundingClientRect().right;
            const rightEdge = pinnedCell
                ? box.left + viewport.clientWidth
                : Math.min(
                      row.querySelector('[data-grid-part="pinned-right"]').getBoundingClientRect().left,
                      box.left + viewport.clientWidth
                  );
            const covered = false;
            const onScreen = Math.min(rect.right, rightEdge) - Math.max(rect.left, leftEdge) > 0.5;
            if (anchor.visible !== (onScreen && !covered) && rect.width > 1) {
                visibleMismatch++;
                window.__mismatch = window.__mismatch ?? [];
                if (window.__mismatch.length < 4) {
                    window.__mismatch.push({
                        col: cell.dataset.colId,
                        row: row.dataset.rowId,
                        anchorVisible: anchor.visible,
                        onScreen,
                        covered,
                        left: Math.round(rect.left),
                        right: Math.round(rect.right),
                        anchorLeft: Math.round(anchor.left),
                    });
                }
            }
            // The anchor is the cell's box within the row, so its height is the row box (including the
            // row border), not the inner cell element.
            const diff = Math.max(
                Math.abs(anchor.top - rect.top),
                Math.abs(anchor.left - rect.left),
                Math.abs(anchor.width - rect.width),
                Math.abs(anchor.height - rowRect.height)
            );
            if (diff > maxDiff) {
                window.__worst = {
                    row: row.dataset.rowId,
                    col: cell.dataset.colId,
                    anchor: [anchor.top, anchor.left, anchor.width, anchor.height].map(Math.round),
                    dom: [rect.top, rect.left, rect.width, rowRect.height].map(Math.round),
                };
            }
            maxDiff = Math.max(maxDiff, diff);
            compared++;
        }
    }

    const worst = maxDiff >= 1 ? window.__worst : undefined;
    window.__worst = undefined;

    return {
        maxDiff: Math.round(maxDiff * 100) / 100,
        compared,
        visibleMismatch,
        examples: (window.__mismatch ?? []).splice(0),
        worst,
    };
};

/** Hit tests on a grid of points against what the browser says is under each point. */
const compareHits = () => {
    const geometry = window.__pg.geometry;
    const viewport = document.querySelector('.pg-viewport');
    const box = viewport.getBoundingClientRect();
    let checked = 0;
    const mismatches = [];
    for (let y = box.top + 5; y < box.top + viewport.clientHeight - 2; y += 23) {
        for (let x = box.left + 3; x < box.left + viewport.clientWidth - 2; x += 37) {
            const element = document.elementFromPoint(x, y);
            const hit = geometry.hitTest(x, y);
            const domCell = element?.closest('[data-grid-part="cell"]');
            const domHeader = element?.closest('[data-grid-part="header-cell"], [data-grid-part="group-header-row"]');
            let expected;
            if (domHeader) {
                expected = 'header';
            } else if (domCell) {
                const rowRect = domCell.closest('[data-row-id]').getBoundingClientRect();
                const cellRect = domCell.getBoundingClientRect();
                // A probe within a pixel of an edge is ambiguous. Rows sit at sub-pixel positions, and far down
                // a long scroll the browser's hit testing can disagree with getBoundingClientRect by up to a
                // pixel (seen at 1.2 million px in Chromium). getBoundingClientRect stays exact.
                const band = 1;
                if (
                    Math.min(
                        Math.abs(y - rowRect.top),
                        Math.abs(y - rowRect.bottom),
                        Math.abs(x - cellRect.left),
                        Math.abs(x - cellRect.right)
                    ) < band
                ) {
                    continue;
                }
                expected = `${domCell.closest('[data-row-id]').dataset.rowId}/${domCell.dataset.colId}`;
            } else {
                continue;
            }
            const actual =
                hit.area === 'header'
                    ? 'header'
                    : hit.area === 'cell'
                      ? `${hit.cell.rowId}/${hit.cell.colId}`
                      : hit.area;
            checked++;
            if (actual !== expected) {
                mismatches.push({ x: Math.round(x), y: Math.round(y), expected, actual });
            }
        }
    }

    return { checked, mismatches: mismatches.length, examples: mismatches.slice(0, 3) };
};

async function geometryChecks(page, fixture, positions) {
    await page.goto(`http://localhost:${port}/?fixture=grid${fixture}`);
    await page.waitForSelector('[data-row-id]');
    await settle(page);
    await waitForStableHeights(page);
    const label = fixture ? '1M scaled' : '100k measured';

    const anchorSamples = [];
    const hitSamples = [];
    for (const [left, top] of positions) {
        await scroll(page, left, top);
        anchorSamples.push({ left, top, ...(await page.evaluate(compareAnchors)) });
        hitSamples.push({ left, top, ...(await page.evaluate(compareHits)) });
    }
    record(
        `${label}: cell anchors match the DOM`,
        anchorSamples.every((s) => s.maxDiff < 1 && s.compared > 50 && s.visibleMismatch === 0),
        { samples: anchorSamples }
    );
    record(
        `${label}: hit testing matches elementFromPoint`,
        hitSamples.every((s) => s.mismatches === 0 && s.checked > 200),
        {
            samples: hitSamples.map(({ left, top, checked, mismatches, examples }) => ({
                left,
                top,
                checked,
                mismatches,
                examples,
            })),
        }
    );

    // Bounds for a row far from the viewport, then bring it into view and compare with the DOM.
    const far = await page.evaluate(() => {
        const geometry = window.__pg.geometry;
        const target = {
            rowId: String(Math.floor(window.__pg.rowCount ? window.__pg.rowCount * 0.8 : 80_000)),
            colId: 'c70',
        };
        const before = geometry.getCellBounds(target);
        geometry.ensureCellVisible(target);

        return { target, before };
    });
    await settle(page);
    await settle(page);
    await settle(page);
    const ensured = await page.evaluate(({ target }) => {
        const geometry = window.__pg.geometry;
        const cell = document.querySelector(`[data-row-id="${target.rowId}"] [data-col-id="${target.colId}"]`);
        if (!cell) {
            return { mounted: false };
        }
        const rect = cell.getBoundingClientRect();
        const anchor = geometry.getCellAnchor(target);
        const viewport = document.querySelector('.pg-viewport');
        const box = viewport.getBoundingClientRect();
        const headerBottom = document.querySelector('.pg-grid-header').getBoundingClientRect().bottom;
        const pinnedLeft = document
            .querySelector('.pg-grid-header [data-grid-part="pinned-left"]')
            .getBoundingClientRect().right;
        const pinnedRight = document
            .querySelector('.pg-grid-header [data-grid-part="pinned-right"]')
            .getBoundingClientRect().left;
        const after = geometry.getCellBounds(target);

        return {
            mounted: true,
            fullyVisible:
                rect.top >= headerBottom - 0.5 &&
                rect.bottom <= box.top + viewport.clientHeight + 0.5 &&
                rect.left >= pinnedLeft - 0.5 &&
                rect.right <= pinnedRight + 0.5,
            anchorDiff:
                Math.round(Math.max(Math.abs(anchor.top - rect.top), Math.abs(anchor.left - rect.left)) * 100) / 100,
            anchorVisible: anchor.visible,
            boundsTop: after.top,
        };
    }, far);
    record(
        `${label}: ensureCellVisible brings a far cell fully into view`,
        ensured.mounted && ensured.fullyVisible && ensured.anchorDiff < 1 && ensured.anchorVisible,
        { ...far, ...ensured }
    );

    // Edge proximity and the viewport events.
    const proximity = await page.evaluate(() => {
        const viewport = document.querySelector('.pg-viewport');
        const box = viewport.getBoundingClientRect();
        const headerBottom = document.querySelector('.pg-grid-header').getBoundingClientRect().bottom;
        const pinnedLeft = document
            .querySelector('.pg-grid-header [data-grid-part="pinned-left"]')
            .getBoundingClientRect().right;

        return {
            result: window.__pg.geometry.edgeProximity(pinnedLeft + 10, headerBottom + 4),
            expectedTop: 4,
            expectedLeft: 10,
            boxTop: box.top,
        };
    });
    record(
        `${label}: edge proximity measures from the body edges`,
        Math.abs(proximity.result.top - 4) < 0.6 && Math.abs(proximity.result.left - 10) < 0.6,
        proximity.result
    );
    const log = await page.evaluate(() => window.__pg.eventLog());
    record(
        `${label}: scroll and visibleRangeChanged events fire`,
        log.scroll >= positions.length && log.visibleRangeChanged >= positions.length,
        log
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
    await geometryChecks(page, '', [
        [0, 0],
        [1700, 250_000],
        [6000, 1_200_000],
        [100_000, 9_000_000],
    ]);
    await geometryChecks(page, '&rows=1000000', [
        [0, 0],
        [2500, 2_000],
        [4000, 5_000_000],
        [100_000, 100_000_000],
    ]);
    record('no page errors', errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
}

mkdirSync(join(root, 'playground/results'), { recursive: true });
writeFileSync(
    join(root, `playground/results/geometry-results${browserName === 'chromium' ? '' : `-${browserName}`}.json`),
    JSON.stringify(results, null, 2) + '\n'
);
const failed = results.checks.filter((check) => !check.pass);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
