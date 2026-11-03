/**
 * 打开 Harness：SQLite 存储、模型、工具、每个会话一个容器。
 *
 * 这里就是"Agent 循环与沙箱执行分离"的落点：
 * Harness 在宿主机跑，工具通过 ExecutionEnv 伸进容器。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  Harness,
  createRegistry,
  defineExtension,
  section,
  type Conversation,
  type ConversationId,
  type Registry,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import type { Settings } from "../config.ts";
import { LocalOutboxAdapter, type DeliveryAdapter } from "../delivery/adapter.ts";
import { ensureRunning, type ContainerOptions } from "../env/container.ts";
import { DockerExecutionEnv } from "../env/docker-execution-env.ts";
import { RpcClient } from "../env/rpc.ts";
import { stageWorkspace } from "../staging/stage.ts";
import { fetchAssetTool } from "../tools/fetch-asset.ts";
import { createImageTool } from "../tools/image.ts";
import { createMediaTools } from "../tools/media.ts";
import { listProjectsTool, renderStatusTool } from "../tools/projects.ts";
import { RenderTask } from "./render-task.ts";
import { startRenderTool } from "./render-tool.ts";
import { loadSkillIndex, renderSkillIndex } from "./skills.ts";
import { createUploadTool } from "./upload-tool.ts";

const preamble = (skillIndex: string): string => `You are a design agent working on your own computer.
Your computer is a Linux sandbox at /workspace: the brand pack under /workspace/brand,
skills under /workspace/skills, deterministic render and gate scripts under /workspace/tools,
and your own work under /workspace/projects.

Read the matching skill before you start: /workspace/skills/<name>/SKILL.md.
Run the gates in /workspace/tools before you call anything finished.

Long renders go through start_render, not bash: it returns immediately, keeps running in the
background, and sends you the result as a new message when it finishes. Keep working while it runs.

When the person should receive files, call upload_files. It never sends the same file twice in
this conversation, and a modified file is sent again.

Skills:
${skillIndex}`;

export interface Runtime {
  settings: Settings;
  harness: Harness;
  root: Conversation;
  /** 新建一条对话，用于一次干净的任务。 */
  create(): Promise<Conversation>;
  /** 某个对话的执行环境；附件下载和工具调用共用同一套容器与 staging。 */
  env(conversationId: ConversationId): Promise<ExecutionEnv>;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  /** 覆盖默认的本地 outbox；飞书入口会注入一个会同时上传到群的适配器。 */
  delivery?: DeliveryAdapter;
}

export async function openRuntime(
  settings: Settings,
  context: Context = BACKGROUND_CONTEXT,
  options: RuntimeOptions = {},
): Promise<Runtime> {
  if (settings.apiKey === undefined) {
    throw new Error("OPENCODE_API_KEY 未设置：在仓库根目录的 .env 里写一行，或导出环境变量");
  }

  mkdirSync(settings.dataDir, { recursive: true });
  const storage = await openNodeSqliteStorage(join(settings.dataDir, "design-agent.sqlite"));

  const models = createModels();
  models.setProvider(opencodeGoProvider());

  const containerOptions: ContainerOptions & { root: string } = {
    image: process.env["DESIGN_AGENT_SANDBOX_IMAGE"] ?? "design-agent-sandbox:local",
    mountDir: settings.runtimeDir,
    root: settings.root,
  };

  const clients = new Map<string, RpcClient>();
  const staged = new Set<string>();

  /** 容器 + staging + RPC 客户端；Harness 和飞书附件下载共用。 */
  const buildEnv = async (target: {
    conversationId: ConversationId | number | string;
    cwd?: string;
  }): Promise<ExecutionEnv> => {
    const conversationId = String(target.conversationId);
    const ref = ensureRunning(conversationId, containerOptions);

    if (!staged.has(ref.name)) {
      await stageWorkspace(conversationId, containerOptions);
      staged.add(ref.name);
    }

    let client = clients.get(ref.name);
    if (client === undefined) {
      client = RpcClient.docker(ref.name);
      clients.set(ref.name, client);
    }
    return new DockerExecutionEnv(client, {
      id: ref.name,
      cwd: target.cwd ?? "/workspace",
    });
  };

  const delivery =
    options.delivery ?? new LocalOutboxAdapter(join(settings.dataDir, "outbox"));

  const registry: Registry = createRegistry();
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "design-agent",
      tools: [
        startRenderTool,
        createUploadTool(delivery),
        fetchAssetTool,
        createImageTool(settings),
        ...createMediaTools(settings),
        listProjectsTool,
        renderStatusTool,
      ],
      tasks: [RenderTask],
      sections: [
        section("preamble", () => preamble(renderSkillIndex(loadSkillIndex(settings.root))), {
          tag: false,
        }),
      ],
    }),
  );

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: (target) => buildEnv(target),
    },
    context,
  );

  const root = await harness.root(context, {
    agent: { model: settings.model },
  });
  harness.resume();

  return {
    settings,
    harness,
    root,
    create: () =>
      harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: settings.model } },
        context,
      ),
    env: (conversationId: ConversationId) => buildEnv({ conversationId }),
    close: async () => {
      for (const client of clients.values()) client.close();
      await harness.close(context);
    },
  };
}
