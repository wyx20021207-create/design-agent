/**
 * 36 个技能的静态矩阵：
 *   - 每个 SKILL.md 有 name/description
 *   - 引用的 /workspace/tools 与 /workspace/skills 文件真实存在
 *   - 引用的宿主工具都已注册
 *
 * 这是“技能依赖检查”，不跑模型；端到端仍按 stills / deck / diagram / video 抽查。
 *
 *   npm run skills
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");
const skillsRoot = join(root, "skills");
const toolsRoot = join(root, "workspace", "tools");
const binariesRoot = join(root, "skill-binaries");

const HOST_TOOLS = [
  "start_render",
  "upload_files",
  "fetch_asset",
  "generate_image",
  "generate_voiceover",
  "generate_sound_effect",
  "generate_music",
  "transcribe_audio",
  "list_recent_projects",
  "get_render_status",
];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const field = (block: string, key: string): string =>
  new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(block)?.[1]?.trim() ?? "";

const failures: string[] = [];
const toolSkills = new Map<string, string[]>(
  HOST_TOOLS.map((name) => [name, [] as string[]]),
);
const skills: {
  name: string;
  folder: string;
  description: string;
  tools: string[];
  references: number;
}[] = [];

const exists = (path: string): boolean => existsSync(path);

/** 所有技能里的 .mjs 文件名；技能文档会跨技能引用脚本。 */
const scriptIndex = new Set<string>();
function collectScripts(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectScripts(path);
    else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
      scriptIndex.add(entry.name);
    }
  }
}
collectScripts(skillsRoot);

/** 检查一个技能内引用的路径是否存在。 */
function checkReference(skill: string, reference: string): void {
  const clean = reference.replace(/[).,;:]+$/, "");
  if (clean.includes("${") || clean.includes("<")) return;

  const tools = /^\/workspace\/tools\/(.+)$/.exec(clean);
  if (tools !== null) {
    const relative = tools[1];
    if (relative === undefined) return;
    const path = join(toolsRoot, relative);
    if (!exists(path)) failures.push(`${skill}: missing ${clean}`);
    return;
  }

  const skillPath = /^\/(?:workspace\/)?skills\/([^/]+)\/(.+)$/.exec(clean);
  if (skillPath !== null) {
    const owner = skillPath[1];
    const relative = skillPath[2];
    if (owner === undefined || relative === undefined) return;
    const candidates = [join(skillsRoot, owner, relative), join(binariesRoot, owner, relative)];
    if (!candidates.some(exists)) failures.push(`${skill}: missing ${clean}`);
    return;
  }

  const bare = /^([A-Za-z0-9_-]+\.mjs)$/.exec(clean);
  if (bare !== null) {
    const script = bare[1];
    if (script === undefined) return;
    if (!scriptIndex.has(script) && !exists(join(toolsRoot, script))) {
      failures.push(`${skill}: missing script ${clean}`);
    }
  }
}

for (const name of readdirSync(skillsRoot).sort()) {
  const directory = join(skillsRoot, name);
  if (!statSync(directory).isDirectory()) continue;
  const file = join(directory, "SKILL.md");
  if (!exists(file)) {
    failures.push(`${name}: SKILL.md missing`);
    continue;
  }

  const text = readFileSync(file, "utf8");
  const block = FRONTMATTER.exec(text)?.[1] ?? "";
  const declared = field(block, "name") || name;
  const description = field(block, "description");
  if (description.length === 0) failures.push(`${name}: description missing`);

  const references = new Set<string>();
  for (const match of text.matchAll(/\/workspace\/tools\/[A-Za-z0-9._/-]+/g)) references.add(match[0]);
  for (const match of text.matchAll(/\/workspace\/skills\/[A-Za-z0-9._/-]+/g)) references.add(match[0]);
  for (const match of text.matchAll(/\/skills\/[A-Za-z0-9._/-]+/g)) references.add(match[0]);
  for (const line of text.split(/\r?\n/)) {
    if (!/\bnode\s/.test(line)) continue;
    for (const match of line.matchAll(/\b[A-Za-z0-9_-]+\.mjs\b/g)) references.add(match[0]);
  }
  for (const reference of references) checkReference(name, reference);

  const usedTools = HOST_TOOLS.filter((tool) => new RegExp(`\\b${tool}\\b`).test(text));
  for (const tool of usedTools) toolSkills.get(tool)?.push(name);

  skills.push({ name: declared, folder: name, description, tools: usedTools, references: references.size });
}

console.log(`skills: ${skills.length}`);
console.log("\nhost tools referenced:");
for (const [tool, users] of toolSkills) {
  console.log(`  ${tool.padEnd(24)} ${users.length}  ${users.slice(0, 6).join(", ")}${users.length > 6 ? "…" : ""}`);
}

console.log("\nskills without host tools (HTML/render-only paths):");
console.log(
  "  " +
    skills
      .filter((skill) => skill.tools.length === 0)
      .map((skill) => skill.folder)
      .join(", "),
);

if (failures.length > 0) {
  console.error("\nFAIL 引用了不存在的路径：");
  for (const failure of failures) console.error("  " + failure);
  process.exitCode = 1;
} else {
  console.log("\nPASS 技能矩阵：front matter / 文件引用 / 宿主工具");
}
