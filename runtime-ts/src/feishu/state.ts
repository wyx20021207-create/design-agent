/**
 * 飞书线程的持久状态：回复目标、最后一条已推送的对话条目。
 *
 * 放在 Session 级文档里，进程重启后能接着推送，不会把旧回答重发一遍。
 * entry id 是全局递增的，所以 `lastEntryId` 足够做游标。
 */
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

export type FeishuThreadState = {
  conversationId: number;
  chatId: string;
  /** 回复挂在根消息下面；顶层 @ 消息本身就是根。 */
  rootMessageId: string;
  /** 已经发到飞书的最后一条 entry id；0 表示还没发过。 */
  lastEntryId: number;
  updatedAt: number;
};

export type FeishuStateValue = {
  threads: Record<string, FeishuThreadState>;
  /** 已处理过的 message_id；飞书重推同一消息时不再跑一遍。 */
  seen: string[];
};

const MAX_SEEN = 500;

export const FeishuStateDoc = defineDoc({
  kind: "design.feishu",
  version: 2,
  scope: "session",
  initial: (): FeishuStateValue => ({ threads: {}, seen: [] }),
  migrate: (value) => ({
    threads: (value["threads"] as FeishuStateValue["threads"] | undefined) ?? {},
    seen: [],
  }),
  checkpointWhen: () => true,
});

export async function readFeishuState(
  harness: Harness,
  context: Context,
): Promise<FeishuStateValue> {
  const value = await harness.snapshot(FeishuStateDoc, context);
  return value === undefined
    ? { threads: {}, seen: [] }
    : { threads: value.threads ?? {}, seen: value.seen ?? [] };
}

/** true 表示第一次见到；false 表示重复投递，调用方应直接返回。 */
export async function markFeishuMessageSeen(
  harness: Harness,
  messageId: string,
  context: Context,
): Promise<boolean> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(FeishuStateDoc);
    doc.seen ??= [];
    if (doc.seen.includes(messageId)) return false;
    doc.seen.push(messageId);
    if (doc.seen.length > MAX_SEEN) doc.seen.splice(0, doc.seen.length - MAX_SEEN);
    return true;
  }, context);
}

export async function writeFeishuThread(
  harness: Harness,
  threadKey: string,
  state: FeishuThreadState,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(FeishuStateDoc);
    doc.threads[threadKey] = state;
  }, context);
}

/** 只前进，不后退；并发推送时以更大的 id 为准。 */
export async function advanceFeishuThread(
  harness: Harness,
  threadKey: string,
  entryId: number,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(FeishuStateDoc);
    const state = doc.threads[threadKey];
    if (state === undefined || state.lastEntryId >= entryId) return;
    state.lastEntryId = entryId;
    state.updatedAt = Date.now();
  }, context);
}

/** 交付适配器用它判断某个 conversation 是不是飞书线程。 */
export async function feishuTargetForConversation(
  harness: Harness,
  conversationId: string | number,
  context: Context,
): Promise<{ threadKey: string; chatId: string; rootMessageId: string } | undefined> {
  const state = await readFeishuState(harness, context);
  for (const [threadKey, record] of Object.entries(state.threads)) {
    if (String(record.conversationId) === String(conversationId)) {
      return { threadKey, chatId: record.chatId, rootMessageId: record.rootMessageId };
    }
  }
  return undefined;
}
