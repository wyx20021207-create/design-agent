/** 异步任务测试共用的命令、路径与容器参数。 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Settings } from "../src/config.ts";

export const PROJECT = "/workspace/projects/async-crash";
export const OUTPUT = `${PROJECT}/out.txt`;
export const GO = `${PROJECT}/go`;

/** 命令会一直阻塞到 go 文件出现，测试因此能精确控制任务何时完成。 */
export const COMMAND =
  `mkdir -p ${PROJECT} && while [ ! -f ${GO} ]; do sleep 0.5; done ` +
  `&& printf 'crash-ok\\n' > ${OUTPUT}`;

export const PROMPT = `使用 start_render 工具，只调用一次，参数必须完全如下。
不要用 bash 自己执行这条命令，也不要创建 go 文件。

command: ${COMMAND}
outputPath: ${OUTPUT}
label: async-crash

start_render 返回后，你的回复必须只有四个字：已提交。不要等待渲染，不要轮询。`;

/** 两次进程之间只传 conversation id。 */
export const CONVERSATION_FILE = join(tmpdir(), "design-agent-async-crash-conversation");

export const containerOptions = (settings: Settings) => ({
  image: process.env["DESIGN_AGENT_SANDBOX_IMAGE"] ?? "design-agent-sandbox:local",
  mountDir: settings.runtimeDir,
  root: settings.root,
});
