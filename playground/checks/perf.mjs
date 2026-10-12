#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Performance run of the full <Grid> (?fixture=interactive&rows=N): times every interaction a user does,
 * reports frame times and long tasks, and in Chromium records a CPU profile per scenario and lists the
 * functions with the most self time. Unminified build, so the profile names are readable.
 *
 * Usage: node playground/checks/perf.mjs [--browser=chromium] [--rows=100000] [--only=scenario,...]
 * Writes playground/results/PERF-results[-browser].json.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5193;
const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const browserName = arg('browser', 'chromium');
const rows = Number(arg('rows', 100000));
const only = arg('only', '')?.split(',').filter(Boolean);
const results = { date: new Date().toISOString(), rows, environment: {}, scenarios: [] };

const settle = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Starts frame and long task recording in the page. */
async function startRecording(page) {
    await page.evaluate(() => {
        window.__perf = { frames: [], longTasks: [], start: performance.now() };
        let last = performance.now();
        const tick = (now) => {
            if (!window.__perf) {
                return;
            }
            window.__perf.frames.push(now - last);
            last = now;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        try {
            window.__perfObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    window.__perf?.longTasks.push(Math.round(entry.duration));
                }
            });
            window.__perfObserver.observe({ type: 'longtask', buffered: false });
        } catch {
            // Long tasks are Chromium only.
        }
    });
}

async function stopRecording(page) {
    return page.evaluate(() => {
        const perf = window.__perf;
        window.__perf = null;
        window.__perfObserver?.disconnect();
        const frames = perf.frames.slice(1);
        const sorted = [...frames].sort((a, b) => a - b);
        const pick = (q) =>
            sorted.length
                ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10
                : 0;

        return {
            ms: Math.round(performance.now() - perf.start),
            frames: frames.length,
            p50: pick(0.5),
            p95: pick(0.95),
            max: Math.round(Math.max(0, ...frames)),
            over50: frames.filter((frame) => frame > 50).length,
            longTasks: perf.longTasks.length,
            longestTask: Math.max(0, ...perf.longTasks),
        };
    });
}

/** Runs one scenario with recording and, in Chromium, a CPU profile summarised by self time. */
async function scenario(page, cdp, name, run) {
    if (only.length && !only.includes(name)) {
        return;
    }
    await settle(page);
    if (cdp) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
        await cdp.send('Profiler.start');
    }
    await startRecording(page);
    const extra = (await run()) ?? {};
    await settle(page);
    const timing = await stopRecording(page);
    let hot = [];
    if (cdp) {
        const { profile } = await cdp.send('Profiler.stop');
        hot = summarise(profile);
    }
    const entry = { name, ...timing, ...extra, hot };
    results.scenarios.push(entry);
    console.log(`\n${name}: ${JSON.stringify({ ...timing, ...extra })}`);
    for (const line of hot.slice(0, 8)) {
        console.log(`   ${String(line.selfMs).padStart(6)} ms  ${line.name}  ${line.url}`);
    }
}

