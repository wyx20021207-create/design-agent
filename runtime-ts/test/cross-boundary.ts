/**
 * 第一个里程碑：宿主机代码 → 容器内的 NodeExecutionEnv → 结果回来。
 *
 *   npm run cross
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { ensureRunning } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";

import { SPIKE as SPEC } from "./spike.ts";

const ctx = BACKGROUND_CONTEXT;

const ref = ensureRunning(SPEC.conversationId, SPEC);
console.log("容器就绪");

const rpc = RpcClient.docker(ref.name);
const env = new DockerExecutionEnv(rpc, { id: ref.name });

try {
  const written = await env.writeFile("/workspace/hello.txt", "来自宿主机的问候\n", ctx);
  if (!written.ok) throw new Error(`writeFile: ${written.error.message}`);
  console.log("写入成功: /workspace/hello.txt");

  const read = await env.readTextFile("/workspace/hello.txt", ctx);
  if (!read.ok) throw new Error(`readTextFile: ${read.error.message}`);
  console.log("读回内容:", JSON.stringify(read.value));

  const listed = await env.listDir("/workspace", ctx);
  if (!listed.ok) throw new Error(`listDir: ${listed.error.message}`);
  console.log("目录条目:", listed.value.map((entry) => entry.name).join(", "));

  let streamed = "";
  const exec = await env.exec(
    "node -v; echo '---'; ls /workspace",
    {
      onOutput: (text, _context, info) => {
        streamed += text;
        if (info.stream === "stderr") process.stderr.write(text);
      },
    },
    ctx,
  );
  if (!exec.ok) throw new Error(`exec: ${exec.error.message}`);
  console.log("退出码:", exec.value.exitCode);
  console.log("流式输出:\n" + streamed.trimEnd());

  const missing = await env.readTextFile("/workspace/不存在.txt", ctx);
  if (missing.ok) throw new Error("缺失文件竟然读成功");
  console.log("错误码:", missing.error.code);

  console.log("\n跨边界调用成功。");
} finally {
  rpc.close();
}
