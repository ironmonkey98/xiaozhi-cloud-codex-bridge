import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TOKEN = 't'.repeat(16) + '0123456789abcdef0123456789abcdef';

/** 临时目录里创建一个 Git Demo 项目与白名单配置。 */
export function makeFixture(): { dir: string; workspace: string; writeWorkspace: string; projectsPath: string; dataDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xzcb-test-'));
  const workspace = join(dir, 'demo');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'README.md'), '# demo\n');
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  const writeWorkspace = join(dir, 'desk');
  mkdirSync(writeWorkspace);
  execFileSync('git', ['init', '-q'], { cwd: writeWorkspace });
  const projectsPath = join(dir, 'projects.json');
  writeFileSync(
    projectsPath,
    JSON.stringify({
      projects: [
        { project_id: 'demo', display_name: '演示项目', workspace, mode: 'read-only' },
        { project_id: 'desk', display_name: '桌面工作区', workspace: writeWorkspace, mode: 'workspace-write' },
      ],
      voice_summary_max_chars: 200,
    }),
  );
  return { dir, workspace, writeWorkspace, projectsPath, dataDir: join(dir, 'data') };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
