#!/usr/bin/env node
/**
 * ZCodeQuotaInjector — ZCode 桌面版额度注入器（零依赖，Node ≥ 18 / SEA 单文件 exe）
 *
 * 以"外科手术"方式修改 resources/app.asar：
 *   1. out/renderer/index.html   → 追加 <script> 加载 zquota-renderer.js（小环 + 设置页 UI）
 *   2. out/preload/index.cjs     → 追加 require zquota-preload.cjs（渲染层桥）
 *   3. out/main/index.js         → 追加动态 import zquota-main.js（ipcMain 额度查询）
 *   4. 新增 out/zquota/* 与 out/renderer/assets/zquota-renderer.js
 *
 * 不解包全档：原数据区原样拷贝，修改/新增内容追加在尾部并重定位条目 offset、
 * 重算 SHA256 完整性，最后原子替换。卸载 = 恢复首次安装前的原版备份（字节级还原）。
 *
 * 双击（无参数）进入交互菜单；带参数为 CLI：
 *   install | uninstall | status | doctor | version   （--asar <路径> 指定测试目标）
 */
"use strict";
const { createHash } = require("node:crypto");
const {
  existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync, appendFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { join, dirname, basename } = require("node:path");
const { execSync } = require("node:child_process");
const readline = require("node:readline");

const VERSION = "0.1.7";
const ROOT = __dirname;

// ---------- 载荷加载（SEA 资产或源码目录） ----------

function loadPayload(name) {
  try {
    const { getAsset } = require("node:sea");
    return Buffer.from(getAsset(name));
  } catch (e) {
    const p = join(ROOT, "payload", name);
    if (!existsSync(p)) throw new Error(`载荷缺失：${p}`);
    return readFileSync(p);
  }
}

// ---------- 交互辅助（双击运行时窗口不再一闪而过） ----------

function isInteractive() {
  if (process.env.ZQUOTA_FORCE_TTY) return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function pause(reason) {
  return new Promise((res) => {
    if (!isInteractive()) return res();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(reason || "\n按回车键退出…", () => {
      rl.close();
      res();
    });
    rl.on("close", () => res()); // 流意外关闭（EOF/Ctrl+C）时也不悬挂
  });
}

function injectLog(line) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(join(stateDir(), "injector.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 日志不可写时忽略 */
  }
}

// ---------- asar 解析与重建（零依赖） ----------

const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

function findFirstFile(node) {
  if (node.files) {
    for (const k of Object.keys(node.files)) {
      const r = findFirstFile(node.files[k]);
      if (r) return r;
    }
  } else if (node.offset != null && node.size != null && node.integrity && node.integrity.hash) {
    return { offset: Number(node.offset), size: node.size, hash: node.integrity.hash };
  }
  return null;
}

// asar 头布局：[u32 4][u32 headerBufSize][Pickle: u32 payloadSize][u32 jsonLen][json utf8][padding]
// 数据区从 8 + headerBufSize 开始；条目 offset 相对数据区起点。
function parseAsar(buf) {
  if (buf.readUInt32LE(0) !== 4) throw new Error("非 asar 格式（magic 不符）");
  const headerBufSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  if (16 + jsonLen > buf.length) throw new Error("asar 头长度异常");
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString("utf8"));
  const first = findFirstFile(header);
  if (!first) throw new Error("asar 头中未找到可用文件条目");
  const base = 8 + headerBufSize;
  const candidates = [base, base + ((4 - (base % 4)) % 4)];
  const dataStart = candidates.find((ds) => sha256hex(buf.slice(ds + first.offset, ds + first.offset + first.size)) === first.hash);
  if (dataStart == null) throw new Error("无法校验 asar 数据区起点");
  return { header, headerBufSize, dataStart, dataLen: buf.length - dataStart };
}

function encodeHeader(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), "utf8");
  const payload = Buffer.alloc(4 + jsonBuf.length + ((4 - (jsonBuf.length % 4)) % 4));
  payload.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(payload, 4);
  const pickle = Buffer.alloc(4 + payload.length);
  pickle.writeUInt32LE(payload.length, 0);
  payload.copy(pickle, 4);
  const prefix = Buffer.alloc(8 + pickle.length);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(pickle.length, 4);
  pickle.copy(prefix, 8);
  return { prefix, headerBufSize: pickle.length };
}

