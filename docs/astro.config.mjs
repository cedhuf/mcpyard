import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// Published to GitHub Pages under /mcpyard/ by the docs job of release.yml.
// `format: 'file'` keeps the page URLs ending in .html, which the README and older links use.
export default defineConfig({
  site: 'https://cedhuf.github.io',
  base: '/mcpyard',
  build: { format: 'file' },
  trailingSlash: 'never',
  // The logo is the hub's own file in ../static, not a copy.
  vite: { server: { fs: { allow: ['..'] } } },
  integrations: [
    starlight({
      title: 'MCP Yard',
      description: 'A small, self-hosted MCP hub. One endpoint, every MCP server behind it, one key per client.',
      logo: { src: '../static/apple-touch-icon.png', alt: 'MCP Yard' },
      favicon: '/favicon.ico',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/cedhuf/mcpyard' }],
      editLink: { baseUrl: 'https://github.com/cedhuf/mcpyard/edit/main/docs/' },
      customCss: ['@fontsource-variable/fredoka', './src/styles/custom.css'],
      // Self-hosted Umami: no cookie and no personal data, so no consent banner.
      head: [
        {
          tag: 'script',
          attrs: { defer: true, src: 'https://audience.thehuf.uk/script.js', 'data-website-id': '6f3d2ca5-ddc2-40da-9ed1-60195b4112f2' },
        },
      ],
      components: { Header: './src/components/Header.astro', Hero: './src/components/Hero.astro' },
      sidebar: [
        { label: 'Start', items: ['getting-started', 'deployment'] },
        { label: 'Configure', items: ['configuration', 'packages', 'keys'] },
        { label: 'Operate', items: ['web-ui', 'admin'] },
        { label: 'Architecture', items: [{ autogenerate: { directory: 'architecture' } }] },
        { label: 'Project', items: [{ label: 'Releases', link: '/releases.html' }] },
      ],
    }),
  ],
});
