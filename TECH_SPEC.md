# 小智官方云端 MCP 接入本机 Codex：Claude Code 开发交付规范

> **版本：V1.1（云端小智修订版）｜2026-10-09**<br>
> **项目建议名：** `xiaozhi-cloud-codex-bridge`<br>
> **部署环境：** 用户现有 Mac（macOS），Node.js 22+，已登录 Codex CLI；小智设备继续使用 `xiaozhi.me` 官方云端<br>
> **交付类型：** 可执行研发需求与验收合同。本文不是已完成软件，不得把设计目标当作联调结果。

## 0. 关键修正与不可误解的事实

1. 用户使用的是 **https://xiaozhi.me/ 的官方云端服务**，不是自行部署 `xiaozhi-esp32-server`。**不开发小智语音服务端，不修改 ESP32 固件，不重做 ASR、LLM、TTS。**
2. 小智控制台的 **MCP 接入点**提供了云端智能体调用第三方 MCP 工具的路径。由 Mac 本机的 MCP 桥接程序**主动发起 WSS 出站连接**，不要求 Mac 对公网开放任何端口。
3. 这里不使用 ChatGPT Dot、Secure MCP Tunnel、MCP Events，不依赖 ChatGPT 桌面窗口或云端 VM。
4. Codex 被调用的正确方向是：**小智云端 MCP Client → Mac MCP Server（经出站桥接）→ Codex SDK → 授权工作区**。不要反写成 Codex 作为 MCP Client 调用小智。
5. `codex mcp-server` 已移除；本项目在 Mac 上调用官方 `@openai/codex-sdk`。Codex CLI 的登录凭据应由本机已有用户会话管理，禁止上传给小智。
6. 这是用户语音触发的远程工具调用。默认**只读、专用测试工作区、无外部 Shell 写入、无任意路径访问**。后续文件修改必须使用不同权限模式及本机确认。

## 1. 项目目标及使用场景

### 1.1 MVP 用户体验

- “小智，列出我允许你分析的项目。” → 返回本机预先配置的**项目别名**，不公布绝对路径。
- “分析 demo 项目的目录结构和核心模块。” → 小智调用 `codex_submit`；立即播报“任务已受理”，并得到短任务编号。
- “查一下刚才任务的结果。” → 云端通过 MCP 调用 `codex_get_latest_task`，返回状态；完成则播报短中文结论。
- “继续分析那个项目的测试模块。” → `codex_continue` 使用本项目保存的 Codex 线程，不假设继承 ChatGPT Dot 记忆。
- “取消刚才任务。” → `codex_cancel_task` 尽力中断并返回最终状态，不能声称一定已经杀死内部进程。
- “帮我删除项目、安装程序、发送邮件。” → MVP 必须拒绝，不得通过 prompt 绕过。

### 1.2 明确不做

- 不自建 / 迁移小智官方云端的 ASR、LLM、TTS，不在 ESP32 内部署 MCP Client。
- 不模拟声卡，不控制 ChatGPT Dot，也不接入 Dot 的记忆与任务。
- 不默认实现通用电脑控制、远程键鼠、截图、任意脚本执行。
- 不保证每轮语音都能同步得到 Codex 的最终结果。复杂任务采取**提交 → 查询**模式，避免 MCP 超时。
- 不在未确认用户权限和系统授权前获取真实屏幕，不将整张屏幕默认上传第三方服务。

## 2. 唯一默认架构（官方云端）

```text
小智 ESP32（原厂固件）
    ⇅ 设备原有协议（语音、TTS、表情）
小智 xiaozhi.me 官方云端（ASR + LLM + MCP Client + TTS）
    ⇅ 官方 MCP 接入点，WSS（由 Mac 主动出站建立）
Mac 上的 MCP Endpoint Bridge（首选官方示例 mcp_pipe.py，或兼容的 xiaozhi-client）
    ⇅ 本机 stdio MCP 协议（tools/list、tools/call）
Mac Codex MCP Adapter（薄适配，任务受理/查询/取消）
    ⇅ 127.0.0.1 + 本机令牌
Mac 常驻 Codex Gateway（SQLite 队列、会话、权限、日志）
    ⇅ 官方 @openai/codex-sdk
本机 Codex + 受控的项目工作区
```

**传输方向的重点：** Mac 主动连接云端 WSS；不是云端主动访问 `localhost`，不是 ESP32 直接调用 MCP，也不是 Secure MCP Tunnel。

### 2.1 出站 MCP 桥接器选择

