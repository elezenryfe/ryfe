import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Cargo holds a lock on src-tauri during a build; watching it crashes Vite on Windows.
    watch: { ignored: ['**/src-tauri/**', '**/target/**'] },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        island: resolve(root, 'index.html'),
      },
    },
  },
});
