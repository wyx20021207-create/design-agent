/**
 * 容器生命周期：第 1 周只在测试里用，形态与 Python 版一致。
 *
 * 每 conversation 一个容器 + 一个命名卷，容器无网络、无特权。
 * 正式的回收、句柄失效处理放在第 2 周。
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface ContainerSpec {
  name: string;
  volume: string;
  image: string;
  /** 宿主机上 runtime-ts 的目录，挂载为容器里的 /opt/env（只读）。 */
  mountDir: string;
}

const docker = (args: string[]) =>
  spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });

const toDockerPath = (path: string): string => resolve(path).replace(/\\/g, "/");

export function ensureContainer(spec: ContainerSpec): void {
  const running = docker(["inspect", "--format", "{{.State.Running}}", spec.name]);

  if (running.status === 0) {
    if (running.stdout.trim() !== "true") {
      const started = docker(["start", spec.name]);
      if (started.status !== 0) {
        throw new Error(`docker start 失败: ${started.stderr}`);
      }
    }
    return;
  }

  const created = docker([
    "run",
    "-d",
    "--name", spec.name,
    "--network", "none",
    "--cap-drop", "ALL",
    // root 需要这三项才能把卷里的文件交给 node 用户；agent 的 uid 一个都用不到。
    "--cap-add", "CHOWN",
    "--cap-add", "DAC_OVERRIDE",
    "--cap-add", "FOWNER",
    "--security-opt", "no-new-privileges",
    "-v", `${spec.volume}:/workspace`,
    "-v", `${toDockerPath(spec.mountDir)}:/opt/env:ro`,
    spec.image,
    "sleep", "infinity",
  ]);

  if (created.status !== 0) {
    throw new Error(`docker run 失败: ${created.stderr}`);
  }

  const chown = docker(["exec", "-u", "0", spec.name, "chown", "1000:1000", "/workspace"]);
  if (chown.status !== 0) {
    throw new Error(`chown 失败: ${chown.stderr}`);
  }
}
