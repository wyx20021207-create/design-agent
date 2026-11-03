/**
 * 宿主机侧的 ExecutionEnv 实现：把每一次调用转发进容器。
 *
 * 它是一个纯代理：不认识路径、不碰文件，只负责把方法名和参数发过去、
 * 把结果和错误码带回来。所有语义都由容器内的官方 NodeExecutionEnv 决定。
 *
 * 唯一在本地处理的是取消：调用前 context 已经中止就直接返回 aborted，
 * 不产生一次跨进程往返。
 */
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type ExecutionErrorCode,
  type FileChange,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";

import { RpcClient, type RpcError } from "./rpc.ts";

const toFileError = (error: RpcError): FileError =>
  new FileError(error.code as FileErrorCode, error.message, error.path);

const toExecutionError = (error: RpcError): ExecutionError =>
  new ExecutionError(error.code as ExecutionErrorCode, error.message);

const isBytes = (value: unknown): value is { __bytes: string } =>
  value !== null && typeof value === "object" && "__bytes" in value;

const decode = (value: unknown): unknown => {
  if (isBytes(value)) return new Uint8Array(Buffer.from(value.__bytes, "base64"));
  return value;
};

const encode = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return { __bytes: Buffer.from(value).toString("base64") };
  return value;
};

const abortedFile = <T>(context: Context): Result<T, FileError> | undefined =>
  context.abortSignal?.aborted ? err<T, FileError>(new FileError("aborted", "aborted")) : undefined;

const abortedExec = (context: Context): Result<ShellExecResult, ExecutionError> | undefined =>
  context.abortSignal?.aborted
    ? err<ShellExecResult, ExecutionError>(new ExecutionError("aborted", "aborted"))
    : undefined;

const asFile = async <T>(work: Promise<unknown>): Promise<Result<T, FileError>> => {
  try {
    return ok(decode(await work) as T);
  } catch (error) {
    return err(toFileError(error as RpcError));
  }
};

const asVoid = async (work: Promise<unknown>): Promise<Result<void, FileError>> => {
  try {
    await work;
    return ok(undefined);
  } catch (error) {
    return err(toFileError(error as RpcError));
  }
};

const handleOf = (value: unknown): string => {
  if (value !== null && typeof value === "object" && "__handle" in value) {
    return String((value as { __handle: unknown }).__handle);
  }
  throw new Error("env server 没有返回句柄");
};

class RemoteBinaryReader implements BinaryReader {
  #rpc: RpcClient;
  #handle: string;

  constructor(rpc: RpcClient, handle: string) {
    this.#rpc = rpc;
    this.#handle = handle;
  }

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    const stop = abortedFile<FileInfo>(context);
    if (stop) return stop;
    return asFile<FileInfo>(this.#rpc.call("handle.info", [this.#handle]));
  }

