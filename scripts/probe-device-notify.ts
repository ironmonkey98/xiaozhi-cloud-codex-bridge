// Replays a stored completed task to the actual ESP32. No software device and no new Codex run.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectAsync } from 'mqtt';
import { z } from 'zod';
import { loadDotEnv, readToken } from '../src/config.ts';
import { makeResultSignal, notificationConfigSchema } from '../src/notifications/signal.ts';

const root = resolve(import.meta.dirname, '..');
loadDotEnv(resolve(root, '.env'));
const config = notificationConfigSchema.parse(JSON.parse(readFileSync(resolve(root, 'config/notify.local.json'), 'utf8')));
const requestedTask = process.argv[2];
if (requestedTask && !/^T-\d{1,12}$/.test(requestedTask)) throw new Error('Invalid replay task ID');
const path = requestedTask ? `/internal/tasks/${requestedTask}` : '/internal/tasks/latest';
const response = await fetch(`${process.env.GATEWAY_URL ?? 'http://127.0.0.1:18765'}${path}`, {
  headers: { authorization: `Bearer ${readToken()}`, 'x-bridge-namespace': config.namespace }, signal: AbortSignal.timeout(5000),
});
const task = await response.json() as { ok: boolean; task_id: string; status: string };
if (!response.ok || !task.ok || !['succeeded', 'failed', 'canceled', 'timed_out'].includes(task.status)) throw new Error('No completed task to replay');
const signal = makeResultSignal(config.namespace, task.task_id, Date.now());
const topic = `devices/${config.device_id}/notify/${signal.event_id}`;
const ackTopic = `devices/${config.device_id}/ack`;
const ackSchema = z.object({ event_id: z.string(), stage: z.enum(['signal_received', 'wake_requested']), receiver: z.literal('firmware') }).strict();
const client = await connectAsync(config.url, { ...config.gateway, clientId: `real-device-probe-${Date.now()}`, reconnectPeriod: 0, connectTimeout: 10000 });
try {
  await client.subscribeAsync(ackTopic, { qos: 1 });
  const controller = new AbortController();
  let wakeRequested = false;
  client.on('message', (t, data) => {
    if (t !== ackTopic || data.length > 512) return;
    try {
      const parsed = ackSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || parsed.data.event_id !== signal.event_id) return;
      console.log(JSON.stringify({ event: 'device_ack', task_id: signal.task_id, ...parsed.data }));
      if (parsed.data.stage === 'wake_requested') { wakeRequested = true; controller.abort(); }
    } catch { /* Ignore unrelated or malformed acknowledgements. */ }
  });
  console.log(JSON.stringify({ event: 'device_probe_started', task_id: task.task_id, event_id: signal.event_id, audio_sent: false }));
  const end = Date.now() + 60_000;
  while (Date.now() < end && !wakeRequested) {
    await client.publishAsync(topic, JSON.stringify(signal), { qos: 1, retain: true });
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) { resolve(); return; }
      const onAbort = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, 10_000);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  await client.publishAsync(topic, '', { qos: 1, retain: true });
  console.log(JSON.stringify({ device_wake_request: wakeRequested ? 'PASS' : 'FAIL', official_cloud_query: 'REQUIRES_DEVICE_LOG', device_speech: 'REQUIRES_HUMAN_CONFIRMATION', audio_sent: false }));
  if (!wakeRequested) process.exitCode = 1;
} finally { await client.endAsync(); }
