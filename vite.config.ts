import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: { outDir: '../dist/client', emptyOutDir: true, target: 'es2020', assetsDir: 'assets', sourcemap: false },
  server: { port: 5173, proxy: { '/ws': { target: 'ws://localhost:8080', ws: true }, '/healthz': 'http://localhost:8080' } },
});
