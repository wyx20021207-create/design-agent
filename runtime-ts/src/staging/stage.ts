/**
 * staging：把技能、渲染脚本、品牌包和字体灌进会话的容器。
 *
 * 与 Python 版同样的三步：比摘要、解 tar、写标记。
 * 文件以 root 身份落盘并去掉写权限，agent（uid 1000）只能读。
 */
import { readFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import tar from "tar-stream";

import { ensureRunning, execAsRoot, readAsRoot, type ContainerOptions } from "../env/container.ts";
import { buildManifest, type Manifest } from "./manifest.ts";

const MARKER = "/workspace/.design-agent-ready";
const STAGED_ROOTS = [
  "/workspace/skills",
  "/workspace/tools",
  "/workspace/brand",
  "/workspace/fonts",
];

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export interface StageResult {
  container: string;
  staged: boolean;
  digest: string;
  files: number;
}

function stagingScript(manifest: Manifest): string {
  const roots = STAGED_ROOTS.join(" ");
  const families = manifest.requiredFamilies
    .map((family) => {
      const quoted = quote(family);
      return `[ "$(fc-match -f '%{family[0]}' ${quoted})" = ${quoted} ] || exit 23`;
    })
    .join("\n");

  return [
    "set -u",
    `rm -rf ${roots} && mkdir -p ${roots} || exit 21`,
    "tar -xzf - -C / --no-same-owner --no-same-permissions || exit 22",
    `chown -R 0:0 ${roots}`,
    `chmod -R a-w ${roots}`,
    "fc-cache -f /workspace/fonts >/dev/null 2>&1 || true",
    families,
    `printf '%s' ${quote(manifest.digest)} > ${MARKER}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function tarStream(manifest: Manifest): NodeJS.ReadableStream {
  const pack = tar.pack();
  const gzip = createGzip();
  pack.pipe(gzip);

  for (const asset of manifest.assets) {
    pack.entry(
      { name: asset.destination.replace(/^\//, ""), mode: 0o644 },
      readFileSync(asset.source),
    );
  }
  pack.finalize();
  return gzip;
}

/** 清单没变就跳过；返回 staged=false。 */
export async function stageWorkspace(
  conversationId: string,
  options: ContainerOptions & { root: string },
): Promise<StageResult> {
  const { name } = ensureRunning(conversationId, options);
  const manifest = buildManifest(options.root);

  if (readAsRoot(name, MARKER) === manifest.digest) {
    return { container: name, staged: false, digest: manifest.digest, files: manifest.assets.length };
  }

  const result = await execAsRoot(name, stagingScript(manifest), tarStream(manifest));
  if (result.code !== 0) {
    throw new Error(`staging 失败（exit ${result.code}）: ${result.stderr.trim().slice(0, 300)}`);
  }

  return { container: name, staged: true, digest: manifest.digest, files: manifest.assets.length };
}
