/**
 * start_render：把长任务丢到后台，立刻返回任务 id。
 *
 * 工具本身不渲染，只创建 RenderTask 并返回。渲染完成后由任务自己把结果作为一条
 * 输入投放回对话，模型因此获得新的一轮 run。
 */
import { defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";

import { RenderTask } from "./render-task.ts";

const MAX_COMMAND_LENGTH = 8_000;
const MAX_LABEL_LENGTH = 120;

const parameters = obj(
  {
    command: str({
      description:
        "Bash command to run in the container, with /workspace as the working directory. " +
        "It must write the artifact to outputPath before exiting.",
    }),
    outputPath: str({
      description: "Absolute artifact path under /workspace, for example /workspace/projects/card/render.png.",
    }),
    label: opt(
      str({
        description: "Short human-readable name shown in the completion message.",
      }),
    ),
  },
  { open: true },
);

/** 只允许 agent 自己的目录；`..` 一律拒绝，避免命令和产物落到 workspace 之外。 */
function validatePath(path: string): string | undefined {
  if (!path.startsWith("/workspace/")) return "outputPath 必须以 /workspace/ 开头";
  if (path.includes("\0")) return "outputPath 含非法字符";
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    return "outputPath 不能包含 . 或 .. 段";
  }
  return undefined;
}

const text = (message: string) => [{ type: "text" as const, text: message }];

export const startRenderTool = defineTool({
  name: "start_render",
  description: [
    "Start a long-running render in the background and return immediately with a task id.",
    "Use it instead of bash for anything that may take more than about 20 seconds:",
    "PNG/video renders, ffmpeg, HyperFrames, or multi-step shell pipelines.",
    "",
    "The command runs with bash in /workspace and must write its artifact to outputPath.",
    "Do not wait or poll: when the render finishes, a new message with the result arrives automatically.",
    "Keep working on other parts while it runs.",
  ].join("\n"),
  parameters,

  async execute(args, api, context) {
    const command = args.command.trim();
    if (command.length === 0) {
      return { output: text("start_render 参数错误：command 不能为空"), isError: true };
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      return {
        output: text(`start_render 参数错误：command 超过 ${MAX_COMMAND_LENGTH} 字符`),
        isError: true,
      };
    }
    if (args.label !== undefined && args.label.length > MAX_LABEL_LENGTH) {
      return {
        output: text(`start_render 参数错误：label 超过 ${MAX_LABEL_LENGTH} 字符`),
        isError: true,
      };
    }
    const invalid = validatePath(args.outputPath);
    if (invalid !== undefined) {
      return { output: text(`start_render 参数错误：${invalid}`), isError: true };
    }

    const id = await api.createTask(
      RenderTask,
      {
        command,
        outputPath: args.outputPath,
        ...(args.label === undefined ? {} : { label: args.label }),
      },
      { ownership: { kind: "conversation" }, background: true },
      context,
    );

    return {
      output: text(
        `已开始渲染，任务 ${id}。\n` +
          `产物：${args.outputPath}\n` +
          "完成或失败时你会收到一条新消息；现在可以继续做别的事。",
      ),
    };
  },
});
