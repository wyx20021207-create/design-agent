/**
 * 常驻入口：
 *
 *   DESIGN_AGENT_API_TOKENS="token:alice" npm run serve
 *
 * 默认监听 127.0.0.1:8787；用 DESIGN_AGENT_HOST / DESIGN_AGENT_PORT 覆盖。
 */
import { loadSettings } from "./config.ts";
import { openRuntime } from "./harness/runtime.ts";
import { createServer } from "./server.ts";

const settings = loadSettings();
const runtime = await openRuntime(settings);
const server = createServer(runtime);

const host = process.env["DESIGN_AGENT_HOST"] ?? "127.0.0.1";
const port = Number(process.env["DESIGN_AGENT_PORT"] ?? "8787");
await server.listen({ host, port });
console.log(`design-agent listening on http://${host}:${port}`);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal}: shutting down`);
  await server.close();
  await runtime.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
