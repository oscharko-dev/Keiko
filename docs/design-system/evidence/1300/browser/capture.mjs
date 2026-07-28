// Issue #1300 — running-app cross-theme / cross-viewport screenshot bundle.
//
// Serves the Next.js STATIC EXPORT (packages/keiko-ui/out, ADR-0011 D1 — self-contained, no backend)
// and captures the live product routes across the theme/contrast/motion matrix at desktop / tablet /
// mobile widths, proving the REAL product workflows render at 0.4.0 fidelity in Light, Dark, High
// Contrast, reduced-motion and forced-colors after the full token migration (#1292–#1299). This is
// the App-Browser visual-inspection evidence the issue requires in addition to the token gate.
//
// The harness rebuilds the static export itself so the source and rendered CSS evidence cannot drift:
//   node docs/design-system/evidence/1300/browser/capture.mjs
//
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, stat, mkdir, realpath } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join, extname, resolve, dirname, normalize, sep, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const ROOT = resolve(REPO, "packages/keiko-ui/out");
const OUT_DIR = resolve(REPO, "docs/design-system/evidence/1300/browser");
const CSS_PATH = resolve(REPO, "packages/keiko-ui/src/app/globals.css");
const POST_CSS_SHA256 = createHash("sha256")
  .update(readFileSync(CSS_PATH, "utf8").replace(/\r\n?/g, "\n"))
  .digest("hex");

