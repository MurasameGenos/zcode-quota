#!/usr/bin/env node
/**
 * 注入器安全测试：在真实 app.asar 的副本上完整走 install → 校验 → uninstall → 还原比对。
 * 不触碰正在使用的安装目录。运行：node test-patcher.mjs
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join as pjoin } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAsar, encodeHeader, buildPatched } from "./injector.cjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LIVE = "C:\\Program Files\\ZCode\\resources\\app.asar";
const BAK = LIVE + ".zquota-backup";
// 真实 asar 可能已带补丁：优先用安装时留下的原版备份做测试基底
const REAL = existsSync(BAK) ? BAK : LIVE;
const tmp = mkdtempSync(join(tmpdir(), "zq-injector-test-"));
const copy = join(tmp, "app.asar");
const home = join(tmp, "state");

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const INJECTOR = (args) =>
  spawnSync(process.execPath, [pjoin(ROOT, "injector.cjs"), ...args], {
    env: { ...process.env, ZQUOTA_SKIP_RUNNING_CHECK: "1", ZQUOTA_HOME: home },
    encoding: "utf8",
  });

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? "：" + extra : ""}`);
  if (!ok) failed++;
};

(async () => {
  try {
    console.log(`工作目录：${tmp}`);
    console.log(`复制真实 asar（${(statSize(REAL) / 1048576).toFixed(1)} MB）…`);
    copyFileSync(REAL, copy);
    const originalSha = sha(copy);

    // 0. 零改动重建必须逐字节还原（序列化与布局完全兼容的证明）
    const buf0 = readFileSync(copy);
    const parsed0 = parseAsar(buf0);
    const rebuilt = buildPatched(buf0, parsed0, [], []);
    check("零改动重建 = 原文件逐字节一致", sha256hex(rebuilt) === originalSha);

    // 1. install
    const inst = INJECTOR(["install", "--asar", copy]);
    console.log(inst.stdout.trim());
    if (inst.stderr) console.error(inst.stderr.trim());
    check("install 成功退出", inst.status === 0);
    check("原版备份生成", existsSync(copy + ".zquota-backup"));
    check("备份与原版一致", sha(copy + ".zquota-backup") === originalSha);
    check("补丁后 asar 大于原版", statSize(copy) > statSize(copy + ".zquota-backup"));

    // 2. 用官方 @electron/asar 交叉验证
    const ex = spawnSync(
      process.execPath,
      ["--eval", `require('child_process')`],
      { encoding: "utf8" }
    );
    const list = execSync(
      `npx --yes @electron/asar list "${copy}"`,
      { encoding: "utf8", shell: true, maxBuffer: 128 * 1024 * 1024 }
    );
    check("官方工具可列出新条目 zquota-main.js", list.includes("zquota-main.js"));
    check("官方工具可列出 zquota-renderer.js", list.includes("zquota-renderer.js"));

    const exdir = join(tmp, "ex");
    mkdirSync(exdir, { recursive: true });
    execSync(`npx --yes @electron/asar extract-file "${copy}" "out\\renderer\\index.html"`, { cwd: exdir, shell: true });
    const html = readFileSync(join(exdir, "index.html"), "utf8");
    check("index.html 含注入 script", html.includes("zquota-renderer.js"));

    execSync(`npx --yes @electron/asar extract-file "${copy}" "out\\preload\\index.cjs"`, { cwd: exdir, shell: true });
    const preload = readFileSync(join(exdir, "index.cjs"), "utf8");
    check("preload 尾部内联桥（沙箱安全）", preload.includes('exposeInMainWorld("zquotaApi"') && !preload.includes('require("../zquota/'));

    execSync(`npx --yes @electron/asar extract-file "${copy}" "out\\main\\index.js"`, { cwd: exdir, shell: true });
    const main = readFileSync(join(exdir, "index.js"), "utf8");
    check("main 尾部含动态 import（正确相对路径）", main.includes('import("../zquota/zquota-main.js")'));

    execSync(`npx --yes @electron/asar extract-file "${copy}" "out\\renderer\\assets\\zquota-renderer.js"`, { cwd: exdir, shell: true });
    check("zquota-renderer.js 可提取且完整", readFileSync(join(exdir, "zquota-renderer.js"), "utf8").length > 5000);

    execSync(`npx --yes @electron/asar extract-file "${copy}" "package.json"`, { cwd: exdir, shell: true });
    check("package.json 未被破坏", JSON.parse(readFileSync(join(exdir, "package.json"), "utf8")).version === "3.14.3");

    // 3. status
    const st = INJECTOR(["status", "--asar", copy]);
    check("status 识别已安装", st.stdout.includes("已安装"), st.stdout.trim().split("\n")[1] || "");

    // 4. 二次 install 走"更新模式"（还原→重打）
    const again = INJECTOR(["install", "--asar", copy]);
    check("重复 install 走更新模式成功", again.status === 0 && again.stdout.includes("更新模式"), (again.stdout.match(/✓.*/g) || ["无输出"]).join(" | "));

    // 5. uninstall → 字节级还原
    const un = INJECTOR(["uninstall", "--purge", "--asar", copy]);
    console.log(un.stdout.trim());
    check("uninstall 成功", un.status === 0);
    check("卸载后与原版逐字节一致", sha(copy) === originalSha);

    console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
    process.exit(failed ? 1 : 0);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch { /* Windows 文件占用时忽略 */ }
  }
})();

function statSize(p) {
  return readFileSync(p).length;
}
