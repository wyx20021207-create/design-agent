/**
 * 交付幂等：同一个文件在同一对话里只发送一次。
 *
 *   1. 模型写文件并 upload_files → 成功
 *   2. 再 upload_files 同一路径 → 被台账挡住
 *   3. outbox 里只有一个文件，台账里只有一条记录
 *
 *   npm run delivery
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";

import { loadSettings } from "../src/config.ts";
import { LocalOutboxAdapter, sha256Of } from "../src/delivery/adapter.ts";
import { DeliveryLedgerDoc } from "../src/delivery/ledger.ts";
import { openRuntime } from "../src/harness/runtime.ts";

const PATH = "/workspace/projects/delivery-check/a.txt";
const CONTENT = "delivery-ok";

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

const FIRST_PROMPT = `先用 write 工具把内容 ${CONTENT} 写到 ${PATH}（parent 目录不存在就先创建）。
然后调用 upload_files，paths 参数为 ["${PATH}"]。
最后原样引用 upload_files 返回的文字，不要改写，也不要补充解释。`;

const SECOND_PROMPT = `再次调用 upload_files，paths 参数仍然是 ["${PATH}"]。
原样引用它返回的文字，不要改写，也不要补充解释。`;

const settings = loadSettings();
const runtime = await openRuntime(settings);

try {
  const conversation = await runtime.create();

  const outbox = new LocalOutboxAdapter(join(settings.dataDir, "outbox"));
  const folder = outbox.folderFor(String(conversation.id));
  rmSync(folder, { recursive: true, force: true });

  const ask = async (prompt: string): Promise<string> => {
    const submission = await conversation.submit({ type: "input", content: prompt }, ctx);
    const settled = await submission.wait(withAbortSignal(AbortSignal.timeout(180_000), ctx));
    if (settled.status !== "done" || settled.type !== "input") {
      throw new Error(`提交没有完成：${settled.status}`);
    }
    const entry = await conversation.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      ctx,
    );
    return textOf(entry?.model?.[0]);
  };

  const first = await ask(FIRST_PROMPT);
  console.log(`第一次回答：${first.replace(/\s+/g, " ").slice(0, 160)}`);
  check(first.includes("Files uploaded."), "第一次上传没有成功");

  const second = await ask(SECOND_PROMPT);
  console.log(`第二次回答：${second.replace(/\s+/g, " ").slice(0, 160)}`);
  check(
    second.includes("Already delivered in this thread, not sent again"),
    "第二次上传没有被台账挡住",
  );

  const deliveredBytes = readFileSync(join(folder, "a.txt"));
  const delivered = deliveredBytes.toString("utf8");
  check(delivered.trim() === CONTENT, `outbox 内容不对：${JSON.stringify(delivered)}`);
  console.log(`outbox：${join(folder, "a.txt")} = ${JSON.stringify(delivered)}`);

  const ledger = await runtime.harness.snapshot(DeliveryLedgerDoc, conversation.id, ctx);
  check(ledger !== undefined, "没有写交付台账");
  check(ledger.deliveries.length === 1, `台账记录数不对：${ledger.deliveries.length}`);
  const record = ledger.deliveries[0];
  check(record !== undefined, "台账记录为空");
  check(record.path === PATH, `台账路径不对：${record.path}`);
  check(record.sha256 === sha256Of(deliveredBytes), "台账摘要不对");
  console.log(`台账：${record.path} sha256=${record.sha256.slice(0, 12)}… → ${record.target}`);

  console.log("\nPASS 交付幂等：首次发送 → 记录台账 → 重复调用被跳过");
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
