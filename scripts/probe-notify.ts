// Real cloud transport probe. The receiving client simulates the ESP32; it cannot prove wake or TTS.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectAsync } from 'mqtt';
import type { MqttClient } from 'mqtt';
import { loadDotEnv, readToken } from '../src/config.ts';
import { makeResultSignal, notificationConfigSchema, resultSignalSchema } from '../src/notifications/signal.ts';

function nextMessage(client: MqttClient, signal: AbortSignal): Promise<[string, Buffer]> {
  const result = new Promise<[string, Buffer]>((resolve, reject) => {
    const cleanup = () => { client.off('message', onMessage); signal.removeEventListener('abort', onAbort); };
    const onMessage = (topic: string, data: Buffer) => { cleanup(); resolve([topic, data]); };
    const onAbort = () => { cleanup(); reject(new Error('Timed out waiting for notification')); };
    client.once('message', onMessage);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Publishing can fail before the awaiting statement; preserve the eventual rejection safely.
  void result.catch(() => {});
  return result;
}

const root = resolve(import.meta.dirname, '..');
loadDotEnv(resolve(root, '.env'));
const config = notificationConfigSchema.parse(JSON.parse(readFileSync(resolve(root, 'config/notify.local.json'), 'utf8')));
const response = await fetch(`${process.env.GATEWAY_URL ?? `http://127.0.0.1:${process.env.GATEWAY_PORT ?? 18765}`}/internal/tasks/latest`, {
  headers: { authorization: `Bearer ${readToken()}`, 'x-bridge-namespace': config.namespace },
  signal: AbortSignal.timeout(5000),
});
const task = await response.json() as { ok: boolean; task_id: string; status: string };
if (!response.ok || !task.ok || !['succeeded', 'failed', 'canceled', 'timed_out'].includes(task.status)) {
  throw new Error('The local gateway must have a finished task to probe');
}
const signal = makeResultSignal(config.namespace, task.task_id, Date.now());
const topic = `devices/${config.device_id}/notify/${signal.event_id}`;
const ackTopic = `devices/${config.device_id}/ack`;
const clients = [];
try {
  const device = await connectAsync(config.url, { ...config.device, clientId: `probe-device-${Date.now()}`, reconnectPeriod: 0, connectTimeout: 10000 });
  clients.push(device);
  const gateway = await connectAsync(config.url, { ...config.gateway, clientId: `probe-gateway-${Date.now()}`, reconnectPeriod: 0, connectTimeout: 10000 });
  clients.push(gateway);
  await device.subscribeAsync(`devices/${config.device_id}/notify/+`, { qos: 1 });
  await gateway.subscribeAsync(ackTopic, { qos: 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const received = nextMessage(device, controller.signal);
    await gateway.publishAsync(topic, JSON.stringify(signal), { qos: 1 });
    const [receivedTopic, data] = await received;
    const parsed = resultSignalSchema.parse(JSON.parse(data.toString()));
    if (receivedTopic !== topic || parsed.event_id !== signal.event_id || parsed.expires_at <= Date.now()) throw new Error('Invalid delivered signal');
    const ack = nextMessage(gateway, controller.signal);
    await device.publishAsync(ackTopic, JSON.stringify({ event_id: parsed.event_id, stage: 'signal_received', receiver: 'software_probe' }), { qos: 1 });
    const [, ackData] = await ack;
    if (JSON.parse(ackData.toString()).event_id !== parsed.event_id) throw new Error('Mismatched acknowledgement');
    console.log(JSON.stringify({ transport: 'PASS', task_id: task.task_id, bytes: Buffer.byteLength(JSON.stringify(signal)), audio_sent: false, receiver: 'software_probe', device_wake: 'NOT_RUN', official_cloud_query: 'NOT_RUN', device_speech: 'NOT_RUN' }, null, 2));
  } finally { controller.abort(); clearTimeout(timer); }
} finally { await Promise.all(clients.map((client) => client.endAsync())); }
