# ZCodeQuota — ZCode 桌面版常驻额度悬浮窗

在 ZCode 界面里**直接看到** Kimi Code 订阅额度与 DeepSeek API 余额——就像 GLM 订阅额度的展示方式，无需敲命令。

```
┌──────────────────────────────┐
│ K 100/100 · 12.7% ｜ DS ¥13.23 │   ← 常驻胶囊（右下角，可拖动）
└──────────────────────────────┘
        点击展开 ↓
┌──────────────────────────────┐
│ Kimi Code 订阅                │
│  5 小时会话窗口  ▓▓░░ 100/100   │
│  重置 09-27 08:46（2分钟后）    │
│  月度总量  ▓░░░ 12.7%          │
│  代码模型月度  ▓░░░ 11.6%      │
│ DeepSeek 余额                 │
│  人民币余额  ¥13.23            │
│  充值 13.23 · 赠送 0.00        │
│ 更新于 08:44 · ↻ 刷新          │
└──────────────────────────────┘
```

## 快速开始

1. **完全退出**正在运行的 ZCode（托盘里也要退出）。
2. 双击本目录的 **`启动 ZCodeQuota.vbs`**——它会拉起 ZCode（带调试端口）并注入悬浮窗。
3. 右下角出现胶囊即成功；建议右键该 .vbs → 发送到桌面快捷方式，以后从快捷方式启动。

- 排错：双击 `ZCodeQuota-调试.bat`（控制台可见），日志见 `zcode-quota.log`。
- 卸载：直接删除本文件夹即可——ZCode 安装目录从未被修改，从原快捷方式启动就是纯净原版。
- 自检（不碰 ZCode，用无头 Edge 验证注入管线）：`node selftest.mjs`。

## 工作原理

ZCode 桌面版是 Electron 应用，目前**没有**官方 UI 扩展点（插件体系只有 skills/commands/hooks/MCP，订阅额度 UI 硬编码绑定 bigmodel/zai）。本项目沿用社区 [zcode-plus](https://github.com/Llliao1113/zcode-plus) 验证过的 CDP 注入模式，零第三方依赖：

```
启动 ZCodeQuota.vbs（无窗口）
  └→ 控制器 controller.mjs（常驻 Node 进程；无 node 时用 ZCode 自带 Electron 以 Node 模式运行）
       ├─ 检测 ZCode 已在运行则提示退出重开；分配空闲调试端口（9336 起顺延）
       ├─ 以 --remote-debugging-port 拉起 ZCode（不改安装目录、不碰签名、不影响更新）
       ├─ CDP 注入 inject.js（页面刷新/新窗口自动重注入；Shadow DOM 隔离样式）
       ├─ 每 5 分钟查询官方端点并推送数据到悬浮窗
       └─ ZCode 退出 → 控制器自动退出
```

数据端点（均实测可用）：

| 提供方 | 端点 | 说明 |
| --- | --- | --- |
| Kimi Code 订阅 | `GET https://api.kimi.com/coding/v1/usages` | 与开源 kimi-cli 的 `/usage` 同源，需 `sk-kimi-` 订阅密钥 |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | 官方余额接口 |

## 配置（`zcode-quota-config.json`，首次运行自动生成）

```json
{
  "zcodePath": "",          // 留空则自动探测 C:\Program Files\ZCode\ZCode.exe
  "port": 9336,
  "intervalMinutes": 5,
  "kimi": true,
  "deepseek": true
}
```

密钥自动读取 ZCode 的外部模型配置（`~/.zcode/v2/provider_config.json`），也可用环境变量 `KIMI_API_KEY` / `DEEPSEEK_API_KEY` 覆盖。

## 隐私与安全

- API 密钥只在本地控制器进程内存中使用，**不进页面、不落盘、不写日志、不回显**；页面只收到数字。
- 只向上述两家官方域名发起只读 GET 请求，无任何写操作、无遥测。
- 本地调试端口仅监听 127.0.0.1。

## 已知限制

- 必须经「ZCodeQuota」入口启动 ZCode 才有悬浮窗（用原快捷方式启动则是纯净原版——这是特性不是缺陷）。
- ZCode 大版本更新若重构 UI，悬浮窗位置可能需要微调（悬浮窗为 fixed 定位 + Shadow DOM，不依赖内部 DOM 结构，抗更新能力较强）。
- 多窗口（如独立设置窗口）会各自显示一个悬浮窗。

## 致谢

- 注入机制参考 [Llliao1113/zcode-plus](https://github.com/Llliao1113/zcode-plus)（MIT）。
- Kimi 额度端点源自开源 [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)；DeepSeek 为官方文档接口。
