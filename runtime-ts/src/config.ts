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

export interface FeishuSettings {
  appId: string | undefined;
  appSecret: string | undefined;
  encryptKey: string | undefined;
  verificationToken: string | undefined;
  /** @ 提及默认显示的应用名；只用于日志与提示。 */
  botName: string;
}

export type ModelRef = { provider: "opencode-go"; modelId: string };

/** lead 与 worker 的模型；provider 目前只有 OpenCode Go。 */
export interface WorkerModels {
  low: ModelRef;
  xhigh: ModelRef;
  max: ModelRef;
}

export interface Settings {
  /** 仓库根目录：技能、脚本、示例品牌的来源。 */
  root: string;
  /** runtime-ts 目录：数据与容器挂载点。 */
  runtimeDir: string;
  /** SQLite 与其它持久化文件。 */
  dataDir: string;
  model: ModelRef;
  /** worker 分档模型；未配置的档位回落到 DESIGN_AGENT_WORKER_MODEL_ID 或 lead。 */
  workerModels: WorkerModels;
  /** parallel_looks 使用的模型。 */
  lookModel: ModelRef;
  apiKey: string | undefined;
  /** 宿主工具凭据；只在宿主机使用，绝不进容器。 */
  openaiApiKey: string | undefined;
  openaiBaseUrl: string;
  imageModel: string;
  elevenlabsApiKey: string | undefined;
  groqApiKey: string | undefined;
  feishu: FeishuSettings;
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

  const model = (modelId: string): ModelRef => ({ provider: "opencode-go", modelId });
  const lead = model(process.env["DESIGN_AGENT_MODEL_ID"] ?? DEFAULT_MODEL);
  const worker = process.env["DESIGN_AGENT_WORKER_MODEL_ID"] ?? lead.modelId;

  return {
    root,
    runtimeDir,
    dataDir: join(runtimeDir, "data"),
    model: lead,
    workerModels: {
      low: model(process.env["DESIGN_AGENT_WORKER_MODEL_LOW"] ?? worker),
      xhigh: model(process.env["DESIGN_AGENT_WORKER_MODEL_XHIGH"] ?? worker),
      max: model(process.env["DESIGN_AGENT_WORKER_MODEL_MAX"] ?? worker),
    },
    lookModel: model(process.env["DESIGN_AGENT_LOOK_MODEL_ID"] ?? worker),
    apiKey: process.env["OPENCODE_API_KEY"],
    openaiApiKey: process.env["OPENAI_API_KEY"],
    openaiBaseUrl: process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
    imageModel: process.env["DESIGN_AGENT_IMAGE_MODEL"] ?? "gpt-image-2.5-flare",
    elevenlabsApiKey: process.env["ELEVENLABS_API_KEY"],
    groqApiKey: process.env["GROQ_API_KEY"],
    feishu: {
      appId: process.env["FEISHU_APP_ID"],
      appSecret: process.env["FEISHU_APP_SECRET"],
      encryptKey: process.env["FEISHU_ENCRYPT_KEY"],
      verificationToken: process.env["FEISHU_VERIFICATION_TOKEN"],
      botName: process.env["FEISHU_BOT_NAME"] ?? "Design Agent",
    },
  };
}
