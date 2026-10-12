import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * Library build. Only `src/` is bundled; React stays a peer dependency. The prototype, benchmark and
 * baselines have their own Vite configs and never feed into this output.
 */
export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
        minify: false,
        lib: {
            entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
            formats: ['es'],
            fileName: () => 'index.js',
        },
        rolldownOptions: {
            external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
        },
    },
});
