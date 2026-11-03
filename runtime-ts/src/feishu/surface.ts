/**
 * 飞书入口：长连接收事件，把消息投给 Pi，再把对话里的新回答推回同一个根消息。
 *
 * - 事件去重：event_id 作为 submit 的 requestId，飞书重推不会重复执行
 * - 线程状态：FeishuStateDoc 记住根消息和 lastEntryId，进程重启后接着推送
 * - 后台任务：RenderTask 的 task.report 也是对话条目，走同一个 watcher 发回群
 */
import * as lark from "@larksuiteoapi/node-sdk";

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";

import { TASK_REPORT_ENTRY } from "../harness/render-task.ts";
import type { Runtime } from "../harness/runtime.ts";
import { ThreadRegistry } from "../harness/thread-map.ts";
import { messageText } from "../text.ts";
import { downloadAttachments } from "./attachments.ts";
import type { FeishuTransport } from "./client.ts";
import { parseEvent, type FeishuEvent } from "./events.ts";
import { progressLine } from "./progress.ts";
import {
  advanceFeishuThread,
  markFeishuMessageSeen,
  readFeishuState,
  writeFeishuThread,
  type FeishuThreadState,
} from "./state.ts";

const RETRY_MS = 10_000;
/** 飞书补投可能延迟很久；超过这个时间的消息不再执行，避免一小时前的指令突然跑起来。 */
const STALE_MS = 5 * 60 * 1_000;
/** 进度推送间隔；调试时可以调小。 */
const PROGRESS_MS = (() => {
  const value = Number(process.env["DESIGN_AGENT_PROGRESS_MS"] ?? "120000");
  return Number.isFinite(value) && value >= 5_000 ? value : 120_000;
})();

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
  /** 每个线程一条进度定时器；空闲时自动停。 */
  readonly #progress = new Map<string, NodeJS.Timeout>();
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
    const inspection = await this.#runtime.harness.inspect(ctx);
    for (const [threadKey, record] of Object.entries(state.threads)) {
      const conversation = await this.#runtime.harness.conversation(
        record.conversationId as ConversationId,
        ctx,
      );
      if (conversation === undefined) continue;
      this.#watch(threadKey, conversation, record);
      if (inspection.tasks.some((task) => task.record.conversationId === conversation.id)) {
        this.#startProgress(threadKey, conversation.id, record.rootMessageId);
      }
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
    for (const timer of this.#progress.values()) clearInterval(timer);
    this.#progress.clear();
    for (const stop of this.#watchers.values()) {
      try {
        await stop();
      } catch {
        // 关闭阶段的错误没有补救价值。
      }
    }
    this.#watchers.clear();
  }

  /** 每两分钟看一次：还有活任务就回一句进度，空了就停。 */
  #startProgress(threadKey: string, conversationId: ConversationId, rootMessageId: string): void {
    if (this.#closed || this.#progress.has(threadKey)) return;
    const timer = setInterval(() => {
      void this.#postProgress(threadKey, conversationId, rootMessageId);
    }, PROGRESS_MS);
    timer.unref();
    this.#progress.set(threadKey, timer);
  }

  #stopProgress(threadKey: string): void {
    const timer = this.#progress.get(threadKey);
    if (timer !== undefined) {
      clearInterval(timer);
      this.#progress.delete(threadKey);
    }
  }

  async #postProgress(
    threadKey: string,
    conversationId: ConversationId,
    rootMessageId: string,
  ): Promise<void> {
    if (this.#closed) return;
    try {
      const inspection = await this.#runtime.harness.inspect(ctx);
      const tasks = inspection.tasks.filter(
        (task) => task.record.conversationId === conversationId,
      );
      if (tasks.length === 0) {
        this.#stopProgress(threadKey);
        return;
      }

      const startedAt = Math.min(...tasks.map((task) => task.record.startedAt ?? Date.now()));
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
      const live = await this.#runtime.harness.snapshot(LiveDoc, conversationId, ctx);
      const line = progressLine(live, tasks.map((task) => task.record.kind), elapsed);
      await this.#transport.replyText(rootMessageId, line, `da-progress-${conversationId}-${elapsed}`);
    } catch (error) {
      this.#logger.error("飞书进度推送失败", error);
    }
  }

  async #onEvent(event: FeishuEvent): Promise<void> {
    try {
      const parsed = parseEvent(event);
      if (parsed === undefined) {
        this.#logger.info(
          `飞书事件 ${event.event_id ?? "-"} 类型=${event.message.message_type} 未处理`,
        );
        if (event.sender.sender_type === "app") return;
        if (["sticker", "share_chat", "share_user"].includes(event.message.message_type)) {
          await this.#transport.replyText(
            event.message.message_id,
            "这个类型的消息还处理不了；目前支持文本、图片和文件。",
            `da-unsupported-${event.message.message_id}`,
          );
        }
        return;
      }

      this.#logger.info(
        `飞书事件 ${parsed.eventId} msg=${parsed.messageId} ${parsed.chatType} ` +
          `root=${parsed.replyTo} text=${JSON.stringify(parsed.text.slice(0, 80))} ` +
          `attachments=${parsed.attachments.length}`,
      );

      if (parsed.text.length === 0 && parsed.attachments.length === 0) return;

      const state = await readFeishuState(this.#runtime.harness, ctx);
      if (state.seen.includes(parsed.messageId)) {
        this.#logger.info(`重复消息 ${parsed.messageId}，忽略`);
        return;
      }

      const age = Date.now() - parsed.createdAt;
      if (Number.isFinite(age) && age > STALE_MS) {
        const minutes = Math.round(age / 60_000);
        this.#logger.info(`跳过过期消息 ${parsed.messageId}，延迟 ${minutes} 分钟`);
        await this.#transport.replyText(
          parsed.replyTo,
          `这条消息是 ${minutes} 分钟前发的，已跳过；需要的话请重新发送。`,
          `da-stale-${parsed.messageId}`,
        );
        await markFeishuMessageSeen(this.#runtime.harness, parsed.messageId, ctx);
        return;
      }

      const conversation = await this.#registry.resolve(
        parsed.threadKey,
        `feishu:${parsed.chatId}`,
        true,
      );
      if (conversation === undefined) return;

      const record = await this.#ensureThread(parsed.threadKey, parsed, conversation);
      this.#watch(parsed.threadKey, conversation, record);
      this.#startProgress(parsed.threadKey, conversation.id, record.rootMessageId);

      // 先回执，再下载附件、跑模型；长任务期间用户不会觉得消息丢了。
      const pending = parsed.attachments.length > 0 ? `，收到 ${parsed.attachments.length} 个附件` : "";
      const busy = (await this.#runtime.harness.inspect(ctx)).tasks.some(
        (task) => task.record.conversationId === conversation.id,
      );
      await this.#transport.replyText(
        parsed.replyTo,
        busy ? `已收到${pending}，转给正在运行的任务……` : `已收到${pending}。开始处理……`,
        `da-ack-${parsed.messageId}`,
      );

      let attachments: readonly string[] = [];
      let failed: readonly string[] = [];
      if (parsed.attachments.length > 0) {
        const env = await this.#runtime.env(conversation.id);
        const downloaded = await downloadAttachments(this.#transport, parsed.attachments, env, ctx);
        attachments = downloaded.paths;
        failed = downloaded.failed;
      }

      const blocks: string[] = [];
      if (parsed.text.trim().length > 0) blocks.push(parsed.text.trim());
      if (attachments.length > 0) {
        blocks.push(`[附件]\n${attachments.map((path) => `- ${path}`).join("\n")}`);
      }
      if (failed.length > 0) {
        blocks.push(`[附件未能读取] ${failed.join(", ")}`);
      }
      const content = blocks.join("\n\n").trim();
      if (content.length === 0) return;

      await conversation.submit(
        { type: "input", content, requestId: parsed.messageId, whenBusy: "steer" },
        ctx,
      );
      await markFeishuMessageSeen(this.#runtime.harness, parsed.messageId, ctx);
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
          const markdown = entry.kind === TASK_REPORT_ENTRY ? `**任务回执**\n\n${text}` : text;
          await this.#transport.replyMarkdown(record.rootMessageId, markdown, `da-${entry.id}`);
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
