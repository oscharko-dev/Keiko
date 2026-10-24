import { createUiStaticFixtureServer, listenUiStaticFixtureServer, loadThemedUiFixture } from "../../../../../scripts/lib/ui-browser-evidence.mjs";
// Issue #1295 — running-app browser evidence.
// Serves the Next.js STATIC EXPORT (packages/keiko-ui/out, ADR-0011 D1 — self-contained, no
// backend) and captures the live product routes across the theme/contrast/motion matrix at
// desktop/tablet/mobile widths, proving real product workflows render at 0.4.0 fidelity in Light,
// Dark, High Contrast, reduced-motion and forced-colors. The static export MUST be rebuilt from the
// migrated globals.css before running this (npm run build --workspace @oscharko-dev/keiko-ui).
//
//   node docs/design-system/evidence/1295/browser/capture.mjs   # writes PNGs into the OUT_DIR below
//
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const ROOT = resolve(REPO, "packages/keiko-ui/out");
const OUT_DIR = resolve(REPO, "docs/design-system/evidence/1295/browser");
await mkdir(OUT_DIR, { recursive: true });
const server = await createUiStaticFixtureServer(ROOT);
await listenUiStaticFixtureServer(server, 4611);
const BASE = "http://127.0.0.1:4611";

// theme/contrast/motion modes (mirror the equivalence-harness 7-mode matrix)
const MODES = [
  { id: "dark", theme: "dark", hc: null, media: {} },
  { id: "light", theme: "light", hc: null, media: {} },
  {
    id: "dark-hc",
    theme: "dark",
    hc: "more",
    media: { forcedColors: undefined, contrast: "more" },
  },
  { id: "light-hc", theme: "light", hc: "more", media: { contrast: "more" } },
  { id: "reduced-motion", theme: "dark", hc: null, media: { reducedMotion: "reduce" } },
  { id: "forced-colors", theme: "dark", hc: null, media: { forcedColors: "active" } },
];
const VIEWPORTS = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "tablet", width: 900, height: 1024 },
  { id: "mobile", width: 420, height: 820 },
];
// The `/memoriaviva` route stub was deleted in #2894 (KEIKO-0129); production `serveStatic`
// falls back to the desktop shell for bookmarked deep links, but this evidence server serves
// static files without that fallback and would 404. The in-desktop `memoria` window (owned by
// #1295) is the surviving surface — reproduce it inside the shell via the `/` route rather
// than a top-level URL.
const ROUTES = [
  { id: "home", path: "/" },
  { id: "launch", path: "/launch" },
  { id: "local-knowledge", path: "/local-knowledge" },
];

const browser = await chromium.launch();
const manifest = [];
let shotCount = 0;
for (const vp of VIEWPORTS) {
  for (const mode of MODES) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: mode.theme === "light" ? "light" : "dark",
      reducedMotion: mode.media.reducedMotion === "reduce" ? "reduce" : "no-preference",
      forcedColors: mode.media.forcedColors === "active" ? "active" : "none",
    });
    const page = await ctx.newPage();
    if (mode.media.contrast) await page.emulateMedia({ contrast: "more" });
    // Register the pageerror listener and the localStorage init script ONCE per page. The mutable
    // `errs` array is reset per route below so each iteration reports only its own errors, while
    // the single listener keeps pushing into the same buffer — matching this file's per-(viewport,
    // mode) page-reuse design.
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.addInitScript((t) => {
      try {
        localStorage.setItem("keiko.theme", t);
      } catch {}
    }, mode.theme);
    for (const route of ROUTES) {
      // mobile/tablet only need the primary surfaces to bound shot count
      if (vp.id !== "desktop" && route.id !== "home") continue;
      errs.length = 0;
      await loadThemedUiFixture(page, BASE + route.path, mode);
      const name = `${vp.id}__${route.id}__${mode.id}.png`;
      await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
      const info = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        hasShell: !!document.querySelector(".header,.hd,.workspace,.ws,.stage"),
        textLen: (document.body.innerText || "").length,
      }));
      manifest.push({
        file: name,
        route: route.path,
        viewport: vp.id,
        mode: mode.id,
        ...info,
        pageErrors: errs.slice(0, 3),
      });
      shotCount++;
      console.log(`${name}  theme=${info.theme} shell=${info.hasShell} err=${errs.length}`);
    }
    await ctx.close();
  }
}
await browser.close();
server.close();
const { writeFileSync } = await import("node:fs");
writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify({ issue: 1295, shotCount, manifest }, null, 2),
);
console.log(`\nWrote ${shotCount} screenshots + manifest.json to ${OUT_DIR}`);
const anyErr = manifest.some((m) => m.pageErrors.length || !m.hasShell);
process.exit(anyErr ? 1 : 0);
