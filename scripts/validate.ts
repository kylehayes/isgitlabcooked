/**
 * The gate between data/ and the build. Every assertion here exists because the
 * corresponding failure would ship silently: a truncated page, a renamed upstream
 * label, a classifier regression. Exits non-zero on the first hard failure class.
 */
import { join } from 'node:path';
import type { Durations, Incident, StatusComponent } from '../src/lib/types.ts';
import { DurationQuality } from '../src/lib/types.ts';
import { assertStatusIoMapping, isUnclassified, SERVICES } from '../src/lib/services.ts';
import { decode, encodeRows } from '../src/lib/columnar.ts';
import { encode } from '../src/lib/columnar-encode.ts';
import { downtimeByMonth } from '../src/lib/aggregate.ts';
import { DATA_DIR, readJson, readNdjson } from './lib/io.ts';
import { NON_INCIDENT_PATTERNS, nonIncidentReason } from './lib/nonIncidents.ts';

const INCIDENTS_PATH = join(DATA_DIR, 'incidents.ndjson');
const DURATIONS_PATH = join(DATA_DIR, 'durations.json');
const COMPONENTS_PATH = join(DATA_DIR, 'status-components.json');
const EXCLUDED_PATH = join(DATA_DIR, 'excluded.ndjson');

/**
 * Counts observed on 2026-08-26, BEFORE the non-incident filter. They are asserted
 * against kept + excluded, so tightening the junk filter cannot quietly erode the
 * baseline: a row has to be in one file or the other.
 */
const CLOSED_YEARS: Record<string, number> = {
  '2018': 128,
  '2019': 254,
  '2020': 706,
  '2021': 1601,
  '2022': 1038,
  '2023': 1017,
  '2024': 758,
  '2025': 914,
};
/** The open year keeps growing; only the floor is meaningful. */
const MIN_TOTAL = 7325;
const OPEN_YEAR = '2026';
const MIN_OPEN_YEAR = 900;
const EARLIEST_DATE = '2018-04-28';
/**
 * Severity baselines drift by a handful as old issues get relabelled, so these are
 * a floor-with-slack rather than an equality: the point is to catch a truncated
 * sync or a broken label parser, not to freeze GitLab's triage decisions.
 */
const SEVERITY_BASELINE: Record<string, number> = { '1': 141, '2': 823, '3': 3343, '4': 2861, '0': 157 };
const SEVERITY_TOLERANCE = 0.02;
const MAX_OTHER_RATE = 0.12;
const MAX_QUALITY0_MINUTES = 72 * 60;
const MIN_QUALITY0_MINUTES = 1;

