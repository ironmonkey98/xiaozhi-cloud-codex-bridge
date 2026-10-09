import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

/** child 是否等于 parent 或位于 parent 之内（两者均需已 realpath）。 */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 校验并规范化白名单工作区：必须是绝对路径、真实存在的目录、Git 仓库，
 * 且不能是根目录、家目录或家目录的祖先（避免把整个 Home 授权出去）。
 * 返回 realpath，符号链接在此被解析，后续一律使用解析后的路径。
 */
export function resolveWorkspace(input: string): string {
  if (!isAbsolute(input)) throw new Error(`workspace 必须是绝对路径：${input}`);
  if (!existsSync(input)) throw new Error(`workspace 不存在：${input}`);
  const real = realpathSync(input);
  if (!statSync(real).isDirectory()) throw new Error(`workspace 不是目录：${input}`);

  const home = realpathSync(homedir());
  if (real === sep || isWithin(real, home)) {
    throw new Error(`workspace 不能是根目录、家目录或其上级目录：${input}`);
  }
  if (!existsSync(join(real, '.git'))) {
    throw new Error(`workspace 必须是 Git 仓库根目录（先执行 git init）：${input}`);
  }
  return real;
}
