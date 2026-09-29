#!/usr/bin/env bash
# ZCodeQuota 一键卸载（Linux）：还原原版 app.asar（字节级），并清理状态文件。
set -u
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

echo "=== ZCodeQuota 一键卸载 ==="
echo

if [ -x "$DIR/ZCodeQuotaInjector-linux-x64" ]; then
  "$DIR/ZCodeQuotaInjector-linux-x64" uninstall
  rc=$?
elif command -v node >/dev/null 2>&1; then
  node "$DIR/injector.cjs" uninstall
  rc=$?
else
  echo "✗ 未找到可运行方式：需要同目录的 ZCodeQuotaInjector-linux-x64（可执行），或系统安装 Node.js ≥ 18。"
  rc=1
fi

echo
[ $rc -eq 0 ] && echo "已还原原版 ZCode。" || echo "卸载未完成（退出码 $rc）。若 ZCode 正在运行，请先完全退出后重试。"
[ -t 0 ] && read -rp "按回车键关闭…"
exit $rc
