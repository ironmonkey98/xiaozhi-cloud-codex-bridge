# 独立通知服务

这是完成信号的转发服务，无语音合成、音频文件或公开 Codex Gateway。Mosquitto 两个监听端口只绑定回环；nginx 的 HTTPS 站点新增 `/codex-notify/mqtt` WebSocket 路径。现有 HTTPS 证书与业务位置保持使用。

部署主机：<server>（2026-10-09），Mosquitto 和 nginx 已运行。

```text
本机 Codex Gateway 保存任务结果
  → 本机 notify-relay 只读任务数据库，持久记录通知 ID
  → wss://<server>/codex-notify/mqtt
  → 改版 AI Passport 主动建立的出站 WSS/MQTT 连接
  → 正常 manual 音频会话上传固定查询句
  → codex_get_notifications 查询冻结批次
  → 官方云端 TTS，设备播完回执
```

设备不需要公网 IP 或入站端口；服务器沿设备已建立的连接投递。原版固件不会订阅这个通道，需要本仓库 firmware/ai-passport 中的补丁。

## 配置与安装

本机 `config/notify.local.json` 应为 0600，已忽略提交。配置包含 `url`、`device_id`、`namespace`、`gateway: {username,password}`、`device: {username,password}`。两个账号分别随机生成至少 32 字符密码，设备账号不能获得 Gateway 账号或本机 Bearer token。

服务器安装 `mosquitto mosquitto-clients`，用服务器原生 `mosquitto_passwd` 生成名为 `passwords` 的哈希文件。不要自己拼接密码哈希格式。账号名、设备 ID 和 `acl` 必须匹配。

将配置与哈希文件通过 SSH 传入单独目录，设置准确的现有 HTTPS 站点路径，再运行：

```sh
NGINX_NOTIFY_SITE=/etc/nginx/sites-available/pocket-judo bash install.sh
```

安装脚本备份站点，验证 nginx 配置后重启 Mosquitto、重载 nginx。它不会安装或升级其他服务器应用。部署完成后删除临时认证文件。

## 本机运行与检查

Gateway 在配置存在且非 Mock 时自动启动 relay；退出后5秒重启，Gateway 关闭时一并停止。已验证自动重启。PID 在 `data/notify-relay.pid`，日志继承 Gateway（当前 `/private/tmp/xiaocdoex-gateway.log`）。本机尚未配置开机自启动。

`npm run notify:probe` 只验证软件云通道，不代表设备播报。`npm run notify:device -- --replay` 以已有终态任务重放通知，验证设备查询与音频排空回执，不启动新 Codex 任务。需要连接真实设备并保持 Gateway、pipe 在线。不要额外运行第二个生产 relay。

旁路每两秒检查配置 namespace 下最近24小时成功、失败、超时的任务。通道不发送任务正文、结果摘要、音频URL、路径或 Codex 凭据。outbox 为 `data/notify-*.sqlite`，最早一个待通知事件以 QoS1/retained 重试；设备查询开始后暂停重复触发，Gateway 冻结准确批次。只在该次查询回执与固件 `playback_completed` 均成立后清理，否则保留至重试或24小时过期。服务离线时 retained 信号可暂留，设备仍校验有效期。

设备繁忙先等待；自动待听无回答待处理且输入连续安静15秒可让出会话。实际查询由固定上行 Opus 音频触发，官方云端负责识别、调用工具及合成播报。原 UI 保留。T-18 重放及新任务 T-19 已在实机完成查询、播报流程和回执；安静待听分支单独验收。
