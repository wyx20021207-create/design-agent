/**
 * 宿主机侧的 RPC 客户端：用 `docker exec -i` 起一个长驻进程，通过 NDJSON 通信。
 *
 * 每条请求一个 id；响应用同一个 id 配对。
 * - exec 的输出以 event=output 流式到达，最后一条 ok 结束。
 * - watch 打开后仍持续发 event=change，直到显式 closeStream。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcError {
  code: string;
  message: string;
  path?: string;
}

interface Entry {
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  onOutput?: (text: string, stream: string) => void;
  onEvent?: (message: Record<string, unknown>) => void;
  keepOpen: boolean;
  settled: boolean;
  timer: NodeJS.Timeout;
}

export interface CallOptions {
  onOutput?: (text: string, stream: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StreamOptions {
  onEvent?: (message: Record<string, unknown>) => void;
}

export interface StreamResult {
  /** 请求 id，用于 closeStream。 */
  id: number;
  value: unknown;
}

const CALL_TIMEOUT_MS = 30_000;

export class RpcClient {
  #child: ChildProcessWithoutNullStreams;
  #entries = new Map<number, Entry>();
  #buffer = "";
  #nextId = 1;
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[env-server] ${chunk}`);
    });
    child.on("close", (code) => {
      this.#closed = true;
      const error: RpcError = {
        code: "shell_unavailable",
        message: `env server exited with code ${code ?? "null"}`,
      };
      for (const entry of this.#entries.values()) entry.reject(error);
      this.#entries.clear();
    });
  }

  static docker(
    container: string,
    options: { cwd?: string; entrypoint?: string } = {},
  ): RpcClient {
    const entrypoint = options.entrypoint ?? "/opt/env/container/pi-env-server.mjs";
    const args = [
      "exec", "-i",
      "--user", "1000:1000",
      "--env", "HOME=/home/node",
      container,
      "node", entrypoint,
    ];
    if (options.cwd !== undefined) args.push(options.cwd);

    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    return new RpcClient(child);
  }

  call(method: string, params: unknown[], options: CallOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) {
      return Promise.reject<RpcError>({ code: "aborted", message: "aborted" });
    }

    const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const id = this.#nextId++;
      this.#register(id, {
        resolve,
        reject,
        ...(options.onOutput ? { onOutput: options.onOutput } : {}),
        keepOpen: false,
        timeoutMs,
      });
      options.signal?.addEventListener("abort", () => this.#abortCall(id), { once: true });
      this.#write(id, method, params);
    });
  }

  /** 取消一次进行中的调用：通知容器中止，并让本地立刻拿到 aborted。 */
  #abortCall(id: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;

    clearTimeout(entry.timer);
    this.#entries.delete(id);

    if (!this.#closed) {
      this.#child.stdin.write(`${JSON.stringify({ id: 0, method: "abort", params: [id] })}\n`);
    }
    entry.reject({ code: "aborted", message: "aborted" });
  }

  /** 打开一个会长久发事件的请求（watch）。解析后条目保留，直到 closeStream。 */
  openStream(
    method: string,
    params: unknown[],
    options: StreamOptions = {},
  ): Promise<StreamResult> {
    return new Promise<StreamResult>((resolve, reject) => {
      const id = this.#nextId++;
      this.#register(id, {
        resolve: (value) => resolve({ id, value }),
        reject,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        keepOpen: true,
        timeoutMs: CALL_TIMEOUT_MS,
      });
      this.#write(id, method, params);
    });
  }

  closeStream(id: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#entries.delete(id);
  }

  close(): void {
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill();
  }

  #register(
    id: number,
    options: {
      resolve: (value: unknown) => void;
      reject: (error: RpcError) => void;
      onOutput?: (text: string, stream: string) => void;
      onEvent?: (message: Record<string, unknown>) => void;
      keepOpen: boolean;
      timeoutMs: number;
    },
  ): void {
    const timer = setTimeout(() => {
      this.#entries.delete(id);
      options.reject({ code: "timeout", message: `request ${id} timed out` });
    }, options.timeoutMs);

    this.#entries.set(id, {
      resolve: options.resolve,
      reject: options.reject,
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      keepOpen: options.keepOpen,
      settled: false,
      timer,
    });
  }

  #write(id: number, method: string, params: unknown[]): void {
    if (this.#closed) {
      const entry = this.#entries.get(id);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.#entries.delete(id);
        entry.reject({ code: "shell_unavailable", message: "client closed" });
      }
      return;
    }
    this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;

    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;

      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === "") continue;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        process.stderr.write(`[env-client] 无法解析: ${line.slice(0, 200)}\n`);
        continue;
      }

      const id = message["id"];
      if (typeof id !== "number") continue;

      const entry = this.#entries.get(id);
      if (entry === undefined) continue;

      if (message["event"] === "output") {
        entry.onOutput?.(String(message["text"] ?? ""), String(message["stream"] ?? "stdout"));
        continue;
      }
      if (message["event"] !== undefined) {
        entry.onEvent?.(message);
        continue;
      }

      if (entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      if (!entry.keepOpen) this.#entries.delete(id);

      if (message["ok"] === true) {
        entry.resolve(message["value"]);
      } else {
        entry.reject(message["error"] as RpcError);
      }
    }
  }
}
