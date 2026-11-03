/**
 * 异步渲染任务：工具立刻返回，渲染在后台推进，完成后把结果提交回对话。
 *
 * 三个 phase 边界就是三个恢复点：
 *   render  → 在容器里跑命令，检查产物，写完成标记
 *   report  → 把结果作为一条输入投放回对话，同时把任务置为终态
 *
 * 崩溃后 Harness.open() 会把 running 改回 pending，从最后一个 commit 的 checkpoint 重跑。
 * 因此 render 先查完成标记：同样的命令 + 同样的产物路径，重跑时直接跳过。
 */
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import { defineTask, type NextTaskState, type RunningTask } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** 结果投回对话时使用的 entry kind；UI 可以据此把普通用户消息和任务回执分开。 */
export const TASK_REPORT_ENTRY = "task.report";

const MARKER_DIR = "/workspace/.renders";
const MAX_COMMAND_OUTPUT = 8_000;
const RENDER_TIMEOUT_SECONDS = 20 * 60;

export type RenderInput = {
  /** 在容器的 /workspace 下执行，字符串走 shell。 */
  readonly command: string;
  /** 期望落盘的绝对路径，必须在 /workspace 下。 */
  readonly outputPath: string;
  /** 给人和模型看的短名字，可选。 */
  readonly label?: string;
};

export type RenderResult = {
  readonly path: string;
  readonly bytes: number;
};

export type RenderState =
  | { readonly phase: "render"; readonly digest: string }
  | {
      readonly phase: "report";
      readonly digest: string;
      readonly result: RenderResult;
      readonly durationMs: number;
      readonly output: string;
    }
  | {
      readonly phase: "report";
      readonly digest: string;
      readonly failure: string;
      readonly durationMs: number;
      readonly output: string;
    };

/** 同样的命令 + 同样的产物路径 → 同样的 digest，完成标记也同名。 */
export const renderDigest = (input: Pick<RenderInput, "command" | "outputPath">): string =>
  createHash("sha256")
    .update(input.outputPath)
    .update("\0")
    .update(input.command)
    .digest("hex");

const markerPathOf = (digest: string): string => `${MARKER_DIR}/${digest}.done`;

const labelOf = (input: RenderInput): string => input.label ?? input.outputPath;

const tail = (text: string, limit = 1_200): string =>
  text.length <= limit ? text : text.slice(-limit);

const seconds = (durationMs: number): string => (durationMs / 1_000).toFixed(1);

/** 命令成功、产物也在：值来自文件系统，所以重跑时拿到的是当前大小。 */
async function existingArtifact(
  env: ExecutionEnv,
  path: string,
  context: Context,
): Promise<RenderResult | undefined> {
  const info = await env.fileInfo(path, context);
  if (!info.ok || info.value.kind !== "file") return undefined;
  return { path, bytes: info.value.size };
}

/** 上一次已经成功过：完成标记的内容以 digest 开头。 */
async function markerMatches(
  env: ExecutionEnv,
  path: string,
  digest: string,
  context: Context,
): Promise<boolean> {
  const marker = await env.readTextFile(markerPathOf(digest), context);
  return marker.ok && marker.value.startsWith(digest) && (await existingArtifact(env, path, context)) !== undefined;
}

/**
 * 执行命令，返回退出码和保留的尾部输出。
 * env.exec 的 timeout 单位是秒；context 的 abortSignal 来自任务的 signal。
 */
async function runCommand(
  env: ExecutionEnv,
  input: RenderInput,
  signal: AbortSignal,
  context: Context,
): Promise<{ exitCode: number; output: string }> {
  let output = "";
  const result = await env.exec(
    input.command,
    {
      cwd: "/workspace",
      timeout: RENDER_TIMEOUT_SECONDS,
      onOutput: (text: string) => {
        output += text;
        if (output.length > MAX_COMMAND_OUTPUT) output = output.slice(-MAX_COMMAND_OUTPUT);
      },
    },
    withAbortSignal(signal, context),
  );

  if (!result.ok) {
    // 任务被取消时把错误抛出去，调度器会走 abort 分支，而不是把这个任务判成 faulted。
    if (result.error.code === "aborted" && signal.aborted) throw result.error;
    throw new Error(`命令无法执行（${result.error.code}）：${result.error.message}`);
  }

  return { exitCode: result.value.exitCode, output };
}

const terminalState = (
  result: RenderResult | undefined,
  failure: string | undefined,
): NextTaskState<RenderState, RenderResult> =>
  result === undefined
    ? {
        status: "terminal",
        outcome: { status: "failed", error: { message: failure ?? "渲染失败" } },
      }
    : { status: "terminal", outcome: { status: "completed", result } };

