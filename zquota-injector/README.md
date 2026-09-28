# ZCodeQuotaInjector — ZCode 原生位置额度显示注入器

把 **Kimi Code 订阅额度** 和 **DeepSeek API 余额** 注入到 ZCode 桌面版的**原生 UI 位置**——与 GLM 订阅额度同形：

1. **上下文小环旁**新增一个同款额度小环（悬停/点击展开面板：月度总量、代码模型月度、5 小时会话窗口进度条 + 重置倒计时；DeepSeek 余额与可用状态）
2. **设置页**底部新增「外部模型额度」区块

单文件 `ZCodeQuotaInjector.exe`（约 90MB，内嵌 Node 运行时与全部载荷，零外部依赖），支持**安装 / 卸载 / 版本管理**。

## 使用

```text
ZCodeQuotaInjector.exe install      安装（需先完全退出 ZCode；Program Files 下自动弹 UAC 提权）
ZCodeQuotaInjector.exe status       查看状态（ZCode 版本 / 补丁版本 / 备份位置）
ZCodeQuotaInjector.exe doctor       排障：状态 + 渲染层诊断日志
ZCodeQuotaInjector.exe uninstall    卸载（字节级还原原版；--purge 连备份和日志一起删）
```

- 装好后正常从原快捷方式启动 ZCode 即可（不需要特殊启动器）。
- ZCode 自动更新会替换 app.asar，补丁随之消失：`status` 会提示版本变化，重新 `install` 即可（会自动刷新备份）。
- 排障第一步永远是 `doctor`——渲染层每个关键步骤（挂载/数据/异常）都会写入 `%LOCALAPPDATA%\ZCodeQuota\renderer.log`。

## 工作原理（外科手术式改包）

修改 `resources/app.asar`，共 3 处追加 + 3 个新文件：

| 位置 | 改动 | 作用 |
| --- | --- | --- |
| `out/renderer/index.html` | `</head>` 前加一行 `<script>` | 加载渲染层 UI |
| `out/preload/index.cjs` | 尾部追加 `require(...)` | 暴露 `window.zquotaApi` 桥 |
| `out/main/index.js` | 尾部追加动态 `import(...)` | 注册 `ipcMain` 额度查询处理器 |
| `out/zquota/zquota-main.js` 等 3 个新文件 | 新增 | 载荷本体 |

asar 读写为**自研零依赖实现**：原数据区逐字节原样保留，仅追加修改内容、重定位条目 offset、重算 SHA256 完整性哈希。每条改动都先打在内存里、自检通过后才原子替换；首次安装自动留原版备份，卸载即字节级还原。ZCode 的 asar 完整性校验 fuse 已确认是关闭状态（`EnableEmbeddedAsarIntegrityValidation: Disabled`），此路可行。

### 原生观感如何达成

- 小环按钮**克隆 GLM 触发器**（`[data-testid="chat-context-usage-trigger"]`，公开稳定锚点）的全部类名，SVG 环几何同源（kimi-cli 同款 24 视窗 r10 环）。
- 面板与设置区块的行结构复刻自开源仓库 `ChatCodingPlanUsageMeter` 组件（`text-foreground-subtle` / `font-mono` / `h-1.5 rounded-full bg-surface-hover` 等设计令牌），颜色取自 `--color-usage-chart-1` 等主题变量，自动跟随明暗主题。
- 数据链路：渲染层 → preload 桥 → 主进程 `ipcMain` → 官方端点（`GET api.kimi.com/coding/v1/usages`、`GET api.deepseek.com/user/balance`）。**密钥只在主进程内存中**，从 ZCode 的 provider 配置读取，支持 `KIMI_API_KEY` / `DEEPSEEK_API_KEY` 环境变量覆盖。每 5 分钟自动刷新，面板打开与点击 ↻ 时即时刷新。

## 已验证 / 待验证

已验证（本机，均通过）：

- `test-patcher.mjs` 21 项：零改动重建=逐字节一致；打补丁后官方 `@electron/asar` 交叉验证（列表 + 提取 + package.json 完好）；重复安装被拦截；卸载后与原版逐字节一致
- `fixture-test.mjs` 12 项：真实 ZCode 样式表 + 模拟 DOM 上，小环注入位置/悬停面板/设置区块/刷新全通过（截图 `fixture-screenshot.png`）
- **exe 本体**在 asar 副本上完整 install → status → 官方工具读补丁 → uninstall → 字节级还原

待验证（需要你操作，当前 ZCode 正在运行所以我没有动真实安装目录）：

1. 退出 ZCode → 运行 `ZCodeQuotaInjector.exe install` → 启动 ZCode
2. 确认小环与设置区块（若未出现，运行 `doctor` 把日志发我即可迭代）

## 构建（开发者）

```bash
node build-exe.mjs     # Node SEA + postject → ZCodeQuotaInjector.exe
```

源码：`injector.cjs`（CLI+asar patcher）/ `payload/zquota-main.js` / `payload/zquota-preload.cjs` / `payload/zquota-renderer.js`。

## 已知限制

- ZCode 大版本更新后需重跑 `install`（`status` 会提示）。
- 设置区块的挂载锚点依赖设置页 DOM 结构，版本大改时可能挂不上（小环不受影响）；`doctor` 日志含页面 `data-testid` 清单，便于适配。
- 多窗口（如独立设置的窗口）各自会注入一份 UI。
- 与任何 asar 改包方案一样：极小概率触发 SmartScreen/杀软启发式扫描（本工具只追加内容、不改可执行文件）。
