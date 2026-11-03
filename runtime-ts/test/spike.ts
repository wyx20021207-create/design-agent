/** 第 1 周 spike 用的环境参数：容器与卷由 conversationId 派生。 */
import { fileURLToPath } from "node:url";

const runtimeDir = fileURLToPath(new URL("..", import.meta.url));

export const SPIKE = {
  conversationId: "ts-spike",
  image: "design-agent-sandbox:local",
  /** 宿主机上要挂进 /opt/env 的目录。 */
  mountDir: runtimeDir.replace(/[\\/]$/, ""),
  /** 仓库根目录：技能、脚本、示例品牌的来源。 */
  root: fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, ""),
};
