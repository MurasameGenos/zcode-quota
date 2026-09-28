#!/usr/bin/env node
/**
 * model-quota — 查询 Kimi Code 订阅额度与 DeepSeek API 余额
 *
 * 密钥来源（优先级从高到低）：
 *   1. 环境变量 KIMI_API_KEY / MOONSHOT_API_KEY、DEEPSEEK_API_KEY
 *   2. ZCode 外部模型配置 ~/.zcode/v2/provider_config.json（按 providerId/templateId 匹配）
 *
 * 仅向各厂商官方域名发起只读 GET 请求：
 *   Kimi:     GET {baseUrl}/v1/usages   （默认 https://api.kimi.com/coding/v1/usages，与 kimi-cli /usage 同源）
 *   DeepSeek: GET {baseUrl}/user/balance（默认 https://api.deepseek.com/user/balance）
 *
 * 用法： node quota.mjs [--provider=kimi|deepseek] [--json]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const only = argv.find((a) => a.startsWith("--provider="))?.slice("--provider=".length) || "all";
const wantKimi = only === "all" || only === "kimi";
const wantDeepseek = only === "all" || only === "deepseek";

// ---------- 配置发现 ----------

function readProviderRules() {
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

const rules = readProviderRules();

function ruleFor(ids, keyPrefix) {
  return (
    rules.find(
      (r) =>
        ids.includes(r.providerId) ||
        ids.includes(r.templateId) ||
        ids.includes(String(r.providerName ?? "").toLowerCase())
    ) ||
    (keyPrefix ? rules.find((r) => String(r.config?.access?.apiKey ?? "").startsWith(keyPrefix)) : undefined)
  );
}

const kimiRule = ruleFor(["moonshot-kimi", "kimi", "moonshot"], "sk-kimi-");
const dsRule = ruleFor(["deepseek"]);

const kimi = {
  name: kimiRule?.providerName || "Kimi",
  key: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || kimiRule?.config?.access?.apiKey || "",
  baseUrl: kimiRule?.config?.api?.baseUrl || "https://api.kimi.com/coding",
  source: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY ? "环境变量" : kimiRule ? "ZCode 配置" : "",
};

const deepseek = {
  name: dsRule?.providerName || "DeepSeek",
  key: process.env.DEEPSEEK_API_KEY || dsRule?.config?.access?.apiKey || "",
  baseUrl: dsRule?.config?.api?.baseUrl || "https://api.deepseek.com",
  source: process.env.DEEPSEEK_API_KEY ? "环境变量" : dsRule ? "ZCode 配置" : "",
};

// ---------- HTTP ----------

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
    /* 非 JSON 响应按原文处理 */
  }
  return { status: res.status, ok: res.ok, data };
}

function kimiUsageUrl(base) {
  let b = String(base || "https://api.kimi.com/coding").replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(b)) b += "/v1";
  return `${b}/usages`;
}

// ---------- 展示 ----------

function bar(ratio, width = 10) {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtReset(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso);
  const local = t.toLocaleString("zh-CN", { hour12: false });
  const ms = t.getTime() - Date.now();
  if (ms <= 0) return `${local}（已重置）`;
  const hours = ms / 3_600_000;
  const rel = hours < 48 ? `${hours < 1 ? Math.ceil(hours * 60) + " 分钟" : Math.round(hours) + " 小时"}后` : `${Math.round(hours / 24)} 天后`;
  return `${local}（${rel}）`;
}

const KIMI_ROW_NAMES = {
  limit_month_total: "月度总额度",
  limit_month_code: "代码模型月度额度",
  limit_5h: "5 小时滚动窗口",
};

function kimiReport(data) {
  const lines = [];
  const normalized = { type: "kimi", rows: [] };

  // 新版接口：usages 按额度项给 used_ratio（0~1）
  const usages = data?.usages && typeof data.usages === "object" ? data.usages : {};
  for (const [key, val] of Object.entries(usages)) {
    if (!val || typeof val !== "object") continue;
    const ratio = Number(val.used_ratio ?? val.usedRatio);
    if (!Number.isFinite(ratio)) continue;
    const label = KIMI_ROW_NAMES[key] || key;
    const reset = fmtReset(val.reset_time || val.resetTime);
    lines.push(`  ${label}　${bar(ratio)} ${((ratio * 100).toFixed(1) + "%").padStart(6)} 已用${reset ? `　重置：${reset}` : ""}`);
    normalized.rows.push({ label, used_ratio: ratio, reset_time: val.reset_time || val.resetTime || null });
  }

  // limits：会话窗口的精确 剩余/上限（与 usages.limit_5h 通常为同一窗口，有精确数字时覆盖展示）
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const windowTexts = [];
  for (const item of limits) {
    const d = item?.detail && typeof item.detail === "object" ? item.detail : item;
    const limit = Number(d?.limit);
    const remaining = Number(d?.remaining);
    if (!Number.isFinite(limit)) continue;
    const usedRatio = Number.isFinite(remaining) ? (limit - remaining) / limit : null;
    const win = item?.window || {};
    const mins = /MINUTE/i.test(win.timeUnit || "") ? Number(win.duration) : /HOUR/i.test(win.timeUnit || "") ? Number(win.duration) * 60 : null;
    const label = mins ? `${mins >= 60 ? mins / 60 + " 小时" : mins + " 分钟"}会话窗口` : "会话窗口";
    const reset = fmtReset(d?.resetTime || d?.reset_at);
    if (usedRatio !== null) {
      // 有精确数字时，把 usages.limit_5h 那一行替换为会话窗口明细
      const idx = lines.findIndex((l) => l.includes(KIMI_ROW_NAMES.limit_5h));
      const text = `  ${label}　${bar(usedRatio)} ${((usedRatio * 100).toFixed(1) + "%").padStart(6)} 已用　剩余 ${remaining}/${limit}${reset ? `　重置：${reset}` : ""}`;
      if (idx >= 0) lines[idx] = text;
      else lines.push(text);
      const nRow = normalized.rows.find((r) => r.label === KIMI_ROW_NAMES.limit_5h);
      if (nRow) {
        nRow.label = label;
        nRow.remaining = remaining;
        nRow.limit = limit;
      } else normalized.rows.push({ label, used_ratio: usedRatio, remaining, limit, reset_time: d?.resetTime || null });
    } else {
      windowTexts.push(`  ${label}　剩余 ${remaining}/${limit}${reset ? `　重置：${reset}` : ""}`);
    }
  }
  lines.push(...windowTexts);

  // 兼容 kimi-cli 旧解析形态：顶层 usage {name/title, used|remaining, limit}
  const legacy = data?.usage && typeof data.usage === "object" ? data.usage : null;
  if (legacy && !lines.length) {
    const limit = Number(legacy.limit);
    const used = Number.isFinite(Number(legacy.used))
      ? Number(legacy.used)
      : Number.isFinite(limit) && Number.isFinite(Number(legacy.remaining))
        ? limit - Number(legacy.remaining)
        : null;
    if (used !== null && Number.isFinite(limit) && limit > 0) {
      const ratio = used / limit;
      lines.push(`  ${legacy.name || legacy.title || "额度"}　${bar(ratio)} ${(ratio * 100).toFixed(1)}% 已用　${used}/${limit}　重置：${fmtReset(legacy.reset_at || legacy.resetTime) || "未知"}`);
    }
  }

  return { lines, normalized };
}

