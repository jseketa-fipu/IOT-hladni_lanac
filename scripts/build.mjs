// Bundles the page into dist/ (what GitHub Pages serves).
// `--serve` starts a dev server with live reload: changes in src/ rebuild the bundle,
// changes in project/ or public/ are copied into dist/, and the open page reloads
// (and restarts the simulation if it was running).
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const serve = process.argv.includes('--serve');

/** Files of the MicroPython project: plain files only (no __pycache__ from the Python tests). */
const projectFiles = () =>
  readdirSync('project').filter((name) => !name.startsWith('.') && statSync(`project/${name}`).isFile());

function copyStatic() {
  cpSync('public', 'dist', { recursive: true });
  rmSync('dist/project', { recursive: true, force: true });
  mkdirSync('dist/project', { recursive: true });
  const names = projectFiles();
  for (const name of names) cpSync(`project/${name}`, `dist/project/${name}`);
  writeFileSync('dist/project/files.json', JSON.stringify(names));
  cpSync('node_modules/littlefs/dist/littlefs.wasm', 'dist/littlefs.wasm');
}

// Bumped whenever project/ or public/ change, so the bundle changes and esbuild's
// live-reload event fires even though no TypeScript changed.
let staticVersion = 0;
const staticVersionPlugin = {
  name: 'static-version',
  setup(build) {
    build.onResolve({ filter: /^virtual:static-version$/ }, (args) => ({ path: args.path, namespace: 'static-version' }));
    build.onLoad({ filter: /.*/, namespace: 'static-version' }, () => ({
      contents: `export default ${staticVersion};`,
      loader: 'js',
    }));
  },
};

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
copyStatic();

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
  define: { __DEV__: JSON.stringify(serve) },
  plugins: [staticVersionPlugin],
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  // PORT=8081 npm run dev picks another port.
  const wanted = Number(process.env.PORT) || 8080;
  let port;
  try {
    ({ port } = await ctx.serve({ servedir: 'dist', port: wanted }));
  } catch (e) {
    console.error(`Could not serve on port ${wanted}: ${e.message.split('\n')[0]}`);
    console.error('Close the other server (often an earlier npm run dev), or use another port: PORT=8081 npm run dev');
    await ctx.dispose();
    process.exit(1);
  }

  let timer = null;
  const onStaticChange = (dir) => (_event, file) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        copyStatic();
        staticVersion++;
        await ctx.rebuild();
        console.log(`${dir}/${file ?? ''} changed: copied, page reloading`);
      } catch (e) {
        console.error(`copy after ${dir} change failed:`, e.message);
      }
    }, 120);
  };
  const ignore = (handler) => (event, file) => (String(file ?? '').includes('__pycache__') ? undefined : handler(event, file));
  watch('project', { recursive: true }, ignore(onStaticChange('project')));
  watch('public', { recursive: true }, onStaticChange('public'));

  console.log(`http://localhost:${port}/  (live reload: src/, project/, public/)`);
} else {
  await esbuild.build(options);
  console.log('built dist/');
}
