import type { ServiceMeta, Stage } from './types';
import { OTHER_ID, SERVICE_META, SERVICE_META_BY_ID, SERVICE_META_BY_KEY } from './serviceMeta';

/**
 * The service taxonomy. GitLab's incident issues carry no service label, so the
 * bucket is inferred from the title (and, weakly, the description). Classification
 * is multi-label on purpose: "Gitaly saturation causing 500s on the web fleet"
 * is legitimately git + web + db-adjacent, and the filter UI is a bitmask.
 *
 * `id` doubles as the bit position, so ids must stay stable forever: appending is
 * fine, reordering or reusing an id silently rewrites history.
 */
export interface ServiceBucket extends ServiceMeta {
  /** Status.io component names owned by this bucket. Every one of the 23 maps once. */
  statusIo: string[];
  patterns: RegExp[];
}

/**
 * `other` is the fallback bucket; nothing pattern-matches into it. Ids, keys and
 * labels come from serviceMeta.ts so the browser can label a bitmask without
 * pulling this regex table into the bundle.
 */
export { OTHER_ID, SERVICE_META };

export const SERVICES: ServiceBucket[] = [
  {
    ...SERVICE_META_BY_ID[0]!,
    statusIo: ['Git Operations'],
    patterns: [
      /gitaly/i,
      /praefect/i,
      /\bgit\s+(push|pull|clone|fetch|http|ssh|lfs|gc)/i,
      /\bgit(hub)?\s*-?\s*(operation|access)/i,
      /repository\s+(storage|move|verification|replicat)/i,
      /\bssh\b.*\b(git|clone|push)|\b(git|clone|push)\b.*\bssh\b/i,
      /\brepo(sitor(y|ies))?\b.*\b(unavailab|error|fail|read.?only|corrupt|missing)/i,
      /\bgit\b.*\b(unavailab|error|fail|slow|latenc|timeout|5\d\d)/i,
      /\b(unavailab|error|fail|slow|latenc|timeout)\w*\b.*\bgit\s+(backends?|service|fleet|nodes?)\b/i,
      /\bclon(e|es|ing)\b/i,
      /\bpull\s*mirror|\bmirror(ing|s)?\b/i,
      /\bsubmodule/i,
      /\bfile-[a-z]*-?\d+\b/i,
      /\bgit\s+service\b/i,
      /\bgitlab-?shell\b|gitlab[-_ ]?sshd\b/i,
      /\bgoserver\b/i,
      /-stor-(gprd|gstg)\b/i,
      /\bssh\b/i,
      /\bpull\s+mirror|\bpush\s+mirror/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[1]!,
    statusIo: ['API'],
    patterns: [/\bapi\b/i, /graphql/i, /\/api\/v\d/i, /\bgrpc\b/i],
  },
  {
    ...SERVICE_META_BY_ID[2]!,
    statusIo: ['Website', 'Canary'],
    patterns: [
      /\bweb\b/i,
      /\bwebsite\b/i,
      /workhorse/i,
      /\bpuma\b/i,
      /\brails\b/i,
      /\bunicorn\b/i,
      /\bfrontend\b/i,
      /\b5xx\b/i,
      /\b50[234]\b/i,
      /\b(gitlab\.com|dot ?com)\b.*\b(down|unavailab|slow|error|degrad)/i,
      // `apdex`, `error rate`, `cny` and `canary` are deliberately NOT web patterns.
      // They appear in ~1,800 SLI alert titles across every service; treating them
      // as a web signal put a quarter of the dataset in the wrong bucket.
      /\bwebsockets?\b/i,
      /\bcamoproxy\b/i,
      /\bwebservice\b/i,
      /\bimage\s?scaler\b/i,
      /\bnginx\b/i,
      /\bhaproxy\b/i,
      /\bcloudflare\b/i,
      /\bcdn\b/i,
      /\b40[34]\b/i,
      /\bmerge\s+requests?\b|\bmrs?\b/i,
      /\bcomments?\b/i,
      /\bissues?\b.*\b(creat|load|fail|slow|open|view|404|error)/i,
      /\bgraphs?\b|\bavatars?\b|\bbanner\b/i,
      // Public-endpoint probes and certificate expiries are website availability.
      /(?:blackbox|pingdom|probe|certificate|expires)[\s\S]*\b(?:www\.|staging\.|pre\.)?gitlab\.com\b/i,
      /\bgitlab-static\.net\b|user-content/i,
      /\bgitlab\.com\b.*\b(down|unavailab|slow|error|degrad|500|502|503|timeout|fail)/i,
      /\b(500|502|503|504|520|429|422|403|404)s?\b/,
      /internal\s+server\s+error/i,
      /site-?wide/i,
      /\brender(ing|ed)?\b|\bmarkdown\b|\bdark\s+mode\b|\bautocomplete\b/i,
      /\bwikis?\b|\bsnippets?\b|\bmilestones?\b|\bdiffs?\b|\bblob\b/i,
      /\bglql\b|\bchangelog\b|\banalytics\b|\bnamespaces?\b/i,
      // A bare certificate alert is an HTTPS-endpoint availability problem.
      /\bcertificates?\b|\bx509\b|\bssl\b|\btls\b/i,
      /\bdns\b|\bingress\b|\bload\s?balancer\b|\biap\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[3]!,
    statusIo: [
      'CI/CD',
      'CI/CD - Hosted runners on Linux',
      'CI/CD - Hosted runners on Windows',
      'CI/CD - Hosted runners on macOS',
      'CI/CD - Hosted runners for GitLab community contributions',
      'CI/CD - Self-managed runners',
    ],
    patterns: [
      /\bci\b/i,
      /\bci\/?cd\b/i,
      /pipeline/i,
      /runner/i,
      /\bjobs?\b.*\b(stuck|queue|pending|fail|drop|lost|delay|not\s+start)/i,
      /\b(stuck|queued|pending|failing)\b.*\bjobs?\b/i,
      /\bbuilds?\b.*\b(fail|stuck|queue|slow)/i,
      /\bkubernetes\s+executor\b/i,
      /\bshared\s+runners?\b/i,
      /\bdeploy(ment)?s?\b.*\b(block|fail|stuck)/i,
      /\bmerge\s+trains?\b/i,
      /\bauto-?deploy\b/i,
      /\bdeploy(ment|er)?s?\b/i,
      /\bbuilds?\b/i,
      /\brelease\b.*\b(block|fail|delay|stuck|broken)/i,
      /\b(patch|hot\s?patch)\b.*\brelease\b/i,
      /\bqa\b|\bsmoke\s+tests?\b|\be2e\b/i,
      /\bhot\s?patch(ing)?\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[4]!,
    statusIo: ['Container Registry'],
    patterns: [
      /container\s+registry/i,
      /\bregistry\b/i,
      /\bdocker\b/i,
      /\bdependency\s+prox/i,
      /registry\.gitlab\.com/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[5]!,
    statusIo: ['Package Registry', 'packages.gitlab.com'],
    patterns: [
      /package\s+registry/i,
      /packages\.gitlab\.com/i,
      /\bnpm\b|\bmaven\b|\bpypi\b|\bhelm\b|\bnuget\b|\bconan\b|\brubygem/i,
      /\bpackages?\b.*\b(upload|download|publish|fail|unavailab)/i,
      /\bpackagecloud\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[6]!,
    statusIo: ['GitLab Pages'],
    patterns: [
      /gitlab[\s-]?pages/i,
      /\bpages\b.*\b(down|deploy|serv|domain|cert|unavailab|error|fail|fleet|latenc|slow|tls|traffic|spike|flood)/i,
      /\bpages\.gitlab\.io\b/i,
      /[a-z0-9-]+\.gitlab\.io\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[7]!,
    statusIo: [],
    patterns: [
      /\bpostgres(ql)?\b/i,
      /patroni/i,
      /pgbouncer/i,
      /\bpg\b|\bpgb\b/i,
      /replica(tion)?\s+lag/i,
      /\bvacuum\b/i,
      /\bdatabase\b/i,
      /\bdb\b/i,
      /\bwal-?[ge]?\b/i,
      /\bxid\b|transaction\s+id\s+wraparound/i,
      /\bdead\s*tuples?\b/i,
      /\bslow\s+quer/i,
      /\bconnection\s+pool/i,
      /\bclickhouse\b/i,
      /cloud-?sql/i,
      /\bwal-?g\b|\bwalg\w*/i,
      /\btuples?\b/i,
      /\bbase\s?backup|\bbackups?\b/i,
      /\bpdm\b|post-?deploy(ment)?\s+migration/i,
      /\b(statement|lock|idle)\s+timeout/i,
      /\bmigration/i,
      /\bsequence\b|\bindex(es)?\b.*\b(bloat|missing|invalid)/i,
      /\bprimary\b.*\b(failover|switchover|promot)/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[8]!,
    statusIo: ['Background Processing'],
    patterns: [
      /sidekiq/i,
      /background\s+(job|migration|processing|task)/i,
      /queue\s+(depth|backlog|length|size)/i,
      /\bredis\b/i,
      /\bcron\b/i,
      /\bworkers?\b.*\b(saturat|backlog|stuck|fail|oom)/i,
      /\bmailroom\b/i,
      /\bpub\/?sub\b|\bpubsub\b/i,
      /\bqueu(e|es|ed|ing)\b/i,
      /\bbacklog\b/i,
      /\bthrottl/i,
      /\b(catchall|urgent-\w+|cpu-bound|memory-bound|quarantine|low-urgency)\b/i,
      /\breactive[\s_]?caching\b/i,
      /\bscheduled\b.*\b(job|task|export|import)/i,
      /\b(project|group|bitbucket|github)\s+(import|export)/i,
      /\bimports?\b.*\b(fail|stuck|slow)|\bexports?\b.*\b(fail|stuck|slow|expir)/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[9]!,
    statusIo: [],
    patterns: [
      /elastic\s?search/i,
      /\belastic\b/i,
      /\bzoekt\b/i,
      /code\s+search/i,
      /\bopensearch\b/i,
      /\bes\s+cluster\b/i,
      /advanced\s+search/i,
      /\bsearch\b.*\b(down|slow|fail|degrad|unavailab|error|index)/i,
      /\belk\b|\blogstash\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[10]!,
    statusIo: [],
    patterns: [
      /object\s+storage/i,
      /storage\.googleapis\.com/i,
      /\bgcs\b/i,
      /\bs3\b/i,
      /\bbuckets?\b/i,
      /artifacts?\b.*\b(upload|download|expir|missing|fail|delet)/i,
      /\blfs\b/i,
      /\bdisk\s+(space|full|usage|saturat)/i,
      /\bfilesystem\b/i,
      /\bnfs\b/i,
      /\bpvc\b|persistent\s+volume/i,
      /\bquota\b.*\bstorage\b|storage\b.*\bquota\b/i,
      /\bsnapshots?\b/i,
      /\buploads?\b/i,
      /\bdisk\b/i,
      /\bio\s+(problem|saturat|latenc|wait)|\bdisk\s+i\/?o\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[11]!,
    statusIo: ['GitLab Duo'],
    patterns: [
      /\bduo\b/i,
      /code\s+suggestions?/i,
      /\bai\s*-?\s*gateway\b/i,
      /code[\s_]?completions?/i,
      /\binference/i,
      /\bfireworks\b|\bbedrock\b|\bmistral\b/i,
      /\bllm\b/i,
      /\banthropic\b|\bvertex\b|\bopenai\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[12]!,
    statusIo: ['GitLab agent server for Kubernetes'],
    patterns: [/\bkas\b/i, /kubernetes\s+agent/i, /\bagentk\b/i],
  },
  {
    ...SERVICE_META_BY_ID[13]!,
    statusIo: ['GitLab Customers Portal'],
    patterns: [
      /customers\.gitlab\.com/i,
      /customers\s*dot/i,
      /\bcustomersdot\b/i,
      /\blicens(e|ing)\b/i,
      /\bsubscription/i,
      /\bzuora\b|\bsalesforce\b|\bbilling\b/i,
      /\btrials?\b.*\b(fail|error|unavailab)/i,
      /\bpurchase|\bcheckout\b|\bseats?\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[14]!,
    statusIo: ['SAML SSO - GitLab SaaS'],
    patterns: [
      /\bsso\b|\bsaml\b|\boauth\b|\b2fa\b|\bmfa\b/i,
      /\blog\s?in\b|\bsign\s?-?\s?in\b|\bsign\s?-?\s?up\b/i,
      /\bsessions?\b/i,
      /\bauthenticat|\bauthoriz/i,
      /\bldap\b/i,
      /\bscim\b/i,
      /personal\s+access\s+token|\bpat\b/i,
      /\bcaptcha\b|\barkose\b/i,
      /\bidentity\s+verification\b/i,
      /\bcredential/i,
      /\bteleport\b/i,
      /\bvault\b/i,
      /\bpermission|\baccess\s+denied\b|\b403\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[15]!,
    statusIo: [],
    patterns: [
      /\bemails?\b|\bsmtp\b|\bmailgun\b|\bsendgrid\b/i,
      /\bwebhooks?\b/i,
      /notification/i,
      /\bslack\b.*\b(integration|notif)/i,
      /\bpagerduty\b/i,
      /\bmails?\b|\bmailgun\b/i,
      /\bincident\.io\b|\bstatuspage\b/i,
      /\bchat\s?ops\b|\bwoodhouse\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[16]!,
    statusIo: [
      'docs.gitlab.com',
      'forum.gitlab.com',
      'version.gitlab.com',
      'Support Services',
    ],
    patterns: [
      /docs\.gitlab\.com/i,
      /\bforum\b/i,
      /about\.gitlab\.com/i,
      /version\.gitlab\.com/i,
      /\bdocumentation\b/i,
      /\bzendesk\b|support\s+(portal|services)/i,
      /\bstatus\.gitlab\.com\b|\bstatus\s+page\b/i,
      /support\.gitlab\.com|design\.gitlab\.com|handbook/i,
      /\bcontributors?\b|\bcommunity\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[18]!,
    statusIo: [],
    patterns: [
      /prometheus/i,
      /\bthanos\b/i,
      /alert\s?manager/i,
      /grafana/i,
      /\btrickster\b/i,
      /\bsentry\b/i,
      /\bkibana\b/i,
      /\bfluentd\b|\btd-agent\b/i,
      /\blogging\b|\blog\s+(ingest|output|reject|shipp)/i,
      /\bmonitoring\b|\bobservability\b/i,
      /rule\s+evaluat/i,
      /\bdashboards?\b/i,
      /\bmetrics?\b/i,
      /\bblackbox\b|\bpingdom\b|\bsnitch/i,
      /\bjaeger\b|\btracing\b|\bapm\b/i,
      /\bmimir\b|\bexporter\b|\bvictoria\s?metrics\b/i,
      /alerts?\s+(are\s+)?(not|fail|missing|flapp|firing)/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[19]!,
    statusIo: [],
    patterns: [
      /\bkube\w*\b|\bk8s\b/i,
      /\bgke\b/i,
      /\bpods?\b/i,
      /unschedulable/i,
      /cluster[\s_-]?(scaleup|autoscal)/i,
      /\bautoscal/i,
      /\bapiserver\b/i,
      /\bwaf\b|gitlab[\s_]zone/i,
      /\bnat\b/i,
      /\bconsul\b/i,
      /\batlantis\b/i,
      /cloud-?sql/i,
      /\bpvs\b/i,
      /\bgcp\b|google\s+cloud/i,
      /\bquota\b/i,
      /\bbastion\b/i,
      /\bterraform\b|\bansible\b/i,
      /\bistio\b/i,
      /statefulset|\bdaemonset\b|\bdeployment\s+replicas?\b/i,
      /node\s?pool/i,
      /\bchef\b|\bknife\b/i,
      /\bvms?\b|\binstance\s+group\b/i,
      /\binfrastructure\b/i,
    ],
  },
  {
    ...SERVICE_META_BY_ID[OTHER_ID]!,
    statusIo: [],
    patterns: [],
  },
];

export const SERVICE_BY_ID: Record<number, ServiceBucket> = Object.fromEntries(
  SERVICES.map((s) => [s.id, s]),
);
export const SERVICE_BY_KEY: Record<string, ServiceBucket> = Object.fromEntries(
  SERVICES.map((s) => [s.key, s]),
);
export { SERVICE_META_BY_ID, SERVICE_META_BY_KEY };

/** The 23 component names Status.io publishes. Kept literal so a rename fails the build. */
export const STATUS_IO_COMPONENTS: string[] = [
  'Website',
  'API',
  'Git Operations',
  'Package Registry',
  'Container Registry',
  'GitLab Pages',
  'CI/CD',
  'CI/CD - Hosted runners on Linux',
  'CI/CD - Hosted runners on Windows',
  'CI/CD - Hosted runners on macOS',
  'CI/CD - Hosted runners for GitLab community contributions',
  'CI/CD - Self-managed runners',
  'SAML SSO - GitLab SaaS',
  'Background Processing',
  'GitLab Customers Portal',
  'Support Services',
  'packages.gitlab.com',
  'version.gitlab.com',
  'forum.gitlab.com',
  'docs.gitlab.com',
  'Canary',
  'GitLab Duo',
  'GitLab agent server for Kubernetes',
];

/**
 * Every Status.io component must belong to exactly one bucket, and no bucket may
 * claim a component that does not exist. Called by sync, build and validate; a
 * component rename upstream should break the build, not quietly drop a mapping.
 */
export function assertStatusIoMapping(observed: string[] = STATUS_IO_COMPONENTS): void {
  const errors: string[] = [];
  const owner = new Map<string, string[]>();
  for (const svc of SERVICES) {
    for (const name of svc.statusIo) {
      owner.set(name, [...(owner.get(name) ?? []), svc.key]);
    }
  }
  for (const [name, keys] of owner) {
    if (keys.length > 1) errors.push(`component ${JSON.stringify(name)} claimed by ${keys.join(', ')}`);
    if (!observed.includes(name)) errors.push(`bucket maps unknown component ${JSON.stringify(name)}`);
  }
  for (const name of observed) {
    if (!owner.has(name)) errors.push(`component ${JSON.stringify(name)} is not mapped to any service bucket`);
  }
  if (observed.length !== STATUS_IO_COMPONENTS.length) {
    errors.push(
      `expected ${STATUS_IO_COMPONENTS.length} Status.io components, saw ${observed.length}`,
    );
  }
  if (errors.length) {
    throw new Error(`Status.io component mapping is broken:\n  - ${errors.join('\n  - ')}`);
  }
}

/** Status.io component name -> service bucket id. */
export function serviceIdForComponent(name: string): number {
  for (const svc of SERVICES) if (svc.statusIo.includes(name)) return svc.id;
  return OTHER_ID;
}

/**
 * Bitmask over SERVICES ids. Every bucket is tested; an incident can set several
 * bits. Returns `1 << OTHER_ID` when nothing matches.
 *
 * Two signals, OR'd together:
 *  1. the `Service::*` scoped label, which SRE applies by hand and is by far the
 *     most precise thing available (present on ~62% of issues);
 *  2. the title, matched against the bucket patterns.
 *
 * The description is deliberately NOT used. It is a filled-in template that
 * name-drops half the platform, and sampling showed it assigning buckets to
 * incidents whose titles say nothing at all ("NoMethod errors seen on staging"
 * landing in `docs`). A wrong bucket is worse than `other`, because `other` is
 * honest and a wrong tag silently lies in the filter UI.
 */
export function classify(title: string, _description?: string | null, labels: string[] = []): number {
  let mask = maskFromLabels(labels) | maskFromText(normalise(title));
  return mask === 0 ? 1 << OTHER_ID : mask;
}

function maskFromText(haystack: string): number {
  let mask = 0;
  for (const svc of SERVICES) {
    if (svc.id === OTHER_ID) continue;
    for (const re of svc.patterns) {
      if (re.test(haystack)) {
        mask |= 1 << svc.id;
        break;
      }
    }
  }
  return mask;
}

/**
 * `Service::Gitaly`, `Service::Monitoring-Other`, `Service::GitLab Rails`, ...
 * Only the `Service::` scope is trusted: `group::` and `team::` name the owning
 * engineering team, which is often not the service that broke.
 */
function maskFromLabels(labels: string[]): number {
  let mask = 0;
  for (const raw of labels) {
    const l = raw.trim();
    if (!/^service::/i.test(l)) continue;
    const name = l.slice(l.indexOf('::') + 2).trim();
    if (IGNORED_SERVICE_LABELS.has(name.toLowerCase())) continue;
    mask |= maskFromText(normalise(name));
  }
  return mask;
}

/**
 * `Service::Woodhouse` marks incidents *filed by* the chatops bot, not incidents
 * where the bot is what broke — 64 issues carry it and their titles are about
 * Redis, pgbouncer, workhorse and everything else. `Needed`/`Unknown` are triage
 * placeholders. Treat all three as absent.
 */
const IGNORED_SERVICE_LABELS = new Set(['woodhouse', 'needed', 'unknown', 'other']);

/**
 * Punctuation and camelCase both hide tokens from `\b` anchors, and a large slice
 * of these titles are raw alert names: `WebServiceLoadBalancerErrorSLOViolation`,
 * `walgBaseBackupDelayed`, `KubeServiceApiserverErrorSLOViolation`. We append a
 * word-split copy rather than replacing the original, so patterns that expect the
 * squashed form (`walg`, `pgbouncer`) still match.
 */
function normalise(s: string): string {
  const flat = s.replace(/[`'"\u201c\u201d]+/g, '').replace(/[_/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
  const split = splitCamelCase(flat);
  return split === flat ? flat : `${flat} ${split}`;
}

function splitCamelCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ');
}

/** Decode a bitmask back into bucket keys, in SERVICES order. */
export function servicesFromMask(mask: number): ServiceBucket[] {
  return SERVICES.filter((s) => (mask & (1 << s.id)) !== 0);
}

/** True when the only bit set is `other`. */
export function isUnclassified(mask: number): boolean {
  return mask === 1 << OTHER_ID;
}

const STAGE_PATTERNS: [Stage, RegExp][] = [
  ['cny', /\bcny\b|\bcanary\b/i],
  ['gstg', /\bgstg\b|\bstaging\b|\bstg\b|\bpre\b(?!-?prod\w)|\bpre-?prod/i],
  ['gprd', /\bgprd\b|\bproduction\b|\bprd\b|\bmain\s+stage\b/i],
];

/**
 * Which environment the incident hit. Order matters: "canary in gprd" is a canary
 * incident, and a title naming both staging and production is a staging incident
 * (production-only incidents rarely bother to say "production").
 */
export function classifyStage(title: string, _description?: string | null): Stage {
  // Title only. Incident descriptions link to Grafana boards for every stage, so
  // reading them flipped ~130 plainly-production incidents ("Chef client failures
  // have reached critical levels") into `cny`/`gstg` and hid them from the default
  // production filter. The parameter is kept for call-site symmetry.
  const hay = normalise(title);
  for (const [stage, re] of STAGE_PATTERNS) if (re.test(hay)) return stage;
  return 'gprd';
}
