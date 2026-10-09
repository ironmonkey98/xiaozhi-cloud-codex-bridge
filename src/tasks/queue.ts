import type { CodexRunner } from '../codex/runner.ts';
import type { ProjectsConfig } from '../config.ts';
import { assertInstructionAllowed, wrapInstruction } from '../security/policy.ts';
import { log } from '../security/redact.ts';
import { BridgeError } from '../shared/errors.ts';
import { toSpokenSummary } from '../speech/summary.ts';
import {
  FINAL_STATUSES,
  formatTaskId,
  parseTaskId,
  type TaskKind,
  type TaskRow,
  type TaskStatus,
  type TaskStore,
} from './store.ts';

/** 无 client_request_id 时，同内容重复提交的防重窗口。窗口外允许正常重试。 */
const DEDUPE_WINDOW_MS = 30_000;

// AbortSignal.reason 标记中止来源，决定任务终态。
const ABORT_CANCEL = 'cancel';
const ABORT_TIMEOUT = 'timeout';
const ABORT_SHUTDOWN = 'shutdown';

export interface SubmitInput {
  project_id: string;
  instruction: string;
  client_request_id?: string;
}

export interface TaskView {
  task_id: string;
  project_id: string;
  status: TaskStatus;
  spoken_summary: string;
  error_code: string | null;
}

export interface SubmitResult extends TaskView {
  accepted: boolean;
  /** 是否命中幂等（返回的是已存在的任务）。 */
  deduplicated: boolean;
}

export interface CancelResult {
  task_id: string;
  requested: boolean;
  actual_status: TaskStatus;
  spoken_summary: string;
}

export interface TaskQueueOptions {
  store: TaskStore;
  runner: CodexRunner;
  projects: ProjectsConfig;
  timeoutMs: number;
  maxQueue: number;
}

/** 任务受理、串行执行（全局并发 1）、查询与取消。MCP 断线不影响此处的任务。 */
export class TaskQueue {
  private readonly pending: number[] = [];
  private readonly running = new Map<number, AbortController>();
  private draining = false;
  private idleWaiters: (() => void)[] = [];

  private readonly opts: TaskQueueOptions;

  constructor(opts: TaskQueueOptions) {
    this.opts = opts;
  }

  submit(namespace: string, input: SubmitInput, kind: TaskKind): SubmitResult {
    const project = this.opts.projects.projects.get(input.project_id);
    if (!project) throw new BridgeError('PROJECT_NOT_ALLOWED', '这个项目不在允许列表里，请先在电脑上配置。');
    assertInstructionAllowed(input.instruction, project.mode);

    const newTask = {
      namespace,
      projectId: project.id,
      kind,
      instruction: input.instruction,
      clientRequestId: input.client_request_id ?? null,
    };
    const existing = newTask.clientRequestId
      ? this.opts.store.findByRequestId(namespace, newTask.clientRequestId)
      : this.opts.store.findRecentDuplicate(newTask, Date.now() - DEDUPE_WINDOW_MS);
    if (existing) return { accepted: true, deduplicated: true, ...this.view(existing) };

    if (this.pending.length + this.running.size >= this.opts.maxQueue) {
      throw new BridgeError('TASK_BUSY', '电脑上的任务已经排满了，请等前面的任务完成后再试。');
    }

    const row = this.opts.store.insert(newTask);
    this.pending.push(row.id);
    void this.drain();
    log('info', 'task accepted', { task_id: formatTaskId(row.id), project_id: project.id, kind });
    return {
      accepted: true,
      deduplicated: false,
      ...this.view(row),
      spoken_summary: `已开始处理${project.displayName}，任务号 ${formatTaskId(row.id)}，稍后可以问我刚才的结果。`,
    };
  }

  get(namespace: string, taskId: string): TaskView {
    return this.view(this.owned(namespace, taskId));
  }

  latest(namespace: string, projectId?: string): TaskView {
    if (projectId && !this.opts.projects.projects.has(projectId)) {
      throw new BridgeError('PROJECT_NOT_ALLOWED', '这个项目不在允许列表里。');
    }
    const row = this.opts.store.latest(namespace, projectId);
    if (!row) throw new BridgeError('TASK_NOT_FOUND', '还没有提交过任务。');
    return this.view(row);
  }

  cancel(namespace: string, taskId: string): CancelResult {
    const row = this.owned(namespace, taskId);
    const id = row.id;
    const tid = formatTaskId(id);

    const queuedText = `任务 ${tid} 还没开始，已经取消。`;
    if (this.opts.store.transition(id, ['queued'], 'canceled', { spoken_summary: queuedText })) {
      const index = this.pending.indexOf(id);
      if (index >= 0) this.pending.splice(index, 1);
      return { task_id: tid, requested: true, actual_status: 'canceled', spoken_summary: queuedText };
    }

    const controller = this.running.get(id);
    if (controller && this.opts.store.transition(id, ['running'], 'cancel_requested')) {
      controller.abort(ABORT_CANCEL);
      return {
        task_id: tid,
        requested: true,
        actual_status: 'cancel_requested',
        spoken_summary: `已请求取消任务 ${tid}，正在停止，稍后可以再确认状态。`,
      };
    }

    const current = this.opts.store.get(id)!;
    return {
      task_id: tid,
      requested: false,
      actual_status: current.status,
      spoken_summary: FINAL_STATUSES.has(current.status)
        ? `任务 ${tid} 已经结束，不需要取消。`
        : `任务 ${tid} 正在停止中。`,
    };
  }

