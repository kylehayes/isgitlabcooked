import type { ServiceMeta } from './types';

/**
 * Service ids, keys and labels — and nothing else.
 *
 * This is deliberately split out of services.ts. The browser needs to label a
 * service bitmask; it never needs the ~150 classifier regexes that live next to
 * this table, and pulling them into the island cost ~3.3 KB brotli for code that
 * only ever runs in the sync script.
 *
 * `id` is the bit position in `Incident.svc`. Ids must stay stable forever:
 * appending is fine, reordering or reusing an id silently rewrites history.
 * `other` keeps id 17 even though two buckets were appended after it.
 */
export const OTHER_ID = 17;

export const SERVICE_META: ServiceMeta[] = [
  { id: 0, key: 'git', label: 'Git' },
  { id: 1, key: 'api', label: 'API' },
  { id: 2, key: 'web', label: 'Web' },
  { id: 3, key: 'ci', label: 'CI/CD' },
  { id: 4, key: 'registry', label: 'Container Registry' },
  { id: 5, key: 'packages', label: 'Packages' },
  { id: 6, key: 'pages', label: 'GitLab Pages' },
  { id: 7, key: 'db', label: 'Database' },
  { id: 8, key: 'jobs', label: 'Background Jobs' },
  { id: 9, key: 'search', label: 'Search' },
  { id: 10, key: 'storage', label: 'Storage' },
  { id: 11, key: 'duo', label: 'GitLab Duo' },
  { id: 12, key: 'kas', label: 'Kubernetes Agent' },
  { id: 13, key: 'customers', label: 'Customers Portal' },
  { id: 14, key: 'auth', label: 'Auth' },
  { id: 15, key: 'comms', label: 'Notifications' },
  { id: 16, key: 'docs', label: 'Docs & Community' },
  { id: 18, key: 'monitoring', label: 'Observability' },
  { id: 19, key: 'platform', label: 'Cloud Platform' },
  { id: OTHER_ID, key: 'other', label: 'Other' },
];

export const SERVICE_META_BY_ID: Record<number, ServiceMeta> = Object.fromEntries(
  SERVICE_META.map((s) => [s.id, s]),
);
export const SERVICE_META_BY_KEY: Record<string, ServiceMeta> = Object.fromEntries(
  SERVICE_META.map((s) => [s.key, s]),
);

/** Decode a bitmask into service metadata, in display order. */
export function metaFromMask(mask: number, services: ServiceMeta[] = SERVICE_META): ServiceMeta[] {
  return services.filter((s) => (mask & (1 << s.id)) !== 0);
}
