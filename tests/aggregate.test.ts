import { describe, expect, it } from 'vitest';
import type { DecodedDataset, DecodedRow } from '../src/lib/columnar';
import { DEFAULT_EPOCH } from '../src/lib/columnar';
import {
  avgPerMonthLast3,
  computeAggregates,
  countsByDay,
  countsByMonth,
  countsByRootCause,
  countsBySeverity,
  countsByService,
  currentStreak,
  daysSince,
  downtimeByMonth,
  filterRows,
  longestStreak,
  matches,
  worstMonth,
} from '../src/lib/aggregate';
import { addMonths, dayIndex, isoFromDayIndex, monthKey } from '../src/lib/dates';
import { SERVICE_BY_KEY } from '../src/lib/services';
import type { FilterState } from '../src/lib/types';

const EPOCH = DEFAULT_EPOCH;
const day = (iso: string) => dayIndex(iso, EPOCH);

function row(over: Partial<DecodedRow> & { d: number }): DecodedRow {
  return {
    iid: 1000 + over.d,
    h: 12,
    sev: 2,
    stg: 'gprd',
    svc: 1 << SERVICE_BY_KEY.web!.id,
    m: -1,
    q: 2,
    rc: null,
    open: 0,
    ...over,
  };
}

function dataset(rows: DecodedRow[]): DecodedDataset {
  return { epoch: EPOCH, services: [], rootCauses: [], rows };
}

describe('dates', () => {
  it('is UTC-only at the day boundary', () => {
    expect(day('2018-01-01T00:00:00.000Z')).toBe(0);
    expect(day('2018-01-01T23:59:59.999Z')).toBe(0);
    expect(day('2018-01-02T00:00:00.000Z')).toBe(1);
  });

  it('round-trips a day index', () => {
    for (const iso of ['2018-04-28', '2020-02-29', '2024-12-31', '2026-08-27']) {
      expect(isoFromDayIndex(day(iso), EPOCH)).toBe(iso);
    }
  });

  it('does month arithmetic without a Date', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-08', -14)).toBe('2025-06');
    expect(monthKey('2026-08-27T10:00:00Z')).toBe('2026-08');
  });
});

describe('longestStreak', () => {
  const today = day('2026-01-31');

  it('counts the clean days BETWEEN incidents, not the gap endpoints', () => {
    // Incidents on day 10 and day 14 leave three clean days: 11, 12, 13.
    const rows = [row({ d: 10 }), row({ d: 14 })];
    const streak = longestStreak(rows, EPOCH, 14);
    expect(streak.days).toBe(3);
    expect(streak.start).toBe(isoFromDayIndex(11, EPOCH));
    expect(streak.end).toBe(isoFromDayIndex(13, EPOCH));
  });

  it('keeps days === end - start + 1', () => {
    const rows = [row({ d: 5 }), row({ d: 40 }), row({ d: 41 })];
    const s = longestStreak(rows, EPOCH, 41);
    expect(day(s.end) - day(s.start) + 1).toBe(s.days);
  });

  it('returns 0 for back-to-back days', () => {
    expect(longestStreak([row({ d: 7 }), row({ d: 8 })], EPOCH, 8).days).toBe(0);
  });

  it('returns 0 for two incidents on the same day', () => {
    expect(longestStreak([row({ d: 7, iid: 1 }), row({ d: 7, iid: 2 })], EPOCH, 7).days).toBe(0);
  });

  it('counts the still-running streak up to today, inclusive', () => {
    // Last incident day 10, today day 13 -> 11, 12, 13 are clean: 3 days.
    expect(longestStreak([row({ d: 10 })], EPOCH, 13).days).toBe(3);
  });

  it('prefers a historical streak over a shorter running one', () => {
    const rows = [row({ d: 0 }), row({ d: 100 }), row({ d: 101 })];
    const s = longestStreak(rows, EPOCH, 105);
    expect(s.days).toBe(99);
    expect(s.start).toBe(isoFromDayIndex(1, EPOCH));
    expect(s.end).toBe(isoFromDayIndex(99, EPOCH));
  });

  it('handles an empty set', () => {
    expect(longestStreak([], EPOCH, today)).toMatchObject({ days: 0 });
  });

  it('is unaffected by input order', () => {
    const rows = [row({ d: 40 }), row({ d: 5 }), row({ d: 41 })];
    expect(longestStreak(rows, EPOCH, 41)).toEqual(longestStreak([...rows].reverse(), EPOCH, 41));
  });
});

