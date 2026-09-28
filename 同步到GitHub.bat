@echo off
rem 一键同步：提交所有变更并推送到 GitHub（ZCodeQuota 仓库）
cd /d "%~dp0"
git add -A
git diff --cached --quiet >nul 2>&1
if %errorlevel%==1 (
  git commit -m "更新：%date% %time:~0,8%"
  git push
  echo.
  echo 已同步到 https://github.com/MurasameGenos/zcode-quota
) else (
  echo 没有需要同步的变更。
)
pause
