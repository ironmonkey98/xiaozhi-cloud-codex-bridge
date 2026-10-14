# 部署：小智官方云端 → Mac Codex

## 0. 前提

- 小智设备使用 xiaozhi.me 官方云端，固件不改。
- Mac：Node.js ≥22.18、Python 3（实测 3.9.6 可用）、`codex login` 已完成（`npm run doctor` 可检查）。
- Mac 不开放任何入站端口：Gateway 只监听 `127.0.0.1`，云端连接由 Mac 主动出站。

## 1. 本机闭环

```bash
npm ci && npm run build
npm run setup:demo                 # 或自建 config/projects.json
cp .env.example .env && chmod 600 .env
# .env: LOCAL_BRIDGE_TOKEN=<openssl rand -hex 32 的输出>，CODEX_MOCK=0
npm run doctor
npm run start:daemon               # 保持运行
npm run mcp:call -- --list
npm run mcp:call -- codex_submit '{"project_id":"demo","instruction":"看看测试为什么失败"}'
npm run mcp:call -- codex_get_latest_task
```

## 2. 获取接入点（用户本人操作）

1. 打开 <https://xiaozhi.me/console/agents> 并登录，选择设备正在使用的智能体。
2. 进入 MCP 设置 → 获取 MCP 接入点，复制控制台返回的完整地址（通常形如 `wss://…/mcp/?token=…`，以控制台为准）。
3. 写入 `.env`：`XIAOZHI_MCP_ENDPOINT=<完整地址>`。该地址含密钥：不要发到聊天、截图或提交到 Git。

## 3. 建议先验证官方示例（TECH_SPEC P0）

V1.1 要求先用官方计算器示例证明云端路径：

```bash
npm run setup:pipe
cd external/mcp-calculator
set -a; . ../../.env; set +a
MCP_ENDPOINT="$XIAOZHI_MCP_ENDPOINT" ../.venv/bin/python mcp_pipe.py calculator.py
```

> 注：`calculator.py` 依赖 `fastmcp`（需 Python ≥3.10）。若本机 Python 为 3.9，此步会失败，可直接进行第 4 步，以 `codex_ping` 作为“无权限 ping 工具”完成 P0 验证。

控制台显示在线后，对小智说“用计算器算一下 3 乘 7”。

## 4. 挂载本项目

```bash
npm run start:daemon     # 终端 1
npm run pipe             # 终端 2：生成 external/mcp_config.json 并连接接入点
```

`npm run pipe` 输出中的 `token=` 会被替换为 `<redacted>`。控制台刷新后应看到 11 个工具：8 个 `codex_*` 与 3 个 `recording_*`（录音工具在未配置录音 API 时返回 `RECORDING_NOT_CONFIGURED`）。然后：

| 语音 | 期望工具 |
|---|---|
| “测试本机连接” | `codex_ping` |
| “我电脑上有哪些项目” | `codex_list_projects` |
| “分析演示项目的模块职责” | `codex_submit` |
| “刚才的任务怎么样了” | `codex_get_latest_task` |
| “继续分析它的测试” | `codex_continue` |
| “取消任务 T-5” | `codex_cancel_task` |

把 README 中的角色设定提示词加到智能体配置，可提高工具选择准确率。

## 5. 常驻运行（可选）

用户级 LaunchAgent 尚未随仓库提供（见 IMPLEMENTATION_REPORT 的未完成项）。临时可在两个终端分别运行，或使用 `tmux`。

## 6. 停止

`Ctrl+C` 停止 `npm run pipe` 即断开云端能力；Gateway 收到 SIGINT/SIGTERM 会中止运行中的任务（标记为 `INTERRUPTED`）后退出。
