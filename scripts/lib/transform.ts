/**
 * The single place a raw GitLab issue becomes an `Incident`. sync.ts and the
 * reclassify pass both go through here so the stored rows can never disagree with
 * the classifier.
 */
import type { Incident } from '../../src/lib/types.ts';
import { classify, classifyStage } from '../../src/lib/services.ts';
import { parseIncidentState, parseSeverity } from '../../src/lib/severity.ts';
import { parseRootCause } from '../../src/lib/rootCause.ts';
import type { GitLabIssue } from './schemas.ts';

/** Titles are uniformly prefixed `YYYY-MM-DD: `; it is redundant with created_at. */
export function stripDatePrefix(title: string): string {
  return title.replace(/^\s*\d{4}[-/]\d{2}[-/]\d{2}\s*[:\-–]?\s*/, '').trim() || title.trim();
}

export function toIncident(issue: GitLabIssue): Incident {
  const t = stripDatePrefix(issue.title);
  // Key order is fixed so the ndjson diffs cleanly.
  return {
    iid: issue.iid,
    t,
    c: issue.created_at,
    x: issue.closed_at,
    u: issue.updated_at,
    st: issue.state,
    sev: parseSeverity(issue.labels),
    ist: parseIncidentState(issue.labels),
    stg: classifyStage(t, issue.description),
    svc: classify(t, issue.description, issue.labels),
    rc: parseRootCause(issue.labels),
  };
}

/** Rebuild only the derived fields, for when the classifier changes. */
export function reclassify(
  incident: Incident,
  description?: string | null,
  labels: string[] = [],
): Incident {
  return {
    ...incident,
    stg: classifyStage(incident.t, description),
    svc: classify(incident.t, description, labels),
  };
}

export function compareByIid(a: Incident, b: Incident): number {
  return a.iid - b.iid;
}
