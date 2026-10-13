// Loopback HTTP server behind nginx (port 8443): Bailian's audio download links and the
// read-only recording API for the Mac bridge. Contract: docs/RECORDING_API.md.
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { SessionMeta } from './session.ts';
import { type DownloadTokens, readTranscriptStatus, type Transcript } from './transcribe.ts';

export interface ApiOptions {
  dataDir: string;
  token: string;
  tokens: DownloadTokens;
  log?: (event: Record<string, unknown>) => void;
}

const ID = /^[a-f0-9]{32}$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store' });
  res.end(data);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
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
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      send(res, 500, { error: 'internal' });
    }
  });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

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

    const api = /^\/recording-api\/v1\/recordings(?:\/([^/]+)(\/transcript)?)?$/.exec(path);
    if (!api) return send(res, 404, { error: 'not_found' });
    if (!authorized(req, o.token)) return send(res, 401, { error: 'unauthorized' });
    const [, id, transcriptPart] = api;

    if (!id) {
      const limitRaw = url.searchParams.get('limit') ?? '10';
      const limit = Number(limitRaw);
      if (!/^\d+$/.test(limitRaw) || limit < 1 || limit > 50) return send(res, 400, { error: 'bad_request' });
      let ids: string[] = [];
      try {
        ids = readdirSync(join(o.dataDir, 'sessions')).filter((x) => ID.test(x));
      } catch { /* none yet */ }
      const recordings = ids.map((x) => readMeta(o.dataDir, x)).filter((m): m is SessionMeta => m !== null)
        .map((m) => recordingOf(o.dataDir, m)).filter((r) => r !== null)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
      return send(res, 200, { recordings });
    }

    if (!ID.test(id)) return send(res, 400, { error: 'bad_request' });
    const meta = readMeta(o.dataDir, id);
    const recording = meta ? recordingOf(o.dataDir, meta) : null;
    if (!recording) return send(res, 404, { error: 'not_found' });
    if (!transcriptPart) return send(res, 200, recording);

    if (recording.transcript.state === 'failed') return send(res, 409, { error: 'transcript_failed', state: 'failed' });
    const transcript = recording.transcript.state === 'done' ? readTranscript(o.dataDir, id) : null;
    if (!transcript) return send(res, 409, { error: 'transcript_not_ready', state: recording.transcript.state });
    return send(res, 200, transcript);
  }

  server.listen(port, '127.0.0.1');
  return server;
}
