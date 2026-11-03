/**
 * 飞书附件 → 容器里的 /workspace/attachments/。
 *
 * 图片按魔数补扩展名；同名文件加序号，不覆盖上一次的参考图。
 * 超过 30 MB 或下载失败的文件跳过，并把结果告诉调用方。
 */
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

import type { FeishuTransport } from "./client.ts";
import type { ParsedAttachment } from "./events.ts";

const ATTACHMENT_DIR = "/workspace/attachments";
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

/** 保留中文和空格，只去掉路径分隔符与文件系统保留字符。 */
function sanitizeName(name: string): string {
  const base = name
    .slice(name.lastIndexOf("/") + 1)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^[ .]+|[ .]+$/g, "");
  return base.length === 0 ? "file" : base;
}

export function sniffImageExtension(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return ".gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return ".webp";
  return ".bin";
}

export function attachmentName(attachment: ParsedAttachment, bytes: Uint8Array): string {
  if (attachment.name !== undefined && attachment.name.length > 0) {
    return sanitizeName(attachment.name);
  }
  const suffix = attachment.fileKey.slice(-8);
  if (attachment.type === "image") return `image-${suffix}${sniffImageExtension(bytes)}`;
  return `file-${suffix}.bin`;
}

async function uniquePath(
  env: ExecutionEnv,
  base: string,
  context: Context,
): Promise<string> {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : "";
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? base : `${stem}-${index}${extension}`;
    const path = `${ATTACHMENT_DIR}/${name}`;
    const exists = await env.exists(path, context);
    if (!exists.ok || !exists.value) return path;
  }
}

export interface DownloadedAttachments {
  readonly paths: readonly string[];
  readonly failed: readonly string[];
}

export async function downloadAttachments(
  transport: FeishuTransport,
  attachments: readonly ParsedAttachment[],
  env: ExecutionEnv,
  context: Context,
): Promise<DownloadedAttachments> {
  if (attachments.length === 0) return { paths: [], failed: [] };

  const created = await env.createDir(ATTACHMENT_DIR, { recursive: true }, context);
  if (!created.ok) {
    return { paths: [], failed: attachments.map((item) => item.fileKey) };
  }

  const paths: string[] = [];
  const failed: string[] = [];
  for (const attachment of attachments) {
    try {
      const bytes = await transport.downloadResource(
        attachment.messageId,
        attachment.fileKey,
        attachment.type,
      );
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        failed.push(attachment.name ?? attachment.fileKey);
        continue;
      }
      const path = await uniquePath(env, attachmentName(attachment, bytes), context);
      const written = await env.writeFile(path, bytes, context);
      if (written.ok) paths.push(path);
      else failed.push(attachment.name ?? attachment.fileKey);
    } catch {
      failed.push(attachment.name ?? attachment.fileKey);
    }
  }
  return { paths, failed };
}
