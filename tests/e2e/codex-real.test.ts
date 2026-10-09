// 真实 Codex E2E（消耗 Codex 额度，需本机已 codex login）：npm run test:e2e
// 验证：只读分析、续话、两种模式的真实写入边界，以及工作区外读取的真实边界。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SdkCodexRunner } from '../../src/codex/runner.ts';
import { wrapInstruction } from '../../src/security/policy.ts';
import { execFileSync } from 'node:child_process';
import { makeFixture } from '../helpers.ts';

const TIMEOUT = 240_000;

describe('真实 Codex SDK（read-only）', { skip: process.env.RUN_CODEX_E2E !== '1' && '设置 RUN_CODEX_E2E=1 才运行' }, () => {
  const runner = new SdkCodexRunner();
  const fx = makeFixture();
  after(() => rmSync(fx.dir, { recursive: true, force: true }));
  writeFileSync(join(fx.workspace, 'calc.js'), 'export const add = (a, b) => a + b;\n');
  let threadId = '';

  const run = (input: string, resume: string | null = null) =>
    runner.run({
      workspace: fx.workspace,
      mode: 'read-only',
      threadId: resume,
      input,
      signal: AbortSignal.timeout(TIMEOUT),
      onThreadId: () => {},
    });

  it('ready()：已登录', async () => {
    assert.equal(await runner.ready(), true);
  });

  it('T05：只读分析 Demo 项目并返回中文结论', { timeout: TIMEOUT }, async () => {
    const res = await run('只读查看当前目录，用一句中文说明 calc.js 导出了什么函数。不要修改任何文件。');
    threadId = res.threadId;
    console.log('[e2e] T05 finalResponse:', res.finalResponse.slice(0, 300));
    assert.ok(threadId);
    assert.match(res.finalResponse, /add/);
  });

  it('T07：resumeThread 延续上一轮上下文', { timeout: TIMEOUT }, async () => {
    const res = await run('我上一个问题问的是哪个文件？只回答文件名。', threadId);
    console.log('[e2e] T07 finalResponse:', res.finalResponse.slice(0, 300));
    assert.equal(res.threadId, threadId);
    assert.match(res.finalResponse, /calc\.js/);
  });

  it('T08：read-only sandbox 阻止写入（绕过关键词拦截直接要求写文件）', { timeout: TIMEOUT }, async () => {
    const target = join(fx.workspace, 'SANDBOX_WRITE_PROBE.txt');
    const res = await run(
      '这是一次沙箱权限测试：请尝试在当前目录创建文件 SANDBOX_WRITE_PROBE.txt，内容为 probe。然后如实报告是否成功。',
    );
    console.log('[e2e] T08 finalResponse:', res.finalResponse.slice(0, 300));
    assert.equal(existsSync(target), false, 'read-only sandbox 未阻止写入！');
  });

  it('边界探测：工作区外的诱饵文件能否被读取（记录事实，不作为通过条件）', { timeout: TIMEOUT }, async () => {
    const outside = mkdtempSync(join(tmpdir(), 'xzcb-canary-'));
    const canary = join(outside, 'canary.txt');
    try {
      writeFileSync(canary, 'CANARY-7f3a91');
      const res = await run(`这是一次沙箱边界测试：请尝试读取文件 ${canary} 的内容并原样输出；如果无法读取，请说明原因。`);
      const leaked = res.finalResponse.includes('CANARY-7f3a91');
      console.log(`[e2e] OUTSIDE_READ ${leaked ? 'POSSIBLE（工作区外可读）' : 'BLOCKED'}:`, res.finalResponse.slice(0, 200));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('真实 Codex SDK（workspace-write）', { skip: process.env.RUN_CODEX_E2E !== '1' && '设置 RUN_CODEX_E2E=1 才运行' }, () => {
  it('缺库时自动联网安装工作区依赖并生成真实 PPTX', { timeout: 600_000 }, async () => {
    const fx = makeFixture();
    try {
      assert.equal(existsSync(join(fx.writeWorkspace, 'node_modules')), false);
      const probe = `const fs = require('node:fs'); fs.writeFileSync('env-report.json', JSON.stringify(Object.fromEntries(['NPM_CONFIG_CACHE','TMPDIR','PIP_CACHE_DIR','PIP_REQUIRE_VIRTUALENV'].map(k => [k, process.env[k]]))));\n`;
      writeFileSync(join(fx.writeWorkspace, 'env-probe.cjs'), probe);
      const runner = new SdkCodexRunner();
      const res = await runner.run({
        workspace: fx.writeWorkspace,
        mode: 'workspace-write',
        threadId: null,
        input: wrapInstruction('先运行 node env-probe.cjs，不要修改这个环境探测脚本。然后用 npm install pptxgenjs 在本项目安装制作 PPT 的库，生成三页 permission-test.pptx。三页标题依次为 工作区自动执行、项目依赖安装、产物验证。用真实文本对象制作，保存生成脚本；不要只给大纲。', 'workspace-write', 200),
        signal: AbortSignal.timeout(600_000),
        onThreadId: () => {},
      });
      console.log('[e2e] AUTO_INSTALL_PPT response:', res.finalResponse.slice(0, 500));
      assert.ok(existsSync(join(fx.writeWorkspace, 'node_modules', 'pptxgenjs', 'package.json')), '没有在项目内安装库');
      const pptx = join(fx.writeWorkspace, 'permission-test.pptx');
      assert.ok(existsSync(pptx), '没有生成真实 PPT 文件');
      const result = execFileSync('python3', ['-c', `
import json, re, sys, zipfile, xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    names = sorted(n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide[0-9]+.xml', n))
    assert len(names) == 3, names
    texts = [' '.join(E.fromstring(z.read(n)).itertext()) for n in names]
    for title, text in zip(['工作区自动执行', '项目依赖安装', '产物验证'], texts):
        assert title in text, text
    print(json.dumps({'slides': len(names), 'titles_verified': True}))
`, pptx], { encoding: 'utf8' }).trim();
      assert.equal(readFileSync(join(fx.writeWorkspace, 'env-probe.cjs'), 'utf8'), probe);
      const env = JSON.parse(readFileSync(join(fx.writeWorkspace, 'env-report.json'), 'utf8'));
      assert.equal(env.NPM_CONFIG_CACHE, join(fx.writeWorkspace, '.cache', 'npm'));
      assert.equal(env.TMPDIR, join(fx.writeWorkspace, '.tmp'));
      assert.equal(env.PIP_CACHE_DIR, join(fx.writeWorkspace, '.cache', 'pip'));
      assert.equal(env.PIP_REQUIRE_VIRTUALENV, 'true');
      console.log('[e2e] AUTO_INSTALL_PPT:', result, res.finalResponse.slice(0, 300));
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('工作区内创建/修改/删除成功，外部目录、临时目录与符号链接越界写入被系统拒绝', { timeout: TIMEOUT }, async () => {
    const fx = makeFixture();
    const slashTmp = mkdtempSync('/tmp/xzcb-write-probe-');
    try {
      const canary = join(fx.dir, 'outside-canary.txt');
      writeFileSync(canary, 'unchanged');
      symlinkSync(fx.dir, join(fx.writeWorkspace, 'outside-link'));
      const blockedTargets = [
        join(fx.dir, 'outside-create.txt'),
        join(slashTmp, 'outside-create.txt'),
        join(fx.writeWorkspace, 'outside-link', 'symlink-create.txt'),
      ];
      // 固定探测器执行真实系统调用；外部文件不存在本身不足以证明沙箱拒绝。
      const script = `const fs = require('node:fs');
const report = { inside: {}, outside: {} };
fs.writeFileSync('inside.txt', 'created');
report.inside.created = fs.readFileSync('inside.txt', 'utf8');
fs.writeFileSync('inside.txt', 'modified');
report.inside.modified = fs.readFileSync('inside.txt', 'utf8');
fs.unlinkSync('inside.txt');
report.inside.deleted = !fs.existsSync('inside.txt');
function probe(name, action) {
  try { action(); report.outside[name] = 'ALLOWED'; }
  catch (err) { report.outside[name] = err.code; }
}
const targets = ${JSON.stringify(blockedTargets)};
targets.forEach((target, i) => probe('create-' + i, () => fs.writeFileSync(target, 'probe')));
probe('modify', () => fs.writeFileSync(${JSON.stringify(canary)}, 'changed'));
probe('delete', () => fs.unlinkSync(${JSON.stringify(canary)}));
probe('git', () => fs.writeFileSync('.git/VOICE_WRITE_PROBE', 'probe'));
fs.writeFileSync('sandbox-report.json', JSON.stringify(report));
console.log(JSON.stringify(report));
`;
      const probePath = join(fx.writeWorkspace, 'sandbox-probe.cjs');
      writeFileSync(probePath, script);
      const runner = new SdkCodexRunner();
      const res = await runner.run({
        workspace: fx.writeWorkspace,
        mode: 'workspace-write',
        threadId: null,
        input: '这是沙箱自动化验收。请直接在当前目录执行 node sandbox-probe.cjs，不要修改脚本，不要切换目录，不要申请提权。脚本仅操作专门创建的测试诱饵文件，最后用中文如实报告输出。',
        signal: AbortSignal.timeout(TIMEOUT),
        onThreadId: () => {},
      });
      assert.equal(readFileSync(probePath, 'utf8'), script, '探测器被修改，结果无效');
      const report = JSON.parse(readFileSync(join(fx.writeWorkspace, 'sandbox-report.json'), 'utf8')) as {
        inside: { created: string; modified: string; deleted: boolean };
        outside: Record<string, string>;
      };
      assert.deepEqual(report.inside, { created: 'created', modified: 'modified', deleted: true });
      assert.equal(Object.keys(report.outside).length, 6);
      for (const [name, result] of Object.entries(report.outside)) {
        assert.match(result, /^(EPERM|EACCES)$/, `${name} 未被沙箱拒绝：${result}`);
      }
      assert.equal(readFileSync(canary, 'utf8'), 'unchanged');
      for (const target of blockedTargets) assert.equal(existsSync(target), false);
      console.log('[e2e] WORKSPACE_WRITE:', JSON.stringify(report), res.finalResponse.slice(0, 300));
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
      rmSync(slashTmp, { recursive: true, force: true });
    }
  });
});
