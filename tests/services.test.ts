import { describe, expect, it } from 'vitest';
import { nonIncidentReason, partitionIncidents } from '../scripts/lib/nonIncidents';
import {
  assertStatusIoMapping,
  classify,
  classifyStage,
  isUnclassified,
  OTHER_ID,
  SERVICES,
  SERVICE_BY_KEY,
  serviceIdForComponent,
  servicesFromMask,
  STATUS_IO_COMPONENTS,
} from '../src/lib/services';

const keys = (mask: number) => servicesFromMask(mask).map((s) => s.key);
const has = (title: string, key: string, labels: string[] = []) =>
  keys(classify(title, null, labels)).includes(key);

/**
 * Real titles pulled from across every year in gitlab-com/gl-infra/production,
 * hand-labelled. These are regressions, not a spec: each one broke, or nearly
 * broke, while the patterns were being tuned.
 */
const EXPECTED: [title: string, expected: string[]][] = [
  // --- 2018 ---
  ['High load on dev.gitlab.org due to 170+ simultaneous clones', ['git']],
  ['Intermittent problems with the registry fleet', ['registry']],
  ['Redis switchover causing increased rate of sidekiq errors', ['jobs']],
  ['CI Runners not respecting tags (Hot Patch)', ['ci']],
  ['Investigate why mongo-replica-02 stopped', []],
  // --- 2019 ---
  ['Redis replication flapping and primary failover', ['jobs', 'db']],
  ['sidekiq error rates are high', ['jobs']],
  ['root filesystem full on about.gitlab.com', ['storage', 'docs']],
  ['customers.gitlab.com is returing 502 errors', ['customers', 'web']],
  ['Chef client has reached "critical levels" (1) on two nodes.', ['platform']],
  // --- 2020 ---
  ['The fluentd_log_output SLI of the logging service (`main` stage) has an error rate violating SLO', ['monitoring']],
  ['haproxy errors on https-git backends - action cable related', ['web', 'git']],
  ['Sidekiq not meeting latency SLOs', ['jobs']],
  ['Cannot push - gitaly RPC error', ['git']],
  ['Significant drop in RPS detected in Git service in canary', ['git']],
  // --- 2021 ---
  ['The goserver SLI of the gitaly service (`cny` stage) has an apdex violating SLO', ['git']],
  ['dashboards.gitlab.net/thanos.gitlab.net down/unable to show data', ['monitoring']],
  ['Prometheus has slow rule evaluations', ['monitoring']],
  [
    'The goserver SLI of the gitaly service on node `file-43-stor-gprd.c.gitlab-production.internal` has an apdex violating SLO',
    ['git'],
  ],
  // --- 2022 ---
  ['CustomersDot not responding', ['customers']],
  ['Prometheus PVC saturation in us-east1-b and us-east1-c', ['monitoring', 'storage']],
  ['email processing delays', ['comms']],
  ['An uptick of 503 errors', ['web']],
  ['Firing 1 - The loadbalancer SLI of the websockets service has an error rate violating SLO', ['web']],
  // --- 2023 ---
  ['PostgreSQL queries dominating total query time', ['db']],
  ['praefect deploy to gstg-cny failing', ['git', 'ci']],
  ['websockets rails_requests violating slo in us-east1-d', ['web']],
  ['Deploys failing due to `gcloud` failing to execute on ops', ['ci']],
  // --- 2024 ---
  ['No new events on Sentry', ['monitoring']],
  ['Long-running transactions detected on Patroni', ['db']],
  ['Incremental indexing queue is backed up', ['jobs']],
  ['Failing E2E Test cancel_pipeline_when_block_user_spec in Staging Canary', ['ci']],
  // --- 2025 ---
  ['SidekiqServiceSidekiqQueueingApdexSLOViolationSingleShard low-urgency-cpu-bound shard', ['jobs']],
  ['Multiple Redis nodes not taking snapshots', ['jobs', 'storage']],
  ['Migration failing on prod canary due to deadlock error', ['db']],
  ['Loadbalancer error rate SLO violation in web service (main stage)', ['web']],
  // --- 2026 ---
  ['Goserver apdex SLO violation for Gitaly GRPC requests in cny stage', ['git']],
  ['External DNS records are stale', ['web']],
  ['Redis deployment error causes delayed CI processing and GitLab Duo outage', ['jobs', 'ci', 'duo']],
  ['Disk space utilization on gitaly nodes predicted to reach capacity within 6 hours', ['git', 'storage']],
  ['The queuing_queries_duration SLI of the ci-runners service (`main` stage) has an apdex violating SLO', ['ci']],
  ['Apdex SLO violation for code completions on AI Gateway in europe-west3', ['duo']],
  ['GitLab Pages is returning 502 for custom domains', ['pages', 'web']],
  ['Container registry pushes failing with 500', ['registry', 'web']],
  ['SAML SSO Redirects are failing with ERR_TOO_MANY_REDIRECTS', ['auth']],
  ['kas is not accepting agent connections', ['kas']],
  ['Zoekt Webserver Memory Saturation', ['search']],
  ['npm package publishing to the package registry fails', ['packages']],
];

