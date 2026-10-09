import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toSpokenSummary } from '../../src/speech/summary.ts';

describe('toSpokenSummary', () => {
  it('取首个非空行并去掉 Markdown', () => {
    assert.equal(toSpokenSummary('\n## **项目分为三层**\n细节', 200), '项目分为三层');
  });
  it('按字符截断到上限（含省略号）', () => {
    const out = toSpokenSummary('一'.repeat(300), 200);
    assert.equal(Array.from(out).length, 200);
    assert.ok(out.endsWith('…'));
  });
  it('空回复给出兜底播报', () => {
    assert.match(toSpokenSummary('', 200), /没有得到可播报的结论/);
  });
});
