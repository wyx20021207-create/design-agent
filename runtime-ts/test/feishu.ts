/**
 * 飞书适配器的纯逻辑检查（不连网）：
 *
 *   事件解析 / 线程键 / @ 去除 / 富文本 / 线程状态 / 交付路由
 *
 *   npm run feishu
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

import { loadSettings } from "../src/config.ts";
import type { DeliveryAdapter, DeliveryBatch, DeliveryOutcome } from "../src/delivery/adapter.ts";
import type { FeishuTransport } from "../src/feishu/client.ts";
import { FeishuDeliveryAdapter } from "../src/feishu/delivery.ts";
import { parseEvent, threadKeyOf, type FeishuEvent } from "../src/feishu/events.ts";
import {
  advanceFeishuThread,
  feishuTargetForConversation,
  readFeishuState,
  writeFeishuThread,
} from "../src/feishu/state.ts";
import { openRuntime } from "../src/harness/runtime.ts";

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CHAT = "oc_73093a0d27157b194e9fe89ed5b75bb6";
const ROOT = "om_x100b61a2b85374a4c0c3663c96a3182";

const event = (overrides: Partial<FeishuEvent["message"]> = {}, extra: Partial<FeishuEvent> = {}): FeishuEvent => ({
  event_id: "be3a95e8cd05d7a66d96d9f2755458dc",
  sender: { sender_type: "user", sender_id: { open_id: "ou_4095aceaceb6c70ba645fd519cd8fb6b" } },
  message: {
    message_id: ROOT,
    chat_id: CHAT,
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "@_user_1 测试" }),
    mentions: [{ key: "@_user_1", name: "Design Agent", id: { open_id: "ou_bot" } }],
    ...overrides,
  },
  ...extra,
});

const top = parseEvent(event());
check(top !== undefined, "顶层消息没有解析出来");
check(top!.text === "测试", `@ 没有去掉：${JSON.stringify(top!.text)}`);
check(top!.threadKey === `feishu-${CHAT}-root-${ROOT}`, `线程键不对：${top!.threadKey}`);
check(top!.replyTo === ROOT, "顶层消息的回复目标应该是它自己");

const reply = parseEvent(event({ message_id: "om_reply", root_id: ROOT }));
check(reply !== undefined, "回复消息没有解析出来");
check(reply!.threadKey === top!.threadKey, "回复和顶层消息没有落在同一个线程");
check(reply!.replyTo === ROOT, "回复应该挂回根消息");

const topic = parseEvent(event({ message_id: "om_topic_msg", thread_id: "omt_topic" }));
check(topic!.threadKey === `feishu-${CHAT}-thread-omt_topic`, `话题线程键不对：${topic!.threadKey}`);

const p2p = parseEvent(event({ chat_type: "p2p", chat_id: "oc_p2p" }));
check(p2p!.threadKey === "feishu-p2p-oc_p2p", `私聊线程键不对：${p2p!.threadKey}`);

const post = parseEvent(
  event({
    message_type: "post",
    content: JSON.stringify({
      title: "标题",
      content: [
        [{ tag: "text", text: "第一行" }, { tag: "at", user_id: "ou_bot" }],
        [{ tag: "text", text: "第二行" }],
      ],
    }),
    mentions: [],
  }),
);
check(post?.text === "标题\n第一行\n第二行", `富文本解析不对：${JSON.stringify(post?.text)}`);

const fromApp = parseEvent(
  event({}, { sender: { sender_type: "app", sender_id: { open_id: "ou_bot" } } }),
);
check(fromApp === undefined, "机器人自己的消息不应处理");

check(threadKeyOf({ ...event().message, message_id: "om_self" }) === `feishu-${CHAT}-root-om_self`, "独立顶层消息应自成一线程");

const settings = loadSettings();
const runtime = await openRuntime(settings);

try {
  const harness = runtime.harness;
  const threadKey = `feishu-${CHAT}-root-test-${Date.now()}`;
  const conversationId = 999_999;

  await writeFeishuThread(
    harness,
    threadKey,
    {
      conversationId,
      chatId: CHAT,
      rootMessageId: ROOT,
      lastEntryId: 0,
      updatedAt: Date.now(),
    },
    ctx,
  );

  const state = await readFeishuState(harness, ctx);
  check(state.threads[threadKey]?.rootMessageId === ROOT, "线程状态没有写进去");

  await advanceFeishuThread(harness, threadKey, 7, ctx);
  await advanceFeishuThread(harness, threadKey, 3, ctx);
  const advanced = await readFeishuState(harness, ctx);
  check(advanced.threads[threadKey]?.lastEntryId === 7, "lastEntryId 不应后退");

  const target = await feishuTargetForConversation(harness, conversationId, ctx);
  check(target?.rootMessageId === ROOT, "按 conversation 找不到飞书线程");

  const calls: string[] = [];
  const transport: FeishuTransport = {
    async replyText(messageId, text) {
      calls.push(`text:${messageId}:${text}`);
      return ["m1"];
    },
    async replyImage(messageId, key) {
      calls.push(`image:${messageId}:${key}`);
      return "m2";
    },
    async replyFile(messageId, key, name) {
      calls.push(`file:${messageId}:${name}`);
      return "m3";
    },
    async uploadImage(bytes) {
      calls.push(`upload-image:${bytes.byteLength}`);
      return "img_key";
    },
    async uploadFile(bytes, name) {
      calls.push(`upload-file:${name}:${bytes.byteLength}`);
      return "file_key";
    },
  };

  const localNames: string[] = [];
  const local: DeliveryAdapter = {
    async deliver(batch: DeliveryBatch): Promise<readonly DeliveryOutcome[]> {
      localNames.push(...batch.items.map((item) => item.name));
      return batch.items.map((item) => ({ name: item.name, target: "local", skipped: false }));
    },
  };

  const adapter = new FeishuDeliveryAdapter(() => harness, transport, local);
  const outcomes = await adapter.deliver({
    conversationId: String(conversationId),
    items: [
      {
        name: "card.png",
        sourcePath: "/workspace/projects/card.png",
        sha256: "a".repeat(64),
        bytes: new Uint8Array([1, 2, 3]),
      },
      {
        name: "deck.pdf",
        sourcePath: "/workspace/projects/deck.pdf",
        sha256: "b".repeat(64),
        bytes: new Uint8Array([4, 5]),
      },
    ],
  });

  check(outcomes.length === 2, "交付结果数量不对");
  check(outcomes.every((outcome) => outcome.target.startsWith("feishu:")), "交付目标不是飞书消息");
  check(calls.includes(`upload-image:3`), "图片没有上传");
  check(calls.includes(`image:${ROOT}:img_key`), "图片没有回复到根消息");
  check(calls.includes("upload-file:deck.pdf:2"), "文件没有上传");
  check(calls.includes(`file:${ROOT}:deck.pdf`), "文件没有回复到根消息");
  check(localNames.join(",") === "card.png,deck.pdf", "本地副本没有写");

  console.log("事件解析：顶层 / 回复 / 话题 / 私聊 / 富文本 / @ 去除  OK");
  console.log("线程状态：写入 / 前进不回退 / 按 conversation 查找  OK");
  console.log(`交付路由：${calls.join(" | ")}`);
  console.log("\nPASS 飞书适配器纯逻辑检查");
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
