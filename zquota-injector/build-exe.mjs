#!/usr/bin/env node
/** 构建 ZCodeQuotaInjector.exe：Node SEA + postject 注入。运行：node build-exe.mjs */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXE = join(ROOT, "ZCodeQuotaInjector.exe");

console.log("1/4 生成 SEA blob…");
execSync(`node --experimental-sea-config sea-config.json`, { cwd: ROOT, stdio: "inherit" });

console.log("2/4 复制 node 运行时…");
copyFileSync(process.execPath, EXE);

console.log("3/4 postject 注入 blob…");
execSync(
  `npx --yes postject "${EXE}" NODE_SEA_BLOB "${join(ROOT, "zquota-injector.blob")}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { cwd: ROOT, stdio: "inherit" }
);

console.log("4/4 清理…");
try { rmSync(join(ROOT, "zquota-injector.blob")); } catch {}

console.log(`完成：${EXE}`);
console.log("自检：");
execSync(`"${EXE}" version`, { stdio: "inherit" });
