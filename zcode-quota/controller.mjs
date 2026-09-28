#!/usr/bin/env node
/**
 * ZCodeQuota 控制器（零依赖，Node ≥ 18）
 *
 * 职责：
 *   1. 以 --remote-debugging-port 拉起 ZCode 桌面版（不改安装目录、不影响原版快捷方式）
 *   2. 通过 CDP 向每个页面注入 inject.js（页面刷新/新窗口自动重注入）
 *   3. 定时从官方端点查询 Kimi Code 订阅额度与 DeepSeek 余额（密钥仅存本进程内存），
 *      经 Runtime.evaluate 推送给页面悬浮窗
 *
 * 用法：
 *   node controller.mjs                     正常启动（拉起 ZCode）
 *   node controller.mjs --attach=127.0.0.1:9555   附加到已开调试端口的浏览器（测试用）
 *   可选：--interval=5（分钟）、--port=9336、--no-kimi、--no-deepseek
 *
 * 机制参考社区项目 zcode-plus（CDP 注入先例），原理见 README.md。
 */
import { spawn, execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQuota, resolveProviders } from "./quota-lib.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(ROOT, "zcode-quota-config.json");
const LOG_PATH = join(ROOT, "zcode-quota.log");
const INJECT_SRC = readFileSync(join(ROOT, "inject.js"), "utf8");

// 若本进程本身是被 ELECTRON_RUN_AS_NODE 方式运行的（如经 ZCode.exe 充当 Node），
// 必须清掉该变量，否则拉起的 ZCode 子进程也会变成 Node 模式。
delete process.env.ELECTRON_RUN_AS_NODE;

const DEFAULTS = { zcodePath: "", port: 9336, intervalMinutes: 5, kimi: true, deepseek: true };
let cfg = { ...DEFAULTS };
try {
  if (existsSync(CONFIG_PATH)) cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  else writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n");
} catch {
  /* 配置损坏则用默认值 */
}

const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const attach = argOf("attach");
if (argOf("interval")) cfg.intervalMinutes = Math.max(1, Number(argOf("interval")) || 5);
if (argv.includes("--no-kimi")) cfg.kimi = false;
if (argv.includes("--no-deepseek")) cfg.deepseek = false;

function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* 日志写失败不影响运行 */
  }
}