function integrityOf(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += 4194304) blocks.push(sha256hex(buf.slice(i, Math.min(buf.length, i + 4194304))));
  if (!blocks.length) blocks.push(sha256hex(buf));
  return { algorithm: "SHA256", hash: sha256hex(buf), blockSize: 4194304, blocks };
}

function navigate(header, parts, create) {
  let node = header;
  for (const part of parts) {
    if (!node.files) node.files = {};
    if (!node.files[part]) {
      if (!create) throw new Error(`asar 条目不存在：${parts.join("\\")}`);
      node.files[part] = { files: {} };
    }
    node = node.files[part];
  }
  return node;
}

function buildPatched(origBuf, parsed, mods, adds) {
  const header = JSON.parse(JSON.stringify(parsed.header));
  const chunks = [];
  let appendLen = 0;
  const appendBuf = (buf) => {
    const off = parsed.dataLen + appendLen;
    chunks.push(buf);
    appendLen += buf.length;
    return off;
  };
  const setEntry = (path, buf, isAdd) => {
    const parts = path.split("\\").filter(Boolean);
    const node = navigate(header, parts, isAdd);
    if (!isAdd && node.files) throw new Error(`目标条目是目录：${path}`);
    delete node.files;
    node.offset = String(appendBuf(buf));
    node.size = buf.length;
    node.integrity = integrityOf(buf);
    delete node.unpacked;
    delete node.external;
  };
  for (const list of [mods, adds]) {
    const isAdd = list === adds;
    for (const [path, buf] of list) {
      const parts = path.split("\\").filter(Boolean);
      parts.pop();
      if (parts.length) navigate(header, parts, true); // 确保父目录存在
      setEntry(path, buf, isAdd);
    }
  }
  // 头部可以增长：所有条目 offset 均相对数据区起点，数据区随新头部整体后移即可
  const { prefix } = encodeHeader(header);
  const out = Buffer.alloc(prefix.length + parsed.dataLen + appendLen);
  prefix.copy(out, 0);
  origBuf.copy(out, prefix.length, parsed.dataStart);
  let pos = prefix.length + parsed.dataLen;
  for (const c of chunks) {
    c.copy(out, pos);
    pos += c.length;
  }
  return out;
}

function readFileFromAsar(buf, parsed, path) {
  const parts = path.split("\\").filter(Boolean);
  let node = parsed.header;
  for (const p of parts) {
    if (!node.files || !node.files[p]) return null;
    node = node.files[p];
  }
  if (node.files || node.offset == null) return null;
  return buf.slice(parsed.dataStart + Number(node.offset), parsed.dataStart + Number(node.offset) + node.size);
}

// ---------- 补丁定义 ----------

const RENDERER_TAG = '<script crossorigin src="./assets/zquota-renderer.js"></script>';
const P_HTML = "out\\renderer\\index.html";
const P_PRELOAD = "out\\preload\\index.cjs";
const P_MAIN = "out\\main\\index.js";
const A_MAIN = "out\\zquota\\zquota-main.js";
const A_RENDERER = "out\\renderer\\assets\\zquota-renderer.js";

// 沙箱化 preload 的 require 仅允许 'electron' 等内置模块、不能加载文件，
// 因此桥必须内联（只用 require('electron')），不能 require 载荷文件。
const PRELOAD_TAIL =
  '\n;/*ZQUOTA*/(function(){try{' +
  'var e=require("electron");' +
  'var api={fetchQuota:function(o){return e.ipcRenderer.invoke("zquota:fetchQuota",o||{})},' +
  'log:function(l){try{return e.ipcRenderer.invoke("zquota:log",String(l))}catch(x){return Promise.resolve(false)}}};' +
  'try{e.contextBridge.exposeInMainWorld("zquotaApi",api)}catch(x){window.zquotaApi=api}' +
  'try{e.ipcRenderer.invoke("zquota:log","[preload] zquotaApi 桥已暴露")}catch(x){}' +
  '}catch(e){console.warn("[zquota] preload bridge failed:",e&&e.message)}})();\n';

