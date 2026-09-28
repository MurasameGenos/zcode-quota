/**
 * ZCodeQuota — 渲染层 UI（作为模块脚本加入 out/renderer/index.html）
 *
 * 1. 在 GLM 上下文小环（[data-testid="chat-context-usage-trigger"]）旁注入同款小环，
 *    悬停/点击展开面板：Kimi Code 订阅额度（进度条 + 重置时间）+ DeepSeek 余额。
 * 2. 在设置页注入「外部模型额度」区块。
 *
 * 原生观感策略：克隆 GLM 触发器的类名；额度行结构复刻 ChatCodingPlanUsageMeter
 * （label / font-mono 数值 / h-1.5 rounded-full bg-surface-hover 进度条 / 设计令牌颜色）。
 * 数据经 preload 桥（window.zquotaApi）由主进程查询，密钥不进渲染层。
 */
(() => {
  if (window.__ZQUOTA_RENDERER__) return;
  window.__ZQUOTA_RENDERER__ = true;
  try {
    if (window.top !== window.self) return; // 只在顶层窗口生效
  } catch (e) {
    return;
  }

  const TID = "chat-context-usage-trigger";
  const state = { data: null, error: "", fetching: false, lastFetch: 0, kimiBtn: null, dsBtn: null, panel: null, panelScope: "all", hoverTimer: null, settingsCard: null, testidsDumped: false };

  const log = (m) => {
    console.debug("[zquota]", m);
    try {
      window.zquotaApi && window.zquotaApi.log(m);
    } catch (e) { /* 桥不可用时忽略 */ }
  };

  // ---------- 数据 ----------

  async function refresh(force) {
    if (!window.zquotaApi) {
      state.error = "zquotaApi 桥不可用（preload 未加载）";
      log(state.error);
      renderAll();
      return;
    }
    if (state.fetching) return;
    if (!force && Date.now() - state.lastFetch < 60_000 && state.data) return;
    state.fetching = true;
    try {
      const data = await window.zquotaApi.fetchQuota({ intervalMinutes: 5 });
      state.data = data;
      state.error = "";
      state.lastFetch = Date.now();
      renderAll();
    } catch (e) {
      state.error = "查询失败：" + (e && e.message ? e.message : e);
      log(state.error);
      renderAll();
    } finally {
      state.fetching = false;
    }
  }

  // ---------- 工具 ----------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.setAttribute("class", cls);
    if (text != null) n.textContent = text;
    return n;
  }
  const token = (name, fallback) => `var(${name}, ${fallback})`;
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // 剩余语义配色：剩得越少越警示（≤15% 红、≤40% 琥珀）
  function remainColor(remain) {
    if (remain == null) return token("--color-foreground-subtle", "#9aa3b5");
    if (remain <= 0.15) return token("--color-destructive", "#ff7b93");
    if (remain <= 0.4) return token("--color-warning", "#ffb86c");
    return token("--color-usage-chart-1", "#5b8cff");
  }

  // ---------- 小环（Kimi 用量环 + DeepSeek 余额环） ----------

  function ringSvg(ratio, colorOverride) {
    const C = 2 * Math.PI * 10;
    const used = ratio == null ? 0 : Math.max(0, Math.min(1, ratio));
    const off = C * (1 - used);
    // 颜色全部走内联样式 + 显式令牌：GLM 环的"重置机会变绿"等状态样式（祖先类/currentColor 继承）
    // 无法波及本环。Kimi 环颜色由用量分级决定（蓝/琥珀/红）；DeepSeek 环固定品牌色。
    const track = token("--color-foreground-subtle", "#9aa3b5");
    const color = colorOverride || remainColor(ratio);
    return (
      `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style="width:1em;height:1em;display:block">` +
      `<circle cx="12" cy="12" r="10" fill="none" transform="rotate(-90 12 12)" ` +
      `style="stroke:${track};stroke-width:4;opacity:.22"/>` +
      `<circle cx="12" cy="12" r="10" fill="none" transform="rotate(-90 12 12)" stroke-linecap="round" ` +
      `style="stroke:${color};stroke-width:4;stroke-dasharray:${C.toFixed(2)};stroke-dashoffset:${off.toFixed(2)};` +
      `transition:stroke-dashoffset .5s ease,stroke .3s"/></svg>`
    );
  }

  // Kimi 上下双半环：上半 = 5 小时额度剩余，下半 = 月度额度剩余；
  // 各半独立按剩余比例填充与分级配色（半圆弧长 πr）
  function kimiRingSvg(topRemain, bottomRemain) {
    const HALF = Math.PI * 10;
    const track = token("--color-foreground-subtle", "#9aa3b5");
    const clamp01 = (v) => (v == null ? 0 : Math.max(0, Math.min(1, v)));
    const half = (d, remain, extra = "") =>
      `<path d="${d}" fill="none" stroke-linecap="round" style="stroke:${remain == null ? track : remainColor(remain)};stroke-width:4;` +
      `stroke-dasharray:${HALF.toFixed(2)};stroke-dashoffset:${(HALF * (1 - clamp01(remain))).toFixed(2)};` +
      `opacity:${remain == null ? ".22" : "1"};transition:stroke-dashoffset .5s ease,stroke .3s${extra}"/>`;
    return (
      `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style="width:1em;height:1em;display:block">` +
      // 轨道两半
      `<path d="M 2 12 A 10 10 0 0 1 22 12" fill="none" style="stroke:${track};stroke-width:4;opacity:.22"/>` +
      `<path d="M 22 12 A 10 10 0 0 1 2 12" fill="none" style="stroke:${track};stroke-width:4;opacity:.22"/>` +
      // 上半：5 小时；下半：月度
      half("M 2 12 A 10 10 0 0 1 22 12", topRemain) +
      half("M 22 12 A 10 10 0 0 1 2 12", bottomRemain) +
      `</svg>`
    );
  }

  function kimiHalves(data) {
    const rows = data?.kimi?.rows || [];
    const w = rows.find((r) => r.key === "5h");
    const m = rows.find((r) => r.key === "month");
    return { top: w ? w.remain : null, bottom: m ? m.remain : null };
  }

  function kimiRingTitle() {
    const d = state.data;
    if (!d) return "Kimi 额度（加载中…）";
    if (!d.kimi?.ok) return `Kimi：${d.kimi?.error || "不可用"}`;
    const w = d.kimi.rows.find((r) => r.key === "5h");
    const m = d.kimi.rows.find((r) => r.key === "month");
    return `Kimi ${w ? "5h " + w.text : ""}${w && m ? " · " : ""}${m ? "月度 " + m.text : ""}`.trim();
  }

  // DeepSeek 环：以 ¥100 为满
  const DS_FULL = 100;
  function dsRatio(data) {
    const b = data?.deepseek?.rows?.[0];
    if (!b || b.value == null || !Number.isFinite(Number(b.value))) return null;
    return Math.max(0, Math.min(1, Number(b.value) / DS_FULL));
  }
  function dsRingTitle() {
    const d = state.data;
    if (!d) return "DeepSeek 余额（加载中…）";
    if (!d.deepseek?.ok) return `DeepSeek：${d.deepseek?.error || "不可用"}`;
    const b = d.deepseek.rows[0];
    return `DeepSeek 余额 ${b?.text || ""}（满 ¥${DS_FULL}）${d.deepseek.available === false ? " · 余额不足" : ""}`;
  }

  function updateRing() {
    // 不设置 title：原生 tooltip（悬停弹出的系统黑框）不需要，信息由悬停面板承载；
    // aria-label 保留给无障碍读屏
    if (state.kimiBtn?.isConnected) {
      const halves = kimiHalves(state.data);
      state.kimiBtn.innerHTML = kimiRingSvg(halves.top, halves.bottom);
      state.kimiBtn.setAttribute("aria-label", kimiRingTitle());
    }
    if (state.dsBtn?.isConnected) {
      const r = dsRatio(state.data);
      // DeepSeek 品牌主题色；查不到数据时灰、余额不足时琥珀
      const color =
        r == null
          ? token("--color-foreground-subtle", "#9aa3b5")
          : state.data?.deepseek?.available === false
            ? token("--color-warning", "#ffb86c")
            : "#4D6BFE";
      state.dsBtn.innerHTML = ringSvg(r, color);
      state.dsBtn.setAttribute("aria-label", dsRingTitle());
    }
  }

  function buildRingBtn(trig, attrValue, fallbackTitle) {
    const btn = trig.cloneNode(false); // 复用 GLM 触发器的全部类名（原生观感）
    btn.removeAttribute("data-testid");
    btn.removeAttribute("id");
    btn.removeAttribute("title"); // 克隆可能带上原生 tooltip，去掉（黑框小窗）
    btn.setAttribute("data-zquota-ring", attrValue);
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.fontSize = "16px"; // svg 用 1em
    btn.innerHTML = ringSvg(null);
    btn.setAttribute("aria-label", fallbackTitle);
    btn.addEventListener("mouseenter", () => openPanel(btn));
    btn.addEventListener("mouseleave", () => scheduleHidePanel());
    btn.addEventListener("focus", () => openPanel(btn));
    btn.addEventListener("blur", () => scheduleHidePanel());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 再次点击已展开的粘滞面板 → 收起
      if (state.open && state.panel && state.panel.getAttribute("data-sticky") === "true") closePanel();
      else openPanel(btn, true);
    });
    return btn;
  }

  function mountRing() {
    const trig = document.querySelector(`[data-testid="${TID}"]`);
    if (!trig || !trig.parentElement) return false;
    const parent = trig.parentElement;
    if (state.kimiBtn?.isConnected && state.dsBtn?.isConnected) {
      // GLM 触发器重建时把我们的环挪到它旁边
      if (state.kimiBtn.previousElementSibling !== trig) {
        parent.insertBefore(state.kimiBtn, trig.nextSibling);
        parent.insertBefore(state.dsBtn, state.kimiBtn.nextSibling);
      }
      return true;
    }
    try {
      state.kimiBtn = buildRingBtn(trig, "kimi", "Kimi 额度");
      state.dsBtn = buildRingBtn(trig, "ds", "DeepSeek 余额");
      parent.insertBefore(state.kimiBtn, trig.nextSibling);
      parent.insertBefore(state.dsBtn, state.kimiBtn.nextSibling);
      updateRing();
      log("小环已挂载（Kimi + DeepSeek，克隆自 GLM 触发器）");
      return true;
    } catch (e) {
      log("小环挂载失败：" + e.message);
      return false;
    }
  }

  // ---------- 面板（悬停展开，结构复刻 ChatCodingPlanUsageMeter） ----------

  function meterRow(row) {
    const wrap = el("div", "min-w-0 space-y-1.5");
    const head = el("div", "min-w-0 space-y-0.5 text-ui-sm");
    const lab = el("div", "flex min-h-5 min-w-0 items-center gap-1");
    lab.appendChild(el("span", "min-w-0 truncate text-foreground-subtle", row.label));
    head.appendChild(lab);
    const val = el("div", "relative min-w-0 overflow-hidden whitespace-nowrap text-ui-sm tabular-nums");
    val.appendChild(el("span", "font-mono text-foreground", row.text || "—"));
    head.appendChild(val);
    wrap.appendChild(head);
    // 重置说明
    if (row.resetAbs || row.resetRel) {
      wrap.appendChild(el("div", "text-ui-xs text-foreground-subtle", "重置 " + row.resetAbs + (row.resetRel ? "（" + row.resetRel + "）" : "")));
    }
    // 进度条按「剩余」填充：满条 = 额度充裕，越用越空
    const remain = row.remain != null ? row.remain : row.ratio != null ? Math.max(0, Math.min(1, 1 - row.ratio)) : null;
    if (remain != null) {
      const track = el("div", "h-1.5 overflow-hidden rounded-full");
      track.style.backgroundColor = token("--color-surface-hover", "rgba(127,127,127,.18)");
      const fill = el("div", "h-full rounded-full");
      const pct = Math.max(0, Math.min(100, remain * 100));
      fill.style.width = pct.toFixed(1) + "%";
      fill.style.backgroundColor = remainColor(remain);
      fill.style.transition = "width .5s ease";
      if (pct > 0) fill.style.minWidth = "6px";
      track.appendChild(fill);
      wrap.appendChild(track);
    }
    return wrap;
  }

  function sectionTitle(text) {
    const t = el("div", "text-ui-xs font-medium uppercase tracking-wide");
    t.style.color = token("--color-foreground-subtle", "#9aa3b5");
    t.textContent = text;
    return t;
  }

  // scope: "kimi" 只显示 Kimi 区块，"ds" 只显示 DeepSeek 区块，"all" 全部（设置页用）
  const SCOPE_TITLES = { kimi: "Kimi Code 订阅", ds: "DeepSeek 余额", all: "外部模型额度" };

  function panelBody(container, scope = "all") {
    const d = state.data;
    container.textContent = "";
    if (container === state._panelBody && state._panelTitle) state._panelTitle.textContent = SCOPE_TITLES[scope] || SCOPE_TITLES.all;
    if (!d) {
      const line = el("div", "text-ui-sm", state.error || "加载中…");
      if (state.error) line.style.color = token("--color-destructive", "#ff7b93");
      container.appendChild(line);
      return;
    }
    if (state.error) {
      const warn = el("div", "text-ui-xs", "⚠ " + state.error);
      warn.style.color = token("--color-warning", "#ffb86c");
      container.appendChild(warn);
    }
    // Kimi
    if (scope !== "ds") {
      container.appendChild(sectionTitle("Kimi Code 订阅"));
      if (d.kimi?.ok) d.kimi.rows.forEach((r) => container.appendChild(meterRow(r)));
      else container.appendChild(el("div", "text-ui-sm", d.kimi?.error || "查询失败")).style.color = token("--color-destructive", "#ff7b93");
    }
    // DeepSeek
    if (scope !== "kimi") {
      const dsTitle = sectionTitle("DeepSeek 余额");
      if (scope === "ds") dsTitle.style.marginTop = "0";
      else dsTitle.style.marginTop = "12px";
      container.appendChild(dsTitle);
      if (d.deepseek?.ok) {
        d.deepseek.rows.forEach((b) => {
          const row = el("div", "flex min-h-5 min-w-0 items-center justify-between gap-2 text-ui-sm");
          row.appendChild(el("span", "min-w-0 truncate text-foreground-subtle", b.label));
          const right = el("span", "min-w-0 whitespace-nowrap tabular-nums");
          right.appendChild(el("span", "font-mono text-foreground", b.text));
          if (b.sub) right.appendChild(el("span", "text-ui-xs text-foreground-subtle", " · " + b.sub));
          row.appendChild(right);
          container.appendChild(row);
        });
        const st = el("div", "text-ui-xs");
        st.style.color = d.deepseek.available ? "#4D6BFE" : token("--color-warning", "#ffb86c");
        st.textContent = d.deepseek.available ? "✓ 有余额，可正常调用" : "⚠ 余额不足";
        container.appendChild(st);
      } else {
        const err = el("div", "text-ui-sm", d.deepseek?.error || "查询失败");
        err.style.color = token("--color-destructive", "#ff7b93");
        container.appendChild(err);
      }
    }
  }

  function buildPanel() {
    if (state.panel && state.panel.isConnected) return state.panel;
    const p = el("div");
    p.setAttribute("data-zquota-panel", "true");
    p.style.cssText = [
      "position:fixed", "z-index:2147483000", "width:320px",
      "border-radius:12px", "padding:14px 16px", "display:none",
      // 与 ZCode 原生弹层一致：实底（--color-popover）、无 backdrop 模糊
      "box-shadow:0 4px 16px rgba(0,0,0,.28)",
      `border:1px solid ${token("--color-popover-border", token("--color-border", "rgba(127,127,127,.22)"))}`,
      `background:${token("--color-popover", "#2b2b2b")}`,
      `color:${token("--color-popover-foreground", token("--color-foreground", "#e8eaf2"))}`,
      "font-size:13px", "line-height:1.45",
    ].join(";");
    const head = el("div", "flex items-center justify-between gap-2");
    const title = el("span", "font-medium", "外部模型额度");
    head.appendChild(title);
    const btns = el("div", "flex items-center gap-2");
    const rf = el("button", "text-ui-xs", state.fetching ? "刷新中…" : "↻ 刷新");
    rf.style.cssText = `color:${token("--color-foreground-subtle", "#9aa3b5")};background:transparent;border:0;cursor:pointer;padding:2px 6px;border-radius:6px`;
    rf.addEventListener("mouseenter", () => (rf.style.color = token("--color-foreground", "#fff")));
    rf.addEventListener("mouseleave", () => (rf.style.color = token("--color-foreground-subtle", "#9aa3b5")));
    rf.addEventListener("click", async () => {
      rf.textContent = "刷新中…";
      await refresh(true);
      panelBody(body, state.panelScope || "all");
      rf.textContent = "↻ 刷新";
    });
    btns.appendChild(rf);
    head.appendChild(btns);
    p.appendChild(head);
    const body = el("div");
    body.style.marginTop = "10px";
    p.appendChild(body);
    // 面板自身的悬停语义：移入取消待隐藏，移出安排隐藏
    p.addEventListener("mouseenter", () => clearTimeout(state.hoverTimer));
    p.addEventListener("mouseleave", () => scheduleHidePanel());
    document.body.appendChild(p);
    state.panel = p;
    state._panelBody = body;
    state._panelTitle = title;
    return p;
  }

  function closePanel() {
    clearTimeout(state.hoverTimer);
    if (state.panel) {
      state.panel.style.display = "none";
      state.panel.setAttribute("data-sticky", "false");
    }
    state.open = false;
  }

  function openPanel(anchor, sticky) {
    const p = buildPanel();
    // 关键：取消任何待执行的隐藏定时器，否则"环间移动"时旧 leave 的 250ms 隐藏
    // 会把刚重新打开的面板关掉（表现为面板闪现后消失）
    clearTimeout(state.hoverTimer);
    // 环的归属决定面板内容域：Kimi 环只显示 Kimi，DS 环只显示 DeepSeek
    const scope = anchor.getAttribute && anchor.getAttribute("data-zquota-ring") === "ds" ? "ds" : anchor.getAttribute && anchor.getAttribute("data-zquota-ring") === "kimi" ? "kimi" : "all";
    state.panelScope = scope;
    panelBody(state._panelBody, scope);
    state.open = true;
    p.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const pw = 320;
    const ph = p.offsetHeight || 260;
    let left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2));
    let top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;
    p.style.left = left + "px";
    p.style.top = top + "px";
    p.setAttribute("data-sticky", sticky ? "true" : "false");
    refresh(); // 打开时若数据过期则刷新
  }
  function scheduleHidePanel() {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => {
      const p = state.panel;
      if (p && p.getAttribute("data-sticky") !== "true" && !p.matches(":hover")) p.style.display = "none";
    }, 250);
  }

  // ---------- 设置页区块 ----------

  function buildSettingsCard() {
    const card = el("section");
    card.setAttribute("data-zquota-settings", "true");
    card.style.cssText = [
      "border-radius:12px", "padding:16px", "margin-top:16px",
      `border:1px solid ${token("--color-border", "rgba(127,127,127,.2)")}`,
      `background:${token("--color-card", "#2b2b2b")}`,
    ].join(";");
    const h = el("h3", "text-ui-md font-medium");
    h.style.margin = "0 0 4px";
    h.textContent = "外部模型额度";
    card.appendChild(h);
    const body = el("div");
    body.style.marginTop = "12px";
    card.appendChild(body);
    state._settingsBody = body;
    return card;
  }

  function mountSettings() {
    if (state.settingsCard && state.settingsCard.isConnected) {
      renderSettingsBody();
      return true;
    }
    // 锚点策略：设置页内的滚动容器（任一包含 settings 类 testid 的子树的最近滚动祖先）
    const tidEl = document.querySelector('[data-testid^="settings"], [class*="SettingsSection"]');
    if (!tidEl) return false;
    let host = tidEl;
    while (host && host.parentElement) {
      const ov = getComputedStyle(host).overflowY;
      if (ov === "auto" || ov === "scroll") break;
      host = host.parentElement;
    }
    if (!host || state.settingsCard?.parentElement === host) return false;
    try {
      const card = state.settingsCard && !state.settingsCard.isConnected ? state.settingsCard : buildSettingsCard();
      host.appendChild(card);
      state.settingsCard = card;
      renderSettingsBody();
      log("设置页区块已挂载");
      dumpTestids();
      return true;
    } catch (e) {
      log("设置页挂载失败：" + e.message);
      return false;
    }
  }

  function renderSettingsBody() {
    if (state._settingsBody) panelBody(state._settingsBody, "all");
  }

  // 把页面上出现过的 data-testid 清单写进诊断日志（仅 id 字符串，无用户数据），便于适配新版本
  function dumpTestids() {
    if (state.testidsDumped) return;
    state.testidsDumped = true;
    try {
      const ids = new Set();
      document.querySelectorAll("[data-testid]").forEach((n) => ids.add(n.getAttribute("data-testid")));
      log("data-testid 清单：" + [...ids].join(","));
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 渲染与挂载循环 ----------

  function renderAll() {
    updateRing();
    if (state.panel && state.panel.style.display !== "none" && state._panelBody) panelBody(state._panelBody, state.panelScope || "all");
    renderSettingsBody();
  }

  function mountAll() {
    try {
      mountRing();
      mountSettings();
    } catch (e) {
      log("mountAll 异常：" + e.message);
    }
  }

  function init() {
    log("渲染层已加载");
    const start = () => {
      mountAll();
      refresh(true);
      const mo = new MutationObserver(() => {
        // 节流：DOM 变更风暴时每 800ms 最多挂载一次
        if (init._t) return;
        init._t = setTimeout(() => {
          init._t = null;
          mountAll();
        }, 800);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      setInterval(() => refresh(), 60_000); // 内部 60s 节流；数据有效期由主进程 5 分钟语义控制
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refresh();
      });
      // 点击面板与小环之外的任意位置 / 按 Esc → 收起面板
      document.addEventListener("pointerdown", (e) => {
        if (!state.open || !state.panel) return;
        const t = e.target;
        if (state.panel.contains(t) || (state.kimiBtn && state.kimiBtn.contains(t)) || (state.dsBtn && state.dsBtn.contains(t))) return;
        closePanel();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closePanel();
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }

  init();
})();
