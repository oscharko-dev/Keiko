/**
 * Tailwind was removed: the UI ships hand-crafted design CSS (ui/app/globals.css)
 * from the Claude-Design handoff verbatim, with oklch tokens and color-mix() that
 * Tailwind cannot represent without verbose arbitrary values. autoprefixer stays
 * for vendor-prefix coverage of the older WebKit scrollbar pseudo-elements.
 * @type {import('postcss-load-config').Config}
 */
const config = {
  plugins: {
    autoprefixer: {},
  },
};

export default config;
