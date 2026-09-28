---
name: model-quota
description: 查询 Kimi Code 订阅额度（月度总量、代码模型月度、5 小时会话窗口及重置时间）与 DeepSeek API 账户余额（人民币/美元、充值与赠送余额、可用状态）。当用户询问 kimi 额度、kimi 用量、deepseek 余额、deepseek 还剩多少钱、配额 quota、什么时候重置额度等时使用。运行插件内的零依赖 Node 脚本 scripts/quota.mjs，密钥从本机 ZCode provider 配置（~/.zcode/v2/provider_config.json）读取或用环境变量 KIMI_API_KEY / DEEPSEEK_API_KEY 覆盖，仅向 api.kimi.com 与 api.deepseek.com 官方端点发起只读 GET 请求。
---

# 模型额度查询（Kimi Code 订阅 + DeepSeek 余额）

## 用法

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/quota.mjs" [--provider=kimi|deepseek] [--json]
```

环境变量优先于 ZCode 配置：`KIMI_API_KEY`（或 `MOONSHOT_API_KEY`）、`DEEPSEEK_API_KEY`；可用 `KIMI`/`DEEPSEEK` 提供方的 `baseUrl` 覆盖端点域名。

## 背后的接口

| 提供方 | 端点 | 说明 |
| --- | --- | --- |
| Kimi Code 订阅 | `GET https://api.kimi.com/coding/v1/usages` | 与开源 kimi-cli 的 `/usage` 命令同源；返回 `usages.limit_month_total / limit_month_code / limit_5h`（`used_ratio` 为 0~1）与 `limits[]`（会话窗口精确的 `remaining/limit`），需 `sk-kimi-` 开头的订阅密钥 |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | 官方余额接口；返回 `is_available` 与 `balance_infos[]`（`currency / total_balance / granted_balance / topped_up_balance`） |

两者均为官方文档或官方客户端同源的只读接口。

## 安全与边界

- 密钥只从本机读取，只出现在 `Authorization: Bearer` 请求头中，只发往上述官方域名；不落盘、不打印。
- 只做 GET 查询，不产生任何计费请求。
- 脚本零第三方依赖，仅需 Node ≥ 18（内置 fetch）。

## 常见问题

- **401**：密钥无效/过期，重新在 ZCode 中配置该模型。
- **Kimi 404**：当前 Key 是 Kimi 开放平台按量计费 Key，不是 Kimi Code 订阅 Key（`sk-kimi-` 开头），没有订阅额度可查。
- **未找到密钥**：ZCode 尚未接入该模型，或未设置环境变量。
- **非 JSON / 超时**：检查网络与代理，或用环境变量覆盖 baseUrl。
