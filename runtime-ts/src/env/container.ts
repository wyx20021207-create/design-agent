/**
 * 容器生命周期：每个 conversation 一个容器 + 一个命名卷。
 *
 * 与 Python 版一致：无网络、cap-drop、pids 限制、只读挂载。
 * 空闲回收与句柄失效处理留到接上 Harness 之后（那时才有常驻进程）。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface ContainerOptions {
  image: string;
  /** 宿主机 runtime-ts 目录，挂载为容器里的 /opt/env（spike 期用，之后烘进镜像）。 */
  mountDir: string;
  prefix?: string;
}

export interface ContainerRef {
  name: string;
  volume: string;
}

export const namesFor = (
  conversationId: string,
  prefix = "design-agent",
): ContainerRef => {
  const hash = createHash("sha256").update(conversationId).digest("hex").slice(0, 16);
  return { name: `${prefix}-${hash}`, volume: `${prefix}-ws-${hash}` };
};

const docker = (args: string[]) =>
  spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });

const toDockerPath = (path: string): string => resolve(path).replace(/\\/g, "/");

/** 镜像自带的目录属于 root；这些交给 agent，它才有地方写。 */
const AGENT_DIRS = [
  "/workspace",
  "/workspace/projects",
  "/workspace/attachments",
  "/workspace/references",
  "/workspace/.renders",
];

/** 保证容器在跑；不存在就建，存在但停了就起。 */
export function ensureRunning(conversationId: string, options: ContainerOptions): ContainerRef {
  const ref = namesFor(conversationId, options.prefix);

  const state = docker(["inspect", "--format", "{{.State.Running}}", ref.name]);
  if (state.status === 0) {
    if (state.stdout.trim() !== "true") {
      const started = docker(["start", ref.name]);
      if (started.status !== 0) throw new Error(`docker start 失败: ${started.stderr}`);
    }
    return ref;
  }

  const created = docker([
    "run", "-d",
    "--name", ref.name,
    "--network", "none",
    "--cap-drop", "ALL",
    // root 需要这三项才能把卷里的文件交给 node 用户；agent 的 uid 一个都用不到。
    "--cap-add", "CHOWN",
    "--cap-add", "DAC_OVERRIDE",
    "--cap-add", "FOWNER",
    "--security-opt", "no-new-privileges",
    "-v", `${ref.volume}:/workspace`,
    "-v", `${toDockerPath(options.mountDir)}:/opt/env:ro`,
    options.image,
    "sleep", "infinity",
  ]);

  if (created.status !== 0) throw new Error(`docker run 失败: ${created.stderr}`);

  const chown = docker(["exec", "-u", "0", ref.name, "chown", "1000:1000", ...AGENT_DIRS]);
  if (chown.status !== 0) throw new Error(`chown 失败: ${chown.stderr}`);

  return ref;
}

/** 以 root 身份执行一段脚本，可选把 stdin 交给它（staging 的 tar 走这里）。 */
export function execAsRoot(
  container: string,
  script: string,
  input?: NodeJS.ReadableStream,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["exec", "-i", "-u", "0", container, "sh", "-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));

    if (input) input.pipe(child.stdin);
    else child.stdin.end();
  });
}

/** 读一个文件的原始内容；不存在返回 undefined。 */
export function readAsRoot(container: string, path: string): string | undefined {
  const result = docker(["exec", "-u", "0", container, "cat", "--", path]);
  return result.status === 0 ? result.stdout : undefined;
}
