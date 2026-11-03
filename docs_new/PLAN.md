# Design Agent · 新架构计划

> 用 Pi Durable（TypeScript）替换现有 Python 的 Agent 运行时，实现 Agent 循环与沙箱执行分离、异步 ReAct、事件驱动与任务级崩溃恢复。
>
> 文档状态：草案（第 0 周）
> 最后更新：2026-11-03

---

## 1. 目标

### 1.1 一句话

把现有 Python 版的 **控制层**（Agent 循环、任务编排、状态持久化）换成 Pi Durable，
**执行层**（容器里的 Chrome / FFmpeg / HyperFrames / 脚本 / 技能 / 品牌）原样保留。

### 1.2 四个可验证的目标

| 目标 | 验收方式 |
|---|---|
| Agent 循环与沙箱执行分离 | 同一个工具代码，切换 `ExecutionEnv` 实现即可在本机 / 容器间搬移 |
| 异步 ReAct | `start_render` 立即返回 taskId，任务完成后自动唤醒主会话 |
| 事件驱动 | `watchEvents` 能推送对话事件给 CLI / API / 飞书 |
| 任务级崩溃恢复 | 中途 `kill -9`，重启后从最后检查点继续，副作用不重复 |

### 1.3 明确的非目标

- 不重写容器镜像（原样复用 `design-agent-sandbox:local`）
- 不重写 14 个 `.mjs` 渲染/门禁脚本
- 不重写 36 个技能文档
- 不在第一阶段接 Slack / 飞书（第 6 周）
- 不删除 Python 版（逐步替换，保留参考实现）

---

## 2. 现状与问题

### 2.1 现有架构（Python）

```text
入口 CLI / API / Slack / MDA
        ↓  thread_id
运行时适配 RuntimeProfile（四个答案）
        ↓
Agent 内核：模型 + 工具 + 36 技能 + 25 中间件 + 子代理
        ↓
执行环境：DockerSandboxBackend（deepagents BackendProtocol）
        ↓
每 thread 一个容器 + 一个卷
```

四个答案（`src/design_agent/runtime/profiles.py`）：

```python
backend_for     # 文件/命令去哪
staging_for     # 素材往哪灌
delivery        # 产物谁发
services        # 后台和唤醒怎么接
```

### 2.2 已经做到的部分

| 能力 | 现状 |
|---|---|
| 控制循环在宿主、执行在容器 | ✅ 已分离 |
| 会话记录独立保存 | ✅ `workspace/state/threads.sqlite` / Postgres |
| 执行环境可替换 | ✅ docker / host / langsmith 三种 binding |
| 容器可重建 | ✅ 卷保留，容器销毁后同卷重建 |
| 后台助手 | ✅ `start_task` + ledger + 心跳 |
| 崩溃后通知与续跑 | ⚠️ 通知 + 模型手动 `resume_task` |

### 2.3 三个明显的弱点

**① 边界是 shell 字符串，不是类型化接口**

`BaseSandbox` 把 `ls` / `read` / `write` / `grep` / `glob` 都翻译成 shell 命令，
再由 `docker exec` 执行并解析文本输出。二进制、编码、watch 都做不好。

**② 工具调用没有检查点**

一条 20 分钟的渲染命令跑到一半崩了，整条重来。恢复粒度是"任务"，不是"这一步"。

**③ 恢复依赖模型决策**

进程崩溃后，sweep 发现心跳过期 → 发 `TASK_INTERRUPTED` → 唤醒主线程 →
**模型自己决定**要不要 `resume_task`。框架不保证续跑。

### 2.4 一次真实运行的证据

```text
thread:  cli-7d494693
耗时:    约 43 分钟
调用:    约 150 次工具调用
产出:    design-review-1200x627.png（54 KB）
         design-review-2x-1200x627.png（138 KB）
         still/comp.html（2.1 KB）
容器:    design-agent-bff644e9f9a50efc
卷:      design-agent-ws-bff644e9f9a50efc
```

