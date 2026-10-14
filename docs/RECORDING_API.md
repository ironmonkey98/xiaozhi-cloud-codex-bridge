# 录音查询 API V1（云端 → Mac Bridge）

云端 `recording-ingest` 保存录音后自动调用百炼 Fun-ASR 转写，并通过本 API 提供列表与转写文字。Mac 上的 Gateway 用它实现 `recording_*` MCP 工具。录音、转写本身不依赖 Mac 在线；语音查询依赖 Mac（与现有 MCP 一致）。

## 访问

- 基址：`https://<server>:8443/recording-api/v1`（独立 nginx 站点，8443 → 回环端口；不改动 443 上的其他站点）。
- 鉴权：`Authorization: Bearer <RECORDING_API_TOKEN>`。令牌 64 位 hex，Mac 端放 `.env`，服务端放 `/etc/recording-ingest/recording.json`；不得写入仓库或日志。
- 除删除外均为只读；不接受设备标识或路径参数。`recording_id` 为 32 位小写 hex。
- 响应均为 JSON（UTF-8）。错误：`401 {"error":"unauthorized"}`，`404 {"error":"not_found"}`，`400 {"error":"bad_request"}`。

## 对象

```jsonc
// Recording
{
  "recording_id": "75c64fa5a1320a3c5472e3bfe07974f4",
  "created_at": "2026-10-13T12:51:51.922Z",
  "duration_ms": 14520,
  "state": "saved",                 // saved | partial | failed（failed 无音频）
  "transcript": {
    "state": "done",                // none | pending | running | done | failed
    "chars": 128,                   // done 时的文字长度
    "preview": "今天我们讨论……",      // done 时前 80 字
    "error": null                   // failed 时的简短原因（不含密钥/URL）
  }
}
```

## 接口

### `GET /recordings?limit=10&q=关键词`

按 `created_at` 倒序，`limit` 1–200（默认 10）。不含仍在接收中的会话。

`q`（可选，≤100 字）只在已完成的转写全文中查找（不区分大小写）；结果每条多一个 `match` 字段：命中位置附近的一小段文字。

```json
{"recordings": [Recording, ...]}
```

### `GET /recordings/{recording_id}`

单条 `Recording`。

### `GET /recordings/{recording_id}/transcript`

```json
{
  "recording_id": "…",
  "duration_ms": 14520,
  "language": "zh",
  "text": "整段文字……",
  "sentences": [{"begin_ms": 0, "end_ms": 2310, "text": "……"}]
}
```

转写未完成时 `409 {"error":"transcript_not_ready","state":"pending"}`；失败时 `409 {"error":"transcript_failed","state":"failed"}`。

### `GET /recordings/{recording_id}/audio`

`audio/ogg` 音频；`failed` 录音没有音频，返回 404。

### `DELETE /recordings/{recording_id}`

删除音频、帧日志与转写，不能恢复。成功 `200 {"deleted":"<id>"}`；正在转写时 `409 {"error":"transcript_running"}`；接收中或不存在 404。

## 管理页面

`https://<server>:8443/recording-api/ui/`：列表、播放、查看转写（点句子跳到对应位置）、复制全文、下载、搜索、删除。页面本身不含数据，也不需要鉴权；首次打开输入上面的访问令牌，令牌只存在该浏览器的 localStorage，点“退出”清除。页面带严格 CSP，只连同源 API。

## 转写规则（服务端）

- `saved` 与 `partial` 录音都会转写；`partial` 在 `state` 中如实保留，调用方需在播报中说明“录音不完整”。
- 失败可重试 2 次；不会无限重试。
- 百炼通过一次性、30 分钟有效的随机下载链接（`/recording-dl/<token>`）取音频，链接不需要鉴权但不可猜测，过期即失效。
