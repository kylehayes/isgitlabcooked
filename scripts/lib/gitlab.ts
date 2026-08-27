/**
 * Rate-limited, retrying HTTP client for the GitLab REST API and Status.io.
 *
 * The anonymous limit on gitlab.com is 500 req/min. We deliberately sit under it
 * (300/min, concurrency 4) because being throttled mid-sync is far more expensive
 * than being 40% slower.
 */
import { z } from 'zod';
import {
  GitLabIssuePageSchema,
  ResourceLabelEventPageSchema,
  StatusIoResponseSchema,
  type GitLabIssue,
  type StatusIoResponse,
} from './schemas.ts';

export const PROJECT_ID = 7444821;
export const API_BASE = `https://gitlab.com/api/v4/projects/${PROJECT_ID}`;
export const STATUS_IO_URL = 'https://api.status.io/1.0/status/5b36dc6502d06804c08349f7';

const MAX_CONCURRENCY = 4;
const MAX_REQUESTS_PER_MINUTE = 300;
const MAX_RETRIES = 5;
const USER_AGENT = 'isgitlabcooked-sync/1.0 (+https://isgitlabcooked.com)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sliding-window limiter: at most N requests in any 60s window, M in flight. */
class RateLimiter {
  private inFlight = 0;
  private readonly window: number[] = [];
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly perMinute: number,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.window.length && now - this.window[0]! > 60_000) this.window.shift();
      if (this.inFlight < this.concurrency && this.window.length < this.perMinute) {
        this.inFlight++;
        this.window.push(now);
        return;
      }
      const oldest = this.window[0];
      const waitForWindow =
        this.window.length >= this.perMinute && oldest !== undefined
          ? 60_000 - (now - oldest) + 25
          : Infinity;
      const waitForSlot = this.inFlight >= this.concurrency ? 50 : Infinity;
      await Promise.race([
        sleep(Math.min(waitForWindow, waitForSlot, 1_000)),
        new Promise<void>((resolve) => this.waiters.push(resolve)),
      ]);
    }
  }

  release(): void {
    this.inFlight--;
    const w = this.waiters.shift();
    if (w) w();
  }
}

const limiter = new RateLimiter(MAX_CONCURRENCY, MAX_REQUESTS_PER_MINUTE);

export interface FetchResult {
  body: unknown;
  headers: Headers;
  status: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (token) h['PRIVATE-TOKEN'] = token;
  return h;
}

/**
 * One request with 429/5xx handling. Honours `RateLimit-Reset` (epoch seconds) and
 * `Retry-After`, otherwise exponential backoff with jitter. Throws HttpError on a
 * non-retryable status or after MAX_RETRIES.
 */
export async function request(url: string, token?: string): Promise<FetchResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiter.acquire();
    let res: Response;
    try {
      res = await fetch(url, { headers: authHeaders(token) });
    } catch (err) {
      lastErr = err;
      await sleep(backoffMs(attempt));
      continue;
    } finally {
      limiter.release();
    }

    if (res.status === 429 || res.status >= 500) {
      const text = await res.text().catch(() => '');
      lastErr = new HttpError(res.status, url, text);
      if (attempt === MAX_RETRIES) break;
      await sleep(retryDelayMs(res, attempt));
      continue;
    }
    if (!res.ok) {
      throw new HttpError(res.status, url, await res.text().catch(() => ''));
    }
    return { body: await res.json(), headers: res.headers, status: res.status };
  }
  throw lastErr instanceof Error ? lastErr : new Error(`request failed: ${url}`);
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
}

function retryDelayMs(res: Response, attempt: number): number {
  const reset = Number(res.headers.get('ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // Epoch seconds on gitlab.com; a small integer would mean "seconds from now".
    const ms = reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000;
    if (ms > 0 && ms < 120_000) return ms + 250;
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000 + 250;
  return backoffMs(attempt);
}

/** Run `worker` over `items` with the shared limiter's concurrency. */
export async function mapPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!, i);
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
  onProgress?.(items.length, items.length);
  return out;
}

export interface IssuePage {
  issues: GitLabIssue[];
  total: number | null;
  totalPages: number | null;
}

function buildIssuesUrl(page: number, params: Record<string, string> = {}): string {
  const u = new URL(`${API_BASE}/issues`);
  u.searchParams.set('labels', 'incident');
  u.searchParams.set('per_page', '100');
  u.searchParams.set('order_by', 'created_at');
  u.searchParams.set('sort', 'asc');
  u.searchParams.set('page', String(page));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export async function fetchIssuePage(
  page: number,
  params: Record<string, string> = {},
  token?: string,
): Promise<IssuePage> {
  const url = buildIssuesUrl(page, params);
  const { body, headers } = await request(url, token);
  const parsed = GitLabIssuePageSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `GitLab issue shape changed on page ${page}:\n${JSON.stringify(parsed.error.issues.slice(0, 5), null, 2)}`,
    );
  }
  const num = (h: string) => {
    const raw = headers.get(h);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return { issues: parsed.data, total: num('x-total'), totalPages: num('x-total-pages') };
}

/**
 * Fetch every page of incident-labelled issues. Page 1 is fetched first for the
 * X-Total-Pages header, then the remainder in parallel.
 */
export async function fetchAllIssues(
  params: Record<string, string> = {},
  token?: string,
  log: (msg: string) => void = () => {},
): Promise<{ issues: GitLabIssue[]; total: number | null }> {
  const first = await fetchIssuePage(1, params, token);
  const totalPages = first.totalPages ?? (first.issues.length === 100 ? Infinity : 1);
  log(`page 1/${totalPages} (X-Total=${first.total})`);

  if (totalPages === Infinity) {
    // No pagination headers (GitLab omits them past 10k rows). Walk sequentially.
    const all = [...first.issues];
    for (let page = 2; ; page++) {
      const p = await fetchIssuePage(page, params, token);
      all.push(...p.issues);
      log(`page ${page} (+${p.issues.length})`);
      if (p.issues.length < 100) break;
    }
    return { issues: all, total: first.total };
  }

  const rest = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 2);
  const pages = await mapPool(
    rest,
    (page) => fetchIssuePage(page, params, token),
    (done, total) => log(`pages ${done + 1}/${total + 1}`),
  );
  return { issues: [...first.issues, ...pages.flatMap((p) => p.issues)], total: first.total };
}

export async function fetchLabelEvents(iid: number, token: string) {
  const { body } = await request(`${API_BASE}/issues/${iid}/resource_label_events?per_page=100`, token);
  const parsed = ResourceLabelEventPageSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `resource_label_events shape changed for iid ${iid}: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
    );
  }
  return parsed.data;
}

export async function fetchStatusIo(): Promise<StatusIoResponse> {
  const { body } = await request(STATUS_IO_URL);
  const parsed = StatusIoResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Status.io shape changed:\n${JSON.stringify(parsed.error.issues.slice(0, 5), null, 2)}`,
    );
  }
  return parsed.data;
}

export type { GitLabIssue };
export { z };
