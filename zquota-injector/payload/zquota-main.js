/**
 * ZCodeQuota — ZCode 主进程钩子（被追加到 out/main/index.js 的动态 import 加载）
 * 提供 ipcMain 处理器：额度查询（Node 环境，可读 provider 配置）+ 渲染层诊断日志。
 * 密钥只在主进程内存中使用，不进渲染层、不落盘。
 */
import { ipcMain, app } from "electron";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- 额度查询逻辑（与 model-quota 插件同源） ----------

function loadProviderRules() {
  const candidates = [
    join(homedir(), ".zcode", "v2", "provider_config.json"),
    join(homedir(), ".zcode", "provider_config.json"),
  ];
  for (const path of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      const rules = cfg?.config?.providerConfigRules?.providerRules;
      if (Array.isArray(rules)) return rules;
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return [];
}

function resolveProviders(rules) {
  const ruleFor = (ids, keyPrefix) =>
    rules.find(
      (r) =>
        ids.includes(r.providerId) ||
        ids.includes(r.templateId) ||
        ids.includes(String(r.providerName ?? "").toLowerCase())
    ) ||
    (keyPrefix ? rules.find((r) => String(r.config?.access?.apiKey ?? "").startsWith(keyPrefix)) : undefined);
  const kimiRule = ruleFor(["moonshot-kimi", "kimi", "moonshot"], "sk-kimi-");
  const dsRule = ruleFor(["deepseek"]);
  return {
    kimi: {
      key: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || kimiRule?.config?.access?.apiKey || "",
      baseUrl: kimiRule?.config?.api?.baseUrl || "https://api.kimi.com/coding",
    },
    deepseek: {
      key: process.env.DEEPSEEK_API_KEY || dsRule?.config?.access?.apiKey || "",
      baseUrl: dsRule?.config?.api?.baseUrl || "https://api.deepseek.com",
    },
  };
}

async function getJSON(url, key) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 按错误处理 */
  }
  return { status: res.status, ok: res.ok, data };
}

function kimiUsageUrl(base) {
  let b = String(base || "https://api.kimi.com/coding").replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(b)) b += "/v1";
  return `${b}/usages`;
}

