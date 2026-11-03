/**
 * 把模型输出的 Markdown 转成飞书卡片能渲染的样子。
 *
 * 卡片 markdown 支持加粗、列表、链接、代码块，但不支持 `#` 标题和表格：
 *   - 标题 → 加粗一行
 *   - 表格 → 列表（两列时 `- **列一**：列二`）
 *   - 分隔线 → ———
 * 代码块里的内容原样保留。
 */

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

const splitRow = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
};

const stripBold = (text: string): string => text.replace(/\*\*/g, "");

/** 一张表 → 一组列表项。两列按「键：值」排，多列按列名排。 */
function tableToList(header: string[], rows: string[][]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.length === 0 || row.every((cell) => cell.length === 0)) continue;
    if (header.length === 2 && row.length >= 2) {
      lines.push(`- **${stripBold(row[0] ?? "")}**：${row[1] ?? ""}`);
      continue;
    }
    const parts: string[] = [];
    for (const [index, cell] of row.entries()) {
      if (cell.length === 0) continue;
      const label = header[index];
      parts.push(label === undefined || label.length === 0 ? cell : `**${label}**: ${cell}`);
    }
    if (parts.length > 0) lines.push(`- ${parts.join(" · ")}`);
  }
  return lines;
}

export function toCardMarkdown(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      output.push(line);
      continue;
    }
    if (inFence) {
      output.push(line);
      continue;
    }

    // 表格：当前行是表头，下一行是分隔行。
    if (line.trimStart().startsWith("|") && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      const header = splitRow(line);
      const rows: string[][] = [];
      index += 1; // 跳过分隔行
      while (index + 1 < lines.length && (lines[index + 1] ?? "").trimStart().startsWith("|")) {
        index += 1;
        rows.push(splitRow(lines[index] ?? ""));
      }
      output.push(...tableToList(header, rows), "");
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      output.push(`**${heading[2]}**`, "");
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push("———");
      continue;
    }

    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 卡片内容没有无限容量；按段落切，尽量不切在列表项中间。 */
export function chunkMarkdown(text: string, limit = 3_500): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n- "));
    const cut = boundary > limit / 2 ? boundary + (window[boundary] === "\n" ? 1 : 0) : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
