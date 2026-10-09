# Codex 完成后主动通知小智：方案调研

调研日期：2026-10-09（Asia/Shanghai）。用户使用官方固件，并说明使用“小智 Lite”；硬件现已确认 AI Passport，实读 ESP32-C3 / 8MB；已安装固件版本尚未确认。本文的公开资料调研与后续部署验证分别记录；尚未完成真实设备推送验收。

## 当前项目为什么需要追问

`src/mcp/stdio.ts` 的 `codex_submit`、`codex_continue` 接收任务后立即返回，工具描述要求稍后查询。`src/tasks/queue.ts` 在任务结束时只保存状态、语音摘要和完整结果，没有通知投递机制。因此执行完成与语音播报之间缺少触发链路。

需要分清两个目标：设备主动播放结果，以及官方云端智能体自动接收结果并继续对话。前者实现后，后者仍需要云端会话支持或下一轮主动查询。

如果“小智 Lite”指控制台的语言模型选项，它不能提供设备型号或固件版本。M5Stack 的厂商教程确实将“小智 Lite”标为“语言模型”。[厂商教程](https://m5stack.oss-cn-shenzhen.aliyuncs.com/resource/docs/static/pdf/static/zh_CN/guide/realtime/xiaozhi/sticks3.pdf)

## 已有方案与适用边界

### 官方源码中的异步语音通知

官方 `main` 已有 `notify`：云端通过设备控制连接发送音频 URL，设备空闲时播放单声道 Ogg Opus，并可显示字幕。这是单向通知，不会自动进入对话。文档提供 `xz-mqtt` 的 Redis `forward` 服务端投递方式，未在所查资料中找到面向普通 `xiaozhi.me` 用户的公开通知 API。[官方通知文档](https://github.com/78/xiaozhi-esp32/blob/main/docs/notify.md)、[接收实现](https://github.com/78/xiaozhi-esp32/blob/main/main/application.cc)

通知没有设备确认和离线保留；繁忙时会被忽略。不能将发送成功当作播完确认。也不能将 `main` 的能力当作用户已安装固件的能力。[官方通知文档](https://github.com/78/xiaozhi-esp32/blob/main/docs/notify.md)

另一个 `speak_request` 主动唤醒提案 PR #1939 在本次查看时仍为 Open；它与上述已存在的 `notify` 是不同机制，不能用该 PR 未合并推断官方完全没有通知能力。[PR #1939](https://github.com/78/xiaozhi-esp32/pull/1939)

### StackChan Fusion：最接近 Codex 完成播报的社区实现

它保留 `xiaozhi.me` 对话，新增独立 MQTT 主动播报通道。Codex hook 上报事件到 `POST /api/agent_event`，网关生成语音再推送给定制固件。现成硬件目标为 M5Stack CoreS3，需要刷配套固件，Mac 还需要适配其 Windows 启动和路径设置。[项目架构](https://github.com/LucaZhang7784/stackchan-fusion)、[部署说明](https://github.com/LucaZhang7784/stackchan-fusion/blob/master/DEPLOY.md)

网关有持久待投递队列、消息 ID、回执和补推。源码中 ACK 表示开始被接收／开始播放，不能证明完整音频播完。根据其独立推流和 MCP 查询路径推断，它没有自动将结果写入官方 LLM 上下文。[事件入口及推流源码](https://github.com/LucaZhang7784/stackchan-fusion/blob/master/gateway/fusion_gateway.py)、[云端工具源码](https://github.com/LucaZhang7784/stackchan-fusion/blob/master/xiaozhi-mcp/server.py)

核查未发现仓库根级许可证；参考固件子树的 MIT 不能自动覆盖网关源码。可参考架构，复制实现前需确认相应许可。

### 小智Pro：已有异步回复与唤醒投递产品

产品文档描述了 OpenClaw 回复缓存、感知设备状态、空闲唤醒、繁忙等待、设备取消息，以及插件 WebSocket 双向推送。但这是第三方 Pro 固件与平台能力，其 OpenClaw 集成也不是现有 Codex Gateway 的直接适配器。[异步投递文档](https://mkwyqeoebedx.sealosbja.site/docs/cn/user/openclaw.html)、[插件文档](https://mkwyqeoebedx.sealosbja.site/docs/cn/user/openclaw-server.html)、[固件及绑定要求](https://github.com/hougeai/xiaozhiPro)

远程控制 API 提供唤醒和发送指令，但公开短文本接口限制少于 10 字，长文本接口标为暂不开放；不能把它直接当作任意结果文本播报 API。[远程控制 API](https://mkwyqeoebedx.sealosbja.site/docs/cn/api/remote.html)

### 自建语音服务

`hackers365/xiaozhi-esp32-server-golang` v0.6.0 描述了设备空闲时下发音频，同时要求配套推送固件。该路线涉及替换官方语音服务，不是当前官方固件配置下的直接补丁。[发行说明](https://github.com/hackers365/xiaozhi-esp32-server-golang/releases/tag/v0.6.0)

## 为什么只增加 MCP 通知不够

官方示例 `mcp_pipe.py` 转发 WebSocket 与 stdio，能发送消息不代表云端会识别自定义完成事件并启动播报。[官方 pipe 源码](https://github.com/78/mcp-calculator/blob/main/mcp_pipe.py)

MCP 2025-11-25 有实验性 Tasks 和可选状态通知，但需要双方支持并协商。规范仍要求请求方轮询，不能假设小智已实现；协议状态通知也没有自动语音播报的保证。[MCP Tasks 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)

延长 `tools/call` 至整个 Codex 完成不能作为长任务方案：官方示例仓库有用户报告工具调用在 10000 ms 超时。这是个案，不是今天官方统一上限的证明；当前限制需要实测。自动连续查询可作为试验，但对话结束后的主动唤起仍未解决。[超时反馈](https://github.com/78/mcp-calculator/issues/20)

## 建议的接入设计（尚未实施）

保留现有 Gateway 和任务存储，新增通知模块：

```text
Codex 完成或失败
  → 保存结果，并持久记录一条待通知事件
  → 通知 Worker 生成短摘要
  → 已验证的官方通知接口，或配套固件的独立推送通道
  → 小智设备播报
```

通知事件包含任务号、项目、设备目标、状态、摘要和稳定事件 ID。通知失败不应改变任务执行结果；查询工具继续可用。适配器明确区分待投递、已发出、已接收和已播完，仅记录通道实际能证明的状态。去重、过期、繁忙等待和离线保留按选定通道实现，不能假设 MQTT QoS 等于最终播完。

优先确认硬件和固件版本、官方 `notify` 是否存在对第三方开放的入口；若有，先验证一条独立测试通知再接入 Gateway。若无，接受改固件时参考 StackChan 的独立通道，接受第三方平台时再评估 Pro。若坚持现有官方固件和官方云且不具备通知入口，目前公开资料不足以支持承诺真正的后台主动播报；Mac 本机通知／语音可作为临时提醒，但不能冒充小智回调。

无论选哪条设备播报通道，都应继续保留云端查询结果工具，让后续对话能取回完整结果。


## 本次落地验证（2026-10-09）

已在用户授权的云服务器部署独立 Mosquitto + nginx WSS 通道，两个独立账号与主题 ACL 生效。本机真实加密连接测试 PASS：任务 T-12 的 119 字节完成信号收发与软件回执成功，`audio_sent=false`。这是软件订阅端测试，不是 ESP32 真机验收。

本机任务完成旁路已运行；只读 Gateway 状态，自己的通知状态单独持久化。去重、重试、过期与回执语义有测试。正式回执只到 `wake_requested`，没有“已播完”的虚假状态。具体运行方式见 `deploy/notify/README.md`。

选用有明确 MIT 许可且针对 Passport 硬件的 [FoloToy 发行版](https://github.com/FoloToy/folo-ai-passport-xiaozhi)。定制固件用 ESP-IDF v6.1 构建成功。普通 C3 `WakeWordInvoke` 不一定发送唤醒文本，补丁增加通过已有 `listen.detect.text` 发起固定查询的实验路径。它是否被官方云端用于调用 MCP，仍需要真实设备与云端验证；不能由构建成功推断。

用户接入 USB 后识别成功；完整备份读取失败且串口断开，所以尚未烧录。设备唤醒、官方云端查询、真实语音播报均 NOT_RUN。详见 `firmware/ai-passport/README.md`。


补充：USB 恢复后完成了完整备份和实验烧录，但新底版替换了原界面。已完整恢复原 xiaozhi 2.5.1 固件，用户确认 UI 恢复。该底版适配尚未成立，当前设备通知仍 NOT_RUN；下一步需基于原固件源码与 UI 资源重新实现。

## 最新实测：官方 detect 限制（2026-10-09）

正确原固件位于 `<固件源码目录>`，其 Muse UI 已保留并重新构建。独立通知已实机接收，T-13 已请求唤醒，但任意查询句经 `listen.detect` 送入官方云端被拒绝：只允许唤醒词。对应上游记录：[issue 1327](https://github.com/78/xiaozhi-esp32/issues/1327)、[issue 1336](https://github.com/78/xiaozhi-esp32/issues/1336)。因此不能把程序唤醒当作任务查询入口；代码已改成合法唤醒词，relay 暂停。

下一步可验证正常上行 Opus 音频承载固定查询句；这与下载 OGG 或由扬声器喊话无关。云端角色配置在唤醒后自动查任务也是候选，但唤醒是否运行模型/工具必须实测，不能用提示词假设补上这条链路。

修正版实机重放 T-12：`signal_received` / `wake_requested` 均通过。串口显示发送“你好小智”，云端仅回答“你好呀！有什么我可以帮你的吗？”，未自动查询任务。后续工具调用来自用户另说的新请求，不能算完成回调。没有观察到原 detect 报错，原 UI 继续渲染。

## 已验证方案（2026-10-09 晚）

后续实机验证成功：绕过受限的 detect 查询文本，改用按键式 manual 正常音频会话上传固定 Opus 查询句。官方 ASR 正确识别，调用 `codex_get_notifications`，播报准确的冻结任务批次，设备确认音频排空。T-18 重放及新提交的 T-19 都完成自动查询和播放回执。原 Muse UI 保留；生产 relay 已恢复并由 Gateway 监督重启。以上更新替代之前“自动查询尚未实现、relay 暂停”的阶段性结论。

空闲直接查询；对话中等待；自动待听连续安静15秒且无云端回答待处理时允许让出会话。通知保留24小时、积压合并，失败和超时也播报。最终安静分支实机结果见实施报告。
