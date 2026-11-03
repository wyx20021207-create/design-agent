/**
 * upload_files：把工作区文件交给对话外的人。
 *
 * 名字和参数与 Python 版一致，技能文档不用改。
 * 同一个对话里，(路径, sha256) 已经交付过就不再发送；只有适配器确认成功才记账。
 */
import { posix } from "node:path";

import type { Context } from "@earendil-works/chord/context";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { arr, obj, str } from "@earendil-works/pi-schema";

import {
  deliveredName,
  sha256Of,
  type DeliveryAdapter,
  type DeliveryItem,
} from "../delivery/adapter.ts";
import { DeliveryLedgerDoc, alreadyDelivered } from "../delivery/ledger.ts";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const WORKSPACE = "/workspace";

const UPLOADED = "Files uploaded.";
const NOT_CONFIRMED = "File delivery was not confirmed. Do not retry this upload automatically.";

const parameters = obj(
  {
    paths: arr(
      str({ description: "Absolute path under /workspace, or a path relative to it." }),
      { minItems: 1, maxItems: MAX_FILES },
    ),
  },
  { open: true },
);

const text = (message: string) => [{ type: "text" as const, text: message }];
const ok = (message: string) => ({ output: text(message) });
const error = (message: string) => ({ output: text(message), isError: true });

/** 规范化到 /workspace 下的绝对路径；越界一律拒绝。 */
function workspacePath(raw: string): string {
  const candidate = raw.startsWith("/") ? raw : `${WORKSPACE}/${raw}`;
  const normalized = posix.normalize(candidate);
  if (normalized !== WORKSPACE && !normalized.startsWith(`${WORKSPACE}/`)) {
    throw new Error("Upload paths must be files under /workspace.");
  }
  return normalized;
}

/**
 * 在容器里算 sha256，已交付的文件就不用把内容拉回宿主机。
 * sha256sum 不可用时退回逐个读文件。
 */
async function hashFiles(
  env: ExecutionEnv,
  paths: readonly string[],
  context: Context,
): Promise<Map<string, string> | undefined> {
  let stdout = "";
  const result = await env.exec(["sha256sum", "--", ...paths], {
    cwd: WORKSPACE,
    onOutput: (chunk, _outputContext, info) => {
      if (info.stream === "stdout") stdout += chunk;
    },
  }, context);

  const found = new Map<string, string>();
  if (result.ok) {
    for (const line of stdout.split("\n")) {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) found.set(match[2], match[1]);
    }
  }
  if (found.size === paths.length) return found;

  for (const path of paths) {
    if (found.has(path)) continue;
    const bytes = await env.readBinaryFile(path, context);
    if (!bytes.ok) return undefined;
    found.set(path, sha256Of(bytes.value));
  }
  return found;
}

export function createUploadTool(adapter: DeliveryAdapter) {
  return defineTool({
    name: "upload_files",
    description: [
      "Upload 1 to 10 workspace files as one attachment batch to the person.",
      "Use this instead of pasting file contents into chat.",
      "The same file is never sent twice in one conversation; a changed file is sent again.",
    ].join("\n"),
    parameters,

    async execute(args, api, context) {
      const env = api.env;
      if (env === undefined) return error("File attachments are unavailable for this run.");

      if (args.paths.length === 0 || args.paths.length > MAX_FILES) {
        return error(`Upload 1 to ${MAX_FILES} files at a time.`);
      }

      let paths: string[];
      try {
        paths = args.paths.map(workspacePath);
      } catch (failure) {
        return error(failure instanceof Error ? failure.message : String(failure));
      }
      if (new Set(paths).size !== paths.length) {
        return error("Use each workspace file only once.");
      }

      const names = paths.map(deliveredName);
      if (new Set(names).size !== names.length) {
        return error("Two files share a name; rename one before uploading.");
      }

      const hashes = await hashFiles(env, paths, context);
      if (hashes === undefined) return error("The workspace file could not be read.");

      const ledger = await api.snapshot(DeliveryLedgerDoc, api.conversationId, context);
      const fresh = paths.filter((path) => !alreadyDelivered(ledger, path, hashes.get(path) ?? ""));
      const already = paths.filter((path) => !fresh.includes(path));

      if (fresh.length === 0) {
        return ok(
          `Already delivered in this thread, not sent again: ${already.map(deliveredName).join(", ")}.`,
        );
      }

      const items: DeliveryItem[] = [];
      for (const path of fresh) {
        const info = await env.fileInfo(path, context);
        if (!info.ok || info.value.kind !== "file") {
          return error("The workspace file could not be read.");
        }
        if (info.value.size > MAX_FILE_BYTES) {
          return error(`Attachment exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MiB limit.`);
        }

        const bytes = await env.readBinaryFile(path, context);
        if (!bytes.ok) return error("The workspace file could not be read.");
        const digest = sha256Of(bytes.value);
        if (digest !== hashes.get(path)) {
          return error("The file changed while it was being delivered. Try again.");
        }
        items.push({ name: deliveredName(path), sourcePath: path, sha256: digest, bytes: bytes.value });
      }

      let outcomes;
      try {
        outcomes = await adapter.deliver({
          conversationId: String(api.conversationId),
          items,
        });
      } catch {
        // 适配器的错误可能带 token 或 URL，只回固定文本。
        return error(NOT_CONFIRMED);
      }

      // 只有适配器确认之后才写台账；写在同一批提交里，要么全有要么全无。
      const byName = new Map(items.map((item) => [item.name, item]));
      const at = api.now();
      await api.commit(async (tx) => {
        const doc = await tx.doc(DeliveryLedgerDoc, api.conversationId);
        for (const outcome of outcomes) {
          const item = byName.get(outcome.name);
          if (item === undefined) continue;
          doc.deliveries.push({
            path: item.sourcePath,
            sha256: item.sha256,
            name: item.name,
            bytes: item.bytes.byteLength,
            target: outcome.target,
            at,
          });
        }
      }, context);

      if (already.length === 0) return ok(UPLOADED);
      return ok(
        `${UPLOADED} Skipped, already delivered: ${already.map(deliveredName).join(", ")}.`,
      );
    },
  });
}
