// Loopback HTTP server behind nginx (port 8443): Bailian's audio download links, the
// recording API for the Mac bridge and the management page. Contract: docs/RECORDING_API.md.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { SessionMeta } from './session.ts';
import { type DownloadTokens, readTranscriptStatus, type Transcript } from './transcribe.ts';

export interface ApiOptions {
  dataDir: string;
  token: string;
  tokens: DownloadTokens;
  /** `scrypt$<salt hex>$<hash hex>` from hashUiPassword(); the page login is off without it. */
  uiPasswordHash?: string;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

const SESSION_COOKIE = 'rec_session';
const SESSION_MS = 30 * 24 * 3600_000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 5;

/** Hash for the page password; the plain password is never stored. */
export function hashUiPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const m = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored);
  if (!m) return false;
  return timingSafeEqual(scryptSync(password, Buffer.from(m[1]!, 'hex'), 32), Buffer.from(m[2]!, 'hex'));
}

const ID = /^[a-f0-9]{32}$/;
const UI_DIR = join(import.meta.dirname, 'ui');
const UI_FILES: Record<string, { file: string; type: string }> = {
  '/recording-api/ui/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/recording-api/ui/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/recording-api/ui/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
// The page holds no data; everything it shows comes from the token-protected API.
const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src blob:; " +
  "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store' });
  res.end(data);
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sessionCookie(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value && /^[a-f0-9]{64}$/.test(value)) return value;
  }
  return '';
}

/** Reads a small JSON body; null when it is too large or not JSON. */
function readJson(req: IncomingMessage, limit = 1024): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function readMeta(dataDir: string, id: string): SessionMeta | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'sessions', id, 'meta.json'), 'utf8')) as SessionMeta;
  } catch {
    return null;
  }
}

function readTranscript(dataDir: string, id: string): Transcript | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'sessions', id, 'transcript.json'), 'utf8')) as Transcript;
  } catch {
    return null;
  }
}

/** Finished sessions only; receiving/finishing ones are not recordings yet. */
function recordingOf(dataDir: string, meta: SessionMeta) {
  if (meta.state !== 'saved' && meta.state !== 'partial' && meta.state !== 'failed') return null;
  const id = meta.session_id;
  const status = meta.state === 'failed' ? null : readTranscriptStatus(join(dataDir, 'sessions', id));
  const transcript = status?.state === 'done' ? readTranscript(dataDir, id) : null;
  return {
    recording_id: id,
    created_at: meta.created_at,
    duration_ms: meta.result?.ok ? meta.result.duration_ms ?? 0 : 0,
    state: meta.state,
    transcript: {
      state: status ? (status.state === 'running' ? 'running' : status.state === 'none' ? 'pending' : status.state) : 'none',
      chars: transcript ? transcript.text.length : null,
      preview: transcript ? transcript.text.slice(0, 80) : null,
      error: status?.state === 'failed' ? status.error : null,
    },
  };
}

