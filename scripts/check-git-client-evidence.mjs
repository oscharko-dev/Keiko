import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const MAX_PNG_BYTES = 1_000_000;
const MAX_TOTAL_PNG_BYTES = 4_000_000;

const REQUIRED_DOCS = [
  "docs/git-delivery/git-client-desktop-reuse-contract.md",
  "docs/git-delivery/git-client-repository-api.md",
  "docs/git-delivery/epic-1571-closeout.md",
];

const REQUIRED_DOC_SNIPPETS = {
  "docs/git-delivery/epic-1571-closeout.md": [
    "#1573",
    "#1574",
    "#1575",
    "#1576",
    "#1577",
    "#1578",
    "BFF",
    "CSRF",
    "credential",
    "agent operation",
    "MIT",
    "Qodana",
    "CodeQL",
  ],
};

const EVIDENCE = {
  1575: {
    manifest: "docs/git-delivery/evidence/1575/manifest.json",
    issue: "#1575",
    artifacts: ["git-changes-view.png"],
    requiredRoutes: [
      "/api/git/status",
      "/api/git/branches",
      "/api/git/diff",
      "/api/projects",
      "/api/git-delivery/staging/stage",
      "/api/git-delivery/staging/unstage",
      "/api/git-delivery/commit/preview",
    ],
    requiredStateSnippets: ["modified", "added", "deleted", "renamed", "untracked", "conflicted"],
  },
  1576: {
    manifest: "docs/git-delivery/evidence/1576/manifest.json",
    issue: "#1576",
    artifacts: ["git-branch-history-sync.png"],
    requiredRoutes: [
      "/api/git/branches",
      "/api/git/summary",
      "/api/git/history",
      "/api/git/remotes",
      "/api/git-delivery/local-branch/create",
      "/api/git-delivery/local-branch/switch",
      "/api/git-delivery/fetch/preview",
      "/api/git-delivery/pull/execute",
      "/api/git-delivery/push/execute",
    ],
    requiredStateSnippets: ["behind -> pull", "ahead -> push", "no upstream", "diverged", "detached"],
  },
  1577: {
    manifest: "docs/git-delivery/evidence/1577/manifest.json",
    issue: "#1577",
    artifacts: ["git-pr-merge-agent-ops.png"],
    requiredRoutes: [
      "/api/git/remotes",
      "/api/git-delivery/pr/preview",
      "/api/git-delivery/pr/execute",
      "/api/git-delivery/merge/preview",
      "/api/git-delivery/merge/execute",
    ],
    requiredStateSnippets: ["Pull Request", "Merge", "remote URLs"],
  },
  1578: {
    manifest: "docs/git-delivery/evidence/1578/manifest.json",
    issue: "#1578",
    artifacts: ["git-client-closeout-desktop.png", "git-client-closeout-constrained.png"],
    requiredRoutes: [
      "/api/git/status",
      "/api/git/branches",
      "/api/git/summary",
      "/api/git/history",
      "/api/git/remotes",
      "/api/git/diff",
      "/api/git-delivery/staging/stage",
      "/api/git-delivery/commit/execute",
      "/api/git-delivery/local-branch/create",
      "/api/git-delivery/local-branch/switch",
      "/api/git-delivery/pull/execute",
      "/api/git-delivery/pr/preview",
      "/api/git-delivery/merge/preview",
    ],
    requiredStateSnippets: [
      "repository selection",
      "changed files",
      "branch search",
      "history list",
      "sync pull",
      "Pull Request",
      "Merge",
      "constrained viewport",
    ],
  },
};

const FORBIDDEN_EVIDENCE_PATTERNS = [
  /\/private\/var\//iu,
  /\/var\/folders\//iu,
  /\/tmp\//iu,
  /\\Users\\/iu,
  /\/Users\//iu,
  /generatedAt/iu,
  /fixtureRoot/iu,
  /git@github\.com:/iu,
  /https:\/\/github\.com\/[^"'\s)]+\.git/iu,
  /Bearer\s+[A-Za-z0-9._-]+/u,
  /BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/u,
  /api[_-]?key/iu,
  /access[_-]?token/iu,
];

function readText(root, relPath) {
  return readFileSync(resolve(root, relPath), "utf8");
}

function readJson(root, relPath) {
  return JSON.parse(readText(root, relPath));
}

function existsFile(root, relPath) {
  const target = resolve(root, relPath);
  return existsSync(target) && statSync(target).isFile();
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validateNoForbiddenText(relPath, text) {
  const failures = [];
  for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
    if (pattern.test(text)) {
      failures.push(`${relPath}: forbidden evidence text matched ${pattern.toString()}`);
    }
  }
  return failures;
}

function readPngDimensions(root, relPath) {
  const buffer = readFileSync(resolve(root, relPath));
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error("not a PNG");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
  };
}

function arrayIncludesAll(values, required, relPath, fieldName) {
  const failures = [];
  if (!Array.isArray(values)) {
    return [`${relPath}: ${fieldName} must be an array`];
  }
  for (const item of required) {
    if (!values.includes(item)) {
      failures.push(`${relPath}: ${fieldName} missing ${item}`);
    }
  }
  return failures;
}

function manifestStateText(manifest) {
  const buckets = [
    manifest.statesCovered,
    manifest.statesVerified,
    manifest.gitFixtureStates === undefined ? [] : Object.entries(manifest.gitFixtureStates).flat(),
  ];
  return buckets.flat().join("\n");
}

