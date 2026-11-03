/**
 * 常驻入口：HTTP API +（配置了飞书时）长连接。
 *
 *   DESIGN_AGENT_API_TOKENS="token:alice" npm run serve
 *
 * 默认监听 127.0.0.1:8787；用 DESIGN_AGENT_HOST / DESIGN_AGENT_PORT 覆盖。
 * 飞书凭据来自 .env 的 FEISHU_APP_ID / FEISHU_APP_SECRET；缺省则只开 HTTP。
 */
import { join } from "node:path";

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";

import { loadSettings } from "./config.ts";
import { LocalOutboxAdapter } from "./delivery/adapter.ts";
import { FeishuSdkTransport } from "./feishu/client.ts";
import { FeishuDeliveryAdapter } from "./feishu/delivery.ts";
import { FeishuSurface } from "./feishu/surface.ts";
import { openRuntime, type Runtime } from "./harness/runtime.ts";
import { createServer } from "./server.ts";

const settings = loadSettings();
const { appId, appSecret, encryptKey } = settings.feishu;
const local = new LocalOutboxAdapter(join(settings.dataDir, "outbox"));

const transport =
  appId !== undefined && appSecret !== undefined
    ? new FeishuSdkTransport(appId, appSecret)
    : undefined;

let harness: Harness | undefined;
const delivery =
  transport === undefined
    ? local
    : new FeishuDeliveryAdapter(
        () => {
          if (harness === undefined) throw new Error("Harness 尚未就绪");
          return harness;
        },
        transport,
        local,
      );

const runtime: Runtime = await openRuntime(settings, ctx, { delivery });
harness = runtime.harness;

const feishu =
  transport !== undefined && appId !== undefined && appSecret !== undefined
    ? new FeishuSurface({
        runtime,
        transport,
        appId,
        appSecret,
        ...(encryptKey === undefined ? {} : { encryptKey }),
      })
    : undefined;

const server = createServer(runtime);
if (feishu !== undefined) await feishu.start();

const host = process.env["DESIGN_AGENT_HOST"] ?? "127.0.0.1";
const port = Number(process.env["DESIGN_AGENT_PORT"] ?? "8787");
await server.listen({ host, port });
console.log(`design-agent listening on http://${host}:${port}`);
if (feishu !== undefined) console.log("飞书长连接已启动");

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal}: shutting down`);
  await feishu?.stop();
  await server.close();
  await runtime.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