前 15 轮的真实顺序：读 6 轮技能与品牌 → `ls /workspace` → `mkdir` → 写 HTML
→ `brand-lint` 警告 → 修 → `html2png` 渲染 → `look` 看图 → 重建。

---

## 3. 目标架构

```text
┌──────────────────────────── 入口 ────────────────────────────┐
│  CLI（现在）    HTTP API（第 6 周）   飞书/Slack（第 6 周）      │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌────────────────────────── 事件网关 ───────────────────────────┐
│  requestId 去重 · 路由 · 外部线程 ↔ conversation 映射          │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌───────────────── Pi Durable Harness（宿主机进程）─────────────┐
│  Conversation · Task Graph · Reporter · SQLite · watchEvents │
│  resume() 任务级恢复        memo() 副作用幂等                  │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────────────────── 工具层 ───────────────────────────┐
│  CodingTools            宿主工具                  codemode    │
│  read · write · edit    生图 · 抓取 · 交付                  （可选）│
│  bash                   read_skill                            │
└───────────────────────────────┬──────────────────────────────┘
             ═════════ 分离边界 · ExecutionEnv ═════════
                                ▼
┌────────────────── DockerExecutionEnv（新写）──────────────────┐
│  转发 24 个方法 · 容器侧句柄管理 · 跑官方 conformance          │
└───────────────────────────────┬──────────────────────────────┘
                                │  RPC · docker exec -i 长连接
                                ▼
┌────────────────── 容器（每 conversation 一个）────────────────┐
│  pi-env-server.mjs  →  官方 NodeExecutionEnv（cwd=/workspace）│
│  Chrome · FFmpeg · HyperFrames · D2 · 字体        ← 复用      │
│  /workspace/brand      品牌包                     ← 复用      │
│  /workspace/skills     36 个技能                  ← 复用      │
│  /workspace/tools      14 个 .mjs 脚本            ← 复用      │
│  /workspace/fonts      字体                       ← 复用      │
│  /workspace/projects   模型产出                               │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────────────────── 外部服务 ─────────────────────────┐
│  模型 API（OpenCode Go）· 生图服务 · Slack/飞书                │
│  全部由宿主机直连，容器无网络、无密钥                           │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. 核心设计决策

### 4.1 ExecutionEnv：容器内跑官方实现 + RPC 代理

**问题**：`ExecutionEnv` 有 24 个方法，包括二进制分页读、按行扫描、目录流、
文件监听、符号链接、错误码。用 `docker exec cat` 逐条拼 shell 做不出来。

**方案**：

```text
宿主机                                  容器
DockerExecutionEnv  ──── JSON-RPC ────→  pi-env-server.mjs
  实现 ExecutionEnv                        └─ NodeExecutionEnv(cwd=/workspace)
  转发每个方法调用                              官方实现，已有 conformance 覆盖
```

**为什么不是另外两条路**：

| 方案 | 问题 |
|---|---|
| bind mount + 本机 `NodeExecutionEnv` | watch 在 Windows 挂载上不触发；IO 跨 VM 慢一个数量级；远程 Docker 不成立 |
| 每条操作一次 `docker exec` | 24 个方法全要自己拼 shell；`watch` 无解；每次一个新进程 |
| **容器内官方实现 + RPC** | 复用官方语义，watch 原生可用，一个长连接 |

**代价**：
- RPC 要支持流式 shell 输出和 watch 通知；
- 容器重建后句柄失效，要返回明确错误；
- 容器内 Node 版本必须与镜像一致。

**已核实的 1.5.0 行为**：`exec` 不返回 stdout，输出通过 `ShellExecOptions.onOutput(text, ctx, info)`
逐块回调；`ShellExecResult` 只有 `exitCode` 和可选的 `spillPath`。
所以 RPC 必须从一开始就按"流式回传"设计，不能先做同步返回再补。

### 4.2 异步 ReAct：Task + Reporter

```text
模型调 start_render
  → api.createTask(RenderTask, { ownership, background: true })
  → 立即返回 { status: "started", taskId }
  → 本轮结束

