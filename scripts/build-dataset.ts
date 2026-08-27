/**
 * npm prebuild. Turns data/ into the artifacts the site actually ships:
 *
 *   public/data/incidents.<hash>.json        columnar dataset, the island's only fetch
 *   public/data/details/<year>.<hash>.json   lazy per-year day details
 *   src/generated/aggregates.json            inlined into the HTML, default filter
 *   src/generated/manifest.json              content-hashed URLs
 *   src/generated/snapshot.json              build-time Status.io capture
 *
 * Both output directories are gitignored: they are derived, never hand-edited.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type {
  DataManifest,
  DayDetailEntry,
  Durations,
  Incident,
  LiveComponent,
  LiveStatus,
  StatusCode,
  StatusSnapshot,
  YearDetails,
} from '../src/lib/types.ts';
import { DEFAULT_FILTER } from '../src/lib/types.ts';
import { assertStatusIoMapping } from '../src/lib/services.ts';
import { isOpenIncident } from '../src/lib/severity.ts';
import { decode } from '../src/lib/columnar.ts';
import { encode } from '../src/lib/columnar-encode.ts';
import { computeAggregates } from '../src/lib/aggregate.ts';
import { toIsoDate } from '../src/lib/dates.ts';
import { fetchStatusIo } from './lib/gitlab.ts';
import {
  bytes,
  contentHash,
  DATA_DIR,
  ensureDir,
  GENERATED_DIR,
  PUBLIC_DATA_DIR,
  readJson,
  readNdjson,
  writeAtomic,
} from './lib/io.ts';

const INCIDENTS_PATH = join(DATA_DIR, 'incidents.ndjson');
const DURATIONS_PATH = join(DATA_DIR, 'durations.json');
const DETAILS_DIR = join(PUBLIC_DATA_DIR, 'details');

const log = (msg: string) => console.log(`[build] ${msg}`);

interface Emitted {
  path: string;
  raw: number;
  gzip: number;
}

const emitted: Emitted[] = [];

function emit(path: string, contents: string): void {
  writeAtomic(path, contents);
  emitted.push({
    path: path.replace(`${process.cwd()}/`, ''),
    raw: Buffer.byteLength(contents),
    gzip: gzipSync(Buffer.from(contents), { level: 9 }).byteLength,
  });
}

/** Hashed filenames accumulate across builds; drop everything before writing. */
function cleanDir(dir: string): void {
  ensureDir(dir);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isFile()) rmSync(p);
  }
}

function buildDetails(incidents: Incident[], durations: Durations): Map<string, YearDetails> {
  const byYear = new Map<string, YearDetails>();
  for (const incident of incidents) {
    const day = incident.c.slice(0, 10);
    const year = day.slice(0, 4);
    const duration = durations[String(incident.iid)];
    const entry: DayDetailEntry = {
      i: incident.iid,
      t: incident.t,
      s: incident.sev,
      m: duration && duration.m >= 0 ? duration.m : -1,
      q: duration?.q ?? 2,
      o: isOpenIncident(incident.st, incident.ist) ? 1 : 0,
    };
    const details = byYear.get(year) ?? {};
    (details[day] ??= []).push(entry);
    byYear.set(year, details);
  }
  // Worst severity first within a day, then by iid, so the UI needs no sorting.
  for (const details of byYear.values()) {
    for (const day of Object.keys(details)) {
      details[day]!.sort((a, b) => (a.s || 9) - (b.s || 9) || a.i - b.i);
    }
  }
  return byYear;
}

