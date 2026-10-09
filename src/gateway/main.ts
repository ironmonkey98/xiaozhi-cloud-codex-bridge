import { join } from 'node:path';
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
const server = createGatewayServer({ token: config.token, queue, projects, runner });

server.listen(config.port, config.host, () => {
  log('info', 'gateway listening', {
    host: config.host,
    port: config.port,
    projects: [...projects.projects.keys()],
    codex: config.codexMock ? 'mock' : 'sdk',
    interrupted,
    purged,
  });
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log('info', 'gateway stopping', { signal });
  queue.abortAll();
  server.close();
  void queue.idle().finally(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
