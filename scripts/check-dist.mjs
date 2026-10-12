#!/usr/bin/env node
/**
 * Guards the published package after a build:
 * - source maps reference only the package's own `src/` files (nothing copied in from elsewhere)
 * - no absolute positioning in shipped code or CSS
 * - runtime imports limited to the React peer dependencies
 * - dependencies in package.json limited to peers (nothing can arrive transitively)
 * - the packed file list contains only dist, README, LICENSE, CHANGELOG and package.json
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const failures = [];

function walk(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);

        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const allowedImports = new Set(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']);

for (const file of walk(dist)) {
    const name = relative(root, file);
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.map')) {
        for (const source of JSON.parse(text).sources ?? []) {
            if (!/^(?:\.\.\/)+src\//.test(source)) {
                failures.push(`${name}: maps a source outside src/ (${source})`);
            }
        }
    }
    if (/\.(js|css)$/.test(file) && /position\s*:\s*(absolute|fixed)/.test(text)) {
        failures.push(`${name}: uses absolute or fixed positioning`);
    }
    if (file.endsWith('.js')) {
        for (const match of text.matchAll(
            /(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
        )) {
            const specifier = match[1] ?? match[2];
            if (!specifier.startsWith('.') && !allowedImports.has(specifier)) {
                failures.push(`${name}: imports ${specifier}`);
            }
        }
    }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies']) {
    const names = Object.keys(manifest[field] ?? {});
    if (names.length) {
        failures.push(`package.json ${field} must be empty, found: ${names.join(', ')}`);
    }
}
const peers = Object.keys(manifest.peerDependencies ?? {});
if (peers.some((peer) => !['react', 'react-dom'].includes(peer))) {
    failures.push(`unexpected peer dependencies: ${peers.join(', ')}`);
}

const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })
)[0];
const unexpected = packed.files
    .map((file) => file.path)
    .filter((path) => !/^(dist\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/.test(path));
if (unexpected.length) {
    failures.push(`packed files outside dist: ${unexpected.join(', ')}`);
}

if (failures.length) {
    console.error(`check-dist failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log(
    `check-dist ok: ${packed.files.length} files, ${(packed.size / 1024).toFixed(1)} kB packed, no absolute positioning, React peers only`
);
