import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancel_requested',
  'canceled',
  'timed_out',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['succeeded', 'failed', 'canceled', 'timed_out']);

export type TaskKind = 'submit' | 'continue';

export interface TaskRow {
  id: number;
  namespace: string;
  project_id: string;
  kind: TaskKind;
  instruction: string;
  client_request_id: string | null;
  status: TaskStatus;
  thread_id: string | null;
  spoken_summary: string | null;
  detailed_result: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewTask {
  namespace: string;
  projectId: string;
  kind: TaskKind;
  instruction: string;
  clientRequestId: string | null;
}

export const formatTaskId = (id: number): string => `T-${id}`;

export function parseTaskId(taskId: string): number | null {
  const m = /^T-(\d{1,12})$/.exec(taskId.trim());
  return m ? Number(m[1]) : null;
}

/** SQLite 持久化：任务、请求幂等、项目线程映射。所有查询都带 namespace（接入点身份）做归属隔离。 */
export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        instruction TEXT NOT NULL,
        client_request_id TEXT,
        status TEXT NOT NULL,
        thread_id TEXT,
        spoken_summary TEXT,
        detailed_result TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_request
        ON tasks(namespace, client_request_id) WHERE client_request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_latest ON tasks(namespace, id DESC);
      CREATE TABLE IF NOT EXISTS threads (
        namespace TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, project_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  insert(task: NewTask, now = Date.now()): TaskRow {
    const result = this.db
      .prepare(
        `INSERT INTO tasks (namespace, project_id, kind, instruction, client_request_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(task.namespace, task.projectId, task.kind, task.instruction, task.clientRequestId, now, now);
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  getOwned(namespace: string, id: number): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ? AND namespace = ?').get(id, namespace) as
      | TaskRow
      | undefined;
  }

  findByRequestId(namespace: string, clientRequestId: string): TaskRow | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE namespace = ? AND client_request_id = ?')
      .get(namespace, clientRequestId) as TaskRow | undefined;
  }

  /** 无 client_request_id 时的短窗口防重：同一接入点、同项目、同类型、同指令。 */
  findRecentDuplicate(task: NewTask, sinceMs: number): TaskRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE namespace = ? AND project_id = ? AND kind = ? AND instruction = ?
           AND created_at >= ? ORDER BY id DESC LIMIT 1`,
      )
      .get(task.namespace, task.projectId, task.kind, task.instruction, sinceMs) as TaskRow | undefined;
  }

  latest(namespace: string, projectId?: string): TaskRow | undefined {
    if (projectId) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE namespace = ? AND project_id = ? ORDER BY id DESC LIMIT 1')
        .get(namespace, projectId) as TaskRow | undefined;
    }
    return this.db.prepare('SELECT * FROM tasks WHERE namespace = ? ORDER BY id DESC LIMIT 1').get(namespace) as
      | TaskRow
      | undefined;
  }

  /**
   * 条件状态迁移（原子）：仅当当前状态属于 from 时才更新，返回是否生效。
   * 用于防止取消与完成的竞态把终态覆盖。
   */
  transition(
    id: number,
    from: readonly TaskStatus[],
    to: TaskStatus,
    fields: Partial<Pick<TaskRow, 'thread_id' | 'spoken_summary' | 'detailed_result' | 'error_code'>> = {},
    now = Date.now(),
  ): boolean {
    const sets = ['status = ?', 'updated_at = ?'];
    const values: (string | number | null)[] = [to, now];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      values.push(value ?? null);
    }
    const placeholders = from.map(() => '?').join(', ');
    const result = this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
      .run(...values, id, ...from);
    return Number(result.changes) === 1;
  }

  setThreadId(id: number, threadId: string): void {
    this.db.prepare('UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ?').run(threadId, Date.now(), id);
  }

  /** 进程重启：未结束的任务无法安全续跑，统一标记失败并注明中断。 */
  markUnfinishedInterrupted(spokenText: string): number {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', error_code = 'INTERRUPTED', spoken_summary = ?, updated_at = ?
         WHERE status IN ('queued', 'running', 'cancel_requested')`,
      )
      .run(spokenText, Date.now());
    return Number(result.changes);
  }

  purgeOlderThan(cutoffMs: number): number {
    return Number(this.db.prepare('DELETE FROM tasks WHERE updated_at < ?').run(cutoffMs).changes);
  }

  getThread(namespace: string, projectId: string): string | undefined {
    const row = this.db
      .prepare('SELECT thread_id FROM threads WHERE namespace = ? AND project_id = ?')
      .get(namespace, projectId) as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  saveThread(namespace: string, projectId: string, threadId: string): void {
    this.db
      .prepare(
        `INSERT INTO threads (namespace, project_id, thread_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace, project_id) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
      )
      .run(namespace, projectId, threadId, Date.now());
  }
}
