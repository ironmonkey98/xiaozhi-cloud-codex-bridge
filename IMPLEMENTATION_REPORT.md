# 实施报告

日期：2026-10-09 ｜ 基线：`TECH_SPEC.md` V1.1 + 已授权工作区自动执行扩展（ADR 0002、0003） ｜ 版本：0.1.0

## 1. 环境与依赖（实测）

| 项 | 版本 |
|---|---|
| macOS / 架构 | Darwin 25.5.0 / arm64 |
| Node.js / npm | v26.7.0 / 11.19.0（`engines` 要求 ≥22.18，见 ADR 0001） |
| Codex CLI | codex-cli 0.162.0（Homebrew），登录方式：ChatGPT |
| `@openai/codex-sdk` | 0.162.0（自带同版本 codex 二进制） |
| `@modelcontextprotocol/server` / `client` | 2.3.1（v2 包；未混用 v1 导入路径） |
| zod / TypeScript | 4.6.5 / 7.0.2 |
| 出站桥接器 | `78/mcp-calculator` @ `c537f71`，venv：Python 3.9.6 + websockets 15.0.1 + python-dotenv 1.2.1 |
| 小智服务端类型 | 官方 xiaozhi.me 云端；接入点已在本机配置，pipe 实测 WSS 连接成功；真机语音验收仍为 NOT_RUN |

已核实的 SDK 接口：`Codex.startThread/resumeThread`、`Thread.runStreamed`（事件 `thread.started / item.completed / turn.failed / error`）、`TurnOptions.signal`、`ThreadOptions.sandboxMode / approvalPolicy / networkAccessEnabled / webSearchMode / skipGitRepoCheck`；MCP v2 `McpServer.registerTool(name, {inputSchema: z.object()}, cb)` + `StdioServerTransport`。

## 2. 阶段状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 接入点验证 | 本机连接 **PASS** / 真机 **NOT_RUN** | 接入点已配置，2026-10-09 重启后 WSS 连接成功；真机语音 ping 尚未验证。`mcp_pipe.py` 已安装，并用本地假接入点验证了与 stdio 适配器的协议兼容（协商 `2024-11-05`）。官方 `calculator.py` 依赖 fastmcp（Python ≥3.10），本机 Python 3.9 无法运行该示例，建议直接以 `codex_ping` 做 P0 验证 |
| P1 MCP 契约 | 本机 **PASS** / 真机 **NOT_RUN** | 7 个工具、Mock Codex、合同测试通过 |
| P2 只读 Codex | 本机 **PASS** | 真实 Codex 经 MCP→Gateway 全链路分析 demo、续话、取消均成功；幂等测试通过 |
| P3 稳定运行 | **部分完成** | 已完成：断线重连（mcp_pipe 自带 + 实测）、Gateway 崩溃恢复、日志脱敏、仅回环监听。**未完成**：LaunchAgent 自启动（`scripts/setup-launchagent.sh` 未提供） |
| P4 受控写入扩展 | 本机 **PASS** / 真机 **NOT_RUN** | 每项目 read-only / workspace-write；desk 可自动联网、安装项目依赖、运行程序与生成文档，无逐次确认；见 ADR 0002、0003 与 §9 |

## 3. 实际执行的命令与结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test`（单元 + 集成，Mock） | 60 / 60 pass |
| `npm run test:mcp`（dist stdio 合同） | 7 / 7 pass |
| `npm run test:pipe`（真实 mcp_pipe + 假接入点） | 1 / 1 pass |
| `npm run test:e2e`（真实 Codex） | 本轮只读 5/5；最终可写 2/2 分批通过，含联网安装 PPT 库与生成文件；见 §9 |
| `npm run doctor` | 全项 OK：Codex 登录、demo/desk 白名单、Gateway、mcp_pipe、已配置小智接入点 |
| 全链路手工（`npm run start:daemon` + `npm run mcp:call`，真实 Codex） | T-1 submit → succeeded（约 35 s）；T-2 continue → succeeded；T-3 cancel → canceled；demo 目录无新文件；日志中令牌/家目录出现次数 0；`lsof` 仅 `127.0.0.1:18765` |

真实 Codex 播报样例（T-1，“看看 demo 项目的测试为什么会失败”）：
> 测试失败是因为用例期待除以零返回 Infinity，但代码会抛出“除数不能为 0”的异常。我已复现：两个测试，一个通过，一个失败。

MCP Inspector 未使用：改用 `@modelcontextprotocol/client` 编写的自动化合同测试，以及 `scripts/mcp-call.ts` 做同等的 `tools/list` / `tools/call` 验证。

