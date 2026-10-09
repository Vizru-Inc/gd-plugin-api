import { existsSync, readFileSync } from 'node:fs';

/** Minimal .env loader. Values already in process.env win. */
export function loadEnv(fileUrl) {
  if (!existsSync(fileUrl)) return;
  for (const line of readFileSync(fileUrl, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = m;
    const value = raw.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
