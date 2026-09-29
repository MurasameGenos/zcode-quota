#!/usr/bin/env node
/**
 * 构建 ZCodeQuotaInjector：
 *   node build-exe.mjs                    → 当前平台单文件可执行（Windows: .exe）
 *   node build-exe.mjs --target=linux     → 交叉构建 linux-x64 单文件可执行（实验性）
 *                                           下载官方 Linux Node 二进制 + postject 注入 ELF
 * Linux 产物在 Windows/macOS 上仅验证"构建成功"，未做运行验证（无法在本机执行 ELF）。
 */
import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { get } from "node:https";

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const target = (argv.find((a) => a.startsWith("--target=")) || "--target=native").slice(9);

function download(url, file) {
  return new Promise((res, rej) => {
    get(url, (r) => {
      if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return download(r.headers.location, file).then(res, rej);
      }
      if (r.statusCode !== 200) return rej(new Error(`下载失败 HTTP ${r.statusCode}: ${url}`));
      const out = createWriteStream(file);
      r.pipe(out);
      out.on("finish", () => out.close(res));
      out.on("error", rej);
    }).on("error", rej);
  });
}

async function main() {
  execSync("node --experimental-sea-config sea-config.json", { cwd: ROOT, stdio: "inherit" });

  if (target === "linux") {
    const ver = process.versions.node;
    const dir = join(ROOT, ".sea-linux");
    mkdirSync(dir, { recursive: true });
    const tar = join(dir, `node-v${ver}-linux-x64.tar.xz`);
    const url = `https://nodejs.org/dist/v${ver}/node-v${ver}-linux-x64.tar.xz`;
    if (!existsSync(tar)) {
      console.log(`1/4 下载 Linux node v${ver}（~25MB）…`);
      await download(url, tar);
    } else console.log("1/4 使用已缓存的 Linux node");
    console.log("2/4 解压…");
    // 用相对路径调用 tar：GNU tar 会把 "C:\..." 当作远程主机名
    execSync(`tar -xJf ".sea-linux/node-v${ver}-linux-x64.tar.xz" -C .sea-linux`, { cwd: ROOT, stdio: "inherit" });
    const nodeBin = join(dir, `node-v${ver}-linux-x64`, "bin", "node");
    if (!existsSync(nodeBin)) throw new Error("解压后未找到 bin/node");
    const OUT = join(ROOT, "ZCodeQuotaInjector-linux-x64");
    copyFileSync(nodeBin, OUT);
    console.log("3/4 postject 注入（ELF）…");
    execSync(
      `npx --yes postject "${OUT}" NODE_SEA_BLOB "${join(ROOT, "zquota-injector.blob")}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
      { cwd: ROOT, stdio: "inherit" }
    );
    console.log("4/4 清理…");
    try { rmSync(join(ROOT, "zquota-injector.blob")); } catch {}
    console.log(`完成：${OUT}`);
    console.log("注意：产物未做运行验证。请在 Linux 上执行：chmod +x ZCodeQuotaInjector-linux-x64 && ./ZCodeQuotaInjector-linux-x64 version");
    return;
  }

  const EXE = join(ROOT, "ZCodeQuotaInjector.exe");
  console.log("复制 node 运行时…");
  copyFileSync(process.execPath, EXE);
  console.log("postject 注入 blob…");
  execSync(
    `npx --yes postject "${EXE}" NODE_SEA_BLOB "${join(ROOT, "zquota-injector.blob")}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { cwd: ROOT, stdio: "inherit" }
  );
  try { rmSync(join(ROOT, "zquota-injector.blob")); } catch {}
  console.log(`完成：${EXE}`);
  console.log("自检：");
  execSync(`"${EXE}" version`, { stdio: ["ignore", "inherit", "inherit"] });
}

main().catch((e) => {
  console.error("✗ " + (e.message || e));
  process.exit(1);
});