## 4. 验收清单 T01–T12

“本机”指 Mock 或真实 Codex 在本机的验证；“云端”指经 xiaozhi.me 与真实设备的验证。

| 测试 | 本机 | 云端 | 证据 / 说明 |
|---|---|---|---|
| T01 配置自检 | PASS | — | `npm run doctor`；缺 token/白名单/非 Git 目录均有明确报错（`tests/unit/security.test.ts`） |
| T02 官方云端连接 | — | 连接 PASS / 真机 NOT_RUN | pipe 日志确认 WSS 成功连接；真实设备交互未验收 |
| T03 小智语音调用 ping | PASS | NOT_RUN | 合同测试 + `mcp:call codex_ping` 返回“电脑已连接，Codex 可以使用” |
| T04 工具发现 | PASS | NOT_RUN | 只返回别名与 writable 标记；实际 MCP 列表返回 demo=false、desk=true |
| T05 项目只读分析 | PASS | NOT_RUN | 真实 Codex e2e + 全链路 T-1 |
| T06 长任务查询 | PASS | NOT_RUN | 提交 <2 s 返回 `queued`；`codex_get_latest_task` 取得结论；完成前不报完成 |
| T07 会话连续 | PASS | NOT_RUN | 真实 `resumeThread` 正确回答上一轮问题；全链路 T-2 续话 |
| T08 权限边界 | PASS（附读取风险） | NOT_RUN | 只读项目拒绝文件变更；可写项目内创建/修改/删除成功。真实探测器的外部创建/覆盖/删除、临时目录、符号链接逃逸和 .git 写入均返回 EPERM；两种模式不提供读取隔离，见 §5 |
| T09 网络隔离 | 部分 PASS | NOT_RUN | Gateway 仅回环监听；只读 Codex 网络关闭，可写项目按 ADR 0003 开放联网。断开真实出站网络后的恢复尚未验收 |
| T10 故障恢复 | PASS | NOT_RUN | stdio 适配器被杀后重连可查任务；mcp_pipe 断线重连（假接入点）后可查；Gateway 重启后未完成任务标记 `INTERRUPTED`、历史可查 |
| T11 隐私保护 | PASS | NOT_RUN | 脱敏单测；合同测试与全链路日志扫描令牌/家目录为 0；mcp_pipe 原始日志不含接入点 token |
| T12 否定断言 | PASS | — | 文档未声称连接 Dot、修改固件或桌面操作；未验证的真机项均标 NOT_RUN |

## 5. 已知风险与限制

1. **两种模式均不提供读取隔离；read-only 工作区外读取已再次实测。** 诱饵文件内容被 Codex 原样返回。指令拦截只能挡住显式请求。生产前建议使用专用低权限 macOS 用户运行，或只分析复制出来的隔离目录。详见 `docs/SECURITY.md`。
2. read-only 下 Codex 仍会执行不写盘的命令（例如 `node --test`）。
3. 同一接入点下的所有设备共享身份。
4. 越权拦截基于关键词，可能误拦或漏拦；它不是安全边界。
5. 小智云端对工具调用超时、description 长度、工具数量的限制没有公开资料，需真机确认。
6. Gateway 重启会中断运行中的任务（标记失败，需重新提交），不会自动续跑。

## 6. 与规范的偏差

| 项 | 规范 | 实现 | 理由 |
|---|---|---|---|
| Codex 沙箱 | V1.1 固定只读 | 按项目 read-only / workspace-write | 已授权专用文件夹内自动写入、安装项目依赖与联网，见 ADR 0002、0003；只读项目无网络 |
| SQLite 驱动 | 未指定（V1.0 建议 better-sqlite3） | Node 内置 `node:sqlite` | 免原生编译（ADR 0001） |
| Node 版本 | 22+ | ≥22.18 | 直接运行 TS 源码（类型剥离）用于测试与脚本 |
| 播报字段名 | submit 用 `spoken_text`、查询用 `spoken_summary` | 统一 `spoken_summary` | 一个字段名，降低云端 LLM 混淆 |
| `codex_ping` 输出 | `{ok, bridge_version, gateway_status}` | 另含 `codex_ready`、`spoken_summary` | 便于播报登录状态 |
| 脚本名 | `mock-mcp-call.ts` | `scripts/mcp-call.ts` | 同时支持 Mock 与真实 Gateway |
| mcp_pipe 依赖 | requirements.txt | 仅 websockets + python-dotenv | 其余包需 Python ≥3.10 且 stdio 模式不使用 |

## 7. 需要用户完成

