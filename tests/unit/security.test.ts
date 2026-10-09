import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveWorkspace } from '../../src/security/path.ts';
import { assertInstructionAllowed } from '../../src/security/policy.ts';
import { redact } from '../../src/security/redact.ts';
import { BridgeError } from '../../src/shared/errors.ts';
import { makeFixture } from '../helpers.ts';

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof BridgeError ? err.code : 'OTHER';
  }
}

describe('assertInstructionAllowed（T08 拒绝越权）', () => {
  const ro = (s: string) => () => assertInstructionAllowed(s, 'read-only');
  const rw = (s: string) => () => assertInstructionAllowed(s, 'workspace-write');
  for (const ok of ['概括当前仓库的模块职责', '分析删除功能的实现逻辑', '看看最近的改动有哪些风险', '测试为什么失败']) {
    it(`放行只读提问：${ok}`, () => assert.equal(codeOf(ro(ok)), null));
  }
  const privileged = [
    '帮我删除整个 src 目录',
    '直接把 README 改成英文',
    '安装 lodash 依赖',
    '执行命令 ls -la',
    'run rm -rf build',
    '帮我提交代码并推送',
    '删库跑路',
    '在项目中创建一个hello world程序',
  ];
  for (const bad of privileged) {
    it(`只读项目拦截越权：${bad}`, () => assert.equal(codeOf(ro(bad)), 'APPROVAL_REQUIRED'));
  }
  for (const bad of ['读一下 ~/.ssh/id_rsa', '看看 /etc/passwd', '分析 ../other-project', '看看我桌面上的文件']) {
    it(`拦截路径：${bad}`, () => {
      assert.equal(codeOf(ro(bad)), 'PATH_NOT_ALLOWED');
      assert.equal(codeOf(rw(bad)), 'PATH_NOT_ALLOWED');
    });
  }
  it('只读项目拒绝敏感配置；可写项目可维护自己的配置', () => {
    assert.equal(codeOf(ro('读取 .env 文件')), 'PATH_NOT_ALLOWED');
    assert.equal(codeOf(rw('创建 .env 文件保存项目配置')), null);
  });
  for (const ok of [
    '写一个 hello world 程序',
    '在桌面工作区里创建 hello.py 并运行它',
    '把 hello.py 改成打印中文',
    '删除 hello.py',
    '在桌面工作区里安装 python-pptx 并制作 PPT',
    '用 npm install pptxgenjs 安装制作 PPT 的库',
    '用 curl 下载一张图片作为 PPT 配图',
    'chmod +x build.sh 然后运行',
    '在桌面创建一个 PPT',
    '在桌面上制作一个演示文稿',
    '创建 .env 文件保存项目配置',
  ]) {
    it(`可写工作区放行：${ok}`, () => assert.equal(codeOf(rw(ok)), null));
  }
  for (const bad of ['帮我提交代码并推送', 'sudo 运行一下', 'brew install libreoffice']) {
    it(`可写工作区仍拦截：${bad}`, () => assert.equal(codeOf(rw(bad)), 'APPROVAL_REQUIRED'));
  }
  it('只读项目仍然拒绝依赖安装和联网下载', () => {
    for (const bad of ['安装 python-pptx', 'npm install pptxgenjs', '用 curl 下载图片']) {
      assert.equal(codeOf(ro(bad)), 'APPROVAL_REQUIRED');
    }
  });
});

describe('resolveWorkspace', () => {
  it('接受 Git 仓库并返回 realpath', () => {
    const { workspace } = makeFixture();
    assert.ok(resolveWorkspace(workspace).endsWith('/demo'));
  });
  it('解析符号链接到真实路径', () => {
    const { dir, workspace } = makeFixture();
    const link = join(dir, 'link');
    symlinkSync(workspace, link);
    assert.equal(resolveWorkspace(link), resolveWorkspace(workspace));
  });
  it('拒绝相对路径、非 Git 目录、家目录与根目录', () => {
    const plain = mkdtempSync(join(tmpdir(), 'xzcb-plain-'));
    mkdirSync(join(plain, 'x'));
    assert.throws(() => resolveWorkspace('relative/dir'), /绝对路径/);
    assert.throws(() => resolveWorkspace(plain), /Git/);
    assert.throws(() => resolveWorkspace(homedir()), /家目录/);
    assert.throws(() => resolveWorkspace('/'), /根目录/);
  });
});

describe('redact（T11 隐私保护）', () => {
  it('脱敏接入点 token、Bearer 与家目录', () => {
    const line = `wss://api.xiaozhi.me/mcp/?token=abc.def-123 Bearer secretvalue123 ${homedir()}/proj sk-abcdefghijkl`;
    const out = redact(line);
    assert.ok(!out.includes('abc.def-123'));
    assert.ok(!out.includes('secretvalue123'));
    assert.ok(!out.includes(homedir()));
    assert.ok(!out.includes('abcdefghijkl'));
    assert.match(out, /token=<redacted>/);
  });
});
