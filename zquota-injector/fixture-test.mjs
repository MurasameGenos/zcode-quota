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
  // Windows
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  // Linux 常见浏览器路径
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];
const edge = EDGE_CANDIDATES.find(existsSync);
if (!edge) throw new Error("未找到 Edge");

const dir = mkdtempSync(join(tmpdir(), "zq-fixture-"));
// 从真实 asar 提取样式表与渲染层脚本
// 跨平台定位真实 asar（优先原版备份），并注意样式表文件名可能随版本变化——探测实际文件
const NATIVE_ASAR =
  process.platform === "win32" ? "C:\\Program Files\\ZCode\\resources\\app.asar" : "/opt/ZCode/resources/app.asar";
const ASAR = existsSync(NATIVE_ASAR + ".zquota-backup") ? NATIVE_ASAR + ".zquota-backup" : NATIVE_ASAR;
const listOut = execSync(`npx --yes @electron/asar list "${ASAR}"`, { encoding: "utf8", shell: true, maxBuffer: 128 * 1024 * 1024 });
const cssName = (listOut.match(/out\\renderer\\assets\\styles-[\w-]+\.css/) || [])[0];
if (!cssName) throw new Error("asar 中未找到 styles-*.css");
execSync(`npx --yes @electron/asar extract-file "${ASAR}" "${cssName}"`, { cwd: dir, shell: true });
copyFileSync(join(ROOT, "payload", "zquota-renderer.js"), join(dir, "zquota-renderer.js"));