1. Gateway 与 pipe 已重新启动，接入点连接成功；按 `docs/ACCEPTANCE.md` 完成真机 10 次验收，并试说“在桌面工作区里创建一个 hello world 程序”，回填结果。
2. 决定是否需要 LaunchAgent 自启动（P3 剩余项），以及是否采用专用 macOS 用户隔离读取。


## 8. 受控写入落地（2026-10-09）

- 已创建 `~/Desktop/xiaozhi-workspace` 并初始化 Git；`config/projects.json` 新增 `desk` / “桌面工作区” / `workspace-write`，demo 仍为只读。
- 修正 `workspace-write` 默认临时目录写权限：强制空附加根目录，排除 `/tmp` 与 `$TMPDIR`；清空继承 MCP 配置。安装、联网、提交推送、外部路径关键词仍先行拒绝；只读创建关键词回归通过。
- 新增真实 Codex 固定探测脚本验收；探测器未被修改，工作区内创建/修改/删除均成功，六个越界操作全部 `EPERM`。外部诱饵文件保持原值，未创建越界文件；测试诱饵已清理。
- 类型检查、构建、Mock 53/53、MCP 7/7、pipe 1/1、真实 Codex 6/6 均通过。首次在会话沙箱中运行 HTTP/MCP 检查受回环监听限制而未完成，改为允许本机监听后重跑通过。
- 旧 Gateway 与 pipe 已停止，重新构建并启动；`codex_ping` 返回在线且 `codex_ready=true`，`codex_list_projects` 返回 demo 只读与 desk 可写，pipe 日志确认连接官方 WSS。后台日志位于 `/tmp/xiaocdoex-gateway.log` 与 `/tmp/xiaocdoex-pipe.log`；仍未配置开机自启动。
- 本机 MCP→Gateway→真实 Codex 桌面工作区运行验证 PASS：T-7 在 desk 创建并运行随机命名 Python 程序，任务 succeeded；直接读取输出文件确认 `Hello, world!`，随后只清理本次测试的两个随机命名文件。
- 更新 SECURITY、CONTEXT 与 README，补 ADR 0002，同步 CLAUDE 约束与 MCP 指令字段说明。没有把读取隔离或真实设备语音调用记为通过。


## 9. 工作区自动执行权限调整（2026-10-09）

- 原因已复现：工作区的安装 python-pptx、npm install pptxgenjs、curl 下载均被关键词拒绝，可写 Codex 的网络也为关闭；“在桌面创建 PPT”还会被路径关键词误拦。历史任务 T-10 只生成 create_ppt.py，返回“缺少 python-pptx，尚未生成 PPT”。
- 可写模式现允许联网、实时搜索、项目依赖安装、chmod 与程序运行、真实 PPT/Word/Excel/PDF 文件生成，`approvalPolicy: never`。只读项目的权限继续保留。系统软件安装、sudo、提交推送、外部发送和工作区外写入不在此次授权内。
- Node 使用项目 node_modules；Python 使用项目 .venv，并设置 PIP_REQUIRE_VIRTUALENV；缓存与临时文件配置在 .cache、.tmp，npm 全局前缀为项目 .local/npm。缓存目录若是指向工作区外的符号链接会被拒绝。任务默认时限与本机 .env 从 180 秒提高到 600 秒。
- 实际 CLI 检查发现旧 `mcp_servers={}` 会合并继承配置，并没有关闭 cua_repl、node_repl。现改为枚举项目继承的服务器，用合法的完整禁用条目覆盖；无模型 CLI 自检确认所有服务器 enabled=false。首次逐项覆盖试验出现 invalid transport，已修正后重跑验收。
- 类型检查与构建 PASS，Mock 60/60、MCP 7/7、pipe 1/1 PASS。真实 Codex 只读 5/5 PASS；最终可写 2/2 PASS（分批运行）。首次 PPT 已生成，但严格缓存目录断言失败；修正为显式设置沙箱命令环境，并用固定 env-probe 验证实际 NPM_CONFIG_CACHE、TMPDIR、PIP_CACHE_DIR 与虚拟环境限制，重新验收通过。
- Gateway 与 pipe 已重新启动并加载新权限；正式 MCP 任务 T-11 succeeded：自动在工作区创建 .venv、安装 python-pptx 并运行原 create_ppt.py，生成 example_presentation.pptx。独立 ZIP/XML 校验 PASS，共五页，标题为 Python 自动生成 PPT、项目介绍、主要功能、使用方法、总结；使用本机中文字体完成 PDF 渲染与五页缩略图检查，中文显示正常，无明显重叠或裁切。
- 最终构建已加载，Gateway 与 pipe 均运行；codex_ping、项目列表与 doctor 通过，pipe 在 2026-10-09 16:54（上海时间）重新连接官方 WSS。
- 工作区内创建/修改/删除 PASS；外部创建/覆盖/删除、两种外部临时目录、符号链接逃逸和 .git 写入全部 EPERM。读取隔离与真实设备完整验收仍未声称通过；本轮是本机 MCP 链路与 Codex 的实测。


