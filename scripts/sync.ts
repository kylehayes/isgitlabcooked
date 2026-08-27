/**
 * Pulls incident issues out of gitlab-com/gl-infra/production into data/.
 *
 *   npx tsx scripts/sync.ts --mode=full                 # all pages, rewrites everything
 *   npx tsx scripts/sync.ts --mode=incremental          # updated_after the last sync - 6h
 *   npx tsx scripts/sync.ts --mode=backfill-durations   # needs GITLAB_TOKEN (read_api)
 *   npx tsx scripts/sync.ts --mode=reclassify           # re-derive svc/stg offline
 *
 * Every mode also refreshes data/status-components.json and asserts that the 23
 * Status.io components still map onto the service taxonomy.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DurationEntry,
  Durations,
  Incident,
  StatusComponent,
  SyncMeta,
} from '../src/lib/types.ts';
import { DurationQuality } from '../src/lib/types.ts';
import { assertStatusIoMapping } from '../src/lib/services.ts';
import { isUnclassified } from '../src/lib/services.ts';
import { minutesBetween } from '../src/lib/dates.ts';
import { fetchAllIssues, fetchLabelEvents, fetchStatusIo, mapPool } from './lib/gitlab.ts';
import type { GitLabIssue } from './lib/schemas.ts';
import {
  CACHE_DIR,
  DATA_DIR,
  ensureDir,
  writeAtomic,
  readJson,
  readNdjson,
  writeJson,
  writeKeyedJsonLines,
  writeNdjson,
} from './lib/io.ts';
import { compareByIid, reclassify, toIncident } from './lib/transform.ts';
import { partitionIncidents, summariseExcluded, type ExcludedSummary } from './lib/nonIncidents.ts';

const INCIDENTS_PATH = join(DATA_DIR, 'incidents.ndjson');
const DURATIONS_PATH = join(DATA_DIR, 'durations.json');
const META_PATH = join(DATA_DIR, 'meta.json');
const COMPONENTS_PATH = join(DATA_DIR, 'status-components.json');
const EXCLUDED_PATH = join(DATA_DIR, 'excluded.ndjson');
const RAW_CACHE_PATH = join(CACHE_DIR, 'issues.raw.ndjson');

const PROXY_MIN_MINUTES = 1;
const PROXY_MAX_MINUTES = 72 * 60;
/** Overlap window for incremental syncs; GitLab's updated_at is not transactional. */
const INCREMENTAL_OVERLAP_MS = 6 * 60 * 60 * 1000;

type Mode = 'full' | 'incremental' | 'backfill-durations' | 'reclassify';

/**
 * SyncMeta plus the junk-filter audit trail. `SyncMeta` in src/lib/types.ts is
 * frozen and has no slot for this, so the sync writes a superset; the extra key
 * is additive and existing readers are unaffected.
 */
interface SyncMetaPlus extends SyncMeta {
  excludedNonIncidents: ExcludedSummary;
}

interface RawCacheRow {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
}

function parseMode(argv: string[]): Mode {
  const arg = argv.find((a) => a.startsWith('--mode='));
  const mode = (arg?.slice('--mode='.length) ?? 'incremental') as Mode;
  if (!['full', 'incremental', 'backfill-durations', 'reclassify'].includes(mode)) {
    throw new Error(`unknown --mode=${mode}`);
  }
  return mode;
}

const log = (msg: string) => console.log(`[sync] ${msg}`);

function emptyMeta(): SyncMetaPlus {
  return {
    schema: 1,
    lastSyncedAt: null,
    lastFullSyncAt: null,
    durationsBackfilledThrough: 0,
    counts: { total: 0, bySeverity: {}, byYear: {} },
    unclassifiedSample: [],
    excludedNonIncidents: { total: 0, byYear: {}, byRule: {}, iids: [] },
  };
}

function countsFor(incidents: Incident[]): SyncMeta['counts'] {
  const bySeverity: Record<string, number> = {};
  const byYear: Record<string, number> = {};
  for (const i of incidents) {
    const s = String(i.sev);
    bySeverity[s] = (bySeverity[s] ?? 0) + 1;
    const y = i.c.slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + 1;
  }
  return { total: incidents.length, bySeverity, byYear };
}

