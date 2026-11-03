/**
 * 容器内的执行环境服务。
 *
 * 用官方 NodeExecutionEnv 实现全部文件与 shell 操作，通过 stdin/stdout 上的
 * 换行分隔 JSON（NDJSON）接受宿主机调用。容器内没有模型、密钥或网络依赖。
 *
 * 用法：node pi-env-server.mjs [cwd]      cwd 默认 /workspace
 *
 * 协议：
 *   请求   {"id":1,"method":"readTextFile","params":["/workspace/a.txt"]}
 *   响应   {"id":1,"ok":true,"value":"..."}
 *          {"id":1,"ok":false,"error":{"code":"not_found","message":"..."}}
 *
 *   句柄   open* / watch 返回 {"__handle":"h1", ...}；后续用
 *          handle.readLine / handle.read / handle.info / handle.scanLines /
 *          handle.next / handle.stop / handle.close，第一个参数是句柄 id
 *
 *   exec   先发 {"id":1,"event":"output","text":"...","stream":"stdout"}
 *          最后 {"id":1,"ok":true,"value":{"exitCode":0}}
 *
 *   watch  先发 {"id":2,"ok":true,"value":{"__handle":"h2","mode":"native"}}
 *          之后 {"id":2,"event":"change","change":{...}}
 */
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const cwd = process.argv[2] ?? "/workspace";
const env = new NodeExecutionEnv({ cwd });
const ctx = BACKGROUND_CONTEXT;

/** 正在跑的 exec，按请求 id 存放；宿主机发 abort 时用。 */
const execControllers = new Map();

const handles = new Map();
let nextHandle = 1;

const keep = (value) => {
  const id = `h${nextHandle++}`;
  handles.set(id, value);
  return id;
};

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const describeError = (error) => ({
  code: typeof error?.code === "string" ? error.code : "unknown",
  message: error?.message ?? String(error),
  ...(error?.path ? { path: error.path } : {}),
});

/** Uint8Array 不能直接 JSON 化，转 base64 并打标记。 */
const encode = (value) => {
  if (value instanceof Uint8Array) {
    return { __bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.map(encode);
  }
  return value;
};

const decode = (value) => {
  if (value !== null && typeof value === "object" && "__bytes" in value) {
    return new Uint8Array(Buffer.from(value.__bytes, "base64"));
  }
  return value;
};

/** Result 型返回值统一出口。 */
const reply = (id, result) => {
  if (result !== null && typeof result === "object" && "ok" in result) {
    if (result.ok) {
      send({ id, ok: true, value: encode(result.value) });
    } else {
      send({ id, ok: false, error: describeError(result.error) });
    }
    return;
  }
  send({ id, ok: true, value: encode(result) });
};

async function runExec(id, [command, options]) {
  const forwarded = { ...(options ?? {}) };
  delete forwarded.onOutput;

  const controller = new AbortController();
  execControllers.set(id, controller);
  const callContext = withAbortSignal(controller.signal, ctx);

  try {
    const result = await env.exec(
      command,
      {
        ...forwarded,
        onOutput: (text, _context, info) => {
          send({ id, event: "output", text, stream: info.stream });
        },
      },
      callContext,
    );

    if (result.ok) {
      send({ id, ok: true, value: result.value });
    } else {
      send({ id, ok: false, error: describeError(result.error) });
    }
  } finally {
    execControllers.delete(id);
  }
}

async function openWatch(id, [targets]) {
  const result = await env.watch(
    targets,
    (change) => {
      const payload =
        change.kind === "failed"
          ? { kind: "failed", error: describeError(change.error) }
          : change;
      send({ id, event: "change", change: payload });
    },
    ctx,
  );

  if (!result.ok) {
    send({ id, ok: false, error: describeError(result.error) });
    return;
  }

  const handle = keep(result.value);
  send({ id, ok: true, value: { __handle: handle, mode: result.value.mode } });
}

/** 句柄方法：handle.<op>(handleId, ...args) */
async function runHandle(id, method, params) {
  const [handleId, ...args] = params;
  const target = handles.get(handleId);
  if (target === undefined) {
    // 官方语义：句柄关闭后再用是 invalid，不是 not_found。
    send({ id, ok: false, error: { code: "invalid", message: `unknown handle ${handleId}` } });
    return;
  }

  const operation = method.slice("handle.".length);
  if (operation === "close" || operation === "stop") {
    const result = await target[operation](ctx);
    handles.delete(handleId);
    reply(id, result);
    return;
  }

  const result = await target[operation](...args, ctx);
  reply(id, result);
}

const ALLOWED = new Set([
  "absolutePath",
  "joinPath",
  "canonicalPath",
  "exists",
  "fileInfo",
  "listDir",
  "readTextFile",
  "readTextLines",
  "readBinaryFile",
  "writeFile",
  "appendFile",
  "truncateFile",
  "flushFile",
  "renameFile",
  "remove",
  "createDir",
  "createTempDir",
  "createTempFile",
  "openTextLineReader",
  "openBinaryReader",
  "openDirReader",
]);

const OPENERS = new Set(["openTextLineReader", "openBinaryReader", "openDirReader"]);

async function handle(request) {
  const { id, method, params = [] } = request;

  if (typeof method !== "string" || !Array.isArray(params)) {
    send({ id, ok: false, error: { code: "invalid", message: "bad request" } });
    return;
  }

  if (method === "exec") return runExec(id, params);
  if (method === "abort") {
    // 不收 id 的响应：宿主机已经放弃这次调用。
    const [targetId] = params;
    execControllers.get(targetId)?.abort();
    return;
  }
  if (method === "watch") return openWatch(id, params);
  if (method === "cleanup") {
    await env.cleanup(ctx);
    send({ id, ok: true });
    return;
  }
  if (method.startsWith("handle.")) return runHandle(id, method, params);

  if (!ALLOWED.has(method)) {
    send({ id, ok: false, error: { code: "not_supported", message: method } });
    return;
  }

  const fn = env[method];
  if (typeof fn !== "function") {
    send({ id, ok: false, error: { code: "not_supported", message: method } });
    return;
  }

  const args = decodeArgs(params);
  const result = await fn.apply(env, [...args, ctx]);

  if (OPENERS.has(method)) {
    if (!result.ok) {
      send({ id, ok: false, error: describeError(result.error) });
      return;
    }
    const handle = keep(result.value);
    send({ id, ok: true, value: { __handle: handle } });
    return;
  }

  reply(id, result);
}

/** 参数里的二进制以 {"__bytes": base64} 传入，还原成 Uint8Array。 */
function decodeArgs(params) {
  return params.map(decode);
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;

  let request;
  try {
    request = JSON.parse(text);
  } catch {
    send({ id: null, ok: false, error: { code: "invalid", message: "bad json" } });
    return;
  }

  handle(request).catch((error) => {
    send({ id: request?.id ?? null, ok: false, error: describeError(error) });
  });
});

lines.on("close", () => {
  process.exit(0);
});
