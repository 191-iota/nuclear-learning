import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { localDb } from './server/localdb';

// web_pen_sdk ships a webpack CommonJS bundle that transitively includes
// firebase / jszip / jquery and references the Node `global` identifier.
// Mapping `global` to `globalThis` and pre-bundling the dep lets it load in a
// browser ESM build. If you ever hit a `Buffer is not defined` error, add a
// Node polyfill plugin (e.g. vite-plugin-node-polyfills).
export default defineConfig({
  // The file database rides the dev server: everything durable lands under ./data,
  // outside the browser profile, so clearing browser data destroys nothing.
  plugins: [vue(), localDb(fileURLToPath(new URL('./data', import.meta.url)))],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@config': fileURLToPath(new URL('./config', import.meta.url)),
    },
  },
  define: {
    global: 'globalThis',
  },
  // web_pen_sdk imports Neo ncode page-definition files (.nproj, which are XML)
  // from its NoteServer code. We never use NoteServer / ncode mapping, but the
  // bundler still follows those imports — treat them as inert assets (build) and
  // text (dev pre-bundle) so they are not parsed as JavaScript.
  assetsInclude: ['**/*.nproj'],
  optimizeDeps: {
    include: ['web_pen_sdk'],
    // The dependency pre-bundle runs in isolation and follows the .nproj imports
    // too, so it needs the same instruction as the app build above.
    rolldownOptions: {
      moduleTypes: { '.nproj': 'text' },
    },
  },
  server: {
    port: 5173,
  },
});