/** Self time per function from a CDP profile, grid code first. */
function summarise(profile) {
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const self = new Map();
    const deltas = profile.timeDeltas;
    profile.samples.forEach((id, index) => {
        const node = byId.get(id);
        const frame = node.callFrame;
        const key = `${frame.functionName || '(anonymous)'}|${(frame.url || '').split('/').pop()}:${frame.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + (deltas[index] ?? 0) / 1000);
    });

    return [...self]
        .map(([key, ms]) => ({ name: key.split('|')[0], url: key.split('|')[1], selfMs: Math.round(ms) }))
        .filter(
            (entry) =>
                !['(idle)', '(program)', '(garbage collector)', '(root)'].includes(entry.name) ||
                entry.name === '(garbage collector)'
        )
        .sort((a, b) => b.selfMs - a.selfMs)
        .slice(0, 15);
}

async function cellBox(page, rowId, colId) {
    await page.evaluate(({ r, c }) => window.__ig.api.geometry.ensureCellVisible({ rowId: r, colId: c }, 'center'), {
        r: rowId,
        c: colId,
    });
    await settle(page);

    return page.locator(`[data-row-id="${rowId}"] [data-grid-part="cell"][data-col-id="${colId}"]`).boundingBox();
}

async function run(page, cdp) {
    await page.goto(`http://localhost:${port}/?fixture=interactive&rows=${rows}`);
    await page.waitForSelector('[data-row-id="1"]');
    await settle(page);
    const viewport = await page.locator('[data-grid-part="viewport"]').boundingBox();
    const reset = () =>
        page.evaluate(() => {
            const api = window.__ig.api;
            api.clearRanges();
            api.deselectAll();
            api.setQuickFilter('');
            api.setFilterModel({});
            api.setSortModel([]);
            api.geometry.setScroll({ top: 0, left: 0 });
        });

    await scenario(page, cdp, 'range drag with autoscroll (3 s)', async () => {
        const start = await cellBox(page, '5', 'm1');
        await page.mouse.move(start.x + 10, start.y + 10);
        await page.mouse.down();
        await page.mouse.move(start.x + 400, viewport.y + viewport.height - 6, { steps: 10 });
        await page.waitForTimeout(3000);
        await page.mouse.up();
        const range = await page.evaluate(() => window.__ig.api.getResolvedRanges()[0]);

        return { rangeRows: range?.rowIds.length ?? 0, rangeCols: range?.colIds.length ?? 0 };
    });

    await scenario(page, cdp, 'scroll with that range active', async () => {
        await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
        for (let index = 0; index < 60; index++) {
            await page.mouse.wheel(0, -150);
            await page.waitForTimeout(16);
        }
    });

    await reset();
    await scenario(page, cdp, 'select all cells (Ctrl or Cmd plus A)', async () => {
        await page.locator('[data-grid-part="viewport"]').focus();
        await page.evaluate(() => window.__ig.api.setFocusedCell({ rowId: '1', colId: 'name' }, { scroll: false }));
        const started = Date.now();
        await page.keyboard.press('ControlOrMeta+a');
        await settle(page);

        return { applyMs: Date.now() - started };
    });

    await scenario(page, cdp, 'scroll with every cell selected', async () => {
        await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
        for (let index = 0; index < 60; index++) {
            await page.mouse.wheel(0, 300);
            await page.waitForTimeout(16);
        }
    });

    await scenario(page, cdp, 'copy every cell', async () => {
        const result = await page.evaluate(() => {
            const transfer = new DataTransfer();
            const event = new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true });
            const started = performance.now();
            document.querySelector('[data-grid-part="viewport"]').dispatchEvent(event);

            return {
                copyMs: Math.round(performance.now() - started),
                bytes: event.clipboardData.getData('text/plain').length,
            };
        });

        return result;
    });

    await reset();
    await scenario(page, cdp, 'extend to the last row (Shift plus Ctrl or Cmd plus ArrowDown)', async () => {
        await page.evaluate(() => window.__ig.api.setFocusedCell({ rowId: '1', colId: 'm1' }, { scroll: false }));
        await page.locator('[data-grid-part="viewport"]').focus();
        const started = Date.now();
        await page.keyboard.press('Shift+ControlOrMeta+ArrowDown');
        await settle(page);

        return { applyMs: Date.now() - started };
    });

    await reset();
    await scenario(page, cdp, 'keyboard navigation (100 ArrowDown)', async () => {
        await page.evaluate(() => window.__ig.api.setFocusedCell({ rowId: '1', colId: 'name' }, { scroll: false }));
        await page.locator('[data-grid-part="viewport"]').focus();
        for (let index = 0; index < 100; index++) {
            await page.keyboard.press('ArrowDown');
        }
    });

    await reset();
    await scenario(page, cdp, 'sort by clicking a header', async () => {
        const started = Date.now();
        await page
            .locator('[data-grid-part="header-cell"][data-col-id="name"] [data-grid-part="header-label"]')
            .click();
        await settle(page);

        return { applyMs: Date.now() - started };
    });

    await reset();
    await scenario(page, cdp, 'filter model', async () => {
        const applyMs = await page.evaluate(() => {
            const started = performance.now();
            window.__ig.api.setFilterModel({ fee: { filterType: 'number', type: 'greaterThan', filter: 500 } });

            return Math.round(performance.now() - started);
        });

        return { applyMs };
    });

    await reset();
    await scenario(page, cdp, 'quick filter typed word by word', async () => {
        // One keystroke at a time, each measured until the grid has painted, as a user types.
        const perKeystrokeMs = [];
        for (const text of ['d', 'de', 'dea', 'deal', 'deal 1', 'deal 12']) {
            perKeystrokeMs.push(
                await page.evaluate(
                    (value) =>
                        new Promise((resolve) => {
                            const started = performance.now();
                            window.__ig.api.setQuickFilter(value);
                            requestAnimationFrame(() =>
                                requestAnimationFrame(() => resolve(Math.round(performance.now() - started)))
                            );
                        }),
                    text
                )
            );
        }

        return { perKeystrokeMs };
    });

    await reset();
    await scenario(page, cdp, 'select all rows and scroll', async () => {
        await page.locator('[data-grid-part="header-checkbox"]').click();
        await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
        for (let index = 0; index < 40; index++) {
            await page.mouse.wheel(0, 300);
            await page.waitForTimeout(16);
        }
    });

    await reset();
    await scenario(page, cdp, 'transaction adding 1,000 rows', async () => {
        const applyMs = await page.evaluate(() => {
            const base = window.__ig.rows[1];
            const added = Array.from({ length: 1000 }, (_, index) => ({
                ...base,
                id: 9_000_000 + index,
                name: `Added ${index}`,
            }));
            const started = performance.now();
            window.__ig.api.applyTransaction({ add: { rows: added, index: 0 } });

            return Math.round(performance.now() - started);
        });

        return { applyMs };
    });

    await reset();
    await scenario(page, cdp, 'fill handle over 300 rows', async () => {
        await page.evaluate(() => {
            window.__ig.api.setRanges([{ anchor: { rowId: '2', colId: 'm2' }, end: { rowId: '3', colId: 'm3' } }]);
            window.__ig.api.geometry.ensureCellVisible({ rowId: '3', colId: 'm3' }, 'start');
        });
        await settle(page);
        const handle = await page.locator('[data-grid-part="fill-handle"]').boundingBox();
        await page.mouse.move(handle.x + 3, handle.y + 3);
        await page.mouse.down();
        await page.mouse.move(handle.x + 3, viewport.y + viewport.height - 6, { steps: 8 });
        await page.waitForTimeout(1500);
        await page.mouse.up();
        await page.waitForTimeout(300);
    });

    await reset();
    await scenario(page, cdp, 'typing 30 characters in an editor', async () => {
        await page.evaluate(() => window.__ig.api.setFocusedCell({ rowId: '4', colId: 'name' }, { scroll: false }));
        await page.locator('[data-grid-part="viewport"]').focus();
        await page.keyboard.press('Enter');
        await page.keyboard.type('abcdefghijklmnopqrstuvwxyz1234', { delay: 10 });
        await page.keyboard.press('Escape');
    });

    results.heapMb = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576));
}

const configFile = join(root, 'playground/vite.config.ts');
await build({ configFile, logLevel: 'warn', build: { minify: false } });
const server = await preview({ configFile, preview: { port, strictPort: true }, logLevel: 'warn' });
const browserType = { chromium, firefox, webkit }[browserName];
const browser = await browserType.launch();
results.environment = { browser: `${browserName} ${browser.version()}`, platform: process.platform };
try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    const cdp = browserName === 'chromium' ? await context.newCDPSession(page) : null;
    await run(page, cdp);
} catch (error) {
    console.error(error);
    results.error = String(error?.stack ?? error).slice(0, 800);
} finally {
    await browser.close();
    server.httpServer.close();
}

const suffix = browserName === 'chromium' ? '' : `-${browserName}`;
mkdirSync(join(root, 'playground/results'), { recursive: true });
writeFileSync(join(root, `playground/results/PERF-results${suffix}.json`), JSON.stringify(results, null, 2));
console.log(`\nheap ${results.heapMb} MB`);