function unclassifiedSample(incidents: Incident[], limit = 25): string[] {
  const out: string[] = [];
  for (const i of incidents) {
    if (isUnclassified(i.svc)) out.push(i.t);
    if (out.length >= limit) break;
  }
  return out;
}

/** closed_at - created_at, clamped. Overstates outage length by design; quality 1. */
function proxyDuration(incident: Incident): DurationEntry | null {
  if (!incident.x) return null;
  const raw = minutesBetween(incident.c, incident.x);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const m = Math.max(PROXY_MIN_MINUTES, Math.min(PROXY_MAX_MINUTES, Math.round(raw)));
  return { m, q: DurationQuality.ClosedAtProxy };
}

function rebuildProxyDurations(incidents: Incident[], existing: Durations): Durations {
  const next: Durations = {};
  for (const incident of incidents) {
    const key = String(incident.iid);
    const prior = existing[key];
    if (prior && prior.q === DurationQuality.LabelEvent) {
      next[key] = prior;
      continue;
    }
    const proxy = proxyDuration(incident);
    next[key] = proxy ?? { m: -1, q: DurationQuality.Unknown };
  }
  return next;
}

async function syncStatusComponents(): Promise<void> {
  const live = await fetchStatusIo();
  const components: StatusComponent[] = live.result.status.map((c) => ({ id: c.id, name: c.name }));
  assertStatusIoMapping(components.map((c) => c.name));
  writeJson(COMPONENTS_PATH, components);
  log(`status.io: ${components.length} components, all mapped`);
}

/**
 * Split off the test/practice rows, write both halves, and return the keepers.
 * data/excluded.ndjson exists so the filter is auditable: nothing is dropped
 * without a record of which rule dropped it.
 */
function splitAndWrite(all: Incident[]): { kept: Incident[]; excluded: ExcludedSummary } {
  const { kept, excluded, byRule } = partitionIncidents(all);
  kept.sort(compareByIid);
  excluded.sort(compareByIid);
  writeNdjson(INCIDENTS_PATH, kept);
  writeNdjson(EXCLUDED_PATH, excluded);
  if (excluded.length) {
    log(
      `excluded ${excluded.length} non-incidents (${Object.entries(byRule)
        .map(([r, n]) => `${r}:${n}`)
        .join(' ')})`,
    );
  }
  return { kept, excluded: summariseExcluded(excluded) };
}

function writeRawCache(issues: GitLabIssue[]): void {
  ensureDir(CACHE_DIR);
  // data/ is committed; this ~10 MB classifier-tuning cache is not.
  writeAtomic(join(CACHE_DIR, '.gitignore'), '*\n');
  const rows: RawCacheRow[] = issues
    .map((i) => ({
      iid: i.iid,
      title: i.title,
      // Enough context to re-tune the classifier offline without a 200 MB cache.
      description: i.description ? i.description.slice(0, 1200) : null,
      labels: i.labels,
    }))
    .sort((a, b) => a.iid - b.iid);
  writeNdjson(RAW_CACHE_PATH, rows);
}

async function runFull(startedAt: string): Promise<void> {
  const { issues, total } = await fetchAllIssues({}, process.env.GITLAB_TOKEN, log);
  const incidents = issues.map(toIncident);
  const seen = new Set<number>();
  for (const i of incidents) {
    if (seen.has(i.iid)) throw new Error(`duplicate iid ${i.iid} returned by the API`);
    seen.add(i.iid);
  }
  if (total !== null && incidents.length !== total) {
    throw new Error(`truncated sync: X-Total=${total} but fetched ${incidents.length} issues`);
  }
  const { kept, excluded } = splitAndWrite(incidents);
  writeRawCache(issues);
  log(`wrote ${kept.length} incidents of ${incidents.length} fetched (X-Total=${total})`);

  const durations = rebuildProxyDurations(kept, readJson<Durations>(DURATIONS_PATH, {}));
  writeKeyedJsonLines(DURATIONS_PATH, durations);

  const meta = readJson<SyncMetaPlus>(META_PATH, emptyMeta());
  writeJson(META_PATH, {
    ...meta,
    schema: 1,
    lastSyncedAt: startedAt,
    lastFullSyncAt: startedAt,
    counts: countsFor(kept),
    unclassifiedSample: unclassifiedSample(kept),
    excludedNonIncidents: excluded,
  } satisfies SyncMetaPlus);
}

