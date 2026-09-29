#!/usr/bin/env bash
# ZCodeQuota 注入器启动器（Linux）
# 依赖系统 Node.js ≥ 18（Debian 系：sudo apt install -y nodejs；其他发行版用各自包管理器或 NodeSource）
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
