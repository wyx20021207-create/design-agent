/**
 * 冒烟测试：不碰容器，只确认 Pi Durable 的 ExecutionEnv 能用。
 *
 *   npm run smoke
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const env = new NodeExecutionEnv({ cwd: process.cwd() });

const read = await env.readTextFile("package.json", BACKGROUND_CONTEXT);
if (!read.ok) {
  console.error("readTextFile 失败:", read.error);
  process.exit(1);
}

const pkg = JSON.parse(read.value) as { name?: string; version?: string };
console.log("包名:", pkg.name);
console.log("版本:", pkg.version);

const listed = await env.listDir(".", BACKGROUND_CONTEXT);
if (!listed.ok) {
  console.error("listDir 失败:", listed.error);
  process.exit(1);
}
console.log("当前目录条目数:", listed.value.length);

let output = "";
const exec = await env.exec(
  "node -v",
  { onOutput: (text) => { output += text; } },
  BACKGROUND_CONTEXT,
);
if (!exec.ok) {
  console.error("exec 失败:", exec.error);
  process.exit(1);
}
console.log("退出码:", exec.value.exitCode);
console.log("容器外的 node:", output.trim());

console.log("\n环境可用。");