RenderTask 在容器里执行
  → 每个阶段 runtime.commit() 存检查点

Reporter 用 requestId 把结果 submit 回主会话
  → 主会话被唤醒，继续推理或交付
```

### 4.3 幂等：memo + outbox

```ts
// 先写意图，再执行副作用
if ((await runtime.memo(`delivered-${sha}`, ctx)) === undefined) {
  await runtime.memo(`delivered-${sha}`, true, ctx);
  await deliver(path);
}
```

覆盖对象：交付文件、发消息、上传、外部 API 调用。

### 4.4 检查点粒度

| 粒度 | 崩溃代价 | 写放大 |
|---|---|---|
| 一个 phase 做完 200 帧 | 全部重来 | 最低 |
| 每帧一个 phase | 只重做 1 帧 | 200 次 commit |
| **每 20 帧一批** | 重做 ≤20 帧 | 10 次 commit |

首批任务采用批次粒度，后续按实测调整。

### 4.5 模型与鉴权

```ts
{ provider: "opencode-go", modelId: "deepseek-v4.1-flash" }
```

- Pi AI 原生支持该 provider；
- 鉴权：`OPENCODE_API_KEY`；
- `ProviderDoc.sessionId` 自动加 `x-opencode-session` 头，无需手拼。

---

## 5. 复用 / 新建清单

### 5.1 原样复用（不动一行）

| 资产 | 位置 | 说明 |
|---|---|---|
| 沙箱镜像 | `design-agent-sandbox:local` | Chrome、FFmpeg、HyperFrames 0.8.169、D2、字体 |
| 镜像 recipe | `sandbox/Dockerfile`、`sandbox/setup.sh` | 重建镜像时仍用它 |
| 渲染脚本 | `workspace/tools/*.mjs`（14 个） | 容器内 `node` 调用 |
| 技能 | `skills/`（36 个） | 复制到 `/workspace/skills/` |
| 品牌包 | `examples/brands/example-studio` | 复制到 `/workspace/brand/` |
| 字体 | `fonts/` | 已烤进镜像 |
| 容器参数 | `runtime/sandbox/docker.py` | `--network none`、`--cap-drop ALL`、pids 限制、卷挂载 |

### 5.2 新建（TS）

| 模块 | 职责 |
|---|---|
| `runtime-ts/` 工程 | TypeScript + Node 24 |
| `DockerExecutionEnv` | 24 个方法转发 |
| `pi-env-server.mjs` | 容器内 RPC 服务端 |
| 容器生命周期 | 每 conversation 一容器一卷，空闲回收 |
| staging | 品牌 / 技能 / 脚本 / 字体灌进 `/workspace` |
| 宿主工具 | `generate_image`、`fetch_asset`、`deliver`、`read_skill` |
| `RenderTask` | 带检查点的渲染任务 |
| CLI | 第一阶段唯一入口 |
| 事件网关 | 第 6 周 |

### 5.3 不复用

| 资产 | 原因 |
|---|---|
| `src/design_agent/harness/` | 正是要替换的编排层 |
| `DockerSandboxBackend`（Python） | 接口不同，Pi 自带等价实现 |
| `surfaces/`（Slack / API） | Python 实现，用 TS 重写 |

---

## 6. 目录规划

```text
runtime-ts/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts                     CLI 入口
│   ├── config.ts                   Settings（从环境变量读）
│   ├── harness/
│   │   ├── open.ts                 Harness.open + SQLite storage
│   │   ├── registry.ts             工具与任务注册
│   │   └── events.ts               watchEvents → 输出
│   ├── env/
│   │   ├── docker-execution-env.ts 宿主机代理（24 个方法）
│   │   ├── rpc.ts                  JSON-RPC 编解码
│   │   └── container.ts            容器生命周期（创建/回收/卷）
│   ├── staging/
│   │   └── stage.ts                品牌/技能/脚本/字体
│   ├── tools/
│   │   ├── media.ts                generate_image 等
│   │   ├── fetch.ts                fetch_asset
│   │   ├── deliver.ts              deliver + memo
│   │   └── skill.ts                read_skill
│   ├── tasks/
│   │   ├── render.ts               RenderTask（阶段 + 检查点）
│   │   └── reporter.ts             结果回传
│   └── surfaces/
│       └── cli.ts
├── container/
│   └── pi-env-server.mjs           容器内 RPC 服务端
├── test/
│   ├── conformance.test.ts         官方 createEnvConformance
│   ├── recovery.test.ts            崩溃恢复
│   └── stage.test.ts               staging
└── README.md
```

---

## 7. 分阶段计划

### 第 1 周 · 执行环境 spike

**目标**：证明"容器内 NodeExecutionEnv + RPC 代理"可行。

| 任务 | 产出 |
|---|---|
| 建 `runtime-ts/` 工程 | `package.json`、`tsconfig.json`、`pnpm/npm install` 通过 |
| 写 `pi-env-server.mjs` | 容器内起 NodeExecutionEnv，stdin/stdout 跑 JSON-RPC |
| 写 `DockerExecutionEnv` | `readTextFile`、`writeFile`、`exec`、`listDir`、`exists` 先通 |
| 写 `RpcClient` | 请求/响应配对、超时、错误码 |
| 跑 conformance | 基础用例通过（文件读写、目录、错误码） |

**验收**：

```bash
node --test runtime-ts/test/conformance.test.ts
# 基础用例全绿，watch / symlink / listFiles 可能仍红
```

**风险**：RPC 流式输出与 watch 通知设计不对。**若第 1 周结束时基础用例不通，退回 bind-mount 方案（A）。**

---

### 第 2 周 · 完整 conformance + 容器生命周期

| 任务 | 产出 |
|---|---|
| 补完 24 个方法 | conformance 全绿 |
| watch 通知流 | 容器内 `fs.watch` 事件经 RPC 回传 |
| 二进制分页读 | `openBinaryReader` / `read` / `close` 句柄管理 |
| 容器管理 | 每 conversation 一容器一卷；空闲 TTL 回收；重建后句柄失效 |
| staging | 品牌 / 技能 / 脚本 / 字体灌入 `/workspace` |
| 两会话隔离 | 两个 conversation 互不可见 |

**验收**：

```bash
node --test runtime-ts/test/conformance.test.ts     # 全绿
node --test runtime-ts/test/stage.test.ts           # 两会话隔离
```

---

### 第 3 周 · CLI + 模型 + 存储

| 任务 | 产出 |
|---|---|
| `Harness.open` + SQLite | `runtime-ts/data/design-agent.sqlite` |
| 模型接入 | `opencode-go` / `deepseek-v4.1-flash` |
| `CodingTools` | read / write / edit / bash |
| CLI | `ask` / `resume` / `history` |
| `instructions.md` 精简版 | 根提示词 |

**验收**：

```bash
design-agent-ts ask "列出 /workspace 里的文件"
design-agent-ts ask --thread <id> "继续"
# 重启进程后历史仍在
```

---

### 第 4 周 · 第一条 vertical slice

| 任务 | 产出 |
|---|---|
| 技能加载 | 根提示词放索引 + `read_skill` 工具 |
| 渲染链路 | write HTML → `html2png.mjs` → `read` 看图 |
| 门禁 | `brand-lint.mjs`、`artifact-contract.mjs` |
| 品牌包 | `/workspace/brand` |

**验收**：一句话生成 1200×627 PNG，模型能看图并修正一次。

---

### 第 5 周 · 异步任务与交付

| 任务 | 产出 |
|---|---|
| `RenderTask` | 阶段 + 检查点 + memo |
| `start_render` 工具 | 立即返回 taskId |
| Reporter | 结果 submit 回主会话 |
| `deliver` | sha256 账本 + memo |

**验收**：

```text
提交长任务 → 立即返回 taskId → 主会话可继续接收指令
→ 任务完成 → 自动唤醒 → 结果出现在对话里
→ 重复交付同一文件 → 不重复发送
```

---

### 第 6 周 · 事件网关与入口

| 任务 | 产出 |
|---|---|
| Fastify API | `POST /threads/:id/messages`、`GET /threads/:id/events`（SSE） |
| 飞书 webhook | `requestId` 去重、线程映射 |
| 进度推送 | 从 `watchEvents` 转成平台消息 |

**验收**：重复 webhook 不重复创建任务；飞书 @ 触发任务。

---

### 第 7 周 · 故障注入与恢复

| 任务 | 产出 |
|---|---|
| 故障注入脚本 | 在 render / deliver / reporter 各阶段 `kill -9` |
| 恢复验证 | `harness.resume()` 从检查点继续 |
| 幂等验证 | 副作用只发生一次 |
| 指标 | 恢复耗时、重执行次数、成功率 |

**验收**：

```text
5 分钟任务中途被杀 → 重启 → 从第 N 批继续
→ 已渲染批次不重做
→ 已交付文件不重发
```

---

### 第 8 周 · 可观测性与文档

| 任务 | 产出 |
|---|---|
| 结构化日志 | 任务图、事件时间线 |
| 架构图 | 更新 `docs_new/` |
| 演示脚本 | 5 分钟全流程 |
| 简历描述 | 问题 / 方案 / 验证 |

**验收**：能在 5 分钟内演示「提交 → 后台执行 → 杀进程 → 恢复 → 交付」。

---

## 8. 验收标准总表

| 维度 | 标准 | 验证方式 |
|---|---|---|
| 执行环境 | 官方 conformance 全绿 | `node --test` |
| 隔离 | 两个 conversation 互不可见 | 自动化测试 |
| 网络 | 容器无出网 | `curl` 超时 |
| 密钥 | 容器内无凭据 | `env` 检查 |
| 异步 | 提交立即返回 | 手工 + 计时 |
| 恢复 | kill -9 后继续 | 故障注入 |
| 幂等 | 副作用只一次 | 交付台账比对 |
| 可观测 | 事件流可见 | CLI 输出 |

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Pi Durable 仍标 experimental（1.5.0） | API 变化 | 锁版本；外部包一层 adapter |
| RPC 协议设计不当 | 第 1 周卡住 | 先做最小可用（读/写/exec），后补 watch |
| 容器内 Node 版本不一致 | conformance 失败 | 镜像固定 Node 版本 |
| Windows 开发环境 | 路径/权限差异 | 核心逻辑用容器内 Linux；CI 用 Linux |
| 长任务慢且贵 | 演示体验差 | 先做静态图；视频放后期 |
| 技能加载器缺失 | 需自研 | `read_skill` 工具 + 提示词索引 |

---

## 10. 术语

| 术语 | 含义 |
|---|---|
| `ExecutionEnv` | Pi Durable 的执行环境接口，24 个方法，覆盖文件系统与 shell |
| `NodeExecutionEnv` | 官方实现，跑在本机文件系统 |
| `DockerExecutionEnv` | 本项目要实现，把调用转发进容器 |
| `Harness` | Pi Durable 的运行时，管理 conversation / task / storage |
| `Task` | 可持久化的状态机，每阶段提交检查点 |
| `memo` | 幂等记录，同名只保留第一次写入 |
| `conformance` | 官方一致性测试，验证 ExecutionEnv 实现 |
| `staging` | 把品牌 / 技能 / 脚本 / 字体灌进容器 |
| `分离边界` | 宿主控制层与容器执行层之间的接口 |

---

## 11. 待确认事项

1. 包管理器：npm / pnpm / bun（建议 pnpm，与现有 `sandbox/render` 一致）
2. TS 运行方式：`tsx` 直跑，还是先编译
3. 存储位置：`runtime-ts/data/` 还是复用 `workspace/state/`
4. Python 版是否在同一仓库继续保留 CI
5. 是否引入 codemode（建议第 4 周后再评估）
