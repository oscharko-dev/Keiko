// Product-runtime failure-surface inventory and executable-proof resolution (#3532).
//
// Everything here is a VIEW over the typed Activity Log registry that generate-op-catalog.mjs
// already derives from the production sources — never a second maintained source. Three closed,
// checked-in tables are the only hand-written inputs, and each is validated against the registry
// so it cannot drift silently:
//
//   * ACTIVITY_LOG_SURFACE_RULES maps (owner package, emitter module prefix) to one product surface.
//     The longest matching prefix wins. An operation no rule maps, two rules claiming the same
//     prefix, and a rule that maps no operation are all violations.
//   * ACTIVITY_LOG_OWNER_PORTS names the log port every owner package emits through. The port must
//     be declared (`export interface <Port>`) in the package the table names.
//   * ACTIVITY_LOG_FAILURE_MODE_TOKENS classifies a failure class into one of the four scenario
//     modes from its registered operation names and lifecycle phases.
//
// Proofs and scenarios resolve from the test sources. A registered proof id resolves when a test in
// the operation's OWNING package calls `expectActivityLogProof("<proof id>", line)` with a literal
// id (tests/support/activity-log-proof.ts); a scenario resolves when a test calls
// `expectActivityLogScenario("<surface>.<mode>", …)` (tests/support/activity-log-scenario.ts). The
// calls are found with the TypeScript parser, so a commented-out call or a call spelled inside a
// string is never counted.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export const FAILURE_SURFACE_INVENTORY_RELATIVE_PATH =
  "docs/observability/failure-surface-inventory.generated.json";

export const ACTIVITY_LOG_FAILURE_SURFACES = [
  "ui",
  "bff",
  "client-diagnostics",
  "model-gateway",
  "tools-workflows",
  "memory-knowledge",
  "editor-delivery",
  "lifecycle-crash",
  "runtime-packages",
];

export const ACTIVITY_LOG_FAILURE_MODES = ["rejection", "dependency-failure", "crash", "loss"];

// `emitterPrefix` is matched against the registration's `emitter` at a module boundary (`.` or
// `/`); an empty prefix binds every emitter of a domain package that has exactly one surface.
// keiko-server and keiko-cli have no owner-wide rule on purpose: a new BFF or CLI emitter module
// must be mapped deliberately, and until it is, generation fails with `surface-unmapped`.
function surfaceRulesForOwner(owner, surfaces) {
  return Object.entries(surfaces).flatMap(([surface, emitterPrefixes]) =>
    emitterPrefixes.map((emitterPrefix) => ({ owner, emitterPrefix, surface })),
  );
}

// Group the closed mapping by its owner and surface; expand its shared row shape once.
// Selection depends on the longest matching prefix, never on the order of these unique keys.
export const ACTIVITY_LOG_SURFACE_RULES = [
  ...surfaceRulesForOwner("keiko-cli", {
    "runtime-packages": [
      "audit",
      "install-layout",
      "security-log",
      "support",
      "support-query-evidence",
      "support-report-evidence",
      "uninstall",
    ],
    ui: [
      "lifecycle-browser-activity",
      "lifecycle-health-activity",
      "lifecycle-native-activity",
      "ui",
      "ui-process-stop",
    ],
    "lifecycle-crash": ["portable-launch-notifier", "process-activity-log"],
  }),
  ...surfaceRulesForOwner("keiko-local-knowledge", {
    "memory-knowledge": [""],
  }),
  ...surfaceRulesForOwner("keiko-memory-consolidation", {
    "memory-knowledge": [""],
  }),
  ...surfaceRulesForOwner("keiko-memory-vault", {
    "memory-knowledge": [""],
  }),
  ...surfaceRulesForOwner("keiko-model-gateway", {
    "model-gateway": [""],
    "editor-delivery": ["prDescription"],
  }),
  ...surfaceRulesForOwner("keiko-security", {
    "runtime-packages": [""],
  }),
  // ADR-0179: this package owns the one writer/store implementation and its reader engine. Its
  // registered lifecycle evidence remains one closed surface regardless of module filename.
  ...surfaceRulesForOwner("keiko-activity-log", {
    "lifecycle-crash": [""],
  }),
  ...surfaceRulesForOwner("keiko-server", {
    bff: [
      "atlassian",
      "bounded-request-body",
      "support-report-evidence",
      "chat-activity",
      "chat-scope-update-log",
      "chat-compaction-model-summary",
      "diagnostics-log",
      "chat-context-log",
      "chat-draft-log",
      "markdown-skill-log",
      "chat-continuity-log",
      "reference-id",
      "run-handlers",
      "server",
      "sse-write",
      "store",
      "store-handlers",
    ],
    "client-diagnostics": ["client-diagnostics-routes"],
    "tools-workflows": [
      "coding-app-session",
      "coding-context",
      "coding-runtime",
      "mcp",
      "coding-sidecar-gateway",
      "coding-sidecar-tool-facade",
      "deps-activity.logTaskWorkspaceRepositoryRegistration",
      "harness-context-compactor",
      "process-log-sink",
      "task-workspace",
      "tool-catalog",
      "workspace-root-denial-log",
      "workspace-script-trust",
    ],
    "editor-delivery": [
      "coding-runtime.productionDraftDeliveryDependencies",
      "coding-runtime.productionRuntimeGitPreparation",
      "coding-runtime.productionVerifiedCommitDependencies",
      "editor",
      "gitChangeChatContext",
      "gitChangeRoutes",
      "gitChangeSnapshotRegistry",
      "gitChangeSnapshotService",
      "gitDelivery",
      "gitDiffView",
      "gitProcessActivity",
    ],
    "runtime-packages": [
      "coding-runtime.windowsPortableAuthenticode",
      "evidence-retention-log",
      "update-candidate-authority",
      "update-portable-normal-startup",
      "update-preflight-activity",
      "update-runtime-activity",
      "update-native-handoff-activity",
      "update-session",
    ],
    "lifecycle-crash": ["deps-activity"],
    "model-gateway": [
      "gateway-instance-cache",
      "gateway-readiness",
      "conversation-readiness-log",
      "gateway-setup",
      "gateway-startup-activity",
      "gateway-discovery-log",
      "gateway-context-window",
      "gateway-spend-budget",
      "voice-live-dictation",
      "voice-realtime",
    ],
    "memory-knowledge": [
      "grounded-citation-log",
      "knowledge-prompt-window",
      "grounded-entailment-stage",
      "grounded-answer-activity",
      "grounded-orchestrator",
      "grounded-rerank-facade",
      "grounded-symbol-diagnostics",
      "local-knowledge-handlers",
      "memory-embedding",
    ],
    ui: ["native-file-dialog"],
  }),
];