export const RenderTask = defineTask<RenderInput, RenderState, RenderResult>({
  name: "render",
  version: 1,

  initial: (input) => ({ phase: "render", digest: renderDigest(input) }),

  phases: {
    render: async (task, runtime, context) => {
      const input = task.input;
      const digest = task.state.checkpoint.digest;
      const startedAt = runtime.now();
      const signal = runtime.signal;

      const env = await runtime.env(context);
      if (env === undefined) throw new Error("这个对话没有可用的执行环境");

      // 同一任务重跑时 memo 最快；跨进程或跨任务时用文件系统里的完成标记。
      const remembered = await runtime.memo<RenderResult>("artifact", context);
      const cached =
        remembered !== undefined
          ? await existingArtifact(env, remembered.path, context)
          : undefined;
      if (cached !== undefined) {
        await runtime.commit((): NextTaskState<RenderState, RenderResult> => ({
          status: "running",
          checkpoint: {
            phase: "report",
            digest,
            result: cached,
            durationMs: 0,
            output: "已存在完成标记，跳过执行。",
          },
        }), context);
        return;
      }

      if (await markerMatches(env, input.outputPath, digest, context)) {
        const artifact = await existingArtifact(env, input.outputPath, context);
        if (artifact !== undefined) {
          await runtime.commit((): NextTaskState<RenderState, RenderResult> => ({
            status: "running",
            checkpoint: {
              phase: "report",
              digest,
              result: artifact,
              durationMs: 0,
              output: "完成标记匹配，跳过执行。",
            },
          }), context);
          return;
        }
      }

      let exitCode = 0;
      let output = "";
      let failure: string | undefined;

      try {
        const ran = await runCommand(env, input, signal, context);
        exitCode = ran.exitCode;
        output = ran.output;
        if (exitCode !== 0) failure = `命令退出码 ${exitCode}`;
      } catch (error) {
        // 被取消的命令交给 abort handler。
        if (signal.aborted) throw error;
        failure = error instanceof Error ? error.message : String(error);
      }

      let artifact: RenderResult | undefined;
      if (failure === undefined) {
        artifact = await existingArtifact(env, input.outputPath, context);
        if (artifact === undefined) {
          failure = `命令成功，但产物不存在：${input.outputPath}`;
        } else {
          // 完成标记供重跑使用；写失败不影响本次结果，只是下次会重跑。
          await env.writeFile(markerPathOf(digest), `${digest}\n${input.outputPath}\n`, context);
          await runtime.memo("artifact", artifact, context);
        }
      }

      const durationMs = runtime.now() - startedAt;
      await runtime.commit((): NextTaskState<RenderState, RenderResult> => ({
        status: "running",
        checkpoint:
          artifact === undefined
            ? { phase: "report", digest, failure: failure ?? "渲染失败", durationMs, output }
            : { phase: "report", digest, result: artifact, durationMs, output },
      }), context);
    },

    report: async (task, runtime, context) => {
      // 故障注入用：让报告阶段停在这里，测试可以在这个窗口杀掉进程。
      // 生产环境不设置这个变量。
      const delay = Number(process.env["DESIGN_AGENT_REPORT_DELAY_MS"] ?? "0");
      if (Number.isFinite(delay) && delay > 0) {
        await sleep(delay, undefined, { signal: runtime.signal });
      }

      const state = task.state.checkpoint;
      const ok = "result" in state;
      const headline = ok
        ? `渲染完成：${state.result.path}（${state.result.bytes} 字节，${seconds(state.durationMs)}s）`
        : `渲染失败：${state.failure}（${seconds(state.durationMs)}s）`;
      const detail = tail(state.output).trim();
      const content = detail.length === 0 ? headline : `${headline}\n\n最后输出：\n${detail}`;

      const conversation = await runtime.conversation(runtime.conversationId, context);
      if (conversation === undefined) {
        await runtime.commit(() => terminalState(undefined, "对话已不存在，无法回报结果"), context);
        return;
      }

      await runtime.commit(async (tx) => {
        // 必须在这个 commit 的第一个表写之前；否则 ReadAfterWrite。
        await conversation.submit(tx, {
          type: "input",
          content,
          entry: {
            kind: TASK_REPORT_ENTRY,
            data: {
              taskId: runtime.taskId,
              task: "render",
              ok,
              label: labelOf(task.input),
              outputPath: task.input.outputPath,
            },
          },
        });
        return terminalState(ok ? state.result : undefined, ok ? undefined : state.failure);
      }, context);
    },
  },

  abort: async (task: RunningTask<RenderInput, RenderState, RenderResult>, runtime, context) => {
    const conversation = await runtime.conversation(runtime.conversationId, context);
    let notifyError: unknown;

    await runtime.commit(async (tx) => {
      if (conversation !== undefined) {
        try {
          await conversation.submit(tx, {
            type: "input",
            content: `渲染已取消：${labelOf(task.input)}`,
            entry: {
              kind: TASK_REPORT_ENTRY,
              data: { taskId: runtime.taskId, task: "render", ok: false, cancelled: true },
            },
          });
        } catch (error) {
          // 通知失败不能阻止任务落到终态；把错误交给 Harness 的报告通道。
          notifyError = error;
        }
      }
      return {
        status: "terminal",
        outcome: { status: "aborted", reason: "任务被取消" },
      } satisfies NextTaskState<RenderState, RenderResult>;
    }, context);

    if (notifyError !== undefined) runtime.report(notifyError);
  },
});
