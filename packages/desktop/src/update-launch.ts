/* ============================================================================
   自动更新：下载完成后怎么启动安装程序。
   Windows 必须直接执行安装器，不能经过 cmd.exe 拼一段带引号的命令：
   Node 会给整段命令加一层引号，cmd /c 去掉首尾引号后命令开头变成 \"，
   于是它去找一个叫 '\' 的文件，用户只看到「Windows 找不到 '\'」，
   安装器根本不会启动（0.4.20 及以前就是这样）。
   ========================================================================== */

export interface LaunchCommand {
  cmd: string;
  args: string[];
}

/**
 * @param platform 系统：win32 / darwin / linux
 * @param file 下载好的安装包路径
 * @param appImage Linux AppImage 安装包自身路径（可选）
 */
export function installerLaunch(platform: NodeJS.Platform, file: string, appImage?: string): LaunchCommand {
  if (platform === 'darwin') {
    /* .pkg 交给系统安装器；装完（安装器关闭）后重新打开应用 */
    return { cmd: 'sh', args: ['-c', 'sleep 1; open -W "$1"; open "/Applications/AIGC Studio.app"', 'sh', file] };
  }
  if (platform === 'win32') {
    /* /S 静默安装；--force-run 让安装器装完后自己拉起新版本，
       本进程在这之前已经退出，避免文件被占用。 */
    return { cmd: file, args: ['/S', '--force-run'] };
  }
  if (appImage) {
    /* 退出后用新 AppImage 覆盖旧文件并启动 */
    return { cmd: 'sh', args: ['-c', 'sleep 1; mv "$1" "$2"; chmod +x "$2"; "$2" >/dev/null 2>&1 &', 'sh', file, appImage] };
  }
  return { cmd: 'xdg-open', args: [file] };
}
