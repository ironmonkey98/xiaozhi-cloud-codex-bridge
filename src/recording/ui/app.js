// Recording management page. Talks only to the login-protected API next to it.
// All data goes into the page through textContent; never through innerHTML.
'use strict';

// Login is a password exchanged for an HttpOnly session cookie; this script never sees a credential.
const API = '../v1/recordings';
const $ = (id) => document.getElementById(id);

let current = null;      // recording shown in the dialog
let audioUrl = '';       // object URL of the loaded audio
let transcriptText = '';

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) {
    showLogin('');
    throw new Error('unauthorized');
  }
  return res;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const STATE = { saved: '完整', partial: '不完整', failed: '失败' };
const TSTATE = { done: '已转写', pending: '等待转写', running: '转写中', failed: '转写失败', none: '无转写' };

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Text with every occurrence of q wrapped in <mark>, built from text nodes only. */
function highlighted(text, q) {
  const frag = document.createDocumentFragment();
  if (!q) { frag.append(text); return frag; }
  const lower = text.toLowerCase();
  let at = 0;
  for (let hit = lower.indexOf(q); hit >= 0; hit = lower.indexOf(q, at)) {
    frag.append(text.slice(at, hit), el('mark', {}, text.slice(hit, hit + q.length)));
    at = hit + q.length;
  }
  frag.append(text.slice(at));
  return frag;
}