describe('currentStreak', () => {
  it('is 0 on a day that had an incident', () => {
    const s = currentStreak([row({ d: 20 })], EPOCH, 20);
    expect(s.days).toBe(0);
    expect(s.start).toBe(s.end);
  });

  it('counts today as part of the streak', () => {
    // Incident on day 20, today day 21 -> exactly one clean day.
    const s = currentStreak([row({ d: 20 })], EPOCH, 21);
    expect(s.days).toBe(1);
    expect(s.start).toBe(isoFromDayIndex(21, EPOCH));
    expect(s.end).toBe(isoFromDayIndex(21, EPOCH));
  });

  it('agrees with daysSince', () => {
    const rows = [row({ d: 20 }), row({ d: 33 })];
    expect(currentStreak(rows, EPOCH, 50).days).toBe(daysSince(rows, 50));
  });

  it('never goes negative when the clock is behind the data', () => {
    expect(currentStreak([row({ d: 50 })], EPOCH, 40).days).toBe(0);
  });
});

describe('filtering', () => {
  const rows = [
    row({ d: 1, sev: 1, stg: 'gprd', svc: 1 << 0 }),
    row({ d: 2, sev: 3, stg: 'gprd', svc: 1 << 2 }),
    row({ d: 3, sev: 2, stg: 'cny', svc: 1 << 0 }),
    row({ d: 4, sev: 2, stg: 'gprd', svc: (1 << 0) | (1 << 2) }),
  ];

  it('applies the default filter (sev 1+2, gprd)', () => {
    expect(filterRows(dataset(rows)).map((r) => r.d)).toEqual([1, 4]);
  });

  it('treats serviceMask 0 as "all services"', () => {
    const f: FilterState = { severities: [], serviceMask: 0, stages: [] };
    expect(filterRows(dataset(rows), f)).toHaveLength(4);
  });

  it('matches a service bitmask on ANY overlapping bit', () => {
    const f: FilterState = { severities: [], serviceMask: 1 << 2, stages: [] };
    expect(filterRows(dataset(rows), f).map((r) => r.d)).toEqual([2, 4]);
  });

  it('matches() and filterRows() agree', () => {
    const f: FilterState = { severities: [2], serviceMask: 1 << 0, stages: ['cny'] };
    expect(filterRows(dataset(rows), f)).toEqual(rows.filter((r) => matches(r, f)));
  });
});

describe('bucketing', () => {
  it('counts per day', () => {
    const m = countsByDay([row({ d: 3, iid: 1 }), row({ d: 3, iid: 2 }), row({ d: 9, iid: 3 })]);
    expect(m.get(3)).toBe(2);
    expect(m.get(9)).toBe(1);
    expect(m.has(4)).toBe(false);
  });

  it('fills empty months between the first and last incident', () => {
    const byMonth = countsByMonth([row({ d: day('2020-01-15') }), row({ d: day('2020-04-02') })], EPOCH);
    expect(Object.keys(byMonth)).toEqual(['2020-01', '2020-02', '2020-03', '2020-04']);
    expect(byMonth['2020-02']).toBe(0);
  });

  it('extends byMonth to today when asked', () => {
    const byMonth = countsByMonth([row({ d: day('2020-01-15') })], EPOCH, day('2020-03-05'));
    expect(Object.keys(byMonth)).toEqual(['2020-01', '2020-02', '2020-03']);
  });

  it('picks the worst month, earliest on a tie', () => {
    expect(worstMonth({ '2020-01': 3, '2020-02': 9, '2020-03': 9 })).toEqual({ month: '2020-02', count: 9 });
    expect(worstMonth({})).toEqual({ month: '', count: 0 });
  });

  it('counts a multi-service incident once per bucket it touches', () => {
    const svc = (1 << SERVICE_BY_KEY.git!.id) | (1 << SERVICE_BY_KEY.db!.id);
    const counts = countsByService([row({ d: 1, svc })]);
    const get = (k: string) => counts.find((c) => c.key === k)!.count;
    expect(get('git')).toBe(1);
    expect(get('db')).toBe(1);
    expect(get('web')).toBe(0);
  });

  it('labels a missing root cause as Unrecorded', () => {
    const counts = countsByRootCause([row({ d: 1, rc: null }), row({ d: 2, rc: 'Saturation' })]);
    expect(counts).toEqual([
      { key: 'Saturation', count: 1 },
      { key: 'Unrecorded', count: 1 },
    ]);
  });

  it('always reports all five severity buckets', () => {
    expect(countsBySeverity([row({ d: 1, sev: 1 })])).toEqual({ '0': 0, '1': 1, '2': 0, '3': 0, '4': 0 });
  });
});

