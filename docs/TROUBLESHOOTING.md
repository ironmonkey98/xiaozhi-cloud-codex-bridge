# 故障排查

先运行 `npm run doctor`，它会逐项给出 OK / WARN / FAIL，且不打印密钥。

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 小智说“电脑上的 Codex 服务没有运行” | Gateway 未启动或端口不一致 | `npm run start:daemon`；确认 `.env` 的 `GATEWAY_PORT` 与 pipe 侧一致 |
| `codex_ping` 返回 `codex_ready: false` | Codex 未登录或登录过期 | 终端执行 `codex login`，再 `npm run doctor` |
| 启动报 `LOCAL_BRIDGE_TOKEN 未设置或少于 32 个字符` | `.env` 未填写 | `openssl rand -hex 32` 生成后填入 |
| 启动报 `workspace 必须是 Git 仓库根目录` | 项目目录未 `git init` | 在该目录执行 `git init`（Codex 拒绝在非 Git 目录运行，本项目不跳过该检查） |
| 启动报 `workspace 不能是根目录、家目录或其上级目录` | 白名单过宽 | 改为具体项目目录 |
| 控制台接入点不在线 | pipe 未运行 / 地址错误 / 网络 | 看 `npm run pipe` 输出；确认地址以 `wss://` 开头且来自控制台；`mcp_pipe` 会指数退避重连（最长 600 s） |
| 控制台在线但看不到工具 | stdio 适配器启动失败 | `npm run build` 后重试；pipe 输出会包含适配器 stderr |
| 小智说“已开始”后一直“正在分析” | Codex 任务耗时长或排队 | 默认 180 s 超时后变为 `timed_out`；可拆小问题 |
| 返回 `TASK_BUSY` | 队列已满（默认 10） | 等待或取消前面的任务 |
| 返回 `APPROVAL_REQUIRED` | 指令被判定为写入/删除/安装/执行 | MVP 只读；换成“分析/解释/找原因”类说法 |
| 返回 `PATH_NOT_ALLOWED` | 指令包含路径或敏感目录 | 用项目别名，不要说具体路径 |
| 任务状态 `failed` + `INTERRUPTED` | Gateway 重启时任务未完成 | 重新提交 |
| `npm run test:pipe` 被跳过 | 未安装 mcp_pipe | `npm run setup:pipe` |
| `setup:pipe` 中 pip 失败 | 无网络或 Python 异常 | 检查网络；本项目只需 `websockets` 与 `python-dotenv`，不需要 requirements.txt 中的 `mcp`/`fastmcp` |
| LLM 不调用工具或选错工具 | 智能体提示词 | 把 README 中的角色设定加入智能体配置 |
| 任务完成后设备不播报 | 角色设定缺通知规则；Gateway 未启动 relay；设备通知通道未连上 | 角色设定保留第一段通知播报规则；确认存在 `config/notify.local.json`；`npm run notify:probe`；设备串口应有 `CodexNotify: notification channel connected` |
| 录音工具返回 `RECORDING_NOT_CONFIGURED` | `.env` 未填录音 API | 填 `RECORDING_API_URL` 与 `RECORDING_API_TOKEN` 后重启 Gateway |
| 设备提示“录音服务未连接” | 开机后通知通道尚未连上（约 14 秒）或 Wi-Fi 断开 | 稍等再长按；看串口 `CodexNotify` 日志 |
| 录音结束显示“部分保存” | 传输中断或服务在录音中重启 | 网页或 `recording_list` 中如实标记不完整；录音中不要重启 `recording-ingest` |
| 转写一直“等待转写” | 百炼 Key 错误，或百炼拉不到 8443 下载链接 | `journalctl -u recording-ingest` 看 `transcript_failed`；检查 `transcription.public_base_url` 与证书 |
| 管理网页登录返回 429 | 1 分钟内输错 5 次 | 等 1 分钟 |

## 日志

- Gateway：stderr，JSON 行，已脱敏。`LOG_LEVEL=debug` 可看更多。
- pipe：`npm run pipe` 的终端输出（已脱敏）。
- 录音服务（服务器）：`journalctl -u recording-ingest -f`，每行一个 JSON 事件，不含密钥与音频。
- 任务详情：`sqlite3 ~/.xiaozhi-codex-bridge/tasks.sqlite 'select id,status,error_code,spoken_summary from tasks order by id desc limit 10'`。
