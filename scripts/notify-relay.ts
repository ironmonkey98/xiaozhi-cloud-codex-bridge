// Optional sidecar: the Gateway remains the only writer/authority for task state.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'mqtt';
import { z } from 'zod';
import { loadDotEnv, loadGatewayConfig } from '../src/config.ts';
import { notificationConfigSchema } from '../src/notifications/signal.ts';
import { NotificationOutbox } from '../src/notifications/outbox.ts';

const root = resolve(import.meta.dirname, '..');
loadDotEnv(resolve(root, '.env'));
const config = notificationConfigSchema.parse(JSON.parse(readFileSync(resolve(root, 'config/notify.local.json'), 'utf8')));
const tasks = new DatabaseSync(join(loadGatewayConfig().dataDir, 'tasks.sqlite'), { readOnly: true });
const binding = createHash('sha256').update(`${config.namespace}:${config.device_id}`).digest('hex').slice(0, 16);
const outbox = new NotificationOutbox(join(root, 'data', `notify-${binding}.sqlite`));
const client = connect(config.url, { ...config.gateway, clientId: `relay-${config.device_id}`, reconnectPeriod: 5000, connectTimeout: 10000 });
client.on('error', () => console.error('notification connection error; retrying'));
const ackSchema = z.object({ event_id: z.string().regex(/^[a-f0-9]{32}$/), stage: z.string(), receiver: z.string() }).strict();
const prefix = `devices/${config.device_id}/notify/`;
const ackTopic = `devices/${config.device_id}/ack`;
client.on('message', (topic, data) => {
  if (topic !== ackTopic || data.length > 512) return;
  try {
    const parsed = ackSchema.safeParse(JSON.parse(data.toString()));
    if (parsed.success && outbox.acknowledge(parsed.data.event_id, parsed.data.receiver, parsed.data.stage)) {
      console.log(JSON.stringify({ event: 'playback_completed', event_id: parsed.data.event_id, query_and_playback_confirmed: true }));
    }
  } catch { /* Ignore malformed device replies. */ }
});
client.on('connect', () => {
  void client.subscribeAsync(ackTopic, { qos: 1 }).then(() => console.log(JSON.stringify({ event: 'notification_channel_connected' })))
    .catch(() => console.error('notification subscription failed; reconnecting'));
});
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
console.log(JSON.stringify({ event: 'relay_started', device: config.device_id, audio_sent: false }));
try {
  while (!stopping) {
    const now = Date.now();
    const rows = tasks.prepare(`SELECT id, updated_at FROM tasks WHERE namespace = ?
      AND status IN ('succeeded', 'failed', 'timed_out') AND updated_at > ? ORDER BY updated_at`)
      .all(config.namespace, now - 86_400_000) as { id: number; updated_at: number }[];
    for (const row of rows) outbox.discover(config.namespace, `T-${row.id}`, row.updated_at, now);
    if (client.connected) {
      for (const signal of outbox.queryServed(now)) {
        await client.publishAsync(prefix + signal.event_id, JSON.stringify({ ...signal, type: 'query_served' }), { qos: 1, retain: true });
      }
      for (const signal of outbox.due(now)) {
        try {
          await client.publishAsync(prefix + signal.event_id, JSON.stringify(signal), { qos: 1, retain: true });
          outbox.sent(signal.event_id);
          console.log(JSON.stringify({ event: 'signal_published', task_id: signal.task_id, event_id: signal.event_id }));
        } catch { console.error('notification delivery pending; retrying'); break; }
      }
      for (const eventId of outbox.clearable(now)) {
        try { await client.publishAsync(prefix + eventId, '', { qos: 1, retain: true }); outbox.cleared(eventId); }
        catch { break; }
      }
    }
    outbox.prune(now);
    await delay(2000);
  }
} finally {
  await client.endAsync(); tasks.close(); outbox.close();
}
