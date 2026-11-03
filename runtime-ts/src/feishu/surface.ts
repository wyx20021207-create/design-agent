/**
 * 飞书入口：长连接收事件，把消息投给 Pi，再把对话里的新回答推回同一个根消息。
 *
 * - 事件去重：event_id 作为 submit 的 requestId，飞书重推不会重复执行
 * - 线程状态：FeishuStateDoc 记住根消息和 lastEntryId，进程重启后接着推送
 * - 后台任务：RenderTask 的 task.report 也是对话条目，走同一个 watcher 发回群
 */
import * as lark from "@larksuiteoapi/node-sdk";

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationId,
  ConversationView,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";

import { TASK_REPORT_ENTRY } from "../harness/render-task.ts";
import type { Runtime } from "../harness/runtime.ts";
import { ThreadRegistry } from "../harness/thread-map.ts";
import { messageText } from "../text.ts";
import type { FeishuTransport } from "./client.ts";
import { parseEvent, type FeishuEvent } from "./events.ts";
import {
  advanceFeishuThread,
  readFeishuState,
  writeFeishuThread,
  type FeishuThreadState,
} from "./state.ts";

const RETRY_MS = 10_000;

export interface FeishuSurfaceOptions {
  runtime: Runtime;
  transport: FeishuTransport;
  appId: string;
  appSecret: string;
  encryptKey?: string;
  logger?: Pick<Console, "info" | "error">;
}

const postable = (entry: EntryRecord): boolean => {
  const role = entry.model?.[0]?.role;
  return role === "assistant" || entry.kind === TASK_REPORT_ENTRY;
};

export class FeishuSurface {
  readonly #runtime: Runtime;
  readonly #transport: FeishuTransport;
  readonly #registry: ThreadRegistry;
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #encryptKey: string | undefined;
  readonly #logger: Pick<Console, "info" | "error">;

  readonly #watchers = new Map<string, () => Promise<void>>();
  readonly #starting = new Map<string, Promise<void>>();
  #ws: lark.WSClient | undefined;
  #closed = false;

  constructor(options: FeishuSurfaceOptions) {
    this.#runtime = options.runtime;
    this.#transport = options.transport;
    this.#registry = new ThreadRegistry(options.runtime.harness, options.runtime.settings);
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#encryptKey = options.encryptKey;
    this.#logger = options.logger ?? console;
  }

