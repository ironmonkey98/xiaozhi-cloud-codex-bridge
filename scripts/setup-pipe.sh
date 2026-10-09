#!/usr/bin/env bash
# 安装出站桥接器 78/mcp-calculator 的 mcp_pipe.py（固定 commit），以及它在 stdio 模式下实际需要的两个 Python 包。
# 只装到仓库内 external/ 的独立 venv，不做全局安装。
set -euo pipefail

REPO_URL="https://github.com/78/mcp-calculator"
PINNED_COMMIT="c537f71d61fd73b47d6c8955b5df6d3721acf4e4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/external/mcp-calculator"
VENV="$ROOT/external/.venv"

if [ ! -d "$DEST/.git" ]; then
  git clone --quiet "$REPO_URL" "$DEST"
fi
git -C "$DEST" fetch --quiet origin "$PINNED_COMMIT" 2>/dev/null || true
git -C "$DEST" checkout --quiet "$PINNED_COMMIT"
echo "mcp_pipe.py @ $(git -C "$DEST" rev-parse --short HEAD)"

if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
# requirements.txt 中的 mcp/fastmcp 需要 Python ≥3.10，且只服务于 sse/http 目标；stdio 目标只依赖下面两个包。
"$VENV/bin/pip" install --quiet --disable-pip-version-check "websockets==15.0.1" "python-dotenv==1.2.1"
echo "venv 就绪：$("$VENV/bin/python" --version)"