async function captureSnapshot(incidents: Incident[]): Promise<StatusSnapshot> {
  const capturedAt = new Date().toISOString();
  const openIncidents = incidents
    .filter((i) => i.stg === 'gprd' && isOpenIncident(i.st, i.ist))
    .map((i) => ({ iid: i.iid, t: i.t, sev: i.sev, c: i.c }))
    .sort((a, b) => (a.sev || 9) - (b.sev || 9) || b.c.localeCompare(a.c));

  let live: LiveStatus | null = null;
  try {
    const res = await fetchStatusIo();
    assertStatusIoMapping(res.result.status.map((c) => c.name));
    const updated = res.result.status_overall.updated;
    const components: LiveComponent[] = res.result.status.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      status_code: c.status_code as StatusCode,
      // Status.io does not publish a per-component timestamp; the overall one is
      // the only honest value we have.
      updated,
    }));
    live = {
      updated,
      overall: {
        status: res.result.status_overall.status,
        status_code: res.result.status_overall.status_code as StatusCode,
      },
      components,
      degradedCount: components.filter((c) => c.status_code !== 100).length,
    };
    log(`status.io: ${live.overall.status} (${live.degradedCount}/${components.length} degraded)`);
  } catch (err) {
    // A flaky third-party status page must never break the build; the island
    // refetches live data at runtime anyway and this is only the fallback.
    console.warn(`[build] WARNING: Status.io capture failed, writing live:null — ${(err as Error).message}`);
  }
  return { capturedAt, live, openIncidents };
}

async function main(): Promise<void> {
  const incidents = readNdjson<Incident>(INCIDENTS_PATH);
  const durations = readJson<Durations>(DURATIONS_PATH, {});
  if (!incidents.length) {
    throw new Error(`${INCIDENTS_PATH} is empty — run \`npx tsx scripts/sync.ts --mode=full\` first`);
  }
  log(`${incidents.length} incidents, ${Object.keys(durations).length} durations`);

  cleanDir(PUBLIC_DATA_DIR);
  cleanDir(DETAILS_DIR);
  ensureDir(GENERATED_DIR);

  const dataset = encode(incidents, durations);
  const datasetJson = JSON.stringify(dataset);
  const datasetHash = contentHash(datasetJson);
  const datasetName = `incidents.${datasetHash}.json`;
  emit(join(PUBLIC_DATA_DIR, datasetName), datasetJson);

  const details = buildDetails(incidents, durations);
  const detailUrls: Record<string, string> = {};
  for (const [year, yearDetails] of [...details.entries()].sort()) {
    const json = JSON.stringify(yearDetails);
    const name = `${year}.${contentHash(json)}.json`;
    emit(join(DETAILS_DIR, name), json);
    detailUrls[year] = `/data/details/${name}`;
  }

  const manifest: DataManifest = {
    incidents: `/data/${datasetName}`,
    details: detailUrls,
  };
  emit(join(GENERATED_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const aggregates = computeAggregates(decode(dataset), { filter: DEFAULT_FILTER });
  emit(join(GENERATED_DIR, 'aggregates.json'), `${JSON.stringify(aggregates, null, 2)}\n`);

  const snapshot = await captureSnapshot(incidents);
  emit(join(GENERATED_DIR, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

  log(`default filter (sev ${DEFAULT_FILTER.severities.join('+')}, ${DEFAULT_FILTER.stages.join('/')}): ` +
    `${aggregates.totalDefault} of ${aggregates.totalAll} incidents, ` +
    `last ${aggregates.lastIncidentDate}, ${aggregates.daysSince}d ago, ` +
    `longest clean streak ${aggregates.longestStreak.days}d`);

  console.log('\n[build] artifacts');
  let rawTotal = 0;
  let gzipTotal = 0;
  for (const e of emitted) {
    rawTotal += e.raw;
    gzipTotal += e.gzip;
    console.log(`  ${e.path.padEnd(48)} ${bytes(e.raw).padStart(10)}  gz ${bytes(e.gzip).padStart(10)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(48)} ${bytes(rawTotal).padStart(10)}  gz ${bytes(gzipTotal).padStart(10)}`);
  log(`today is ${toIsoDate(Date.now())}`);
}

main().catch((err) => {
  console.error('[build] FAILED:', err);
  process.exit(1);
});
