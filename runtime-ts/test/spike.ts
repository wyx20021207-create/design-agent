/** 第 1 周 spike 用的容器与卷，测试之间共享，避免名字漂移。 */
export const SPIKE = {
  name: "design-agent-ts-spike",
  volume: "design-agent-ts-spike-ws",
  image: "design-agent-sandbox:local",
  mountDir: process.cwd(),
};
