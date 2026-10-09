import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { MODEL_LONG_NAME, MODEL_NAME, MODEL_TAGLINE, MODEL_VERSION } from './shared/beta3/params';

/** %MODEL_NAME% and the like in the HTML pages, from the model's constants in params.ts */
const modelName = (): Plugin => ({
  name: 'model-name',
  transformIndexHtml: {
    order: 'pre',
    handler: (html) =>
      html
        .replace(/%MODEL_NAME%/g, MODEL_NAME)
        .replace(/%MODEL_LONG_NAME%/g, MODEL_LONG_NAME)
        .replace(/%MODEL_TAGLINE%/g, MODEL_TAGLINE)
        .replace(/%MODEL_VERSION%/g, MODEL_VERSION),
  },
});

/**
 * Cross-origin isolation in the dev server, so the workers share memory (SharedArrayBuffer).
 * Static hosts such as GitHub Pages send no such headers; the app then copies the arrays instead,
 * with the same results. `npm run preview` leaves them out too, to match.
 */
const CROSS_ORIGIN_ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };

export default defineConfig({
  root: 'client',
  // BASE_PATH=/sf-trace/ for a project page; the default './' works under any path
  base: process.env.BASE_PATH || './',
  // per checkout, so checkouts that share node_modules don't clear each other's cache
  cacheDir: resolve(__dirname, '.vite-cache'),
  publicDir: false,
  plugins: [modelName()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { app: resolve(__dirname, 'client/index.html'), method: resolve(__dirname, 'client/method/index.html') },
    },
  },
  server: { port: 5180, headers: CROSS_ORIGIN_ISOLATION },
  preview: { port: 4180 },
});
