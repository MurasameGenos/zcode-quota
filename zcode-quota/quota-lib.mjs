/**
 * ZCodeQuota 共享额度库：配置发现 + 端点查询 + 归一化
 *
 * 密钥来源（优先级从高到低）：
 *   1. 环境变量 KIMI_API_KEY / MOONSHOT_API_KEY、DEEPSEEK_API_KEY
 *   2. ZCode 外部模型配置 ~/.zcode/v2/provider_config.json
 *
 * 仅向各厂商官方域名发起只读 GET 请求（Kimi /coding/v1/usages、DeepSeek /user/balance）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadProviderRules() {
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
      /* 文件不存在或损坏则尝试下一个 */
    }
  }
  return [];
}

export function resolveProviders(rules = loadProviderRules()) {
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
      source: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY ? "环境变量" : kimiRule ? "ZCode 配置" : "",
    },
    deepseek: {
      key: process.env.DEEPSEEK_API_KEY || dsRule?.config?.access?.apiKey || "",
      baseUrl: dsRule?.config?.api?.baseUrl || "https://api.deepseek.com",
      source: process.env.DEEPSEEK_API_KEY ? "环境变量" : dsRule ? "ZCode 配置" : "",
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
    /* 非 JSON 响应按错误处理 */
  }
  return { status: res.status, ok: res.ok, data };
}

function kimiUsageUrl(base) {
  let b = String(base || "https://api.kimi.com/coding").replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(b)) b += "/v1";
  return `${b}/usages`;
}

function httpHint(status, provider) {
  if (status === 401) return "密钥无效或已过期";
  if (status === 404)
    return provider === "kimi" ? "该 Key 不是 Kimi Code 订阅密钥（sk-kimi-）" : "余额接口不可用（检查 baseUrl）";
  if (status === 429) return "请求过于频繁，稍后再试";
  return `HTTP ${status}`;
}

function splitReset(iso) {
  if (!iso) return { abs: "", rel: "" };
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return { abs: String(iso), rel: "" };
  const abs = `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${String(
    t.getHours()
  ).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const ms = t.getTime() - Date.now();
  if (ms <= 0) return { abs, rel: "已重置" };
  const h = ms / 3_600_000;
  const rel = h < 48 ? (h < 1 ? `${Math.ceil(h * 60)}分钟后` : `${Math.round(h)}小时后`) : `${Math.round(h / 24)}天后`;
  return { abs, rel };
}

/**
 * 查询并归一化。永不抛异常；每个 provider 独立容错。
 * 返回：
 * {
 *   ts, intervalMinutes,
 *   kimi: { ok, error?, rows: [{key,label,ratio,text,resetAbs,resetRel}] },
 *   deepseek: { ok, error?, available?, rows: [{key,label,text,sub}] }
 * }
 */
export async function fetchQuota(providers, intervalMinutes = 5) {
  const payload = { ts: Date.now(), intervalMinutes, kimi: { ok: false, rows: [] }, deepseek: { ok: false, rows: [] } };

  // ---- Kimi ----
  if (providers.kimi.key) {
    try {
      const { status, ok, data } = await getJSON(kimiUsageUrl(providers.kimi.baseUrl), providers.kimi.key);
      if (!ok) payload.kimi.error = httpHint(status, "kimi");
      else {
        const rows = [];
        const usages = data?.usages && typeof data.usages === "object" ? data.usages : {};
        const put = (key, label, ratio, text, iso) => {
          const { abs, rel } = splitReset(iso);
          rows.push({ key, label, ratio, text, resetAbs: abs, resetRel: rel });
        };
        const monthTotal = usages.limit_month_total;
        if (monthTotal && Number.isFinite(Number(monthTotal.used_ratio)))
          put("month", "月度总量", Number(monthTotal.used_ratio), (Number(monthTotal.used_ratio) * 100).toFixed(1) + "%", monthTotal.reset_time);
        const monthCode = usages.limit_month_code;
        if (monthCode && Number.isFinite(Number(monthCode.used_ratio)))
          put("code", "代码模型月度", Number(monthCode.used_ratio), (Number(monthCode.used_ratio) * 100).toFixed(1) + "%", monthCode.reset_time);

        // limits[] 提供 5 小时会话窗口的精确 remaining/limit
        let windowRow = null;
        const limits = Array.isArray(data?.limits) ? data.limits : [];
        for (const item of limits) {
          const d = item?.detail && typeof item.detail === "object" ? item.detail : item;
          const limit = Number(d?.limit);
          const remaining = Number(d?.remaining);
          if (!Number.isFinite(limit)) continue;
          const ratio = Number.isFinite(remaining) ? (limit - remaining) / limit : null;
          const win = item?.window || {};
          const mins = /MINUTE/i.test(win.timeUnit || "")
            ? Number(win.duration)
            : /HOUR/i.test(win.timeUnit || "")
              ? Number(win.duration) * 60
              : null;
          const { abs, rel } = splitReset(d?.resetTime || d?.reset_at);
          windowRow = {
            key: "5h",
            label: mins ? `${mins >= 60 ? mins / 60 + " 小时" : mins + " 分钟"}会话窗口` : "会话窗口",
            ratio,
            text: Number.isFinite(remaining) ? `${remaining}/${limit}` : "",
            resetAbs: abs,
            resetRel: rel,
          };
          break; // 只取第一个窗口（当前生效窗口）
        }
        if (windowRow) rows.unshift(windowRow);
        else if (usages.limit_5h && Number.isFinite(Number(usages.limit_5h.used_ratio)))
          put("5h", "5 小时滚动窗口", Number(usages.limit_5h.used_ratio), "", usages.limit_5h.reset_time);

        if (rows.length) {
          payload.kimi.ok = true;
          payload.kimi.rows = rows;
        } else payload.kimi.error = "无额度数据返回（可能是非订阅 Key 或接口响应变化）";
      }
    } catch (e) {
      payload.kimi.error = e.name === "TimeoutError" ? "请求超时" : e.message;
    }
  } else payload.kimi.error = "未找到 Kimi 密钥（ZCode 未接入或未设 KIMI_API_KEY）";

  // ---- DeepSeek ----
  if (providers.deepseek.key) {
    try {
      const base = String(providers.deepseek.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
      const { status, ok, data } = await getJSON(`${base}/user/balance`, providers.deepseek.key);
      if (!ok) payload.deepseek.error = httpHint(status, "deepseek");
      else {
        const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
        payload.deepseek.rows = infos.map((b) => ({
          key: b.currency,
          label: b.currency === "CNY" ? "人民币余额" : `${b.currency} 余额`,
          text: `¥${b.total_balance}`,
          sub: `充值 ${b.topped_up_balance} · 赠送 ${b.granted_balance}`,
        }));
        payload.deepseek.available = Boolean(data?.is_available);
        if (payload.deepseek.rows.length) payload.deepseek.ok = true;
        else payload.deepseek.error = "无余额数据返回";
      }
    } catch (e) {
      payload.deepseek.error = e.name === "TimeoutError" ? "请求超时" : e.message;
    }
  } else payload.deepseek.error = "未找到 DeepSeek 密钥（ZCode 未接入或未设 DEEPSEEK_API_KEY）";

  return payload;
}
