#!/usr/bin/env node
/**
 * Polls GitLab's Status.io page and appends a TRANSITION record whenever any
 * component's status changes. Runs every 10 minutes from GitHub Actions against
 * the `status-log` branch.
 *
 * Deliberately zero-dependency plain ESM: the workflow runs ~4,300 times a month,
 * so it must not need `npm ci` or `tsx`. Keep it that way.
 *
 * Over time this accumulates the real per-component uptime record that the
 * historical incident tracker cannot give us (see README, "Measured uptime").
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STATUS_URL = 'https://api.status.io/1.0/status/5b36dc6502d06804c08349f7';
const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'status-log.ndjson';
const statePath = process.argv.find((a) => a.startsWith('--state='))?.slice(8) ?? 'status-state.json';

async function fetchStatus() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(STATUS_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`status.io HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const now = new Date().toISOString();

let payload;
try {
  payload = await fetchStatus();
} catch (err) {
  // A failed poll is itself signal worth recording, but must never fail the job.
  appendLine({ ts: now, kind: 'poll_error', error: String(err.message ?? err) });
  console.error(`poll failed: ${err.message ?? err}`);
  process.exit(0);
}

const result = payload?.result;
if (!result?.status) {
  appendLine({ ts: now, kind: 'poll_error', error: 'unexpected payload shape' });
  console.error('unexpected payload shape');
  process.exit(0);
}

const current = {};
for (const c of result.status) current[c.name] = c.status_code;
const overall = result.status_overall?.status_code ?? null;

const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

const changes = [];
for (const [name, code] of Object.entries(current)) {
  const before = prev?.components?.[name];
  if (before !== code) changes.push({ name, from: before ?? null, to: code });
}
// A component disappearing from the page is also a transition worth knowing about.
for (const name of Object.keys(prev?.components ?? {})) {
  if (!(name in current)) changes.push({ name, from: prev.components[name], to: null });
}

if (changes.length || prev?.overall !== overall) {
  appendLine({ ts: now, kind: 'transition', overall, changes });
  console.log(`recorded ${changes.length} component transition(s), overall=${overall}`);
} else {
  console.log(`no change (overall=${overall})`);
}

// The heartbeat is what makes downtime math honest: without it we cannot tell
// "operational the whole time" apart from "the poller was down".
writeFileSync(
  statePath,
  JSON.stringify({ lastPoll: now, overall, components: current }, null, 2) + '\n',
);

function appendLine(obj) {
  const line = JSON.stringify(obj) + '\n';
  writeFileSync(outPath, (existsSync(outPath) ? readFileSync(outPath, 'utf8') : '') + line);
}
