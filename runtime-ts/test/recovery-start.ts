/**
 * 恢复测试第一段：让渲染完成并进入 report 阶段，然后硬退出。
 *
 * 关键窗口：产物已写、完成标记已写、检查点已到 report，但回执还没提交。
 * 第二段进程应该直接从 report 继续，不重跑渲染。
 *
 *   npm run recovery
 */
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";

import { loadSettings } from "../src/config.ts";
import { ensureRunning } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";
import { openRuntime } from "../src/harness/runtime.ts";
import { CONVERSATION_FILE, PROMPT, PROJECT, containerOptions } from "./recovery-fixture.ts";

const POLL_MS = 250;
const DEADLINE_MS = 180_000;

function fail(message: string): never {
  console.error("FAIL", message);
  process.exit(1);
}

const settings = loadSettings();
const runtime = await openRuntime(settings);
const conversation = await runtime.create();

const ref = ensureRunning(String(conversation.id), containerOptions(settings));
const rpc = RpcClient.docker(ref.name);
const env = new DockerExecutionEnv(rpc, { id: ref.name, cwd: "/workspace" });
try {
  await env.remove(PROJECT, { recursive: true, force: true }, ctx);
  await env.remove("/workspace/.renders", { recursive: true, force: true }, ctx);
  await env.createDir("/workspace/.renders", { recursive: true }, ctx);
} finally {
  rpc.close();
}

// report 阶段睡两分钟，给我们时间杀掉进程。
process.env["DESIGN_AGENT_REPORT_DELAY_MS"] = "120000";

const submission = await conversation.submit({ type: "input", content: PROMPT }, ctx);
const settled = await submission.wait(withAbortSignal(AbortSignal.timeout(180_000), ctx));
if (settled.status !== "done" || settled.type !== "input") {
  fail(`第一次提交没有完成：${settled.status}`);
}

const deadline = Date.now() + DEADLINE_MS;
for (;;) {
  const inspection = await runtime.harness.inspect(ctx);
  const render = inspection.tasks.find((task) => task.record.kind === "render");
  const phase = (render?.record.state as { checkpoint?: { phase?: string } } | undefined)?.checkpoint?.phase;
  if (render !== undefined && phase === "report") {
    console.log(`任务 ${render.record.id} 已到 report 阶段，现在硬退出进程`);
    break;
  }
  if (Date.now() > deadline) fail("render 任务始终没有进入 report 阶段");
  await sleep(POLL_MS);
}

writeFileSync(CONVERSATION_FILE, String(conversation.id), "utf8");

// 不 close、不清理：任务停在 running，report 还没提交。
process.exit(0);