async function runIncremental(startedAt: string): Promise<void> {
  const meta = readJson<SyncMetaPlus>(META_PATH, emptyMeta());
  // Both halves, so a row whose title changed can move back out of the junk pile.
  const existing = [...readNdjson<Incident>(INCIDENTS_PATH), ...readNdjson<Incident>(EXCLUDED_PATH)];
  if (!existing.length) {
    log('no existing dataset, falling back to a full sync');
    return runFull(startedAt);
  }
  const since = new Date(
    (meta.lastSyncedAt ? Date.parse(meta.lastSyncedAt) : Date.now() - 30 * 86_400_000) -
      INCREMENTAL_OVERLAP_MS,
  ).toISOString();
  log(`updated_after=${since}`);

  const { issues } = await fetchAllIssues({ updated_after: since }, process.env.GITLAB_TOKEN, log);
  const byIid = new Map(existing.map((i) => [i.iid, i]));
  let added = 0;
  let changed = 0;
  for (const issue of issues) {
    const next = toIncident(issue);
    const prev = byIid.get(next.iid);
    if (!prev) added++;
    else if (JSON.stringify(prev) !== JSON.stringify(next)) changed++;
    byIid.set(next.iid, next);
  }
  const merged = [...byIid.values()];
  const { kept, excluded } = splitAndWrite(merged);
  log(`merged ${issues.length} updated issues: ${added} new, ${changed} changed, ${kept.length} kept`);

  // Refresh the raw cache rows we just saw, keeping the rest.
  if (existsSync(RAW_CACHE_PATH) && issues.length) {
    const cache = new Map(readNdjson<RawCacheRow>(RAW_CACHE_PATH).map((r) => [r.iid, r]));
    for (const i of issues) {
      cache.set(i.iid, {
        iid: i.iid,
        title: i.title,
        description: i.description ? i.description.slice(0, 1200) : null,
        labels: i.labels,
      });
    }
    writeNdjson(RAW_CACHE_PATH, [...cache.values()].sort((a, b) => a.iid - b.iid));
  }

  const durations = rebuildProxyDurations(kept, readJson<Durations>(DURATIONS_PATH, {}));
  writeKeyedJsonLines(DURATIONS_PATH, durations);

  writeJson(META_PATH, {
    ...meta,
    schema: 1,
    lastSyncedAt: startedAt,
    counts: countsFor(kept),
    unclassifiedSample: unclassifiedSample(kept),
    excludedNonIncidents: excluded,
  } satisfies SyncMetaPlus);
}

/**
 * The only authoritative duration signal: the timestamp the Incident::Mitigated
 * label was first added. resource_label_events is 401 anonymously, so this stage
 * is a no-op without a read_api PAT.
 */