async function load() {
  const q = $('q').value.trim();
  $('status').textContent = '加载中…';
  try {
    const res = await api(`?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { recordings } = await res.json();
    render(recordings, q.toLowerCase());
    const total = recordings.reduce((sum, r) => sum + r.duration_ms, 0);
    $('status').textContent = q
      ? `找到 ${recordings.length} 条包含“${q}”的录音`
      : `共 ${recordings.length} 条录音，总时长 ${fmtDuration(total)}`;
  } catch (err) {
    if (err.message !== 'unauthorized') $('status').textContent = `加载失败：${err.message}`;
  }
}

function render(recordings, q) {
  const list = $('list');
  list.replaceChildren();
  for (const r of recordings) {
    const t = r.transcript;
    const li = el('li', { tabindex: '0' },
      el('div', { class: 'row' },
        el('span', { class: 'when' }, fmtTime(r.created_at)),
        el('span', {}, fmtDuration(r.duration_ms)),
        el('span', { class: `tag ${r.state}` }, STATE[r.state] || r.state),
        r.state !== 'failed' ? el('span', { class: `tag ${t.state}` }, TSTATE[t.state] || t.state) : null),
      el('p', { class: 'preview' },
        r.match ? highlighted(r.match, q) : t.preview ? `${t.preview}${t.chars > t.preview.length ? '…' : ''}`
          : t.error ? `错误：${t.error}` : ''));
    li.addEventListener('click', () => open(r));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(r); });
    list.append(li);
  }
}

function resetDetail() {
  const audio = $('d-audio');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = '';
  transcriptText = '';
  $('d-sentences').replaceChildren();
  $('d-note').textContent = '';
}

async function open(r) {
  resetDetail();
  current = r;
  $('d-title').textContent = fmtTime(r.created_at);
  $('d-meta').textContent = `${fmtDuration(r.duration_ms)} · ${STATE[r.state] || r.state} · ${TSTATE[r.transcript.state] || ''}` +
    ` · ID ${r.recording_id}`;
  $('d-copy').disabled = true;
  $('d-download').disabled = r.state === 'failed';
  $('d-audio').hidden = r.state === 'failed';
  $('detail').showModal();

  if (r.transcript.state === 'done') {
    $('d-note').textContent = '加载转写…';
    try {
      const res = await api(`/${r.recording_id}/transcript`);
      const t = await res.json();
      if (current !== r) return;
      transcriptText = t.text;
      $('d-copy').disabled = false;
      $('d-note').textContent = r.state === 'partial' ? '录音不完整，转写可能缺少片段。' : '';
      const items = t.sentences.length ? t.sentences : [{ begin_ms: 0, text: t.text }];
      $('d-sentences').replaceChildren(...items.map((s) => {
        const li = el('li', {}, el('span', { class: 't' }, fmtDuration(s.begin_ms)), el('span', {}, s.text));
        li.addEventListener('click', () => seek(s.begin_ms));
        return li;
      }));
    } catch (err) {
      if (current === r && err.message !== 'unauthorized') $('d-note').textContent = `转写加载失败：${err.message}`;
    }
  } else if (r.transcript.error) {
    $('d-note').textContent = `转写失败：${r.transcript.error}`;
  } else if (r.state !== 'failed') {
    $('d-note').textContent = '转写还没完成，稍后刷新。';
  }

  if (r.state !== 'failed') loadAudio(r);
}

async function loadAudio(r) {
  try {
    const res = await api(`/${r.recording_id}/audio`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (current !== r) return;
    audioUrl = URL.createObjectURL(blob);
    $('d-audio').src = audioUrl;
  } catch (err) {
    if (current === r && err.message !== 'unauthorized') $('d-note').textContent = `音频加载失败：${err.message}`;
  }
}

function seek(ms) {
  const audio = $('d-audio');
  if (!audio.src) return;
  audio.currentTime = ms / 1000;
  audio.play().catch(() => {});
}

$('d-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(transcriptText);
    $('d-note').textContent = '已复制全文。';
  } catch {
    $('d-note').textContent = '复制失败：浏览器不允许访问剪贴板。';
  }
});

$('d-download').addEventListener('click', () => {
  if (!audioUrl || !current) { $('d-note').textContent = '音频还在加载。'; return; }
  const a = el('a', { href: audioUrl, download: `recording-${current.created_at.slice(0, 16).replace(/[:T]/g, '-')}.ogg` });
  document.body.append(a);
  a.click();
  a.remove();
});

$('d-delete').addEventListener('click', async () => {
  const r = current;
  if (!r) return;
  if (!confirm(`删除 ${fmtTime(r.created_at)} 的录音（${fmtDuration(r.duration_ms)}）？\n音频和转写都会删除，不能恢复。`)) return;
  try {
    const res = await api(`/${r.recording_id}`, { method: 'DELETE' });
    if (res.status === 409) { $('d-note').textContent = '正在转写，稍后再删除。'; return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $('detail').close();
    load();
  } catch (err) {
    if (err.message !== 'unauthorized') $('d-note').textContent = `删除失败：${err.message}`;
  }
});

$('d-close').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => { current = null; resetDetail(); });

function showLogin(message) {
  $('app').hidden = true;
  $('logout').hidden = true;
  $('login').hidden = false;
  $('login-error').hidden = !message;
  $('login-error').textContent = message;
  if ($('detail').open) $('detail').close();
  $('password').focus();
}

function enter() {
  $('login').hidden = true;
  $('app').hidden = false;
  $('logout').hidden = false;
  load();
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-btn').disabled = true;
  try {
    const res = await fetch('login', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
    if (res.ok) {
      $('password').value = '';
      enter();
      return;
    }
    $('login-error').hidden = false;
    $('login-error').textContent = res.status === 429 ? '尝试次数过多，请 1 分钟后再试。'
      : res.status === 401 ? '密码不对。' : `登录失败：HTTP ${res.status}`;
  } catch (err) {
    $('login-error').hidden = false;
    $('login-error').textContent = `登录失败：${err.message}`;
  } finally {
    $('login-btn').disabled = false;
  }
});
$('logout').addEventListener('click', async () => {
  try { await fetch('logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* offline: cookie stays */ }
  showLogin('已退出。');
});
$('search').addEventListener('submit', (e) => { e.preventDefault(); load(); });
$('refresh').addEventListener('click', () => { $('q').value = ''; load(); });

// The first list call shows the login form when there is no valid session.
enter();
