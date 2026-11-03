/**
 * 宿主工具检查：
 *   fetch_asset 的 SSRF/类型/大小约束
 *   projects 的列表与 run.json 读取
 *
 *   npm run tools
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

import { loadSettings } from "../src/config.ts";
import {
  FetchRefused,
  checkUrl,
  fetchAssetBytes,
  isPublicAddress,
  workspacePath,
} from "../src/tools/fetch-asset.ts";
import { listProjects, renderStatus } from "../src/tools/projects.ts";
import { generateImages, pngHasAlpha } from "../src/tools/image.ts";
import { requestMusic, requestSoundEffect, requestVoiceover, wordTimings } from "../src/tools/media.ts";
import { openRuntime } from "../src/harness/runtime.ts";

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function refuses(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    check(error instanceof FetchRefused, `${message}：抛出的不是 FetchRefused（${String(error)}）`);
    return;
  }
  throw new Error(`${message}：本应拒绝，实际通过`);
}

// --- SSRF 地址判定 ---
for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
  check(!isPublicAddress(address), `${address} 不应是公网地址`);
}
for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) {
  check(isPublicAddress(address), `${address} 应是公网地址`);
}

const publicResolver = async () => ["93.184.216.34"];
await checkUrl("https://example.com/a.png", publicResolver);
check(workspacePath("projects/x.png") === "/workspace/projects/x.png", "相对路径没有落到 /workspace");
check(workspacePath("/workspace/a.png") === "/workspace/a.png", "绝对路径被改了");
let escaped = false;
try {
  workspacePath("/etc/passwd");
} catch {
  escaped = true;
}
check(escaped, "越界路径本应被拒绝");

await refuses(checkUrl("ftp://example.com/a.png", publicResolver), "非 http 协议");
await refuses(checkUrl("https://user:pass@example.com/a.png", publicResolver), "带凭据 URL");
await refuses(checkUrl("http://localhost/a.png", publicResolver), "localhost");
await refuses(checkUrl("http://example.local/a.png", publicResolver), "内网域名");
await refuses(checkUrl("https://example.com:8443/a.png", publicResolver), "非标准端口");
await refuses(checkUrl("https://example.com/a.png", async () => ["127.0.0.1"]), "解析到内网");
await checkUrl("https://[2606:4700:4700::1111]/a.png", publicResolver);
await refuses(checkUrl("https://[::1]/a.png", publicResolver), "IPv6 回环");

// --- 下载管线 ---
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const okFetcher = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/redirect.png")) {
    return new Response(null, { status: 302, headers: { location: "https://example.com/final.png" } });
  }
  return new Response(png, {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(png.byteLength) },
  });
}) as typeof fetch;

const fetched = await fetchAssetBytes("https://example.com/redirect.png", {
  resolver: publicResolver,
  fetcher: okFetcher,
});
check(fetched.bytes.byteLength === png.byteLength, "重定向后的内容不对");
check(fetched.contentType === "image/png", "Content-Type 没有取到");

const svgFetcher = (async () =>
  new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } })) as typeof fetch;
await refuses(
  fetchAssetBytes("https://example.com/a.svg", { resolver: publicResolver, fetcher: svgFetcher }),
  "SVG",
);

const bigFetcher = (async () =>
  new Response(png, {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(51 * 1024 * 1024) },
  })) as typeof fetch;
await refuses(
  fetchAssetBytes("https://example.com/big.png", { resolver: publicResolver, fetcher: bigFetcher }),
  "超过 50 MB",
);

console.log("fetch_asset：地址 / 协议 / 凭据 / 端口 / 重定向 / 类型 / 大小  OK");

// --- generate_image ---
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngBytes = Uint8Array.from(Buffer.from(PNG_B64, "base64"));
check(pngHasAlpha(pngBytes) === true, "RGBA PNG 没有识别出 alpha");
check(pngHasAlpha(new Uint8Array([1, 2, 3])) === null, "非 PNG 不应报告 alpha");

let imageBody: Record<string, unknown> | undefined;
const imageFetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
  imageBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const settings = { ...loadSettings(), openaiApiKey: "test-key", imageModel: "test-image-model" };
const images = await generateImages(
  settings,
  { prompt: "a red circle", size: "1024x1024", n: 1 },
  imageFetcher,
);
check(images.length === 1, "图像结果数量不对");
check(images[0]?.bytes.byteLength === pngBytes.byteLength, "图像字节不对");
check(images[0]?.alpha === true, "图像 alpha 报告不对");
check(imageBody?.["model"] === "test-image-model", "请求没有带 image model");
check(imageBody?.["prompt"] === "a red circle", "请求没有带 prompt");

const missing = { ...loadSettings(), openaiApiKey: undefined };
let missingKey = false;
try {
  await generateImages(missing, { prompt: "x" }, imageFetcher);
} catch {
  missingKey = true;
}
check(missingKey, "没有 key 时应拒绝生图");

console.log("generate_image：请求体 / 图片解码 / alpha / 缺 key  OK");

// --- media helpers ---
const alignment = {
  characters: ["h", "i", " ", "t", "h", "e", "r", "e"],
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
};
const words = wordTimings(alignment);
check(words.length === 2, `词级时间数量不对：${words.length}`);
check(words[0]?.word === "hi" && words[1]?.word === "there", "词级切分不对");
check(words[1]?.start === 0.3 && words[1]?.end === 0.8, "词级时间不对");

const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
let voiceUrl = "";
let voiceBody: Record<string, unknown> | undefined;
const voiceFetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  voiceUrl = String(input);
  voiceBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  return new Response(
    JSON.stringify({ audio_base64: Buffer.from(audio).toString("base64"), alignment }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const elevenSettings = { ...loadSettings(), elevenlabsApiKey: "test-key" };
const voice = await requestVoiceover(
  elevenSettings,
  {
    text: "hi there",
    voiceId: "abcdefghij1234",
    speed: 1.1,
    stability: 0.5,
    outputFormat: "mp3_44100_192",
  },
  voiceFetcher,
);
check(voice.bytes.byteLength === audio.byteLength, "配音字节不对");
check(voice.words.length === 2, "配音词级时间不对");
check(voice.duration === 0.8, `配音时长不对：${voice.duration}`);
check(voiceUrl.includes("/text-to-speech/abcdefghij1234/with-timestamps"), "配音 URL 不对");
check(voiceBody?.["model_id"] === "eleven_v4", "配音没有带 model");
check((voiceBody?.["voice_settings"] as Record<string, unknown> | undefined)?.["speed"] === 1.1, "配音没有带 speed");

let effectBody: Record<string, unknown> | undefined;
const effectFetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
  effectBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  return new Response(audio, { status: 200 });
}) as typeof fetch;
const effect = await requestSoundEffect(
  elevenSettings,
  { prompt: "a soft click", durationSeconds: 1.5, loop: false },
  effectFetcher,
);
check(effect.byteLength === audio.byteLength, "音效字节不对");
check(effectBody?.["model_id"] === "eleven_text_to_sound_v2", "音效 model 不对");

let musicBody: Record<string, unknown> | undefined;
const musicFetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
  musicBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  return new Response(audio, { status: 200 });
}) as typeof fetch;
await requestMusic(elevenSettings, { prompt: "calm synth", lengthSeconds: 5 }, musicFetcher);
check(musicBody?.["music_length_ms"] === 5000, "音乐时长没有换算成毫秒");

console.log("media：词级时间 / 配音 / 音效 / 音乐请求  OK");

// --- projects ---
const runtime = await openRuntime(loadSettings());
try {
  const conversation = await runtime.create();
  const env = await runtime.env(conversation.id);
  const slug = `tool-check-${Date.now().toString(36)}`;
  const project = `/workspace/projects/${slug}`;

  await env.createDir(`${project}/renders`, { recursive: true }, ctx);
  await env.writeFile(`${project}/BRIEF.md`, "# brief\n", ctx);
  await env.writeFile(
    `${project}/run.json`,
    JSON.stringify({ status: "running", phase: "render", step: "poster" }),
    ctx,
  );
  await env.writeFile(`${project}/renders/a.png`, png, ctx);
  await env.writeFile(`${project}/renders/notes.txt`, "not an output", ctx);

  const listed = await listProjects(env, 50, ctx);
  check(listed.includes(slug), `项目列表里没有 ${slug}：${listed}`);
  check(listed.includes("1 render(s)"), `渲染数量不对：${listed}`);

  const status = await renderStatus(env, slug, ctx);
  check(status.includes("BRIEF.md yes"), `BRIEF 状态不对：${status}`);
  check(status.includes("renders: a.png"), `渲染列表不对：${status}`);
  check(status.includes('"status":"running"'), `run.json 没有读出来：${status}`);
  check((await renderStatus(env, "../etc", ctx)).includes("not allowed"), "非法项目名没有被拒绝");

  console.log(`projects：${slug} 列表 / 渲染 / run.json  OK`);
  console.log("\nPASS 宿主工具（fetch_asset + generate_image + media + projects）");
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
