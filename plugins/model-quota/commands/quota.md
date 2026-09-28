---
description: 查询 Kimi Code 订阅额度与 DeepSeek API 余额
---

# 查询模型额度 /quota

运行以下命令（零依赖 Node 脚本，密钥自动从本机 ZCode 模型配置读取，也可用环境变量 `KIMI_API_KEY` / `DEEPSEEK_API_KEY` 覆盖）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/quota.mjs" $ARGUMENTS
```

用户附加参数（无参数时查询全部）：

- `--provider=kimi` 或 `--provider=deepseek`：只查一家
- `--json`：输出结构化 JSON

## 要求

1. 将脚本输出原样呈现给用户，它已经是格式化的中文报告（含进度条、已用比例、重置时间、余额明细）。
2. 密钥属于敏感信息：不得回显密钥内容，不得将其发送到上述查询端点以外的任何地方。
3. 这是一次只读查询，不要执行任何写入类或其他的网络请求。
4. 若报告提示"未找到密钥"，指导用户在 ZCode 中接入对应模型，或设置环境变量后重试；若提示 404（Kimi），说明该 Key 是开放平台按量 Key 而非 Kimi Code 订阅 Key。