const payload = {
  ts: Date.now(),
  intervalMinutes: 5,
  kimi: {
    ok: true,
    rows: [
      { key: "5h", label: "5 小时会话窗口", ratio: 0.12, remain: 0.88, text: "剩 88.0%", resetAbs: "09-27 13:46", resetRel: "4小时后" },
      { key: "month", label: "月度总量", ratio: 0.127, remain: 0.873, text: "剩 87.3%", resetAbs: "10-26 08:00", resetRel: "29天后" },
      { key: "code", label: "代码模型月度", ratio: 0.116, remain: 0.884, text: "剩 88.4%", resetAbs: "10-26 08:00", resetRel: "29天后" },
    ],
  },
  deepseek: {
    ok: true,
    available: true,
    rows: [{ key: "CNY", label: "人民币余额", text: "¥13.23", value: 13.23, sub: "充值 13.23 · 赠送 0.00" }],
  },
};

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./${cssName.split("\\").pop()}">
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
    const ringSvgOk = await ev(`!!document.querySelector('[data-zquota-ring="kimi"] path[style*="stroke-dasharray"]')`);
    check("小环 SVG 就位", ringSvgOk);
    check("环颜色内联固定（不受状态类影响）", await ev(`(()=>{const c=document.querySelector('[data-zquota-ring="kimi"] path[style*="stroke-dasharray"]');return c && c.style.stroke.includes('var(') && !c.getAttribute('stroke');})()`));
    check("Kimi 环 aria-label 含剩余数据且无原生 title", await ev(`(()=>{const k=document.querySelector('[data-zquota-ring="kimi"]');return (k.getAttribute('aria-label')||'').includes('剩 88.0%') && !k.hasAttribute('title');})()`));
    check("环尺寸与官方环一致（运行时实测同步）", await ev(`(()=>{const t=document.querySelector('[data-testid="chat-context-usage-trigger"] svg');const k=document.querySelector('[data-zquota-ring="kimi"] svg');const d=document.querySelector('[data-zquota-ring="ds"] svg');if(!t||!k||!d)return false;const tw=t.getBoundingClientRect().width,kw=k.getBoundingClientRect().width,dw=d.getBoundingClientRect().width;return Math.abs(kw-tw)<0.6&&Math.abs(dw-tw)<0.6;})()`));
    check("Kimi 环上下双半环（上半 5h=0.88，下半月度=0.873，含圆头补偿）", await ev(`(()=>{const k=document.querySelector('[data-zquota-ring="kimi"]');if(!k)return false;const ps=[...k.querySelectorAll('path[style*="stroke-dasharray"]')];if(ps.length<2)return false;const U=Math.PI*10-4;const top=1-parseFloat(ps[0].style.strokeDashoffset)/U;const bot=1-parseFloat(ps[1].style.strokeDashoffset)/U;return Math.abs(top-0.88)<0.005&&Math.abs(bot-0.873)<0.005;})()`));
    check("DeepSeek 环以 ¥100 为满显示进度且用主题色 #4D6BFE", await ev(`(()=>{const d=document.querySelector('[data-zquota-ring="ds"]');if(!d)return false;const c=d.querySelector('circle[style*="stroke-dasharray"]');if(!c)return false;const U=2*Math.PI*10-4;const off=parseFloat(c.style.strokeDashoffset);const ratio=1-off/U;const col=getComputedStyle(c).stroke;return Math.abs(ratio-13.23/100)<0.005 && (d.getAttribute('aria-label')||'').includes('¥13.23') && !d.hasAttribute('title') && (col==='rgb(77, 107, 254)'||col==='#4d6bfe');})()`));

    // 环间移动不闪没：Kimi leave → 立即 DS enter → 300ms 后面板仍显示
    await ev(`document.querySelector('[data-zquota-ring="kimi"]').dispatchEvent(new MouseEvent('mouseenter', {bubbles:false}))`);
    await sleep(150);
    await ev(`document.querySelector('[data-zquota-ring="kimi"]').dispatchEvent(new MouseEvent('mouseleave', {bubbles:false}))`);
    await ev(`document.querySelector('[data-zquota-ring="ds"]').dispatchEvent(new MouseEvent('mouseenter', {bubbles:false}))`);
    await sleep(400);
    check("环间移动面板不消失（无闪没）", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'block'`));

    // 移向官方环（relatedTarget=官方触发器）：立即隐藏，不与官方卡片重叠
    await ev(`document.querySelector('[data-zquota-ring="kimi"]').dispatchEvent(new MouseEvent('mouseleave', {bubbles:false, relatedTarget: document.querySelector('[data-testid="chat-context-usage-trigger"]')}))`);
    await sleep(50);
    check("移向官方环立即隐藏（无重叠窗口）", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'none'`));

    // 移向我们自己的面板（relatedTarget=panel）：保留 250ms 回桥缓冲
    await ev(`document.querySelector('[data-zquota-ring="kimi"]').dispatchEvent(new MouseEvent('mouseenter', {bubbles:false}))`);
    await sleep(100);
    await ev(`document.querySelector('[data-zquota-ring="kimi"]').dispatchEvent(new MouseEvent('mouseleave', {bubbles:false, relatedTarget: document.querySelector('[data-zquota-panel]')}))`);
    await sleep(100);
    check("移向面板保留回桥缓冲（250ms 内仍显示）", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'block'`));
    await sleep(500);
    check("缓冲期后自然隐藏", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'none'`));

    // 悬停 Kimi 环 → 面板只含 Kimi 区块
    await ev(`document.querySelector('[data-zquota-ring="kimi"]').dispatchEvent(new MouseEvent('mouseenter', {bubbles:false}))`);
    await sleep(400);
    check("悬停 Kimi 环后面板显示", await ev(`document.querySelector('[data-zquota-panel]')?.style.display === 'block'`));
    check("面板带进场动画（zqIn）", await ev(`(()=>{const p=document.querySelector('[data-zquota-panel]');return p && (p.style.animation||'').includes('zqIn') && !!document.getElementById('zquota-panel-style');})()`));
    const kimiPanelText = await ev(`document.querySelector('[data-zquota-panel]')?.innerText || ''`);
    check("Kimi 环面板只显示 Kimi 区块且为剩余语义", kimiPanelText.toLowerCase().includes("kimi") && kimiPanelText.includes("剩 87.3%") && !kimiPanelText.toLowerCase().includes("deepseek"), kimiPanelText.split("\n").slice(0, 2).join(" / "));
    check("Kimi 面板无 剩 xx/xx 副文本", !kimiPanelText.includes("剩 88/100"));
    check("Kimi 面板含重置时间", kimiPanelText.includes("29天后"));
    check("面板无底部说明行", !kimiPanelText.includes("更新于") && !kimiPanelText.includes("ZCodeQuota"));
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await sleep(200);

    // 悬停 DS 环 → 面板只含 DeepSeek 区块
    await ev(`document.querySelector('[data-zquota-ring="ds"]').dispatchEvent(new MouseEvent('mouseenter', {bubbles:false}))`);
    await sleep(400);
    const dsPanelText = await ev(`document.querySelector('[data-zquota-panel]')?.innerText || ''`);
    check("DS 环面板只显示 DeepSeek 区块", dsPanelText.toLowerCase().includes("deepseek") && dsPanelText.includes("¥13.23") && !dsPanelText.toLowerCase().includes("kimi"), dsPanelText.split("\n").slice(0, 2).join(" / "));
    check("面板无毛玻璃（实底+无模糊）", await ev(`(()=>{const p=document.querySelector('[data-zquota-panel]');const s=getComputedStyle(p);const opaque=s.backgroundColor;return s.backdropFilter==='none'&&s.webkitBackdropFilter!=='blur(8px)'&&!!opaque;})()`));

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
