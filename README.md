# ZCodeQuota

**[English](README.en.md)** | 简体中文

让 [ZCode](https://github.com/zai-org/ZCode) 桌面版像显示 GLM 订阅额度一样，直接在界面上看到 **Kimi Code 订阅额度**与 **DeepSeek API 余额**。

![面板效果](zquota-injector/fixture-screenshot.png)

在 ZCode 的**原生位置**展示——上下文小环旁新增一个额度环（悬停展开面板），设置页新增「外部模型额度」区块，与 GLM 额度的呈现方式同形。

## 特性

- 🔵 **小环进度**：环的填充量 = Kimi 5 小时窗口已用比例（蓝 → 琥珀 ≥60% → 红 ≥85%），与 GLM 环同一视觉语言但颜色独立、互不干扰
- 📊 **悬停面板**：Kimi 月度总量 / 代码模型月度 / 5 小时会话窗口（百分比 + 剩余次数 + 重置倒计时），DeepSeek 余额明细与可用状态
- ⚙️ **设置页区块**：同样的数据以原生卡片样式常驻设置页
- 🔄 **自动刷新**：每 5 分钟，面板打开与 ↻ 点击时即时刷新
- 🛡️ **可安装可卸载**：单文件 exe 注入器，卸载即字节级还原原版；ZCode 更新后重跑一次安装即可

## 下载安装

从 [Releases](../../releases) 下载 `ZCodeQuotaInjector.exe`（约 90MB，内嵌 Node 运行时，零依赖）。

1. **完全退出** ZCode（托盘图标也要退出）
2. 双击 exe → 选 **1）安装注入** → UAC 弹窗点"是" → 子窗口完成后按回车
3. 正常启动 ZCode，小环旁即出现额度环

命令行用法：`install` / `uninstall` / `status` / `doctor`（排障第一步，显示渲染层与注入器日志）/ `version`；`uninstall --purge` 连备份与日志一起清理。

## 工作原理

以"外科手术"方式修改 `resources/app.asar`（3 处一行式追加 + 3 个新文件），不解包全档：

- `index.html` 追加 `<script>` 加载渲染层 UI；`preload/index.cjs` 尾部内联桥（沙箱安全，只用 `require('electron')`）；`main/index.js` 尾部动态 import 注册 `ipcMain` 查询处理器
- 原数据区**逐字节原样保留**，修改内容追加在尾部并重定位条目偏移、重算 SHA256 完整性，自检通过后原子替换；首次安装自动留原版备份
- UI 原生观感：小环克隆 GLM 触发器（公开锚点 `data-testid="chat-context-usage-trigger"`），面板行结构复刻开源版 `ChatCodingPlanUsageMeter`，颜色使用 ZCode 主题令牌（跟随明暗主题）
- **不修改 ZCode.exe 本体**（不破坏签名）；已验证 ZCode 的 asar 完整性校验 fuse 为关闭状态

数据链路：渲染层 → preload 桥 → 主进程 → 官方端点（只读 GET）：

| 提供方 | 端点 | 说明 |
| --- | --- | --- |
| Kimi Code 订阅 | `GET https://api.kimi.com/coding/v1/usages` | 与开源 [kimi-cli](https://github.com/MoonshotAI/kimi-cli) `/usage` 同源，需 `sk-kimi-` 订阅密钥 |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | [官方余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance) |

## 安全与隐私

- API 密钥只从本机 ZCode 外部模型配置（`~/.zcode/v2/provider_config.json`）或环境变量 `KIMI_API_KEY` / `DEEPSEEK_API_KEY` 读取，**只在主进程内存中使用**，不进渲染层、不落盘、不写日志
- 除上述两家官方域名的只读查询外无任何网络行为，无遥测
- 本仓库不含任何密钥；密钥形状的字符串扫描纳入发布前检查

## 构建与测试

```bash
cd zquota-injector
node build-exe.mjs        # 重建 exe（Node SEA + postject）
node test-patcher.mjs     # 21 项安全测试（asar 副本：打补丁/官方工具交叉验证/字节级还原）
node fixture-test.mjs     # UI 无头测试（真实 ZCode 样式表 + 模拟 DOM）
```

仓库还包含两个演进阶段的历史方案：`plugins/model-quota/`（官方插件形式的 `/quota` 命令）与 `zcode-quota/`（CDP 悬浮窗方案存档）。

## 已知限制

- ZCode 自动更新会替换 app.asar，补丁随之消失——`status` 会提示版本变化，重跑 `install` 即可
- 多窗口会各自显示一份 UI；杀软启发式扫描极小概率误报（本工具只追加 asar 内容，不改可执行文件）
- 本工具修改 ZCode 安装目录属于终端用户自行决定的行为，与 ZCode 官方无关；出问题可随时 `uninstall` 字节级还原

## 致谢

- [Llliao1113/zcode-plus](https://github.com/Llliao1113/zcode-plus) — CDP 注入先例（历史方案参考）
- [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) — Kimi 额度端点出处
- [zai-org/ZCode](https://github.com/zai-org/ZCode) — 开源版组件结构参照

## 许可

[MIT](LICENSE)
