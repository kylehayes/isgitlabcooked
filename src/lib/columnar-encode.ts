import type { ColumnarDataset, Durations, Incident, ServiceMeta } from './types';
import type { DecodedRow } from './columnar';
import { compareRows, DEFAULT_EPOCH, encodeRows } from './columnar';
import { SERVICE_META } from './serviceMeta';
import { dayIndex, utcHour } from './dates';
import { isOpenIncident } from './severity';

/**
 * The build-time half of the columnar codec. Kept out of columnar.ts so the
 * browser can import `decode` without also pulling in the service table and the
 * `Incident` shape it never sees.
 */

export function serviceMeta(): ServiceMeta[] {
  return SERVICE_META.map((s) => ({ ...s }));
}

export function toRows(
  incidents: Incident[],
  durations: Durations,
  epoch: string = DEFAULT_EPOCH,
): DecodedRow[] {
  return incidents
    .map((i) => {
      const duration = durations[String(i.iid)];
      return {
        iid: i.iid,
        d: dayIndex(i.c, epoch),
        h: utcHour(i.c),
        sev: i.sev,
        stg: i.stg,
        svc: i.svc,
        m: duration && duration.m >= 0 ? duration.m : -1,
        q: (duration?.q ?? 2) as DecodedRow['q'],
        rc: i.rc,
        open: isOpenIncident(i.st, i.ist) ? (1 as const) : (0 as const),
      };
    })
    .sort(compareRows);
}

export function encode(
  incidents: Incident[],
  durations: Durations,
  epoch: string = DEFAULT_EPOCH,
): ColumnarDataset {
  return encodeRows({
    epoch,
    services: serviceMeta(),
    rootCauses: [],
    rows: toRows(incidents, durations, epoch),
  });
}
