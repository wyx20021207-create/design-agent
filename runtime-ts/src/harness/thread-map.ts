/**
 * 外部线程 id → Pi conversation id 的映射。
 *
 * 飞书 / Slack 的 thread_ts 或 API 的 thread_id 不是数字，而 Pi 的 ConversationId 是数据库
 * 分配的数字。映射存成 Session 级文档，线程归最先创建它的 caller 所有。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";

import type { Settings } from "../config.ts";

export type ThreadRecord = {
  conversationId: number;
  owner: string;
  createdAt: number;
};

export type ThreadMapValue = {
  threads: Record<string, ThreadRecord>;
};

export const ThreadMapDoc = defineDoc({
  kind: "design.threads",
  version: 1,
  scope: "session",
  initial: (): ThreadMapValue => ({ threads: {} }),
  checkpointWhen: () => true,
});

export class ThreadRegistry {
  /** 同一进程内串行化首次创建，避免并发首条消息建出两条对话。 */
  readonly #creating = new Map<string, Promise<Conversation | undefined>>();

  constructor(
    private readonly harness: Harness,
    private readonly settings: Settings,
    private readonly context: Context = BACKGROUND_CONTEXT,
  ) {}

  /** `create: false` 用于查询；所有权不符或不存在都返回 undefined。 */
  async resolve(
    threadId: string,
    caller: string,
    create: boolean,
  ): Promise<Conversation | undefined> {
    const existing = await this.#lookup(threadId);
    if (existing !== undefined) {
      return existing.owner === caller ? this.#conversation(existing.conversationId) : undefined;
    }
    if (!create) return undefined;

    const key = `${caller}\0${threadId}`;
    const pending = this.#creating.get(key);
    if (pending !== undefined) return pending;

    const creating = this.#create(threadId, caller).finally(() => this.#creating.delete(key));
    this.#creating.set(key, creating);
    return creating;
  }

  async #lookup(threadId: string): Promise<ThreadRecord | undefined> {
    const map = await this.harness.snapshot(ThreadMapDoc, this.context);
    return map?.threads[threadId];
  }

  async #conversation(id: number): Promise<Conversation | undefined> {
    return this.harness.conversation(id as ConversationId, this.context);
  }

  async #create(threadId: string, caller: string): Promise<Conversation | undefined> {
    const conversation = await this.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: this.settings.model } },
      this.context,
    );

    await this.harness.commit(async (tx) => {
      const map = await tx.doc(ThreadMapDoc);
      if (map.threads[threadId] !== undefined) return;
      map.threads[threadId] = {
        conversationId: conversation.id,
        owner: caller,
        createdAt: Date.now(),
      };
    }, this.context);

    // 另一个进程可能同时创建了；以先写进映射的为准。
    const winner = await this.#lookup(threadId);
    if (winner === undefined) return conversation;
    if (winner.owner !== caller) return undefined;
    return this.#conversation(winner.conversationId);
  }
}
