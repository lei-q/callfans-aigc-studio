@echo off
rem AIGC 创作台 · 无界面 Web 服务：aigc-studio-web.cmd [--port 5780] [--lan]
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\AIGC Studio.exe" "%~dp0..\server\server.cjs" %*
