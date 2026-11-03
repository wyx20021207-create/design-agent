/**
 * 要灌进容器的文件清单。
 *
 * 四个来源：技能、渲染脚本、品牌包、字体。
 * digest 覆盖每个文件的目的地、内容哈希和必需字体家族，和 Python 版一致——
 * 清单没变就不重复上传。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";

const SKIPPED = new Set([".DS_Store", "__pycache__", "node_modules", ".git"]);
const SAMPLE_BRAND = "examples/brands/example-studio";

export interface Asset {
  source: string;
  /** 容器内的绝对路径。 */
  destination: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  assets: Asset[];
  requiredFamilies: string[];
  digest: string;
}

const sha256Of = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const walk = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
};

const collect = (source: string, destination: string, into: Asset[]): void => {
  if (!existsSync(source)) return;
  for (const file of walk(source)) {
    into.push({
      source: file,
      destination: `${destination}/${relative(source, file).replace(/\\/g, "/")}`,
      sha256: sha256Of(file),
      size: statSync(file).size,
    });
  }
};

/** 有 brand.toml 就用它，否则退回示例品牌，与 Python 的 resolved_brand_path 一致。 */
export function brandRootOf(root: string): string {
  const configured = join(root, "workspace", "brand");
  if (existsSync(join(configured, "brand.toml"))) return configured;
  return join(root, SAMPLE_BRAND);
}

interface FontEntry {
  family?: string;
  file?: string;
  sha256?: string;
}

export function buildManifest(root: string): Manifest {
  const assets: Asset[] = [];

  collect(join(root, "skills"), "/workspace/skills", assets);
  // 技能的二进制文件单独放，合并回同名技能目录。
  const binaries = join(root, "skill-binaries");
  if (existsSync(binaries)) {
    for (const name of readdirSync(binaries)) {
      collect(join(binaries, name), `/workspace/skills/${name}`, assets);
    }
  }
  collect(join(root, "workspace", "tools"), "/workspace/tools", assets);
  collect(brandRootOf(root), "/workspace/brand", assets);

  const fontsToml = join(brandRootOf(root), "fonts.toml");
  const families: string[] = [];
  if (existsSync(fontsToml)) {
    const parsed = parseToml(readFileSync(fontsToml, "utf8")) as { fonts?: FontEntry[] };
    for (const font of parsed.fonts ?? []) {
      if (font.family) families.push(font.family);
      if (!font.file) continue;
      const source = join(root, font.file);
      if (!existsSync(source)) continue;
      const sha256 = sha256Of(source);
      if (font.sha256 && font.sha256 !== sha256) {
        throw new Error(`字体哈希不符: ${font.file}`);
      }
      assets.push({
        source,
        destination: `/workspace/fonts/${basename(source)}`,
        sha256,
        size: statSync(source).size,
      });
    }
  }

  const lines = [
    ...assets.map((asset) => `${asset.destination}\t${asset.sha256}`),
    ...families.map((family) => `font\t${family}`),
  ].sort();

  const destinations = new Set(assets.map((asset) => asset.destination));
  if (destinations.size !== assets.length) {
    throw new Error("two sources stage to the same destination");
  }

  return {
    assets,
    requiredFamilies: [...new Set(families)],
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
}
