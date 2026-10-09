# 任务存储使用内置 node:sqlite，而非 better-sqlite3

规范推荐 `better-sqlite3`（Node 20+）。我们改用 Node 内置的 `node:sqlite`，并把 `engines` 提升到 Node ≥22：本机为 Node 26，原生模块存在编译与 ABI 兼容风险，内置模块零依赖且同步 API 足以满足单进程、并发 1 的任务存储。代价是放弃 Node 20 支持，且 `node:sqlite` 的稳定性级别需以锁定 Node 版本的官方文档为准。