function splitReset(iso) {
  if (!iso) return { abs: "", rel: "" };
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return { abs: String(iso), rel: "" };
  const p = (n) => String(n).padStart(2, "0");
  const abs = `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  const ms = t.getTime() - Date.now();
  if (ms <= 0) return { abs, rel: "已重置" };
  const h = ms / 3_600_000;
  const rel = h < 48 ? (h < 1 ? `${Math.ceil(h * 60)}分钟后` : `${Math.round(h)}小时后`) : `${Math.round(h / 24)}天后`;
  return { abs, rel };
}

async function fetchQuotaImpl(intervalMinutes) {
  const providers = resolveProviders(loadProviderRules());
  const payload = { ts: Date.now(), intervalMinutes, kimi: { ok: false, rows: [] }, deepseek: { ok: false, rows: [] } };

  if (providers.kimi.key) {
    try {
      const { status, ok, data } = await getJSON(kimiUsageUrl(providers.kimi.baseUrl), providers.kimi.key);
      if (!ok) payload.kimi.error = status === 401 ? "密钥无效" : status === 404 ? "非 Kimi Code 订阅密钥" : `HTTP ${status}`;
      else {
        const rows = [];
        const usages = data?.usages && typeof data.usages === "object" ? data.usages : {};
        const put = (key, label, ratio, text, iso) => {
          const { abs, rel } = splitReset(iso);
          rows.push({ key, label, ratio, text, resetAbs: abs, resetRel: rel });
        };
        if (Number.isFinite(Number(usages.limit_month_total?.used_ratio)))
          put("month", "月度总量", Number(usages.limit_month_total.used_ratio), (Number(usages.limit_month_total.used_ratio) * 100).toFixed(1) + "%", usages.limit_month_total.reset_time);
        if (Number.isFinite(Number(usages.limit_month_code?.used_ratio)))
          put("code", "代码模型月度", Number(usages.limit_month_code.used_ratio), (Number(usages.limit_month_code.used_ratio) * 100).toFixed(1) + "%", usages.limit_month_code.reset_time);
        let win = null;
        for (const item of Array.isArray(data?.limits) ? data.limits : []) {
          const d = item?.detail && typeof item.detail === "object" ? item.detail : item;
          const limit = Number(d?.limit);
          const remaining = Number(d?.remaining);
          if (!Number.isFinite(limit)) continue;
          const ratio = Number.isFinite(remaining) ? (limit - remaining) / limit : null;
          const w = item?.window || {};
          const mins = /MINUTE/i.test(w.timeUnit || "") ? Number(w.duration) : /HOUR/i.test(w.timeUnit || "") ? Number(w.duration) * 60 : null;
          const { abs, rel } = splitReset(d?.resetTime || d?.reset_at);
          win = {
            key: "5h",
            label: mins ? `${mins >= 60 ? mins / 60 + " 小时" : mins + " 分钟"}会话窗口` : "会话窗口",
            ratio,
            text: ratio != null ? (ratio * 100).toFixed(1) + "%" : "",
            resetAbs: abs,
            resetRel: rel,
          };
          break;
        }
        if (win) rows.unshift(win);
        if (rows.length) {
          payload.kimi.ok = true;
          payload.kimi.rows = rows;
        } else payload.kimi.error = "无额度数据返回";
      }
    } catch (e) {
      payload.kimi.error = e.name === "TimeoutError" ? "请求超时" : e.message;
    }
  } else payload.kimi.error = "未找到 Kimi 密钥";

  if (providers.deepseek.key) {
    try {
      const base = String(providers.deepseek.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
      const { status, ok, data } = await getJSON(`${base}/user/balance`, providers.deepseek.key);
      if (!ok) payload.deepseek.error = status === 401 ? "密钥无效" : `HTTP ${status}`;
      else {
        const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
        payload.deepseek.rows = infos.map((b) => ({
          key: b.currency,
          label: b.currency === "CNY" ? "人民币余额" : `${b.currency} 余额`,
          text: `¥${b.total_balance}`,
          value: Number(b.total_balance),
          sub: `充值 ${b.topped_up_balance} · 赠送 ${b.granted_balance}`,
        }));
        payload.deepseek.available = Boolean(data?.is_available);
        if (payload.deepseek.rows.length) payload.deepseek.ok = true;
        else payload.deepseek.error = "无余额数据返回";
      }
    } catch (e) {
      payload.deepseek.error = e.name === "TimeoutError" ? "请求超时" : e.message;
    }
  } else payload.deepseek.error = "未找到 DeepSeek 密钥";

  return payload;
}

// ---------- 日志 ----------

function logPath() {
  const base =
    process.env.LOCALAPPDATA && process.platform === "win32"
      ? join(process.env.LOCALAPPDATA, "ZCodeQuota")
      : join(homedir(), ".zquota");
  try {
    if (!existsSync(base)) mkdirSync(base, { recursive: true });
  } catch {
    /* 目录不可写则丢弃日志 */
  }
  return join(base, "renderer.log");
}

function log(line) {
  try {
    appendFileSync(logPath(), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 忽略 */
  }
}

// ---------- 注册（幂等） ----------

if (!ipcMain._zquotaRegistered) {
  ipcMain._zquotaRegistered = true;
  ipcMain.handle("zquota:fetchQuota", async (_evt, opts) => {
    try {
      const payload = await fetchQuotaImpl(Number(opts?.intervalMinutes) || 5);
      log(`fetchQuota → kimi:${payload.kimi.ok ? "ok" : payload.kimi.error} deepseek:${payload.deepseek.ok ? "ok" : payload.deepseek.error}`);
      return payload;
    } catch (e) {
      log(`fetchQuota 异常：${e.message}`);
      return { ts: Date.now(), kimi: { ok: false, rows: [], error: e.message }, deepseek: { ok: false, rows: [], error: e.message } };
    }
  });
  ipcMain.handle("zquota:log", (_evt, line) => {
    log(String(line));
    return true;
  });
  log(`zquota-main 已加载（app ${app?.isPackaged ? "packaged" : "dev"}，electron ${process.versions.electron}）`);
}