## 10. 无音频完成通知实验（2026-10-09）

- 用户授权登录云服务器并更新通知服务；独立 Mosquitto 通过现有 nginx HTTPS 的 `/codex-notify/mqtt` 提供 WSS，内部端口仅回环，既有应用保持运行。网关和设备使用不同随机凭据与主题 ACL，凭据未提交。
- 本机 `notify-relay` 已启动，Gateway 保持任务状态唯一来源。旁路只读任务数据库，自己的 outbox 持久化，15 分钟有效期、15 秒重试、QoS1/retained、唤醒请求回执与清理均已实现。没有向设备发送任务正文或音频。
- 真实云端软件探测 PASS：T-12 重放信号 119 字节、收发和回执成功、audio_sent=false。软件回执不影响正式旁路待通知状态。设备接收 NOT_RUN，不能将软件测试记为实机通过。
- Node 类型检查 PASS，单元/集成 64/64 PASS，MCP 合同 7/7 PASS。原有 Gateway/pipe 未重启，未新增 Codex 调用。
- USB 实读设备为 ESP32-C3 revision 1.1 / 8MB。基于 FoloToy 固定上游源码制作通知与程序查询补丁，ESP-IDF v6.1 构建 PASS。上游 host 测试 81 项出现 17 failures / 18 errors；未修改原版同样失败（删掉其他开发板后仍保留多板测试），未记录为全通过。
- 完整 Flash 备份未成功：USB 读取停滞，随后 Device not configured，串口消失。烧录 NOT_RUN；真实设备接收、自行唤醒、官方云端自动 MCP 查询、结果播报全部 NOT_RUN。等待 USB 恢复后先完成备份，再分段烧录保留 NVS 并验收。
- 提示音采用设备内置 popup，不下载外部 OGG；官方云端是否接受程序发出的 listen.detect 查询文本尚不确定。旁路 `wake_requested` 也不证明查询或播报成功。


### 10.1 实机烧录与 UI 回滚（2026-10-09）

- USB 恢复后用 esptool 5.5 完整备份 8MB，备份校验 PASS，权限 0600；原固件描述为 xiaozhi 2.5.1 / ESP-IDF v6.0.1，当日编译，分区布局与新构建一致。
- 已分段烧录通知实验固件，写入哈希校验 PASS。用户发现原 UI 消失，表明选用的厂商 2.5.0 底版及资源不符合现有设备 UI 保持要求。这是固件基线选择错误，不是本机 Gateway UI。
- 已立即完整恢复烧录前备份，8MB 写入哈希校验 PASS；用户明确确认原 UI 已回来。当前设备仍使用原固件，设备端通知功能没有启用。
- 云端通知服务、本机通知旁路与桥接继续运行。真实 ESP32 通知、自动查询和播报均未验收。
- 当前桥接仓库原历史不包含用户 2.5.1 的固件源码和 UI 资源；新增 firmware 目录仅是本次实验。已检查本机可见的相关项目和源码位置，尚未找到原版对应源码；重新适配前必须核对原固件来源，不能用实验底版继续替换。

### 10.2 正确原 UI 基线与官方查询限制

用户提供 `<固件源码目录>` 后，确认原发行应用与备份应用逐字节一致。使用独立构建目录保留 Muse 渲染器、像素素材、显示初始化和引脚；新增 UI 烧录前检查。ESP-IDF v6.1 构建及 99 项 host 测试通过。应用单独烧录到 ota_0 的 0x20000，不更新 NVS、OTA 和资源。

独立 WSS/MQTT 通知已被实机接收并回执，T-13 已请求唤醒。原固件将系统时间加上时区偏移用于 UI，通知 UTC 校验对此单独补偿；显示时间不变。通过 listen.detect 发送查询句被官方云端拒绝（Detect is only for wake words），自动查询和播报未实现。修正路径改为只发送“你好小智”，API 改名 RequestNotificationWake，回执不能表示查询成功。relay 已暂停，已知 retained 通知已清理，任务状态不改动。后续必须验证受支持的查询输入方式。

