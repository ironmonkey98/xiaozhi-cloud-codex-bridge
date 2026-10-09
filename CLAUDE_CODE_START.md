# 交给 Claude Code 的执行指令（V1.1，官方小智云端）

请打开同目录 `TECH_SPEC.md`，按其功能契约直接实现一个可运行的 `xiaozhi-cloud-codex-bridge` 仓库，而不是再写一份方案。

**强制前提：** 用户当前使用 `xiaozhi.me` 的官方云端，小智 ESP32 固件保持不动，ASR / LLM / TTS 全部由云端提供。本机只运行 MCP 接入点出站客户端（首选 `78/mcp-calculator/mcp_pipe.py`）、MCP stdio 适配器、常驻任务服务，以及 `@openai/codex-sdk`。不要自建 `xiaozhi-esp32-server`，不要使用 ChatGPT Dot 或 Secure MCP Tunnel。

## 开发时立即执行

1. 检查本机 OS、Node.js、Codex CLI 版本和已登录状态；输出结果，不打印任何认证令牌。
2. 检查 `@openai/codex-sdk` 当前版本的 `startThread` / `resumeThread` / `thread.run` 与 `sandboxMode:'read-only'` 选项类型。核对 MCP 官方 SDK 的实际版本和 stdio 兼容性，固定 lockfile。
3. 从安全的 `codex_ping` 开始做 MCP stdio 服务，用本地 MCP 测试工具验证 `tools/list` 与 `tools/call`。
4. 通过真实小智控制台获得的 MCP Endpoint **由 Mac 发起 WSS 出站连接**；先用官方 calculator 样例证明云端路径，再挂载刚开发的 stdio 服务。
5. 实现本机 Gateway：项目允许列表、SQLite 任务队列、Codex SDK 只读任务、简短中文结果、查询/续话/取消、断网重连及常驻启动。
6. 增加自动化测试和安全测试。最终生成 `IMPLEMENTATION_REPORT.md`，逐项记录 T01-T12 的 PASS/FAIL/BLOCKED/NOT_RUN 与证据。

## 绝对禁止

- 不编写新的小智云端服务或烧录新 ESP32 固件。
- 不把用户的 ChatGPT Dot、当前 ChatGPT 对话、Codex GUI 会话视作共享状态。
- 不使用已移除的 `codex mcp-server`。
- 不把官方接入点的 token、Codex 登录文件、敏感路径提交代码或写入日志。
- 不开放 Mac 任意公网端口、不注册任意 Shell、删除文件、键盘鼠标控制类工具。
- 未获得真实 MCP Endpoint 时，可完成 Mock、代码、单测；真实联调必须标记 BLOCKED，不得假装完成。

## 交付物

- 完整源代码及依赖锁定；可执行 `npm run dev` / `npm test` / `npm run doctor` / `npm run mcp`。
- `config/projects.example.json`、`.env.example`（无密钥）、`DEPLOY_XIAOZHI_CLOUD.md`、`SECURITY.md`。
- `README.md`、完整工具契约、12 项验收测试、`IMPLEMENTATION_REPORT.md`。
- 若第三方桥接器的实际 API 与文档不一致，提供真实证据及兼容调整，不能为了交付编造接口。

优先完成 P0 至 P2；P3 强化稳定性。P4 的截图和写入操作是**未来阶段**，不得默认启动。
