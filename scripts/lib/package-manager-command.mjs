import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** Resolve Windows npm/pnpm shims without a shell so argument boundaries survive. */
export function packageManagerCommand(command, args) {
  if (process.platform !== 'win32' || !['pnpm', 'npm'].includes(command)) return [command, args];
  const entry = command === 'pnpm'
    ? process.env.npm_execpath
    : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!entry || !existsSync(entry)) {
    throw new Error(`Cannot locate ${command}'s JavaScript entry; run this check with pnpm using a full Node installation.`);
  }
  return /\.exe$/i.test(entry) ? [entry, args] : [process.execPath, [entry, ...args]];
}

export const spawnPackageManagerSync = (command, args, options) =>
  spawnSync(...packageManagerCommand(command, args), options);
export const execPackageManagerSync = (command, args, options) =>
  execFileSync(...packageManagerCommand(command, args), options);
