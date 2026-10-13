# AI Passport 在线录音协议 V1（草案，P2 冻结前可改）

范围：设备 ↔ 云端 `recording-ingest` 的 MQTT 协议，以及 ingest ↔ 封装器（finalize）的会话目录格式。交接规范见 `AI_Passport_Recording_Codex_Handoff_V1.0`。

所有多字节整数均为 **小端**（ESP32 原生字节序）。CRC32 为 IEEE 802.3 多项式，与 `zlib.crc32` 相同（初值 0、结果不反转的封装形式，即 Python `zlib.crc32(data)`、Node `zlib.crc32(data)`）。

## 1. Topic 与 QoS

`{id}` 是 MQTT 账号绑定的设备标识（例如 `passport-01`）。ingest 只信任 Topic 中的 `{id}`，ACL 保证设备只能写自己的 Topic。

| Topic | 方向 | QoS | retain | 内容 |
|---|---|---|---|---|
| `devices/{id}/recording/request` | 设备 → 云 | 1 | false | 控制 JSON：`start` / `stop` |
| `devices/{id}/recording/audio` | 设备 → 云 | **0** | false | 二进制音频包（第 3 节） |
| `devices/{id}/recording/ack` | 云 → 设备 | 1 | false | 控制 JSON：`start_ack` / `chunk_ack` / `finish_ack` / `error` |
| `devices/{id}/recording/status` | 设备 → 云 | 0 | false | 可选，简短状态 |

音频使用 QoS0：esp-mqtt 的 QoS1 会在 outbox 里再复制一份消息，与设备录音队列形成双重缓冲。完整性由第 4 节的 **应用层累计 ACK** 保证，它表示“已落盘”，比 Broker 的 PUBACK 更强。

## 2. 控制消息（JSON，单条 ≤ 512 字节）

所有消息含 `"v":1` 和 `"type"`。未知字段拒绝。

### start（设备 → 云）

```json
{"v":1,"type":"start","request_id":"9f1c…(32位小写hex)",
 "format":{"codec":"opus","sample_rate":16000,"channels":1,"frame_ms":60,"dtx":true},
 "max_duration_s":7200}
```

- `request_id` 幂等：同一设备重复发送同一 `request_id`，返回同一个 `session_id`，不重复建会话。
- 每台设备同时最多 1 个活动会话。已有其他活动会话时返回 `error/busy`。

### start_ack（云 → 设备）

```json
{"v":1,"type":"start_ack","request_id":"…","session_id":"…(32位小写hex)","max_packet_bytes":768}
```

设备只有收到 `start_ack` 才进入“录音中”。

### chunk_ack（云 → 设备）

```json
{"v":1,"type":"chunk_ack","session_id":"…","persisted_seq":41,"frames":168}
```

- `persisted_seq`：**已落盘（fsync 后）的最高连续包序号**；尚无数据时为 `-1`。
- `frames`：已落盘的帧总数。
- ingest 至少每 1 秒或每 8 个新包发送一次；收到重复包时立即重发当前 ACK。

### stop（设备 → 云）

```json
{"v":1,"type":"stop","session_id":"…","last_seq":119,"frames":480,
 "duration_ms":28800,"dropped_frames":0,"reason":"user"}
```

- `last_seq`：最后一个音频包序号；一个包都没发时为 `-1`。
- `dropped_frames`：设备在上游（编码发送队列、录音队列）检测到的丢帧数。
- `reason`：`user` | `max_duration` | `queue_overflow` | `network` | `error`。
- 重复发送同一 `stop` 是安全的。

### finish_ack（云 → 设备）

```json
{"v":1,"type":"finish_ack","session_id":"…","state":"saved","recording_id":"…",
 "duration_ms":28800,"missing_frames":0}
```

- `state`：`saved`（完整）| `partial`（有缺口但已保存可播放部分）| `failed`（无法生成文件）。
- 只有 `saved` 能显示“已保存”。

### error（云 → 设备）

```json
{"v":1,"type":"error","request_id":"…","session_id":"…","code":"busy"}
```

`code`：`busy` | `bad_request` | `no_space` | `unavailable` | `unknown_session` | `too_long`。`request_id` 与 `session_id` 视情况出现。

## 3. 音频包（二进制，单条 ≤ `max_packet_bytes`，默认 768）

```text
偏移 大小  字段
0    4     magic           "APR1"
4    16    session_id      start_ack 中 32 位 hex 对应的 16 字节
20   4     packet_seq      u32，从 0 起严格 +1
24   4     first_frame     u32，本包第一帧的帧序号（见下）
28   1     frame_count     u8，1..16
29   1     flags           u8，当前为 0
30   2     reserved        u16，必须为 0
32   4     payload_crc32   u32，覆盖偏移 36 起的全部字节
36   …     frames          重复 frame_count 次：[len u16][len 字节 Opus 数据]
```

包头固定 36 字节。

**帧序号 = 时间轴**：录音开始后第 n 个 60 ms 编码周期的帧序号为 n。编码器每个周期都会出一个包（DTX 静音时包很小），`len = 0` 也合法，表示该 60 ms 为静音。

- 同一包内的帧序号连续：`first_frame, first_frame+1, …`。
- 相邻两包之间若帧序号跳跃，表示 **设备上游丢帧**（编码发送队列溢出等）。设备应按检测到的丢帧数推进帧序号，云端据此记录缺口、标记 `partial`。
- 包序号（`packet_seq`）缺口表示 **网络丢包**，靠重传补齐，不应留到最后。

