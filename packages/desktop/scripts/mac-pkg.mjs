/* ============================================================================
   macOS .pkg 安装器：在「自定义安装」页给出运行方式的选择
     ☑ AIGC 创作台（必选）
     ☐ 以 Web 服务方式运行（不勾 = 桌面应用）
   electron-builder 自带的 pkg 目标不支持自定义选项，这里用 pkgbuild + productbuild 自己组装。
   用法：node scripts/mac-pkg.mjs   （先跑 electron-builder --mac 生成 release/mac-*（各架构目录）里的 .app）
   ========================================================================== */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const ID = 'com.callfans.aigcstudio';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

const targets = [
  { dir: 'mac-arm64', arch: 'arm64', host: 'arm64' },
  { dir: 'mac', arch: 'x64', host: 'x86_64' },
].filter((t) => fs.existsSync(path.join(release, t.dir, 'AIGC Studio.app')));

if (!targets.length) {
  console.error('没有找到 release/mac 目录下的 AIGC Studio.app，先运行 electron-builder --mac');
  process.exit(1);
}

/** postinstall：把选择写给当前登录用户（应用首次启动时读取），同时留一份系统级默认值 */
const postinstall = (mode) => `#!/bin/bash
MODE="${mode}"
SYS="/Library/Application Support/AIGC Studio"
mkdir -p "$SYS"
printf '{"mode":"%s"}' "$MODE" > "$SYS/launch-mode.json"
chmod 644 "$SYS/launch-mode.json"
CONSOLE_USER=$(stat -f%Su /dev/console 2>/dev/null)
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ]; then
  HOME_DIR=$(dscl . -read /Users/"$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
  if [ -n "$HOME_DIR" ]; then
    DIR="$HOME_DIR/Library/Application Support/AIGC Studio"
    mkdir -p "$DIR"
    printf '{"mode":"%s"}' "$MODE" > "$DIR/pending-mode.json"
    chown -R "$CONSOLE_USER" "$DIR" 2>/dev/null || true
  fi
fi
exit 0
`;

for (const t of targets) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `aigc-pkg-${t.arch}-`));
  const appPath = path.join(release, t.dir, 'AIGC Studio.app');

  /* 1. 应用本体：装到 /Applications，不允许被挪到别处的旧副本「吸走」 */
  const payload = path.join(work, 'payload');
  fs.mkdirSync(payload);
  run('ditto', [appPath, path.join(payload, 'AIGC Studio.app')]);
  const plist = path.join(work, 'components.plist');
  run('pkgbuild', ['--analyze', '--root', payload, plist]);
  run('plutil', ['-replace', '0.BundleIsRelocatable', '-bool', 'NO', plist]);
  const appScripts = path.join(work, 'scripts-app');
  fs.mkdirSync(appScripts);
  fs.writeFileSync(path.join(appScripts, 'postinstall'), postinstall('desktop'), { mode: 0o755 });
  run('pkgbuild', [
    '--root', payload, '--component-plist', plist, '--install-location', '/Applications',
    '--identifier', `${ID}.app`, '--version', version, '--scripts', appScripts, path.join(work, 'app.pkg'),
  ]);

  /* 2. Web 模式选项：没有文件，只有 postinstall，排在应用本体之后执行，覆盖默认的 desktop */
  const webScripts = path.join(work, 'scripts-web');
  fs.mkdirSync(webScripts);
  fs.writeFileSync(path.join(webScripts, 'postinstall'), postinstall('web'), { mode: 0o755 });
  run('pkgbuild', ['--nopayload', '--identifier', `${ID}.webmode`, '--version', version, '--scripts', webScripts, path.join(work, 'webmode.pkg')]);

  /* 3. 分发描述：强制显示自定义页，选项一目了然 */
  const res = path.join(work, 'resources');
  fs.mkdirSync(res);
  fs.writeFileSync(
    path.join(res, 'welcome.html'),
    `<html><body style="font-family:-apple-system,'PingFang SC',sans-serif;font-size:13px;line-height:1.7">
<h3>AIGC 创作台 ${version}</h3>
<p>按次付费、说一句就能出片。接下来的「安装类型」页可以选择运行方式：</p>
<ul><li><b>桌面应用</b>（默认）：独立窗口，只在本机访问。</li>
<li><b>Web 服务</b>：勾选「以 Web 服务方式运行」，启动后在菜单栏常驻，用浏览器访问 http://127.0.0.1:5780 。</li></ul>
<p>两种方式共用同一份数据，之后可以随时在应用「设置 · 运行模式」里切换。</p></body></html>`,
  );
  const dist = path.join(work, 'distribution.xml');
  fs.writeFileSync(
    dist,
    `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>AIGC 创作台</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <options customize="always" require-scripts="false" hostArchitectures="${t.host}" rootVolumeOnly="true"/>
  <domains enable_localSystem="true"/>
  <choices-outline>
    <line choice="app"/>
    <line choice="webmode"/>
  </choices-outline>
  <choice id="app" title="AIGC 创作台" description="应用本体，安装到「应用程序」文件夹。默认以桌面应用方式运行。" enabled="false" selected="true">
    <pkg-ref id="${ID}.app"/>
  </choice>
  <choice id="webmode" title="以 Web 服务方式运行（浏览器访问）" description="勾选后，应用在菜单栏常驻并用系统浏览器打开；可在设置里开放给局域网。不勾选则以桌面应用方式运行。" start_selected="false">
    <pkg-ref id="${ID}.webmode"/>
  </choice>
  <pkg-ref id="${ID}.app" version="${version}" onConclusion="none">app.pkg</pkg-ref>
  <pkg-ref id="${ID}.webmode" version="${version}" onConclusion="none">webmode.pkg</pkg-ref>
</installer-gui-script>
`,
  );
  const out = path.join(release, `AIGC-Studio-${version}-mac-${t.arch}.pkg`);
  const args = ['--distribution', dist, '--package-path', work, '--resources', res];
  if (process.env.APPLE_INSTALLER_IDENTITY) args.push('--sign', process.env.APPLE_INSTALLER_IDENTITY);
  run('productbuild', [...args, out]);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`✓ ${path.relative(root, out)}`);
}
