# Claude Code 项目约束

本仓库实现「小智官方云端（xiaozhi.me）→ Mac Codex」MCP 桥接，支持工程只读与专用工作区受控写入。

- 功能与验收基线：`TECH_SPEC.md`（V1.1）与 `CLAUDE_CODE_START.md`；术语：`CONTEXT.md`；决策：`docs/adr/`。
- 架构不可变更：`mcp_pipe.py`（出站 WSS）→ `dist/mcp/stdio.js`（薄适配，可随断线重启）→ `dist/gateway/main.js`（常驻，任务状态唯一来源）→ `@openai/codex-sdk`。
- Codex 模式只由本机项目配置决定（`read-only` / `workspace-write`），`approvalPolicy: 'never'`。可写项目已授权联网、安装项目依赖、运行程序并生成文档，缓存、临时文件与依赖留在项目内（ADR 0003）；只读项目保持无网络。文件边界与读取限制见 `docs/SECURITY.md`；新增整机权限或外部 MCP/截图工具需用户单独批准。
- 调用方身份只来自配置注入的 `BRIDGE_NAMESPACE`，工具 schema 不得出现 `device_id` 或路径参数。
- Gateway 只绑定回环地址并要求 Bearer；不得把接入点 token、`LOCAL_BRIDGE_TOKEN`、Codex 凭据写入仓库或日志。
- 源码为可直接被 Node 类型剥离运行的 TypeScript（`erasableSyntaxOnly`，相对导入带 `.ts` 后缀）。
- 每次改动后运行并如实报告：`npm run typecheck`、`npm test`、`npm run test:mcp`；涉及桥接器时加 `npm run test:pipe`；涉及 Codex 调用时加 `npm run test:e2e`（消耗额度，先征得同意）。
- 未在真实小智设备上验证的项目，在 `IMPLEMENTATION_REPORT.md` 中只能标记 BLOCKED / NOT_RUN。
