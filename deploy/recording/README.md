# recording-ingest 部署（P2）

接收 AI Passport 录音（MQTT），按序落盘、累计 ACK，停止后封装为 Ogg/Opus。协议见 `docs/RECORDING_PROTOCOL.md`。不含 Speakr/百炼（P1）和固件（P3）。

## 服务器布局

| 路径 | 内容 | 属主/权限 |
|---|---|---|
| `/opt/recording-ingest/node/` | Node 22 LTS（官方二进制，独立目录，不改全局） | root |
| `/opt/recording-ingest/src/recording/*.ts` | 服务源码（Node 类型剥离直接运行） | root |
| `/opt/recording-ingest/node_modules/` | 仅 `mqtt`、`zod`（版本同仓库 lockfile） | root |
| `/opt/recording-ingest/cloud/recording-ingest/finalize/` | `finalize.py`、`opus_encoder.py`、`.venv`（仅 `av`） | root |
| `/etc/recording-ingest/recording.json` | Broker 账号与路径（含密码） | root:recording 640 |
| `/var/lib/recording-ingest/{sessions,recordings}` | 会话帧日志与成品录音 | recording 700 |
| `/etc/systemd/system/recording-ingest.service` | 服务单元（本目录同名文件） | root |

系统依赖：apt `ffmpeg`（提供 ffprobe）、`libopus0`、`python3-venv`。

## Broker 改动（只追加）

- `/etc/mosquitto/passwd-xiaozhi-notify`：新增用户 `recording-ingest`（随机密码，仅存于上面的 json）。
- `/etc/mosquitto/acl-xiaozhi-notify`：追加 `acl.append`。原通知规则、`bridge-gateway` 与 `passport-01` 原有权限不变；`bridge-gateway` 无录音权限。
- 设备仍走现有 nginx WSS 路径到 18884，录音上传不需要改 443 站点。录音 API、管理网页与百炼下载链接使用单独的 8443 站点（[nginx-recording.conf](nginx-recording.conf)），只放行 GET、DELETE、POST。
- 改动前备份：`/root/backup-recording-<时间>/`。

## 配置示例（`recording.json`）

完整示例（含录音 API、网页密码哈希、百炼转写）：[recording.example.json](recording.example.json)。nginx 8443 站点：[nginx-recording.conf](nginx-recording.conf)。下面是最小配置（只收录音，不转写）：

```json
{
  "url": "mqtt://127.0.0.1:18883",
  "username": "recording-ingest",
  "password": "<openssl rand -hex 24>",
  "devices": ["passport-01"],
  "data_dir": "/var/lib/recording-ingest",
  "python": "/opt/recording-ingest/cloud/recording-ingest/finalize/.venv/bin/python",
  "finalize_script": "/opt/recording-ingest/cloud/recording-ingest/finalize/finalize.py"
}
```

明文 `mqtt://`/`ws://` 只允许回环地址（配置校验会拒绝其他主机）。

## 运维

```bash
systemctl status recording-ingest
journalctl -u recording-ingest -f        # 每行一个 JSON 事件，不含密钥与音频
ls /var/lib/recording-ingest/recordings  # 成品 <session_id>.ogg
```

## 回滚

```bash
sudo systemctl disable --now recording-ingest
sudo rm /etc/systemd/system/recording-ingest.service && sudo systemctl daemon-reload
B=/root/backup-recording-<时间>
sudo cp -a $B/acl-xiaozhi-notify $B/passwd-xiaozhi-notify /etc/mosquitto/
sudo systemctl reload mosquitto
# 可选：sudo rm -rf /opt/recording-ingest /etc/recording-ingest；录音数据 /var/lib/recording-ingest 按需保留
```

## 验证状态（2026-10-13）

| 项 | 结果 |
|---|---|
| 本机 `npm run typecheck` / `npm test`（84）/ `npm run test:mcp`（8） | PASS |
| 本机 `npm run test:recording`（真 Mosquitto + 真 finalize，3 项） | PASS |
| finalize `pytest`（47） | PASS |
| 服务器隔离自检（临时 Mosquitto，同 3 项） | PASS |
| 生产服务启动、以 `recording-ingest` 账号连上 Broker | PASS |
| `recording-ingest` 账号读不到通知主题 | NOT_RUN（mosquitto 对无权订阅也返回成功，本次方法无法区分；依据 ACL 配置） |
| 真实设备经 WSS 录音 | NOT_RUN（固件 P3 未实现） |