function buildStaticExport() {
  const build = spawnSync("npm", ["run", "build", "--workspace", "@oscharko-dev/keiko-ui"], {
    cwd: REPO,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("The UI static export build failed.");
}

async function cssBundleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return cssBundleFiles(path);
      return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function renderedCssBundleSha256() {
  const files = (await cssBundleFiles(ROOT)).sort();
  if (files.length === 0) throw new Error("The UI static export contains no rendered CSS.");
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(relative(ROOT, file));
    digest.update("\0");
    digest.update(await readFile(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

buildStaticExport();
const RENDERED_CSS_BUNDLE_SHA256 = await renderedCssBundleSha256();
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
    x: 40,
    y: 44,
    w: 400,
    h: 360,
    z: 25,
    cfg: { root: DEMO_ROOT },
    max: false,
  },
  {
    id: "issue-1300-editor",
    type: "editor",
    x: 40,
    y: 430,
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
      '[data-window-id="issue-1300-files"] .files .files-tree',
      '[data-window-id="issue-1300-editor"]',
      '[data-window-id="issue-1300-editor"] .editor-workspace[data-trust-settled="true"]',
      '[data-window-id="issue-1300-editor"] .ed-panes-root',
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
      '[data-window-id="issue-1574-git-desktop"] [role="combobox"][aria-label^="Branch:"]',
      '[data-window-id="issue-1574-git-desktop"] [role="tablist"][aria-label="Changes and history"]',
      '[data-window-id="issue-1574-git-desktop"] nav[aria-label="Changed files"]',
      // Issue #1575 — per-file staging checkboxes and the pinned commit composer.
      '[data-window-id="issue-1574-git-desktop"] nav[aria-label="Changed files"] input[type="checkbox"]',
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
      '[data-window-id="issue-1574-git-constrained"] [role="combobox"][aria-label^="Branch:"]',
      '[data-window-id="issue-1574-git-constrained"] [role="tablist"][aria-label="Changes and history"]',
      '[data-window-id="issue-1574-git-constrained"] nav[aria-label="Changed files"]',
      // Issue #1575 — staging checkboxes and the pinned commit composer must survive the reflow.
      '[data-window-id="issue-1574-git-constrained"] nav[aria-label="Changed files"] input[type="checkbox"]',
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
const DEMO_CHAT = {
  id: "issue-1300-chat-session",
  projectPath: DEMO_ROOT,
  title: "Issue #1300 visual audit",
  selectedModel: DEMO_MODELS[0].id,
  branchLabel: undefined,
  status: "open",
  connectedScopes: [],
  connectedScope: undefined,
  localKnowledgeScopes: [],
  localKnowledgeScope: undefined,
  groundingScopeIdentity: `gsi-v1:${"0".repeat(64)}`,
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_000_000,
};

// Exact-pathname API fixtures. Every route here returns a fixed body with no request-dependent
// logic, so apiBody() can dispatch through a single lookup instead of a long if/else chain — same
// bodies as before, one branch per route to look up instead of one branch per route to evaluate.
const STATIC_API_BODIES = {
  "/api/health": { status: "ok", version: "0.2.0-beta.9" },
  "/api/update/preflight": {
    schemaVersion: 1,
    checkedAt: "2026-07-28T00:00:00.000Z",
    currentVersion: "0.2.15",
    updateAvailable: false,
    status: "current",
    availabilityState: "current",
    severity: "none",
    registryStatus: "ok",
    releaseMetadataStatus: "not-needed",
    userActionRequired: false,
    affectedStateStores: [],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: false,
    warnings: [],
  },
  "/api/config": {
    config: null,
    configPresent: false,
    effectiveGroundingLimits: { maxConnectedSources: 16 },
  },
  "/api/models": { models: DEMO_MODELS },
  "/api/native-file-dialog/capability": { supported: false },
  "/api/voice/capability": {
    voice: {
      available: false,
      profile: "none",
      capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
      transport: { websocketControl: false, webrtcMedia: false },
      availableVoicePersonas: [],
      reason: "no-voice-provider",
    },
  },
  "/api/workflows": { workflows: [] },
  "/api/chats": { chats: [DEMO_CHAT] },
  "/api/chats/messages": { messages: [] },
  "/api/desktop/chats": {
    project: {
      path: DEMO_ROOT,
      name: "Issue #1300 fixture",
      favorite: false,
      createdAt: 1_750_000_000_000,
      lastOpenedAt: 1_750_000_000_000,
      available: true,
    },
    chat: DEMO_CHAT,
    messages: [],
    projects: [
      {
        path: DEMO_ROOT,
        name: "Issue #1300 fixture",
        favorite: false,
        createdAt: 1_750_000_000_000,
        lastOpenedAt: 1_750_000_000_000,
        available: true,
      },
    ],
    chats: [DEMO_CHAT],
  },
  "/api/projects": {
    projects: [
      {
        path: DEMO_ROOT,
        name: "Issue #1300 fixture",
        favorite: false,
        createdAt: 1_750_000_000_000,
        lastOpenedAt: 1_750_000_000_000,
        available: true,
      },
    ],
    path: DEMO_ROOT,
  },
  "/api/memory": { memories: [], total: 0, limit: 50, offset: 0 },
  "/api/memory/review-queue": { memories: [], total: 0 },
  "/api/memory/consolidation/jobs": { jobs: [] },
  "/api/memory/autonomy-policy": {
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
    deploymentCeiling: "governed-assist",
    revision: 0,
  },
  "/api/relationships": { entries: [], truncated: false, nextCursor: null },
  "/api/relationships/health": {
    checkedAt: 1_750_000_000_000,
    totals: ZERO_RELATIONSHIP_TOTALS,
    truncated: false,
    findings: EMPTY_RELATIONSHIP_FINDINGS,
  },
  "/api/local-knowledge/capsules": { capsules: [] },
  "/api/local-knowledge/capsule-sets": { capsuleSets: [] },
  "/api/editor/language/capabilities": {
    schemaVersion: "1",
    providers: [
      {
        id: "static-evidence-typescript",
        languages: ["typescript", "javascript", "tsx", "jsx"],
        operations: ["diagnostics", "hover", "symbols"],
        availability: "available",
      },
    ],
  },
  "/api/editor/settings": {
    schemaVersion: "1",
    storeState: "ready",
    userRevision: 0,
    workspaceRevision: 0,
    revision: 0,
    etag: '"edm7-0-0-static-evidence"',
    root: DEMO_ROOT,
    definitions: [],
    settings: [],
    eventSequence: 0,
  },
  "/api/editor/snippets": {
    schemaVersion: "1",
    storeState: "absent",
    revision: 0,
    etag: '"edsn-0-static-evidence"',
    workspaceFingerprint: "0123456789abcdef",
    snippets: [],
  },
  "/api/editor/agent/sessions": { sessions: [] },
  "/api/editor/agent/snapshot": { snapshot: null },
  "/api/editor/agent/audit": { records: [] },
  // Issue #446 (Epic #443) — the globally mounted task-workspace switcher reads the inventory and the
  // active binding on boot. Without these the malformed fallback leaves `instances` undefined and the
  // switcher throws on every route, so the read surface must return an empty inventory and no active
  // binding (the unbound studio default), keeping every scenario error-free.
  "/api/task-workspaces": { instances: [] },
  "/api/task-workspaces/active": { active: null },
  // Issue #2619 — execution surfaces now fail closed while V2 workspace membership is unreadable.
  // This deterministic unbound fixture has no V2 manifests, so return the valid empty envelope
  // instead of the generic `{ ok: true }` fallback that the contract parser correctly rejects.
  "/api/workspaces": { manifests: [] },
  // Issue #1574 — read surface for the Git client window shell (repository status / branches / diff).
  // Fixtures keep the shell's desktop IA fully populated: a dirty repository (changed-file list), a
  // current branch in the branch selector, and a Sync status pill, proving the shell renders at all
  // viewport widths. No mutation endpoints are exercised (#1575/#1576/#1577 own those).
  "/api/git/status": {
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
  },
  "/api/git/branches": {
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
  },
  "/api/git/summary": {
    schemaVersion: "1",
    root: DEMO_ROOT,
    repositoryRoot: DEMO_ROOT,
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    ahead: 0,
    behind: 0,
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: false,
    remotes: [{ name: "origin" }],
    truncated: false,
  },
  "/api/git/diff": {
    schemaVersion: "1",
    root: DEMO_ROOT,
    repositoryRoot: DEMO_ROOT,
    state: "available",
    available: true,
    scope: "all",
    diff: "",
    truncated: false,
    maxBytes: 262144,
  },
  // Issue #1575 — the commit composer auto-previews policy for the staged set, so the live shell
  // posts here on mount. Return a content-free, passing preview so the policy preview renders.
  "/api/git-delivery/commit/preview": {
    schemaVersion: "1",
    summary: { stagedFileCount: 1, areaCount: 1, areas: ["src"], touchesTests: false },
    intent: { warnings: [], mixedScope: false, isWip: false },
    messageValidation: { ok: true },
    preflightFindingCodes: [],
    policyOutcome: "allowed",
  },
  "/api/quality-intelligence/runs": {
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
  },
  "/api/quality-intelligence/model-policy": {
    policy: { policyVersion: 1 },
    recommendedPolicy: {
      policyVersion: 1,
      testDesignModelId: DEMO_MODELS[0].id,
      judgeModelId: DEMO_MODELS[0].id,
    },
    resolved: {
      testDesignModelId: DEMO_MODELS[0].id,
      judgeModelId: DEMO_MODELS[0].id,
    },
    models: DEMO_MODELS,
    validation: { ok: true, issues: [] },
    repaired: false,
  },
};

function qualityIntelligenceRunDetailBody() {
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

function filesTreeBody(searchParams) {
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

function filesContentBody(pathname) {
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

function gitRemotesBody(searchParams) {
  return {
    schemaVersion: "1",
    root: searchParams.get("root") ?? "",
    repositoryRoot: DEMO_ROOT,
    state: "available",
    available: true,
    remotes: [],
    truncated: false,
  };
}

function gitDiffBody(searchParams) {
  return {
    schemaVersion: "1",
    scope: searchParams.get("scope") ?? "unstaged",
    files: [],
    truncated: false,
    totalFiles: 0,
    totalBytes: 0,
    maxBytes: 524288,
    maxFiles: 400,
  };
}

function editorVerificationCatalogBody(searchParams) {
  const projectId = searchParams.get("projectId") ?? "";
  return {
    schemaVersion: "1",
    projectId,
    workspaceTrust: {
      kind: "workspace-trust-status",
      schemaVersion: 1,
      projectId,
      trust: "trusted",
      decidedBy: "server",
      reason: "human-grant",
      revision: 1,
    },
    kinds: ["test", "targeted-test", "typecheck", "lint", "build"].map((kind) => ({
      kind,
      available: true,
      trustState: "trusted",
    })),
  };
}

function apiBody(url) {
  const pathname = typeof url === "string" ? url : url.pathname;
  const searchParams = typeof url === "string" ? new URLSearchParams() : url.searchParams;
  if (Object.hasOwn(STATIC_API_BODIES, pathname)) return STATIC_API_BODIES[pathname];
  if (pathname.startsWith("/api/quality-intelligence/runs/")) {
    return qualityIntelligenceRunDetailBody();
  }
  if (pathname === "/api/files/tree") return filesTreeBody(searchParams);
  if (pathname === "/api/files/preview" || pathname === "/api/files/content") {
    return filesContentBody(pathname);
  }
  if (pathname === "/api/git/remotes") return gitRemotesBody(searchParams);
  if (pathname === "/api/git/diff/structured") return gitDiffBody(searchParams);
  if (pathname === "/api/editor/verification/catalog") {
    return editorVerificationCatalogBody(searchParams);
  }
  return undefined;
}

const SSE_API_BODIES = {
  "/api/editor/settings/events": "event: ready\ndata: {}\n\n",
  "/api/editor/snippets/events": 'event: ready\ndata: {"ok":true}\n\n',
  "/api/editor/workspace-watch/events": [
    "id: 0",
    "event: editor-watch:snapshot",
    'data: {"schemaVersion":"1","sequence":0,"health":"healthy","rootToken":"0123456789abcdef","nativeWatcherCount":0,"subscriberCount":1,"queueDepth":0,"replayCapacity":0,"replayOldestSequence":0,"eventCount":0,"requiresSnapshot":false,"degradedReasons":[]}',
    "",
    "event: ready",
    "data: {}",
    "",
    "",
  ].join("\n"),
  "/api/relationships/events": "retry: 5000\n: connected\n\n",
};

function languageOperationBody(route) {
  const request = route.request().postDataJSON();
  if (request?.operation === "diagnostics") {
    return { operation: "diagnostics", result: { diagnostics: [], truncated: false } };
  }
  if (request?.operation === "symbols") {
    return { operation: "symbols", result: { symbols: [], truncated: false } };
  }
  return undefined;
}

function unexpectedApiLabel(route, url) {
  const requestSha256 = createHash("sha256")
    .update(`${route.request().method()}\0${url.pathname}`)
    .digest("hex");
  return `request_sha256=${requestSha256}`;
}

const POST_API_PATHS = new Set([
  "/api/desktop/chats",
  "/api/editor/agent/snapshot",
  "/api/editor/language",
]);

function expectedApiMethod(pathname) {
  return POST_API_PATHS.has(pathname) ? "POST" : "GET";
}

async function rejectUnexpectedApi(route, url, unexpectedApiRequests) {
  unexpectedApiRequests.add(unexpectedApiLabel(route, url));
  await route.fulfill({
    status: 501,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "STATIC_EVIDENCE_UNEXPECTED_API" } }),
  });
}

async function fulfillApiRoute(route, url, unexpectedApiRequests) {
  const method = route.request().method();
  if (method !== expectedApiMethod(url.pathname)) {
    await rejectUnexpectedApi(route, url, unexpectedApiRequests);
    return;
  }
  if (Object.hasOwn(SSE_API_BODIES, url.pathname)) {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: SSE_API_BODIES[url.pathname],
    });
    return;
  }
  const body =
    url.pathname === "/api/editor/language" ? languageOperationBody(route) : apiBody(url);
  if (body === undefined) {
    await rejectUnexpectedApi(route, url, unexpectedApiRequests);
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    headers:
      url.pathname === "/api/editor/snippets"
        ? { ETag: '"edsn-0-static-evidence"', "Cache-Control": "no-store" }
        : {},
    body: JSON.stringify(body),
  });
}

async function installRoutes(page, unexpectedApiRequests) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === BASE) {
      if (url.pathname.startsWith("/api/")) {
        await fulfillApiRoute(route, url, unexpectedApiRequests);
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
      const unexpectedApiRequests = new Set();
      await installRoutes(page, unexpectedApiRequests);
      const pageErrorFingerprints = [];
      page.on("pageerror", (error) => {
        pageErrorFingerprints.push(
          createHash("sha256")
            .update(String(error.stack ?? error))
            .digest("hex"),
        );
      });
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
          visibleErrorNoticeCount: document.querySelectorAll(".ui-error-notice").length,
          crashedWindowBodyCount: document.querySelectorAll('[data-window-body-crashed="true"]')
            .length,
          unavailableTrustStateCount: document.querySelectorAll('[data-trust="unavailable"]')
            .length,
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
        unexpectedApiRequestCount: unexpectedApiRequests.size,
        pageErrors: pageErrorFingerprints.slice(0, 3),
      });
      shotCount++;
      console.log(
        `${name}  theme=${info.theme} shell=${info.hasShell} windows=${info.windowCount} notices=${info.visibleErrorNoticeCount} crashed=${info.crashedWindowBodyCount} trust=${info.unavailableTrustStateCount} unknownApi=${unexpectedApiRequests.size} missing=${info.missingRequiredSelectors.length} err=${pageErrorFingerprints.length}`,
      );
      if (info.missingRequiredSelectors.length > 0) {
        console.log(`  missing selectors: ${info.missingRequiredSelectors.join(", ")}`);
      }
      if (info.visibleErrorNoticeCount > 0) {
        console.log(
          `  error notice diagnostic: rendered_count=${info.visibleErrorNoticeCount}`,
        );
      }
      if (unexpectedApiRequests.size > 0) {
        console.log(`  unexpected APIs: ${[...unexpectedApiRequests].join(", ")}`);
      }
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
      postCssSha256: POST_CSS_SHA256,
      renderedCssBundleSha256: RENDERED_CSS_BUNDLE_SHA256,
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
  (m) =>
    m.pageErrors.length ||
    !m.hasShell ||
    m.visibleErrorNoticeCount > 0 ||
    m.crashedWindowBodyCount > 0 ||
    m.unexpectedApiRequestCount > 0 ||
    m.unavailableTrustStateCount > 0 ||
    m.missingRequiredSelectors.length > 0,
);
process.exit(anyErr ? 1 : 0);