export function startApi(port: number, o: ApiOptions): Server {
  const now = o.now ?? Date.now;
  const sessions = new Map<string, number>(); // session id -> expiry
  let failures: number[] = [];

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      send(res, 500, { error: 'internal' });
    }
  });

  function authorized(req: IncomingMessage): boolean {
    if (bearerMatches(req, o.token)) return true;
    const id = sessionCookie(req);
    const expiry = id ? sessions.get(id) : undefined;
    if (expiry === undefined) return false;
    if (expiry <= now()) {
      sessions.delete(id);
      return false;
    }
    return true;
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!o.uiPasswordHash) return send(res, 404, { error: 'not_found' });
    // JSON only: a cross-site form cannot send it without a CORS preflight, which is never allowed.
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'bad_request' });
    const t = now();
    failures = failures.filter((x) => x > t - LOGIN_WINDOW_MS);
    if (failures.length >= LOGIN_MAX_FAILURES) return send(res, 429, { error: 'too_many_attempts' });
    const body = await readJson(req);
    const password = typeof body === 'object' && body !== null ? (body as { password?: unknown }).password : undefined;
    if (typeof password !== 'string' || password.length > 200 || !passwordMatches(password, o.uiPasswordHash)) {
      failures.push(t);
      o.log?.({ event: 'ui_login_failed' });
      return send(res, 401, { error: 'unauthorized' });
    }
    for (const [id, expiry] of sessions) if (expiry <= t) sessions.delete(id);
    const id = randomBytes(32).toString('hex');
    sessions.set(id, t + SESSION_MS);
    o.log?.({ event: 'ui_login' });
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; Path=/recording-api/; Max-Age=${SESSION_MS / 1000}; ` +
      'HttpOnly; Secure; SameSite=Strict');
    send(res, 200, { ok: true });
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'POST' && path === '/recording-api/ui/login') {
      void login(req, res).catch(() => send(res, 500, { error: 'internal' }));
      return;
    }
    if (req.method === 'POST' && path === '/recording-api/ui/logout') {
      sessions.delete(sessionCookie(req));
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/recording-api/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'GET' && !(req.method === 'DELETE' && path.startsWith('/recording-api/v1/recordings/'))) {
      return send(res, 405, { error: 'method_not_allowed' });
    }

    if (path === '/recording-api/ui') {
      res.writeHead(301, { Location: '/recording-api/ui/' });
      res.end();
      return;
    }
    const ui = UI_FILES[path];
    if (ui) {
      const data = readFileSync(join(UI_DIR, ui.file));
      res.writeHead(200, { 'Content-Type': ui.type, 'Content-Length': data.length, 'Cache-Control': 'no-cache',
        'Content-Security-Policy': UI_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(data);
      return;
    }

    // Bailian download link: unguessable, short-lived, no other auth.
    const dl = /^\/recording-dl\/([a-f0-9]{48})$/.exec(path);
    if (dl) {
      const id = o.tokens.resolve(dl[1]!);
      const file = id ? join(o.dataDir, 'recordings', `${id}.ogg`) : '';
      let size = 0;
      try {
        size = id ? statSync(file).size : 0;
      } catch { /* missing */ }
      if (!id || size === 0) return send(res, 404, { error: 'not_found' });
      o.log?.({ event: 'audio_downloaded', recording_id: id });
      res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Content-Length': size, 'Cache-Control': 'no-store' });
      createReadStream(file).pipe(res);
      return;
    }

    const api = /^\/recording-api\/v1\/recordings(?:\/([^/]+)(\/transcript|\/audio)?)?$/.exec(path);
    if (!api) return send(res, 404, { error: 'not_found' });
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    const [, id, part] = api;

    if (!id) {
      const limitRaw = url.searchParams.get('limit') ?? '10';
      const limit = Number(limitRaw);
      if (!/^\d+$/.test(limitRaw) || limit < 1 || limit > 200) return send(res, 400, { error: 'bad_request' });
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (q.length > 100) return send(res, 400, { error: 'bad_request' });
      let ids: string[] = [];
      try {
        ids = readdirSync(join(o.dataDir, 'sessions')).filter((x) => ID.test(x));
      } catch { /* none yet */ }
      let recordings = ids.map((x) => readMeta(o.dataDir, x)).filter((m): m is SessionMeta => m !== null)
        .map((m) => recordingOf(o.dataDir, m)).filter((r) => r !== null)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (q) {
        // Search only reads transcripts that are done; the result adds a short snippet around the first hit.
        recordings = recordings.flatMap((r) => {
          const text = r.transcript.state === 'done' ? readTranscript(o.dataDir, r.recording_id)?.text ?? '' : '';
          const at = text.toLowerCase().indexOf(q);
          if (at < 0) return [];
          const from = Math.max(0, at - 30);
          return [{ ...r, match: (from > 0 ? '…' : '') + text.slice(from, at + q.length + 50) }];
        });
      }
      return send(res, 200, { recordings: recordings.slice(0, limit) });
    }

    if (!ID.test(id)) return send(res, 400, { error: 'bad_request' });
    const meta = readMeta(o.dataDir, id);
    const recording = meta ? recordingOf(o.dataDir, meta) : null;
    if (!recording) return send(res, 404, { error: 'not_found' });

    if (req.method === 'DELETE') {
      if (part) return send(res, 405, { error: 'method_not_allowed' });
      // The transcriber sets "running" in the same tick it picks a recording, so this check cannot race it.
      if (recording.transcript.state === 'running') return send(res, 409, { error: 'transcript_running' });
      rmSync(join(o.dataDir, 'sessions', id), { recursive: true, force: true });
      rmSync(join(o.dataDir, 'recordings', `${id}.ogg`), { force: true });
      o.log?.({ event: 'recording_deleted', recording_id: id });
      return send(res, 200, { deleted: id });
    }
    if (!part) return send(res, 200, recording);

    if (part === '/audio') {
      const file = join(o.dataDir, 'recordings', `${id}.ogg`);
      let size = 0;
      try {
        size = statSync(file).size;
      } catch { /* failed recordings have no audio */ }
      if (size === 0) return send(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Content-Length': size, 'Cache-Control': 'no-store' });
      createReadStream(file).pipe(res);
      return;
    }

    if (recording.transcript.state === 'failed') return send(res, 409, { error: 'transcript_failed', state: 'failed' });
    const transcript = recording.transcript.state === 'done' ? readTranscript(o.dataDir, id) : null;
    if (!transcript) return send(res, 409, { error: 'transcript_not_ready', state: recording.transcript.state });
    return send(res, 200, transcript);
  }

  server.listen(port, '127.0.0.1');
  return server;
}
