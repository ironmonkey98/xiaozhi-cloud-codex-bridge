# 安全模型

## 信任边界

| 来源 | 信任 | 处理 |
|---|---|---|
| 小智云端 LLM 的工具参数 | 不可信 | zod 严格校验；只接受 `project_id` 别名；无路径、无 `device_id` 参数 |
| 语音指令文本 | 不可信 | 越权关键词与路径引用拦截（`APPROVAL_REQUIRED` / `PATH_NOT_ALLOWED`），不启动 Codex |
| 仓库内容（README/注释/日志） | 不可信 | 指令包装中声明为数据；硬边界是 sandbox |
| 本机 MCP 适配进程 | 受信 | 持 `LOCAL_BRIDGE_TOKEN`；注入 `BRIDGE_NAMESPACE` 作为调用方身份 |

## 已落实措施

- **Gateway**：只能绑定回环地址（配置校验拒绝其他值）；所有接口要求 `Authorization: Bearer`（SHA-256 后常数时间比较）；拒绝带 `Origin` 的请求与非回环 `Host`（防浏览器 / DNS rebinding）；请求体 ≤16 KB。
- **Codex**：项目配置只允许 `read-only` / `workspace-write`，调用方不能改变模式；固定 `approvalPolicy: 'never'`。只读项目无网络、无 Web 搜索；可写项目允许网络与实时搜索。不跳过 Git 检查，无 `danger-full-access` 入口。清空全局附加可写根目录，排除外部 `/tmp` 与 `$TMPDIR`，清空继承的 MCP 工具。传给 Codex 子进程的环境变量剔除 `LOCAL_BRIDGE_TOKEN` 与接入点地址。
- **工作区自动执行**：可写项目支持变更文件、安装项目依赖、下载资料、运行程序、制作真实 PPT/Word/Excel/PDF，无弹窗审批；Node 使用项目 node_modules，Python 使用 `.venv`，缓存放 `.cache`、临时目录放 `.tmp`，npm 全局前缀指向项目 `.local/npm`。只读项目继续拒绝文件变更、依赖安装、显式执行与联网下载。两种模式均拦截系统管理、sudo/brew 安装、提交推送、外部发送与外部路径引用；“在桌面创建/制作……”会归一为所选可写工作区。关键词与提示词不能代替沙箱，取消也不会回滚已完成的文件变更。
- **工作区**：配置加载时 `realpath` 解析符号链接；必须是 Git 仓库根目录；拒绝根目录、家目录及其上级。
- **任务隔离**：查询、取消、幂等、会话均按接入点身份隔离。
- **资源**：全局并发 1、队列上限、超时（默认 600 s，给依赖安装与文档生成留出时间）、可取消。
- **隐私**：日志统一脱敏（URL token、Bearer、`sk-`、家目录）；对外不返回物理路径、堆栈、环境变量；完整结果只存本机 SQLite（`~/.xiaozhi-codex-bridge/`，目录 0700），按保留期清理。
- **接入点 token**：只存 `.env`（0600，gitignore）；`start-pipe.sh` 输出经 sed 脱敏。

## 已知风险（实测）

1. **两种模式都不提供读取隔离。** 2026-10-09 的 read-only 实测（codex-cli 0.162.0，macOS）中，工作区外临时诱饵文件被原样返回；切换到 workspace-write 也不增加读取限制。因此：
   - 白名单只决定“工作目录”，不是文件读取边界；
   - 指令拦截可挡住显式路径/敏感词，但无法防御间接方式（例如仓库内容诱导）；
   - 读到的内容可能进入播报摘要并经小智云端离开本机。

   **缓解建议**（生产前应至少采用其一）：用专用低权限 macOS 用户运行 Gateway 与 Codex（该用户的家目录中不放任何凭据）；或仅把需要分析的代码复制到隔离目录。
2. **只读写入阻断曾实测有效**：要求 Codex 写文件时返回 `operation not permitted`，文件未产生。可写模式的验收脚本见 `tests/e2e/codex-real.test.ts`：检查工作区内创建/修改/删除，以及外部文件创建/覆盖/删除、`/tmp`、`$TMPDIR`、符号链接逃逸与 `.git` 写入的系统拒绝；最新执行结果见 `IMPLEMENTATION_REPORT.md`。
3. **只读命令仍可执行**：read-only 下 Codex 可运行不写盘的命令（实测会运行 `node --test` 复现失败用例）。网络已关闭。
4. **同一接入点下的多台设备共享身份**，彼此可见任务。多用户隔离需另行设计。
5. **`mcp_pipe.py` 把完整环境变量传给子进程**（含接入点地址）。stdio 适配器不记录环境变量，Codex 子进程的环境已剔除该变量。
6. **可写项目网络开放。** 下载资料与安装依赖无需确认，网络没有限定为包仓库白名单；包安装可能运行安装脚本。文件写入仍受沙箱限制，网络不能代替读取隔离。

## 不做（MVP）

截图、任意路径写入、独立 Shell 工具、键鼠控制、公网监听、Secure MCP Tunnel、ChatGPT Dot。

## 配置依据与决策

Codex 的临时目录排除项与附加可写根目录定义见 [官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)，自动执行与网络配置见 [官方权限说明](https://learn.chatgpt.com/docs/agent-approvals-security)。初始语音写入决策见 ADR 0002，本次依赖与联网授权见 [ADR 0003](adr/0003-workspace-dependencies-and-network.md)。

## 结果通知通道

云端 MQTT 仅传固定结构的事件 ID、任务 ID、类型和到期时间；设备与 Gateway 使用不同凭据和互反主题 ACL。设备凭据不包含本机 Bearer 或 Codex 凭据。专用工具 `codex_get_notifications` 的身份仍由本机 namespace 配置决定，无路径、设备 ID 或自由指令参数；只写通知查询回执，不修改任务状态或执行新任务。结果文本仅通过既有官方 MCP/语音链路返回。

查询音频为固件内固定内容，通知会话关闭麦克风；安静检测只在现有输入流计算幅度，不保存或新增上传环境录音。只有当前查询回执和固件音频排空确认共同成立才清队列，软件 probe 不能冒充固件成功。凭据文件、Flash 备份和构建私有头均忽略提交。

## 录音通道与管理网页

- 设备只用自己的 MQTT 账号向 `devices/<id>/recording/{request,audio}` 发布、读取 `…/ack`；设备 ID 只取自主题，ACL 把账号绑定到主题。`bridge-gateway` 没有录音权限。
- 录音存服务器 `/var/lib/recording-ingest`（0700，独立系统用户），服务只写该目录（systemd `ProtectSystem=strict`）。转写时百炼通过 30 分钟有效、用完即撤销的随机链接取音频。
- 录音 API 需 64 位 Bearer 令牌（Mac Bridge 用）；管理网页用单独密码换取 30 天 HttpOnly、Secure、SameSite=Strict 会话 Cookie，服务器只存 scrypt 哈希，1 分钟内失败 5 次即锁 1 分钟。网页带严格 CSP，所有数据以文本节点渲染。删除不可恢复，转写中的录音拒绝删除。
- 录音正文对 Codex 只是资料，不作为用户授权；`recording_to_codex` 仍经过原有指令检查。
