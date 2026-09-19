import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The day this build was made, as an ISO date (LT-308). Reproducible enough:
 *  it is what About shows beside the version, so "which build is this" has an
 *  answer that does not need a git checkout. */
const BUILT_ON = new Date().toISOString().slice(0, 10);

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILT_ON__: JSON.stringify(BUILT_ON),
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // The Rust build writes tens of thousands of files into target/ and deletes
    // them again mid-build; watching it makes the dev server fall over with
    // ENOENT on a fingerprint file. Nothing in there is a frontend source.
    watch: { ignored: ['**/target/**', '**/src-tauri/gen/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'chrome110',
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