修正版实机重放 T-12：`signal_received` / `wake_requested` 均通过。串口显示发送“你好小智”，云端仅回答“你好呀！有什么我可以帮你的吗？”，未自动查询任务。后续工具调用来自用户另说的新请求，不能算完成回调。没有观察到原 detect 报错，原 UI 继续渲染。

## 11. 自动结果播报落地（2026-10-09 晚）

- 已替代 detect 查询文本：固件正常 manual 会话上传固定16kHz/60ms Opus 查询句，查询期间关闭麦克风；无需外部 OGG 或扬声器自唤醒。保留原 Muse UI，仅刷应用区。
- 新增 `codex_get_notifications`，按配置 namespace 领取准确的冻结批次。成功、失败、超时保留24小时并合并，查询之后的新任务等下一批。当前查询回执和设备播放排空确认缺一不可；打断、断线、失败保留重试。
- 真机 PASS：固定句 ASR → 专用 MCP 工具 → 官方 TTS → 音频排空 → 固件完成 ACK。首次批次包括失败原因及 T-17 PPT 成功；T-18 重放成功，新任务 T-19 在20:34:44完成后20:34:55自动查询并完成播放确认。没有为通知测试启动新 Codex 任务。
- 生产 Gateway 监督 relay，配置加载后自动启动、意外退出5秒重启；已杀掉单独 relay 验证恢复，未中断正在执行的 T-19。Gateway/pipe 仍须在本机运行，尚无开机自启动。
- 验证：类型检查、构建、67项单元/集成、8项 MCP、1项 pipe PASS；原 UI guard、ESP-IDF v6.1构建、100项固件 host 测试 PASS。软件播放回执不等价于测量扬声器物理声压。
- 待听改进：自动待听、无云端回答待处理、输入连续安静15秒且播放排空时，让出原会话后执行通知查询；有声音、手动讲话或播放时继续等待。首次实机被底噪误判阻塞，已将 RMS 阈值从120调整为240并增加回归测试；修正后100项 host 测试及构建通过，已烧录并移除临时诊断。修正后的15秒待听接管实机专项验收 NOT_RUN，不能据 host 测试声称通过。

### 11.1 T-20 结果播报确认

T-20于20:59:50成功，21:00:02自动查询，随后收到固件播放完成回执。用户报告首次未听到后，以原终态任务重放，未启动新Codex任务。串口捕获完整结果语句、6页PPT及文件名，音频排空并回idle，硬件探测PASS；用户明确确认“听到了完整结果”。首次未听到的具体原因未确定，没有将重放成功当作原问题根因已修复。

## 12. 在线录音、转写与录音管理（2026-10-13 至 2026-10-14）

- 服务端：`recording-ingest`（MQTT 收录音，按序落盘、累计 ACK、Go-Back-N 重传，结束后封装 Ogg/Opus）已部署为 systemd 服务；百炼 Fun-ASR 自动转写；8443 独立站点提供录音 API 与百炼下载链接。MCP 新增 `recording_list`、`recording_get_transcript`、`recording_to_codex`，控制台共 11 个工具。
- 固件：长按 OK 录音，全屏录音界面显示计时、音量与云端已确认时长；录音期间不开对话，通知排队。UI 性能（FreeRTOS 运行时统计，5 分钟固定流程）：待机 LVGL 44% → 17%，播报时空闲 CPU 4% → 21%，开机最低堆 26 → 34 KB。
- 实机 PASS：64 s 录音两次 saved（0 丢帧、0 重传）；12 分 46 秒录音 12761 帧 0 缺失，停止后约 22 s 完成转写。录音中重启服务会如实降级为 partial（已作为运维规则）。
- 2026-10-14 固件：移植上游 `af55a78` 分级省电（60 s 变暗、6 min 软睡眠、深度睡眠改为 2 h），Codex 通知唤醒软睡眠，录音中 60 s 无按键变暗；恢复 CW2017 电池参数写入（电量图标）；通知 MQTT 重连 3 s，开机约 14 s 可录音。串口日志确认 70 s 变暗、370 s 软睡眠与电池参数匹配；按键与通知唤醒由用户目测确认，日志未捕获。
- 2026-10-14 管理网页：`/recording-api/ui/` 列表、播放、逐句转写、搜索、删除；密码登录换取会话 Cookie（服务器只存 scrypt 哈希，失败限流）。线上验证：错误密码 401、登录后列表、退出后 401、Bridge Bearer 仍可用。单元/集成 112 项 PASS。
- NOT_RUN：60 分钟录音耐久（R07）；按 README 在全新服务器从零部署；不带私有头的固件构建。偶发“开机自动重启一次”原因未定位。
