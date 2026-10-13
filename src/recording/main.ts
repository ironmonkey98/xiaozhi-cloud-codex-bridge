// recording-ingest service: MQTT <-> RecordingIngest. Config: config/recording.local.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect } from 'mqtt';
import { z } from 'zod';
import { RecordingIngest } from './ingest.ts';
import { makeFinalizer } from './finalize.ts';
import { deviceIdSchema, recordingTopics } from './protocol.ts';
import { startApi } from './api.ts';
import { DownloadTokens, Transcriber } from './transcribe.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const recordingConfigSchema = z.object({
  url: z.url().refine((raw) => {
    const url = new URL(raw);
    if (url.protocol === 'mqtts:' || url.protocol === 'wss:') return true;
    return (url.protocol === 'mqtt:' || url.protocol === 'ws:') && LOOPBACK.has(url.hostname);
  }, 'Plain MQTT is only allowed on loopback'),
  username: z.string().min(1),
  password: z.string().min(16),
  devices: z.array(deviceIdSchema).min(1),
  data_dir: z.string().min(1),
  python: z.string().min(1),
  finalize_script: z.string().min(1),
  /** Loopback HTTP server for nginx: Bailian download links and the read-only recording API. */
  api: z.object({
    port: z.number().int().min(1024).max(65535),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  /** Bailian Fun-ASR; needs `api` for the download links. */
  transcription: z.object({
    api_key: z.string().min(20),
    public_base_url: z.url().refine((u) => u.startsWith('https://'), 'Bailian must fetch over HTTPS'),
    model: z.string().min(1).optional(),
  }).strict().optional(),
}).strict().refine((c) => !c.transcription || c.api, 'transcription requires api');

const root = resolve(import.meta.dirname, '..', '..');
const configPath = process.env.RECORDING_CONFIG ?? resolve(root, 'config/recording.local.json');
const config = recordingConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));

const client = connect(config.url, {
  username: config.username, password: config.password,
  clientId: `recording-ingest-${process.pid}`, reconnectPeriod: 5000, connectTimeout: 10_000, clean: true,
});

const ingest = new RecordingIngest({
  dataDir: resolve(root, config.data_dir),
  allowedDevices: new Set(config.devices),
  publish: (deviceId, message) => {
    client.publish(recordingTopics(deviceId).ack, JSON.stringify(message), { qos: 1, retain: false });
  },
  finalize: makeFinalizer(resolve(root, config.python), resolve(root, config.finalize_script)),
  log,
});
ingest.recover();

client.on('connect', () => {
  const topics = config.devices.flatMap((id) => {
    const t = recordingTopics(id);
    return [t.request, t.audio];
  });
  client.subscribe(topics, { qos: 1 }, (err) => {
    log(err ? { event: 'subscribe_failed' } : { event: 'ingest_connected', devices: config.devices.length });
  });
});
client.on('error', () => log({ event: 'mqtt_error' }));
client.on('message', (topic, payload) => ingest.handleMessage(topic, payload));

const timer = setInterval(() => ingest.tick(), 500);

const tokens = new DownloadTokens();
const apiServer = config.api
  ? startApi(config.api.port, { dataDir: resolve(root, config.data_dir), token: config.api.token, tokens, log })
  : null;
const transcriber = config.transcription
  ? new Transcriber({ dataDir: resolve(root, config.data_dir), apiKey: config.transcription.api_key,
    publicBaseUrl: config.transcription.public_base_url.replace(/\/$/, ''), model: config.transcription.model, tokens, log })
  : null;
const transcribeTimer = transcriber
  ? setInterval(() => void transcriber.runOnce().catch(() => log({ event: 'transcriber_error' })), 10_000)
  : null;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (transcribeTimer) clearInterval(transcribeTimer);
  apiServer?.close();
  await ingest.settle();
  ingest.close();
  await client.endAsync();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
log({ event: 'ingest_started', api: config.api !== undefined, transcription: transcriber !== null });
