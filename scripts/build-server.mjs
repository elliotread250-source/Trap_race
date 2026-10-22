// Bundle the server (and the shared rules it imports) into one ESM file; `ws` stays an external runtime dependency.
import { build } from 'esbuild';
await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/server/index.js',
  external: ['ws'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
