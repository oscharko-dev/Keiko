import type { Config } from "tailwindcss";

/**
 * Tailwind is the primary styling system (ADR-0011 D12). Design tokens — colors, spacing,
 * typography — live here as the single token layer rather than ad-hoc inline styles.
 *
 * Dark Keiko brand palette (ADR-0014 D4):
 *   canvas  #1a1e23  page / main workspace background
 *   chrome  #242830  sidebar and header background
 *   panel   #2e3340  raised panels, cards, form backgrounds
 *   elevated #363c4a  hover states, active rows, dropdowns
 *   accent  #4EBA87  brand green — foreground text, icons, focus ring, button-bg fill
 *
 * WCAG 2.2 AA contrast (ADR-0014 D4):
 *   ink#fff on canvas#1a1e23  → 16.75:1 (pass)
 *   ink-muted#9ca3af on canvas → 6.60:1 (pass)
 *   accent#4EBA87 on canvas   → 6.94:1 (pass)
 *   FORBIDDEN: accent as button-bg with text-white (2.41:1 — fail). Use text-ink-inverse instead.
 *
 * Backward-compat aliases: surface.DEFAULT → canvas, surface.subtle → chrome so existing
 * `bg-surface`, `bg-surface-subtle`, etc. continue compiling without per-component edits.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── New dark shell tokens ──────────────────────────────────────────
        canvas: "#1a1e23",
        chrome: "#242830",
        panel: "#2e3340",
        elevated: "#363c4a",
        border: {
          DEFAULT: "#3a4052",
        },
        // ── Backward-compat aliases (existing components use these names) ──
        surface: {
          DEFAULT: "#1a1e23",  // was #ffffff — now points at canvas
          subtle: "#242830",   // was #f4f5f7 — now points at chrome
          inverse: "#0f1729",
        },
        ink: {
          DEFAULT: "#ffffff",  // primary text — was #1a1f2b
          muted: "#9ca3af",    // secondary / hints — was #454c5a
          dim: "#6b7280",      // disabled / decorative
          inverse: "#1a1e23",  // text on accent backgrounds — was #f8fafc
        },
        accent: {
          DEFAULT: "#4EBA87",  // brand green — was #1d4ed8
          strong: "#3da872",   // accent hover — was #1e3a8a
        },
        // Focus ring — brand green so rings honor the brand
        focus: "#4EBA87",
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
