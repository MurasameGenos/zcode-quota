#!/usr/bin/env node
/**
 * 渲染层 UI 无头测试：真实 ZCode 样式表 + 模拟 DOM（testid 小环 / 设置容器）
 * + zquotaApi 假桥 → 验证小环注入、面板展开、设置区块挂载。不触碰 ZCode。
 * 运行：node fixture-test.mjs
 */
import { spawn, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 9591;
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const edge = EDGE_CANDIDATES.find(existsSync);
if (!edge) throw new Error("未找到 Edge");

const dir = mkdtempSync(join(tmpdir(), "zq-fixture-"));
// 从真实 asar 提取样式表与渲染层脚本
execSync(`npx --yes @electron/asar extract-file "C:\\Program Files\\ZCode\\resources\\app.asar" "out\\renderer\\assets\\styles-C8Nayk5k.css"`, { cwd: dir, shell: true });
copyFileSync(join(ROOT, "payload", "zquota-renderer.js"), join(dir, "zquota-renderer.js"));

const payload = {
  ts: Date.now(),
  intervalMinutes: 5,
  kimi: {
    ok: true,
    rows: [
      { key: "5h", label: "5 小时会话窗口", ratio: 0.12, text: "12.0%", resetAbs: "09-27 13:46", resetRel: "4小时后" },
      { key: "month", label: "月度总量", ratio: 0.127, text: "12.7%", resetAbs: "10-26 08:00", resetRel: "29天后" },
      { key: "code", label: "代码模型月度", ratio: 0.116, text: "11.6%", resetAbs: "10-26 08:00", resetRel: "29天后" },
    ],
  },
  deepseek: {
    ok: true,
    available: true,
    rows: [{ key: "CNY", label: "人民币余额", text: "¥13.23", value: 13.23, sub: "充值 13.23 · 赠送 0.00" }],
  },
};

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./styles-C8Nayk5k.css">
<style>body{background:#1b1d22;color:#e8eaf2;font-family:system-ui;padding:40px;display:flex;flex-direction:column;gap:24px;min-height:100vh;box-sizing:border-box}</style>
</head><body>
<div id="composer" style="display:flex;align-items:center;gap:8px;border:1px solid #333;padding:10px;border-radius:12px;max-width:520px">
  <button data-testid="chat-context-usage-trigger" class="inline-flex items-center justify-center rounded-md p-1.5 text-foreground-subtle hover:bg-surface-hover" aria-label="上下文">
    <svg viewBox="0 0 24 24" fill="none" style="width:16px;height:16px"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" opacity=".25"/><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" stroke-dasharray="62.83" stroke-dashoffset="30" transform="rotate(-90 12 12)"/></svg>
  </button>
  <input style="flex:1;background:#25272e;border:0;border-radius:8px;padding:8px;color:inherit" placeholder="模拟输入框…">
</div>
<div data-testid="settings-general" style="overflow-y:auto;max-height:220px;border:1px solid #333;border-radius:12px;padding:16px">
  <section><h3 class="text-ui-md font-medium">模拟设置区块 A</h3><p class="text-ui-xs text-foreground-subtle">SettingsSection fixture</p></section>
  <section><h3 class="text-ui-md font-medium">模拟设置区块 B</h3><p class="text-ui-xs text-foreground-subtle">另一个 section</p></section>
</div>
<script>
  window.__fixturePayload = ${JSON.stringify(JSON.stringify(payload))};
  window.zquotaApi = {
    fetchQuota: async () => JSON.parse(window.__fixturePayload),
    log: async (l) => { window.__fixtureLogs = (window.__fixtureLogs || []).concat(l); return true; },
  };
</script>
<script src="./zquota-renderer.js"></script>
</body></html>`;
writeFileSync(join(dir, "fixture.html"), html);

const browser = spawn(edge, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(dir, "profile")}`,
  "--no-first-run", "--window-size=760,640", "file:///" + join(dir, "fixture.html").replace(/\\/g, "/"),
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}
async function wait(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { return await getJson(url); } catch { await sleep(400); }
  }
  throw new Error("timeout " + url);
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise((res, rej) => {
    ws.addEventListener("open", () => res({ send }), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws fail")), { once: true });
  });
}

let failed = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? "：" + extra : ""}`); if (!ok) failed++; };

(async () => {
  try {
    await wait(`http://127.0.0.1:${PORT}/json/version`, 20000);
    await sleep(4000);
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === "page" && t.url.includes("fixture"));
    if (!page) throw new Error("找不到 fixture 页面: " + targets.map((t) => t.url).join(","));
    const { send } = await cdp(page.webSocketDebuggerUrl);
    await send("Page.enable");
    const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

    check("渲染脚本已执行", await ev("!!window.__ZQUOTA_RENDERER__"));
    check("Kimi 环注入到 GLM 触发器旁", await ev(`!!document.querySelector('[data-zquota-ring="kimi"]') && document.querySelector('[data-zquota-ring="kimi"]').previousElementSibling?.getAttribute('data-testid') === 'chat-context-usage-trigger'`));
    check("DeepSeek 环紧跟 Kimi 环", await ev(`(()=>{const k=document.querySelector('[data-zquota-ring="kimi"]'),d=document.querySelector('[data-zquota-ring="ds"]');return !!(k&&d&&d.previousElementSibling===k);})()`));
    const ringSvgOk = await ev(`!!document.querySelector('[data-zquota-ring="kimi"] svg circle[style*="stroke-dasharray"]')`);
    check("小环 SVG 就位", ringSvgOk);
    check("环颜色内联固定（不受状态类影响）", await ev(`(()=>{const c=document.querySelector('[data-zquota-ring="kimi"] svg circle[style*="stroke-dasharray"]');return c && c.style.stroke.includes('var(') && !c.getAttribute('stroke');})()`));
    check("Kimi 环 title 含实时数据", await ev(`(document.querySelector('[data-zquota-ring="kimi"]')?.title || '').includes('12.0%')`));
    check("DeepSeek 环以 ¥100 为满显示进度", await ev(`(()=>{const d=document.querySelector('[data-zquota-ring="ds"]');if(!d)return false;const c=d.querySelector('circle[style*="stroke-dasharray"]');if(!c)return false;const off=parseFloat(c.style.strokeDashoffset);const C=2*Math.PI*10;const ratio=1-off/C;return Math.abs(ratio-13.23/100)<0.005 && (d.title||'').includes('¥13.23');})()`));

    // 悬停展开面板
    await ev(`document.querySelector('[data-zquota-ring="kimi"]').dispatchEvent(new MouseEvent('mouseenter', {bubbles:false}))`);
    await sleep(400);
    check("悬停后面板显示", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'block'`));
    check("面板无毛玻璃（实底+无模糊）", await ev(`(()=>{const p=document.querySelector('[data-zquota-panel]');const s=getComputedStyle(p);const opaque=s.backgroundColor;return s.backdropFilter==='none'&&s.webkitBackdropFilter!=='blur(8px)'&&!!opaque;})()`));
    const panelText = await ev(`document.querySelector('[data-zquota-panel]')?.innerText || ''`);
    check("面板含 Kimi 区块（无 剩 xx/xx 副文本）", panelText.includes("月度总量") && panelText.includes("12.0%") && !panelText.includes("剩 88/100"), panelText.split("\n").slice(0, 3).join(" / "));
    check("面板含 DeepSeek 余额", panelText.includes("¥13.23") && panelText.includes("可正常调用"));
    check("面板含重置时间", panelText.includes("29天后"));
    check("面板无底部说明行", !panelText.includes("更新于") && !panelText.includes("ZCodeQuota"));

    // 面板关闭：粘滞打开 → 点击面板外 → 收起；Esc 同理
    await ev(`document.querySelector('[data-zquota-ring="kimi"]').click()`);
    await sleep(200);
    check("点击小环粘滞展开", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'block' && document.querySelector('[data-zquota-panel]').getAttribute('data-sticky') === 'true'`));
    await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))`);
    await sleep(200);
    check("点击外部收起面板", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'none'`));
    await ev(`document.querySelector('[data-zquota-ring="ds"]').dispatchEvent(new MouseEvent('mouseenter', {bubbles:false}))`);
    await sleep(200);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await sleep(150);
    check("Esc 收起面板", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'none'`));

    // 设置页区块
    check("设置区块已挂载", await ev(`!!document.querySelector('[data-zquota-settings]')`));
    const settingsText = (await ev(`document.querySelector('[data-zquota-settings]')?.innerText || ''`)).toLowerCase();
    check("设置区块含两家数据（标题被 CSS 大写，忽略大小写匹配）", settingsText.includes("kimi") && settingsText.includes("deepseek"));

    // 刷新按钮可用（点击后面板仍在且无异常）
    await ev(`[...document.querySelectorAll('[data-zquota-panel] button')].find(b => b.textContent.includes('刷新'))?.click()`);
    await sleep(300);
    check("刷新按钮工作正常", await ev(`!!window.__fixtureLogs && window.__fixtureLogs.some(l => l.includes('渲染层已加载'))`));

    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(ROOT, "fixture-screenshot.png"), Buffer.from(shot.data, "base64"));
    console.log("✓ 截图：", join(ROOT, "fixture-screenshot.png"));
    console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error("fixture 测试失败：", e.message);
    process.exitCode = 1;
  } finally {
    browser.kill();
    try { execSync(`taskkill /PID ${browser.pid} /T /F`, { stdio: "ignore" }); } catch {}
    setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 500);
  }
})();
