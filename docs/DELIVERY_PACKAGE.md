# 小智官方云端 → Mac Codex：Claude Code 交付包 V1.1

此版本根据用户现有的 `xiaozhi.me` 官方云端服务修订原 V1.0 方案。

## 文件说明

- `TECH_SPEC.md`：实施技术规范、完整接口、架构、权限模型、开发计划和 T01-T12 验收表。
- `CLAUDE_CODE_START.md`：可以直接交给 Claude Code 执行的任务指令。
- `config/projects.example.json`：授权工作区配置示例；仅演示路径，必须由用户设定。
- `.env.example`：需要用户自行填写的本地环境变量模板；**不要向聊天发送 token**。
- `小智官方云端_Codex_MCP_ClaudeCode开发交付规范_V1.1.docx`：Word 版规范。

## 关键变更

1. 固定为官方云端 `xiaozhi.me`，删除自建小智服务端作为默认方案。
2. Mac 主动向小智控制台提供的 MCP Endpoint 建立 WSS 出站连接，Mac 不开放公网端口。
3. 首选 `78/mcp-calculator` 的官方作者示例桥接；`xiaozhi-client` 是可选替代。
4. Codex 仅在本机执行，通过 `@openai/codex-sdk` 管理线程；默认只读、专用测试工作区。
5. Codex 长任务采用“提交—查询结果”以适配云端语音 MCP 调用时限。

## 使用方式

将本交付包解压到 Claude Code 工作目录，对 Claude Code 说：

> 阅读 `CLAUDE_CODE_START.md` 和 `TECH_SPEC.md`，按 P0-P3 实现，不要重新设计自建小智服务端；开发后提交实际测试报告。

有关前提及依赖请以 `TECH_SPEC.md` 的官方链接为准。尚未配置用户自己的小智 MCP Endpoint 和本机 Codex 登录之前，交付的是研发规范而非已联通的系统。
