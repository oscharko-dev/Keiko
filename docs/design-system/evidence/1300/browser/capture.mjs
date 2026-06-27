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
import { readFile, stat, mkdir, realpath } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join, extname, resolve, dirname, normalize, sep, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const ROOT = resolve(REPO, "packages/keiko-ui/out");
const OUT_DIR = resolve(REPO, "docs/design-system/evidence/1300/browser");
await mkdir(OUT_DIR, { recursive: true });
const ROOT_REAL = await realpath(ROOT);
const OUT_REL = relative(REPO, OUT_DIR);

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
const server = createServer(async (req, res) => {
  try {
    const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
    // Confine every request to ROOT: prefixing "/" then normalize() collapses any ".." segment so
    // the resolved path can never escape the served directory; the startsWith guard is a
    // belt-and-braces check (CodeQL path-injection hardening).
    const safe = normalize("/" + (requested === "/" ? "index.html" : requested));
    let fp = join(ROOT_REAL, safe);
    if (fp !== ROOT_REAL && !fp.startsWith(ROOT_REAL + sep)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("forbidden");
    }
    try {
      if ((await stat(fp)).isDirectory()) fp = join(fp, "index.html");
    } catch {}
    let buf;
    try {
      const realFile = await realpath(fp);
      if (realFile !== ROOT_REAL && !realFile.startsWith(ROOT_REAL + sep)) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("forbidden");
      }
      buf = await readFile(fp);
    } catch {
      try {
        fp += ".html";
        const realFile = await realpath(fp);
        if (realFile !== ROOT_REAL && !realFile.startsWith(ROOT_REAL + sep)) {
          res.writeHead(403, { "content-type": "text/plain" });
          return res.end("forbidden");
        }
        buf = await readFile(fp);
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
const DEMO_ROOT = "/tmp/keiko-issue-1300-static-evidence";
const WORKSPACE_WINDOWS = [
  {
    id: "issue-1300-chat",
    type: "chat",
    x: 40,
    y: 44,
    w: 450,
    h: 430,
    z: 20,
    cfg: { title: "Issue #1300 visual audit" },
    max: false,
  },
  {
    id: "issue-1300-quality",
    type: "quality",
    x: 520,
    y: 44,
    w: 560,
    h: 430,
    z: 21,
    cfg: {},
    max: false,
  },
  {
    id: "issue-1300-memoria",
    type: "memoria",
    x: 80,
    y: 500,
    w: 610,
    h: 430,
    z: 22,
    cfg: {},
    max: false,
  },
  {
    id: "issue-1300-relationships",
    type: "relationships",
    x: 730,
    y: 500,
    w: 610,
    h: 430,
    z: 23,
    cfg: {},
    max: false,
  },
  {
    id: "issue-1300-local-knowledge",
    type: "localKnowledge",
    x: 730,
    y: 44,
    w: 610,
    h: 430,
    z: 24,
    cfg: {},
    max: false,
  },
  {
    id: "issue-1300-files",
    type: "files",
    x: 80,
    y: 960,
    w: 400,
    h: 360,
    z: 25,
    cfg: { root: DEMO_ROOT },
    max: false,
  },
  {
    id: "issue-1300-editor",
    type: "editor",
    x: 520,
    y: 960,
    w: 720,
    h: 420,
    z: 26,
    cfg: { root: DEMO_ROOT, file: "src/App.tsx", openFiles: ["src/App.tsx", "README.md"] },
    max: false,
  },
  // Issue #1574 (EV3) — Git client window shell at a generous desktop size. Wide enough for the full
  // desktop IA (header toolbar with repository + branch selectors and Sync pill, the Changes/History
  // sidebar, and the diff pane side by side).
  {
    id: "issue-1574-git-desktop",
    type: "governedGit",
    x: 40,
    y: 44,
    w: 760,
    h: 620,
    z: 30,
    cfg: { projectPath: DEMO_ROOT },
    max: false,
  },
  // Issue #1574 (EV3) — the same shell at a constrained window size. Above the governedGit tiny
  // threshold (300x240) so the window renders the full shell rather than the too-small placeholder,
  // proving the desktop IA stays coherent when the window is narrow.
  {
    id: "issue-1574-git-constrained",
    type: "governedGit",
    x: 40,
    y: 44,
    w: 360,
    h: 460,
    z: 31,
    cfg: { projectPath: DEMO_ROOT },
    max: false,
  },
];
const WINDOWS_BY_ID = Object.fromEntries(WORKSPACE_WINDOWS.map((win) => [win.id, win]));
function scenarioWindows(ids) {
  return ids.map((id) => WINDOWS_BY_ID[id]);
}
const SCENARIOS = [
  {
    id: "shell",
    description: "empty workspace shell",
    windows: [],
    requiredSelectors: [".header", ".workspace", ".stage"],
  },
  {
    id: "workspace-chat-quality",
    description: "seeded workspace windows: chat, Quality Intelligence, Local Knowledge",
    windows: scenarioWindows([
      "issue-1300-chat",
      "issue-1300-quality",
      "issue-1300-local-knowledge",
    ]),
    requiredSelectors: [
      '[data-window-id="issue-1300-chat"]',
      '[data-window-id="issue-1300-quality"]',
      '[data-window-id="issue-1300-local-knowledge"]',
    ],
  },
  {
    id: "workspace-memory-relationships",
    description: "seeded workspace windows: MemoriaViva and Relationships",
    windows: scenarioWindows(["issue-1300-memoria", "issue-1300-relationships"]),
    requiredSelectors: [
      '[data-window-id="issue-1300-memoria"]',
      '[data-window-id="issue-1300-relationships"]',
    ],
  },
  {
    id: "workspace-files-editor",
    description: "seeded workspace windows: Files and Editor",
    windows: scenarioWindows(["issue-1300-files", "issue-1300-editor"]),
    requiredSelectors: [
      '[data-window-id="issue-1300-files"]',
      '[data-window-id="issue-1300-editor"]',
    ],
  },
  // Issue #1574 (EV3) — Git client window shell at a generous desktop size. The required selectors
  // prove the composed desktop IA rendered: the window frame, the Git workspace root, the repository
  // and branch combobox triggers and the Changes/History tablist in the sidebar, and the populated
  // changed-files navigation. These target the real classes/roles the shell composes (no new CSS).
  {
    id: "git-window-desktop",
    description: "Git client window shell at a generous desktop size",
    windows: scenarioWindows(["issue-1574-git-desktop"]),
    requiredSelectors: [
      '[data-window-id="issue-1574-git-desktop"]',
      '[data-window-id="issue-1574-git-desktop"] [aria-label="Git"]',
      '[data-window-id="issue-1574-git-desktop"] [role="combobox"][aria-label="Repository"]',
      '[data-window-id="issue-1574-git-desktop"] [role="combobox"][aria-label="Branch"]',
      '[data-window-id="issue-1574-git-desktop"] [role="tablist"][aria-label="Changes and history"]',
      '[data-window-id="issue-1574-git-desktop"] nav.rv-filelist[aria-label="Changed files"]',
      // Issue #1575 — per-file staging checkboxes and the pinned commit composer.
      '[data-window-id="issue-1574-git-desktop"] nav.rv-filelist[aria-label="Changed files"] input[type="checkbox"]',
      '[data-window-id="issue-1574-git-desktop"] section[aria-label="Commit"]',
    ],
  },
  // Issue #1574 (EV3) — the same shell at a constrained window size. The IA must stay coherent when the
  // window is narrow: the same window frame, Git workspace root, repository/branch selectors, tablist,
  // and changed-files list are still required (the shell reflows rather than dropping structure).
  {
    id: "git-window-constrained",
    description: "Git client window shell at a constrained window size",
    windows: scenarioWindows(["issue-1574-git-constrained"]),
    requiredSelectors: [
      '[data-window-id="issue-1574-git-constrained"]',
      '[data-window-id="issue-1574-git-constrained"] [aria-label="Git"]',
      '[data-window-id="issue-1574-git-constrained"] [role="combobox"][aria-label="Repository"]',
      '[data-window-id="issue-1574-git-constrained"] [role="combobox"][aria-label="Branch"]',
      '[data-window-id="issue-1574-git-constrained"] [role="tablist"][aria-label="Changes and history"]',
      '[data-window-id="issue-1574-git-constrained"] nav.rv-filelist[aria-label="Changed files"]',
      // Issue #1575 — staging checkboxes and the pinned commit composer must survive the reflow.
      '[data-window-id="issue-1574-git-constrained"] nav.rv-filelist[aria-label="Changed files"] input[type="checkbox"]',
      '[data-window-id="issue-1574-git-constrained"] section[aria-label="Commit"]',
    ],
  },
];
const FILE_CONTENT = "export function App() { return <main>Issue #1300 evidence</main>; }\n";
const FILE_VERSION = {
  sizeBytes: FILE_CONTENT.length,
  modifiedAt: 1_750_000_000_000,
  contentHash: "0".repeat(64),
};
const FILE_ENTRY_TSX = {
  name: "App.tsx",
  path: "src/App.tsx",
  kind: "file",
  sizeBytes: FILE_CONTENT.length,
  modifiedAt: FILE_VERSION.modifiedAt,
  extension: "tsx",
  symlink: false,
  readable: true,
};
const FILE_ENTRY_README = {
  name: "README.md",
  path: "README.md",
  kind: "file",
  sizeBytes: 46,
  modifiedAt: FILE_VERSION.modifiedAt,
  extension: "md",
  symlink: false,
  readable: true,
};
const FILE_BASE = {
  root: DEMO_ROOT,
  path: "src/App.tsx",
  name: "App.tsx",
  sizeBytes: FILE_CONTENT.length,
  modifiedAt: FILE_VERSION.modifiedAt,
  extension: "tsx",
  mime: "text/typescript",
  symlink: false,
};
const EMPTY_RELATIONSHIP_FINDINGS = {
  orphanedEndpoints: [],
  orphanedEndpointsTruncated: false,
  staleRelationships: [],
  staleRelationshipsTruncated: false,
  blockedRelationships: [],
  blockedRelationshipsTruncated: false,
  failedRelationships: [],
  failedRelationshipsTruncated: false,
  invalidReferences: [],
  invalidReferencesTruncated: false,
  cycleParticipants: [],
  cycleScanTruncated: false,
};
const ZERO_RELATIONSHIP_TOTALS = {
  draft: 0,
  active: 0,
  archived: 0,
  superseded: 0,
  revoked: 0,
  blocked: 0,
  stale: 0,
};
const DEMO_MODELS = [
  {
    id: "static-evidence-chat",
    kind: "chat",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "standard",
    preferredUseCases: ["static browser evidence"],
    knownLimitations: [],
  },
];

function apiBody(url) {
  const pathname = typeof url === "string" ? url : url.pathname;
  const searchParams = typeof url === "string" ? new URLSearchParams() : url.searchParams;
  if (pathname === "/api/health") return { status: "ok", version: "0.2.0-beta.9" };
  if (pathname === "/api/config") {
    return {
      config: null,
      configPresent: false,
      effectiveGroundingLimits: { maxConnectedSources: 16 },
    };
  }
  if (pathname === "/api/models") return { models: DEMO_MODELS };
  if (pathname === "/api/workflows") return { workflows: [] };
  if (pathname === "/api/chats") return { chats: [] };
  if (pathname === "/api/projects") {
    return {
      projects: [{ path: DEMO_ROOT, name: "Issue #1300 fixture", available: true }],
      path: DEMO_ROOT,
    };
  }
  if (pathname === "/api/memory") return { memories: [], total: 0, limit: 50, offset: 0 };
  if (pathname === "/api/memory/review-queue") return { memories: [], total: 0 };
  if (pathname === "/api/memory/consolidation/jobs") return { jobs: [] };
  if (pathname === "/api/relationships") {
    return { entries: [], truncated: false, nextCursor: null };
  }
  if (pathname === "/api/relationships/health") {
    return {
      checkedAt: 1_750_000_000_000,
      totals: ZERO_RELATIONSHIP_TOTALS,
      truncated: false,
      findings: EMPTY_RELATIONSHIP_FINDINGS,
    };
  }
  if (pathname === "/api/local-knowledge/capsules") return { capsules: [] };
  if (pathname === "/api/local-knowledge/capsule-sets") return { capsuleSets: [] };
  if (pathname === "/api/editor/language/capabilities") {
    return {
      schemaVersion: "1",
      providers: [
        {
          id: "static-evidence-typescript",
          languages: ["typescript", "javascript", "tsx", "jsx"],
          operations: ["diagnostics", "hover", "symbols"],
          availability: "available",
        },
      ],
    };
  }
  if (pathname === "/api/editor/agent/sessions") return { sessions: [] };
  // Issue #446 (Epic #443) — the globally mounted task-workspace switcher reads the inventory and the
  // active binding on boot. Without these the malformed fallback leaves `instances` undefined and the
  // switcher throws on every route, so the read surface must return an empty inventory and no active
  // binding (the unbound studio default), keeping every scenario error-free.
  if (pathname === "/api/task-workspaces") return { instances: [] };
  if (pathname === "/api/task-workspaces/active") return { active: null };
  // Issue #1574 — read surface for the Git client window shell (repository status / branches / diff).
  // Fixtures keep the shell's desktop IA fully populated: a dirty repository (changed-file list), a
  // current branch in the branch selector, and a Sync status pill, proving the shell renders at all
  // viewport widths. No mutation endpoints are exercised (#1575/#1576/#1577 own those).
  if (pathname === "/api/git/status") {
    return {
      schemaVersion: "1",
      root: DEMO_ROOT,
      repositoryRoot: DEMO_ROOT,
      state: "available",
      available: true,
      branch: "main",
      detached: false,
      clean: false,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 0,
      conflictedCount: 0,
      changes: [
        {
          path: "src/App.tsx",
          indexStatus: "M",
          worktreeStatus: " ",
          staged: true,
          unstaged: false,
          untracked: false,
          conflicted: false,
        },
        {
          path: "README.md",
          indexStatus: " ",
          worktreeStatus: "M",
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: false,
        },
      ],
      truncated: false,
      maxChanges: 1000,
    };
  }
  if (pathname === "/api/git/branches") {
    return {
      schemaVersion: "1",
      root: DEMO_ROOT,
      repositoryRoot: DEMO_ROOT,
      available: true,
      state: "available",
      branches: [
        { name: "main", headRefHash: "0".repeat(40), current: true },
        { name: "feature/git-window-shell", headRefHash: "1".repeat(40), current: false },
      ],
      truncated: false,
    };
  }
  if (pathname === "/api/git/diff") {
    return {
      schemaVersion: "1",
      root: DEMO_ROOT,
      repositoryRoot: DEMO_ROOT,
      state: "available",
      available: true,
      scope: "all",
      diff: "",
      truncated: false,
      maxBytes: 262144,
    };
  }
  // Issue #1575 — the commit composer auto-previews policy for the staged set, so the live shell
  // posts here on mount. Return a content-free, passing preview so the policy preview renders.
  if (pathname === "/api/git-delivery/commit/preview") {
    return {
      schemaVersion: "1",
      summary: { stagedFileCount: 1, areaCount: 1, areas: ["src"], touchesTests: false },
      intent: { warnings: [], mixedScope: false, isWip: false },
      messageValidation: { ok: true },
      preflightFindingCodes: [],
      policyOutcome: "allowed",
    };
  }
  if (pathname === "/api/quality-intelligence/runs") {
    return {
      runs: [
        {
          id: "qi-run-1300-visual-proof",
          status: "succeeded",
          reviewState: "approved",
          requestedAt: "2026-06-22T00:00:00.000Z",
          completedAt: "2026-06-22T00:01:00.000Z",
          totals: { candidates: 3, findings: 0, exports: 0 },
        },
      ],
      limit: 25,
      totalRunIds: 1,
      truncated: false,
    };
  }
  if (pathname.startsWith("/api/quality-intelligence/runs/")) {
    return {
      runId: "qi-run-1300-visual-proof",
      status: "succeeded",
      reviewState: "approved",
      requestedAt: "2026-06-22T00:00:00.000Z",
      completedAt: "2026-06-22T00:01:00.000Z",
      summary: {
        title: "Issue #1300 visual evidence run",
        totalCandidates: 3,
        approvedCandidates: 3,
      },
      candidates: [],
      findings: [],
      coverage: { coveragePercentage: 100, coveredCount: 6, totalCount: 6, gaps: [] },
    };
  }
  if (pathname === "/api/files/tree") {
    const path = searchParams.get("path") ?? "";
    if (path === "src") {
      return { root: DEMO_ROOT, path: "src", entries: [FILE_ENTRY_TSX], truncated: false };
    }
    return {
      root: DEMO_ROOT,
      path: "",
      entries: [
        {
          name: "src",
          path: "src",
          kind: "directory",
          sizeBytes: 0,
          modifiedAt: FILE_VERSION.modifiedAt,
          extension: null,
          symlink: false,
          readable: true,
        },
        FILE_ENTRY_README,
      ],
      truncated: false,
    };
  }
  if (pathname === "/api/files/preview" || pathname === "/api/files/content") {
    if (pathname === "/api/files/preview") {
      return {
        ...FILE_BASE,
        kind: "text",
        content: FILE_CONTENT,
        truncated: false,
        maxBytes: 262144,
      };
    }
    return {
      ...FILE_BASE,
      content: FILE_CONTENT,
      maxBytes: 262144,
      session: { schemaVersion: "1", version: FILE_VERSION },
    };
  }
  return { ok: true };
}

async function installRoutes(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === BASE) {
      if (url.pathname.startsWith("/api/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(apiBody(url)),
        });
        return;
      }
      await route.continue();
      return;
    }
    if (url.protocol === "data:" || url.protocol === "blob:") {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
}

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
    for (const scenario of SCENARIOS) {
      const ctx = await browser.newContext(contextOptions);
      const page = await ctx.newPage();
      await installRoutes(page);
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e.stack ?? e)));
      await page.addInitScript(
        ({ theme, windows }) => {
          try {
            localStorage.setItem("keiko.theme", theme);
            localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
            if (windows.length > 0) {
              localStorage.setItem("keiko.workspace.v4", JSON.stringify(windows));
            } else {
              localStorage.removeItem("keiko.workspace.v4");
            }
            localStorage.removeItem("keiko.conns.v1");
          } catch {}
        },
        { theme: mode.theme, windows: scenario.windows },
      );
      await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 30000 });
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
      const name = `${vp.id}__${scenario.id}__${mode.id}.png`;
      await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
      const info = await page.evaluate((requiredSelectors) => {
        const missingRequiredSelectors = requiredSelectors.filter(
          (selector) => document.querySelector(selector) === null,
        );
        return {
          theme: document.documentElement.dataset.theme,
          hasShell: !!document.querySelector(".header,.hd,.workspace,.ws,.stage"),
          windowCount: document.querySelectorAll(".window[data-window-id]").length,
          textLen: (document.body.innerText || "").length,
          missingRequiredSelectors,
        };
      }, scenario.requiredSelectors);
      manifest.push({
        file: name,
        route: "/",
        scenario: scenario.id,
        description: scenario.description,
        viewport: vp.id,
        mode: mode.id,
        requiredSelectors: scenario.requiredSelectors,
        ...info,
        pageErrors: errs.slice(0, 3),
      });
      shotCount++;
      console.log(
        `${name}  theme=${info.theme} shell=${info.hasShell} windows=${info.windowCount} missing=${info.missingRequiredSelectors.length} err=${errs.length}`,
      );
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify(
    {
      issue: 1300,
      epic: 1290,
      appPath: "packages/keiko-ui/out",
      route: "/",
      shotCount,
      modes: MODES.map((mode) => mode.id),
      viewports: VIEWPORTS.map((viewport) => viewport.id),
      scenarios: SCENARIOS.map(({ id, description, requiredSelectors }) => ({
        id,
        description,
        requiredSelectors,
      })),
      manifest,
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${shotCount} screenshots + manifest.json to ${OUT_REL}`);
const anyErr = manifest.some(
  (m) => m.pageErrors.length || !m.hasShell || m.missingRequiredSelectors.length > 0,
);
process.exit(anyErr ? 1 : 0);
