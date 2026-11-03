/**
 * 崩溃测试的第一段：提交异步任务，等它真正开始跑，然后硬退出进程。
 *
 * 不调用 runtime.close()，也不写 go 文件：任务会停在 running，下次 open 时由恢复逻辑接手。
 *
 *   npm run async-crash
 */
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";

import { loadSettings } from "../src/config.ts";
import { ensureRunning } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";
import { openRuntime } from "../src/harness/runtime.ts";
import { CONVERSATION_FILE, PROJECT, PROMPT, containerOptions } from "./async-fixture.ts";

const POLL_MS = 200;
const DEADLINE_MS = 60_000;

function fail(message: string): never {
  console.error("FAIL", message);
  process.exit(1);
}

const settings = loadSettings();
const runtime = await openRuntime(settings);
const conversation = await runtime.create();

// 清掉上一次运行留下的产物、go 文件和完成标记。
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

const submission = await conversation.submit({ type: "input", content: PROMPT }, ctx);
const settled = await submission.wait(withAbortSignal(AbortSignal.timeout(120_000), ctx));
if (settled.status !== "done" || settled.type !== "input") {
  fail(`第一次提交没有完成：${settled.status}`);
}

// 等到 render 任务被调度器预留（running），再中断，才能覆盖"执行到一半"的情况。
const deadline = Date.now() + DEADLINE_MS;
for (;;) {
  const inspection = await runtime.harness.inspect(ctx);
  const render = inspection.tasks.find((task) => task.record.kind === "render");
  if (render !== undefined && render.state.kind === "running") {
    console.log(`任务已开始运行：${render.record.id}`);
    break;
  }
  if (Date.now() > deadline) fail("render 任务始终没有进入 running");
  await sleep(POLL_MS);
}

writeFileSync(CONVERSATION_FILE, String(conversation.id), "utf8");
console.log(`已写入 ${CONVERSATION_FILE}，现在硬退出进程（模拟崩溃）`);

// 不 close、不清理：任务保持 running，交给下一次 open 的恢复逻辑。
process.exit(0);
