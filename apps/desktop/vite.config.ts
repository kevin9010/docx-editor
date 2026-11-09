import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import vue from '@vitejs/plugin-vue';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(appRoot, '../..');

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    dedupe: ['vue', 'yjs'],
  },
  optimizeDeps: {
    exclude: ['@superdoc/docx-engine'],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    fs: {
      allow: [searchForWorkspaceRoot(appRoot)],
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // Keep the public package's worker assets as sibling files. Inlining a
      // module worker as a data URL is rejected by Chromium/WebView2.
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  define: {
    __DESKTOP_WORKSPACE_ROOT__: JSON.stringify(workspaceRoot),
  },
});