  async read(
    offset: number,
    length: number,
    context: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    const stop = abortedFile<Uint8Array>(context);
    if (stop) return stop;
    return asFile<Uint8Array>(this.#rpc.call("handle.read", [this.#handle, offset, length]));
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    context: Context,
  ): Promise<Result<LineScan, FileError>> {
    const stop = abortedFile<LineScan>(context);
    if (stop) return stop;
    return asFile<LineScan>(this.#rpc.call("handle.scanLines", [this.#handle, options]));
  }

  async close(_context: Context): Promise<void> {
    await this.#rpc.call("handle.close", [this.#handle]).catch(() => undefined);
  }
}

class RemoteTextLineReader implements TextLineReader {
  #rpc: RpcClient;
  #handle: string;

  constructor(rpc: RpcClient, handle: string) {
    this.#rpc = rpc;
    this.#handle = handle;
  }

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const stop = abortedFile<TextLine | undefined>(context);
    if (stop) return stop;
    return asFile<TextLine | undefined>(this.#rpc.call("handle.readLine", [this.#handle]));
  }

  async close(_context: Context): Promise<void> {
    await this.#rpc.call("handle.close", [this.#handle]).catch(() => undefined);
  }
}

class RemoteDirReader implements DirReader {
  #rpc: RpcClient;
  #handle: string;

  constructor(rpc: RpcClient, handle: string) {
    this.#rpc = rpc;
    this.#handle = handle;
  }

  async next(
    maxEntries: number,
    context: Context,
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const stop = abortedFile<{ entries: FileInfo[]; done: boolean }>(context);
    if (stop) return stop;
    return asFile<{ entries: FileInfo[]; done: boolean }>(
      this.#rpc.call("handle.next", [this.#handle, maxEntries]),
    );
  }

  async close(_context: Context): Promise<void> {
    await this.#rpc.call("handle.close", [this.#handle]).catch(() => undefined);
  }
}

class RemoteFileWatcher implements FileWatcher {
  readonly mode: "native" | "polling";
  #rpc: RpcClient;
  #handle: string;
  #streamId: number;

  constructor(rpc: RpcClient, handle: string, mode: "native" | "polling", streamId: number) {
    this.#rpc = rpc;
    this.#handle = handle;
    this.mode = mode;
    this.#streamId = streamId;
  }

  async stop(_context: Context): Promise<void> {
    await this.#rpc.call("handle.stop", [this.#handle]).catch(() => undefined);
    this.#rpc.closeStream(this.#streamId);
  }
}

export class DockerExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;

  #rpc: RpcClient;

  constructor(rpc: RpcClient, options: { id: string; cwd?: string }) {
    this.#rpc = rpc;
    this.id = options.id;
    this.cwd = options.cwd ?? "/workspace";
  }

  // -- 路径 -----------------------------------------------------------------------------------

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    const stop = abortedFile<string>(context);
    if (stop) return stop;
    return asFile<string>(this.#rpc.call("absolutePath", [path]));
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    const stop = abortedFile<string>(context);
    if (stop) return stop;
    return asFile<string>(this.#rpc.call("joinPath", [parts]));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const stop = abortedFile<string>(context);
    if (stop) return stop;
    return asFile<string>(this.#rpc.call("canonicalPath", [path]));
  }

  // -- 读 -------------------------------------------------------------------------------------

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const stop = abortedFile<string>(context);
    if (stop) return stop;
    return asFile<string>(this.#rpc.call("readTextFile", [path]));
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const stop = abortedFile<string[]>(context);
    if (stop) return stop;
    return asFile<string[]>(this.#rpc.call("readTextLines", [path, options ?? {}]));
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const stop = abortedFile<Uint8Array>(context);
    if (stop) return stop;
    return asFile<Uint8Array>(this.#rpc.call("readBinaryFile", [path]));
  }

  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const stop = abortedFile<TextLineReader>(context);
    if (stop) return stop;
    try {
      const handle = handleOf(await this.#rpc.call("openTextLineReader", [path]));
      return ok(new RemoteTextLineReader(this.#rpc, handle));
    } catch (error) {
      return err(toFileError(error as RpcError));
    }
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const stop = abortedFile<BinaryReader>(context);
    if (stop) return stop;
    try {
      const handle = handleOf(await this.#rpc.call("openBinaryReader", [path, options ?? {}]));
      return ok(new RemoteBinaryReader(this.#rpc, handle));
    } catch (error) {
      return err(toFileError(error as RpcError));
    }
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const stop = abortedFile<DirReader>(context);
    if (stop) return stop;
    try {
      const handle = handleOf(await this.#rpc.call("openDirReader", [path]));
      return ok(new RemoteDirReader(this.#rpc, handle));
    } catch (error) {
      return err(toFileError(error as RpcError));
    }
  }

  // -- 写 -------------------------------------------------------------------------------------

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const stop = abortedFile<void>(context);
    if (stop) return stop;
    return asVoid(this.#rpc.call("writeFile", [path, encode(content)]));
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const stop = abortedFile<void>(context);
    if (stop) return stop;
    return asVoid(this.#rpc.call("appendFile", [path, encode(content)]));
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const stop = abortedFile<void>(context);
    if (stop) return stop;
    return asVoid(this.#rpc.call("truncateFile", [path, size]));
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const stop = abortedFile<void>(context);
    if (stop) return stop;
    return asVoid(this.#rpc.call("flushFile", [path]));
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const stop = abortedFile<void>(context);
    if (stop) return stop;
    return asVoid(this.#rpc.call("renameFile", [sourcePath, destinationPath]));
  }

  // -- 目录 -----------------------------------------------------------------------------------

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const stop = abortedFile<FileInfo>(context);
    if (stop) return stop;
    return asFile<FileInfo>(this.#rpc.call("fileInfo", [path]));
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const stop = abortedFile<FileInfo[]>(context);
    if (stop) return stop;
    return asFile<FileInfo[]>(this.#rpc.call("listDir", [path]));
  }

  // listFiles 在 FileSystem 里是可选的，官方 NodeExecutionEnv 未实现，这里不转发。

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const stop = abortedFile<boolean>(context);
    if (stop) return stop;
    return asFile<boolean>(this.#rpc.call("exists", [path]));
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const stop = abortedFile<void>(context);
    if (stop) return stop;
    return asVoid(this.#rpc.call("createDir", [path, options ?? {}]));
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const stop = abortedFile<void>(context);
    if (stop) return stop;
    return asVoid(this.#rpc.call("remove", [path, options ?? {}]));
  }

  async createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const stop = abortedFile<string>(context);
    if (stop) return stop;
    return asFile<string>(this.#rpc.call("createTempDir", [prefix]));
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const stop = abortedFile<string>(context);
    if (stop) return stop;
    return asFile<string>(this.#rpc.call("createTempFile", [options ?? {}]));
  }

  // -- 监听 -----------------------------------------------------------------------------------

  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: FileChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const stop = abortedFile<FileWatcher>(context);
    if (stop) return stop;
    try {
      const stream = await this.#rpc.openStream("watch", [targets], {
        onEvent: (message) => {
          onChange(message["change"] as FileChange);
        },
      });
      const value = stream.value as { __handle: string; mode: "native" | "polling" };
      return ok(new RemoteFileWatcher(this.#rpc, value.__handle, value.mode, stream.id));
    } catch (error) {
      return err(toFileError(error as RpcError));
    }
  }

  // -- 命令 -----------------------------------------------------------------------------------

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const stop = abortedExec(context);
    if (stop) return stop;

    const forwarded: Record<string, unknown> = { ...(options ?? {}) };
    delete forwarded["onOutput"];

    const sink = options?.onOutput;
    const callOptions = {
      ...(sink
        ? {
            onOutput: (text: string, stream: string) =>
              sink(text, context, { stream: stream === "stderr" ? "stderr" : "stdout" }),
          }
        : {}),
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      timeoutMs: (options?.timeout ?? 0) > 0 ? (options?.timeout ?? 0) * 1000 + 30_000 : 30 * 60_000,
    };

    try {
      return ok(
        (await this.#rpc.call("exec", [command, forwarded], callOptions)) as ShellExecResult,
      );
    } catch (error) {
      return err(toExecutionError(error as RpcError));
    }
  }

  // -- 收尾 -----------------------------------------------------------------------------------

  async cleanup(_context: Context): Promise<void> {
    await this.#rpc.call("cleanup", []).catch(() => undefined);
  }
}