| 选型 | 使用方法 | 结论 |
|---|---|---|
| **A：`78/mcp-calculator` 的 `mcp_pipe.py`** | 官方项目作者提供的示例；替换其 calculator stdio 命令为本项目 MCP Adapter | **P0 首选，变量少、协议路径清晰** |
| B：`shenjingnan/xiaozhi-client` | 社区集成程序，支持官方 xiaozhi.me 接入点、多 MCP Server、Web 管理 | P2 后可选；需锁定测试过的版本并检查当前 CLI/配置语法 |

Claude Code 必须先在真机 Mac 上跑通 A 路径的**无权限 ping 工具**。若 A 不兼容当前官方接入点，记录协议协商与错误日志，再切换 B。**不得同时重新实现两个完整的 MCP WebSocket 桥接器。**

### 2.2 获取接入点（用户操作）

1. 打开 `https://xiaozhi.me/console/agents` 并登录；选择正在使用的智能体。
2. 进入其 MCP 设置，点击“获取 MCP 接入点”，复制控制台返回的 **完整地址**。常见形态包含 `wss://` 和敏感 token，但实际以控制台为准。
3. 在 Mac 上使用本地私密 `.env` 或系统密钥存储保存，格式如 `XIAOZHI_MCP_ENDPOINT=<完整官方接入点>`。不得写入 Git、测试快照、聊天消息或任何日志。
4. 本机桥接器连接后，在控制台刷新接入点状态，确认工具可见；然后用真实小智设备发出语音调用。

**不能从公开网页获得用户的实际 MCP token，也不能仅凭本交付文档证明已登录或已经联调成功。**

## 3. 技术栈与接口基线

| 层级 | 建议技术 | 必须执行的检查 |
|---|---|---|
| 本机 Codex | `@openai/codex-sdk`（TypeScript） | 读取当前锁定版本类型；`Codex.startThread`、`resumeThread`、`thread.run` |
| Codex 授权 | 现有用户的 `codex login` | 仅运行在 Mac，不复制任何认证文件 |
| MCP Server | Model Context Protocol 官方 TypeScript SDK | 与 `mcp_pipe.py` 的 stdio MCP 协议版本兼容；不要混用 v1/v2 导入路径 |
| MCP 云端桥接 | `78/mcp-calculator/mcp_pipe.py` | WSS 出站、`tools/list`/`tools/call`、断线重连 |
| 可选桥接 | `shenjingnan/xiaozhi-client` | Node.js 22+；验证版本 CLI 与 stdio MCP 配置 |
| 任务服务 | Node.js HTTP，仅 `127.0.0.1` | 本地 Bearer token；MCP 断线任务不丢失 |
| 数据库 | SQLite | 幂等请求、任务状态、简短摘要、项目线程映射 |
| 文件范围 | 本地配置 + OS 隔离 | 不接受语音传来的绝对路径；只允许预设项目别名 |
| 运维 | macOS 用户级 LaunchAgent | 登录后自动启动、日志轮转、可停止 |

### 3.1 Codex SDK 调用约束

已核对的 TypeScript API 形态：

```ts
import { Codex } from '@openai/codex-sdk'
const codex = new Codex()
const thread = codex.startThread({
  workingDirectory: '/ABSOLUTE/PATH/TO/ISOLATED_DEMO',
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  networkAccessEnabled: false
})
const result = await thread.run('请只读分析这个测试目录，并返回简短中文摘要')
console.log(result.finalResponse)
```

`workingDirectory` 是工作目录设置，**并不等于严格的目录读取白名单**。Mac 上以同一用户身份运行的进程可能读取其他文件；首版必须在非敏感专用测试工作区验证，后续生产化考虑专门 OS 用户、受限容器或复制工作区隔离。`read-only` 与 `networkAccessEnabled:false` 还需要通过实际越权测试确认生效。

## 4. MCP 工具契约（MVP）

| 工具名 | 输入字段 | 输出字段 / 说明 |
|---|---|---|
| `codex_ping` | 无 | `{ok, bridge_version, gateway_status}`；不返回机器隐私 |
| `codex_list_projects` | 无 | `{projects:[{project_id,display_name}]}`，不返回物理路径 |
| `codex_submit` | `project_id`, `instruction`, 可选 `client_request_id` | `{accepted,task_id,status,spoken_text}`；立刻返回 |
| `codex_get_task` | `task_id` | `{status,spoken_summary,error_code}`；任务归属校验 |
| `codex_get_latest_task` | 可选 `project_id` | 查询本接入点最近任务，解决用户记不住任务号 |
| `codex_continue` | `project_id`, `instruction` | 继续本项目的专属线程，自动创建新任务 |
| `codex_cancel_task` | `task_id` | `{requested,actual_status}`，只能取消属于当前接入点的任务 |

所有工具描述以中文写清使用场景。输入由 `zod` 严格校验。项目别名来自静态 `projects.json`；MVP 的 `instruction` 建议最多 1,500 字、返回播报摘要最多 200 中文字，具体以小智服务端实测能力调整。MCP 工具错误必须返回可理解的中文信息，不返回堆栈、私密路径或环境变量。

