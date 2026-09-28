// 调试：验证新增嵌套条目能被官方 @electron/asar 提取
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parseAsar, buildPatched } from "./injector.cjs";

const tmp = mkdtempSync(join(tmpdir(), "zq-dbg-"));
const copy = join(tmp, "app.asar");
copyFileSync("C:/Program Files/ZCode/resources/app.asar", copy);
const buf = readFileSync(copy);
const parsed = parseAsar(buf);
const adds = [
  ["out\\zquota\\zquota-probe.js", Buffer.from("console.log('probe-main')")],
  ["out\\renderer\\assets\\zquota-probe2.js", Buffer.from("console.log('probe-renderer')")],
];
const patched = buildPatched(buf, parsed, [], adds);
writeFileSync(join(tmp, "patched.asar"), patched);

const p2 = parseAsar(patched);
console.log("zquota-probe entry:", JSON.stringify(p2.header.files["out"].files["zquota"].files["zquota-probe.js"]));

for (const p of ["out\\zquota\\zquota-probe.js", "out\\renderer\\assets\\zquota-probe2.js"]) {
  try {
    execSync(`npx --yes @electron/asar extract-file "${join(tmp, "patched.asar")}" "${p}"`, { cwd: tmp, shell: true, encoding: "utf8" });
    const base = p.split("\\").pop();
    console.log(`✓ 官方工具提取成功 ${p} →`, readFileSync(join(tmp, base), "utf8").trim());
  } catch (e) {
    console.log(`✗ 提取失败 ${p}:`, (e.stderr || e.message).split("\n")[0]);
  }
}
console.log("tmp:", tmp);
