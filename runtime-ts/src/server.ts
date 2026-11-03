/**
 * 入口层：一个常驻进程运行 Harness，并暴露 HTTP 接口。
 *
 *   POST /threads/:id/messages   投递一条消息；requestId 相同的请求只执行一次
 *   GET  /threads/:id/events     SSE：从 after 之后开始推送对话条目
 *   GET  /threads/:id            线程状态：是否还有后台任务、已交付的文件
 *   GET  /threads/:id/files/:n   下载 outbox 里的文件
 *   GET  /health                 无需鉴权
 *
 * 外部 thread id 与 Pi 的 conversation id 由 ThreadMapDoc 映射；线程归创建者所有。
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { join, posix } from "node:path";

import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type ConversationId,
  type ConversationView,
  type EntryId,
} from "@earendil-works/pi-durable";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { LocalOutboxAdapter } from "./delivery/adapter.ts";
import type { Runtime } from "./harness/runtime.ts";
import { ThreadRegistry } from "./harness/thread-map.ts";
import { messageText } from "./text.ts";

const THREAD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEFAULT_WAIT_MS = 120_000;
const PING_MS = 15_000;

export interface ServerOptions {
  /** `token:caller,token2:caller2`；缺省读 DESIGN_AGENT_API_TOKENS。 */
  readonly tokens?: string;
  /** POST /messages 等待首轮回答的上限；超时返回 timedOut=true，run 继续。 */
  readonly waitTimeoutMs?: number;
}

export function parseTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const item of (raw ?? "").split(",")) {
    const separator = item.indexOf(":");
    if (separator <= 0 || separator === item.length - 1) continue;
    tokens.set(item.slice(0, separator), item.slice(separator + 1));
  }
  if (tokens.size === 0) {
    throw new Error("DESIGN_AGENT_API_TOKENS 为空：服务拒绝在没有调用者的情况下启动");
  }
  return tokens;
}

function callerOf(request: FastifyRequest, tokens: Map<string, string>): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return undefined;
  const given = Buffer.from(header.slice(7).trim());
  if (given.length === 0) return undefined;

  for (const [known, caller] of tokens) {
    const expected = Buffer.from(known);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return caller;
  }
  return undefined;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
};

const mimeOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return (dot < 0 ? undefined : MIME[name.slice(dot).toLowerCase()]) ?? "application/octet-stream";
};

interface ThreadStatus {
  readonly working: boolean;
  readonly tasks: readonly {
    readonly id: number;
    readonly kind: string;
    readonly phase: string | null;
    readonly status: string;
  }[];
}

async function statusOf(runtime: Runtime, conversationId: ConversationId): Promise<ThreadStatus> {
  const inspection = await runtime.harness.inspect(ctx);
  const tasks = inspection.tasks
    .filter((task) => task.record.conversationId === conversationId)
    .map((task) => {
      const checkpoint = (task.record.state as { checkpoint?: { phase?: string } }).checkpoint;
      return {
        id: task.record.id,
        kind: task.record.kind,
        phase: checkpoint?.phase ?? null,
        status: task.state.kind,
      };
    });
  const pending = inspection.submissions.filter(
    (submission) =>
      submission.conversationId === conversationId &&
      (submission.status === "queued" || submission.status === "placed"),
  );
  return { working: tasks.length > 0 || pending.length > 0, tasks };
}

function filesIn(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => {
    try {
      return statSync(join(folder, name)).isFile();
    } catch {
      return false;
    }
  });
}