function buildPatchContents(origBuf, parsed) {
  const html = readFileFromAsar(origBuf, parsed, P_HTML);
  const preload = readFileFromAsar(origBuf, parsed, P_PRELOAD);
  const main = readFileFromAsar(origBuf, parsed, P_MAIN);
  if (!html || !preload || !main) throw new Error("asar 中缺少 index.html / preload / main 入口");
  if (html.toString("utf8").includes("zquota-renderer.js")) throw new Error("已安装过 ZCodeQuota（如需重装请先 uninstall）");

  const html2 = Buffer.from(html.toString("utf8").replace("</head>", `  ${RENDERER_TAG}\n  </head>`), "utf8");
  const preload2 = Buffer.concat([preload, Buffer.from(PRELOAD_TAIL, "utf8")]);
  const main2 = Buffer.concat([
    main,
    // 注意：相对 out/main/index.js 解析，必须用 ../zquota/ 才指向 out/zquota/
    Buffer.from('\n;/*ZQUOTA*/import("../zquota/zquota-main.js").catch(function(e){console.warn("[zquota]",e&&e.message)});\n', "utf8"),
  ]);
  return {
    mods: [
      [P_HTML, html2],
      [P_PRELOAD, preload2],
      [P_MAIN, main2],
    ],
    adds: [
      [A_MAIN, loadPayload("zquota-main.js")],
      [A_RENDERER, loadPayload("zquota-renderer.js")],
    ],
  };
}

// ---------- 环境与状态 ----------

const DEFAULT_ASAR = "C:\\Program Files\\ZCode\\resources\\app.asar";
const stateDir = () =>
  process.env.ZQUOTA_HOME
    ? process.env.ZQUOTA_HOME
    : process.env.LOCALAPPDATA && process.platform === "win32"
      ? join(process.env.LOCALAPPDATA, "ZCodeQuota")
      : join(homedir(), ".zquota");
const statePath = () => join(stateDir(), "state.json");
const backupPath = (asarPath) => join(dirname(asarPath), basename(asarPath) + ".zquota-backup");

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return null;
  }
}
function saveState(s) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(s, null, 2) + "\n");
}

function zcodeVersion(asarBuf, parsed) {
  const pkg = readFileFromAsar(asarBuf, parsed, "package.json");
  return pkg ? JSON.parse(pkg.toString("utf8")).version || "?" : "?";
}

