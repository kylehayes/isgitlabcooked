/** Filesystem helpers shared by the sync/build/validate scripts. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = join(ROOT, 'data');
export const CACHE_DIR = join(DATA_DIR, '.cache');
export const PUBLIC_DATA_DIR = join(ROOT, 'public', 'data');
export const GENERATED_DIR = join(ROOT, 'src', 'generated');

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Write via a temp file + rename so a crashed sync never leaves a half file. */
export function writeAtomic(path: string, contents: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown, pretty = true): void {
  writeAtomic(path, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readNdjson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const out: T[] = [];
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo++;
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      throw new Error(`${path}:${lineNo} is not valid JSON: ${(err as Error).message}`);
    }
  }
  return out;
}

export function writeNdjson(path: string, rows: unknown[]): void {
  writeAtomic(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/**
 * A JSON object with one entry per line, keys sorted numerically. Same bytes-ish
 * as a compact dump, but a one-incident change is a one-line diff instead of a
 * 170 KB one.
 */
export function writeKeyedJsonLines(path: string, record: Record<string, unknown>): void {
  const keys = Object.keys(record).sort((a, b) => Number(a) - Number(b));
  const body = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(record[k])}`).join(',\n');
  writeAtomic(path, keys.length ? `{\n${body}\n}\n` : '{}\n');
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
