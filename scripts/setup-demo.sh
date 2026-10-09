#!/usr/bin/env bash
# 创建一个只含公开测试文件的 Demo 项目（Git 仓库），并生成 config/projects.json（若尚不存在）。
# 用法：scripts/setup-demo.sh [目标目录]，默认 ~/CodexVoiceSandbox/demo。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$HOME/CodexVoiceSandbox/demo}"

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "目标目录已存在且非空：$TARGET（不会覆盖）" >&2
else
  mkdir -p "$TARGET/src" "$TARGET/tests"
  cat > "$TARGET/README.md" <<'EOF'
# Demo 计算器

一个用于语音只读分析演示的小项目：`src/calc.js` 提供四则运算，`src/format.js` 负责结果格式化，`tests/` 为单元测试。
EOF
  cat > "$TARGET/src/calc.js" <<'EOF'
export function add(a, b) { return a + b; }
export function sub(a, b) { return a - b; }
export function mul(a, b) { return a * b; }
export function div(a, b) {
  if (b === 0) throw new Error('除数不能为 0');
  return a / b;
}
EOF
  cat > "$TARGET/src/format.js" <<'EOF'
import { add } from './calc.js';
export function formatSum(a, b) { return `${a} + ${b} = ${add(a, b)}`; }
EOF
  cat > "$TARGET/tests/calc.test.js" <<'EOF'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { div } from '../src/calc.js';
test('div', () => assert.equal(div(6, 3), 2));
// 故意的失败用例，供“测试为什么失败”演示
test('div by zero returns Infinity', () => assert.equal(div(1, 0), Infinity));
EOF
  echo '{ "name": "demo-calc", "type": "module", "private": true }' > "$TARGET/package.json"
  git -C "$TARGET" init -q
  echo "已创建 Demo 项目：$TARGET"
fi

REAL_TARGET="$(cd "$TARGET" && pwd -P)"
PROJECTS="$ROOT/config/projects.json"
if [ -f "$PROJECTS" ]; then
  echo "config/projects.json 已存在，未修改；如需加入 Demo，请把 workspace 设为：$REAL_TARGET"
else
  cat > "$PROJECTS" <<EOF
{
  "projects": [
    {
      "project_id": "demo",
      "display_name": "演示代码项目",
      "workspace": "$REAL_TARGET",
      "mode": "read-only"
    }
  ],
  "max_concurrent_tasks": 1,
  "voice_summary_max_chars": 200,
  "task_retention_days": 7
}
EOF
  echo "已生成 config/projects.json"
fi
