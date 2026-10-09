#!/usr/bin/env bash
# 以出站 WSS 连接小智官方接入点，并把本项目的 MCP stdio 适配器挂载上去。
# 接入点地址只从 .env 的 XIAOZHI_MCP_ENDPOINT 读取；输出日志中的 token 会被脱敏。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIPE_DIR="$ROOT/external/mcp-calculator"
PYTHON="$ROOT/external/.venv/bin/python"
STDIO_JS="$ROOT/dist/mcp/stdio.js"
GENERATED_CONFIG="$ROOT/external/mcp_config.json"

[ -f "$ROOT/.env" ] || { echo "缺少 .env，请先 cp .env.example .env 并填写" >&2; exit 1; }
[ -x "$PYTHON" ] || { echo "未安装桥接器，请先执行 npm run setup:pipe" >&2; exit 1; }
[ -f "$STDIO_JS" ] || { echo "未构建，请先执行 npm run build" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

case "${XIAOZHI_MCP_ENDPOINT:-}" in
  wss://*) ;;
  "") echo "XIAOZHI_MCP_ENDPOINT 未设置：请在 xiaozhi.me 控制台 → 智能体 → MCP 设置 获取接入点" >&2; exit 1 ;;
  *) echo "XIAOZHI_MCP_ENDPOINT 必须以 wss:// 开头" >&2; exit 1 ;;
esac

# 根据当前机器生成 mcp_pipe 配置（绝对路径因机器而异，不入库）。
NODE_BIN="$(command -v node)"
cat > "$GENERATED_CONFIG" <<EOF
{
  "mcpServers": {
    "codex-local": {
      "type": "stdio",
      "command": "$NODE_BIN",
      "args": ["$STDIO_JS"]
    }
  }
}
EOF

export MCP_ENDPOINT="$XIAOZHI_MCP_ENDPOINT"
export MCP_CONFIG="$GENERATED_CONFIG"
unset XIAOZHI_MCP_ENDPOINT

cd "$PIPE_DIR"
"$PYTHON" -u mcp_pipe.py 2>&1 | sed -E -u 's/([?&](token|access_token|key)=)[^&[:space:]"]+/\1<redacted>/g'
