@echo off
rem 调试模式：控制台可见，便于排错（正式使用请双击「启动 ZCodeQuota.vbs」）
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node controller.mjs
) else (
  set ELECTRON_RUN_AS_NODE=1
  "C:\Program Files\ZCode\ZCode.exe" "%~dp0controller.mjs"
)
pause