  async start(): Promise<void> {
    // 先把上一次进程认识的所有飞书线程接回 watcher，后台任务在离线期间的回执也能补发。
    const state = await readFeishuState(this.#runtime.harness, ctx);
    for (const [threadKey, record] of Object.entries(state.threads)) {
      const conversation = await this.#runtime.harness.conversation(
        record.conversationId as ConversationId,
        ctx,
      );
      if (conversation !== undefined) this.#watch(threadKey, conversation, record);
    }

    const dispatcher = new lark.EventDispatcher({
      ...(this.#encryptKey === undefined ? {} : { encryptKey: this.#encryptKey }),
    }).register({
      "im.message.receive_v1": async (event) => {
        await this.#onEvent(event as unknown as FeishuEvent);
      },
    });

    this.#ws = new lark.WSClient({
      appId: this.#appId,
      appSecret: this.#appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      onReady: () => this.#logger.info("飞书长连接已就绪"),
      onError: (error) => this.#logger.error("飞书长连接错误", error),
    });
    await this.#ws.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.#closed = true;
    this.#ws?.close({ force: true });
    for (const stop of this.#watchers.values()) {
      try {
        await stop();
      } catch {
        // 关闭阶段的错误没有补救价值。
      }
    }
    this.#watchers.clear();
  }

  async #onEvent(event: FeishuEvent): Promise<void> {
    try {
      const parsed = parseEvent(event);
      if (parsed === undefined) {
        if (event.sender.sender_type === "app") return;
        if (["image", "file", "audio", "media", "sticker"].includes(event.message.message_type)) {
          await this.#transport.replyText(
            event.message.message_id,
            "现在只能处理文本消息，图片和文件支持还在做。",
            `da-unsupported-${event.message.message_id}`,
          );
        }
        return;
      }
      if (parsed.text.length === 0) return;

      const conversation = await this.#registry.resolve(
        parsed.threadKey,
        `feishu:${parsed.chatId}`,
        true,
      );
      if (conversation === undefined) return;

      const record = await this.#ensureThread(parsed.threadKey, parsed, conversation);
      this.#watch(parsed.threadKey, conversation, record);

      await conversation.submit(
        { type: "input", content: parsed.text, requestId: parsed.eventId },
        ctx,
      );
    } catch (error) {
      this.#logger.error("处理飞书事件失败", error);
      try {
        await this.#transport.replyText(
          event.message.message_id,
          "这条消息处理失败，请稍后再试。",
          `da-error-${event.message.message_id}`,
        );
      } catch {
        // 连错误通知都发不出去时只能放弃。
      }
    }
  }

  async #ensureThread(
    threadKey: string,
    parsed: NonNullable<ReturnType<typeof parseEvent>>,
    conversation: Conversation,
  ): Promise<FeishuThreadState> {
    const state = await readFeishuState(this.#runtime.harness, ctx);
    const existing = state.threads[threadKey];
    if (existing !== undefined) return existing;

    // 新线程从当前最新条目之后开始推送，避免把历史回答再发一遍。
    const tail = await conversation.entries({ order: "descending" }, 1, undefined, ctx);
    const record: FeishuThreadState = {
      conversationId: conversation.id,
      chatId: parsed.chatId,
      rootMessageId: parsed.replyTo,
      lastEntryId: tail.items[0]?.id ?? 0,
      updatedAt: Date.now(),
    };
    await writeFeishuThread(this.#runtime.harness, threadKey, record, ctx);
    return record;
  }

  #watch(threadKey: string, conversation: Conversation, record: FeishuThreadState): void {
    if (this.#closed || this.#watchers.has(threadKey) || this.#starting.has(threadKey)) return;

    const starting = this.#startWatch(threadKey, conversation, record)
      .catch((error) => {
        this.#logger.error(`飞书线程 ${threadKey} 的 watcher 启动失败`, error);
      })
      .finally(() => this.#starting.delete(threadKey));
    this.#starting.set(threadKey, starting);
  }

  async #startWatch(
    threadKey: string,
    conversation: Conversation,
    record: FeishuThreadState,
  ): Promise<void> {
    let last = record.lastEntryId;
    const watch = await conversation.watch(ctx, {
      ...(last > 0 ? { from: last as EntryId } : {}),
      min: 50,
      max: 200,
    });

    const send = async (view: ConversationView): Promise<void> => {
      if (this.#closed) return;
      const fresh = view.entries.filter((entry) => entry.id > last && postable(entry));
      for (const entry of fresh) {
        const text = messageText(entry.model?.[0]).trim();
        if (text.length > 0) {
          await this.#transport.replyText(record.rootMessageId, text, `da-${entry.id}`);
        }
        last = entry.id;
      }
      if (fresh.length > 0) {
        await advanceFeishuThread(this.#runtime.harness, threadKey, last, ctx);
      }
    };

    await send(watch.value);
    watch.start(async (call) => {
      if (call.kind !== "value") {
        this.#logger.error(`飞书线程 ${threadKey} 的 watcher 出错`, call.error);
        return;
      }
      try {
        await send(call.value);
      } catch (error) {
        this.#logger.error(`飞书线程 ${threadKey} 推送失败，稍后重试`, error);
        setTimeout(() => {
          if (!this.#closed) void send(watch.value).catch(() => undefined);
        }, RETRY_MS).unref();
      }
    });

    this.#watchers.set(threadKey, async () => {
      await watch.stop();
    });
  }
}
