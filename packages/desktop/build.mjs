import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, '../../package.json'), 'utf8'));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'info', legalComments: 'none' };
await build({ ...common, entryPoints: [path.join(root, 'src/main.ts')], outfile: path.join(out, 'main.cjs') });
await build({ ...common, entryPoints: [path.join(root, 'src/preload.ts')], outfile: path.join(out, 'preload.cjs') });
fs.copyFileSync(path.join(root, 'src/chooser.html'), path.join(out, 'chooser.html'));
fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(out, 'icon.png'));

/* 版本号统一跟根 package.json 走 */
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== rootPkg.version) {
  pkg.version = rootPkg.version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

for (const need of ['../server/dist/server.cjs', '../web/dist/index.html']) {
  if (!fs.existsSync(path.join(root, need))) console.warn(`⚠ 缺少 ${need}：先运行 pnpm build`);
}
console.log('desktop bundle →', out);
