# AI Passport 自动结果播报

基线为用户原源码 `<固件源码目录>`，保留 Muse 像素 UI。原发行应用与设备备份逐字节一致。独立构建在忽略提交的 `external/passport-with-ui`；不修改原项目其他构建的 sdkconfig。旧 FoloToy 2.5.0 实验底版曾替换 UI，已回滚，不再使用。

## 安装与构建

`notify.patch` 覆盖原源码已有文件。另复制 `codex_notify.h`、`codex_query_audio.h` 到 `main/boards/folotoy/ai-passport/`，`wall_clock.h` 到 `main/`，`input_quiet.h` 到 `main/audio/`，两份 `test_*.py` 到 `scripts/tests/`。按私有头示例生成设备凭据；不得提交私有头。

使用 ESP-IDF v6.1：`python scripts/build.py folotoy/ai-passport --name ai-passport --language zh-CN`。烧录前运行桥接项目 `scripts/verify-passport-ui.py`，检查渲染器、素材、显示初始化、引脚、Muse 配置及 8MB 配置。当前设备已完整备份，仅刷 ota_0 应用 `0x20000`，保留 bootloader、分区、NVS、OTA 和资源。

## 查询与确认

独立认证 MQTT/WSS 消息只有版本、类型、事件 ID、任务 ID和到期时间，最长512字节。设备一个待处理槽位；播报和对话期间等待。自动待听且无云端回答待处理时，连续安静15秒可以让出会话；声音、手动按住讲话和播放会继续阻止接管。安静由输入 PCM 去除直流后的幅度判断，不依赖 C3 LiteAudioEngine 的 VAD。

设备通过正常 manual 会话上传固件中的固定 Opus 查询音频：请领取待播报通知，播报已经结束的任务结果，不要提交新的任务。麦克风在这一会话内关闭，不下载外部 OGG，不从扬声器喊唤醒词。固定音频为16kHz单声道、60ms一帧，生成脚本为 `scripts/generate-query-audio.py`。

云端调用 `codex_get_notifications` 领取冻结的待播报批次，官方云端生成结果语音。成功、失败、超时都通知，保留24小时、积压合并；批次查询之后完成的新任务留到下一批。只有当前批次查询回执与设备 TTS/音频排空确认均成立，才发送 `playback_completed`、持久化去重并清除通知。断线、打断、查询超时保留重试；播完回 idle。

`signal_received` 和 `query_started` 不代表已播报。设备音频排空确认能证明软件播放流程完成，不能测量扬声器实际发声。

## 2026-10-09 实测

ESP-IDF v6.1 构建、100项 host 测试、UI 保留检查通过。真实设备固定查询句被 ASR 识别，云端调用专用 MCP 工具，播报冻结批次并返回播放完成回执；T-18 重放与新任务 T-19 均完成该链路。原 UI 渲染保持。安静待听分支的实机结论见实施报告。

旧 detect 文本方案被官方云端拒绝，仅唤醒词也不会自动查询，均已由正常音频输入方案替代。普通官方 OTA 会覆盖改动，升级需继续使用这一原 UI 基线。

## 在线录音与性能优化（2026-10-13 实机验证）

在上面的通知改造之上应用 `recording.patch`，并复制 `recorder_core.h`、`passport_recorder.h`、`recording_overlay.h` 到 `main/boards/folotoy/ai-passport/`。完整提交历史在固件仓库 `xiaozhi-esp32` 的 `passport-recording` 分支（基于上游 `ed5cd7b`）。

- 操作：OK **长按** 开始/停止；录音中单击 OK 不会开启对话。全屏录音界面（LVGL 顶层）显示 REC 闪烁点、像素计时、实时音量条、**云端已落盘时长**与状态灯（绿=已确认、黄=积压、红=断网）；结束显示“已保存 / 部分保存 / 录音失败”。只有云端 `finish_ack: saved` 才显示“已保存”。
- 互斥：录音期间设备处于 `recording` 状态，唤醒词关闭、不开对话；通知查询要求 idle，因此自动排队。
- 传输：复用通知 MQTT/WSS 连接与设备账号，`devices/<id>/recording/{request,audio,ack}`。音频 QoS0 + 云端累计 ACK，独立发送任务 Go-Back-N 重传；8 KiB 发送窗口仅在会话期间分配。
- 性能（FreeRTOS 运行时统计，5 分钟固定流程）：待机 LVGL 44% → 17%，播报时空闲 CPU 4% → 21%，开机最低 Heap 26 → 34 KB。头像帧率按状态（待机/播报 12.5 fps，聆听/思考 25 fps），待机光晕静态，被覆盖时不渲染。
- **UI 检查基线变更**：`recording.patch` 包含 `main/display/muse_style/` 的性能修改（像素画面不变，仅帧率与待机光晕）。运行 `verify-passport-ui.py` 时，以应用了本补丁的树作为基线。
- 实测：录音 64 s 两次 saved（0 丢帧、0 重传）；服务重启时如实降级为 partial；转写由云端百炼完成并可经 MCP `recording_*` 查询。60 分钟耐久（R07）尚未测。

## 闲置熄屏（2026-10-14 实机验证）

`recording.patch` 同时包含上游 `af55a78`（#2283）的分级省电策略：闲置 60 s 背光降到 10%，6 min 软睡眠（关屏、关音频、CPU 40 MHz，Wi-Fi 保持），之后深度睡眠。与上游不同：

- 深度睡眠改为闲置 2 h（上游 36 min）。
- 软睡眠时收到 Codex 通知自动亮屏。
- 录音中 60 s 无按键背光降到 10%，录音不停；按键或录音结束恢复。
- 保留 CW2017 电池参数写入（取自 FoloToy `bsp_battery.c`，MIT），电量图标正常；通知 MQTT 重连间隔 3 s，开机约 14 s 可录音。
- 实测：60 s 变暗、6 min 息屏、按键亮屏均正常；需要 `CONFIG_PM_ENABLE=y`（已在板级 `config.json`）。
