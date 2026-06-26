import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const DOCS = [
  "docs/git-delivery/README.md",
  "docs/git-delivery/verification-matrix.md",
  "docs/git-delivery/operator-runbook.md",
  "docs/git-delivery/policy-pack-guidance.md",
  "docs/git-delivery/epic-470-closeout.md",
  "docs/git-delivery/evidence/479/README.md",
];

const REQUIRED_EVIDENCE_MANIFESTS = {
  475: {
    file: "docs/git-delivery/evidence/475/manifest.json",
    issue: "#475",
    assertions: [
      "nonConventionalPreviewSurfacesViolation",
      "commitPathSurfacesGovernedBlock",
      "browserReachedGovernedExecuteRoute",
      "conventionalCommitReachesSucceeded",
    ],
    artifacts: ["governed-commit-block.png"],
  },
  476: {
    file: "docs/git-delivery/evidence/476/manifest.json",
    issue: "#476",
    assertions: [
      "protectedTargetPreviewSurfacesPolicyBlock",
      "publishPathSurfacesGovernedBlock",
      "browserReachedGovernedPushExecuteRoute",
      "safeNamespaceTargetReachesSucceeded",
    ],
    artifacts: ["governed-publish-block.png"],
  },
  477: {
    file: "docs/git-delivery/evidence/477/manifest.json",
    issue: "#477",
    assertions: [
      "blockedBasePreviewSurfacesPolicyBlock",
      "prPathSurfacesGovernedBlock",
      "browserReachedGovernedPrExecuteRoute",
      "integrationBaseReachesSucceeded",
    ],
    artifacts: ["governed-pr-block.png"],
  },
  478: {
    file: "docs/git-delivery/evidence/478/manifest.json",
    issue: "#478",
    assertions: [
      "notMergeablePrSurfacesReadinessBlock",
      "mergeButtonDisabledWhenNotMergeable",
      "noExecuteRequestReachableWhenBlocked",
      "highRiskConfirmationGatesExecute",
      "mergeableReachesSucceeded",
    ],
    artifacts: ["governed-merge-block.png"],
  },
};

const REQUIRED_479_FIELDS = [
  "issue",
  "epic",
  "generatedAt",
  "sourceBranch",
  "baseBranch",
  "deliverables",
  "acceptanceCriteria",
  "verificationCommands",
  "mergedImplementationPullRequests",
  "evidenceSources",
  "browserEvidence",
  "residualLimitations",
  "governanceNotes",
];

const REQUIRED_479_DELIVERABLES = [
  "verification-matrix",
  "operator-runbook",
  "policy-pack-guidance",
  "closure-evidence",
  "final-closeout-summary",
];

const REQUIRED_479_ACCEPTANCE = [
  "full-path-evidence",
  "rollout-support-readiness",
  "operator-guidance",
  "residual-limitations",
  "terminal-approval-audit-protected-branch-proof",
];

const REQUIRED_TEXT = {
  "docs/git-delivery/verification-matrix.md": [
    "branch-create",
    "stage",
    "commit",
    "push",
    "pr-create",
    "merge",
    "approval-required",
    "recovery-required",
    "provider-not-ready",
  ],
  "docs/git-delivery/operator-runbook.md": [
    "KEIKO_GIT_DELIVERY_ENABLED=true",
    "Troubleshooting",
    "Evidence interpretation",
    "Residual limits",
  ],
  "docs/git-delivery/policy-pack-guidance.md": [
    "strict protected-branch governance",
    "developer self-service publish",
    "audit-heavy review workflow",
    "defaultRule",
  ],
  "docs/git-delivery/epic-470-closeout.md": [
    "Terminal restrictions",
    "Approval discipline",
    "Audit quality",
    "Protected-branch safety",
    "Residual limitations",
    "Project-state note",
  ],
};

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

function slugHeading(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function markdownAnchors(markdown) {
  const anchors = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      anchors.add(slugHeading(match[2]));
    }
  }
  return anchors;
}

function markdownLinks(markdown) {
  const links = [];
  const regex = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(regex)) {
    const target = match[1].trim();
    if (
      target === "" ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:") ||
      target.startsWith("#")
    ) {
      continue;
    }
    links.push(target.replace(/^<|>$/g, ""));
  }
  return links;
}

function validateMarkdownLinks(root, relPath) {
  const failures = [];
  const markdown = readText(root, relPath);
  const sourceDir = dirname(resolve(root, relPath));

  for (const target of markdownLinks(markdown)) {
    const [pathPart, anchorPart] = target.split("#");
    const resolved = normalize(resolve(sourceDir, decodeURIComponent(pathPart)));
    if (!isInside(root, resolved)) {
      failures.push(`${relPath}: link escapes repository root: ${target}`);
      continue;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      failures.push(`${relPath}: missing linked file: ${target}`);
      continue;
    }
    if (anchorPart && extname(resolved) === ".md") {
      const linkedMarkdown = readFileSync(resolved, "utf8");
      if (!markdownAnchors(linkedMarkdown).has(anchorPart)) {
        failures.push(`${relPath}: missing anchor ${target}`);
      }
    }
  }
  return failures;
}

