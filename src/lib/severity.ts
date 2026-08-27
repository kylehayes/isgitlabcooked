import type { IncidentState, Severity } from './types';

/** 157 of ~7,325 issues carry no severity label; those become 0 ("unlabelled"). */
export function parseSeverity(labels: string[]): Severity {
  for (const l of labels) {
    const m = /^severity::([1-4])$/i.exec(l.trim());
    if (m) return Number(m[1]) as Severity;
  }
  return 0;
}

const INCIDENT_STATES: IncidentState[] = ['Active', 'Mitigated', 'Resolved', 'Merged'];

export function parseIncidentState(labels: string[]): IncidentState {
  for (const l of labels) {
    const m = /^Incident::(\w+)$/i.exec(l.trim());
    if (!m) continue;
    const found = INCIDENT_STATES.find((s) => s!.toLowerCase() === m[1]!.toLowerCase());
    if (found) return found;
  }
  return null;
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  0: 'Unlabelled',
  1: 'S1 — Critical',
  2: 'S2 — Major',
  3: 'S3 — Minor',
  4: 'S4 — Low',
};

export const SEVERITY_SHORT: Record<Severity, string> = {
  0: 'S?',
  1: 'S1',
  2: 'S2',
  3: 'S3',
  4: 'S4',
};

/** An incident still counts as ongoing while the issue is open and not mitigated. */
export function isOpenIncident(state: 'opened' | 'closed', ist: IncidentState): boolean {
  if (state === 'closed') return false;
  // Require an explicit Incident::Active label. A ticket being `opened` says
  // almost nothing: of 100 open incident tickets sampled, 52 were
  // Incident::Merged, 42 Resolved and 3 Mitigated. And an open ticket carrying
  // NO Incident:: label at all is abandoned paperwork, not an outage — the
  // three in the dataset are 464, 477 and 481 days old. Counting either as
  // "happening right now" would overstate the headline and could trip the
  // verdict to Cooked off an incident that ended over a year ago.
  return ist === 'Active';
}
