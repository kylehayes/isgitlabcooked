# Is GitLab Cooked?

An unofficial GitLab.com outage tracker: a live verdict from
[status.gitlab.com](https://status.gitlab.com/), backed by every incident-labelled issue in
GitLab's public infrastructure tracker,
[`gitlab-com/gl-infra/production`](https://gitlab.com/gitlab-com/gl-infra/production/-/issues) —
7,000+ of them since 28 April 2018.

Not affiliated with, endorsed by, or connected to GitLab Inc. "GitLab" is their trademark and is
used here only to identify what is being measured.

Live at **<https://isgitlabcooked.com>**.

---

## What the site claims, and what it doesn't

Worth knowing before you read a number off a chart:

- **The default view is a filter, not the whole tracker.** It shows severity 1–2 incidents in the
  `gprd` production stage — the ones a customer could plausibly have noticed. A large share of the
  full tracker is internal SLO alerting that never reached a user. A toggle reveals S3/S4 plus the
  `gstg` and `cny` stages.
- **Service tags are inferred, not published.** GitLab does not attach a machine-readable service
  field to incidents, so we keyword-match incident titles. Directionally useful, not authoritative.
- **Durations exist for S1 and S2 only.** They come from the `Incident::Mitigated` label event.
  S3/S4 get no duration at all, because their tickets are routinely closed hundreds of hours after
  the outage ended — `closed_at − created_at` measures ticket hygiene, not downtime.

## Stack

| | |
|---|---|
| Framework | Astro 7 (`output: 'static'`) |
| Interactive island | Preact 10 + `@preact/signals` |
| Styling | Tailwind CSS 4 via `@tailwindcss/vite` |
| Social card | `satori` + `@resvg/resvg-js`, prerendered at build time |
| Host | Cloudflare Pages |

## Local development

Requires Node 22 (`.nvmrc` pins 22.14.0).

```bash
nvm use            # or: fnm use
npm ci
cp .env.example .env
npm run dev        # http://localhost:4321
```

`.env` only carries `PUBLIC_GA4_ID`. Leave it unset locally if you would rather not send events —
the tracking helper is a no-op when the ID is absent.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Astro dev server with HMR. |
| `npm run build` | Runs `prebuild` (`scripts/build-dataset.ts`) then `astro build` into `dist/`. |
| `npm run preview` | Serves the built `dist/` locally. |
| `npm run check` | `astro check` + `tsc --noEmit`. |
| `npm test` | Vitest. |
| `npm run sync` | Incremental pull of new/updated incidents from the GitLab API into `data/`. |
| `npm run validate` | Asserts the synced counts against `data/meta.json`. |
| `npm run snapshot` | Captures the current status.gitlab.com component states. |

## Data pipeline

Two stages, deliberately separate so a slow API call can never block a deploy.

```
GitLab API ──npm run sync──▶ data/incidents.ndjson       (git-tracked corpus)
                             data/durations.json
                             data/meta.json
                             data/status-components.json
                                      │
                                      │ npm run build  (prebuild step)
                                      ▼
                             public/data/incidents.<hash>.json   columnar, immutable
                             public/data/details/<year>.<hash>.json
                             src/generated/aggregates.json       inlined into the HTML
                             src/generated/snapshot.json
                             src/generated/manifest.json
```

1. **Sync** (`npm run sync`) talks to the GitLab API, walks issues updated since the cursor in
   `data/meta.json`, and appends to the NDJSON corpus. Duration backfill needs an authenticated
   token (see below); without one, the sync still works but durations stay `Unknown`.
2. **Validate** (`npm run validate`) checks the corpus against the recorded counts. Run it before
   committing a sync.
3. **Build** (`npm run build`) derives everything the browser sees. Only the corpus in `data/` is
   committed; `src/generated/` and `public/data/` are gitignored and regenerated on every build.

Because `src/generated/*.json` is gitignored, a fresh checkout has no aggregates until the first
build. Hand-authored fixtures matching the `Aggregates` and `StatusSnapshot` types live at those
paths so the UI can be worked on without running the pipeline; the build overwrites them.

The shared type contract for all three stages is [`src/lib/types.ts`](src/lib/types.ts). Changing
it means changing the sync script, the build and the island together.

## Deployment — Cloudflare Pages

### Build configuration

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | None / Astro |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | *(repository root)* |

### Environment variables

Set these on **both** the Production and the Preview environment — Cloudflare does not copy
variables between them, and a preview built without `NODE_VERSION` will silently pick an older
Node and fail on the ESM-only dependencies.

| Variable | Value |
|---|---|
| `NODE_VERSION` | `22.14.0` |
| `PUBLIC_GA4_ID` | `G-12R6NZBGGZ` |

`PUBLIC_GA4_ID` is declared in `astro.config.mjs` as an optional public client variable, so builds
succeed without it — the analytics snippet is simply not emitted. The value is also validated
against `/^G-[A-Z0-9]+$/` before it is allowed into an inline script; anything else is dropped with
a build warning rather than interpolated.

### Headers and redirects

`public/_headers` and `public/_redirects` are copied verbatim into `dist/` and picked up by
Cloudflare Pages:

- `/data/*` is immutable for a year — safe because those filenames are content-hashed.
- `/` gets a short browser TTL with a longer edge TTL, so a rebuild propagates quickly.
- `X-Content-Type-Options` and `Referrer-Policy` on everything.
- `www.isgitlabcooked.com` 301s to the apex, preserving the path.

### Custom domain

1. Add the zone `isgitlabcooked.com` to Cloudflare and point the registrar at the assigned Cloudflare
   nameservers.
2. In **Workers & Pages → the project → Custom domains**, add `isgitlabcooked.com`. Cloudflare
   creates the proxied apex `CNAME` (flattened) automatically.
3. Add `www.isgitlabcooked.com` as a second custom domain on the same project. Serving it — rather
   than only redirecting at DNS — is what lets `public/_redirects` return a clean 301 to the apex
   with the path intact.
4. Wait for the edge certificate to go active, then confirm:

   ```bash
   curl -sI https://www.isgitlabcooked.com/about/ | head -3   # expect 301 → apex
   curl -sI https://isgitlabcooked.com/ | grep -i cache-control
   ```

The apex is canonical everywhere: `astro.config.mjs` `site`, the `<link rel="canonical">` in
`BaseLayout.astro`, the sitemap, and `public/robots.txt` all use it.

## GitHub Actions secret

The scheduled sync workflow needs one secret:

| Secret | Value |
|---|---|
| `GITLAB_TOKEN` | A GitLab personal access token with the **`read_api`** scope. |

Create it at <https://gitlab.com/-/user_settings/personal_access_tokens>, scope it to `read_api`
only, then add it under **Settings → Secrets and variables → Actions → New repository secret**.

It is required for incident *durations*: reading the `Incident::Mitigated` label event needs the
resource-label-events endpoint, which is not available to anonymous callers. Incident metadata
itself is public, so an unauthenticated sync still works — you just get no durations, and you hit
the anonymous rate limit far sooner.

The token is never needed at deploy time; Cloudflare only ever builds from the committed corpus.

## Project layout

```
src/
  layouts/BaseLayout.astro     head, SEO, JSON-LD, header, footer, analytics
  components/
    Hero.astro                 headline, server-rendered verdict, days-since counter
    StatCards.astro            the four headline numbers
    Explainer.astro            "what this is / what it is not"
    Footer.astro
    Analytics.astro            GA4, ID-validated before it touches an inline script
    island/                    Preact dashboard: calendar, filters, charts
  lib/
    types.ts                   frozen contract shared by scripts, build and browser
    track.ts                   GA4 event helper + the event vocabulary
    dates.ts                   UTC-only day arithmetic
  pages/
    index.astro  about.astro  404.astro  og.png.ts
  fonts/                       Inter subsets, used only by the OG image renderer
  generated/                   build output, gitignored
scripts/                       sync, validate, snapshot, build-dataset
public/                        robots.txt, _headers, _redirects, favicon.svg
```

### Why fonts are vendored

`src/fonts/` holds three Inter subsets (~90 KB total). They are used **only** by `src/pages/og.png.ts`
— satori has to measure glyphs itself, so it needs real font bytes. Fetching them during the build
would make `astro build` fail whenever a CDN has a bad day, and falling back to CI system fonts
would make the social card look different on every machine. The site itself ships no webfont and
uses the system UI stack.

## Accessibility

Semantic landmarks, a skip link, one visible focus style, `prefers-reduced-motion` honoured, and no
information carried by colour alone — the verdict always states "Yes." or "No." in words, degraded
components are named, and every chart value has a text equivalent. Light and dark are both
token-driven and every text/background pair clears WCAG AA; the measured ratios are recorded in
`src/styles/global.css`.

## Licence

Code is MIT. The underlying incident data belongs to GitLab and is reproduced under their public
terms; go read it at the source.
