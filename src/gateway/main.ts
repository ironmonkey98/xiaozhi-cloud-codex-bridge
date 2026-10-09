import { join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { NotificationOutbox } from '../notifications/outbox.ts';
import { notificationConfigSchema } from '../notifications/signal.ts';
import { MockCodexRunner, SdkCodexRunner } from '../codex/runner.ts';
import { loadDotEnv, loadGatewayConfig, loadProjects } from '../config.ts';
import { log } from '../security/redact.ts';
import { TaskQueue } from '../tasks/queue.ts';
import { TaskStore } from '../tasks/store.ts';
import { createGatewayServer } from './http.ts';

loadDotEnv();
const config = loadGatewayConfig();
const projects = loadProjects(config.projectsPath);
const store = new TaskStore(join(config.dataDir, 'tasks.sqlite'));

const interrupted = store.markUnfinishedInterrupted('电脑端服务重启，这个任务被中断了，请重新提交。');
const purged = store.purgeOlderThan(Date.now() - projects.taskRetentionDays * 86_400_000);

const runner = config.codexMock ? new MockCodexRunner() : new SdkCodexRunner();
const queue = new TaskQueue({ store, runner, projects, timeoutMs: config.taskTimeoutMs, maxQueue: config.maxQueue });
const root = resolve(import.meta.dirname, '../..');
const notifyPath = join(root, 'config/notify.local.json');
const notifyConfig = !config.codexMock && existsSync(notifyPath)
  ? notificationConfigSchema.parse(JSON.parse(readFileSync(notifyPath, 'utf8'))) : undefined;
const binding = notifyConfig ? createHash('sha256').update(`${notifyConfig.namespace}:${notifyConfig.device_id}`).digest('hex').slice(0, 16) : '';
const notifications = notifyConfig ? { namespace: notifyConfig.namespace, outbox: new NotificationOutbox(join(root, 'data', `notify-${binding}.sqlite`)) } : undefined;
const server = createGatewayServer({ token: config.token, queue, projects, runner, notifications });
let notifyChild: ChildProcess | undefined;
let stopping = false;
function startNotifications(): void {
  if (!notifications || stopping) return;
  notifyChild = spawn(process.execPath, [join(root, 'scripts/notify-relay.ts')], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  if (notifyChild.pid) writeFileSync(join(root, 'data/notify-relay.pid'), String(notifyChild.pid), { mode: 0o600 });
  notifyChild.on('error', () => log('warn', 'notification relay failed to start'));
  notifyChild.once('exit', () => {
    if (!stopping) setTimeout(startNotifications, 5000);
  });
}

server.listen(config.port, config.host, () => {
  startNotifications();
  log('info', 'gateway listening', {
    host: config.host,
    port: config.port,
    projects: [...projects.projects.keys()],
    codex: config.codexMock ? 'mock' : 'sdk',
    interrupted,
    purged,
  });
});

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  notifyChild?.kill('SIGTERM');
  log('info', 'gateway stopping', { signal });
  queue.abortAll();
  server.close();
  void queue.idle().finally(() => {
    store.close();
    notifications?.outbox.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
