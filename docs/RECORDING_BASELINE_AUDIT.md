# 录音功能 P0 基线审计

日期：2026-10-13。只读审计：未烧录、未改分区、未动云端生产配置。

## 1. 源码与构建环境

| 项 | 值 |
|---|---|
| Muse UI 源码 | `~/xiaozhi/xiaozhi-esp32`（`muse-style-ui` 分支，基于上游 `ed5cd7b`，含未提交的 Muse UI 改动） |
| 基线工作副本 | `~/xiaozhi/passport-recording` = 上述源码 + `firmware/ai-passport/notify.patch` + README 列出的头文件 |
| 补丁应用 | `patch -p1` 干净应用，无冲突（7 个文件） |
| 私有凭据头 | 用 `codex_notify_private.example.h` 占位，仅用于体积测量；真机烧录需正式凭据 |
| ESP-IDF | **v6.0.1**（另一台 Mac 的通知构建为 v6.1，差异见第 5 节） |
| 构建命令 | `python scripts/build.py folotoy/ai-passport --name ai-passport --language zh-CN` |
| sdkconfig 关键项 | `BOARD_TYPE_FOLOTOY_AI_PASSPORT=y`、`AI_PASSPORT_MUSE_STYLE_UI=y`、`ESPTOOLPY_FLASHSIZE_8MB=y`、`PARTITION_TABLE_CUSTOM_FILENAME="partitions/v2/8m.csv"`、`CUSTOM_BASE_MAC=""` |
| 产物存档 | `~/xiaozhi/firmware/p0-baseline/`（bin、elf、sdkconfig） |

## 2. 分区表（R01）

由构建产物 `partition-table.bin` 解析，与 `8m.csv` 一致：

| 分区 | 偏移 | 大小 |
|---|---|---|
| nvs | 0x9000 | 16K |
| otadata | 0xd000 | 8K |
| phy_init | 0xf000 | 4K |
| ota_0 | 0x20000 | 3008K |
| ota_1 | 0x310000 | 3008K |
| assets | 0x600000 | 2M |

真机分区表与 2026-10-09 完整备份 `~/xiaozhi/backup/ai-passport-4C11AE32DE8C-xiaozhi-2.5.1-20261009.bin` 解析结果相同（同表）。

## 3. 应用体积

| 指标 | 值 |
|---|---|
| 基线 app `.bin`（Muse UI + 通知） | **2,346,240 B**，sha256 `6858a7edda7466f8…` |
| `ota_0` 容量 | 3,080,192 B |
| 剩余 | **733,952 B（716.8 KiB）**，已用 76.2% |
| 参考：不含通知补丁的 Muse UI 版 | 2,326,048 B（通知补丁 +20,192 B） |
| Flash Code / Flash Data | 1,599,204 B / 670,248 B |
| 静态 DRAM（.data+.bss+IRAM .text） | 110,632 B / 321,296 B |
| 相关组件 | lvgl 260,721 B；main 215,248 B；esp-mqtt 约 16 KB |

## 4. 运行时 Heap（R07 基线）

| 场景 | 空闲 | 最低 | 最大连续块 | 来源 |
|---|---|---|---|---|
| 待机（Muse UI，无通知补丁） | 约 75 KB | 43 KB（激活 TLS 时） | 未测 | 2026-10-09 实机日志 |
| 待机 / 对话 / 通知播报（含通知补丁） | **待测** | **待测** | **待测** | 需设备连接；当前未连接 |

含通知补丁后多一条常驻 MQTT/WSS TLS 连接，最低空闲预计明显低于 43 KB，**必须实测后再定录音队列大小**（规范建议 8–16 KiB）。

## 5. 按键映射

`ai_passport_board.cc` 当前注册：UP 单击/长按（音量 +/最大），DOWN 单击/长按（音量 −/静音），OK 单击（切换对话 / 启动阶段进入配网）。**OK 长按未使用**，录音开始/停止拟用 OK 长按。

## 6. 与另一台 Mac 的差异

- IDF v6.0.1 vs v6.1：体积和 RAM 可能有小幅差异；最终验收应以实际烧录所用的构建为准。
- 真机当前运行哪一版（Mimi 版或通知版）未确认：设备未连接，待读 `ota_0` 应用描述。

## 7. 结论

**有条件 GO（构建侧）**：分区一致、基线可复现、Muse UI 源码保留、Flash 余量 716.8 KiB 足够。
**运行时 Heap 为 BLOCKED**：需设备连接测量含通知补丁的待机/对话/播报水位后，确定录音队列容量；在此之前 P3 只做实现与 host 测试，不烧录。
