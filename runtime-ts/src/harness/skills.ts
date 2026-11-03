/**
 * 技能索引：把 skills/<name>/SKILL.md 的 name 与 description 抽出来，
 * 放进系统提示。模型据此决定先读哪一个——技能文档本身仍靠 read 工具打开。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillSummary {
  name: string;
  description: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

const field = (block: string, key: string): string => {
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(block);
  return match?.[1]?.trim() ?? "";
};

export function loadSkillIndex(root: string): SkillSummary[] {
  const directory = join(root, "skills");
  if (!existsSync(directory)) return [];

  const skills: SkillSummary[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(directory, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;

    const block = FRONTMATTER.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    skills.push({
      name: field(block, "name") || entry.name,
      description: field(block, "description"),
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** 渲染成提示里的一段，保持一行一个技能。 */
export function renderSkillIndex(skills: SkillSummary[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}
