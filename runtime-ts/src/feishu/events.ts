/**
 * 飞书消息事件 → 内部结构。
 *
 * 只做解析和键的推导，不碰网络，便于用真实事件做单元测试。
 * 线程键与 Slack 版语义一致：顶层消息自成一个线程，回复共享根消息。
 */

export interface FeishuMention {
  key: string;
  name: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
}

export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  chat_id: string;
  chat_type: string;
  message_type: string;
  content: string;
  mentions?: FeishuMention[];
}

export interface FeishuEvent {
  event_id?: string;
  sender: {
    sender_type: string;
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
  };
  message: FeishuMessage;
}

export type ParsedMessage = {
  readonly eventId: string;
  readonly messageId: string;
  /** 回复时使用的消息 id：线程根消息，顶层消息就是它自己。 */
  readonly replyTo: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly senderOpenId: string;
  readonly threadKey: string;
  readonly text: string;
  readonly mentionKeys: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** 文本消息直接取 text；富文本把每行的 text 拼起来。 */
function textOf(message: FeishuMessage): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  if (message.message_type === "text") {
    return typeof parsed["text"] === "string" ? parsed["text"] : undefined;
  }

  if (message.message_type === "post") {
    const title = typeof parsed["title"] === "string" ? parsed["title"] : "";
    const content = parsed["content"];
    if (!Array.isArray(content)) return title;
    const lines: string[] = [];
    for (const row of content) {
      if (!Array.isArray(row)) continue;
      const line = row
        .map((element) => {
          if (!isRecord(element)) return "";
          return element["tag"] === "text" || element["tag"] === "a"
            ? String(element["text"] ?? "")
            : "";
        })
        .join("");
      if (line.length > 0) lines.push(line);
    }
    return [title, ...lines].filter((line) => line.length > 0).join("\n");
  }

  return undefined;
}

/** 群聊里 @ 会以 `@_user_1` 这样的占位符出现在正文里。 */
function stripMentions(text: string, mentions: readonly FeishuMention[]): string {
  let result = text;
  for (const mention of mentions) result = result.split(mention.key).join("");
  return result.replace(/[ \t]+\n/g, "\n").trim();
}

export function threadKeyOf(message: FeishuMessage): string {
  if (message.chat_type === "p2p") return `feishu-p2p-${message.chat_id}`;
  if (message.thread_id !== undefined && message.thread_id.length > 0) {
    return `feishu-${message.chat_id}-thread-${message.thread_id}`;
  }
  // 顶层消息用它自己的 id 当根；回复的 root_id 也是它，两条消息因此落在同一个线程。
  const root =
    message.root_id !== undefined && message.root_id.length > 0
      ? message.root_id
      : message.message_id;
  return `feishu-${message.chat_id}-root-${root}`;
}

/** 机器人自己的消息、无法解析的内容返回 undefined。 */
export function parseEvent(event: FeishuEvent): ParsedMessage | undefined {
  if (event.sender.sender_type === "app") return undefined;
  const text = textOf(event.message);
  if (text === undefined) return undefined;

  const mentions = event.message.mentions ?? [];
  return {
    eventId: event.event_id ?? event.message.message_id,
    messageId: event.message.message_id,
    replyTo: event.message.root_id ?? event.message.message_id,
    chatId: event.message.chat_id,
    chatType: event.message.chat_type,
    senderOpenId: event.sender.sender_id?.open_id ?? "unknown",
    threadKey: threadKeyOf(event.message),
    text: stripMentions(text, mentions),
    mentionKeys: mentions.map((mention) => mention.key),
  };
}
