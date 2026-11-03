/**
 * 恢复测试第二段：从 report 检查点继续，验证：
 *   - restarts 计数 +1
 *   - 渲染没有重跑（count.txt 只有一个 x）
 *   - 回执只提交一次
 *   - 任务终态 completed
 *
 *   npm run recovery
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

import { loadSettings } from "../src/config.ts";
import { TASK_REPORT_ENTRY } from "../src/harness/render-task.ts";
import { openRuntime } from "../src/harness/runtime.ts";
import { messageText } from "../src/text.ts";
import { CONVERSATION_FILE, COUNT, OUTPUT } from "./recovery-fixture.ts";

const POLL_MS = 250;
const QUIET_TIMEOUT_MS = 3 * 60 * 1_000;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (!existsSync(CONVERSATION_FILE)) {
  console.error("FAIL 找不到 conversation id；先运行 npm run recovery-start");
  process.exit(1);
}
delete process.env["DESIGN_AGENT_REPORT_DELAY_MS"];

const conversationId = Number(readFileSync(CONVERSATION_FILE, "utf8").trim()) as ConversationId;
const runtime = await openRuntime(loadSettings());

try {
  const conversation = await runtime.harness.conversation(conversationId, ctx);
  check(conversation !== undefined, "重新打开后找不到对话");

  const deadline = Date.now() + 60_000;
  let taskId: TaskId | undefined;
  let restarts = 0;
  for (;;) {
    const inspection = await runtime.harness.inspect(ctx);
    const render = inspection.tasks.find((task) => task.record.kind === "render");
    if (render !== undefined) {
      taskId = render.record.id;
      restarts = render.record.restarts ?? 0;
      console.log(`恢复的任务 ${taskId} 状态=${render.state.kind} restarts=${restarts}`);
      break;
    }
    if (Date.now() > deadline) throw new Error("恢复后没有找到 render 任务");
    await sleep(POLL_MS);
  }
  check(restarts >= 1, `open() 没有计入这次崩溃：restarts=${restarts}`);

  const quietDeadline = Date.now() + QUIET_TIMEOUT_MS;
  for (;;) {
    const inspection = await runtime.harness.inspect(ctx);
    if (inspection.tasks.length === 0 && inspection.submissions.length === 0) break;
    if (Date.now() > quietDeadline) {
      throw new Error(`等待超时，仍有 ${inspection.tasks.length} 个任务`);
    }
    await sleep(POLL_MS);
  }

  const page = await conversation.entries({ order: "ascending" }, 200, undefined, ctx);
  const reports = page.items.filter((entry) => entry.kind === TASK_REPORT_ENTRY);
  check(reports.length === 1, `回执数量不对：${reports.length}`);
  const report = reports[0];
  check(report !== undefined, "没有任务回执");
  const reportText = messageText(report.model?.[0]);
  check(reportText.includes("渲染完成"), `回执内容不对：${reportText.slice(0, 120)}`);
  console.log(`回执：${reportText.replace(/\s+/g, " ").slice(0, 120)}`);

  const after = page.items.filter(
    (entry) => entry.id > report.id && entry.model?.[0]?.role === "assistant",
  );
  const wakeText = after.map((entry) => messageText(entry.model?.[0])).join("\n");
  check(wakeText.length > 0, "回执后模型没有被唤醒");
  console.log(`唤醒后的回答：${wakeText.replace(/\s+/g, " ").slice(0, 100)}`);

  const env = await runtime.env(conversationId);
  const count = await env.readTextFile(COUNT, ctx);
  if (!count.ok) throw new Error(`读 count.txt 失败：${count.error.code}`);
  check(count.value === "x", `渲染被重跑了：count.txt = ${JSON.stringify(count.value)}`);
  const output = await env.readTextFile(OUTPUT, ctx);
  if (!output.ok) throw new Error(`读 out.txt 失败：${output.error.code}`);
  check(output.value === "recovery-ok\n", "产物内容不对");
  console.log(`产物：count.txt=${JSON.stringify(count.value)}, out.txt=${JSON.stringify(output.value)}`);

  if (taskId === undefined) throw new Error("没有任务 id");
  const record = await runtime.harness.getTask(taskId, ctx);
  if (record === undefined || record.state.status !== "terminal") {
    throw new Error(`任务没有终态：${record?.state.status ?? "missing"}`);
  }
  check(record.state.outcome.status === "completed", `任务终态不是 completed：${record.state.outcome.status}`);
  console.log(`任务终态：${record.state.outcome.status}`);

  rmSync(CONVERSATION_FILE, { force: true });
  console.log("\nPASS 恢复：report 检查点续跑 / 不重渲染 / 回执一次 / 终态 completed");
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
