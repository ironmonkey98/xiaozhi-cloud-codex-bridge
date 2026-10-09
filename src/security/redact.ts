import { homedir } from 'node:os';

/** 日志脱敏：URL 中的 token、Bearer 凭据、OpenAI 风格密钥、家目录绝对路径。 */
export function redact(text: string): string {
  const home = homedir();
  let out = text
    .replace(/([?&](?:token|access_token|key|api_key)=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>');
  if (home && home !== '/') out = out.split(home).join('~');
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 所有日志写 stderr（stdio MCP 进程的 stdout 专用于协议），并统一脱敏。 */
export function log(level: Level, message: string, extra?: Record<string, unknown>): void {
  const min = (process.env.LOG_LEVEL as Level) ?? 'info';
  if (ORDER[level] < (ORDER[min] ?? 20)) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, message, ...extra });
  process.stderr.write(redact(line) + '\n');
}
