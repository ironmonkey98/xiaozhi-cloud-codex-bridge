# 在线录音封装器

需要 Python 3.10+、系统 libopus 动态库，以及 PATH 中的 `ffprobe`、`ffmpeg`（可用环境变量 `FFPROBE` 指定 ffprobe 路径）。生产封装只调用 ffprobe；ffmpeg 用于测试完整解码。PyAV 自带的 FFmpeg 库可能与系统版本不同。

在本目录执行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python make_fixture.py --seconds 12 --out frames.bin
.venv/bin/python make_fixture.py --seconds 12 --out frames.bin --silence-every 10
.venv/bin/python finalize.py --session-dir /path/to/sessions/ID --out-dir /path/to/recordings
.venv/bin/python -m pytest -q
```

夹具由 libopus 编码为 16 kHz 单声道、60 ms、16 kbit/s VBR、DTX 开启、complexity 0，使用 VOIP application。音频每 4 秒含 2 秒静音以触发实际 DTX。`--seconds` 向上取整到完整 60 ms 帧；`--silence-every N` 额外将每第 N 帧替换为协议的零长度静音。真实 libopus DTX 小包仍以非零长度保存。输出不含 MQTT 包头，记录为小端 `u32 frame_index | u16 len | bytes`。

封装遵循协议第 5、6 节：先完整校验日志，再用 PyAV/libavformat Ogg muxer 写 `.ogg.part`，ffprobe 验证后原子改名。标准输出为一行 JSON，退出码为 0（成功）、2（输入无效）、3（封装或验证失败）。不修改 meta.json。失败会清理本次封装产生的 `.part`，既有成品在验证成功前不会替换。

`frames_audio` 统计非零长度记录（包括真实 DTX 小包）；`frames_dtx` 只统计零长度记录；`frames_missing` 统计缺口，`missing_ranges` 为闭区间。头部、内部、尾部缺口均补静音。时长字段为帧数乘 60 ms；PTS、duration 使用 48 kHz 时间基，每帧 2880 个时钟单位。

## 约定与限制

- meta 必须包含协议示例的顶层字段及 format.dtx；frames_persisted 必须等于日志记录数。空会话、负 last_frame_index 返回 2。session_id 必须是 32 位小写 hex。
- 协议没有传递设备编码器 lookahead。本实现以 16 kHz VOIP libopus 的 lookahead 换算为 48 kHz pre-skip，OpusHead 输入采样率为 16000。设备须使用相同延迟约定；建议后续协议明确 application/pre-skip。解码音频因 pre-skip 会少掉开头的编码器延迟，不追加额外编码帧，处于协议 60 ms 容差内。
- 输入 Opus 包应已由设备按 60 ms 编码。本实现检查日志结构，ffprobe 检查容器；不对每个输入包完整解码验证内容。测试另外使用 ffmpeg 验证生成夹具的完整解码。
- 调用方必须先停止日志追加和 meta 更新；同一 session 不可并发封装。日志扫描两次，不将整段音频载入内存。会话总时长上限由 ingest 执行。
- 静音补包来自独立编码器，能维持时间轴，但不能重建丢失声音，丢帧边界可能有轻微音色变化。
- 动态库缺失或不可用返回封装失败；本实现未在真实设备录音上验证。
