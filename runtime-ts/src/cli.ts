/**
 * CLI：一次对话。
 *
 *   npm run cli -- ask "列出 /workspace/skills 下的目录"
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";

import { loadSettings } from "./config.ts";
import { openRuntime } from "./harness/runtime.ts";

const argv = process.argv.slice(2);
const fresh = argv.includes("--new");
const [command, ...rest] = argv.filter((value) => value !== "--new");

if (command !== "ask" || rest.length === 0) {
  console.error('用法: npm run cli -- ask [--new] "你的要求"');
  process.exit(2);
}

const runtime = await openRuntime(loadSettings());

try {
  const conversation = fresh ? await runtime.create() : runtime.root;

  const submission = await conversation.submit(
    { type: "input", content: rest.join(" ") },
    BACKGROUND_CONTEXT,
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);

  if (settled.status !== "done" || settled.type !== "input") {
    console.error("没有完成:", settled.status, "reason" in settled ? settled.reason : "");
    process.exitCode = 1;
  } else {
    const entry = await conversation.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      BACKGROUND_CONTEXT,
    );
    const message = entry?.model?.[0];
    const block =
      message?.role === "assistant"
        ? message.content.find((content) => content.type === "text")
        : undefined;
    console.log(block?.type === "text" ? block.text : "(没有文本回复)");
  }
} finally {
  await runtime.close();
}