describe('classify', () => {
  for (const [title, expected] of EXPECTED) {
    it(`classifies ${JSON.stringify(title.slice(0, 62))}`, () => {
      const got = keys(classify(title));
      for (const key of expected) expect(got, `expected ${key} in [${got}]`).toContain(key);
      if (expected.length === 0) expect(got).toEqual(['other']);
    });
  }

  it('falls back to other when nothing matches', () => {
    const mask = classify('Practice incident');
    expect(mask).toBe(1 << OTHER_ID);
    expect(isUnclassified(mask)).toBe(true);
  });

  it('is multi-label: one incident can set several bits', () => {
    const mask = classify('Gitaly saturation causing 500s across the web fleet');
    expect(keys(mask)).toEqual(expect.arrayContaining(['git', 'web']));
    expect(keys(mask).length).toBeGreaterThan(1);
  });

  it('uses the Service:: label even when the title says nothing', () => {
    expect(has('Elevated latency for some users', 'git', ['incident', 'Service::Gitaly'])).toBe(true);
  });

  it('ignores Service::Woodhouse, which marks the filing bot not the broken service', () => {
    const mask = classify('pgbouncer client connections are saturated', null, [
      'incident',
      'Service::Woodhouse',
    ]);
    expect(keys(mask)).toEqual(['db']);
  });

  it('ignores group:: and team:: labels', () => {
    expect(classify('Practice incident', null, ['group::gitaly'])).toBe(1 << OTHER_ID);
  });

  it('ignores the description entirely', () => {
    const withDesc = classify('Practice incident', 'This affects gitaly and postgres and sidekiq');
    expect(withDesc).toBe(1 << OTHER_ID);
  });

  describe('word-boundary anchors on short tokens', () => {
    const negatives: [title: string, key: string][] = [
      ['Rapid growth in project count', 'api'],
      ['DBMS vendor evaluation issue', 'db'],
      ['Circuit breaker tripped in Gitaly', 'ci'],
      ['Duolingo integration proposal', 'duo'],
      ['Kasten backup tooling review', 'kas'],
      ['Crossover traffic between zones', 'web'],
    ];
    for (const [title, key] of negatives) {
      it(`does not put ${JSON.stringify(title)} in ${key}`, () => {
        expect(has(title, key)).toBe(false);
      });
    }
  });

  it('splits camelCase alert names so their tokens are visible', () => {
    expect(has('WebServiceLoadBalancerErrorSLOViolation', 'web')).toBe(true);
    expect(has('PatroniServiceRailsReplicaSqlApdexSLOViolation', 'db')).toBe(true);
    expect(has('KubeServiceApiserverErrorSLOViolation', 'platform')).toBe(true);
  });

  it('does not treat apdex / error rate / cny as a web signal', () => {
    // These appear in ~1,800 SLI alert titles for every service in the fleet.
    expect(has('Apdex SLO violation in the monitoring service', 'web')).toBe(false);
    expect(has('Error rate exceeding SLO for cny', 'web')).toBe(false);
  });
});

describe('classifyStage', () => {
  const cases: [string, string][] = [
    ['praefect deploy to gstg-cny failing', 'cny'],
    ['Goserver apdex SLO violation in cny stage', 'cny'],
    ['Short canary apdex violation', 'cny'],
    ['Post Deploy Migration fails on Staging', 'gstg'],
    ['QA smoke test failure on gstg', 'gstg'],
    ['Cannot push - gitaly RPC error', 'gprd'],
    ['Loadbalancer error rate SLO violation in web service (main stage)', 'gprd'],
    ['Production database failover', 'gprd'],
  ];
  for (const [title, stage] of cases) {
    it(`${JSON.stringify(title.slice(0, 50))} -> ${stage}`, () => {
      expect(classifyStage(title)).toBe(stage);
    });
  }

  it('ignores the description, which links to dashboards for every stage', () => {
    expect(classifyStage('Chef client failures have reached critical levels', 'see gstg-cny board')).toBe('gprd');
  });
});

