#!/usr/bin/env bash
# ZCodeQuota 注入器启动器（Linux / Ubuntu）
# 依赖系统 Node.js ≥ 18（Ubuntu：sudo apt install -y nodejs，或使用 NodeSource 新版）
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node。安装方式："
  echo "    sudo apt install -y nodejs        # 发行版自带版本"
  echo "    # 或 NodeSource（推荐，版本更新）："
  echo "    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>=18?0:1)' || {
  echo "✗ Node 版本过低（$(node -v)，需要 ≥ 18）。"
  exit 1
}

exec node injector.cjs "$@"
