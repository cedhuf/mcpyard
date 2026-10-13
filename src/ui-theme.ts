/**
 * MCP Yard's own daisyUI themes, taken from the logo: the mint of the server, the gold of the key, the
 * wood of the fence, the green of the grass and the dark outline that holds them together. Rounded
 * shapes and a little depth, like the sticker.
 */
const SHAPE = `
  --radius-selector: 1rem;
  --radius-field: 0.75rem;
  --radius-box: 1rem;
  --size-selector: 0.25rem;
  --size-field: 0.25rem;
  --border: 1px;
  --depth: 1;
  --noise: 0;`;

const YARD_THEMES: Record<string, { scheme: 'light' | 'dark'; colors: string }> = {
  yard: {
    scheme: 'light',
    colors: `
  --color-base-100: #fffdf6;
  --color-base-200: #f5f2e4;
  --color-base-300: #e6e0c9;
  --color-base-content: #2e2420;
  --color-primary: #4fb886;
  --color-primary-content: #0f2a1c;
  --color-secondary: #ffc708;
  --color-secondary-content: #3d2a00;
  --color-accent: #8d5448;
  --color-accent-content: #fff5ee;
  --color-neutral: #33403a;
  --color-neutral-content: #f3f1e6;
  --color-info: #3e9fc4;
  --color-info-content: #06222e;
  --color-success: #3f9e5e;
  --color-success-content: #f1fbf3;
  --color-warning: #f0a630;
  --color-warning-content: #3a2400;
  --color-error: #d9503f;
  --color-error-content: #fff3f1;`,
  },
  'yard-night': {
    scheme: 'dark',
    colors: `
  --color-base-100: #1e2622;
  --color-base-200: #18201c;
  --color-base-300: #2c3731;
  --color-base-content: #e7eee3;
  --color-primary: #76ce9c;
  --color-primary-content: #0d2417;
  --color-secondary: #ffc708;
  --color-secondary-content: #3d2a00;
  --color-accent: #c88a6c;
  --color-accent-content: #2a140c;
  --color-neutral: #33433a;
  --color-neutral-content: #e7eee3;
  --color-info: #6cc0e0;
  --color-info-content: #06222e;
  --color-success: #8fd16a;
  --color-success-content: #12240a;
  --color-warning: #f5b84a;
  --color-warning-content: #3a2400;
  --color-error: #f07a68;
  --color-error-content: #2d0905;`,
  },
};

export const OWN_THEMES = Object.keys(YARD_THEMES);

/** The daisyUI plugin lines for a light and a dark theme, each one ours or built in. */
export function themeCss(light: string, dark: string, include: string[]): string {
  const builtIn = [light && !YARD_THEMES[light] ? `${light} --default` : '', dark && !YARD_THEMES[dark] ? `${dark} --prefersdark` : ''].filter(Boolean);
  const own = [...new Set([light, dark])].filter((name) => YARD_THEMES[name]);
  return [
    `@plugin "daisyui" { themes: ${builtIn.length ? builtIn.join(', ') : 'false'}; logs: false; include: ${include.join(', ')}; }`,
    ...own.map(
      (name) => `@plugin "daisyui/theme" {
  name: "${name}";
  default: ${name === light};
  prefersdark: ${name === dark};
  color-scheme: ${YARD_THEMES[name]!.scheme};${YARD_THEMES[name]!.colors}${SHAPE}
}`,
    ),
  ].join('\n');
}
