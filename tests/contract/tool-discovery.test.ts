import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TEST_TOKEN } from '../helpers.ts';

test('独立 stdio 工具发现：11 个工具，录音 schema 严格且无路径或设备参数', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '../../dist/mcp/stdio.js')],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LOCAL_BRIDGE_TOKEN: TEST_TOKEN },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'tool-discovery-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    const recording = tools.filter((tool) => tool.name.startsWith('recording_'));
    assert.equal(recording.length, 3);
    for (const tool of recording) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /device_id|path|workspace|directory/);
    }
    assert.deepEqual(recording.find((t) => t.name === 'recording_to_codex')!.inputSchema.required, ['project_id', 'instruction']);
    const result = await client.callTool({ name: 'recording_get_transcript', arguments: { recording_id: '../x' } });
    assert.equal(result.isError, true);
  } finally { await client.close(); }
});
