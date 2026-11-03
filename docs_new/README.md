# docs_new

本目录记录把 Design Agent 的执行架构迁移到 **Pi Durable（TypeScript）** 的设计与计划。
与 `docs/` 下的上游文档无关；这里的文档随本项目演进。

| 文档 | 内容 |
|---|---|
| [PLAN.md](./PLAN.md) | 目标架构、核心决策、复用清单、8 周计划、验收标准 |

## 当前状态

- 第 0 周：计划草案
- 已完成：
  - `runtime-ts/` 工程骨架与依赖（pi-durable / pi-ai / chord 1.5.0）
  - 冒烟测试：本机 `NodeExecutionEnv` 的 `readTextFile` / `listDir` / `exec`
  - 容器内 `pi-env-server.mjs`（NDJSON 协议，全部方法 + 句柄 + exec 流式 + abort）
  - 宿主机 `RpcClient` + `DockerExecutionEnv`（完整 `ExecutionEnv` 接口）
  - 跨边界调用跑通：写文件 → 读回 → 列目录 → exec 流式输出 → 错误码
  - **官方 conformance 24/24 通过**
- 下一步：staging（品牌 / 技能 / 脚本 / 字体），然后进入容器生命周期与两会话隔离

## 与 `docs/` 的关系

- `docs/`：上游项目的架构与产品说明，保持只读
- `docs_new/`：本次重构的设计文档与实施计划
