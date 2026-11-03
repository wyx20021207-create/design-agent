/**
 * 子代理：一个任务拥有独立对话和上下文，但和主代理共用同一个容器/工作区。
 *
 * 为什么共用容器：Python 版的 worker 也是在同一个 /workspace 里工作，lead 给每个
 * worker 分配互不重叠的目录。这里用 SubagentDoc 记录 child → parent，环境构建时
 * 直接复用 parent 的容器。
 */
import { BACKGROUND_CONTEXT as ctx, withAbortSignal, type Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";

import type { ModelRef } from "../config.ts";
import { messageText } from "../text.ts";

export type SubagentValue = {
  /** child conversation id → parent conversation id。 */
  parents: Record<string, string>;
};

export const SubagentDoc = defineDoc({
  kind: "design.subagents",
  version: 1,
  scope: "session",
  initial: (): SubagentValue => ({ parents: {} }),
  checkpointWhen: () => true,
});

export async function loadSubagentParents(
  harness: Harness,
  context: Context,
): Promise<Map<string, string>> {
  const value = await harness.snapshot(SubagentDoc, context);
  return new Map(Object.entries(value?.parents ?? {}));
}

export async function registerSubagent(
  harness: Harness,
  childId: ConversationId,
  parentId: ConversationId,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SubagentDoc);
    doc.parents[String(childId)] = String(parentId);
  }, context);
}

const WORKER_PREAMBLE = `You are a specialist working for the lead design agent. The brief below is your job.

How you work:
- Read the skills and files the brief names before you start. The brand pack is /workspace/brand; it outranks your taste.
- Work only in the folders the brief assigns you. Everything else is read-only. If a shared file blocks you, work around it in your own files and say so.
- Measure, don't eyeball: timings, positions, sizes and colours come from the timeline, the brand tokens or a script's numbers.
- Look at every render, sheet and still you rely on. A render you have not looked at does not count.
- Run the gates the brief names. Exit 2 means the gate could not run: report it, never treat it as a pass.
- Never deliver, post, publish or schedule anything: the lead delivers.
- Your final message is all the lead sees. State what you made, the file paths, and gate results. Be concise.`;

export type ChildResult =
  | { readonly ok: true; readonly answer: string; readonly conversationId: ConversationId }
  | { readonly ok: false; readonly message: string; readonly conversationId: ConversationId };

export interface RunChildOptions {
  readonly harness: Harness;
  readonly model: ModelRef;
  readonly parentConversationId: ConversationId;
  readonly brief: string;
  readonly role?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** 持久化 child → parent，并更新进程内的容器映射；由 Runtime 提供。 */
  readonly register: (childId: ConversationId, parentId: ConversationId) => Promise<void>;
  readonly context?: Context;
}

const DEFAULT_CHILD_TIMEOUT_MS = 20 * 60 * 1_000;

/** 建一个子对话，跑完，返回它的最终回答。上下文独立，文件和容器与父对话共享。 */
export async function runChild(options: RunChildOptions): Promise<ChildResult> {
  const context = options.context ?? ctx;
  const child = await options.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: options.model } },
    context,
  );
  await options.register(child.id, options.parentConversationId);

  const content = [
    WORKER_PREAMBLE,
    options.role === undefined ? "" : `Role: ${options.role}`,
    `Brief:\n${options.brief}`,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");

  const submission = await child.submit(
    { type: "input", content, requestId: `delegate-${child.id}` },
    context,
  );

  try {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS);
    const settled = await submission.wait(withAbortSignal(timeout, context));
    if (settled.status !== "done" || settled.type !== "input") {
      const reason = "reason" in settled ? settled.reason : "";
      return {
        ok: false,
        message: `worker did not answer (${settled.status}${reason ? `: ${reason}` : ""})`,
        conversationId: child.id,
      };
    }
    const entry = await child.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      context,
    );
    const answer = messageText(entry?.model?.[0]).trim();
    return {
      ok: true,
      answer: answer.length > 0 ? answer : "(empty report)",
      conversationId: child.id,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      conversationId: child.id,
    };
  }
}
