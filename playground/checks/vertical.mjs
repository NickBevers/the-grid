#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Browser checks for the library's vertical virtualizer, on a production build of the playground.
 * Writes playground/results/vertical-results[-browser].json and exits non-zero when a check fails.
 *
 * Usage: node playground/checks/vertical.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5193;
const base = `http://localhost:${port}`;
const browserName = process.argv.find((arg) => arg.startsWith('--browser='))?.split('=')[1] ?? 'chromium';
const results = { date: new Date().toISOString(), environment: {}, checks: [] };

function record(name, pass, details) {
    results.checks.push({ name, pass, ...details });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
}

const settle = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const inPage = {
    counts: () => {
        const viewport = document.querySelector('.pg-viewport');

        return {
            rows: viewport.querySelectorAll('[data-row-id]').length,
            nodes: viewport.querySelectorAll('*').length,
            scrollHeight: viewport.scrollHeight,
        };
    },
    violations: () =>
        [...document.querySelector('.pg-viewport').querySelectorAll('*')]
            .map((element) => ({ element, style: getComputedStyle(element) }))
            .filter(
                ({ style, element }) =>
                    style.position === 'absolute' ||
                    style.position === 'fixed' ||
                    (element.matches('[data-row-id]') && style.transform !== 'none')
            )
            .map(({ element, style }) => `${element.className} ${style.position} ${style.transform}`)
            .slice(0, 5),
    /** Top of a row relative to the viewport's visible body (below the sticky header). */
    rowTop: (id) => {
        const viewport = document.querySelector('.pg-viewport');
        const header = viewport.querySelector('.pg-header').getBoundingClientRect();
        const row = viewport.querySelector(`[data-row-id="${id}"]`);

        return row ? row.getBoundingClientRect().top - header.bottom : null;
    },
    firstVisible: () => {
        const viewport = document.querySelector('.pg-viewport');
        const top = viewport.querySelector('.pg-header').getBoundingClientRect().bottom;
        const row = [...viewport.querySelectorAll('[data-row-id]')].find(
            (element) => element.getBoundingClientRect().bottom > top + 1
        );

        return { id: row.dataset.rowId, top: row.getBoundingClientRect().top - top };
    },
};

/** Wheel input while the page records frame intervals and frames whose body middle is blank. */
async function wheel(page, deltaY, steps) {
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
            if (!document.elementFromPoint(box.left + 200, box.top + box.height / 2)?.closest('[data-row-id]')) {
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
        await page.mouse.wheel(0, deltaY);
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
    };
}

async function open(page, fixture) {
    await page.goto(`${base}/?fixture=${fixture}`);
    await page.waitForSelector('[data-row-id]');
    await settle(page);
}

async function scrollTo(page, top) {
    await page.evaluate((value) => (document.querySelector('.pg-viewport').scrollTop = value), top);
    await settle(page);
    await settle(page);
}

