#!/usr/bin/env node
/**
 * ZCodeQuota 自检：用本机 Edge 无头模式端到端验证 CDP 注入管线
 * （不触碰正在运行的 ZCode）：拉起 Edge → 附加 controller → 断言悬浮窗已渲染
 * → 打开面板截图 → 校验文本 → 退出。运行：node selftest.mjs
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirnameOf(import.meta.url));
const PORT = 9577;

function dirnameOf(u) {
  return join(fileURLToPath(u), "..");
}

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const edge = EDGE_CANDIDATES.find(existsSync);
if (!edge) {
  console.error("未找到 Edge/Chrome，无法自检");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "zq-selftest-"));
const browser = spawn(edge, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=900,700",
  "about:blank",
], { stdio: "ignore" });

const controller = spawn(process.execPath, [join(ROOT, "controller.mjs"), `--attach=127.0.0.1:${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
controller.stdout.on("data", (d) => process.stdout.write(`[controller] ${d}`));
controller.stderr.on("data", (d) => process.stderr.write(`[controller!] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function waitEndpoint(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      return await getJson(url, 1500);
    } catch {
      await sleep(400);
    }
  }
  throw new Error(`等待超时：${url}`);
}

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  return new Promise((res, rej) => {
    ws.addEventListener("open", () => res({ ws, send }), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
}

async function evalIn(send, sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`页面执行异常: ${r.exceptionDetails.text}`);
  return r.result.value;
}

async function main() {
  try {
    await waitEndpoint(`http://127.0.0.1:${PORT}/json/version`, 20000);
    console.log("✓ 无头浏览器就绪");
    await sleep(9000); // 等控制器注入 + 拉取真实额度数据并推送

    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page =
      targets.find((t) => t.type === "page" && !/^(edge|chrome):\/\//i.test(t.url)) ||
      targets.find((t) => t.type === "page");
    if (!page) throw new Error("没有 page target");
    const { send } = await cdpConnect(page.webSocketDebuggerUrl);
    await send("Page.enable");
    await send("Runtime.enable");

    const booted = await evalIn(send, undefined, "!!window.__ZCODE_QUOTA_BOOTED__");
    console.log(booted ? "✓ 注入脚本已执行" : "✗ 注入脚本未执行");

    const pillText = await evalIn(
      send,
      undefined,
      "document.getElementById('__zcode_quota_host__')?.shadowRoot.querySelector('.zq-pill')?.textContent || ''"
    );
    console.log(`✓ 胶囊内容：${JSON.stringify(pillText.trim())}`);
    if (!/K/.test(pillText) || !/DS/.test(pillText)) throw new Error("胶囊缺少 K/DS 段");

    // 打开面板（pointerdown+pointerup 触发切换）
    await evalIn(
      send,
      undefined,
      `(() => { const p = document.getElementById('__zcode_quota_host__').shadowRoot.querySelector('.zq-pill');
        p.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
        p.dispatchEvent(new PointerEvent('pointerup', {bubbles:true})); })()`
    );
    await sleep(600);
    const panelText = await evalIn(
      send,
      undefined,
      "document.getElementById('__zcode_quota_host__')?.shadowRoot.querySelector('.zq-panel')?.innerText || ''"
    );
    console.log("✓ 面板内容：\n" + panelText.split("\n").map((l) => "    " + l).join("\n"));
    if (!panelText.includes("Kimi Code")) throw new Error("面板缺少 Kimi 区块");

    // 测试手动刷新 binding
    const refreshed = await evalIn(send, undefined, `(typeof __zcodeQuotaCommand === 'function')`);
    console.log(refreshed ? "✓ 刷新 binding 可用" : "✗ 刷新 binding 缺失");

    const shot = await send("Page.captureScreenshot", { format: "png" });
    const png = join(ROOT, "selftest-screenshot.png");
    writeFileSync(png, Buffer.from(shot.data, "base64"));
    console.log(`✓ 截图已保存：${png}`);

    console.log("\n自检通过");
    process.exitCode = 0;
  } catch (e) {
    console.error("自检失败：", e.message);
    process.exitCode = 1;
  } finally {
    controller.kill();
    browser.kill();
    try {
      execSync(`taskkill /PID ${browser.pid} /T /F`, { stdio: "ignore" });
    } catch {}
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    }, 500);
  }
}

main();
