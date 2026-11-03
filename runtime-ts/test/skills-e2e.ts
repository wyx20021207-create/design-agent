/**
 * 技能端到端抽查：真实模型 + 容器 + 技能脚本 + 门禁。
 *
 *   npm run skills-e2e -- chart
 *   npm run skills-e2e -- deck
 *   npm run skills-e2e -- video
 *
 * 每条都会新建一个 conversation（独立容器/卷），跑完后检查产物。
 */
import { withAbortSignal, BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

import { loadSettings } from "../src/config.ts";
import { openRuntime } from "../src/harness/runtime.ts";
import { messageText } from "../src/text.ts";
import { AssistantEntry } from "@earendil-works/pi-durable";

type Kind = "chart" | "deck" | "video";

const PROMPTS: Record<Kind, string> = {
  chart: `先读 /workspace/skills/data-viz/SKILL.md，再按它的规范做一张柱状图。

数据（不要改数字）：
Jan 96, Feb 88, Mar 91, Apr 34, May 31, Jun 29；单位 "min"；高亮 Apr；注记 Apr "One HTML page per size"。

把 spec 写到 /workspace/projects/chart-e2e/chart.json，out 为 "projects/chart-e2e/chart.png"，
svgOut 为 "projects/chart-e2e/chart.svg"（路径从 /workspace 解析）。

执行：
cd /workspace && node /workspace/skills/data-viz/scripts/viz.mjs --spec projects/chart-e2e/chart.json

把脚本输出的 JSON receipt、门禁结果和两个文件路径原样报告。不要自己画 SVG，也不要用别的渲染器。`,

  deck: `先读 /workspace/skills/stills/SKILL.md，再做一份 2 页静态 deck PDF，页面 1920×1080（20x11.25in）。

第 1 页：ink 底，signal 色的 "A second read" + paper 色的 "before you ship"，左上角小号 Example Studio 标记。
第 2 页：三条关于 design review 的短句，同一套品牌色和字体。

用 /workspace/brand 里的 tokens；HTML 写到 /workspace/projects/deck-e2e/deck.html；
先跑 brand-lint，再执行：
node /workspace/tools/html2pdf.mjs --html /workspace/projects/deck-e2e/deck.html --out /workspace/projects/deck-e2e/deck.pdf --size 20x11.25in --brand-fonts

报告门禁结果、PDF 路径和页数。不要用别的 PDF 工具。`,

  video: `先读 /workspace/skills/hyperframes/SKILL.md 和 /workspace/skills/hyperframes-core/SKILL.md。

在 /workspace/projects/video-e2e 做一个 3 秒、640×360 的 HyperFrames 合成：
ink 背景，paper 色的单词 "SHIP" 淡入并轻微移动。用容器里已安装的 hyperframes CLI，不要联网安装。

依次运行 npx hyperframes check 和渲染命令，产出 MP4 到 /workspace/projects/video-e2e/。
报告实际命令、门禁结果、MP4 路径和时长。做不出 MP4 就明确说卡在哪一步，不要假装成功。`,
};

const EXPECTED: Record<Kind, { path: string; minBytes: number }[]> = {
  chart: [
    { path: "/workspace/projects/chart-e2e/chart.png", minBytes: 2_000 },
    { path: "/workspace/projects/chart-e2e/chart.svg", minBytes: 500 },
  ],
  deck: [{ path: "/workspace/projects/deck-e2e/deck.pdf", minBytes: 5_000 }],
  video: [{ path: "/workspace/projects/video-e2e", minBytes: 1 }],
};

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const kind = (process.argv[2] ?? "chart") as Kind;
if (!(kind in PROMPTS)) {
  console.error("用法: npm run skills-e2e -- chart|deck|video");
  process.exit(2);
}

const settings = loadSettings();
const runtime = await openRuntime(settings);

try {
  const conversation = await runtime.create();
  const submission = await conversation.submit({ type: "input", content: PROMPTS[kind] }, ctx);
  console.log(`${kind}: 已提交，等待模型和渲染……`);
  const settled = await submission.wait(withAbortSignal(AbortSignal.timeout(20 * 60_000), ctx));
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(`任务没有完成：${settled.status}`);
  }
  const entry = await conversation.commit(
    (tx) => tx.entry(AssistantEntry, settled.answer),
    ctx,
  );
  const answer = messageText(entry?.model?.[0]);
  console.log(`\n回答：\n${answer.slice(0, 2_000)}\n`);

  const env = await runtime.env(conversation.id);
  for (const expected of EXPECTED[kind]) {
    if (kind === "video") {
      // 视频目录里找任意 mp4
      const listing = await env.listDir(expected.path, ctx);
      check(listing.ok, `无法列出 ${expected.path}`);
      const videos = listing.value.filter((item) => item.name.toLowerCase().endsWith(".mp4"));
      check(videos.length > 0, `${expected.path} 里没有 MP4`);
      const video = videos[0];
      check(video !== undefined && video.size >= expected.minBytes, "MP4 是空文件");
      console.log(`产物：${expected.path}/${video.name} (${video.size} bytes)`);
    } else {
      const info = await env.fileInfo(expected.path, ctx);
      check(info.ok, `产物不存在：${expected.path}`);
      check(info.value.kind === "file", `产物不是文件：${expected.path}`);
      check(info.value.size >= expected.minBytes, `产物太小：${expected.path} (${info.value.size} bytes)`);
      console.log(`产物：${expected.path} (${info.value.size} bytes)`);
    }
  }

  console.log(`\nPASS ${kind} 技能端到端`);
} catch (error) {
  console.error("\nFAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
