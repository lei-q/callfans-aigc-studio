/* electron-builder afterPack：
   没有配置签名证书时，给 macOS 应用做一次 ad-hoc 签名。
   Apple Silicon 上签名无效的程序会直接被系统拒绝运行；ad-hoc 签名后用户右键「打开」即可。 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  /* 自带的 ffmpeg 是独立的 Mach-O，先单独签：Apple Silicon 上未签名的可执行文件会被直接杀掉 */
  const ffmpeg = path.join(app, 'Contents', 'Resources', 'bin', 'ffmpeg');
  if (fs.existsSync(ffmpeg)) execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', ffmpeg], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
};
