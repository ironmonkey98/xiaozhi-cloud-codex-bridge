// 无硬件模拟小智调用：以 MCP 客户端身份启动 dist/mcp/stdio.js，调用一个工具并打印结果。
// 用法：node scripts/mcp-call.ts <tool> ['{"json":"args"}']
//      node scripts/mcp-call.ts --list
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadDotEnv } from '../src/config.ts';

const root = resolve(import.meta.dirname, '..');
loadDotEnv(resolve(root, '.env'));

const [tool, rawArgs] = process.argv.slice(2);
if (!tool) {
  console.error('用法：node scripts/mcp-call.ts <tool|--list> [json-args]');
  process.exit(2);
}

const env: Record<string, string> = { ...getDefaultEnvironment() };
for (const key of ['LOCAL_BRIDGE_TOKEN', 'GATEWAY_PORT', 'GATEWAY_URL', 'BRIDGE_NAMESPACE', 'LOG_LEVEL']) {
  if (process.env[key]) env[key] = process.env[key]!;
}

const client = new Client({ name: 'mcp-call', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'dist/mcp/stdio.js')], env, stderr: 'ignore' }),
);
try {
  if (tool === '--list') {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}: ${t.description}`);
  } else {
    const res = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
    console.log(JSON.stringify(res.structuredContent ?? res.content, null, 2));
  }
} finally {
  await client.close();
}