// The log port each owner package emits through, and the package that declares it. The server and
// the CLI write through the process-wide server logger; every domain package receives its own
// port from the server (AGENTS.md §8).
export const ACTIVITY_LOG_OWNER_PORTS = {
  "keiko-activity-log": { port: "ServerLogSink", declaredIn: "keiko-activity-log" },
  "keiko-cli": { port: "ServerLogSink", declaredIn: "keiko-activity-log" },
  "keiko-local-knowledge": { port: "KnowledgeLogSink", declaredIn: "keiko-local-knowledge" },
  "keiko-memory-consolidation": {
    port: "ConsolidationLogSink",
    declaredIn: "keiko-memory-consolidation",
  },
  "keiko-memory-vault": { port: "MemoryVaultLogSink", declaredIn: "keiko-memory-vault" },
  "keiko-model-gateway": { port: "ModelGatewayLogSink", declaredIn: "keiko-model-gateway" },
  "keiko-security": { port: "SecurityLogSink", declaredIn: "keiko-security" },
  "keiko-server": { port: "ServerLogSink", declaredIn: "keiko-activity-log" },
};

// Checked in order: the first mode whose token appears in a member operation's name wins, after a
// registered `loss` lifecycle phase, which always means loss. A class matching none of them is a
// dependency failure or timeout — the mode every failed call to a collaborator falls into.
const ACTIVITY_LOG_FAILURE_MODE_TOKENS = [
  {
    mode: "loss",
    tokens: [
      "backpressure",
      "discarded",
      "dropped",
      "evicted",
      "limit-reached",
      "lost",
      "pressure",
      "quota-exhausted",
      "rate-limited",
      "sink-failed",
      "truncated",
    ],
  },
  {
    mode: "crash",
    tokens: [
      "abandoned",
      "aborted",
      "cancel",
      "cancelled",
      "crashed",
      "exiting",
      "fatal",
      "killed",
      "runtime-error",
      "shutdown",
      "stop",
      "terminated",
    ],
  },
  {
    mode: "rejection",
    tokens: [
      "blocked",
      "denied",
      "invalid",
      "mismatch",
      "not-admitted",
      "refusal",
      "refused",
      "rejected",
      "revoked",
      "unauthorized",
    ],
  },
];

const TEST_SOURCE = /\.test\.(?:ts|tsx|mts)$/u;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "fixtures", "coverage", ".git"]);
// The proof helpers of tests/support/activity-log-proof.ts: a file-sink line, or the emergency
// stderr notice the sink writes when it cannot persist. Either resolves the proof id it names.
const CALL_KINDS = new Map([
  ["expectActivityLogProof", "proof"],
  ["expectActivityLogStderrProof", "proof"],
  ["expectActivityLogScenario", "scenario"],
]);
const CALL_NAME_PREFIX = "expectActivityLog";

