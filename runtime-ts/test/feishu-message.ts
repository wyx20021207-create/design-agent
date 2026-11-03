/** 临时排查：按 message_id 查消息的创建时间、发送者和线程关系。 */
import * as lark from "@larksuiteoapi/node-sdk";

import { loadSettings } from "../src/config.ts";

const settings = loadSettings();
const { appId, appSecret } = settings.feishu;
if (appId === undefined || appSecret === undefined) {
  console.error("缺少凭据");
  process.exit(1);
}

const ids = process.argv.slice(2);
const client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn });

for (const id of ids) {
  try {
    const response = await client.im.v1.message.get({
      path: { message_id: id },
      params: { user_id_type: "open_id" },
    });
    const message = response.data?.items?.[0];
    if (message === undefined) {
      console.log(id, "-> 没有返回消息");
      continue;
    }
    console.log(
      [
        id,
        new Date(Number(message.create_time)).toLocaleString("zh-CN"),
        `type=${message.msg_type}`,
        `sender=${message.sender?.id ?? "-"}`,
        `chat=${message.chat_id ?? "-"}`,
        `root=${message.root_id ?? "-"}`,
        `parent=${message.parent_id ?? "-"}`,
        `thread=${message.thread_id ?? "-"}`,
        `deleted=${String(message.deleted)}`,
        String(message.body?.content ?? "").slice(0, 160),
      ].join("  "),
    );
  } catch (error) {
    const data = (error as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
    console.log(id, "-> 查询失败", data?.code ?? "?", data?.msg ?? String(error));
  }
}
