/**
 * 入口层检查：
 *
 *   鉴权 → 线程映射 → 消息去重 → SSE 回放 → 文件下载 → 所有权隔离
 *
 *   npm run api
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSettings } from "../src/config.ts";
import { LocalOutboxAdapter } from "../src/delivery/adapter.ts";
import { openRuntime } from "../src/harness/runtime.ts";
import { createServer } from "../src/server.ts";

const TOKENS = "token-alice:alice,token-bob:bob";
const THREAD = `api-${Date.now().toString(36)}`;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const settings = loadSettings();
const runtime = await openRuntime(settings);
const server = createServer(runtime, { tokens: TOKENS, waitTimeoutMs: 180_000 });

await server.listen({ host: "127.0.0.1", port: 0 });
const address = server.server.address();
check(address !== null && typeof address === "object", "服务器没有监听地址");
const base = `http://127.0.0.1:${address.port}`;

const call = (path: string, init: RequestInit = {}, token = "token-alice") =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

try {
  const health = await fetch(`${base}/health`);
  check(health.status === 200, `health 应返回 200，实际 ${health.status}`);
  console.log("health：200");

  const unauthorized = await fetch(`${base}/threads/${THREAD}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  check(unauthorized.status === 401, `无 token 应返回 401，实际 ${unauthorized.status}`);
  console.log("鉴权：无 token → 401");

  const prompt = "只回复两个字：OK。不要调用任何工具，不要解释。";
  const first = await call(`/threads/${THREAD}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: prompt, requestId: "req-1" }),
  });
  check(first.status === 200, `第一次消息应返回 200，实际 ${first.status}`);
  const firstBody = (await first.json()) as {
    reply: string | null;
    submissionId: number;
    conversationId: number;
    working: boolean;
  };
  check((firstBody.reply ?? "").includes("OK"), `回答里没有 OK：${firstBody.reply}`);
  check(firstBody.working === false, "首轮结束后不应还有后台任务");
  console.log(`消息：reply=${JSON.stringify(firstBody.reply)} submission=${firstBody.submissionId}`);

  const duplicate = await call(`/threads/${THREAD}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "这条重复请求不应该执行", requestId: "req-1" }),
  });
  const duplicateBody = (await duplicate.json()) as { reply: string | null; submissionId: number };
  check(duplicateBody.submissionId === firstBody.submissionId, "同一个 requestId 产生了新的提交");
  check((duplicateBody.reply ?? "").includes("OK"), "重复请求没有返回第一次的回答");
  console.log(`去重：requestId=req-1 → 同一个提交 ${duplicateBody.submissionId}`);

  const foreign = await call(`/threads/${THREAD}`, {}, "token-bob");
  check(foreign.status === 404, `其他 caller 应得到 404，实际 ${foreign.status}`);
  console.log("所有权：另一个 caller → 404");

  const status = await call(`/threads/${THREAD}`);
  check(status.status === 200, `线程状态应返回 200，实际 ${status.status}`);
  const statusBody = (await status.json()) as { working: boolean; files: string[] };
  check(statusBody.working === false, "线程应该已空闲");
  console.log(`线程状态：working=${statusBody.working} files=${JSON.stringify(statusBody.files)}`);

  // SSE：从 0 开始回放，应该能看到第一轮的回答。
  const controller = new AbortController();
  const events = await call(`/threads/${THREAD}/events?after=0`, { signal: controller.signal });
  check(events.status === 200, `SSE 应返回 200，实际 ${events.status}`);
  check(
    (events.headers.get("content-type") ?? "").startsWith("text/event-stream"),
    "SSE Content-Type 不对",
  );

  const reader = events.body?.getReader();
  check(reader !== undefined, "SSE 没有响应体");
  const decoder = new TextDecoder();
  let buffer = "";
  let assistant = "";
  const deadline = Date.now() + 30_000;
  while (assistant.length === 0) {
    if (Date.now() > deadline) throw new Error("SSE 等待回答超时");
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (data.length === 0) continue;
      const event = JSON.parse(data) as { role?: string; text?: string };
      if (event.role === "assistant" && (event.text ?? "").includes("OK")) assistant = event.text ?? "";
    }
  }
  controller.abort();
  check(assistant.includes("OK"), "SSE 没有回放到模型回答");
  console.log(`SSE：${JSON.stringify(assistant.slice(0, 60))}`);

  // 文件下载：直接放进 outbox，再通过 HTTP 取回。
  const outbox = new LocalOutboxAdapter(join(settings.dataDir, "outbox"));
  const folder = outbox.folderFor(String(firstBody.conversationId));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "hello.txt"), "hello\n", "utf8");

  const file = await call(`/threads/${THREAD}/files/hello.txt`);
  check(file.status === 200, `文件下载应返回 200，实际 ${file.status}`);
  check((await file.text()) === "hello\n", "文件内容不对");
  console.log("文件下载：hello.txt = hello");

  const hidden = await call(`/threads/${THREAD}/files/.secret`);
  check(hidden.status === 404, `隐藏文件应返回 404，实际 ${hidden.status}`);

  console.log("\nPASS 入口层：鉴权 → 去重 → SSE → 文件下载 → 所有权");
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await server.close();
  await runtime.close();
}
