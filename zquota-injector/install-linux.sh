#!/usr/bin/env bash
# ZCodeQuota 一键安装（Linux）
# 双击运行方式：通过同目录的 .desktop 启动器，或右键本文件→"在终端中运行"。
# 逻辑：优先使用同目录的单文件可执行，其次系统 Node 跑 injector.cjs；需要 root 时由注入器自动弹 pkexec/sudo。
set -u
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

echo "=== ZCodeQuota 一键安装 ==="
echo

if [ -x "$DIR/ZCodeQuotaInjector-linux-x64" ]; then
  "$DIR/ZCodeQuotaInjector-linux-x64" install
  rc=$?
elif command -v node >/dev/null 2>&1; then
  node "$DIR/injector.cjs" install
  rc=$?
else
  echo "✗ 未找到可运行方式：需要同目录的 ZCodeQuotaInjector-linux-x64（可执行），或系统安装 Node.js ≥ 18。"
  echo "  安装 Node：Debian 系 sudo apt install -y nodejs；其他发行版用各自包管理器或 NodeSource。"
  rc=1
fi

echo
if [ $rc -eq 0 ]; then
  echo "完成。启动 ZCode 后：上下文小环旁新增额度环（悬停展开）；设置页新增「外部模型额度」区块。"
else
  echo "安装未完成（退出码 $rc）。常见原因：ZCode 正在运行（请先完全退出）、/opt 无权限且取消了授权。"
fi
[ -t 0 ] && read -rp "按回车键关闭…"
exit $rc
