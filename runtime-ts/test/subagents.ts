/**
 * 子代理端到端：
 *   父对话调 delegate → 子对话独立上下文回答
 *   子对话和父对话共用同一个容器（环境 id 相同）
 *
 *   npm run subagents
 */
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { AssistantEntry, type ConversationId } from "@earendil-works/pi-durable";

import { loadSettings } from "../src/config.ts";
import { openRuntime } from "../src/harness/runtime.ts";
import { SubagentDoc } from "../src/harness/subagents.ts";
import { messageText } from "../src/text.ts";

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const settings = loadSettings();
const runtime = await openRuntime(settings);

try {
  const parent = await runtime.create();
  const parentEnv = await runtime.env(parent.id);

  const submission = await parent.submit(
    {
      type: "input",
      content:
        "使用 delegate 工具，brief 精确为「只回复两个字母 OK，不要使用任何工具，不要解释。」。" +
        "不要自己回答；等 worker 返回后，把它的回复原样贴出来。",
    },
    ctx,
  );
  const settled = await submission.wait(withAbortSignal(AbortSignal.timeout(300_000), ctx));
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(`父对话没有完成：${settled.status}`);
  }
  const entry = await parent.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
  const answer = messageText(entry?.model?.[0]);
  console.log(`父对话回答：${answer.replace(/\s+/g, " ").slice(0, 160)}`);
  check(answer.includes("OK"), "父对话没有拿到 worker 的 OK");

  const state = await runtime.harness.snapshot(SubagentDoc, ctx);
  const children = Object.entries(state?.parents ?? {})
    .filter(([, parentId]) => parentId === String(parent.id))
    .map(([childId]) => Number(childId))
    .sort((a, b) => b - a);
  check(children.length > 0, "delegate 没有登记子对话");
  const childId = children[0] as number;

  const childEnv = await runtime.env(childId as ConversationId);
  check(childEnv.id === parentEnv.id, `子对话没有共用父容器：${childEnv.id} != ${parentEnv.id}`);
  console.log(`父容器 ${parentEnv.id}`);
  console.log(`子对话 ${childId} → 同一个容器`);

  const child = await runtime.harness.conversation(childId as ConversationId, ctx);
  check(child !== undefined, "找不到子对话");
  const childEntries = await child.entries({ order: "ascending" }, 10, undefined, ctx);
  const childText = childEntries.items.map((item) => messageText(item.model?.[0])).join("\n");
  check(childText.includes("specialist working for the lead"), "子对话没有 worker 提示词");

  // 并行 look：一次调用拉起两个 worker
  const looks = await parent.submit(
    {
      type: "input",
      content:
        '使用 parallel_looks 工具，project 为 "look-check"，count 为 2，' +
        'brief 精确为「只回复你的 Direction 名称，不要使用任何工具，不要解释」。' +
        "等两个 worker 都返回后，把 report 原样贴出来，不要改写。",
    },
    ctx,
  );
  const looksSettled = await looks.wait(withAbortSignal(AbortSignal.timeout(600_000), ctx));
  if (looksSettled.status !== "done" || looksSettled.type !== "input") {
    throw new Error(`parallel_looks 没有完成：${looksSettled.status}`);
  }
  const looksEntry = await parent.commit(
    (tx) => tx.entry(AssistantEntry, looksSettled.answer),
    ctx,
  );
  const looksAnswer = messageText(looksEntry?.model?.[0]);
  console.log(`parallel_looks：${looksAnswer.replace(/\s+/g, " ").slice(0, 200)}`);
  check(looksAnswer.includes("look 1") && looksAnswer.includes("look 2"), "没有拿到两个 look 的 report");

  const after = await runtime.harness.snapshot(SubagentDoc, ctx);
  const allChildren = Object.entries(after?.parents ?? {})
    .filter(([, parentId]) => parentId === String(parent.id))
    .map(([childId]) => Number(childId));
  check(allChildren.length >= 3, `子代理数量不对：${allChildren.length}`);
  for (const id of allChildren) {
    const env = await runtime.env(id as ConversationId);
    check(env.id === parentEnv.id, `子代理 ${id} 没有共用父容器`);
  }
  console.log(`子代理总数：${allChildren.length}，全部共用容器 ${parentEnv.id}`);

  console.log("\nPASS 子代理：独立上下文 + 共用容器 + 并行 look");
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
