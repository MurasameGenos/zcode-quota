# ZCodeQuota — ZCode 桌面版 Kimi/DeepSeek 额度显示

让 [ZCode](https://github.com/zai-org/ZCode) 桌面版像显示 GLM 订阅额度一样，直接在界面上看到 **Kimi Code 订阅额度**与 **DeepSeek API 余额**。

本仓库包含一个主交付物与两个历史方案（演进过程存档）：

| 目录 | 形态 | 状态 |
| --- | --- | --- |
| **`zquota-injector/`** | **exe 注入器**：外科手术式修改 `app.asar`，把额度 UI 注入 ZCode 原生位置（上下文小环旁 + 设置页） | ✅ 最终形态，v0.1.6 |
| `plugins/model-quota/` | ZCode 官方插件形式的 `/quota` 命令 | ✅ 可用（命令式查询） |
| `zcode-quota/` | CDP 悬浮窗方案（zcode-plus 模式） | 存档（被注入器方案取代） |

## zquota-injector 快速上手

```text
ZCodeQuotaInjector.exe install      安装（需先完全退出 ZCode；自动请求 UAC）
ZCodeQuotaInjector.exe status       查看状态
ZCodeQuotaInjector.exe doctor       排障（渲染层/注入器日志）
ZCodeQuotaInjector.exe uninstall    卸载（字节级还原原版 asar；--purge 连备份/日志一起删）
```

双击 exe 进入交互菜单。ZCode 自动更新后补丁消失属于预期，重跑 `install` 即可（自动走"更新模式"：还原→重打）。

特性与原理详见 [zquota-injector/README.md](zquota-injector/README.md)：自研零依赖 asar 读写（原数据区逐字节保留、SHA256 完整性重算、原子替换、备份还原）、小环克隆 GLM 触发器（`data-testid="chat-context-usage-trigger"`）、面板行结构复刻开源版 `ChatCodingPlanUsageMeter`、数据链路 渲染层→内联 preload 桥→ipcMain→官方端点。

## 数据端点（只读 GET，密钥不进仓库）

| 提供方 | 端点 | 说明 |
| --- | --- | --- |
| Kimi Code 订阅 | `GET https://api.kimi.com/coding/v1/usages` | 与开源 [kimi-cli](https://github.com/MoonshotAI/kimi-cli) `/usage` 同源，需 `sk-kimi-` 订阅密钥 |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | [官方余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance) |

密钥自动读取 ZCode 的外部模型配置（`~/.zcode/v2/provider_config.json`），可用环境变量 `KIMI_API_KEY` / `DEEPSEEK_API_KEY` 覆盖；只在本地进程内存中使用。

## 构建与测试（开发者）

```bash
cd zquota-injector
node build-exe.mjs        # 重建 ZCodeQuotaInjector.exe（Node SEA + postject）
node test-patcher.mjs     # 21 项安全测试（在 asar 副本上：打补丁/官方工具交叉验证/字节级还原）
node fixture-test.mjs     # UI 无头测试（真实 ZCode 样式表 + 模拟 DOM）
```

## 安全说明

- 仓库不含任何 API 密钥；密钥只从本机 ZCode 配置或环境变量读取。
- 注入器不修改 ZCode.exe 本体（不破坏签名），只追加 app.asar 内容；卸载即恢复备份。
- 每次发布前请自行确认 `git grep -E "sk-[A-Za-z0-9_-]{20,}"` 为空。

## 致谢

- [Llliao1113/zcode-plus](https://github.com/Llliao1113/zcode-plus)（CDP 注入先例）
- [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)（Kimi 额度端点出处）
- [zai-org/ZCode](https://github.com/zai-org/ZCode)（开源版组件结构参照）