function popup(msg) {
  if (process.platform !== "win32") return log(msg);
  try {
    spawn("powershell", [
      "-NoProfile", "-STA", "-Command",
      `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${msg.replace(/'/g, "''")}','ZCodeQuota') | Out-Null`,
    ], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* 弹窗失败则只写日志 */
  }
  log(msg);
}

function zcodeRunning() {
  try {
    if (process.platform === "win32") {
      return execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /FO CSV', { encoding: "utf8" }).includes("ZCode.exe");
    }
    return execSync("pgrep -x zcode || pgrep -x ZCode", { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

async function findFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    const ok = await new Promise((res) => {
      const srv = createServer();
      srv.once("error", () => res(false));
      srv.once("listening", () => srv.close(() => res(true)));
      srv.listen(p, "127.0.0.1");
    });
    if (ok) return p;
  }
  throw new Error(`端口 ${start}-${start + 19} 均被占用`);
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function waitBrowserEndpoint(httpBase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`${httpBase}/json/version`, 2000);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`浏览器调试端口未就绪：${lastErr?.message || "超时"}`);
}

// ---------- CDP 客户端（原生 WebSocket，零依赖） ----------

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.sessions = new Set();
    this.onEvent = () => {};
    this.ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(`${m.error.message} (${m.method || m.id})`)) : res(m.result);
      } else if (m.method) {
        try {
          this.onEvent(m);
        } catch (e) {
          log(`事件处理异常：${e.message}`);
        }
      }
    });
  }

  get ready() {
    return new Promise((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.addEventListener("open", () => res(), { once: true });
      this.ws.addEventListener("error", () => rej(new Error("CDP WebSocket 连接失败")), { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时：${method}`));
        }
      }, 12000);
    });
  }
}

// ---------- 主流程 ----------

let latest = null;
let pollNow = null;

function pushTo(cdp, sessionId) {
  if (!latest) return;
  const expr = `window.__ZCODE_QUOTA_UPDATE__ && window.__ZCODE_QUOTA_UPDATE__(${JSON.stringify(JSON.stringify(latest))})`;
  cdp.send("Runtime.evaluate", { expression: expr }, sessionId).catch(() => {
    /* 目标可能已关闭 */
  });
}

async function attachTarget(cdp, sessionId, url) {
  if (/^devtools:/i.test(url || "")) return;
  cdp.sessions.add(sessionId);
  // 新文档自动注入（覆盖页面刷新/新窗口）+ 对已加载页面立即注入
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT_SRC }, sessionId).catch(() => {});
  await cdp.send("Runtime.addBinding", { name: "__zcodeQuotaCommand" }, sessionId).catch(() => {});
  await cdp.send("Runtime.evaluate", { expression: INJECT_SRC }, sessionId).catch(() => {});
  pushTo(cdp, sessionId);
  log(`已注入悬浮窗（target: ${(url || "about:blank").slice(0, 60)}）`);
}

async function poll(cdp, providers) {
  latest = await fetchQuota(providers, cfg.intervalMinutes);
  for (const s of cdp.sessions) pushTo(cdp, s);
  const k = latest.kimi.ok ? `${latest.kimi.rows.length} 项` : latest.kimi.error;
  const d = latest.deepseek.ok ? latest.deepseek.rows.map((r) => r.text).join(" ") : latest.deepseek.error;
  log(`额度已推送 → Kimi[${k}] DeepSeek[${d}]`);
}

async function main() {
  let wsUrl;
  if (attach) {
    const httpBase = `http://${attach}`;
    wsUrl = (await waitBrowserEndpoint(httpBase, 15000)).webSocketDebuggerUrl;
    log(`附加模式：${httpBase}`);
  } else {
    const zcodePath =
      cfg.zcodePath && existsSync(cfg.zcodePath) ? cfg.zcodePath : "C:\\Program Files\\ZCode\\ZCode.exe";
    if (!existsSync(zcodePath)) {
      popup(`未找到 ZCode：${zcodePath}\n请在 zcode-quota-config.json 中填写 zcodePath`);
      process.exit(1);
    }
    if (zcodeRunning()) {
      popup("检测到 ZCode 正在运行（无调试端口）。\n请先完全退出 ZCode，再从「启动 ZCodeQuota」重新打开。");
      process.exit(1);
    }
    const port = await findFreePort(Number(argOf("port")) || cfg.port);
    const child = spawn(zcodePath, [`--remote-debugging-port=${port}`], { stdio: "ignore" });
    child.on("exit", () => {
      log("ZCode 已退出，控制器结束");
      process.exit(0);
    });
    child.on("error", (e) => {
      popup(`启动 ZCode 失败：${e.message}`);
      process.exit(1);
    });
    log(`已拉起 ZCode（pid ${child.pid}，调试端口 ${port}）`);
    wsUrl = (await waitBrowserEndpoint(`http://127.0.0.1:${port}`, 20000)).webSocketDebuggerUrl;
  }

  const cdp = new Cdp(wsUrl);
  await cdp.ready;
  log("CDP 已连接");

  cdp.onEvent = (m) => {
    if (m.method === "Target.attachedToTarget" && m.params?.targetInfo?.type === "page") {
      attachTarget(cdp, m.params.sessionId, m.params.targetInfo.url).catch((e) => log(`注入失败：${e.message}`));
    } else if (m.method === "Runtime.bindingCalled" && m.params?.name === "__zcodeQuotaCommand") {
      if (m.params.payload === "refresh" && pollNow) pollNow(true);
    }
  };
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const providers = resolveProviders();
  if (!cfg.kimi) providers.kimi.key = "";
  if (!cfg.deepseek) providers.deepseek.key = "";
  log(
    `密钥来源 → Kimi: ${providers.kimi.key ? providers.kimi.source || "已配置" : "未配置"}；` +
      `DeepSeek: ${providers.deepseek.key ? providers.deepseek.source || "已配置" : "未配置"}`
  );

  let polling = false;
  pollNow = async (manual) => {
    if (polling) return;
    polling = true;
    try {
      await poll(cdp, providers);
    } catch (e) {
      log(`查询异常：${e.message}`);
    } finally {
      polling = false;
      if (manual) log("收到页面手动刷新请求");
    }
  };

  await pollNow();
  setInterval(() => pollNow(), cfg.intervalMinutes * 60_000);

  process.on("SIGINT", () => {
    log("控制器退出");
    process.exit(0);
  });
  wsKeepAlive(cdp);
}

function wsKeepAlive(cdp) {
  // 防止空闲连接被断开
  setInterval(() => {
    if (cdp.ws.readyState === WebSocket.OPEN) cdp.send("Target.getTargets").catch(() => {});
  }, 30_000);
  cdp.ws.addEventListener("close", () => {
    log("CDP 连接断开，控制器退出（ZCode 可继续使用）");
    process.exit(0);
  });
}

main().catch((e) => {
  popup(`ZCodeQuota 运行失败：${e.message}`);
  process.exit(1);
});
