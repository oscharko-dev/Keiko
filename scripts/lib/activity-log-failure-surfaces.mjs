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
export const ACTIVITY_LOG_SURFACE_RULES = [
  { owner: "keiko-cli", emitterPrefix: "audit", surface: "runtime-packages" },
  { owner: "keiko-cli", emitterPrefix: "install-layout", surface: "runtime-packages" },
  { owner: "keiko-cli", emitterPrefix: "portable-launch-notifier", surface: "lifecycle-crash" },
  { owner: "keiko-cli", emitterPrefix: "process-activity-log", surface: "lifecycle-crash" },
  { owner: "keiko-cli", emitterPrefix: "security-log", surface: "runtime-packages" },
  { owner: "keiko-cli", emitterPrefix: "support", surface: "runtime-packages" },
  { owner: "keiko-cli", emitterPrefix: "ui", surface: "ui" },
  { owner: "keiko-cli", emitterPrefix: "ui-process-stop", surface: "ui" },
  { owner: "keiko-cli", emitterPrefix: "uninstall", surface: "runtime-packages" },
  { owner: "keiko-local-knowledge", emitterPrefix: "", surface: "memory-knowledge" },
  { owner: "keiko-memory-consolidation", emitterPrefix: "", surface: "memory-knowledge" },
  { owner: "keiko-memory-vault", emitterPrefix: "", surface: "memory-knowledge" },
  { owner: "keiko-model-gateway", emitterPrefix: "", surface: "model-gateway" },
  { owner: "keiko-model-gateway", emitterPrefix: "prDescription", surface: "editor-delivery" },
  { owner: "keiko-security", emitterPrefix: "", surface: "runtime-packages" },
  { owner: "keiko-server", emitterPrefix: "atlassian", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "bounded-request-body", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "chat-activity", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "chat-compaction-model-summary", surface: "bff" },
  {
    owner: "keiko-server",
    emitterPrefix: "client-diagnostics-routes",
    surface: "client-diagnostics",
  },
  { owner: "keiko-server", emitterPrefix: "coding-app-session", surface: "tools-workflows" },
  { owner: "keiko-server", emitterPrefix: "coding-context", surface: "tools-workflows" },
  { owner: "keiko-server", emitterPrefix: "coding-runtime", surface: "tools-workflows" },
  {
    owner: "keiko-server",
    emitterPrefix: "coding-runtime.productionDraftDeliveryDependencies",
    surface: "editor-delivery",
  },
  {
    owner: "keiko-server",
    emitterPrefix: "coding-runtime.productionRuntimeGitPreparation",
    surface: "editor-delivery",
  },
  {
    owner: "keiko-server",
    emitterPrefix: "coding-runtime.productionVerifiedCommitDependencies",
    surface: "editor-delivery",
  },
  {
    owner: "keiko-server",
    emitterPrefix: "coding-runtime.windowsPortableAuthenticode",
    surface: "runtime-packages",
  },
  { owner: "keiko-server", emitterPrefix: "coding-sidecar-gateway", surface: "tools-workflows" },
  {
    owner: "keiko-server",
    emitterPrefix: "coding-sidecar-tool-facade",
    surface: "tools-workflows",
  },
  { owner: "keiko-server", emitterPrefix: "deps-activity", surface: "lifecycle-crash" },
  {
    owner: "keiko-server",
    emitterPrefix: "deps-activity.logTaskWorkspaceRepositoryRegistration",
    surface: "tools-workflows",
  },
  { owner: "keiko-server", emitterPrefix: "diagnostics-log", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "editor", surface: "editor-delivery" },
  { owner: "keiko-server", emitterPrefix: "evidence-retention-log", surface: "runtime-packages" },
  { owner: "keiko-server", emitterPrefix: "gateway-instance-cache", surface: "model-gateway" },
  { owner: "keiko-server", emitterPrefix: "gateway-readiness", surface: "model-gateway" },
  { owner: "keiko-server", emitterPrefix: "gateway-setup", surface: "model-gateway" },
  { owner: "keiko-server", emitterPrefix: "gateway-spend-budget", surface: "model-gateway" },
  { owner: "keiko-server", emitterPrefix: "gitChangeChatContext", surface: "editor-delivery" },
  { owner: "keiko-server", emitterPrefix: "gitChangeRoutes", surface: "editor-delivery" },
  { owner: "keiko-server", emitterPrefix: "gitChangeSnapshotRegistry", surface: "editor-delivery" },
  { owner: "keiko-server", emitterPrefix: "gitChangeSnapshotService", surface: "editor-delivery" },
  { owner: "keiko-server", emitterPrefix: "gitDelivery", surface: "editor-delivery" },
  { owner: "keiko-server", emitterPrefix: "gitProcessActivity", surface: "editor-delivery" },
  { owner: "keiko-server", emitterPrefix: "grounded-orchestrator", surface: "memory-knowledge" },
  { owner: "keiko-server", emitterPrefix: "grounded-rerank-facade", surface: "memory-knowledge" },
  { owner: "keiko-server", emitterPrefix: "harness-context-compactor", surface: "tools-workflows" },
  { owner: "keiko-server", emitterPrefix: "local-knowledge-handlers", surface: "memory-knowledge" },
  { owner: "keiko-server", emitterPrefix: "memory-embedding", surface: "memory-knowledge" },
  { owner: "keiko-server", emitterPrefix: "native-file-dialog", surface: "ui" },
  { owner: "keiko-server", emitterPrefix: "observability", surface: "lifecycle-crash" },
  { owner: "keiko-server", emitterPrefix: "process-log-sink", surface: "tools-workflows" },
  { owner: "keiko-server", emitterPrefix: "run-handlers", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "server", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "sse-write", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "store", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "store-handlers", surface: "bff" },
  { owner: "keiko-server", emitterPrefix: "task-workspace", surface: "tools-workflows" },
  { owner: "keiko-server", emitterPrefix: "tool-catalog", surface: "tools-workflows" },
  {
    owner: "keiko-server",
    emitterPrefix: "update-candidate-authority",
    surface: "runtime-packages",
  },
  {
    owner: "keiko-server",
    emitterPrefix: "update-portable-normal-startup",
    surface: "runtime-packages",
  },
  {
    owner: "keiko-server",
    emitterPrefix: "update-preflight-activity",
    surface: "runtime-packages",
  },
  { owner: "keiko-server", emitterPrefix: "update-runtime-activity", surface: "runtime-packages" },
  { owner: "keiko-server", emitterPrefix: "update-session", surface: "runtime-packages" },
  { owner: "keiko-server", emitterPrefix: "voice-live-dictation", surface: "model-gateway" },
  { owner: "keiko-server", emitterPrefix: "voice-realtime", surface: "model-gateway" },
  { owner: "keiko-server", emitterPrefix: "workspace-root-denial-log", surface: "tools-workflows" },
  { owner: "keiko-server", emitterPrefix: "workspace-script-trust", surface: "tools-workflows" },
];

// The log port each owner package emits through, and the package that declares it. The server and
// the CLI write through the process-wide server logger; every domain package receives its own
// port from the server (AGENTS.md §8).
export const ACTIVITY_LOG_OWNER_PORTS = {
  "keiko-cli": { port: "ServerLogSink", declaredIn: "keiko-server" },
  "keiko-local-knowledge": { port: "KnowledgeLogSink", declaredIn: "keiko-local-knowledge" },
  "keiko-memory-consolidation": {
    port: "ConsolidationLogSink",
    declaredIn: "keiko-memory-consolidation",
  },
  "keiko-memory-vault": { port: "MemoryVaultLogSink", declaredIn: "keiko-memory-vault" },
  "keiko-model-gateway": { port: "ModelGatewayLogSink", declaredIn: "keiko-model-gateway" },
  "keiko-security": { port: "SecurityLogSink", declaredIn: "keiko-security" },
  "keiko-server": { port: "ServerLogSink", declaredIn: "keiko-server" },
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