### 4.1 `codex_submit` 处理示例

请求（示意，不作为官方小智请求协议）：

```json
{"project_id":"demo","instruction":"概括当前仓库的模块职责","client_request_id":"voice-001"}
```

返回（本项目工具的自定义结构）：

```json
{"accepted":true,"task_id":"T-1042","status":"queued","spoken_text":"已开始分析 demo 项目，稍后可以问我刚才的结果。"}
```

所有任务均由 Mac Gateway 异步处理；小智语音端只负责调用和播报。**不允许让 MCP tools/call 长时间阻塞等待 Codex 完成复杂任务。**

## 5. 任务生命周期与会话管理

1. **提交：** MCP Adapter 验证 `project_id`，本机 Gateway 写入 SQLite，生成短 task_id，在短时间内回执。
2. **执行：** Gateway 控制并发（默认 1 个任务），根据 project_id 映射独立 Codex 线程和隔离工作区，使用 SDK 启动只读分析。
3. **状态：** `queued / running / succeeded / failed / cancel_requested / canceled / timed_out`；每次状态变更持久化。
4. **恢复：** 桥接进程 WSS 断开后，Gateway 不终止任务；重新连接后可通过最新任务工具查询。
5. **播报：** 完成结果保留全文在本机数据库，小智只返回短中文 `spoken_summary`；不得一次返回整个仓库或大量源码。
6. **会话：** `project_id + endpoint_namespace` 映射到 thread_id。SDK 的 `resumeThread` 必须严格使用从本项目创建或批准继承的线程 ID。
7. **幂等：** `client_request_id` 存在时去重；若小智未携带该字段，对短时间同内容请求进行有限防重复，不应导致永久无法重试。
8. **取消：** 尽可能通过 SDK 中止运行，若底层接口无法强制中断，状态清楚反映“已请求取消”与实际停止区别。

注意：小智 MCP Endpoint 通常识别的是接入点，不保证把 ESP32 设备身份可靠转发。**首版以一个端点对应一个受信用户/设备组**，不要接受模型声称的任意 device_id 当作权限依据。多用户、多设备隔离须单独设计。

## 6. 安全要求（不得延期到以后）

- 端点地址中 token 是密钥：配置文件权限设为当前用户可读；所有日志脱敏 `token`、Authorization、Codex 凭据、家庭路径。
- Mac 只允许**向官方域名发起 WSS 出站连接**；本机 HTTP 仅监听 `127.0.0.1`，不得绑定 `0.0.0.0`、不得使用公网穿透开放本机管理端口。
- 首版仅读专用 demo 工作区，默认 `sandboxMode:'read-only'`、`approvalPolicy:'never'`、`networkAccessEnabled:false`；不要暴露 Shell、文件删除或写入工具。
- 过滤来自项目内容、README、网页或 MCP 返回值中试图更改系统规则的指令；Codex 输出视为待审核内容，不将其视为外部执行授权。
- 对命令行工具安装、代码修改、文件删除、网络请求、鼠标键盘操作、上传附件等设单独的本机交互式许可流程；MVP 均不实现。
- Codex 分析输出回传小智云端意味着**摘要会离开本机**；未经明确授权不得回传整个文件、API Key、私人记录、屏幕截图。
- 本地数据建议保留期 7 天可配、支持清理和关闭桥接器。若启动项失败或云端异常，默认关闭远程调用能力。

## 7. Claude Code 应创建的仓库结构

```text
xiaozhi-cloud-codex-bridge/
├── CLAUDE.md
├── README.md
├── .env.example
├── package.json / package-lock.json / tsconfig.json
├── config/projects.example.json
├── docs/DEPLOY_XIAOZHI_CLOUD.md
├── docs/SECURITY.md
├── docs/ACCEPTANCE.md
├── IMPLEMENTATION_REPORT.md
├── src/config.ts
├── src/mcp/stdio.ts
├── src/gateway/main.ts
├── src/gateway/http.ts
├── src/codex/runner.ts
├── src/codex/thread-store.ts
├── src/tasks/store.ts
├── src/tasks/queue.ts
├── src/security/policy.ts
├── src/security/path.ts
├── src/shared/schemas.ts
├── scripts/doctor.ts
├── scripts/mock-mcp-call.ts
├── scripts/setup-launchagent.sh
└── tests/{unit,contract,integration,e2e}/
```

`78/mcp-calculator` 的 mcp_pipe 可作为 `external/` 下**固定 commit 的依赖**，也可以在部署脚本中从经审查的版本安装；切勿无版本限制地 `curl | bash`。本机 Gateway 的数据库、日志、token、用户配置应在仓库以外的用户数据目录中。

