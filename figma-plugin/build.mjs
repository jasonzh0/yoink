import { rm, cp, mkdir, watch as fsWatch } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const SRC = resolve(root, 'src');
const BUILD = resolve(root, 'build');

const dev = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: { code: resolve(SRC, 'code.ts') },
  outdir: BUILD,
  entryNames: '[name]',
  bundle: true,
  format: 'iife',
  target: 'es2017', // Figma's plugin runtime
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
};

async function copyStatic() {
  // manifest.json stays at the plugin root (it points into build/); import that one.
  await cp(resolve(SRC, 'ui.html'), resolve(BUILD, 'ui.html'));
}

await rm(BUILD, { recursive: true, force: true });
await mkdir(BUILD, { recursive: true });

if (dev) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await copyStatic();
  console.log('watching… (rebuilds code + re-copies manifest/ui on change)');
  (async () => {
    for await (const _event of fsWatch(SRC, { recursive: true })) {
      await copyStatic().catch((e) => console.error('copy failed:', e));
    }
  })();
} else {
  await esbuild.build(options);
  await copyStatic();
  console.log('build complete -> build/');
}
