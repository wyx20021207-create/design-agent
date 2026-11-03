/** 临时排查：列出群里最近的消息及其 root/thread 关系。 */
import * as lark from "@larksuiteoapi/node-sdk";

import { loadSettings } from "../src/config.ts";

const settings = loadSettings();
const { appId, appSecret } = settings.feishu;
if (appId === undefined || appSecret === undefined) {
  console.error("缺少凭据");
  process.exit(1);
}

const chatId = process.argv[2] ?? "oc_73093a0d27157b194e9fe89ed5b75bb6";
const client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn });
const response = await client.im.v1.message.list({
  params: {
    container_id_type: "chat",
    container_id: chatId,
    sort_type: "ByCreateTimeDesc",
    page_size: 20,
  },
});

for (const message of response.data?.items ?? []) {
  console.log(
    [
      message.message_id,
      message.create_time === undefined
        ? "-"
        : new Date(Number(message.create_time)).toLocaleString("zh-CN"),
      message.msg_type,
      `root=${message.root_id ?? "-"}`,
      `parent=${message.parent_id ?? "-"}`,
      `thread=${message.thread_id ?? "-"}`,
      `sender=${message.sender?.id ?? "-"}`,
      String(message.body?.content ?? "").slice(0, 140),
    ].join("  "),
  );
}
