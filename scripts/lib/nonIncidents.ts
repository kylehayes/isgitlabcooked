/**
 * The incident tracker is a real issue tracker, so it also contains scaffolding:
 * webhook tests, CMOC practice drills, and a decade of issues titled "blah".
 * They are real rows upstream but they are not outages, and "blah" rendering in
 * a day-detail popover just looks broken.
 *
 * Every pattern here is anchored to the start of the title or matches it whole.
 * NOTHING may match a bare substring like `test`: 50 genuine incidents say
 * "QA test failure on staging", "Broken QA test on canary", "flaky test".
 * Excluded rows are written to data/excluded.ndjson so the decision is auditable
 * and reversible, never silently dropped.
 */
import type { Incident } from '../../src/lib/types.ts';

export const NON_INCIDENT_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'blah', re: /^blah\.?$/i },
  { id: 'testing', re: /^testing\.?$/i },
  { id: 'test-n', re: /^test\s*\d*\.?$/i },
  { id: 'test-colon', re: /^test\s*:/i },
  { id: 'test-incident', re: /^test\s+incident\b/i },
  { id: 'test-bracket-ignore', re: /^test\s*\[\s*ignore\s*\]\.?$/i },
  { id: 'test-please-ignore', re: /^test,?\s+please\s+ignore\b/i },
  { id: 'this-is-a-test', re: /^this\s+is\s+a\s+test\s+incident\b/i },
  { id: 'patcher', re: /^(test\s+patcher|patcher\s+test)\.?$/i },
  { id: 'testing-webhook', re: /^testing that the incident webhook\b/i },
  { id: 'working-doc', re: /^incident\s+working\s+doc\s*:/i },
  { id: 'bracket-prefix', re: /^\s*\[\s*(test|ignore)\s*\]/i },
  { id: 'practice-incident', re: /^(cmoc\s+)?practice\s+incident\b/i },
  { id: 'ignore-prefix', re: /^ignore\b/i },
  { id: 'worth-ignoring', re: /^incident\s+worth\s+ignoring\.?$/i },
];

/** Which rule excluded this title, or null when it is a genuine incident. */
export function nonIncidentReason(title: string): string | null {
  const t = title.trim();
  for (const { id, re } of NON_INCIDENT_PATTERNS) if (re.test(t)) return id;
  return null;
}

export function isNonIncident(title: string): boolean {
  return nonIncidentReason(title) !== null;
}

export interface Partitioned {
  kept: Incident[];
  excluded: Incident[];
  /** rule id -> how many rows it caught, so a rule going rogue is visible. */
  byRule: Record<string, number>;
}

export function partitionIncidents(incidents: Incident[]): Partitioned {
  const kept: Incident[] = [];
  const excluded: Incident[] = [];
  const byRule: Record<string, number> = {};
  for (const incident of incidents) {
    const reason = nonIncidentReason(incident.t);
    if (reason === null) {
      kept.push(incident);
    } else {
      excluded.push(incident);
      byRule[reason] = (byRule[reason] ?? 0) + 1;
    }
  }
  return { kept, excluded, byRule };
}

export interface ExcludedSummary {
  total: number;
  byYear: Record<string, number>;
  byRule: Record<string, number>;
  iids: number[];
}

export function summariseExcluded(excluded: Incident[]): ExcludedSummary {
  const byYear: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  for (const i of excluded) {
    const y = i.c.slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + 1;
    const r = nonIncidentReason(i.t) ?? 'unknown';
    byRule[r] = (byRule[r] ?? 0) + 1;
  }
  return {
    total: excluded.length,
    byYear,
    byRule,
    iids: excluded.map((i) => i.iid).sort((a, b) => a - b),
  };
}
