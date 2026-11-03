/**
 * delegate / parallel_looks：把独立工作交给子代理。
 *
 * 子代理有独立上下文，但和主代理共用同一个 /workspace 与容器；brief 必须给每个
 * worker 分配互不重叠的目录。
 */
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

import type { ModelRef, Settings } from "../config.ts";
import { runChild } from "../harness/subagents.ts";

const MAX_LOOKS = 4;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const text = (message: string) => [{ type: "text" as const, text: message }];
const fail = (message: string) => ({ output: text(message), isError: true });

export type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** low 用低档模型，max 用高档，其余落在 xhigh。 */
export function workerModelFor(settings: Settings, effort: WorkerEffort): ModelRef {
  if (effort === "low") return settings.workerModels.low;
  if (effort === "max") return settings.workerModels.max;
  return settings.workerModels.xhigh;
}

export function workerTimeoutSeconds(effort: WorkerEffort): number {
  switch (effort) {
    case "low":
      return 600;
    case "medium":
      return 1_200;
    case "high":
      return 1_800;
    case "xhigh":
      return 1_800;
    case "max":
      return 2_700;
  }
}

export type GetHarness = () => Harness | undefined;
export type RegisterChild = (
  childId: ConversationId,
  parentId: ConversationId,
) => Promise<void>;

export function createDelegateTools(
  settings: Settings,
  getHarness: GetHarness,
  register: RegisterChild,
) {
  const delegate = defineTool({
    name: "delegate",
    description: [
      "Delegate one self-contained job to a specialist worker with its own context.",
      "The worker shares this conversation's /workspace and container, so assign it exclusive folders.",
      "Use it for independent acts, reviews, measurements, or tool-heavy work that would clutter your context.",
      "Returns the worker's final report; it never delivers or publishes.",
    ].join("\n"),
    parameters: obj({
      brief: str({
        description:
          "The job: what to make, the quality bar, which folders belong to the worker, " +
          "which skills and gates to use, and what to return.",
      }),
      role: opt(str({ description: "Optional role such as builder, critic or analyst." })),
      effort: opt(
        oneOf(["low", "medium", "high", "xhigh", "max"], {
          description: "Worker tier: low uses the cheap model, max the strongest. Default xhigh.",
        }),
      ),
      timeout_seconds: opt(num({ description: "Worker timeout in seconds, 60 to 3600. Default depends on effort." })),
    }),

    async execute(args, api, context: Context) {
      const harness = getHarness();
      if (harness === undefined) return fail("delegation unavailable: the harness is not ready.");
      const effort = args.effort ?? "xhigh";
      const timeoutSeconds = args.timeout_seconds ?? workerTimeoutSeconds(effort);
      const timeoutMs = Math.max(60, Math.min(timeoutSeconds, 3_600)) * 1_000;

      const result = await runChild({
        harness,
        model: workerModelFor(settings, effort),
        parentConversationId: api.conversationId,
        brief: args.brief,
        role: args.role,
        timeoutMs,
        register,
        context,
      });

      if (!result.ok) {
        return fail(`worker ${result.conversationId} failed: ${result.message}`);
      }
      return { output: text(`worker ${result.conversationId}:\n${result.answer}`) };
    },
  });

  const parallelLooks = defineTool({
    name: "parallel_looks",
    description: [
      "Run 2 to 4 independent visual directions in parallel, each in its own worker context.",
      "Workers share this conversation's /workspace; each one gets look-1, look-2, … folders.",
      "Returns one report per direction. You review the files and pick or combine.",
    ].join("\n"),
    parameters: obj({
      brief: str({ description: "The shared brief: what is being designed, sizes, copy, gates." }),
      project: str({ description: "Project folder under /workspace/projects." }),
      count: opt(num({ description: "2 to 4 directions. Default 3." })),
      variations: opt(
        arr(str({ description: "One direction description." }), {
          maxItems: MAX_LOOKS,
          description: "Optional direction labels; missing ones are numbered.",
        }),
      ),
    }),

    async execute(args, api, context: Context) {
      const harness = getHarness();
      if (harness === undefined) return fail("delegation unavailable: the harness is not ready.");
      if (!SLUG.test(args.project)) return fail("project must be a single folder name under /workspace/projects.");

      const count = Math.max(2, Math.min(args.count ?? 3, MAX_LOOKS));
      const variations = args.variations ?? [];
      const jobs = Array.from({ length: count }, (_, index) => {
        const direction = variations[index] ?? `direction ${index + 1}`;
        const brief = [
          `Direction: ${direction}`,
          "",
          args.brief,
          "",
          `Work only in /workspace/projects/${args.project}/look-${index + 1}/.`,
          "Produce a distinct direction; do not modify the other looks.",
          "Return the files, the sizes, and the gate results.",
        ].join("\n");
        return runChild({
          harness,
          model: settings.lookModel,
          parentConversationId: api.conversationId,
          brief,
          role: "builder",
          timeoutMs: 30 * 60 * 1_000,
          register,
          context,
        });
      });

      const results = await Promise.all(jobs);
      const report = results
        .map((result, index) => {
          const direction = variations[index] ?? `direction ${index + 1}`;
          return result.ok
            ? `## look ${index + 1} — ${direction}\nworker ${result.conversationId}\n\n${result.answer}`
            : `## look ${index + 1} — ${direction}\nfailed: ${result.message}`;
        })
        .join("\n\n---\n\n");
      return { output: text(report) };
    },
  });

  return [delegate, parallelLooks];
}
