/**
 * GA4 event helper. Owned by Track B; imported by the island (Track C).
 *
 * `gtag` only exists when PUBLIC_GA4_ID was set at build time (see
 * src/components/Analytics.astro). The optional call keeps this a silent no-op
 * on local dev, in previews with no ID, and under ad blockers — never a
 * ReferenceError, never a try/catch at the call site.
 *
 * EVENT VOCABULARY — add to this list rather than inventing names inline, so
 * the GA4 custom-dimension config stays finite.
 *
 *   verdict_shown       Hero verdict resolved. { key, heat, disagreement, source }
 *                       source: 'snapshot' (build-time fallback) | 'live'
 *   filter_service      Service facet changed.  { service, active }
 *   filter_severity     Severity/stage facet changed. { severities, stages }
 *   day_open            A calendar day was opened. { date, count }
 *   incident_click      An incident link was followed. { iid, sev }
 *   year_change         Calendar year switched.  { year }
 *   status_fetch_failed Live status.gitlab.com fetch failed; snapshot in use.
 *                       { reason }
 *   share_click         A share/copy-link control was used. { target }
 *
 * Keep params flat, small and non-PII: GA4 drops nested objects.
 */
export const track = (name: string, params?: Record<string, unknown>) =>
  (globalThis as any).gtag?.('event', name, params);

/** The names above, for callers that want a compile-time check. */
export type TrackEvent =
  | 'verdict_shown'
  | 'filter_service'
  | 'filter_severity'
  | 'day_open'
  | 'incident_click'
  | 'year_change'
  | 'status_fetch_failed'
  | 'share_click';