单帧 `len` 上限 1275（Opus 规范上限）。

## 4. 可靠性

- ingest 只按序落盘：`seq <= persisted_seq` 视为重复，丢弃并重发 ACK；`seq > persisted_seq + 1` 视为乱序，丢弃并重发 ACK（Go-Back-N）。
- 校验失败（magic、session、CRC、帧长度越界、帧序号回退）的包丢弃并记录，不推进 ACK。
- 设备只在收到 `chunk_ack` 后释放队列中 `seq <= persisted_seq` 的包；ACK 3 秒未推进则从 `persisted_seq + 1` 重发。
- 设备队列有上限；放不下时停止录音，`stop.reason = queue_overflow`，结果最多为 `partial`。
- 收到 `stop` 后，ingest 等待 `persisted_seq == last_seq`，最多等 15 秒（宽限期，供重传）。超时仍有缺口则按已落盘内容封装为 `partial`。
- 会话 120 秒无任何包且未收到 `stop`：按已落盘内容封装为 `partial`。
- 会话总时长超过 `max_duration_s`：返回 `error/too_long` 并按已有内容封装。

## 5. 会话目录（ingest ↔ finalize 契约）

```text
<data_dir>/sessions/<session_id>/
  meta.json      会话元数据（ingest 原子写：先写 meta.json.tmp 再 rename）
  frames.bin     帧日志，仅追加
<data_dir>/recordings/<session_id>.ogg   封装结果（finalize 写 .ogg.part 后原子改名）
```

### frames.bin

按落盘顺序（即包序号顺序）重复以下记录，帧序号严格递增：

```text
u32 frame_index | u16 len | len 字节 Opus 数据
```

`len = 0` 表示静音帧。帧序号不连续表示设备上游丢帧。

### meta.json

```json
{
  "version": 1,
  "session_id": "…", "device_id": "passport-01", "request_id": "…",
  "created_at": "2026-10-12T08:00:00.000Z",
  "format": {"codec":"opus","sample_rate":16000,"channels":1,"frame_ms":60,"dtx":true},
  "max_duration_s": 7200,
  "state": "receiving",
  "persisted_seq": 119, "frames_persisted": 480, "last_frame_index": 479,
  "frames_bytes": 52310,
  "stop": {"last_seq":119,"frames":480,"duration_ms":28800,"dropped_frames":0,"reason":"user"},
  "end_cause": null,
  "result": null
}
```

- `state`：`receiving` → `finishing` → `saved` | `partial` | `failed`。
- `frames_bytes`：本 meta 覆盖的 `frames.bin` 字节数。ingest 先追加并 fsync 帧，再原子替换 meta，ACK 以 meta 为准；重启时把 `frames.bin` 截断到该长度，丢弃从未确认的尾部。
- `stop` 未收到时为 `null`。`end_cause`：`stop` | `stop_grace_expired` | `idle_timeout` | `too_long`。
- `result` 由 ingest 在 finalize 后写入（finalize 的 JSON 加 `state`）。

## 6. finalize 命令行契约

```bash
cloud/recording-ingest/finalize/.venv/bin/python cloud/recording-ingest/finalize/finalize.py \
  --session-dir <data_dir>/sessions/<id> --out-dir <data_dir>/recordings
```

- 读取 `meta.json` 与 `frames.bin`，帧数据从帧序号 0 写到 `last_frame_index`。
- `len = 0` 的帧与帧序号缺口用 **合法的 60 ms Opus 静音包** 填充，保证时间轴准确；两者分开统计。
- 用成熟库（PyAV / libavformat 的 Ogg 封装器）写标准 Ogg/Opus（OpusHead：1 声道、输入采样率 16000、pre-skip 按编码器约定），不手写 Ogg 页。
- 先写 `<id>.ogg.part`，用 `ffprobe` 验证（编码 `opus`、1 声道、时长与 `(last_frame_index + 1) × 60 ms` 相差 ≤ 60 ms），通过后原子改名为 `<id>.ogg`；失败删除 `.part`。
- 标准输出只打印一行 JSON：

```json
{"ok":true,"path":"…/<id>.ogg","duration_ms":28800,"frames_total":480,
 "frames_audio":455,"frames_dtx":25,"frames_missing":0,"missing_ranges":[]}
```

`missing_ranges` 为帧序号闭区间列表，如 `[[120,124]]`。失败时 `{"ok":false,"error":"…"}`。

- 退出码：`0` 成功；`2` 输入无效（目录、meta、帧日志格式）；`3` 封装或 ffprobe 验证失败。
- 不修改 `meta.json`（由 ingest 根据结果更新状态）。
- 待定：OpusHead 的 pre-skip 当前取主机 libopus（VOIP，16 kHz）的 lookahead × 3 = 312 个 48 kHz 样本。设备端 esp_opus 编码器的实际 lookahead 需在 P3 实测后确认；只影响开头约 6.5 ms 的对齐，不影响时长与完整性。

## 7. 状态判定（ingest）

- `saved`：收到 `stop`，`persisted_seq == last_seq`，`frames_missing == 0`，`dropped_frames == 0`，finalize 成功。
- `partial`：finalize 成功，但存在任一缺口、超时或设备丢帧。
- `failed`：没有可用帧，或 finalize 失败。

`partial` 录音不自动导入 Speakr（交接规范 6.1）。
