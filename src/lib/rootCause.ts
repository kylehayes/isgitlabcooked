/**
 * `RootCause::*` scoped labels. GitLab only started applying these consistently
 * around 2021, so most incidents have none; treat null as "not recorded", not
 * "no cause".
 */

/** The taxonomy observed in the project. Unknown values are still accepted. */
export const KNOWN_ROOT_CAUSES = [
  'Saturation',
  'DB-Migration',
  'Config-Change',
  'Software-Change',
  'Flaky-Test',
  'Indeterminate',
] as const;

export type KnownRootCause = (typeof KNOWN_ROOT_CAUSES)[number];

export function parseRootCause(labels: string[]): string | null {
  for (const l of labels) {
    const m = /^RootCause::(.+)$/i.exec(l.trim());
    if (m) return canonicalise(m[1]!.trim());
  }
  return null;
}

function canonicalise(value: string): string {
  const hit = KNOWN_ROOT_CAUSES.find((k) => k.toLowerCase() === value.toLowerCase());
  return hit ?? value;
}

/** Human label for a root cause key. */
export function rootCauseLabel(key: string): string {
  switch (key) {
    case 'DB-Migration':
      return 'Database migration';
    case 'Config-Change':
      return 'Config change';
    case 'Software-Change':
      return 'Software change';
    case 'Flaky-Test':
      return 'Flaky test';
    default:
      return key;
  }
}