export function createServer(runtime: Runtime, options: ServerOptions = {}): FastifyInstance {
  const tokens = parseTokens(options.tokens ?? process.env["DESIGN_AGENT_API_TOKENS"]);
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_MS;
  const registry = new ThreadRegistry(runtime.harness, runtime.settings);
  const outbox = new LocalOutboxAdapter(join(runtime.settings.dataDir, "outbox"));
  const app = Fastify({ logger: false });

  const authorize = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
    const caller = callerOf(request, tokens);
    if (caller === undefined) reply.code(401).send({ error: "unauthorized" });
    return caller;
  };

  app.get("/health", async () => ({ ok: true }));

  app.post<{
    Params: { id: string };
    Body: { text: string; requestId?: string; wait?: boolean };
  }>(
    "/threads/:id/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1, maxLength: 20_000 },
            requestId: { type: "string", minLength: 1, maxLength: 200 },
            wait: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const caller = authorize(request, reply);
      if (caller === undefined) return reply;

      const threadId = request.params.id;
      if (!THREAD_ID.test(threadId)) return reply.code(404).send({ error: "no such thread" });

      const conversation = await registry.resolve(threadId, caller, true);
      if (conversation === undefined) return reply.code(404).send({ error: "no such thread" });

      const requestId = request.body.requestId ?? randomUUID();
      const submission = await conversation.submit(
        { type: "input", content: request.body.text, requestId },
        ctx,
      );

      let answer: string | null = null;
      let timedOut = false;
      if (request.body.wait !== false) {
        const timeout = AbortSignal.timeout(waitTimeoutMs);
        try {
          const settled = await submission.wait(withAbortSignal(timeout, ctx));
          if (settled.status === "done" && settled.type === "input") {
            const entry = await conversation.commit(
              (tx) => tx.entry(AssistantEntry, settled.answer),
              ctx,
            );
            answer = messageText(entry?.model?.[0]);
          }
        } catch (error) {
          // 超时只结束这次 HTTP 等待，提交和 run 都还在；客户端可以改看 /events。
          if (!timeout.aborted) throw error;
          timedOut = true;
        }
      }

      const status = await statusOf(runtime, conversation.id);
      return {
        threadId,
        conversationId: conversation.id,
        submissionId: submission.id,
        reply: answer,
        timedOut,
        ...status,
      };
    },
  );

  app.get<{ Params: { id: string } }>("/threads/:id", async (request, reply) => {
    const caller = authorize(request, reply);
    if (caller === undefined) return reply;

    const conversation = await registry.resolve(request.params.id, caller, false);
    if (conversation === undefined) return reply.code(404).send({ error: "no such thread" });

    const folder = outbox.folderFor(String(conversation.id));
    return {
      threadId: request.params.id,
      conversationId: conversation.id,
      files: filesIn(folder),
      ...(await statusOf(runtime, conversation.id)),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/threads/:id/events",
    async (request, reply) => {
      const caller = authorize(request, reply);
      if (caller === undefined) return reply;

      const conversation = await registry.resolve(request.params.id, caller, false);
      if (conversation === undefined) return reply.code(404).send({ error: "no such thread" });

      const parsed = Number(request.query.after ?? "0");
      const after = Number.isSafeInteger(parsed) && parsed > 0 ? (parsed as EntryId) : undefined;
      const watch = await conversation.watch(ctx, {
        ...(after === undefined ? {} : { from: after }),
        min: 100,
        max: 200,
      });

      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(": connected\n\n");

      let last = after ?? 0;
      let closed = false;
      const send = (view: ConversationView) => {
        for (const entry of view.entries) {
          if (entry.id <= last) continue;
          last = entry.id;
          const payload = {
            id: entry.id,
            kind: entry.kind,
            role: entry.model?.[0]?.role ?? null,
            text: messageText(entry.model?.[0]),
            data: entry.data ?? null,
          };
          response.write(`event: entry\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      };

      send(watch.value);
      watch.start(async (call) => {
        if (closed) return;
        if (call.kind === "value") send(call.value);
        else response.write(`event: error\ndata: ${JSON.stringify({ message: "stream failed" })}\n\n`);
      });

      const ping = setInterval(() => {
        if (!closed) response.write(": ping\n\n");
      }, PING_MS);

      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        void watch.stop();
        response.end();
      };
      response.on("close", stop);
      request.raw.on("close", stop);
      return reply;
    },
  );

  app.get<{ Params: { id: string; name: string } }>(
    "/threads/:id/files/:name",
    async (request, reply) => {
      const caller = authorize(request, reply);
      if (caller === undefined) return reply;

      const conversation = await registry.resolve(request.params.id, caller, false);
      if (conversation === undefined) return reply.code(404).send({ error: "no such thread" });

      const name = request.params.name;
      if (
        name === "." ||
        name === ".." ||
        name !== posix.basename(name) ||
        name.includes("\\") ||
        name.startsWith(".")
      ) {
        return reply.code(404).send({ error: "no such file" });
      }

      const file = join(outbox.folderFor(String(conversation.id)), name);
      if (!existsSync(file) || !statSync(file).isFile()) {
        return reply.code(404).send({ error: "no such file" });
      }
      return reply.type(mimeOf(name)).send(createReadStream(file));
    },
  );

  return app;
}
