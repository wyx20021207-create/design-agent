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
  - **官方 conformance 24/24 通过**
  - **staging**：865 个文件（36 技能 / 14 脚本 / 品牌包 / 4 字体），digest 未变则跳过；
    root 所有、只读，agent 写入被拒
  - **容器生命周期**：conversation id → 容器名 + 卷名（sha256 前 16 位）
  - **会话隔离**：两个 conversation 的容器互不可见
- 下一步：第 3 周，CLI + Harness + 模型 + SQLite

## 与 `docs/` 的关系

- `docs/`：上游项目的架构与产品说明，保持只读
- `docs_new/`：本次重构的设计文档与实施计划
