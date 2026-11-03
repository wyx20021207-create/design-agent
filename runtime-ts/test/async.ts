/**
 * 异步 ReAct 的端到端检查：
 *
 *   1. 模型调 start_render，工具立刻返回，这一轮回答先结束
 *   2. 渲染任务仍在跑（被 go 文件挡住）
 *   3. 放行后任务完成，把回执作为新的输入投放回对话
 *   4. 模型被唤醒，产生第二段回复
 *
 *   npm run async
 */
import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";

import { loadSettings } from "../src/config.ts";
import { ensureRunning } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";
import { TASK_REPORT_ENTRY, renderDigest } from "../src/harness/render-task.ts";
import { openRuntime } from "../src/harness/runtime.ts";

const OUTPUT = "/workspace/projects/async-check/out.txt";
const GO = "/workspace/projects/async-check/go";
const POLL_MS = 500;
const QUIET_TIMEOUT_MS = 3 * 60 * 1_000;

const fail = (message: string): never => {
  throw new Error(message);
};
function check(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
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

const prompt = `使用 start_render 工具，只调用一次，参数必须完全如下。不要用 bash 自己执行这条命令，也不要创建 go 文件。

command: mkdir -p /workspace/projects/async-check && while [ ! -f /workspace/projects/async-check/go ]; do sleep 0.5; done && printf 'async-ok\\n' > /workspace/projects/async-check/out.txt
outputPath: ${OUTPUT}
label: async-check

start_render 返回后，你的回复必须只有四个字：已提交。不要等待渲染，不要轮询。`;

const runtime = await openRuntime(loadSettings());

try {
  const conversation = await runtime.create();

  // 同一个卷会复用上一次的产物与完成标记；先清干净，测试才可重复运行。
  const options = {
    image: process.env["DESIGN_AGENT_SANDBOX_IMAGE"] ?? "design-agent-sandbox:local",
    mountDir: runtime.settings.runtimeDir,
    root: runtime.settings.root,
  };
  const ref = ensureRunning(String(conversation.id), options);
  const rpc = RpcClient.docker(ref.name);
  const env = new DockerExecutionEnv(rpc, { id: ref.name, cwd: "/workspace" });
  try {
    await env.remove("/workspace/projects/async-check", { recursive: true, force: true }, ctx);
    await env.remove("/workspace/.renders", { recursive: true, force: true }, ctx);
    await env.createDir("/workspace/.renders", { recursive: true }, ctx);
  } finally {
    rpc.close();
  }

  const started = Date.now();

  const submission = await conversation.submit({ type: "input", content: prompt }, ctx);
  const settled = await submission.wait(withAbortSignal(AbortSignal.timeout(120_000), ctx));
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(`第一次提交没有完成：${settled.status}`);
  }
  const answerId = settled.answer;

  const firstEntry = await conversation.commit(
    (tx) => tx.entry(AssistantEntry, answerId),
    ctx,
  );
  const firstAnswer = textOf(firstEntry?.model?.[0]);
  console.log(`第一次回答（${Date.now() - started}ms）：${firstAnswer.replace(/\s+/g, " ").slice(0, 120)}`);

  const inspection = await runtime.harness.inspect(ctx);
  const render = inspection.tasks.find((task) => task.record.kind === "render");
  check(render !== undefined, "没有找到 render 任务");
  check(
    render.state.kind === "running" || render.state.kind === "pending",
    `render 任务不应已经结束：${render.state.kind}`,
  );
  const taskId = render.record.id;
  console.log(`渲染任务仍在后台：${taskId} (${render.state.kind})`);

  const triggerRpc = RpcClient.docker(ref.name);
  const triggerEnv = new DockerExecutionEnv(triggerRpc, { id: ref.name, cwd: "/workspace" });
  try {
    const trigger = await triggerEnv.writeFile(GO, "go\n", ctx);
    check(trigger.ok, `写 go 文件失败：${trigger.ok ? "" : trigger.error.code}`);
  } finally {
    triggerRpc.close();
  }
  console.log("已放行，等待任务完成并唤醒对话……");

  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  for (;;) {
    const now = await runtime.harness.inspect(ctx);
    if (now.tasks.length === 0 && now.submissions.length === 0) break;
    if (Date.now() > deadline) {
      fail(`等待超时，仍有 ${now.tasks.length} 个任务 / ${now.submissions.length} 个提交`);
    }
    await sleep(POLL_MS);
  }

  const since = firstEntry?.id ?? answerId;
  const page = await conversation.entries(
    { order: "ascending", minEntryId: since },
    200,
    undefined,
    ctx,
  );

  const report = page.items.find(
    (entry) => entry.kind === TASK_REPORT_ENTRY && entry.id > since,
  );
  check(report !== undefined, "没有收到任务回执");
  const data = report.data as { ok?: boolean; taskId?: number } | undefined;
  check(data?.ok === true, `任务回执不是成功状态：${JSON.stringify(data)}`);
  check(data?.taskId === taskId, "回执里的 taskId 不匹配");
  const reportText = textOf(report.model?.[0]);
  console.log(`任务回执：${reportText.replace(/\s+/g, " ").slice(0, 160)}`);

  const afterReport = page.items.filter(
    (entry) => entry.id > report.id && entry.model?.[0]?.role === "assistant",
  );
  const wakeTexts = afterReport
    .map((entry) => textOf(entry.model?.[0]).trim())
    .filter((text) => text.length > 0);
  check(wakeTexts.length > 0, "任务完成后模型没有被唤醒");
  console.log(`唤醒后的回答：${wakeTexts.at(-1)?.replace(/\s+/g, " ").slice(0, 120)}`);

  const verifyRpc = RpcClient.docker(ref.name);
  const verifyEnv = new DockerExecutionEnv(verifyRpc, { id: ref.name, cwd: "/workspace" });
  try {
    const artifact = await verifyEnv.readTextFile(OUTPUT, ctx);
    if (!artifact.ok) throw new Error(`读产物失败：${artifact.error.code}`);
    check(artifact.value === "async-ok\n", "产物内容不对");
    console.log(`产物校验：${OUTPUT} = ${JSON.stringify(artifact.value)}`);

    const record = await runtime.harness.getTask(taskId, ctx);
    check(record !== undefined, "找不到已结束的任务记录");
    const digest = renderDigest(record.input as { command: string; outputPath: string });
    const markerPath = `/workspace/.renders/${digest}.done`;
    const marker = await verifyEnv.readTextFile(markerPath, ctx);
    check(marker.ok && marker.value.startsWith(digest), "重跑用的完成标记没有写");
    console.log(`完成标记：${markerPath}`);
  } finally {
    verifyRpc.close();
  }

  console.log("\nPASS 异步任务：立即返回 → 后台完成 → 回执入队 → 模型被唤醒");
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
