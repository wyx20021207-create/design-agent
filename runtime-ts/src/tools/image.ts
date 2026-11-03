/**
 * generate_image：宿主侧调用 OpenAI 兼容的图像接口，把结果写进工作区。
 *
 * 密钥只在宿主机；容器永远拿不到。带 logo 或精确文案的画面仍应在 HTML 里做，
 * 图像模型只负责照片/插画/质感。
 */
import { posix } from "node:path";

import { defineTool } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";

import type { Settings } from "../config.ts";
import { workspacePath } from "./fetch-asset.ts";

const IMAGE_CAP_BYTES = 25 * 1024 * 1024;
const MAX_N = 4;

const text = (message: string) => [{ type: "text" as const, text: message }];
const fail = (message: string) => ({ output: text(message), isError: true });

export class MissingImageKey extends Error {}

export interface ImageRequest {
  readonly prompt: string;
  readonly size?: string | undefined;
  readonly quality?: string | undefined;
  readonly n?: number | undefined;
  readonly background?: string | undefined;
  readonly outputFormat?: string | undefined;
  readonly model?: string | undefined;
}

export interface ImageResult {
  readonly bytes: Uint8Array;
  readonly index: number;
  /** PNG 是否带 alpha；非 PNG 为 null。 */
  readonly alpha: boolean | null;
}

/** PNG IHDR 的 color type：4 = 灰度+alpha，6 = RGBA。 */
export function pngHasAlpha(bytes: Uint8Array): boolean | null {
  if (bytes.length < 26) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const colorType = bytes[25];
  return colorType === 4 || colorType === 6;
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`generated image is larger than ${Math.round(max / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function downloadImage(url: string, fetcher: typeof fetch): Promise<Uint8Array> {
  const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
  if (response.status !== 200) throw new Error(`image download answered HTTP ${response.status}`);
  const kind = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!kind.startsWith("image/")) throw new Error(`image download is ${kind || "not an image"}`);
  return readCapped(response.body, IMAGE_CAP_BYTES);
}

async function failureReason(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } };
    const message = payload.error?.message;
    return typeof message === "string" ? `: ${message.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

export async function generateImages(
  settings: Settings,
  request: ImageRequest,
  fetcher: typeof fetch = fetch,
): Promise<ImageResult[]> {
  if (settings.openaiApiKey === undefined || settings.openaiApiKey.length === 0) {
    throw new MissingImageKey("image generation unavailable: no OPENAI_API_KEY configured.");
  }

  const n = Math.max(1, Math.min(request.n ?? 1, MAX_N));
  const body: Record<string, unknown> = {
    model: request.model ?? settings.imageModel,
    prompt: request.prompt,
    size: request.size ?? "1024x1024",
    quality: request.quality ?? "high",
    n,
  };
  if (request.background !== undefined) body["background"] = request.background;
  if (request.outputFormat !== undefined) body["output_format"] = request.outputFormat;

  const response = await fetcher(`${settings.openaiBaseUrl.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.openaiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  if (response.status !== 200) {
    throw new Error(`image generation failed: HTTP ${response.status}${await failureReason(response)}`);
  }

  const payload = (await response.json()) as {
    data?: { b64_json?: unknown; url?: unknown }[];
  };
  const items = Array.isArray(payload.data) ? payload.data : [];
  const results: ImageResult[] = [];
  for (const [index, item] of items.entries()) {
    let bytes: Uint8Array | undefined;
    if (typeof item.b64_json === "string") {
      bytes = Uint8Array.from(Buffer.from(item.b64_json, "base64"));
    } else if (typeof item.url === "string") {
      bytes = await downloadImage(item.url, fetcher);
    }
    if (bytes === undefined) continue;
    results.push({ bytes, index, alpha: pngHasAlpha(bytes) });
  }
  return results;
}

export function createImageTool(settings: Settings) {
  return defineTool({
    name: "generate_image",
    description: [
      "Generate images with an OpenAI-compatible image model and save them under /workspace.",
      "Use it for photography, illustration, texture and background imagery.",
      "Anything with a logo or exact copy must be built in HTML on brand instead.",
      "Pass background='transparent' and output_format='png' for cut-outs.",
    ].join("\n"),
    parameters: obj({
      prompt: str({ description: "What the image should show." }),
      path: str({ description: "Destination path under /workspace, e.g. /workspace/projects/x/hero.png." }),
      size: opt(str({ description: "Provider size, e.g. 1024x1024 or 1536x1024." })),
      quality: opt(str({ description: "Provider quality, default high." })),
      n: opt(num({ description: `How many images, 1 to ${MAX_N}. Multi-image paths get _0, _1 suffixes.` })),
      background: opt(str({ description: "Provider background, e.g. transparent." })),
      output_format: opt(str({ description: "Provider output format, e.g. png." })),
      model: opt(str({ description: "Override the configured image model." })),
    }),

    async execute(args, api, context) {
      const env = api.env;
      if (env === undefined) return fail("image generation unavailable: this run has no workspace.");

      let target: string;
      try {
        target = workspacePath(args.path);
      } catch {
        return fail("path must be under /workspace.");
      }

      try {
        const results = await generateImages(settings, {
          prompt: args.prompt,
          size: args.size,
          quality: args.quality,
          n: args.n,
          background: args.background,
          outputFormat: args.output_format,
          model: args.model,
        });
        if (results.length === 0) return fail("image generation returned no images.");

        const extension = posix.extname(target);
        const stem = extension.length > 0 ? target.slice(0, -extension.length) : target;
        const written: string[] = [];
        const notes: string[] = [];
        for (const result of results) {
          const path = results.length > 1 ? `${stem}_${result.index}${extension}` : target;
          const saved = await env.writeFile(path, result.bytes, context);
          if (!saved.ok) return fail(`could not write ${path} (${saved.error.code}).`);
          written.push(path);
          if (args.background?.toLowerCase() === "transparent" && result.alpha !== null) {
            notes.push(`${path}: alpha ${result.alpha ? "present" : "missing"}`);
          }
        }
        return { output: text([`wrote ${written.join(", ")}`, ...notes].join("\n")) };
      } catch (error) {
        if (error instanceof MissingImageKey) return fail(error.message);
        return fail(
          `image generation unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}
