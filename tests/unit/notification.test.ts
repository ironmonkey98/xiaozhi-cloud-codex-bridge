import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResultSignal, resultSignalSchema } from '../../src/notifications/signal.ts';

test('completion hint is stable per task and isolated by namespace and completion', () => {
  const first = makeResultSignal('a', 'T-11', 1000);
  assert.deepEqual(first, makeResultSignal('a', 'T-11', 1000));
  assert.notEqual(first.event_id, makeResultSignal('b', 'T-11', 1000).event_id);
  assert.notEqual(first.event_id, makeResultSignal('a', 'T-11', 2000).event_id);
  assert.equal(first.expires_at, 86401000);
});

test('wake hint rejects audio payloads, paths, malformed task identifiers and extra instructions', () => {
  const signal = makeResultSignal('a', 'T-11', 1000);
  for (const extra of [{ audio_url: 'https://example.com/a.ogg' }, { text: 'run something' }, { path: '/etc' }]) {
    assert.equal(resultSignalSchema.safeParse({ ...signal, ...extra }).success, false);
  }
  assert.equal(resultSignalSchema.safeParse({ ...signal, task_id: '../secret' }).success, false);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationOutbox } from '../../src/notifications/outbox.ts';

test('a merged batch is completed only after the query and firmware playback, not wake', () => {
  const box = new NotificationOutbox(':memory:');
  try {
    box.discover('a', 'T-1', 100_000, 100_000);
    box.discover('a', 'T-2', 100_001, 100_001);
    const hint = box.due(100_001)[0]!;
    box.sent(hint.event_id, 100_001);
    assert.equal(box.acknowledge(hint.event_id, 'firmware', 'wake_requested'), false);
    assert.equal(box.acknowledge(hint.event_id, 'firmware', 'playback_completed'), false);
    assert.equal(box.queryServed(100_002).length, 0);
    assert.deepEqual(box.queryBatch(100_002).map((s) => s.task_id), ['T-1', 'T-2']);
    box.discover('a', 'T-3', 100_003, 100_003);
    assert.deepEqual(box.queryBatch(100_004).map((s) => s.task_id), ['T-1', 'T-2']);
    assert.equal(box.queryServed(100_004).length, 1);
    box.acknowledge(hint.event_id, 'firmware', 'query_started');
    assert.equal(box.queryServed(100_004).length, 0);
    assert.equal(box.acknowledge(hint.event_id, 'firmware', 'playback_completed'), false);
    box.queryBatch(100_005);
    assert.equal(box.acknowledge(hint.event_id, 'software_probe', 'playback_completed'), false);
    assert.equal(box.acknowledge(hint.event_id, 'firmware', 'playback_completed'), true);
    assert.deepEqual(box.due(100_004).map((s) => s.task_id), ['T-3']);
  } finally { box.close(); }
});

test('notification outbox survives restart and only queried firmware playback stops retries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-test-'));
  const path = join(dir, 'outbox.sqlite');
  let box = new NotificationOutbox(path);
  try {
    box.discover('a', 'T-11', 100_000, 100_000);
    box.discover('a', 'T-11', 100_000, 100_000);
    const signal = box.due(100_000)[0]!;
    assert.equal(box.due(100_000).length, 1);
    box.sent(signal.event_id, 100_000);
    box.close(); box = new NotificationOutbox(path);
    assert.equal(box.due(110_000).length, 0);
    assert.equal(box.due(115_000).length, 1);
    assert.equal(box.acknowledge(signal.event_id, 'software_probe', 'wake_requested'), false);
    assert.equal(box.acknowledge(signal.event_id, 'firmware', 'signal_received'), false);
    assert.equal(box.acknowledge(signal.event_id, 'firmware', 'wake_requested'), false);
    box.queryBatch(115_000);
    assert.equal(box.acknowledge(signal.event_id, 'firmware', 'playback_completed'), true);
    assert.equal(box.due(115_000).length, 0);
    assert.deepEqual(box.clearable(115_000), [signal.event_id]);
    box.cleared(signal.event_id);
    box.discover('a', 'T-11', 100_000, 115_000);
    assert.equal(box.due(115_000).length, 0);
    assert.deepEqual(box.clearable(115_000), []);
  } finally { box.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('expired wake hints are cleared rather than delivered', () => {
  const box = new NotificationOutbox(':memory:');
  try {
    box.discover('a', 'T-1', 100_000, 100_000);
    box.discover('a', 'T-2', 1, 90_000_000);
    assert.equal(box.due(90_000_000).length, 0);
    assert.equal(box.clearable(90_000_000).length, 1);
  } finally { box.close(); }
});