function zcodeRunning() {
  if (process.env.ZQUOTA_SKIP_RUNNING_CHECK) return false;
  try {
    if (process.platform === "win32")
      return execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /FO CSV', { encoding: "utf8" }).includes("ZCode.exe");
    return execSync("pgrep -x zcode || pgrep -x ZCode", { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

function canWrite(dir) {
  try {
    const probe = join(dir, ".zquota-probe");
    writeFileSync(probe, "1");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// 经 PowerShell 提权重跑自身；-Wait 等待提权窗口执行完毕。
// 用 -EncodedCommand 传脚本（Base64 UTF-16LE），彻底避开 cmd→powershell 的多层引号转义。
// ArgumentList 每项是"内容带双引号"的 PS 单引号字符串：Start-Process 以空格拼接各参数，
// 只有内嵌的双引号能随命令行传给子进程，保证含空格路径不被拆散。
function relaunchElevated(args) {
  console.log("需要管理员权限，正在请求 UAC 授权…");
  console.log("（请在弹出的新窗口中观察进度；完成后回到本窗口）");
  const sq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PS 单引号字符串
  const item = (s) => sq(`"${String(s).replace(/"/g, '\\"')}"`); // 内容 = "arg"
  const script =
    `Start-Process -FilePath ${sq(process.execPath)} ` +
    `-ArgumentList ${args.map(item).join(",")} -Verb RunAs -Wait`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: "inherit" });
    return true;
  } catch (e) {
    console.error("提权失败或被取消：" + (e.message || ""));
    return false;
  }
}

// ---------- 命令（fatal = 打印 + 记日志 + 抛出，由外层决定退出码与是否停留） ----------

function fatal(msg) {
  injectLog("失败：" + msg);
  throw new Error(msg);
}

function install(asarPath) {
  if (zcodeRunning())
    fatal("检测到 ZCode 正在运行，请先完全退出 ZCode（托盘图标也要退出）再安装。");
  if (!existsSync(asarPath)) fatal(`未找到 ${asarPath}（可用 --asar 指定路径）`);

  // 已打过补丁：先从备份还原为原版，再重新注入（一步完成"更新"）
  {
    const probe = parseAsar(readFileSync(asarPath));
    if (readFileFromAsar(readFileSync(asarPath), probe, P_HTML).toString("utf8").includes("zquota-renderer.js")) {
      const bak0 = backupPath(asarPath);
      if (!existsSync(bak0)) fatal("当前 asar 已带补丁但没有原版备份，无法更新。请先卸载失败残留或重装 ZCode。");
      copyFileSync(bak0, asarPath);
      console.log("✓ 检测到已有补丁，已先还原为原版（更新模式）");
    }
  }

  const origBuf = readFileSync(asarPath);
  const parsed = parseAsar(origBuf);
  const zver = zcodeVersion(origBuf, parsed);
  const patchedNow = readFileFromAsar(origBuf, parsed, P_HTML).toString("utf8").includes("zquota-renderer.js");

  // 首次安装前留原版备份（保持纯净：已存在则不覆盖）
  const bak = backupPath(asarPath);
  const origSha = sha256hex(origBuf);
  if (!existsSync(bak)) {
    copyFileSync(asarPath, bak);
    console.log(`✓ 已备份原版 → ${bak}`);
  } else if (sha256hex(readFileSync(bak)) === origSha) {
    console.log("✓ 原版备份已存在（当前 asar 即原版）");
  } else if (patchedNow) {
    console.log("✓ 检测到当前为已打补丁状态，复用既有原版备份");
  } else {
    // 当前是干净原版但与旧备份不同（ZCode 自动更新过）→ 刷新备份为最新原版
    copyFileSync(asarPath, bak);
    console.log(`✓ 检测到 ZCode 已更新，原版备份已刷新 → ${bak}`);
  }

  const { mods, adds } = buildPatchContents(origBuf, parsed);
  const patched = buildPatched(origBuf, parsed, mods, adds);

  // 自检：重新解析打补丁结果
  const reparsed = parseAsar(patched);
  const htmlOut = readFileFromAsar(patched, reparsed, P_HTML);
  if (!htmlOut || !htmlOut.toString("utf8").includes("zquota-renderer.js"))
    fatal("补丁自检失败：index.html 未包含注入标记");
  for (const [p] of adds) {
    const node = navigate(reparsed.header, p.split("\\").filter(Boolean), false);
    if (!node.integrity || sha256hex(readFileFromAsar(patched, reparsed, p)) !== node.integrity.hash)
      fatal(`补丁自检失败：${p} 完整性不符`);
  }
  const pkgOut = readFileFromAsar(patched, reparsed, "package.json");
  if (!pkgOut || !pkgOut.toString("utf8").includes(`"version": "${zver}"`)) fatal("补丁自检失败：package.json 校验不符");

  const tmp = join(dirname(asarPath), `.zquota-tmp-${Date.now()}`);
  writeFileSync(tmp, patched);
  copyFileSync(tmp, asarPath);
  unlinkSync(tmp);

  saveState({
    pluginVersion: VERSION,
    zcodeVersion: zver,
    asarPath,
    backupPath: bak,
    originalSha256: sha256hex(readFileSync(bak)),
    installedAt: new Date().toISOString(),
  });
  injectLog(`install 完成：v${VERSION} → ZCode ${zver}`);
  console.log(`✓ 安装完成：ZCodeQuota v${VERSION} → ZCode ${zver}`);
  console.log("  启动 ZCode 后：上下文小环旁新增额度环（悬停展开）；设置页底部新增「外部模型额度」区块。");
}

function uninstall(asarPath, purge) {
  const st = loadState();
  const target = (st && st.asarPath) || asarPath;
  const bak = backupPath(target);
  if (existsSync(bak)) {
    if (zcodeRunning()) fatal("检测到 ZCode 正在运行，请先完全退出 ZCode 再卸载。");
    copyFileSync(bak, target);
    console.log("✓ 已还原原版 app.asar（字节级还原）");
    if (purge) {
      unlinkSync(bak);
      console.log("✓ 已删除原版备份");
    }
  } else {
    console.log("未找到原版备份；尝试确认当前 asar 是否干净…");
    const buf = readFileSync(target);
    const parsed = parseAsar(buf);
    if (readFileFromAsar(buf, parsed, P_HTML).toString("utf8").includes("zquota-renderer.js"))
      fatal("当前 asar 带有补丁但没有备份，无法安全还原。请重装 ZCode 修复。");
    console.log("✓ 当前 asar 为原版，无需还原。");
  }
  try {
    unlinkSync(statePath());
  } catch {
    /* 状态文件可能不存在 */
  }
  injectLog("uninstall 完成" + (purge ? "（purge）" : ""));
  console.log("✓ 卸载完成。");
  if (purge) {
    try {
      unlinkSync(join(stateDir(), "renderer.log"));
      console.log("✓ 已清理诊断日志。");
    } catch {
      /* 忽略 */
    }
  }
}

function status(asarPath) {
  const st = loadState();
  const target = (st && st.asarPath) || asarPath;
  console.log(`ZCodeQuotaInjector v${VERSION}`);
  if (!existsSync(target)) {
    console.log(`✗ 未找到 ${target}`);
    return;
  }
  const buf = readFileSync(target);
  const parsed = parseAsar(buf);
  const zver = zcodeVersion(buf, parsed);
  const patchedNow = readFileFromAsar(buf, parsed, P_HTML).toString("utf8").includes("zquota-renderer.js");
  console.log(`ZCode 版本        ：${zver}`);
  console.log(`补丁状态          ：${patchedNow ? `已安装（插件 v${(st && st.pluginVersion) || "?"}，${(st && st.installedAt) || "时间未知"}）` : "未安装"}`);
  if (st && st.zcodeVersion !== zver && patchedNow)
    console.log(`⚠ ZCode 可能已更新（安装时 ${st.zcodeVersion}，当前 ${zver}），建议 uninstall 后重新 install。`);
  console.log(`原版备份          ：${existsSync(backupPath(target)) ? backupPath(target) : "无"}`);
}

function doctor(asarPath) {
  status(asarPath);
  const logFile = join(stateDir(), "renderer.log");
  console.log(`\n诊断日志（${logFile}）：`);
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    console.log(lines.slice(-25).map((l) => "  " + l).join("\n"));
  } else {
    console.log("  （暂无日志：启动打过补丁的 ZCode 后生成）");
  }
  const injLog = join(stateDir(), "injector.log");
  if (existsSync(injLog)) {
    const lines = readFileSync(injLog, "utf8").trim().split("\n");
    console.log(`\n注入器日志（${injLog}）：`);
    console.log(lines.slice(-10).map((l) => "  " + l).join("\n"));
  }
}

// ---------- 调度 ----------

function runCommand(cmd, asarPath, purge) {
  if (cmd === "install") return install(asarPath);
  if (cmd === "uninstall") return uninstall(asarPath, purge);
  if (cmd === "status") return status(asarPath);
  if (cmd === "doctor") return doctor(asarPath);
  if (cmd === "version") return console.log(VERSION);
  fatal(`未知命令：${cmd}`);
}

// 安装/卸载统一入口：先处理提权（提权子进程在新窗口执行，本进程等待后展示结果）
function runMutation(cmd, asarPath, purge) {
  if ((cmd === "install" || cmd === "uninstall") && existsSync(dirname(asarPath)) && !canWrite(dirname(asarPath))) {
    const ok = relaunchElevated([cmd, ...(purge ? ["--purge"] : []), "--asar", asarPath]);
    if (ok) {
      console.log("");
      status(asarPath);
    }
    return ok ? 0 : 1;
  }
  try {
    runCommand(cmd, asarPath, purge);
    return 0;
  } catch (e) {
    console.error("✗ " + (e.message || e));
    return 1;
  }
}

function printHelp() {
  console.log(`ZCodeQuotaInjector v${VERSION} — ZCode 原生位置额度显示注入器
把 Kimi Code 订阅额度与 DeepSeek API 余额注入 ZCode（上下文小环旁 + 设置页）。

双击运行进入交互菜单；命令行用法：
  install     安装/更新注入（需先完全退出 ZCode；需要时自动请求管理员权限）
  uninstall   还原原版 app.asar（--purge 同时删除备份与诊断日志）
  status      查看安装状态与版本
  doctor      排障：状态 + 渲染层/注入器日志
  version     显示版本
选项：
  --asar <路径>   指定 app.asar（测试用）`);
}

// ---------- 交互菜单（双击运行） ----------

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  rl.on("close", () => process.exit(0)); // 输入流关闭时直接退出，避免悬挂
  const asarIdx = process.argv.indexOf("--asar");
  const asarPath = asarIdx >= 0 ? process.argv[asarIdx + 1] : DEFAULT_ASAR;

  console.log(`\n=== ZCodeQuota 注入器 v${VERSION} ===`);
  console.log(`Kimi Code 订阅额度 + DeepSeek 余额 → ZCode 原生 UI（小环旁 + 设置页）`);
  console.log(`目标：${asarPath}\n`);
  try {
    status(asarPath);
  } catch (e) {
    console.log("（读取状态失败：" + e.message + "）");
  }

  for (;;) {
    console.log("\n---------------- 菜单 ----------------");
    console.log("  1) 安装注入   （需先完全退出 ZCode；必要时弹 UAC）");
    console.log("  2) 卸载还原本体（--purge：连备份/日志一起清）");
    console.log("  3) 查看状态");
    console.log("  4) 诊断 doctor");
    console.log("  5) 退出");
    const c = (await ask("请选择：")).trim().toLowerCase();
    if (c === "5" || c === "q" || c === "quit" || c === "exit") break;
    if (c === "1") runMutation("install", asarPath, false);
    else if (c === "2") runMutation("uninstall", asarPath, false);
    else if (c === "2p") runMutation("uninstall", asarPath, true);
    else if (c === "3") {
      try {
        status(asarPath);
      } catch (e) {
        console.error("✗ " + e.message);
      }
    } else if (c === "4") {
      try {
        doctor(asarPath);
      } catch (e) {
        console.error("✗ " + e.message);
      }
    } else console.log("无效选择。");
  }
  rl.close();
}

// ---------- 入口 ----------

// 提取位置参数（跳过 --asar 及其值；其余选项均为布尔开关）
function positionalArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--asar") {
      i++;
      continue;
    }
    if (!argv[i].startsWith("--")) out.push(argv[i]);
  }
  return out;
}

async function cliMain() {
  const argv = process.argv.slice(2);
  const positionals = positionalArgs(argv);
  const cmd = positionals[0] || "help";
  const asarIdx = argv.indexOf("--asar");
  const asarPath = asarIdx >= 0 ? argv[asarIdx + 1] : DEFAULT_ASAR;
  const purge = argv.includes("--purge");

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }
  if (cmd === "version") {
    console.log(VERSION);
    return 0;
  }
  return runMutation(cmd, asarPath, purge);
}

if (require.main === module) {
  (async () => {
    let code = 0;
    try {
      const hasCmd = positionalArgs(process.argv.slice(2)).length > 0;
      if (!hasCmd && isInteractive()) {
        await menu();
      } else {
        code = await cliMain();
      }
    } catch (e) {
      console.error("✗ " + (e.message || e));
      code = 1;
    }
    await pause();
    process.exit(code);
  })();
}

module.exports = { parseAsar, encodeHeader, buildPatched, buildPatchContents };
