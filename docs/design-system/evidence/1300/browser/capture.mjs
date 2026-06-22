// Issue #1300 — running-app cross-theme / cross-viewport screenshot bundle.
//
// Serves the Next.js STATIC EXPORT (packages/keiko-ui/out, ADR-0011 D1 — self-contained, no backend)
// and captures the live product routes across the theme/contrast/motion matrix at desktop / tablet /
// mobile widths, proving the REAL product workflows render at 0.4.0 fidelity in Light, Dark, High
// Contrast, reduced-motion and forced-colors after the full token migration (#1292–#1299). This is
// the App-Browser visual-inspection evidence the issue requires in addition to the token gate.
//
// The static export MUST be rebuilt from the migrated globals.css before running:
//   npm run build --workspace @oscharko-dev/keiko-ui
//   node docs/design-system/evidence/1300/browser/capture.mjs
//
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { join, extname, resolve, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const ROOT = resolve(REPO, "packages/keiko-ui/out");
const OUT_DIR = resolve(REPO, "docs/design-system/evidence/1300/browser");
await mkdir(OUT_DIR, { recursive: true });

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain",
  ".map": "application/json",
};
const ROOT_RESOLVED = resolve(ROOT);
const server = createServer(async (req, res) => {
  try {
    const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
    // Confine every request to ROOT: prefixing "/" then normalize() collapses any ".." segment so
    // the resolved path can never escape the served directory; the startsWith guard is a
    // belt-and-braces check (CodeQL path-injection hardening).
    const safe = normalize("/" + (requested === "/" ? "index.html" : requested));
    let fp = join(ROOT_RESOLVED, safe);
    if (fp !== ROOT_RESOLVED && !fp.startsWith(ROOT_RESOLVED + sep)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("forbidden");
    }
    try {
      if ((await stat(fp)).isDirectory()) fp = join(fp, "index.html");
    } catch {}
    let buf;
    try {
      buf = await readFile(fp);
    } catch {
      try {
        buf = await readFile(fp + ".html");
        fp += ".html";
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
      }
    }
    res.writeHead(200, {
      "content-type": MIME[extname(fp)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  } catch {
    // Never reflect the error/stack to the client (CodeQL: stack-trace exposure). Fixed plain text.
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  }
});
await new Promise((r) => server.listen(4612, "127.0.0.1", r));
const BASE = "http://127.0.0.1:4612";

const MODES = [
  { id: "dark", theme: "dark", hc: null, media: {} },
  { id: "light", theme: "light", hc: null, media: {} },
  { id: "dark-hc", theme: "dark", hc: "more", media: { contrast: "more" } },
  { id: "light-hc", theme: "light", hc: "more", media: { contrast: "more" } },
  { id: "reduced-motion", theme: "dark", hc: null, media: { reducedMotion: "reduce" } },
  { id: "forced-colors", theme: "dark", hc: null, media: { forcedColors: "active" } },
];
const VIEWPORTS = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "tablet", width: 900, height: 1024 },
  { id: "mobile", width: 420, height: 820 },
];
// keiko-ui is a single-route desktop shell (ADR-0011 / #1291): `/` is the complete product surface,
// and every product workflow (chat, QI, editor, local-knowledge, memoria, relationships) is a window
// WITHIN that shell rather than a separate static route. The static export therefore only emits `/`;
// the in-shell surfaces are proven by the component fidelity gate + the per-child evidence bundles.
const ROUTES = [{ id: "home", path: "/" }];

const browser = await chromium.launch();
const manifest = [];
let shotCount = 0;
for (const vp of VIEWPORTS) {
  for (const mode of MODES) {
    const contextOptions = {
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: mode.theme === "light" ? "light" : "dark",
      reducedMotion: mode.media.reducedMotion === "reduce" ? "reduce" : "no-preference",
      forcedColors: mode.media.forcedColors === "active" ? "active" : "none",
    };
    if (mode.media.contrast) contextOptions.contrast = "more";
    const ctx = await browser.newContext(contextOptions);
    const page = await ctx.newPage();
    for (const route of ROUTES) {
      // mobile/tablet only need the primary surface to bound shot count
      if (vp.id !== "desktop" && route.id !== "home") continue;
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e)));
      await page.addInitScript((t) => {
        try {
          localStorage.setItem("keiko.theme", t);
        } catch {}
      }, mode.theme);
      await page.goto(BASE + route.path, { waitUntil: "networkidle", timeout: 30000 });
      await page.evaluate(
        ({ theme, hc }) => {
          const r = document.documentElement;
          r.setAttribute("data-theme", theme);
          r.removeAttribute("data-hc");
          if (hc) r.setAttribute("data-hc", hc);
        },
        { theme: mode.theme, hc: mode.hc },
      );
      await page.waitForTimeout(900);
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
  JSON.stringify({ issue: 1300, epic: 1290, shotCount, manifest }, null, 2),
);
console.log(`\nWrote ${shotCount} screenshots + manifest.json to ${OUT_DIR}`);
const anyErr = manifest.some((m) => m.pageErrors.length || !m.hasShell);
process.exit(anyErr ? 1 : 0);
