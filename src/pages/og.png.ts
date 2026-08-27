/**
 * /og.png — the 1200x630 social card, rendered at build time.
 *
 * satori turns a small element tree into SVG, resvg rasterises it. Both run in
 * the Node build, so nothing here ships to the browser and there is no runtime
 * cost.
 *
 * Fonts are vendored in src/fonts/ rather than fetched. satori has to measure
 * glyphs itself, so it needs real font bytes; downloading them during the
 * build would make `astro build` fail whenever the CDN sneezes, and relying on
 * CI system fonts makes the card look different on every machine. Three Inter
 * subsets, ~90 KB total, committed once.
 */
import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import type { Aggregates, StatusSnapshot } from '../lib/types';
import { computeVerdict } from '../lib/verdict';
import aggregatesJson from '../generated/aggregates.json';
import snapshotJson from '../generated/snapshot.json';

export const prerender = true;

const aggregates = aggregatesJson as Aggregates;
const snapshot = snapshotJson as unknown as StatusSnapshot;

/** Heat ramp for the card only. Deliberately independent of the island's
 *  palette, because an OG image has no dark mode and no CSS variables. */
const HEAT_COLOUR = ['#7dd3a7', '#9fd88a', '#f2c14e', '#f09246', '#e5643c', '#e0453c'] as const;

const FONT_DIR = join(process.cwd(), 'src', 'fonts');
function loadFont(file: string): Buffer {
  try {
    return readFileSync(join(FONT_DIR, file));
  } catch (cause) {
    throw new Error(
      `og.png: missing font ${file}. Expected it in src/fonts/ — it is committed to the repo, so a fresh checkout should have it.`,
      { cause },
    );
  }
}

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, props: Record<string, unknown>): Node => ({ type, props });
const text = (
  content: string,
  style: Record<string, unknown>,
): Node => el('div', { style: { display: 'flex', ...style }, children: content });

const nf = new Intl.NumberFormat('en-US');

export const GET: APIRoute = async () => {
  const verdict = computeVerdict({ live: snapshot.live, open: snapshot.openIncidents });
  const heatColour = HEAT_COLOUR[verdict.heat] ?? HEAT_COLOUR[0];
  const answer = verdict.heat >= 3 ? 'Yes.' : 'No.';
  const headline = `${answer} ${verdict.word}`;

  const stats: [string, string][] = [
    [nf.format(aggregates.daysSince), aggregates.daysSince === 1 ? 'day since the last one' : 'days since the last one'],
    [nf.format(aggregates.totalDefault), 'customer-facing incidents'],
    [nf.format(aggregates.totalAll), 'tracked issues since 2018'],
  ];

  const card = el('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      width: '1200px',
      height: '630px',
      backgroundColor: '#12151d',
      color: '#f5f6f8',
      fontFamily: 'Inter',
      padding: '64px 72px',
      justifyContent: 'space-between',
    },
    children: [
      // Top accent rule.
      el('div', {
        style: {
          display: 'flex',
          position: 'absolute',
          top: 0,
          left: 0,
          width: '1200px',
          height: '10px',
          backgroundColor: heatColour,
        },
      }),

      el('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
        children: [
          text('isgitlabcooked.com', {
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: '0.02em',
            color: '#9aa3b2',
          }),
          text('UNOFFICIAL', {
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: '0.18em',
            color: '#6f7a8c',
            border: '2px solid #2c323f',
            borderRadius: '999px',
            padding: '8px 20px',
          }),
        ],
      }),

      el('div', {
        style: { display: 'flex', flexDirection: 'column' },
        children: [
          text('Is GitLab Cooked?', { fontSize: 44, fontWeight: 700, color: '#c3cad6' }),
          text(headline, {
            // Longest possible headline is "No. Room Temperature" (20 chars);
            // step the size down so nothing is ever clipped by the 1056px
            // content width.
            fontSize: headline.length <= 11 ? 124 : headline.length <= 15 ? 108 : 92,
            fontWeight: 900,
            letterSpacing: '-0.04em',
            color: heatColour,
            marginTop: '6px',
          }),
          text(verdict.subline, {
            fontSize: 30,
            fontWeight: 400,
            color: '#9aa3b2',
            marginTop: '14px',
          }),
        ],
      }),

      el('div', {
        style: {
          display: 'flex',
          borderTop: '2px solid #262c38',
          paddingTop: '28px',
          justifyContent: 'space-between',
        },
        children: stats.map(([value, label]) =>
          el('div', {
            style: { display: 'flex', flexDirection: 'column', width: '330px' },
            children: [
              text(value, { fontSize: 54, fontWeight: 900, color: '#f5f6f8', letterSpacing: '-0.03em' }),
              text(label, { fontSize: 22, fontWeight: 400, color: '#8b94a5', marginTop: '4px' }),
            ],
          }),
        ),
      }),
    ],
  });

  const svg = await satori(card as never, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Inter', data: loadFont('inter-latin-400-normal.woff'), weight: 400, style: 'normal' },
      { name: 'Inter', data: loadFont('inter-latin-700-normal.woff'), weight: 700, style: 'normal' },
      { name: 'Inter', data: loadFont('inter-latin-900-normal.woff'), weight: 900, style: 'normal' },
    ],
  });

  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300, s-maxage=86400',
    },
  });
};