  /** 测试与优雅退出用：等待队列清空。 */
  async idle(): Promise<void> {
    if (!this.draining && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** 停止接收：中止运行中的任务（重启后会被标记为中断）。 */
  abortAll(): void {
    this.pending.length = 0;
    for (const controller of this.running.values()) controller.abort(ABORT_SHUTDOWN);
  }

  private owned(namespace: string, taskId: string): TaskRow {
    const id = parseTaskId(taskId);
    const row = id === null ? undefined : this.opts.store.getOwned(namespace, id);
    if (!row) throw new BridgeError('TASK_NOT_FOUND', '没有找到这个任务，可以问我“刚才的任务”。');
    return row;
  }

  private view(row: TaskRow): TaskView {
    const tid = formatTaskId(row.id);
    const progress: Partial<Record<TaskStatus, string>> = {
      queued: `任务 ${tid} 正在排队，稍后再问我结果。`,
      running: `任务 ${tid} 正在分析中，还没有结论，稍后再问我。`,
      cancel_requested: `任务 ${tid} 正在取消。`,
    };
    return {
      task_id: tid,
      project_id: row.project_id,
      status: row.status,
      spoken_summary: progress[row.status] ?? row.spoken_summary ?? `任务 ${tid} 已结束。`,
      error_code: row.error_code,
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let id: number | undefined;
      while ((id = this.pending.shift()) !== undefined) await this.execute(id);
    } finally {
      this.draining = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private async execute(id: number): Promise<void> {
    const { store, runner, projects, timeoutMs } = this.opts;
    if (!store.transition(id, ['queued'], 'running')) return; // 已被取消
    const row = store.get(id)!;
    const project = projects.projects.get(row.project_id);
    const tid = formatTaskId(id);
    if (!project) {
      store.transition(id, ['running'], 'failed', {
        error_code: 'PROJECT_NOT_ALLOWED',
        spoken_summary: '这个项目已经从允许列表移除，任务没有执行。',
      });
      return;
    }

    const controller = new AbortController();
    this.running.set(id, controller);
    const timer = setTimeout(() => controller.abort(ABORT_TIMEOUT), timeoutMs);
    const threadId = row.kind === 'continue' ? (store.getThread(row.namespace, row.project_id) ?? null) : null;

    try {
      const result = await runner.run({
        workspace: project.workspace,
        mode: project.mode,
        threadId,
        input: wrapInstruction(row.instruction, project.mode, projects.voiceSummaryMaxChars),
        signal: controller.signal,
        onThreadId: (newThreadId) => {
          store.setThreadId(id, newThreadId);
          store.saveThread(row.namespace, row.project_id, newThreadId);
        },
      });
      store.setThreadId(id, result.threadId);
      store.saveThread(row.namespace, row.project_id, result.threadId);
      const ok = store.transition(id, ['running'], 'succeeded', {
        spoken_summary: toSpokenSummary(result.finalResponse, projects.voiceSummaryMaxChars),
        detailed_result: result.finalResponse,
      });
      // 取消请求与完成竞态：Codex 已经跑完，如实记为已取消但保留结果。
      if (!ok) {
        store.transition(id, ['cancel_requested'], 'canceled', {
          spoken_summary: `任务 ${tid} 在取消前已经完成，结果已保存在电脑上。`,
          detailed_result: result.finalResponse,
        });
      }
      log('info', 'task finished', { task_id: tid, status: ok ? 'succeeded' : 'canceled' });
    } catch (err) {
      const reason = controller.signal.aborted ? controller.signal.reason : undefined;
      if (reason === ABORT_TIMEOUT) {
        store.transition(id, ['running', 'cancel_requested'], 'timed_out', {
          error_code: 'TIMED_OUT',
          spoken_summary: `任务 ${tid} 超时了，已停止。可以把问题拆小一点再试。`,
        });
      } else if (reason === ABORT_SHUTDOWN) {
        store.transition(id, ['running', 'cancel_requested'], 'failed', {
          error_code: 'INTERRUPTED',
          spoken_summary: `任务 ${tid} 因电脑端服务停止而中断，请重新提交。`,
        });
      } else if (reason === ABORT_CANCEL) {
        store.transition(id, ['running', 'cancel_requested'], 'canceled', {
          error_code: null,
          spoken_summary: `任务 ${tid} 已取消。`,
        });
      } else {
        log('error', 'task failed', { task_id: tid, error: err instanceof Error ? err.message : String(err) });
        store.transition(id, ['running', 'cancel_requested'], 'failed', {
          error_code: 'CODEX_FAILED',
          spoken_summary: `任务 ${tid} 执行失败，请在电脑上查看日志。`,
          detailed_result: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      clearTimeout(timer);
      this.running.delete(id);
    }
  }
}