function deepseekReport(data) {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const lines = [];
  for (const b of infos) {
    lines.push(
      `  ${b.currency === "CNY" ? "人民币（CNY）" : b.currency}：总余额 ${b.total_balance}　充值 ${b.topped_up_balance}　赠送 ${b.granted_balance}`
    );
  }
  lines.unshift(`  账户状态：${data?.is_available ? "✅ 有余额，可正常调用" : "⛔ 余额不足"}`);
  return {
    lines,
    normalized: { type: "deepseek", is_available: Boolean(data?.is_available), balances: infos },
  };
}

function httpHint(status, provider) {
  if (status === 401) return "密钥无效或已过期，请在 ZCode 中重新配置该模型，或检查环境变量。";
  if (status === 404)
    return provider === "kimi"
      ? "该密钥不是 Kimi Code 订阅密钥（sk-kimi- 开头），而是开放平台按量计费 Key，无订阅额度可查。"
      : "余额接口不可用，请检查 baseUrl 配置。";
  if (status === 429) return "请求过于频繁，请稍后再试。";
  return `HTTP ${status}`;
}

// ---------- 主流程 ----------

const report = { kimi: null, deepseek: null };
const out = [];

async function queryKimi() {
  if (!kimi.key) {
    report.kimi = { error: "未找到 Kimi 密钥：请在 ZCode 中接入 Kimi（moonshot-kimi 提供方），或设置环境变量 KIMI_API_KEY。" };
    return;
  }
  const url = kimiUsageUrl(kimi.baseUrl);
  try {
    const { status, ok, data } = await getJSON(url, kimi.key);
    if (!ok) {
      report.kimi = { error: `查询失败：${httpHint(status, "kimi")}` };
      return;
    }
    const { lines, normalized } = kimiReport(data);
    report.kimi = normalized;
    out.push(`Kimi Code 订阅额度（${kimi.source}，${new URL(url).host}）`);
    out.push(...(lines.length ? lines : ["  无额度数据返回（可能是非订阅 Key 或接口响应变化）。"]));
  } catch (e) {
    report.kimi = { error: `请求异常：${e.name === "TimeoutError" ? "超时（20 秒）" : e.message}` };
  }
}

async function queryDeepseek() {
  if (!deepseek.key) {
    report.deepseek = { error: "未找到 DeepSeek 密钥：请在 ZCode 中接入 DeepSeek，或设置环境变量 DEEPSEEK_API_KEY。" };
    return;
  }
  const url = new URL("/user/balance", String(deepseek.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "") + "/").href;
  try {
    const { status, ok, data } = await getJSON(url, deepseek.key);
    if (!ok) {
      report.deepseek = { error: `查询失败：${httpHint(status, "deepseek")}` };
      return;
    }
    const { lines, normalized } = deepseekReport(data);
    report.deepseek = normalized;
    out.push(`DeepSeek API 余额（${deepseek.source}，${new URL(url).host}）`);
    out.push(...lines);
  } catch (e) {
    report.deepseek = { error: `请求异常：${e.name === "TimeoutError" ? "超时（20 秒）" : e.message}` };
  }
}

const tasks = [];
if (wantKimi) tasks.push(queryKimi());
if (wantDeepseek) tasks.push(queryDeepseek());
await Promise.all(tasks);

const errors = Object.entries(report)
  .filter(([, v]) => v?.error)
  .map(([k, v]) => `${k === "kimi" ? "Kimi" : "DeepSeek"}：${v.error}`);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (out.length) console.log(out.join("\n"));
  for (const e of errors) {
    if (out.length || e !== errors[0]) console.log("");
    console.log(`⚠️  ${e}`);
  }
}

const anySuccess = Object.values(report).some((v) => v && !v.error);
process.exitCode = anySuccess ? 0 : 1;
