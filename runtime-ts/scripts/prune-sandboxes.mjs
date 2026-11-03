#!/usr/bin/env node
/**
 * 清理 design-agent 的沙箱容器与卷。
 *
 *   node scripts/prune-sandboxes.mjs                只删容器（卷保留）
 *   node scripts/prune-sandboxes.mjs --volumes      连同未被引用的卷一起删
 *   node scripts/prune-sandboxes.mjs --dry-run      只打印，不执行
 *   node scripts/prune-sandboxes.mjs --keep=<name>  保留指定容器
 *
 * 有活跃 docker exec 会话（正在跑工具）的容器一律跳过。
 * 前缀可用 DESIGN_AGENT_PREFIX 覆盖，默认 design-agent。
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const removeVolumes = args.includes("--volumes");
const keep = new Set(
  args.filter((arg) => arg.startsWith("--keep=")).map((arg) => arg.slice("--keep=".length)),
);
const prefix = process.env.DESIGN_AGENT_PREFIX ?? "design-agent";

const docker = (argv) => execFileSync("docker", argv, { encoding: "utf8" }).trim();
const lines = (text) => text.split("\n").filter((line) => line.length > 0);

const containers = lines(
  docker(["ps", "-a", "--filter", `name=${prefix}-`, "--format", "{{.Names}}"]),
);

let removed = 0;
let kept = 0;
const removing = new Set();

for (const name of containers) {
  if (keep.has(name)) {
    console.log(`keep    ${name}`);
    kept += 1;
    continue;
  }
  // 有活跃 exec 说明工具正在里面跑，不能动。
  const execIds = JSON.parse(docker(["inspect", "-f", "{{json .ExecIDs}}", name]) || "null");
  if (Array.isArray(execIds) && execIds.length > 0) {
    console.log(`in use  ${name}`);
    kept += 1;
    continue;
  }
  removing.add(name);
  if (dryRun) {
    console.log(`remove  ${name}`);
    removed += 1;
    continue;
  }
  docker(["rm", "-f", name]);
  console.log(`removed ${name}`);
  removed += 1;
}

if (removeVolumes) {
  const volumes = lines(docker(["volume", "ls", "-q", "--filter", `name=${prefix}-ws-`]));
  for (const volume of volumes) {
    const users = lines(
      docker(["ps", "-a", "--filter", `volume=${volume}`, "--format", "{{.Names}}"]),
    ).filter((name) => !removing.has(name));
    if (users.length > 0) {
      console.log(`in use  volume ${volume} (${users.join(",")})`);
      kept += 1;
      continue;
    }
    if (dryRun) {
      console.log(`remove  volume ${volume}`);
      removed += 1;
      continue;
    }
    docker(["volume", "rm", volume]);
    console.log(`removed volume ${volume}`);
    removed += 1;
  }
}

console.log(`\n${dryRun ? "would remove" : "removed"}: ${removed}, kept: ${kept}`);
