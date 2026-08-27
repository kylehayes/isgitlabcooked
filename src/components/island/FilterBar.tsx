/**
 * Facets. Severity, stage, service.
 *
 * The default (S1+S2, production only) is the honest headline: those are the
 * incidents a user would actually have noticed. S3/S4 and staging/canary are
 * one click away but off by default, because including them triples the count
 * and makes GitLab look worse than users experienced.
 *
 * Every service shows its count under the current severity/stage filter — with
 * the service facet itself excluded from that count, so selecting one service
 * does not zero the other seventeen. Buckets that really are empty render as a
 * visible 0 rather than silently disappearing.
 */

import type { JSX } from 'preact';
import type { Severity, Stage } from '../../lib/types';
import { severities, stages, serviceMask, isDefaultFilter, resetFilter, track } from './state';
import type { ServiceMeta } from '../../lib/types';

const SEV_OPTIONS: { value: Severity; label: string; hint: string }[] = [
  { value: 1, label: 'S1', hint: 'Critical' },
  { value: 2, label: 'S2', hint: 'Major' },
  { value: 3, label: 'S3', hint: 'Minor' },
  { value: 4, label: 'S4', hint: 'Low' },
  { value: 0, label: 'S?', hint: 'Unlabelled' },
];

const NON_PROD: Stage[] = ['gstg', 'cny', 'unknown'];

export default function FilterBar(props: {
  services: ServiceMeta[];
  counts: Map<number, number>;
  matched: number;
  total: number;
}): JSX.Element {
  const sev = severities.value;
  const stg = stages.value;
  const mask = serviceMask.value;
  const includeNonProd = stg.length > 1;

  const toggleSeverity = (v: Severity) => {
    const next = sev.includes(v) ? sev.filter((s) => s !== v) : [...sev, v].sort((a, b) => a - b);
    // Never allow an empty severity set: an empty chart looks like a bug.
    if (next.length === 0) return;
    severities.value = next;
    track('filter_severity', { severities: next.join(','), stages: stg.join(',') });
  };

  const toggleStage = () => {
    const next: Stage[] = includeNonProd ? ['gprd'] : ['gprd', ...NON_PROD];
    stages.value = next;
    track('filter_severity', { severities: sev.join(','), stages: next.join(',') });
  };

  const toggleService = (id: number, label: string) => {
    const bit = 1 << id;
    const next = mask & bit ? mask & ~bit : mask | bit;
    serviceMask.value = next;
    track('filter_service', { service: label, active: (next & bit) !== 0 });
  };

  return (
    <div class="flex flex-col gap-3 border-b border-border pb-4">
      <div class="flex flex-wrap items-center gap-x-5 gap-y-3">
        <fieldset class="flex flex-wrap items-center gap-1.5">
          <legend class="sr-only">Severity</legend>
          <span class="mr-1 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            Severity
          </span>
          {SEV_OPTIONS.map((o) => (
            <Chip
              key={o.value}
              pressed={sev.includes(o.value)}
              onClick={() => toggleSeverity(o.value)}
              title={`${o.label} — ${o.hint}`}
            >
              <span
                aria-hidden="true"
                class="inline-block size-2.5 rounded-[2px] ring-1 ring-[var(--color-sev-cell-ring)]"
                style={{ background: sevSwatch(o.value) }}
              />
              {o.label}
            </Chip>
          ))}
        </fieldset>

        <fieldset class="flex flex-wrap items-center gap-1.5">
          <legend class="sr-only">Stage</legend>
          <span class="mr-1 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            Stage
          </span>
          <Chip pressed={!includeNonProd} onClick={() => includeNonProd && toggleStage()}>
            Production only
          </Chip>
          <Chip pressed={includeNonProd} onClick={() => !includeNonProd && toggleStage()}>
            + staging &amp; canary
          </Chip>
        </fieldset>

        <p class="ml-auto text-sm text-ink-muted">
          <span class="font-mono font-semibold tabular-nums text-ink">
            {props.matched.toLocaleString()}
          </span>{' '}
          of {props.total.toLocaleString()} incidents
          {!isDefaultFilter.value && (
            <button
              type="button"
              class="ml-2 text-xs font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
              onClick={() => resetFilter()}
            >
              reset
            </button>
          )}
        </p>
      </div>

      <details class="group">
        <summary class="w-fit cursor-pointer list-none text-xs font-semibold tracking-wide text-ink-subtle uppercase select-none hover:text-ink">
          Service
          <span class="ml-1.5 font-normal normal-case">
            {mask === 0
              ? '— all'
              : `— ${props.services.filter((s) => mask & (1 << s.id)).length} selected`}
          </span>
          <span aria-hidden="true" class="ml-1 inline-block group-open:rotate-90">
            ›
          </span>
        </summary>
        <fieldset class="mt-2.5 flex flex-wrap gap-1.5">
          <legend class="sr-only">Service</legend>
          {props.services.map((s) => {
            const n = props.counts.get(s.id) ?? 0;
            return (
              <Chip
                key={s.id}
                pressed={(mask & (1 << s.id)) !== 0}
                disabled={n === 0}
                onClick={() => toggleService(s.id, s.key)}
              >
                {s.label}
                <span class="ml-0.5 font-mono text-[0.6875rem] tabular-nums opacity-70">{n}</span>
              </Chip>
            );
          })}
        </fieldset>
      </details>
    </div>
  );
}

function sevSwatch(v: Severity): string {
  return v === 0 ? 'var(--color-sev-unknown)' : `var(--color-sev-${v})`;
}

function Chip(props: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: JSX.Element | (JSX.Element | string | number)[] | string;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
      class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        props.pressed
          ? 'border-accent bg-accent text-accent-ink'
          : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink'
      }`}
    >
      {props.children}
    </button>
  );
}