describe('downtimeByMonth', () => {
  it('sums quality-0 minutes only', () => {
    const rows = [
      row({ d: day('2026-03-04'), m: 30, q: 0 }),
      row({ d: day('2026-03-20'), m: 15, q: 0 }),
      // The closed_at proxy overstates outages by orders of magnitude.
      row({ d: day('2026-03-21'), m: 4000, q: 1 }),
      row({ d: day('2026-03-22'), m: -1, q: 2 }),
    ];
    expect(downtimeByMonth(rows, EPOCH)).toEqual({ '2026-03': 45 });
  });

  it('is empty when nothing has an authoritative duration', () => {
    expect(downtimeByMonth([row({ d: 1, m: 500, q: 1 })], EPOCH)).toEqual({});
  });
});

describe('avgPerMonthLast3', () => {
  it('weights the current partial month by how much of it has elapsed', () => {
    // 6 incidents in June, 6 in July, 3 so far in the first half of August.
    const rows = [
      ...Array.from({ length: 6 }, (_, k) => row({ d: day(`2026-06-0${k + 1}`), iid: k })),
      ...Array.from({ length: 6 }, (_, k) => row({ d: day(`2026-07-0${k + 1}`), iid: 100 + k })),
      ...Array.from({ length: 3 }, (_, k) => row({ d: day(`2026-08-0${k + 1}`), iid: 200 + k })),
    ];
    // today = 2026-08-16, i.e. 2 + 16/31 = 2.516 months elapsed; 15 / 2.516 = 5.96
    expect(avgPerMonthLast3(rows, EPOCH, day('2026-08-16'))).toBeCloseTo(6.0, 1);
  });

  it('ignores anything older than three months', () => {
    const rows = [row({ d: day('2025-01-05') })];
    expect(avgPerMonthLast3(rows, EPOCH, day('2026-08-16'))).toBe(0);
  });

  it('is 0 with no rows', () => {
    expect(avgPerMonthLast3([], EPOCH, day('2026-08-16'))).toBe(0);
  });
});

describe('computeAggregates', () => {
  const rows = [
    row({ d: day('2019-01-01'), sev: 1, iid: 1 }),
    row({ d: day('2019-03-15'), sev: 2, iid: 2, rc: 'Saturation', m: 20, q: 0 }),
    row({ d: day('2019-03-15'), sev: 3, iid: 3 }),
    row({ d: day('2019-03-16'), sev: 2, iid: 4, stg: 'cny' }),
    row({ d: day('2026-08-20'), sev: 2, iid: 5, open: 1 }),
  ];
  const agg = computeAggregates(dataset(rows), { now: new Date('2026-08-27T09:00:00Z') });

  it('reports the default-filter total and the unfiltered total separately', () => {
    expect(agg.totalDefault).toBe(3); // sev 1|2 AND gprd
    expect(agg.totalAll).toBe(5);
  });

  it('takes firstIncident from the whole dataset, not the filtered slice', () => {
    expect(agg.firstIncident).toBe('2019-01-01');
  });

  it('reports severity across the whole dataset', () => {
    expect(agg.bySeverityAll).toEqual({ '0': 0, '1': 1, '2': 3, '3': 1, '4': 0 });
  });

  it('measures daysSince against the filtered rows', () => {
    expect(agg.lastIncidentDate).toBe('2026-08-20');
    expect(agg.daysSince).toBe(7);
    expect(agg.currentStreak.days).toBe(7);
  });

  it('keeps byMonth contiguous through today', () => {
    const months = Object.keys(agg.byMonth);
    expect(months[0]).toBe('2019-01');
    expect(months[months.length - 1]).toBe('2026-08');
    expect(months.length).toBe(92);
  });

  it('only counts quality-0 downtime', () => {
    expect(agg.downtimeByMonth).toEqual({ '2019-03': 20 });
  });

  it('is deterministic for a fixed clock', () => {
    const again = computeAggregates(dataset(rows), { now: new Date('2026-08-27T09:00:00Z') });
    expect(again).toEqual(agg);
  });

  it('survives an empty dataset', () => {
    const empty = computeAggregates(dataset([]), { now: new Date('2026-08-27T09:00:00Z') });
    expect(empty.totalAll).toBe(0);
    expect(empty.totalDefault).toBe(0);
    expect(empty.longestStreak.days).toBe(0);
    expect(empty.byMonth).toEqual({});
  });
});