async function runBackfillDurations(startedAt: string): Promise<void> {
  const token = process.env.GITLAB_TOKEN;
  const meta = readJson<SyncMetaPlus>(META_PATH, emptyMeta());
  const incidents = readNdjson<Incident>(INCIDENTS_PATH);
  if (!incidents.length) throw new Error(`${INCIDENTS_PATH} is empty; run --mode=full first`);

  const durations = rebuildProxyDurations(incidents, readJson<Durations>(DURATIONS_PATH, {}));

  if (!token) {
    console.warn(
      '\n[sync] WARNING: GITLAB_TOKEN is not set.\n' +
        '[sync] /resource_label_events returns 401 anonymously, so real mitigation times\n' +
        '[sync] cannot be fetched. Skipping the duration backfill; every S1/S2 keeps the\n' +
        '[sync] closed_at proxy (quality 1). Set a read_api PAT and re-run to fix this.\n',
    );
    writeKeyedJsonLines(DURATIONS_PATH, durations);
    writeJson(META_PATH, { ...meta, schema: 1, lastSyncedAt: startedAt } satisfies SyncMetaPlus);
    return;
  }

  const targets = incidents.filter(
    (i) =>
      (i.sev === 1 || i.sev === 2) &&
      durations[String(i.iid)]?.q !== DurationQuality.LabelEvent,
  );
  log(`backfilling ${targets.length} S1/S2 incidents from resource_label_events`);

  let resolved = 0;
  let missing = 0;
  const failures: number[] = [];
  await mapPool(
    targets,
    async (incident) => {
      try {
        const events = await fetchLabelEvents(incident.iid, token);
        const at = earliestMitigation(events);
        if (!at) {
          missing++;
          return;
        }
        const m = Math.round(minutesBetween(incident.c, at));
        if (m < PROXY_MIN_MINUTES || m > PROXY_MAX_MINUTES) {
          // Out-of-range label events are ticket hygiene, not outage length.
          missing++;
          return;
        }
        durations[String(incident.iid)] = { m, q: DurationQuality.LabelEvent };
        resolved++;
      } catch (err) {
        failures.push(incident.iid);
        if (failures.length <= 3) log(`  iid ${incident.iid}: ${(err as Error).message}`);
      }
    },
    (done, total) => log(`  ${done}/${total}`),
  );

  log(`durations: ${resolved} from label events, ${missing} without a usable event, ${failures.length} failed`);
  if (failures.length > targets.length * 0.05) {
    throw new Error(`${failures.length}/${targets.length} label-event fetches failed; refusing to trust this run`);
  }
  writeKeyedJsonLines(DURATIONS_PATH, durations);
  writeJson(META_PATH, {
    ...meta,
    schema: 1,
    lastSyncedAt: startedAt,
    durationsBackfilledThrough: Math.max(
      meta.durationsBackfilledThrough,
      ...incidents.map((i) => i.iid),
    ),
  } satisfies SyncMetaPlus);
}

function earliestMitigation(
  events: { created_at: string; action: 'add' | 'remove'; label: { name: string } | null }[],
): string | null {
  const firstAdd = (name: string) =>
    events
      .filter((e) => e.action === 'add' && e.label?.name?.toLowerCase() === name.toLowerCase())
      .map((e) => e.created_at)
      .sort()[0] ?? null;
  return firstAdd('Incident::Mitigated') ?? firstAdd('Incident::Resolved');
}

/** Offline: re-derive svc/stg from the cached raw rows after tuning the patterns. */
function runReclassify(): void {
  const all = [...readNdjson<Incident>(INCIDENTS_PATH), ...readNdjson<Incident>(EXCLUDED_PATH)];
  if (!all.length) throw new Error(`${INCIDENTS_PATH} is empty; run --mode=full first`);
  const cache = new Map(readNdjson<RawCacheRow>(RAW_CACHE_PATH).map((r) => [r.iid, r]));
  const next = all.map((i) => {
    const raw = cache.get(i.iid);
    return reclassify(i, raw?.description ?? null, raw?.labels ?? []);
  });
  const { kept, excluded } = splitAndWrite(next);
  const other = kept.filter((i) => isUnclassified(i.svc)).length;
  log(`reclassified ${kept.length} incidents; other-only ${other} (${((other / kept.length) * 100).toFixed(2)}%)`);
  const meta = readJson<SyncMetaPlus>(META_PATH, emptyMeta());
  writeJson(META_PATH, {
    ...meta,
    counts: countsFor(kept),
    unclassifiedSample: unclassifiedSample(kept),
    excludedNonIncidents: excluded,
  } satisfies SyncMetaPlus);
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  ensureDir(DATA_DIR);
  log(`mode=${mode} startedAt=${startedAt}`);

  if (mode === 'reclassify') {
    runReclassify();
  } else if (mode === 'full') {
    await runFull(startedAt);
  } else if (mode === 'incremental') {
    await runIncremental(startedAt);
  } else {
    await runBackfillDurations(startedAt);
  }

  await syncStatusComponents();
  log('done');
}

main().catch((err) => {
  console.error('[sync] FAILED:', err);
  process.exitCode = 1;
});
