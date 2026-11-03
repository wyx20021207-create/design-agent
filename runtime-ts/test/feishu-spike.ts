/**
 * 长连接最小验证：收到群里的 @ 消息并回复。
 * 只用来确认事件订阅、权限和消息格式；正式适配器在 src/feishu/。
 *
 *   npx tsx test/feishu-spike.ts
 */
import * as lark from "@larksuiteoapi/node-sdk";

import { loadSettings } from "../src/config.ts";

const settings = loadSettings();
const { appId, appSecret, encryptKey } = settings.feishu;
if (appId === undefined || appSecret === undefined) {
  console.error("缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET");
  process.exit(1);
}

const client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn });

const stripMentions = (text: string, mentions: readonly { key: string }[]): string => {
  let result = text;
  for (const mention of mentions) result = result.split(mention.key).join("");
  return result.trim();
};

const dispatcher = new lark.EventDispatcher({
  ...(encryptKey === undefined ? {} : { encryptKey }),
}).register({
  "im.message.receive_v1": async (event) => {
    const { message, sender } = event;
    const parsed = JSON.parse(message.content) as { text?: string };
    const text = stripMentions(parsed.text ?? "", message.mentions ?? []);

    console.log(
      [
        `EVENT event_id=${event.event_id ?? "-"}`,
        `chat_type=${message.chat_type}`,
        `msg_type=${message.message_type}`,
        `chat=${message.chat_id}`,
        `message=${message.message_id}`,
        `root=${message.root_id ?? "-"}`,
        `thread=${message.thread_id ?? "-"}`,
        `sender=${sender.sender_id?.open_id ?? sender.sender_type}`,
        `text=${JSON.stringify(text)}`,
      ].join(" "),
    );

    if (sender.sender_type === "app") return;
    const reply = await client.im.v1.message.reply({
      path: { message_id: message.message_id },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: `收到：${text || "(空)"}` }),
      },
    });
    console.log(`REPLY code=${reply.code} message=${reply.data?.message_id ?? "-"}`);
  },
});

const ws = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: lark.LoggerLevel.warn,
  onReady: () => console.log("WS READY"),
  onError: (error) => console.error("WS ERROR", error),
});

await ws.start({ eventDispatcher: dispatcher });
console.log("LISTENING 在群里 @Design Agent 发一句话");

setTimeout(() => {
  console.log("TIMEUP");
  ws.close({ force: true });
  process.exit(0);
}, 180_000);