describe('the service taxonomy itself', () => {
  it('has unique, stable ids and keys', () => {
    expect(new Set(SERVICES.map((s) => s.id)).size).toBe(SERVICES.length);
    expect(new Set(SERVICES.map((s) => s.key)).size).toBe(SERVICES.length);
  });

  it('keeps every id inside a 32-bit mask', () => {
    for (const s of SERVICES) expect(s.id).toBeLessThan(31);
  });

  it('gives the other bucket no patterns', () => {
    expect(SERVICE_BY_KEY.other!.patterns).toHaveLength(0);
    expect(SERVICE_BY_KEY.other!.id).toBe(OTHER_ID);
  });

  it('maps all 23 Status.io components to exactly one bucket', () => {
    expect(STATUS_IO_COMPONENTS).toHaveLength(23);
    expect(() => assertStatusIoMapping()).not.toThrow();
    for (const name of STATUS_IO_COMPONENTS) {
      const owners = SERVICES.filter((s) => s.statusIo.includes(name));
      expect(owners, name).toHaveLength(1);
      expect(serviceIdForComponent(name)).toBe(owners[0]!.id);
    }
  });

  it('fails loudly when upstream renames a component', () => {
    const renamed = STATUS_IO_COMPONENTS.map((n) => (n === 'Git Operations' ? 'Git Ops' : n));
    expect(() => assertStatusIoMapping(renamed)).toThrow(/not mapped|unknown component/);
  });

  it('fails loudly when upstream adds a component', () => {
    expect(() => assertStatusIoMapping([...STATUS_IO_COMPONENTS, 'Brand New Thing'])).toThrow();
  });
});

describe('the non-incident filter', () => {
  const junk = [
    'blah',
    'Testing',
    'Test 3',
    'Test incident',
    'test patcher',
    'patcher test',
    'Test: non-incident issue',
    'TEST: CMOC Practice Event.',
    'TEST: Shadow CMOC Practice Event',
    'Testing that the incident webhook now includes the issue number',
    'Incident Working doc: 2018-06-29',
    '[TEST] Delivery Monthly Release Hot Patching Production Practice',
    '[IGNORE] Test Woodhouse Integration',
    '[ignore][test] incident type issue testing',
    'Practice incident 2020-04-08',
    'CMOC Practice Incident',
    'IGNORE this is a test incident, it is not a real incident',
    'This is a test incident.',
    'TEST, please ignore',
    'Test [IGNORE]',
    'incident worth ignoring',
  ];
  for (const title of junk) {
    it(`excludes ${JSON.stringify(title.slice(0, 56))}`, () => {
      expect(nonIncidentReason(title)).not.toBeNull();
    });
  }

  /**
   * The whole risk of this filter is a rule losing its anchor. These are real
   * incident titles that contain the word "test" and MUST survive.
   */
  const keep = [
    'QA test failure on staging',
    'Broken QA test on canary',
    'QA smoke test failing on gstg',
    'Staging QA test suites failing due to 429 errors',
    'Non-functional gitaly test node in gstg is blocking deployments',
    'Commit via the API fails with error 500 during a QA test',
    'SSL certificate for https://gitlab.com/sytses/test-2/issues/1 expires soon',
    'Deploy pipeline blocked due to failed QA test in Staging',
    '18-8 stable branch is red due to failing tests',
    'Flaky test causing pipeline failures',
    'Practice makes perfect: load testing the registry',
    'Latest release candidate is failing QA',
  ];
  for (const title of keep) {
    it(`keeps ${JSON.stringify(title.slice(0, 56))}`, () => {
      expect(nonIncidentReason(title)).toBeNull();
    });
  }

  it('partitions without losing or duplicating a row', () => {
    const rows = [...junk, ...keep].map((t, k) => ({
      iid: k,
      t,
      c: '2024-01-01T00:00:00Z',
      x: null,
      u: '2024-01-01T00:00:00Z',
      st: 'closed' as const,
      sev: 3 as const,
      ist: null,
      stg: 'gprd' as const,
      svc: 1,
      rc: null,
    }));
    const { kept, excluded } = partitionIncidents(rows);
    expect(kept).toHaveLength(keep.length);
    expect(excluded).toHaveLength(junk.length);
    expect(new Set([...kept, ...excluded].map((r) => r.iid)).size).toBe(rows.length);
  });
});
