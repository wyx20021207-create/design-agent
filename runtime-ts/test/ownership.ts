/**
 * agent 自己的目录必须可写：projects、attachments、references、.renders。
 *
 *   npm run ownership
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

import { ensureRunning } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";
import { SPIKE } from "./spike.ts";

const conversationId = "ownership-check";
const ref = ensureRunning(conversationId, SPIKE);
const rpc = RpcClient.docker(ref.name);
const env = new DockerExecutionEnv(rpc, { id: ref.name });

const targets = [
  "/workspace/projects/probe.txt",
  "/workspace/attachments/probe.txt",
  "/workspace/references/probe.txt",
  "/workspace/.renders/probe.txt",
];

try {
  let failed = 0;
  for (const path of targets) {
    const written = await env.writeFile(path, "ok\n", ctx);
    if (written.ok) {
      console.log(`可写  ${path}`);
    } else {
      failed += 1;
      console.log(`不可写 ${path}  (${written.error.code})`);
    }
  }
  if (failed > 0) process.exitCode = 1;
} finally {
  rpc.close();
}
