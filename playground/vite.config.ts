import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { fileURLToPath } from 'node:url';

/** Library playground: development fixtures that use `src/` directly. Never part of the package. */
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    server: { fs: { allow: ['..'] } },
});
