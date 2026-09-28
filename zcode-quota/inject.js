/**
 * ZCodeQuota 页面注入脚本（经 CDP addScriptToEvaluateOnNewDocument 注入，无需依赖）
 * 在 ZCode 窗口右下角渲染常驻额度悬浮窗：
 *   - 收起态胶囊：Kimi 5h 剩余/月度% ｜ DeepSeek 余额
 *   - 展开面板：进度条 + 重置时间 + 手动刷新
 * 数据由本地控制器通过 window.__ZCODE_QUOTA_UPDATE__(payload) 推送；密钥不进页面。
 */
(function () {
  if (window.__ZCODE_QUOTA_BOOTED__) return;
  window.__ZCODE_QUOTA_BOOTED__ = true;
  // 跳过嵌套 iframe/webview（只在顶层窗口显示，避免 webview 内重复出现）
  try {
    if (window.top !== window.self) return;
  } catch (e) {
    /* 跨域访问 window.top 抛错说明在 iframe 里，直接返回 */
    return;
  }

  var LS_POS = "zcodeQuotaPos";
  var state = { data: null, open: false, drag: null };

  var host = document.createElement("div");
  host.id = "__zcode_quota_host__";
  host.style.cssText = "all:initial;position:static;width:0;height:0;";
  var shadow = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  style.textContent = [
    ".zq-pill{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;",
    "background:rgba(22,24,32,.88);color:#e8eaf2;font-size:11.5px;line-height:1;user-select:none;",
    "box-shadow:0 2px 10px rgba(0,0,0,.35);backdrop-filter:blur(6px);cursor:default;",
    "font-family:'Segoe UI',system-ui,-apple-system,'Microsoft YaHei',sans-serif;white-space:nowrap;}",
    ".zq-pill b{color:#8ab4ff;font-weight:600;margin-right:3px;}",
    ".zq-num{font-variant-numeric:tabular-nums;}",
    ".zq-ok{color:#7ee2a8}.zq-warn{color:#ffb86c}.zq-bad{color:#ff7b93}",
    ".zq-dim{color:#9aa3b5}",
    ".zq-btn{cursor:pointer;border:none;background:transparent;color:#9aa3b5;padding:0 1px;font-size:11px;line-height:1;}",
    ".zq-btn:hover{color:#fff}",
    ".zq-panel{position:fixed;z-index:2147483001;width:308px;background:rgba(24,26,34,.97);color:#e8eaf2;",
    "border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);",
    "padding:11px 13px;font-size:12px;font-family:'Segoe UI',system-ui,'Microsoft YaHei',sans-serif;user-select:none;}",
    ".zq-h{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#9aa3b5;margin-bottom:8px;}",
    ".zq-sec{font-size:11.5px;color:#c6cddd;margin:6px 0 2px;font-weight:600;}",
    ".zq-row{display:grid;grid-template-columns:84px 1fr auto;gap:8px;align-items:center;margin:7px 0;}",
    ".zq-lab{color:#aab4c6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".zq-barwrap{display:flex;align-items:center;gap:8px;}",
    ".zq-bar{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;min-width:60px;}",
    ".zq-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#5b8cff,#8ab4ff);transition:width .4s;}",
    ".zq-fill.warn{background:#ffb86c}.zq-fill.bad{background:#ff7b93}",
    ".zq-txt{color:#eef1f7;font-variant-numeric:tabular-nums;white-space:nowrap;}",
    ".zq-sub{grid-column:1/4;color:#8b93a7;font-size:10.5px;margin-top:-3px;}",
    ".zq-err{color:#ff7b93;padding:2px 0;}",
    ".zq-foot{margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;color:#8b93a7;font-size:10.5px;}",
  ].join("");

  var pill = document.createElement("div");
  pill.className = "zq-pill";
  pill.title = "ZCodeQuota 额度悬浮窗（点击展开，可拖动）";

  var panel = document.createElement("div");
  panel.className = "zq-panel";
  panel.style.display = "none";

  shadow.appendChild(style);
  shadow.appendChild(pill);
  shadow.appendChild(panel);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------- 位置 ----------
  function applyPos(x, y) {
    var w = window.innerWidth || 1600;
    var h = window.innerHeight || 900;
    x = Math.max(4, Math.min(w - 80, x));
    y = Math.max(4, Math.min(h - 30, y));
    pill.style.left = x + "px";
    pill.style.top = y + "px";
    pill.style.right = "auto";
    pill.style.bottom = "auto";
  }
  function defaultPos() {
    pill.style.right = "14px";
    pill.style.bottom = "14px";
    pill.style.left = "auto";
    pill.style.top = "auto";
  }
  try {
    var saved = JSON.parse(localStorage.getItem(LS_POS) || "null");
    if (saved && saved.x != null) applyPos(saved.x, saved.y);
    else defaultPos();
  } catch (e) {
    defaultPos();
  }

  function placePanel() {
    var r = pill.getBoundingClientRect();
    panel.style.left = Math.max(8, r.right - 308) + "px";
    var top = r.top - panel.offsetHeight - 10;
    panel.style.top = (top < 8 ? r.bottom + 10 : top) + "px";
  }

  // ---------- 拖动 ----------
  pill.addEventListener("pointerdown", function (e) {
    if (e.target.closest && e.target.closest(".zq-btn")) return;
    var r = pill.getBoundingClientRect();
    state.drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, sx: e.clientX, sy: e.clientY };
    pill.setPointerCapture && pill.setPointerCapture(e.pointerId);
  });
  pill.addEventListener("pointermove", function (e) {
    if (!state.drag) return;
    if (!state.drag.moved && Math.abs(e.clientX - state.drag.sx) + Math.abs(e.clientY - state.drag.sy) < 4) return;
    state.drag.moved = true;
    applyPos(e.clientX - state.drag.dx, e.clientY - state.drag.dy);
  });
  pill.addEventListener("pointerup", function (e) {
    if (state.drag && state.drag.moved) {
      var r = pill.getBoundingClientRect();
      try {
        localStorage.setItem(LS_POS, JSON.stringify({ x: r.left, y: r.top }));
      } catch (err) { /* localStorage 不可用时忽略 */ }
      if (state.open) placePanel();
    } else if (state.drag && !state.drag.moved) {
      toggle(); // 单击（无拖动）切换面板
    }
    state.drag = null;
  });

  function toggle() {
    state.open = !state.open;
    panel.style.display = state.open ? "block" : "none";
    if (state.open) {
      render();
      placePanel();
    }
  }

  // ---------- 渲染 ----------
  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, "0"); }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function barCls(ratio) {
    if (ratio == null) return "";
    if (ratio >= 0.85) return " bad";
    if (ratio >= 0.6) return " warn";
    return "";
  }

  function kimiPill(data) {
    if (!data || !data.ok) return { cls: "zq-bad", text: "✕" };
    var w = data.rows.find(function (r) { return r.key === "5h"; });
    var m = data.rows.find(function (r) { return r.key === "month"; });
    var parts = [];
    if (w) {
      var rem = w.text; // "98/100"
      var cls = w.ratio != null && w.ratio >= 0.85 ? "zq-bad" : w.ratio != null && w.ratio >= 0.6 ? "zq-warn" : "zq-ok";
      parts.push({ cls: cls, text: rem || (w.ratio != null ? (w.ratio * 100).toFixed(0) + "%" : "") });
    }
    if (m) parts.push({ cls: m.ratio >= 0.85 ? "zq-bad" : m.ratio >= 0.6 ? "zq-warn" : "", text: m.text });
    return parts;
  }

  function render() {
    var d = state.data;
    // 胶囊
    pill.textContent = "";
    pill.appendChild(el("b", null, "K"));
    var kParts = kimiPill(d && d.kimi);
    if (Array.isArray(kParts)) {
      kParts.forEach(function (p, i) {
        if (i > 0) pill.appendChild(el("span", "zq-dim", "·"));
        pill.appendChild(el("span", p.cls + " zq-num", p.text));
      });
    } else {
      pill.appendChild(el("span", kParts.cls, kParts.text));
      pill.title = (d && d.kimi && d.kimi.error) || "Kimi 查询失败";
    }
    pill.appendChild(el("span", "zq-dim", "｜"));
    pill.appendChild(el("b", null, "DS"));
    var ds = d && d.deepseek;
    if (ds && ds.ok && ds.rows[0]) {
      pill.appendChild(el("span", (ds.available ? "zq-ok" : "zq-bad") + " zq-num", ds.rows[0].text));
    } else {
      pill.appendChild(el("span", "zq-bad", "✕"));
    }
    var tgl = el("button", "zq-btn", state.open ? "▴" : "▾");
    tgl.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
    pill.appendChild(tgl);

    // 面板
    if (!state.open) return;
    panel.textContent = "";
    var head = el("div", "zq-h");
    head.appendChild(el("span", null, "模型额度"));
    var hbtns = el("span");
    var rf = el("button", "zq-btn", "↻ 刷新");
    rf.title = "立即刷新（每 " + ((d && d.intervalMinutes) || 5) + " 分钟自动刷新）";
    rf.addEventListener("click", function () {
      rf.textContent = "…";
      try { __zcodeQuotaCommand("refresh"); } catch (e) { /* 控制器未就绪时静默 */ }
      setTimeout(function () { rf.textContent = "↻ 刷新"; }, 1500);
    });
    var cl = el("button", "zq-btn", "✕");
    cl.addEventListener("click", function () { if (state.open) toggle(); });
    hbtns.appendChild(rf);
    hbtns.appendChild(cl);
    head.appendChild(hbtns);
    panel.appendChild(head);

    if (d && d.kimi) {
      panel.appendChild(el("div", "zq-sec", "Kimi Code 订阅"));
      if (d.kimi.ok) {
        d.kimi.rows.forEach(function (r) {
          var row = el("div", "zq-row");
          row.appendChild(el("div", "zq-lab", r.label));
          var bw = el("div", "zq-barwrap");
          if (r.ratio != null) {
            var bar = el("div", "zq-bar");
            var fill = el("div", "zq-fill" + barCls(r.ratio));
            fill.style.width = Math.min(100, Math.max(0, r.ratio * 100)).toFixed(1) + "%";
            bar.appendChild(fill);
            bw.appendChild(bar);
          }
          if (r.text) bw.appendChild(el("span", "zq-txt", r.text));
          row.appendChild(bw);
          panel.appendChild(row);
          if (r.resetAbs || r.resetRel) {
            var sub = el("div", "zq-sub", "重置 " + r.resetAbs + (r.resetRel ? "（" + r.resetRel + "）" : ""));
            panel.appendChild(sub);
          }
        });
      } else {
        panel.appendChild(el("div", "zq-err", d.kimi.error || "查询失败"));
      }
    }
    if (d && d.deepseek) {
      panel.appendChild(el("div", "zq-sec", "DeepSeek 余额"));
      if (d.deepseek.ok) {
        d.deepseek.rows.forEach(function (r) {
          var row = el("div", "zq-row");
          row.appendChild(el("div", "zq-lab", r.label));
          var bw = el("div", "zq-barwrap");
          bw.appendChild(el("span", "zq-txt", r.text));
          row.appendChild(bw);
          panel.appendChild(row);
          if (r.sub) panel.appendChild(el("div", "zq-sub", r.sub));
        });
        panel.appendChild(el("div", "zq-sub", d.deepseek.available ? "✓ 有余额，可正常调用" : "⚠ 余额不足"));
      } else {
        panel.appendChild(el("div", "zq-err", d.deepseek.error || "查询失败"));
      }
    }
    var foot = el("div", "zq-foot");
    foot.appendChild(el("span", null, "更新于 " + (d ? fmtTime(d.ts) : "--:--")));
    foot.appendChild(el("span", null, "密钥仅存本地控制器"));
    panel.appendChild(foot);
    placePanel();
  }

  // ---------- 数据入口 ----------
  window.__ZCODE_QUOTA_UPDATE__ = function (payload) {
    try {
      state.data = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch (e) {
      return;
    }
    render();
    if (state.open) placePanel();
  };

  // ---------- 挂载与自愈 ----------
  function mount() {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }
  mount();
  setInterval(mount, 1500);
  document.addEventListener("DOMContentLoaded", mount);
  window.addEventListener("load", mount);

  render();
})();
