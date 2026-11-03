/**
 * 崩溃测试的第二段：重新打开同一个存储，验证任务从检查点恢复并完成。
 *
 *   npm run async-crash
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";

import { loadSettings } from "../src/config.ts";
import { ensureRunning } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";
import { TASK_REPORT_ENTRY } from "../src/harness/render-task.ts";
import { openRuntime } from "../src/harness/runtime.ts";
import { CONVERSATION_FILE, GO, OUTPUT, containerOptions } from "./async-fixture.ts";

const POLL_MS = 250;
const QUIET_TIMEOUT_MS = 3 * 60 * 1_000;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const textOf = (message: { content?: unknown } | undefined): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("\n");
};

if (!existsSync(CONVERSATION_FILE)) {
  console.error("FAIL 找不到第一段写入的 conversation id；先运行 npm run async-crash-start");
  process.exit(1);
}
const conversationId = Number(readFileSync(CONVERSATION_FILE, "utf8").trim()) as ConversationId;

const settings = loadSettings();
const runtime = await openRuntime(settings);

try {
  const conversation = await runtime.harness.conversation(conversationId, ctx);
  check(conversation !== undefined, "重新打开后找不到对话");

  // open() 应该已经把 running 改回 pending，并把 restarts 加一。
  const deadline = Date.now() + 60_000;
  let recovered: { id: number; restarts: number } | undefined;
  for (;;) {
    const inspection = await runtime.harness.inspect(ctx);
    const render = inspection.tasks.find((task) => task.record.kind === "render");
    if (render !== undefined) {
      recovered = { id: render.record.id, restarts: render.record.restarts ?? 0 };
      console.log(`恢复的任务：${render.record.id} 状态=${render.state.kind} restarts=${recovered.restarts}`);
      break;
    }
    if (Date.now() > deadline) throw new Error("恢复后没有找到 render 任务");
    await sleep(POLL_MS);
  }
  check(recovered !== undefined, "恢复后没有找到 render 任务");
  check(recovered.restarts >= 1, `open() 没有计入这次崩溃：restarts=${recovered.restarts}`);

  const ref = ensureRunning(String(conversationId), containerOptions(settings));
  const triggerRpc = RpcClient.docker(ref.name);
  const triggerEnv = new DockerExecutionEnv(triggerRpc, { id: ref.name, cwd: "/workspace" });
  try {
    const trigger = await triggerEnv.writeFile(GO, "go\n", ctx);
    check(trigger.ok, `写 go 文件失败：${trigger.ok ? "" : trigger.error.code}`);
  } finally {
    triggerRpc.close();
  }
  console.log("已放行，等待恢复后的任务完成……");

  const quietDeadline = Date.now() + QUIET_TIMEOUT_MS;
  for (;;) {
    const inspection = await runtime.harness.inspect(ctx);
    if (inspection.tasks.length === 0 && inspection.submissions.length === 0) break;
    if (Date.now() > quietDeadline) {
      throw new Error(`等待超时，仍有 ${inspection.tasks.length} 个任务 / ${inspection.submissions.length} 个提交`);
    }
    await sleep(POLL_MS);
  }

  const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx);
  const report = page.items
    .filter((entry) => entry.kind === TASK_REPORT_ENTRY)
    .at(-1);
  check(report !== undefined, "恢复后没有收到任务回执");
  const data = report.data as { ok?: boolean; taskId?: number } | undefined;
  check(data?.ok === true, `任务回执不是成功状态：${JSON.stringify(data)}`);
  check(data?.taskId === recovered.id, "回执里的 taskId 不是恢复的那个任务");
  console.log(`任务回执：${textOf(report.model?.[0]).replace(/\s+/g, " ").slice(0, 160)}`);

  const wakeTexts = page.items
    .filter((entry) => entry.id > report.id && entry.model?.[0]?.role === "assistant")
    .map((entry) => textOf(entry.model?.[0]).trim())
    .filter((text) => text.length > 0);
  check(wakeTexts.length > 0, "任务完成后模型没有被唤醒");
  console.log(`唤醒后的回答：${wakeTexts.at(-1)?.replace(/\s+/g, " ").slice(0, 120)}`);

  const verifyRpc = RpcClient.docker(ref.name);
  const verifyEnv = new DockerExecutionEnv(verifyRpc, { id: ref.name, cwd: "/workspace" });
  try {
    const artifact = await verifyEnv.readTextFile(OUTPUT, ctx);
    if (!artifact.ok) throw new Error(`读产物失败：${artifact.error.code}`);
    check(artifact.value === "crash-ok\n", "产物内容不对");
    console.log(`产物校验：${OUTPUT} = ${JSON.stringify(artifact.value)}`);
  } finally {
    verifyRpc.close();
  }

  rmSync(CONVERSATION_FILE, { force: true });
  console.log("\nPASS 崩溃恢复：running → 重开 → restarts+1 → 从检查点重跑 → 回执 → 唤醒");
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
