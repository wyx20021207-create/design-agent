/**
 * 运行设置：仓库位置、数据目录、模型与凭据。
 *
 * `.env` 只做最少的事——读 KEY=VALUE、跳过注释、不覆盖已存在的环境变量。
 * 不引第三方 dotenv。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "deepseek-v4.1-flash";

export interface Settings {
  /** 仓库根目录：技能、脚本、示例品牌的来源。 */
  root: string;
  /** runtime-ts 目录：数据与容器挂载点。 */
  runtimeDir: string;
  /** SQLite 与其它持久化文件。 */
  dataDir: string;
  model: { provider: "opencode-go"; modelId: string };
  apiKey: string | undefined;
}

/** 读 `.env`，只填还没有值的变量。返回读到的键名，便于打印来源。 */
export function loadEnvFile(path: string): string[] {
  if (!existsSync(path)) return [];

  const keys: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return keys;
}

export function loadSettings(): Settings {
  const runtimeDir = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
  const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");

  loadEnvFile(join(root, ".env"));

  return {
    root,
    runtimeDir,
    dataDir: join(runtimeDir, "data"),
    model: {
      provider: "opencode-go",
      modelId: process.env["DESIGN_AGENT_MODEL_ID"] ?? DEFAULT_MODEL,
    },
    apiKey: process.env["OPENCODE_API_KEY"],
  };
}
