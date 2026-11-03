/**
 * CLI：一次对话。
 *
 *   npm run cli -- ask "列出 /workspace/skills 下的目录"
 *   npm run cli -- ask --wait "渲染一张卡片"   # 等到后台任务结束并打印后续消息
 */
import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AssistantEntry, type ConversationId, type EntryId } from "@earendil-works/pi-durable";

import { loadSettings } from "./config.ts";
import { openRuntime, type Runtime } from "./harness/runtime.ts";
import { TASK_REPORT_ENTRY } from "./harness/render-task.ts";
import { messageText } from "./text.ts";

const WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 250;

const argv = process.argv.slice(2);
const fresh = argv.includes("--new");
const follow = argv.includes("--wait");
const [command, ...rest] = argv.filter((value) => value !== "--new" && value !== "--wait");

if (command !== "ask" || rest.length === 0) {
  console.error('用法: npm run cli -- ask [--new] [--wait] "你的要求"');
  process.exit(2);
}

/** 后台任务没结束时保持进程存活；任务结束后把新产生的消息打出来。 */
async function followUntilQuiet(runtime: Runtime, conversationId: ConversationId, since: EntryId): Promise<void> {
  const conversation = (await runtime.harness.conversation(conversationId, ctx)) ?? runtime.root;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  for (;;) {
    const inspection = await runtime.harness.inspect(ctx);
    if (inspection.tasks.length === 0 && inspection.submissions.length === 0) break;

    if (Date.now() > deadline) {
      console.error(`等待超时：仍有 ${inspection.tasks.length} 个任务在跑`);
      process.exitCode = 1;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const page = await conversation.entries(
    { order: "ascending", minEntryId: since },
    100,
    undefined,
    ctx,
  );

  let printed = false;
  for (const entry of page.items) {
    if (entry.id === since) continue;
    const text = messageText(entry.model?.[0]);
    if (text.length === 0) continue;
    if (entry.kind === TASK_REPORT_ENTRY) {
      console.log(`\n[任务回执] ${text}`);
      printed = true;
    } else if (entry.model?.[0]?.role === "assistant") {
      console.log(`\n${text}`);
      printed = true;
    }
  }
  if (!printed) console.log("\n(后台任务结束，没有新的文本消息)");
}

const runtime = await openRuntime(loadSettings());

try {
  const conversation = fresh ? await runtime.create() : runtime.root;

  const submission = await conversation.submit(
    { type: "input", content: rest.join(" ") },
    ctx,
  );
  const settled = await submission.wait(ctx);

  if (settled.status !== "done" || settled.type !== "input") {
    console.error("没有完成:", settled.status, "reason" in settled ? settled.reason : "");
    process.exitCode = 1;
  } else {
    const entry = await conversation.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      ctx,
    );
    console.log(messageText(entry?.model?.[0]) || "(没有文本回复)");

    if (follow) await followUntilQuiet(runtime, conversation.id, settled.answer);
  }
} finally {
  await runtime.close();
}