const failures: string[] = [];
const notes: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(`${label}${detail ? `: ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function main(): void {
  const incidents = readNdjson<Incident>(INCIDENTS_PATH);
  const excluded = readNdjson<Incident>(EXCLUDED_PATH);
  const durations = readJson<Durations>(DURATIONS_PATH, {});
  const components = readJson<StatusComponent[]>(COMPONENTS_PATH, []);
  const fetched = incidents.length + excluded.length;

  section('dataset integrity');
  check('incidents.ndjson is non-empty', incidents.length > 0, `${incidents.length} rows`);
  check(`total (kept + excluded) >= ${MIN_TOTAL}`, fetched >= MIN_TOTAL, `${incidents.length} + ${excluded.length} = ${fetched}`);

  const iids = new Set<number>();
  const dupes: number[] = [];
  let sorted = true;
  for (let k = 0; k < incidents.length; k++) {
    const i = incidents[k]!;
    if (iids.has(i.iid)) dupes.push(i.iid);
    iids.add(i.iid);
    if (k > 0 && incidents[k - 1]!.iid >= i.iid) sorted = false;
  }
  check('no duplicate iids', dupes.length === 0, dupes.slice(0, 5).join(', '));
  check('sorted by iid ascending', sorted);
  check(
    'every row has the required fields',
    incidents.every((i) => typeof i.t === 'string' && typeof i.c === 'string' && typeof i.svc === 'number'),
  );

  const earliest = incidents.reduce((min, i) => (i.c < min ? i.c : min), incidents[0]?.c ?? '');
  check(`earliest created_at is ${EARLIEST_DATE}`, earliest.slice(0, 10) === EARLIEST_DATE, earliest);

  section('non-incident filter');
  check(
    'every excluded row matches a rule',
    excluded.every((i) => nonIncidentReason(i.t) !== null),
    excluded.filter((i) => nonIncidentReason(i.t) === null).slice(0, 3).map((i) => i.t).join(' | '),
  );
  const leaked = incidents.filter((i) => nonIncidentReason(i.t) !== null);
  check('no junk left in incidents.ndjson', leaked.length === 0, leaked.slice(0, 3).map((i) => i.t).join(' | '));
  const excludedRate = excluded.length / Math.max(1, fetched);
  // If this ever creeps up, a rule has stopped being anchored and is eating real
  // incidents ("QA test failure on staging" and friends).
  check('excluded fewer than 2% of rows', excludedRate < 0.02, `${(excludedRate * 100).toFixed(2)}% (${excluded.length})`);
  const byRule: Record<string, number> = {};
  for (const i of excluded) {
    const r = nonIncidentReason(i.t)!;
    byRule[r] = (byRule[r] ?? 0) + 1;
  }
  console.log(`  info excluded ${excluded.length}: ${Object.entries(byRule).map(([r, n]) => `${r}=${n}`).join(' ')}`);
  for (const { id } of NON_INCIDENT_PATTERNS) {
    if (!byRule[id]) console.log(`  info rule ${id} matched nothing (dead rule, or upstream cleaned up)`);
  }

  section('counts by year (closed years are frozen, before exclusions)');
  const byYear: Record<string, number> = {};
  const excludedByYear: Record<string, number> = {};
  for (const i of incidents) {
    const y = i.c.slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + 1;
  }
  for (const i of excluded) {
    const y = i.c.slice(0, 4);
    excludedByYear[y] = (excludedByYear[y] ?? 0) + 1;
  }
  for (const [year, expected] of Object.entries(CLOSED_YEARS)) {
    const kept = byYear[year] ?? 0;
    const skipped = excludedByYear[year] ?? 0;
    check(
      `${year} == ${expected}`,
      kept + skipped === expected,
      `got ${kept} kept + ${skipped} excluded = ${kept + skipped}`,
    );
  }
  const openKept = byYear[OPEN_YEAR] ?? 0;
  check(`${OPEN_YEAR} (open year) >= ${MIN_OPEN_YEAR}`, openKept >= MIN_OPEN_YEAR, `got ${openKept}`);
  notes.push(
    `by year: ${Object.keys(byYear).sort().map((y) => `${y}:${byYear[y]}${excludedByYear[y] ? `(+${excludedByYear[y]} excl)` : ''}`).join(' ')}`,
  );

  section('counts by severity');
  const bySeverity: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 };
  for (const i of [...incidents, ...excluded]) bySeverity[String(i.sev)] = (bySeverity[String(i.sev)] ?? 0) + 1;
  for (const [sev, baseline] of Object.entries(SEVERITY_BASELINE)) {
    const got = bySeverity[sev] ?? 0;
    const slack = Math.max(5, Math.ceil(baseline * SEVERITY_TOLERANCE));
    check(
      `severity ${sev} ~= ${baseline} (+/-${slack})`,
      Math.abs(got - baseline) <= slack,
      `got ${got}`,
    );
  }
  const sevSum = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  check('severity buckets sum to the total', sevSum === fetched, `${sevSum} vs ${fetched}`);

  section('status.io component mapping');
  check('data/status-components.json present', components.length > 0, `${components.length} components`);
  let mappingOk = true;
  try {
    assertStatusIoMapping(components.map((c) => c.name));
  } catch (err) {
    mappingOk = false;
    check('every component maps to exactly one bucket', false, (err as Error).message);
  }
  if (mappingOk) check('every component maps to exactly one bucket', true);

  section('classifier coverage');
  const unmatched = incidents.filter((i) => isUnclassified(i.svc));
  const rate = unmatched.length / Math.max(1, incidents.length);
  check(
    `other-only rate < ${(MAX_OTHER_RATE * 100).toFixed(0)}%`,
    rate < MAX_OTHER_RATE,
    `${(rate * 100).toFixed(2)}% (${unmatched.length}/${incidents.length})`,
  );
  console.log(`  info other-only rate ${(rate * 100).toFixed(2)}% (${unmatched.length}/${incidents.length})`);
  printBigrams(unmatched.map((i) => i.t));
  const perService = SERVICES.map((s) => ({
    key: s.key,
    n: incidents.filter((i) => (i.svc & (1 << s.id)) !== 0).length,
  }));
  console.log(`  info per bucket: ${perService.map((p) => `${p.key}=${p.n}`).join(' ')}`);
  for (const p of perService) {
    if (p.key === 'other') continue;
    check(`bucket ${p.key} matched at least one incident`, p.n > 0, 'dead pattern set');
  }

  section('durations');
  const q0 = Object.entries(durations).filter(([, d]) => d.q === DurationQuality.LabelEvent);
  const badQ0 = q0.filter(([, d]) => d.m < MIN_QUALITY0_MINUTES || d.m > MAX_QUALITY0_MINUTES);
  check(
    'no quality-0 duration outside [1min, 72h]',
    badQ0.length === 0,
    badQ0.slice(0, 5).map(([iid, d]) => `${iid}=${d.m}m`).join(', '),
  );
  console.log(`  info ${q0.length} quality-0, ${Object.values(durations).filter((d) => d.q === 1).length} quality-1, ${Object.values(durations).filter((d) => d.q === 2).length} unknown`);
  if (q0.length === 0) {
    notes.push('no label-event durations present — run --mode=backfill-durations with GITLAB_TOKEN');
  }
  const orphans = Object.keys(durations).filter((iid) => !iids.has(Number(iid)));
  check('no durations for unknown iids', orphans.length === 0, orphans.slice(0, 5).join(', '));

  const encodedRows = encode(incidents, durations);
  const downtime = downtimeByMonth(decode(encodedRows).rows, encodedRows.epoch);
  const q1Minutes = Object.values(durations)
    .filter((d) => d.q !== DurationQuality.LabelEvent)
    .reduce((a, d) => a + Math.max(0, d.m), 0);
  const downtimeMinutes = Object.values(downtime).reduce((a, b) => a + b, 0);
  check(
    'downtimeByMonth excludes the closed_at proxy entirely',
    downtimeMinutes === q0.reduce((a, [, d]) => a + d.m, 0),
    `${downtimeMinutes} reported vs ${q0.reduce((a, [, d]) => a + d.m, 0)} quality-0 (q1/q2 pool is ${q1Minutes})`,
  );

  section('columnar round-trip');
  const encoded = encode(incidents, durations);
  const decoded = decode(encoded);
  const reencoded = encodeRows(decoded);
  check('n matches the row count', encoded.n === incidents.length, `${encoded.n} vs ${incidents.length}`);
  check(
    'encode -> decode -> encode is lossless',
    JSON.stringify(encoded) === JSON.stringify(reencoded),
    firstColumnDifference(encoded, reencoded),
  );
  const decodedIids = new Set(decoded.rows.map((r) => r.iid));
  check('delta-encoded iids survive the round trip', decodedIids.size === iids.size && [...iids].every((i) => decodedIids.has(i)));

  console.log('');
  for (const n of notes) console.log(`note: ${n}`);
  if (failures.length) {
    console.error(`\nvalidate: ${failures.length} FAILED assertion(s)\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nvalidate: all assertions passed');
}

function firstColumnDifference(a: unknown, b: unknown): string {
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  if (as === bs) return '';
  let k = 0;
  while (k < as.length && as[k] === bs[k]) k++;
  return `diverges at char ${k}: ${as.slice(Math.max(0, k - 40), k + 40)} != ${bs.slice(Math.max(0, k - 40), k + 40)}`;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'is', 'are', 'with', 'at', 'by', 'from',
  'not', 'due', 'has', 'have', 'was', 'were', 'be', 'this', 'that', 'it', 'as', 'or', 'we', 'all',
]);

/** The tuning signal: what are we still failing to classify, in bulk? */
function printBigrams(titles: string[], limit = 25): void {
  const counts = new Map<string, number>();
  for (const t of titles) {
    const words = t
      .toLowerCase()
      .replace(/[^a-z0-9.\- ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    for (let k = 0; k + 1 < words.length; k++) {
      const key = `${words[k]} ${words[k + 1]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
  console.log(`  info top ${top.length} unmatched bigrams (classifier tuning targets):`);
  for (const [bigram, n] of top) console.log(`         ${String(n).padStart(4)}  ${bigram}`);
}

main();
