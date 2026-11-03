/**
 * staging：把技能、脚本、品牌、字体灌进容器。
 *
 *   npm run staging
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

import { ensureRunning } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";
import { stageWorkspace } from "../src/staging/stage.ts";
import { SPIKE } from "./spike.ts";

const conversationId = "stage-check";

const first = await stageWorkspace(conversationId, SPIKE);
console.log(`第一次: staged=${first.staged}, ${first.files} 个文件`);
console.log(`  digest ${first.digest.slice(0, 16)}…`);

const second = await stageWorkspace(conversationId, SPIKE);
console.log(`第二次: staged=${second.staged}（应为 false，清单没变）`);

const ref = ensureRunning(conversationId, SPIKE);
const rpc = RpcClient.docker(ref.name);
const env = new DockerExecutionEnv(rpc, { id: ref.name });

try {
  const skills = await env.listDir("/workspace/skills", ctx);
  if (!skills.ok) throw new Error(skills.error.message);
  console.log(`技能目录: ${skills.value.length} 个`);

  const skill = await env.readTextFile("/workspace/skills/stills/SKILL.md", ctx);
  if (!skill.ok) throw new Error(skill.error.message);
  console.log(`stills/SKILL.md 前 40 字: ${JSON.stringify(skill.value.slice(0, 40))}`);

  const tools = await env.listDir("/workspace/tools", ctx);
  if (!tools.ok) throw new Error(tools.error.message);
  console.log(`脚本: ${tools.value.length} 个`);

  const brand = await env.listDir("/workspace/brand", ctx);
  if (!brand.ok) throw new Error(brand.error.message);
  console.log(`品牌包: ${brand.value.map((entry) => entry.name).sort().join(", ")}`);

  const fonts = await env.listDir("/workspace/fonts", ctx);
  if (!fonts.ok) throw new Error(fonts.error.message);
  console.log(`字体: ${fonts.value.length} 个`);

  const blocked = await env.writeFile("/workspace/skills/should-not-exist.txt", "x", ctx);
  console.log(`往只读目录写文件: ${blocked.ok ? "竟然成功了 ✗" : `被拒绝 (${blocked.error.code}) ✓`}`);
  if (blocked.ok) process.exitCode = 1;
} finally {
  rpc.close();
}
