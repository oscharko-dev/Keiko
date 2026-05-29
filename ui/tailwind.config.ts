import type { Config } from "tailwindcss";

/**
 * Tailwind is the primary styling system (ADR-0011 D12). Design tokens — colors, spacing,
 * typography — live here as the single token layer rather than ad-hoc inline styles. Color tokens
 * are chosen for WCAG 2.2 AA contrast (D11): `surface`/`ink` foreground-on-background pairs meet
 * the 4.5:1 text ratio and the focus ring meets the 3:1 non-text ratio.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#ffffff",
          subtle: "#f4f5f7",
          inverse: "#0f1729",
        },
        ink: {
          DEFAULT: "#1a1f2b",
          muted: "#454c5a",
          inverse: "#f8fafc",
        },
        accent: {
          DEFAULT: "#1d4ed8",
          strong: "#1e3a8a",
        },
        focus: "#1d4ed8",
      },
      spacing: {
        gutter: "1.5rem",
        section: "3rem",
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        body: ["1rem", { lineHeight: "1.6" }],
        heading: ["1.875rem", { lineHeight: "1.25", fontWeight: "700" }],
        subheading: ["1.25rem", { lineHeight: "1.4", fontWeight: "600" }],
      },
    },
  },
  plugins: [],
};

export default config;
