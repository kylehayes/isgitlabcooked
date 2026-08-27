// @ts-check
import { defineConfig, envField } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://isgitlabcooked.com',
  output: 'static',
  integrations: [preact({ compat: false }), sitemap()],
  vite: { plugins: [tailwindcss()] },
  env: {
    schema: {
      PUBLIC_GA4_ID: envField.string({ context: 'client', access: 'public', optional: true }),
    },
  },
});
