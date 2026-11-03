/** 故障注入测试共用的命令与路径。 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Settings } from "../src/config.ts";

export const PROJECT = "/workspace/projects/recovery-check";
export const COUNT = `${PROJECT}/count.txt`;
export const OUTPUT = `${PROJECT}/out.txt`;

/** 每次执行都会往 count.txt 追加一个 x；用它证明渲染没有被重跑。 */
export const COMMAND =
  `mkdir -p ${PROJECT} && printf 'x' >> ${COUNT} && printf 'recovery-ok\\n' > ${OUTPUT}`;

export const PROMPT = `使用 start_render 工具，只调用一次，参数必须完全如下。
不要用 bash 自己执行这条命令。

command: ${COMMAND}
outputPath: ${OUTPUT}
label: recovery-check

start_render 返回后，你的回复必须只有四个字：已提交。`;

export const CONVERSATION_FILE = join(tmpdir(), "design-agent-recovery-conversation");

export const containerOptions = (settings: Settings) => ({
  image: process.env["DESIGN_AGENT_SANDBOX_IMAGE"] ?? "design-agent-sandbox:local",
  mountDir: settings.runtimeDir,
  root: settings.root,
});
