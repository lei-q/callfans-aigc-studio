; ============================================================================
; AIGC 创作台 · NSIS 安装器定制
; 在「选择安装目录」之后加一页：让用户选择以「桌面应用」还是「Web 服务」方式运行。
; 选择写进 %APPDATA%\AIGC Studio\pending-mode.json，程序首次启动时读取并合并。
;
; 注意：这个文件在 MUI2 之前被引入，所以页面函数放在 customPageAfterChangeDir 宏里定义
; （宏在页面区展开，那时 MUI2 已经可用）；electron-builder 以 -WX 编译，变量只在安装器里声明。
; ============================================================================

!ifndef BUILD_UNINSTALLER
  Var LaunchMode
!endif

!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var ModeDialog
  Var ModeRadioDesktop
  Var ModeRadioWeb

  Function ModePageCreate
    ${If} $LaunchMode == ""
      StrCpy $LaunchMode "desktop"
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "选择运行方式" "AIGC 创作台可以作为桌面应用使用，也可以作为 Web 服务在浏览器里使用。"
    nsDialogs::Create 1018
    Pop $ModeDialog
    ${If} $ModeDialog == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "两种方式共用同一份数据，之后可以随时在应用「设置 · 运行模式」里切换。"
    Pop $0

    ${NSD_CreateRadioButton} 0 30u 100% 12u "桌面应用（推荐）：独立窗口，只在本机访问"
    Pop $ModeRadioDesktop
    ${NSD_CreateLabel} 14u 43u 92% 18u "像普通软件一样打开和关闭，适合自己一个人用。"
    Pop $0

    ${NSD_CreateRadioButton} 0 66u 100% 12u "Web 服务：后台运行，用浏览器访问"
    Pop $ModeRadioWeb
    ${NSD_CreateLabel} 14u 79u 92% 26u "启动后在系统托盘常驻，默认地址 http://127.0.0.1:5780 ；可在设置里开放给局域网里的其他设备。"
    Pop $0

    ${If} $LaunchMode == "web"
      ${NSD_Check} $ModeRadioWeb
    ${Else}
      ${NSD_Check} $ModeRadioDesktop
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function ModePageLeave
    ${NSD_GetState} $ModeRadioWeb $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $LaunchMode "web"
    ${Else}
      StrCpy $LaunchMode "desktop"
    ${EndIf}
  FunctionEnd

  Page custom ModePageCreate ModePageLeave
!macroend

!macro customInstall
  ; 静默安装（/S、自动更新）时没有经过选择页，保留用户原来的设置
  StrCmp $LaunchMode "" +5 0
    CreateDirectory "$APPDATA\AIGC Studio"
    FileOpen $0 "$APPDATA\AIGC Studio\pending-mode.json" w
    FileWrite $0 '{"mode":"$LaunchMode"}'
    FileClose $0
!macroend
