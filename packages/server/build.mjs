import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, '../../package.json'), 'utf8'));
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/cli.ts')],
  outfile: path.join(out, 'server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  minify: false,
  legalComments: 'none',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
  logOverride: { 'require-resolve-not-external': 'silent' },
});

fs.copyFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'), path.join(out, 'sql-wasm.wasm'));
console.log('server bundle →', out);