## 8. 开发阶段与交付门槛

| 阶段 | 工作 | 完成证明 |
|---|---|---|
| **P0：接入点验证** | 官方云端控制台获取接入点，本机运行 `78/mcp-calculator` 示例 | 控制台显示在线、设备语音调用 `calculator` 成功（需用户提供本人 token） |
| **P1：MCP 契约** | 本机 `codex_ping`、`codex_list_projects` 与 Mock Codex；WSS 连接 | MCP tools/list 与 tools/call 真实可用；云端语音能调用 `ping` |
| **P2：只读 Codex** | 接入 SDK、SQLite、长任务、查询与续话 | `demo` 项目分析成功；重复请求不产生重复任务 |
| **P3：稳定运行** | 自动重连、LaunchAgent、敏感信息脱敏、崩溃恢复 | 断网再连、进程重启后结果可查询；Mac 不暴露公网监听 |
| **P4：扩展能力（独立审批）** | 截图分析、代码写入及本地授权 | 用户同意以后另立权限与验收项；不属于 MVP 完成条件 |

**实施顺序不能调换：** 未通过 P0 的官方云端真实 MCP 调用，不能把本机 Mock 成功写成云端联调成功。

## 9. 验收测试清单（12 项）

| 测试 | 判定标准 |
|---|---|
| T01 配置自检 | 缺少 token / Codex 登录 / 不存在项目目录时提示明确，进程不泄密 |
| T02 官方云端连接 | 控制台 MCP Endpoint 在线、工具列表真实可见 |
| T03 小智语音调用 | 语音“测试本机连接”成功触发 `codex_ping` |
| T04 工具发现 | `codex_list_projects` 只显示允许的别名 |
| T05 项目只读分析 | 对 demo 项目启动并完成 Codex 任务 |
| T06 长任务查询 | 提交后立即回执，稍后通过 `codex_get_latest_task` 查询结论 |
| T07 会话连续 | 相同项目后续任务可以恢复本项目线程 |
| T08 拒绝越权 | 非白名单路径、删除/写入/命令执行请求被拦截 |
| T09 网络隔离 | 关闭出站网络后连接失败可恢复；Mac 无公网服务端口 |
| T10 故障恢复 | MCP WSS 断线、桥接重启后可查询本地已记录任务 |
| T11 隐私保护 | 日志中不存在 MCP token、Codex 凭据、绝对家目录 |
| T12 否定断言 | 不宣称连接现有 Dot、改变 ESP32 固件或已实现桌面操作 |

测试报告必须区分 `PASS / FAIL / BLOCKED / NOT_RUN`，分别记录本地模拟测试和官方云端真实设备测试。未取得真实端点或设备时，只能报告 `BLOCKED`，不能编造成功。

## 10. 部署快速指引（示例，不含密钥）

1. 用户在 Mac 上确认 `codex --version`、`codex login`；为项目创建安全的 `~/CodexVoiceSandbox/demo`，其中只放公开测试文件。
2. 用户登录小智官方控制台，取得自己的 MCP Endpoint 地址，保存到本地私密 `.env`。
3. Claude Code 生成/启动本机 Gateway 和 MCP stdio Adapter；先用本地 MCP Inspector 验证工具。
4. 使用已审核的官方 `mcp_pipe.py` 连接接入点，并把 stdio 服务指向编译输出入口。控制台显示在线后从小智语音调用 `codex_ping`。
5. 用户发出“分析 demo 项目”的语音，检查本地任务队列、Codex 回复和小智查询播报。
6. 若使用 `xiaozhi-client` 替代桥接器，应先对实际已安装的版本运行 `xiaozhi --help`、核对配置格式及管理界面的监听地址，再配置自动启动。

本方案不要求额外设置 Secure MCP Tunnel，亦不需要向路由器开放端口。**只有用户的 Mac 开机且 Gateway 和出站桥接器在运行时，小智才能使用本机 Codex。**

## 11. 官方/项目资料（开发时复核）

- 小智 AI 官方入口：https://xiaozhi.me/home/zh/
- 小智控制台：https://xiaozhi.me/console/agents
- Seeed Studio：小智 MCP 接入点说明：https://wiki.seeedstudio.com/cn/mcp_endpoint/
- 小智作者 MCP 示例：https://github.com/78/mcp-calculator
- 社区聚合客户端：https://github.com/shenjingnan/xiaozhi-client
- OpenAI Codex SDK：https://developers.openai.com/codex/sdk
- Codex TypeScript 参数源码：https://github.com/openai/codex/blob/main/sdk/typescript/src/threadOptions.ts
- MCP TypeScript SDK：https://github.com/modelcontextprotocol/typescript-sdk
