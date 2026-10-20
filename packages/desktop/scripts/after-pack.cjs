/* electron-builder afterPack：
   没有配置签名证书时，给 macOS 应用做一次 ad-hoc 签名。
   Apple Silicon 上签名无效的程序会直接被系统拒绝运行；ad-hoc 签名后用户右键「打开」即可。 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
};