async function localChecks(page, fixture) {
    await open(page, fixture);
    const counts = [];
    for (const fraction of [0, 0.3, 0.6, 0.999]) {
        await page.evaluate((f) => {
            const viewport = document.querySelector('.pg-viewport');
            viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * f;
        }, fraction);
        await settle(page);
        await settle(page);
        counts.push(await page.evaluate(inPage.counts));
    }
    record(`${fixture}: mounted rows bounded`, Math.max(...counts.map((c) => c.rows)) <= 80, {
        counts: counts.map((c) => c.rows),
    });
    record(
        `${fixture}: no absolute, fixed or transformed layout (computed)`,
        (await page.evaluate(inPage.violations)).length === 0,
        {}
    );

    await scrollTo(page, 0);
    const scroll = await wheel(page, 240, 150);
    record(`${fixture}: wheel scroll`, scroll.p95 <= 34 && scroll.gaps <= 2, scroll);

    // Height change of a mounted row above the viewport.
    await scrollTo(page, 400_000);
    const before = await page.evaluate(inPage.firstVisible);
    const above = await page.evaluate(() => {
        const top = document.querySelector('.pg-header').getBoundingClientRect().bottom;

        return [...document.querySelectorAll('[data-row-id]')]
            .filter((row) => row.getBoundingClientRect().bottom <= top && !row.dataset.rowId.startsWith('detail:'))
            .map((row) => Number(row.dataset.rowId))[0];
    });
    await page.evaluate((id) => window.__pg.growRow(id), above);
    await settle(page);
    await settle(page);
    const afterGrow = await page.evaluate(inPage.rowTop, before.id);
    record(`${fixture}: no jump when a row above grows`, above !== undefined && Math.abs(afterGrow - before.top) < 1, {
        grown: above,
        anchor: before.id,
        before: before.top,
        after: afterGrow,
    });

    // Reset of all measured heights.
    const beforeReset = await page.evaluate(inPage.firstVisible);
    await page.evaluate(() => window.__pg.resetHeights());
    await settle(page);
    await settle(page);
    const afterReset = await page.evaluate(inPage.rowTop, beforeReset.id);
    record(`${fixture}: no jump after resetHeights`, Math.abs(afterReset - beforeReset.top) < 1, {
        before: beforeReset.top,
        after: afterReset,
    });

    if (fixture === 'detail') {
        // Expand and collapse a master row above the viewport: rows are inserted and removed above the anchor.
        const anchor = await page.evaluate(inPage.firstVisible);
        const masterAbove = Math.floor((Number(anchor.id) - 20) / 10) * 10;
        await page.evaluate((id) => window.__pg.toggleDetail(id), masterAbove);
        await settle(page);
        await settle(page);
        const afterExpand = await page.evaluate(inPage.rowTop, anchor.id);
        await page.evaluate((id) => window.__pg.toggleDetail(id), masterAbove);
        await settle(page);
        await settle(page);
        const afterCollapse = await page.evaluate(inPage.rowTop, anchor.id);
        record(
            `detail: no jump when a detail row above expands and collapses`,
            Math.abs(afterExpand - anchor.top) < 1 && Math.abs(afterCollapse - anchor.top) < 1,
            {
                master: masterAbove,
                anchor: anchor.id,
                before: anchor.top,
                afterExpand,
                afterCollapse,
            }
        );

        // Expand a detail row inside the viewport: rows below move down, rows above stay.
        const visible = await page.evaluate(() => {
            const top = document.querySelector('.pg-header').getBoundingClientRect().bottom;

            return [...document.querySelectorAll('[data-row-id]')]
                .filter((row) => row.getBoundingClientRect().top >= top)
                .map((row) => row.dataset.rowId);
        });
        const master = visible.find((id) => Number(id) % 10 === 0 && Number(id) > Number(visible[0]));
        const firstTop = await page.evaluate(inPage.rowTop, visible[0]);
        await page.evaluate((id) => window.__pg.toggleDetail(Number(id)), master);
        await settle(page);
        await settle(page);
        const detailMounted = await page.evaluate(
            (id) => Boolean(document.querySelector(`[data-row-id="detail:${id}"]`)),
            master
        );
        record(
            `detail: expanding in view keeps rows above still`,
            detailMounted && Math.abs((await page.evaluate(inPage.rowTop, visible[0])) - firstTop) < 1,
            { master, detailMounted }
        );
    }

    // Retained row stays mounted far away.
    await scrollTo(page, 0);
    await page.evaluate(() => window.__pg.retain(['3']));
    await settle(page);
    await scrollTo(page, 1_000_000);
    record(
        `${fixture}: retained row stays mounted`,
        await page.evaluate(() => Boolean(document.querySelector('[data-row-id="3"]'))),
        {}
    );
    await page.evaluate(() => window.__pg.retain([]));

    // Scroll to the last row.
    await page.evaluate(() => window.__pg.scrollToIndex(window.__pg.rowCount - 1, 'end'));
    await settle(page);
    await settle(page);
    await settle(page);
    const end = await page.evaluate(() => {
        const viewport = document.querySelector('.pg-viewport');
        const rows = [...viewport.querySelectorAll('[data-row-id]')];
        const last = rows[rows.length - 1];

        return {
            lastIndex: Number(last.dataset.rowIndex),
            gap: Math.round(
                viewport.getBoundingClientRect().top + viewport.clientHeight - last.getBoundingClientRect().bottom
            ),
        };
    });
    record(
        `${fixture}: scrollToIndex reaches the last row`,
        end.lastIndex === (await page.evaluate(() => window.__pg.rowCount - 1)) && Math.abs(end.gap) <= 1,
        end
    );
}

async function remoteChecks(page) {
    await open(page, 'remote');
    await page.waitForFunction(() => !document.querySelector('.pg-loading'));
    const counts = await page.evaluate(inPage.counts);
    record(
        'remote: 1M rows use the scaled height and bounded mounts',
        counts.scrollHeight <= 10_000_100 && counts.rows <= 80,
        counts
    );

    const jumps = [];
    for (const fraction of [0.25, 0.5, 1]) {
        await page.evaluate((f) => {
            const viewport = document.querySelector('.pg-viewport');
            viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * f;
        }, fraction);
        await settle(page);
        await page.waitForFunction(() => !document.querySelector('.pg-loading'), null, { timeout: 5000 });
        await settle(page);
        jumps.push(
            await page.evaluate(() => {
                const viewport = document.querySelector('.pg-viewport');
                const rows = [...viewport.querySelectorAll('[data-row-id]')];
                const match = rows.every((row) => row.querySelector('.pg-id')?.textContent === row.dataset.rowIndex);
                const last = rows[rows.length - 1];

                return {
                    match,
                    lastIndex: Number(last.dataset.rowIndex),
                    gap: Math.round(
                        viewport.getBoundingClientRect().top +
                            viewport.clientHeight -
                            last.getBoundingClientRect().bottom
                    ),
                };
            })
        );
    }
    const end = jumps[jumps.length - 1];
    record(
        'remote: jumps show the right rows and reach the end',
        jumps.every((jump) => jump.match) && end.lastIndex === 999_999 && Math.abs(end.gap) <= 1,
        { jumps }
    );

    await scrollTo(page, 2_000_000);
    await page.waitForFunction(() => !document.querySelector('.pg-loading'), null, { timeout: 5000 });
    const scroll = await wheel(page, 400, 100);
    record('remote: fast wheel scroll', scroll.p95 <= 34 && scroll.over50 === 0, scroll);
    record(
        'remote: no absolute, fixed or transformed layout (computed)',
        (await page.evaluate(inPage.violations)).length === 0,
        {}
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
    await localChecks(page, 'local');
    await localChecks(page, 'detail');
    await remoteChecks(page);
    record('no page errors', errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
}

mkdirSync(join(root, 'playground/results'), { recursive: true });
writeFileSync(
    join(root, `playground/results/vertical-results${browserName === 'chromium' ? '' : `-${browserName}`}.json`),
    JSON.stringify(results, null, 2) + '\n'
);
const failed = results.checks.filter((check) => !check.pass);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
