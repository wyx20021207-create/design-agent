/** 验证飞书应用凭据：拿 tenant token 并列出机器人所在的群。 */
import * as lark from "@larksuiteoapi/node-sdk";

import { loadSettings } from "../src/config.ts";

const settings = loadSettings();
const { appId, appSecret } = settings.feishu;
if (appId === undefined || appSecret === undefined) {
  console.error("缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET");
  process.exit(1);
}

const client = new lark.Client({ appId, appSecret });
try {
  const response = await client.im.v1.chat.list({ params: { page_size: 20 } });
  console.log(`凭据 OK：code=${response.code} 群数量=${response.data?.items?.length ?? 0}`);
  for (const chat of response.data?.items ?? []) {
    console.log(`  ${chat.chat_id}  ${chat.name ?? "(未命名)"}`);
  }
} catch (error) {
  const data = (
    error as { response?: { data?: { code?: number; msg?: string } } }
  ).response?.data;
  console.error(
    "凭据或权限有问题：",
    data?.code ?? "?",
    data?.msg ?? (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
}