function compareCodepoints(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedUnique(values) {
  return [...new Set(values)].toSorted(compareCodepoints);
}

function matchesEmitterPrefix(emitter, prefix) {
  if (prefix === "") return true;
  return emitter === prefix || emitter.startsWith(`${prefix}.`) || emitter.startsWith(`${prefix}/`);
}

export function surfaceRuleFor(operation, rules = ACTIVITY_LOG_SURFACE_RULES) {
  const candidates = rules.filter(
    (rule) =>
      rule.owner === operation.owner && matchesEmitterPrefix(operation.emitter, rule.emitterPrefix),
  );
  return candidates.toSorted(
    (left, right) => right.emitterPrefix.length - left.emitterPrefix.length,
  )[0];
}

function operationTokens(op) {
  const segments = op.split(".");
  return new Set([...segments, ...segments.flatMap((segment) => segment.split("-"))]);
}

export function failureModeOf(members) {
  if (members.some((operation) => operation.lifecycle === "loss")) return "loss";
  const tokens = new Set(members.flatMap((operation) => [...operationTokens(operation.op)]));
  const match = ACTIVITY_LOG_FAILURE_MODE_TOKENS.find(({ tokens: modeTokens }) =>
    modeTokens.some((token) => tokens.has(token)),
  );
  return match?.mode ?? "dependency-failure";
}

function walkTestSources(directory, files) {
  if (!existsSync(directory)) return files;
  for (const name of readdirSync(directory).toSorted(compareCodepoints)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walkTestSources(path, files);
    else if (TEST_SOURCE.test(name)) files.push(path);
  }
  return files;
}

function testSourceFiles(repoRoot) {
  const packagesDir = join(repoRoot, "packages");
  const packageRoots = existsSync(packagesDir)
    ? readdirSync(packagesDir)
        .toSorted(compareCodepoints)
        .map((name) => join(packagesDir, name, "src"))
    : [];
  return [...packageRoots, join(repoRoot, "tests"), join(repoRoot, "src")].flatMap((root) =>
    walkTestSources(root, []),
  );
}

function literalFirstArgument(call) {
  const argument = call.arguments[0];
  if (argument === undefined) return undefined;
  return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
    ? argument.text
    : undefined;
}

function callSite(repoRoot, sourceFile, node) {
  const path = relative(repoRoot, sourceFile.fileName).replaceAll("\\", "/");
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return { file: path, site: `${path}:${String(line)}` };
}

function collectCalls(repoRoot, path, text, calls) {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    const kind =
      ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        ? CALL_KINDS.get(node.expression.text)
        : undefined;
    if (kind !== undefined) {
      calls.push({ kind, id: literalFirstArgument(node), ...callSite(repoRoot, sourceFile, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// Every literal proof and scenario call in the repository's test sources, in file order.
export function scanActivityLogProofCalls(repoRoot) {
  const calls = [];
  for (const path of testSourceFiles(repoRoot)) {
    const text = readFileSync(path, "utf8");
    if (!text.includes(CALL_NAME_PREFIX)) continue;
    collectCalls(repoRoot, path, text, calls);
  }
  return calls;
}

function violation(code, site, detail, correctiveAction) {
  return { code, site, detail, correctiveAction };
}

function ruleKey(rule) {
  return `${rule.owner}:${rule.emitterPrefix}`;
}

function surfaceRuleViolations(rules, operations) {
  const violations = [];
  const byKey = Map.groupBy(rules, ruleKey);
  for (const [key, entries] of byKey) {
    if (entries.length > 1)
      violations.push(
        violation(
          "surface-rule-ambiguous",
          `surfaceRules.${key}`,
          key,
          "Keep exactly one surface rule per owner package and emitter module prefix.",
        ),
      );
  }
  const used = new Set(
    operations
      .map((operation) => surfaceRuleFor(operation, rules))
      .filter(Boolean)
      .map(ruleKey),
  );
  for (const rule of rules) {
    if (!ACTIVITY_LOG_FAILURE_SURFACES.includes(rule.surface) || !used.has(ruleKey(rule)))
      violations.push(
        violation(
          "surface-rule-unused",
          `surfaceRules.${ruleKey(rule)}`,
          rule.surface,
          "Remove the stale surface rule or map it to a closed surface that owns an operation.",
        ),
      );
  }
  return violations;
}

function declaredPortPattern(port) {
  return new RegExp(String.raw`\bexport\s+interface\s+${port}\b`, "u");
}

function packageDeclaresPort(repoRoot, packageName, port) {
  const pattern = declaredPortPattern(port);
  const files = [];
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(join(repoRoot, "packages", packageName, "src"));
  return files.some((path) => pattern.test(readFileSync(path, "utf8")));
}

function ownerPortViolations(repoRoot, operations, ports) {
  return sortedUnique(operations.map((operation) => operation.owner)).flatMap((owner) => {
    const entry = ports[owner];
    if (entry === undefined)
      return [
        violation(
          "owner-port-unmapped",
          `ownerPorts.${owner}`,
          owner,
          "Name the log port this owner package emits through.",
        ),
      ];
    return packageDeclaresPort(repoRoot, entry.declaredIn, entry.port)
      ? []
      : [
          violation(
            "owner-port-undeclared",
            `ownerPorts.${owner}`,
            entry.port,
            "Point the owner at a log port its declaring package exports.",
          ),
        ];
  });
}

export {
  ownerPortViolations as failureSurfaceOwnerPortViolations,
  surfaceRuleViolations as failureSurfaceRuleViolations,
};