function validateManifestIdentity(manifest, config) {
  const failures = [];
  if (manifest.issue !== config.issue) {
    failures.push(`${config.file}: expected issue ${config.issue}`);
  }
  if (manifest.evidencePath !== dirname(config.file)) {
    failures.push(`${config.file}: evidencePath must match manifest directory`);
  }
  return failures;
}

function validateManifestAssertions(manifest, config) {
  const failures = [];
  for (const assertion of config.assertions) {
    if (manifest.assertions?.[assertion] !== true) {
      failures.push(`${config.file}: assertion ${assertion} is not true`);
    }
  }
  return failures;
}

function validateManifestArtifacts(root, config) {
  const failures = [];
  for (const artifact of config.artifacts) {
    const artifactPath = join(dirname(config.file), artifact);
    if (!existsFile(root, artifactPath)) {
      failures.push(`${config.file}: missing artifact ${artifact}`);
    }
  }
  return failures;
}

function validateManifestRoutes(manifest, config) {
  const failures = [];
  if (!Array.isArray(manifest.governedRoutes) || manifest.governedRoutes.length === 0) {
    failures.push(`${config.file}: governedRoutes must be non-empty`);
  }
  return failures;
}

function validateManifest(root, _id, config) {
  if (!existsFile(root, config.file)) {
    return [`missing evidence manifest ${config.file}`];
  }
  const manifest = readJson(root, config.file);
  return [
    ...validateManifestIdentity(manifest, config),
    ...validateManifestAssertions(manifest, config),
    ...validateManifestArtifacts(root, config),
    ...validateManifestRoutes(manifest, config),
  ];
}

function validate479RequiredFields(manifest, relPath) {
  const failures = [];
  for (const field of REQUIRED_479_FIELDS) {
    if (!(field in manifest)) {
      failures.push(`${relPath}: missing ${field}`);
    }
  }
  return failures;
}

function validate479Identity(manifest, relPath) {
  const failures = [];
  if (manifest.issue !== "#479" || manifest.epic !== "#470") {
    failures.push(`${relPath}: expected issue #479 and epic #470`);
  }
  if (manifest.sourceBranch !== "codex/issue-479-governed-git-proof") {
    failures.push(`${relPath}: sourceBranch must name the issue branch`);
  }
  if (manifest.baseBranch !== "feat/keiko-establish-governed-end-to-end-git-delivery") {
    failures.push(`${relPath}: baseBranch must name the governed git delivery branch`);
  }
  return failures;
}

function validate479Statuses(manifest, relPath) {
  const failures = [];
  for (const id of REQUIRED_479_DELIVERABLES) {
    if (manifest.deliverables?.[id] !== "complete") {
      failures.push(`${relPath}: deliverable ${id} must be complete`);
    }
  }
  for (const id of REQUIRED_479_ACCEPTANCE) {
    if (manifest.acceptanceCriteria?.[id] !== "satisfied") {
      failures.push(`${relPath}: acceptance criterion ${id} must be satisfied`);
    }
  }
  return failures;
}

function validate479EvidenceLists(manifest, relPath) {
  const failures = [];
  for (const doc of DOCS) {
    if (!manifest.evidenceSources?.documents?.includes(doc)) {
      failures.push(`${relPath}: evidenceSources.documents must include ${doc}`);
    }
  }
  for (const pr of [1503, 1506, 1509, 1513, 1517, 1523, 1525, 1527, 1531, 1534]) {
    if (!manifest.mergedImplementationPullRequests?.includes(pr)) {
      failures.push(`${relPath}: missing implementation PR ${pr}`);
    }
  }
  return failures;
}

function validate479Manifest(root) {
  const relPath = "docs/git-delivery/evidence/479/manifest.json";
  if (!existsFile(root, relPath)) {
    return [`missing evidence manifest ${relPath}`];
  }
  const manifest = readJson(root, relPath);
  return [
    ...validate479RequiredFields(manifest, relPath),
    ...validate479Identity(manifest, relPath),
    ...validate479Statuses(manifest, relPath),
    ...validate479EvidenceLists(manifest, relPath),
  ];
}

export function checkGitDeliveryEvidence(root = REPO_ROOT) {
  const failures = [];

  for (const doc of DOCS) {
    if (!existsFile(root, doc)) {
      failures.push(`missing required document ${doc}`);
      continue;
    }
    failures.push(...validateMarkdownLinks(root, doc));
  }

  for (const [doc, snippets] of Object.entries(REQUIRED_TEXT)) {
    if (!existsFile(root, doc)) {
      continue;
    }
    const text = readText(root, doc);
    for (const snippet of snippets) {
      if (!text.includes(snippet)) {
        failures.push(`${doc}: missing required text "${snippet}"`);
      }
    }
  }

  for (const [id, config] of Object.entries(REQUIRED_EVIDENCE_MANIFESTS)) {
    failures.push(...validateManifest(root, id, config));
  }
  failures.push(...validate479Manifest(root));

  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = checkGitDeliveryEvidence();
  if (failures.length > 0) {
    console.error(`Governed Git delivery evidence check failed (${failures.length}):`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Governed Git delivery evidence check passed.");
  }
}
