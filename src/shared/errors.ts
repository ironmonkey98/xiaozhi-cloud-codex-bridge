// 稳定错误码：对外（MCP / HTTP）只暴露 code 与中文 spoken_text，不暴露堆栈、路径或环境变量。
export const ERROR_CODES = [
  'NOT_READY',
  'AUTH_REQUIRED',
  'INVALID_REQUEST',
  'PROJECT_NOT_ALLOWED',
  'PATH_NOT_ALLOWED',
  'APPROVAL_REQUIRED',
  'TASK_NOT_FOUND',
  'TASK_BUSY',
  'TASK_ALREADY_FINISHED',
  'CODEX_FAILED',
  'CODEX_UNAVAILABLE',
  'TIMED_OUT',
  'INTERRUPTED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  NOT_READY: 503,
  AUTH_REQUIRED: 401,
  INVALID_REQUEST: 400,
  PROJECT_NOT_ALLOWED: 403,
  PATH_NOT_ALLOWED: 403,
  APPROVAL_REQUIRED: 403,
  TASK_NOT_FOUND: 404,
  TASK_BUSY: 429,
  TASK_ALREADY_FINISHED: 409,
  CODEX_FAILED: 502,
  CODEX_UNAVAILABLE: 503,
  TIMED_OUT: 504,
  INTERRUPTED: 500,
  INTERNAL: 500,
};

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly spokenText: string;

  constructor(code: ErrorCode, spokenText: string) {
    super(`${code}: ${spokenText}`);
    this.code = code;
    this.spokenText = spokenText;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}
