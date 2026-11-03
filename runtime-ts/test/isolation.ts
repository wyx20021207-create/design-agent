/**
 * 会话隔离：两个 conversation 各有容器和卷，文件互不可见。
 *
 *   npm run isolation
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

import { ensureRunning, namesFor } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";
import { SPIKE } from "./spike.ts";

const alice = ensureRunning("isolation-alice", SPIKE);
const bob = ensureRunning("isolation-bob", SPIKE);

console.log("alice:", namesFor("isolation-alice").name);
console.log("bob:  ", namesFor("isolation-bob").name);

if (alice.name === bob.name || alice.volume === bob.volume) {
  throw new Error("两个会话拿到了同一个容器或卷");
}

const aliceRpc = RpcClient.docker(alice.name);
const bobRpc = RpcClient.docker(bob.name);
const aliceEnv = new DockerExecutionEnv(aliceRpc, { id: alice.name });
const bobEnv = new DockerExecutionEnv(bobRpc, { id: bob.name });

try {
  const written = await aliceEnv.writeFile("/workspace/alice.txt", "alice 的文件\n", ctx);
  if (!written.ok) throw new Error(written.error.message);

  const own = await aliceEnv.readTextFile("/workspace/alice.txt", ctx);
  console.log("alice 读自己写的文件:", own.ok ? "成功" : own.error.code);

  const peek = await bobEnv.readTextFile("/workspace/alice.txt", ctx);
  console.log("bob 读 alice 的文件:", peek.ok ? "竟然读到了 ✗" : `${peek.error.code} ✓`);

  const bobList = await bobEnv.listDir("/workspace", ctx);
  const leaked = bobList.ok && bobList.value.some((entry) => entry.name === "alice.txt");
  console.log("bob 的目录里有没有 alice.txt:", leaked ? "有 ✗" : "没有 ✓");

  if (peek.ok || leaked) process.exitCode = 1;
} finally {
  aliceRpc.close();
  bobRpc.close();
}