function loadManifest(root, relPath) {
  if (!existsFile(root, relPath)) {
    return { ok: false, failures: [`missing Git client evidence manifest ${relPath}`] };
  }
  try {
    return { ok: true, manifest: readJson(root, relPath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return { ok: false, failures: [`${relPath}: invalid JSON (${message})`] };
  }
}

function validateManifestIdentity(manifest, config) {
  const failures = [];
  const relPath = config.manifest;
  if (manifest.issue !== config.issue) failures.push(`${relPath}: expected issue ${config.issue}`);
  if (manifest.epic !== "#1571") failures.push(`${relPath}: expected epic #1571`);
  if (manifest.evidencePath !== dirname(config.manifest)) {
    failures.push(`${relPath}: evidencePath must match manifest directory`);
  }
  failures.push(...arrayIncludesAll(manifest.routesIntercepted, config.requiredRoutes, relPath, "routesIntercepted"));
  failures.push(...arrayIncludesAll(manifest.artifacts, ["manifest.json", ...config.artifacts], relPath, "artifacts"));
  return failures;
}

function validateManifestStateCoverage(manifest, config) {
  const failures = [];
  const relPath = config.manifest;
  const stateText = manifestStateText(manifest);
  for (const snippet of config.requiredStateSnippets) {
    if (!stateText.includes(snippet)) {
      failures.push(`${relPath}: missing state/evidence text "${snippet}"`);
    }
  }
  return failures;
}

function validate1578Manifest(manifest, relPath) {
  const failures = [];
  for (const child of [
    "docs/git-delivery/evidence/1575/manifest.json",
    "docs/git-delivery/evidence/1576/manifest.json",
    "docs/git-delivery/evidence/1577/manifest.json",
  ]) {
    if (!manifest.childEvidence?.includes(child)) {
      failures.push(`${relPath}: childEvidence missing ${child}`);
    }
  }
  const assertions = manifest.assertions ?? {};
  for (const key of [
    "localPathsRendered",
    "remoteUrlsRendered",
    "externalCredentialsUsed",
    "forbiddenVisibleGovernanceLanguage",
  ]) {
    if (assertions[key] !== false) failures.push(`${relPath}: assertion ${key} must be false`);
  }
  return failures;
}

function validateManifest(root, id, config) {
  const relPath = config.manifest;
  const loaded = loadManifest(root, relPath);
  if (!loaded.ok) return loaded.failures;

  const { manifest } = loaded;
  const failures = [
    ...validateManifestIdentity(manifest, config),
    ...validateManifestStateCoverage(manifest, config),
  ];
  if (id === "1578") failures.push(...validate1578Manifest(manifest, relPath));
  failures.push(...validateNoForbiddenText(relPath, JSON.stringify(manifest)));
  return failures;
}

function validateArtifacts(root, config) {
  const failures = [];
  for (const artifact of config.artifacts) {
    const relPath = join(dirname(config.manifest), artifact);
    const resolved = resolve(root, relPath);
    if (!isInside(root, resolved)) {
      failures.push(`${relPath}: artifact path escapes repository`);
      continue;
    }
    if (!existsFile(root, relPath)) {
      failures.push(`${relPath}: missing evidence artifact`);
      continue;
    }
    try {
      const png = readPngDimensions(root, relPath);
      if (png.width < 700 || png.height < 500) {
        failures.push(`${relPath}: PNG dimensions too small (${png.width}x${png.height})`);
      }
      if (png.bytes > MAX_PNG_BYTES) {
        failures.push(`${relPath}: PNG size ${png.bytes} exceeds ${MAX_PNG_BYTES}`);
      }
    } catch (error) {
      failures.push(`${relPath}: invalid PNG (${error instanceof Error ? error.message : "unknown"})`);
    }
  }
  return failures;
}

function validateDocs(root) {
  const failures = [];
  for (const doc of REQUIRED_DOCS) {
    if (!existsFile(root, doc)) failures.push(`missing Git client closeout document ${doc}`);
  }
  for (const [doc, snippets] of Object.entries(REQUIRED_DOC_SNIPPETS)) {
    if (!existsFile(root, doc)) continue;
    const text = readText(root, doc);
    for (const snippet of snippets) {
      if (!text.includes(snippet)) failures.push(`${doc}: missing required text "${snippet}"`);
    }
  }
  return failures;
}

export function checkGitClientEvidence(root = REPO_ROOT) {
  const failures = [];
  failures.push(...validateDocs(root));

  let totalPngBytes = 0;
  for (const [id, config] of Object.entries(EVIDENCE)) {
    failures.push(...validateManifest(root, id, config));
    failures.push(...validateArtifacts(root, config));
    for (const artifact of config.artifacts) {
      const relPath = join(dirname(config.manifest), artifact);
      if (existsFile(root, relPath)) totalPngBytes += statSync(resolve(root, relPath)).size;
    }
  }
  if (totalPngBytes > MAX_TOTAL_PNG_BYTES) {
    failures.push(`Git client evidence PNG total ${totalPngBytes} exceeds ${MAX_TOTAL_PNG_BYTES}`);
  }

  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = checkGitClientEvidence();
  if (failures.length > 0) {
    console.error(`Git client evidence check failed (${failures.length}):`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Git client evidence check passed.");
  }
}
