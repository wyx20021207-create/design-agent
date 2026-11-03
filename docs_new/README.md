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
  - **Harness + 模型 + CLI**：SQLite 存储、OpenCode Go（deepseek-v4.1-flash）、
    CodingTools 经 ExecutionEnv 进容器；`ask` 一句话即可让模型在容器里跑命令，
    重启进程后对话继续
  - **第一条 vertical slice**：技能索引进系统提示；模型自己读 stills / brand-design /
    design-wiki，写 BRIEF、渲染 1200×627、跑 brand-lint / artifact-contract /
    text-fidelity / review-thumb，并按看图结果改了两处
  - agent 目录归属：projects / attachments / references / .renders 交给 uid 1000
  - **异步 ReAct**：`start_render` 立刻返回 taskId；`RenderTask` 在后台跑命令、
    检查产物、写完成标记，再把回执作为一条输入投放回对话，唤醒模型开新一轮 run。
    崩溃后从最后一个 checkpoint 重跑，完成标记让重跑跳过已完成的工作
  - **故障注入**：`npm run recovery` 在渲染完成、回执未提交时硬退出；重启后从
    report 检查点续跑：不重渲染、回执一次、任务终态 completed
  - **交付幂等**：`upload_files` 在容器里算 sha256，对话级台账（Pi Durable doc）
    记录 (路径, 摘要)，只记确认送达的文件；同一文件第二次调用直接返回已交付。
    当前适配器把文件原子写入宿主机 `data/outbox/<conversation>/`
  - **入口层**：Fastify HTTP API（`POST /threads/:id/messages`、`GET /threads/:id/events`
    SSE、线程状态、outbox 文件下载），Bearer token 鉴权，`requestId` 去重，外部线程
    id 通过 Session 级文档映射到 Pi conversation；`npm run serve` 启动常驻进程
  - **飞书入口**：长连接（WebSocket）接收 `im.message.receive_v1`；`message_id` 作为
    requestId 持久去重；群/话题/私聊映射成外部线程键；回答与 `task.report` 经 watcher
    回到根消息；`upload_files` 把图片/文件上传到同一线程；线程状态持久化，重启后续推
  - **飞书交互**：Markdown 回复转互动卡片（标题→加粗、表格→列表、长文拆卡）；入站
    图片/文件下载到 `/workspace/attachments/`；收到即回执；超过 5 分钟的补投事件
    不执行；每条事件记日志
  - **宿主工具**：`fetch_asset`（SSRF 校验、重定向复检、50 MB）、`generate_image`
    （OpenAI 兼容接口、alpha 报告）、`generate_voiceover` / `generate_sound_effect` /
    `generate_music` / `transcribe_audio`（ElevenLabs / Groq，密钥只在宿主机）、
    `list_recent_projects` / `get_render_status`
  - **技能矩阵**：`npm run skills` 检查 36 个技能的 front matter、脚本与宿主工具引用
  - **子代理 / 并行 look**：`delegate` 建独立上下文子对话、共用父容器；`parallel_looks`
    一次拉起 2-4 个方向；child → parent 映射存 `design.subagents` 文档，重启后仍共享容器
  - **Steering**：飞书与 HTTP 在对话忙碌时用 `whenBusy:"steer"` 把补充要求并入当前 run
  - **worker 分档**：`delegate(effort)` 的 low → `DESIGN_AGENT_WORKER_MODEL_LOW`，
    max → `DESIGN_AGENT_WORKER_MODEL_MAX`，其余档位 → `DESIGN_AGENT_WORKER_MODEL_XHIGH`；
    未配置回落到 `DESIGN_AGENT_WORKER_MODEL_ID` 或 lead；超时按档位
    600/1200/1800/1800/2700 秒；`parallel_looks` 用 `DESIGN_AGENT_LOOK_MODEL_ID`
  - **长任务进度**：飞书每 5 分钟回一条“还在处理（已 N 分钟）：正在执行 X；第 N 轮；
    后台任务运行中”，空闲自动停；`DESIGN_AGENT_PROGRESS_MS` 可调
  - **沙箱清理**：`npm run prune` / `prune:volumes`，跳过有活跃 exec 的容器
- 下一步：技能端到端抽查（deck / 图表 / 视频），然后删除 Python 运行时

## 与 `docs/` 的关系

- `docs/`：上游项目的架构与产品说明，保持只读
- `docs_new/`：本次重构的设计文档与实施计划
