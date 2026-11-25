// Bundles the page into dist/ (what GitHub Pages serves). `--serve` starts a dev server.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const serve = process.argv.includes('--serve');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });
cpSync('project', 'dist/project', { recursive: true });
writeFileSync('dist/project/files.json', JSON.stringify(readdirSync('project')));
cpSync('node_modules/littlefs/dist/littlefs.wasm', 'dist/littlefs.wasm');

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  // The littlefs wasm glue only touches these under Node.
  external: ['fs', 'path', 'crypto'],
  target: 'es2022',
  outfile: 'dist/app.js',
  sourcemap: true,
  minify: !serve,
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: 'dist', port: 8080 });
  console.log(`http://localhost:${port}/  (project/ and public/ are copied once at start)`);
} else {
  await esbuild.build(options);
  console.log('built dist/');
}
