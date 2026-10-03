import { context } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const output = '.local/editor-test';
await mkdir(output, { recursive: true });
await writeFile(
  `${output}/index.html`,
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
);
const build = await context({
  entryPoints: ['apps/mobile/test/EditorHarness.tsx'],
  bundle: true,
  outfile: `${output}/app.js`,
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' },
});
await build.rebuild();
await build.serve({ servedir: output, host: '127.0.0.1', port: 5179 });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void build.dispose().finally(() => process.exit(0));
  });
